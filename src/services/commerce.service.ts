import { FilterQuery, Model, Types } from 'mongoose';
import {
  Card,
  LooseDoc,
  Notification,
  PayPalOrder,
  RainUser,
  SavingsPlan,
  StripePayment,
  WertTransaction,
} from '../models/domain.models';
import { ApiError } from '../utils/ApiError';
import { createdAtRangeFilter, mergeFilters } from '../utils/dateFilter';
import { enrichWithUserDisplay } from '../utils/enrichUsers';
import { escapeRegex, parseObjectId } from '../utils/query';
import { Actor, recordAudit } from './audit.service';

const REFERRAL_STATUSES = ['pending', 'processing', 'paid', 'rejected', 'disputed'] as const;

const CARD_STATUSES = ['notActivated', 'active', 'locked', 'canceled'] as const;
const CARD_LIMIT_FREQUENCIES = [
  'per24HourPeriod',
  'per7DayPeriod',
  'per30DayPeriod',
  'perYearPeriod',
  'allTime',
  'perAuthorization',
] as const;

const SAVINGS_STATUSES = [
  'PENDING',
  'AWAITING_SIGNATURE',
  'ACTIVE',
  'SUSPENDED',
  'CANCELED',
  'TERMINATED',
] as const;

function searchFilter(query: Record<string, unknown>, fields: string[]) {
  const filter: FilterQuery<LooseDoc> = {};
  if (typeof query.status === 'string' && query.status) filter.status = query.status;
  if (typeof query.userId === 'string' && query.userId) {
    filter.userId = parseObjectId(query.userId, 'user id');
  }
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = fields.map((field) => ({ [field]: pattern }));
  }
  return mergeFilters(filter, createdAtRangeFilter(query));
}

