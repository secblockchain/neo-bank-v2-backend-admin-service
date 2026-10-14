import { FilterQuery } from 'mongoose';
import { Charge, Package, Subscription } from '../models/domain.models';
import { ApiError } from '../utils/ApiError';
import { parseObjectId } from '../utils/query';
import { Actor, recordAudit } from './audit.service';

const SUBSCRIPTION_STATUSES = [
  'PENDING',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELED',
  'CLOSED',
] as const;

export async function getSubscriptionAnalytics() {
  const rows = await Subscription.aggregate<{
    _id: { status: string; accountType: string };
    count: number;
  }>([{ $group: { _id: { status: '$status', accountType: '$accountType' }, count: { $sum: 1 } } }]);
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    groups: rows.map((row) => ({ ...row._id, count: row.count })),
  };
}

export async function listSubscriptions(
  query: Record<string, unknown>,
  skip: number,
  limit: number,
) {
  const filter: FilterQuery<Record<string, unknown>> = {};
  if (typeof query.status === 'string' && query.status) filter.status = query.status;
  if (typeof query.accountType === 'string' && query.accountType)
    filter.accountType = query.accountType;
  if (typeof query.userId === 'string' && query.userId) {
    filter.user_id = parseObjectId(query.userId, 'user id');
  }
  const [total, items] = await Promise.all([
    Subscription.countDocuments(filter),
    Subscription.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

export async function getSubscription(subscriptionId: string) {
  const subscription = await Subscription.findById(
    parseObjectId(subscriptionId, 'subscription id'),
  ).lean();
  if (!subscription) throw new ApiError(404, 'Subscription not found.');
  return subscription;
}

export async function setSubscriptionStatus(actor: Actor, subscriptionId: string, status: string) {
  if (!(SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`);
  }
  const now = new Date();
  const patch: Record<string, unknown> = { status };
  if (status === 'SUSPENDED') patch.suspended_at = now;
  if (status === 'ACTIVE') {
    patch.suspended_at = null;
    patch.past_due_since = null;
  }
  const updated = await Subscription.findByIdAndUpdate(
    parseObjectId(subscriptionId, 'subscription id'),
    { $set: patch },
    { new: true },
  );
  if (!updated) throw new ApiError(404, 'Subscription not found.');
  await recordAudit(actor, 'subscription.status', 'subscription', subscriptionId, { status });
  return updated;
}

export async function listCharges(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<Record<string, unknown>> = {};
  if (typeof query.userId === 'string' && query.userId) {
    filter.user_id = parseObjectId(query.userId, 'user id');
  }
  if (typeof query.status === 'string' && query.status) filter.status = query.status;
  const [total, items] = await Promise.all([
    Charge.countDocuments(filter),
    Charge.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

export async function listPackages() {
  return Package.find().sort({ displayName: 1 }).lean();
}
