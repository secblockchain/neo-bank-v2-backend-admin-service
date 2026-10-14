import { FilterQuery, Model } from 'mongoose';
import {
  Card,
  Charge,
  Logs,
  PayPalOrder,
  RainKyb,
  RainKyc,
  RainUser,
  SavingsPlan,
  StripePayment,
  Subscription,
  WertTransaction,
  LooseDoc,
} from '../models/domain.models';

async function countBy(model: Model<LooseDoc>, field: string, emptyLabel = 'unknown') {
  const rows = await model.aggregate<{ _id: string | null; count: number }>([
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((row) => [row._id ?? emptyLabel, row.count]));
}

async function safeCount(model: Model<LooseDoc>, filter: FilterQuery<LooseDoc> = {}) {
  return model.countDocuments(filter);
}

export async function getDashboardOverview() {
  const [
    users,
    usersByStatus,
    usersByKind,
    kycByStatus,
    subscriptionsByStatus,
    cardsByStatus,
    paypal,
    stripe,
    wert,
    savings,
    charges,
    kyb,
  ] = await Promise.all([
    safeCount(RainUser),
    countBy(RainUser, 'accountStatus', 'active'),
    countBy(RainUser, 'accountKind'),
    countBy(RainKyc, 'kycApprovedStatus'),
    countBy(Subscription, 'status'),
    countBy(Card, 'status'),
    safeCount(PayPalOrder),
    safeCount(StripePayment),
    safeCount(WertTransaction),
    safeCount(SavingsPlan),
    safeCount(Charge),
    safeCount(RainKyb),
  ]);

  return {
    users: { total: users, byStatus: usersByStatus, byAccountKind: usersByKind },
    kyc: { byStatus: kycByStatus },
    kyb: { total: kyb },
    subscriptions: { byStatus: subscriptionsByStatus },
    cards: { byStatus: cardsByStatus },
    payments: { paypal, stripe, wert },
    savings: { total: savings },
    charges: { total: charges },
  };
}

export async function listSystemLogs(page: number, limit: number, skip: number) {
  const [total, items] = await Promise.all([
    Logs.countDocuments(),
    Logs.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total, page, limit };
}