async function page(
  model: Model<LooseDoc>,
  filter: FilterQuery<LooseDoc>,
  skip: number,
  limit: number,
) {
  const [total, items] = await Promise.all([
    model.countDocuments(filter),
    model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

export async function listCards(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<LooseDoc> = {};
  if (typeof query.status === 'string' && query.status) filter.status = query.status;
  if (typeof query.type === 'string' && query.type) filter.type = query.type;
  if (typeof query.customerId === 'string' && query.customerId)
    filter.customerId = query.customerId;
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) {
    filter.$or = [
      { rainUserId: userId },
      { customerId: userId },
      { userId },
      { user_id: userId },
    ];
    if (Types.ObjectId.isValid(userId)) {
      const oid = parseObjectId(userId, 'user id');
      filter.$or.push({ rainUser: oid }, { customerId: String(oid) }, { rainUserId: String(oid) });
    }
  }
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) filter.last4 = new RegExp(escapeRegex(search));
  const result = await page(Card, mergeFilters(filter, createdAtRangeFilter(query)), skip, limit);
  return {
    ...result,
    items: await enrichWithUserDisplay(result.items as Record<string, unknown>[], [
      'customerId',
      'user_id',
      'userId',
      'rainUser',
    ]),
  };
}

export async function getCardAnalytics() {
  const [total, byStatus, byType] = await Promise.all([
    Card.countDocuments(),
    Card.aggregate<{ _id: string | null; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Card.aggregate<{ _id: string | null; count: number }>([
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]),
  ]);
  return {
    total,
    byStatus: Object.fromEntries(byStatus.map((r) => [r._id ?? 'unknown', r.count])),
    byType: Object.fromEntries(byType.map((r) => [r._id ?? 'unknown', r.count])),
  };
}

export async function getCard(cardId: string) {
  const card = await Card.findById(parseObjectId(cardId, 'card id')).lean();
  if (!card) throw new ApiError(404, 'Card not found.');
  return card;
}

async function requireCard(cardId: string) {
  const card = await Card.findById(parseObjectId(cardId, 'card id'));
  if (!card) throw new ApiError(404, 'Card not found.');
  return card;
}

export async function lockCard(actor: Actor, cardId: string) {
  const card = await requireCard(cardId);
  const from = String(card.get('status') ?? '');
  if (from === 'canceled') throw new ApiError(409, 'A canceled card cannot be locked.');
  if (from === 'locked') return card;
  card.set('status', 'locked');
  await card.save();
  await recordAudit(actor, 'card.lock', 'card', cardId, { from, status: 'locked' });
  return card;
}

export async function unlockCard(actor: Actor, cardId: string) {
  const card = await requireCard(cardId);
  const from = String(card.get('status') ?? '');
  if (from === 'active') return card;
  if (from !== 'locked') throw new ApiError(409, 'Only a locked card can be unlocked.');
  card.set('status', 'active');
  await card.save();
  await recordAudit(actor, 'card.unlock', 'card', cardId, { from, status: 'active' });
  return card;
}

export async function setCardStatus(actor: Actor, cardId: string, status: string) {
  if (!(CARD_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `status must be one of: ${CARD_STATUSES.join(', ')}`);
  }
  const card = await requireCard(cardId);
  const from = String(card.get('status') ?? '');
  card.set('status', status);
  await card.save();
  await recordAudit(actor, 'card.status', 'card', cardId, { from, status });
  return card;
}

export async function setCardLimit(
  actor: Actor,
  cardId: string,
  input: { amount: number; frequency?: string },
) {
  if (!Number.isInteger(input.amount) || input.amount < 0 || input.amount > 100_000_000) {
    throw new ApiError(400, 'amount must be a whole number from 0 to 100000000.');
  }
  const card = await requireCard(cardId);
  const current = card.get('limit');
  const currentFrequency =
    current &&
    typeof current === 'object' &&
    typeof (current as { frequency?: unknown }).frequency === 'string'
      ? (current as { frequency: string }).frequency
      : 'per30DayPeriod';
  const frequency = input.frequency?.trim() || currentFrequency;
  if (input.frequency && !(CARD_LIMIT_FREQUENCIES as readonly string[]).includes(frequency)) {
    throw new ApiError(400, `frequency must be one of: ${CARD_LIMIT_FREQUENCIES.join(', ')}`);
  }
  card.set('limit', { amount: input.amount, frequency });
  await card.save();
  await recordAudit(actor, 'card.limit', 'card', cardId, { amount: input.amount, frequency });
  return card;
}

export async function listPayPal(query: Record<string, unknown>, skip: number, limit: number) {
  const result = await page(
    PayPalOrder,
    searchFilter(query, ['paypalOrderId', 'paypalPayerEmail']),
    skip,
    limit,
  );
  return {
    ...result,
    items: await enrichWithUserDisplay(result.items as Record<string, unknown>[], ['userId']),
  };
}

export async function listStripe(query: Record<string, unknown>, skip: number, limit: number) {
  const result = await page(StripePayment, searchFilter(query, ['paymentIntentId']), skip, limit);
  return {
    ...result,
    items: await enrichWithUserDisplay(result.items as Record<string, unknown>[], ['userId']),
  };
}

export async function listWert(query: Record<string, unknown>, skip: number, limit: number) {
  const result = await page(
    WertTransaction,
    searchFilter(query, ['wertOrderId', 'clickId']),
    skip,
    limit,
  );
  return {
    ...result,
    items: await enrichWithUserDisplay(result.items as Record<string, unknown>[], ['userId']),
  };
}

export async function listSavings(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<LooseDoc> = {};
  if (typeof query.status === 'string' && query.status) filter.status = query.status;
  if (typeof query.userId === 'string' && query.userId) {
    filter.user_id = parseObjectId(query.userId, 'user id');
  }
  const result = await page(
    SavingsPlan,
    mergeFilters(filter, createdAtRangeFilter(query)),
    skip,
    limit,
  );
  return {
    ...result,
    items: await enrichWithUserDisplay(result.items as Record<string, unknown>[], [
      'user_id',
      'userId',
    ]),
  };
}

export async function getSavingsAnalytics() {
  const [total, byStatus] = await Promise.all([
    SavingsPlan.countDocuments(),
    SavingsPlan.aggregate<{ _id: string | null; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);
  return {
    total,
    byStatus: Object.fromEntries(byStatus.map((r) => [r._id ?? 'unknown', r.count])),
  };
}

export async function getSavingsPlan(planId: string) {
  const plan = await SavingsPlan.findById(parseObjectId(planId, 'plan id')).lean();
  if (!plan) throw new ApiError(404, 'Savings plan not found.');
  return plan;
}

async function requireSavingsPlan(planId: string) {
  const plan = await SavingsPlan.findById(parseObjectId(planId, 'plan id'));
  if (!plan) throw new ApiError(404, 'Savings plan not found.');
  return plan;
}

export async function setSavingsStatus(actor: Actor, planId: string, status: string) {
  if (!(SAVINGS_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `status must be one of: ${SAVINGS_STATUSES.join(', ')}`);
  }
  const plan = await requireSavingsPlan(planId);
  const from = String(plan.get('status') ?? '');
  plan.set('status', status);
  await plan.save();
  await recordAudit(actor, 'savings.status', 'savings_plan', planId, { from, status });
  return plan;
}

export async function terminateSavingsPlan(actor: Actor, planId: string, path?: string) {
  const plan = await requireSavingsPlan(planId);
  const now = new Date();
  const current = plan.get('termination');
  const termination: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  if (!termination.requested_at) termination.requested_at = now;
  if (!termination.completed_at) termination.completed_at = now;
  const nextPath = path?.trim();
  if (nextPath) termination.path = nextPath;
  else if (!termination.path) termination.path = 'admin';
  plan.set('status', 'TERMINATED');
  plan.set('termination', termination);
  await plan.save();
  await recordAudit(actor, 'savings.terminate', 'savings_plan', planId, {
    path: termination.path,
  });
  return plan;
}

export async function addSavingsAdminNote(actor: Actor, planId: string, body: string) {
  const trimmed = body.trim();
  if (!trimmed) throw new ApiError(400, 'Note body is required.');
  if (trimmed.length > 4000) throw new ApiError(400, 'Note body must be 4000 characters or fewer.');
  const plan = await requireSavingsPlan(planId);
  const existing = plan.get('admin_notes');
  const notes = Array.isArray(existing) ? [...existing] : [];
  notes.push({ authorEmail: actor.email, body: trimmed, createdAt: new Date() });
  plan.set('admin_notes', notes.slice(-50));
  await plan.save();
  await recordAudit(actor, 'savings.note', 'savings_plan', planId);
  return plan;
}

export async function listReferrals(skip: number, limit: number) {
  const pipeline = [
    { $match: { 'referredUsers.0': { $exists: true } } },
    { $unwind: '$referredUsers' },
    { $sort: { 'referredUsers.paidAt': -1 as const, createdAt: -1 as const } },
  ];
  const [countRows, items] = await Promise.all([
    RainUser.aggregate<{ total: number }>([...pipeline, { $count: 'total' }]),
    RainUser.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          email: 1,
          firstName: 1,
          lastName: 1,
          referalCode: 1,
          referredUsers: 1,
        },
      },
    ]),
  ]);
  return { items, total: countRows[0]?.total ?? 0 };
}

