import { FilterQuery, Types } from 'mongoose';
import { AdminNote, AdminUserTag } from '../models/admin.models';
import {
  Card,
  Charge,
  PayPalOrder,
  RainKyb,
  RainKyc,
  RainUser,
  SavingsPlan,
  StripePayment,
  Subscription,
  USER_SECRET_FIELDS,
  WertTransaction,
  docId,
} from '../models/domain.models';
import { ApiError } from '../utils/ApiError';
import { generateImpersonationToken } from '../utils/jwt';
import { createdAtRangeFilter, mergeFilters } from '../utils/dateFilter';
import { escapeRegex, parseObjectId } from '../utils/query';
import { Actor, recordAudit } from './audit.service';

const ACCOUNT_STATUSES = ['active', 'suspended', 'frozen', 'banned', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

function userFilter(query: Record<string, unknown>): FilterQuery<Record<string, unknown>> {
  const filter: FilterQuery<Record<string, unknown>> = {};
  const email = typeof query.email === 'string' ? query.email.trim() : '';
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  const status = typeof query.status === 'string' ? query.status.trim() : '';
  const accountKind = typeof query.accountKind === 'string' ? query.accountKind.trim() : '';

  if (email) filter.email = email.toLowerCase();
  if (accountKind) filter.accountKind = accountKind;
  if (status === 'active') {
    filter.accountStatus = { $in: [null, 'active', ''] };
  } else if (status) {
    filter.accountStatus = status;
  }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      { email: pattern },
      { firstName: pattern },
      { lastName: pattern },
      { displayName: pattern },
    ];
  }
  return filter;
}