export async function updateReferralStatus(
  actor: Actor,
  referrerId: string,
  referredUserId: string,
  rewardStatus: string,
) {
  if (!(REFERRAL_STATUSES as readonly string[]).includes(rewardStatus)) {
    throw new ApiError(400, `rewardStatus must be one of: ${REFERRAL_STATUSES.join(', ')}`);
  }
  const updated = await RainUser.findOneAndUpdate(
    {
      _id: parseObjectId(referrerId, 'referrer id'),
      'referredUsers.userId': parseObjectId(referredUserId, 'referred user id'),
    },
    { $set: { 'referredUsers.$.rewardStatus': rewardStatus } },
    { new: true },
  ).select('email referredUsers');
  if (!updated) throw new ApiError(404, 'Referral not found.');
  await recordAudit(actor, 'referral.status', 'referral', referredUserId, {
    referrerId,
    rewardStatus,
  });
  return updated;
}

export async function listNotifications(skip: number, limit: number) {
  return page(Notification, {}, skip, limit);
}

export async function createAnnouncement(
  actor: Actor,
  input: { title: string; message: string; userId?: string; broadcast?: boolean },
) {
  const title = input.title.trim();
  const message = input.message.trim();
  if (!title || !message) throw new ApiError(400, 'title and message are required.');

  let userIds: Types.ObjectId[] = [];
  if (input.userId) {
    userIds = [parseObjectId(input.userId, 'user id')];
  } else if (input.broadcast) {
    const users = await RainUser.find().select('_id').limit(2000).lean();
    userIds = users.map((user) => user._id as Types.ObjectId);
  } else {
    throw new ApiError(400, 'Provide userId or broadcast=true.');
  }

  if (userIds.length === 0) throw new ApiError(400, 'No recipients.');

  await Notification.insertMany(
    userIds.map((userId) => ({
      userId,
      type: 'ADMIN_ANNOUNCEMENT',
      title,
      message,
      readAt: null,
    })),
  );
  await recordAudit(actor, 'notification.create', 'notification', undefined, {
    title,
    recipients: userIds.length,
  });
  return { recipients: userIds.length };
}