export async function listUsers(query: Record<string, unknown>, skip: number, limit: number) {
  const filter = mergeFilters(userFilter(query), createdAtRangeFilter(query));
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) {
    filter._id = parseObjectId(userId, 'user id');
  }
  const [total, items] = await Promise.all([
    RainUser.countDocuments(filter),
    RainUser.find(filter)
      .select(USER_SECRET_FIELDS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  const ids = items.map((row) => row._id).filter(Boolean);
  const tagRows = ids.length
    ? await AdminUserTag.find({ userId: { $in: ids } }).lean()
    : [];
  const tagsByUser = new Map(tagRows.map((row) => [String(row.userId), row.tags ?? []]));
  return {
    items: items.map((row) => ({
      ...row,
      tags: tagsByUser.get(String(row._id)) ?? [],
    })),
    total,
  };
}

export async function getUserAnalytics() {
  const [total, verified, business, byStatus, byAccountKind] = await Promise.all([
    RainUser.countDocuments(),
    RainUser.countDocuments({ isEmailVerified: true }),
    RainUser.countDocuments({ accountKind: 'business' }),
    RainUser.aggregate<{ _id: string | null; count: number }>([
      { $group: { _id: '$accountStatus', count: { $sum: 1 } } },
    ]),
    RainUser.aggregate<{ _id: string | null; count: number }>([
      { $group: { _id: '$accountKind', count: { $sum: 1 } } },
    ]),
  ]);
  return {
    total,
    verified,
    business,
    byStatus: Object.fromEntries(byStatus.map((row) => [row._id ?? 'active', row.count])),
    byAccountKind: Object.fromEntries(
      byAccountKind.map((row) => [row._id ?? 'unknown', row.count]),
    ),
  };
}

export async function getUserProfile(userId: string) {
  const id = parseObjectId(userId, 'user id');
  const user = await RainUser.findById(id).select(USER_SECRET_FIELDS).lean();
  if (!user) throw new ApiError(404, 'User not found.');
  const idStr = String(id);
  const userFilter = {
    $or: [{ rainUserId: idStr }, { customerId: idStr }, { userId: idStr }, { user_id: idStr }],
  };
  const [
    kyc,
    kyb,
    subscriptions,
    notes,
    tags,
    cardCount,
    savingsCount,
    chargesCount,
    paypalCount,
    stripeCount,
    wertCount,
  ] = await Promise.all([
    RainKyc.findOne({ rainUser: id }).lean(),
    RainKyb.findOne({ rainUser: id })
      .select('kycApprovedStatus applicationStatus name entity.name issuerCountry updatedAt')
      .lean(),
    Subscription.find({ user_id: id }).lean(),
    AdminNote.find({ userId: id }).sort({ createdAt: -1 }).limit(50).lean(),
    AdminUserTag.findOne({ userId: id }).lean(),
    Card.countDocuments(userFilter),
    SavingsPlan.countDocuments({
      $or: [{ user_id: id }, { userId: id }],
    }),
    Charge.countDocuments({
      $or: [{ user_id: id }, { userId: id }],
    }),
    PayPalOrder.countDocuments({ userId: id }),
    StripePayment.countDocuments({ userId: id }),
    WertTransaction.countDocuments({ userId: id }),
  ]);
  return {
    user,
    kyc,
    kyb,
    subscriptions,
    notes,
    tags: tags?.tags ?? [],
    cardCount,
    savingsCount,
    chargesCount,
    purchaseCounts: { paypal: paypalCount, stripe: stripeCount, wert: wertCount },
  };
}

export async function setAccountStatus(actor: Actor, userId: string, accountStatus: string) {
  if (!(ACCOUNT_STATUSES as readonly string[]).includes(accountStatus)) {
    throw new ApiError(400, `accountStatus must be one of: ${ACCOUNT_STATUSES.join(', ')}`);
  }
  const id = parseObjectId(userId, 'user id');
  const updated = await RainUser.findByIdAndUpdate(
    id,
    {
      $set: {
        accountStatus,
        ...(accountStatus === 'active' ? {} : { sessionsInvalidatedAt: new Date() }),
      },
    },
    { new: true },
  ).select(USER_SECRET_FIELDS);
  if (!updated) throw new ApiError(404, 'User not found.');
  await recordAudit(actor, 'user.account_status', 'user', userId, { accountStatus });
  return updated;
}

export async function forceLogout(actor: Actor, userId: string) {
  const id = parseObjectId(userId, 'user id');
  const updated = await RainUser.findByIdAndUpdate(
    id,
    { $set: { sessionsInvalidatedAt: new Date() } },
    { new: true },
  ).select('_id email sessionsInvalidatedAt');
  if (!updated) throw new ApiError(404, 'User not found.');
  await recordAudit(actor, 'user.force_logout', 'user', userId);
  return updated;
}

export async function forcePasswordReset(actor: Actor, userId: string) {
  const id = parseObjectId(userId, 'user id');
  const now = new Date();
  const updated = await RainUser.findByIdAndUpdate(
    id,
    { $set: { passwordResetRequiredAt: now, sessionsInvalidatedAt: now } },
    { new: true },
  ).select('_id email passwordResetRequiredAt');
  if (!updated) throw new ApiError(404, 'User not found.');
  await recordAudit(actor, 'user.force_password_reset', 'user', userId);
  return updated;
}

export async function verifyUserEmail(actor: Actor, userId: string) {
  const id = parseObjectId(userId, 'user id');
  const updated = await RainUser.findByIdAndUpdate(
    id,
    { $set: { isEmailVerified: true } },
    { new: true },
  ).select('_id email isEmailVerified');
  if (!updated) throw new ApiError(404, 'User not found.');
  await recordAudit(actor, 'user.verify_email', 'user', userId);
  return updated;
}

export async function impersonateUser(actor: Actor, userId: string) {
  const user = await RainUser.findById(parseObjectId(userId, 'user id')).select(
    'email firstName lastName accountStatus',
  );
  if (!user) throw new ApiError(404, 'User not found.');
  const accessToken = generateImpersonationToken({
    userId: docId(user._id),
    email: String(user.get('email') ?? ''),
    firstName: String(user.get('firstName') ?? ''),
    lastName: String(user.get('lastName') ?? ''),
    impersonatedBy: actor.id,
  });
  await recordAudit(actor, 'user.impersonate', 'user', userId);
  return { accessToken, expiresIn: '15m', userId };
}

export async function listUserNotes(userId: string) {
  const id = parseObjectId(userId, 'user id');
  return AdminNote.find({ userId: id }).sort({ createdAt: -1 }).lean();
}

export async function addUserNote(actor: Actor, userId: string, body: string) {
  const trimmed = body.trim();
  if (!trimmed) throw new ApiError(400, 'Note body is required.');
  const id = parseObjectId(userId, 'user id');
  const exists = await RainUser.exists({ _id: id });
  if (!exists) throw new ApiError(404, 'User not found.');
  const note = await AdminNote.create({
    userId: id,
    authorId: new Types.ObjectId(actor.id),
    authorEmail: actor.email,
    body: trimmed,
  });
  await recordAudit(actor, 'user.note', 'user', userId);
  return note;
}

export async function setUserTags(actor: Actor, userId: string, tags: string[]) {
  const id = parseObjectId(userId, 'user id');
  const exists = await RainUser.exists({ _id: id });
  if (!exists) throw new ApiError(404, 'User not found.');
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
  const doc = await AdminUserTag.findOneAndUpdate(
    { userId: id },
    { $set: { tags: cleaned } },
    { new: true, upsert: true },
  );
  await recordAudit(actor, 'user.tags', 'user', userId, { tags: cleaned });
  return doc;
}

export async function listAllUserTags() {
  const rows = await AdminUserTag.find().select('tags').lean();
  return [...new Set(rows.flatMap((row) => row.tags))].sort();
}
