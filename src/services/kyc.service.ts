import { FilterQuery } from 'mongoose';
import { RainKyb, RainKyc, RainUser, USER_SECRET_FIELDS } from '../models/domain.models';
import { ApiError } from '../utils/ApiError';
import { escapeRegex, parseObjectId } from '../utils/query';
import { Actor, recordAudit } from './audit.service';

const KYC_STATUSES = [
  'NOT_INITIATED',
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'TEMPORARY_REJECTION',
] as const;

export async function getKycAnalytics() {
  const rows = await RainKyc.aggregate<{ _id: string | null; count: number }>([
    { $group: { _id: '$kycApprovedStatus', count: { $sum: 1 } } },
  ]);
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    byStatus: Object.fromEntries(rows.map((row) => [row._id ?? 'unknown', row.count])),
  };
}

export async function listKyc(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<Record<string, unknown>> = {};
  const status = typeof query.status === 'string' ? query.status.trim() : '';
  const email = typeof query.email === 'string' ? query.email.trim().toLowerCase() : '';
  if (status) filter.kycApprovedStatus = status;
  if (query.pending === 'true') {
    filter.kycApprovedStatus = { $in: ['REQUESTED', 'NOT_INITIATED', 'TEMPORARY_REJECTION'] };
  }

  if (email) {
    const user = await RainUser.findOne({ email }).select('_id');
    filter.rainUser = user?._id ?? null;
  }

  const [total, records] = await Promise.all([
    RainKyc.countDocuments(filter),
    RainKyc.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  const userIds = records.map((record) => record.rainUser).filter(Boolean);
  const users = await RainUser.find({ _id: { $in: userIds } })
    .select('email firstName lastName country accountKind')
    .lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));
  const items = records.map((record) => ({
    ...record,
    user: byId.get(String(record.rainUser)) ?? null,
  }));
  return { items, total };
}

export async function getKycByUser(userId: string) {
  const id = parseObjectId(userId, 'user id');
  const [user, kyc] = await Promise.all([
    RainUser.findById(id).select(USER_SECRET_FIELDS).lean(),
    RainKyc.findOne({ rainUser: id }).lean(),
  ]);
  if (!user) throw new ApiError(404, 'User not found.');
  if (!kyc) throw new ApiError(404, 'KYC record not found.');
  return { user, kyc };
}

export async function updateKycStatus(
  actor: Actor,
  userId: string,
  kycApprovedStatus: string,
  rejectionReason?: string,
) {
  if (!(KYC_STATUSES as readonly string[]).includes(kycApprovedStatus)) {
    throw new ApiError(400, `kycApprovedStatus must be one of: ${KYC_STATUSES.join(', ')}`);
  }
  const id = parseObjectId(userId, 'user id');
  const now = new Date();
  const updated = await RainKyc.findOneAndUpdate(
    { rainUser: id },
    {
      $set: {
        kycApprovedStatus,
        rejectionReason: kycApprovedStatus === 'REJECTED' ? rejectionReason || null : null,
        ...(kycApprovedStatus === 'APPROVED' ? { approvedAt: now } : {}),
        ...(kycApprovedStatus === 'REJECTED' ? { rejectedAt: now } : {}),
      },
      $push: {
        statusHistory: {
          $each: [
            {
              toStatus: kycApprovedStatus,
              statusChangeReason: rejectionReason || 'Updated by admin',
              source: 'api_sync',
              recordedAt: now,
            },
          ],
          $slice: -50,
        },
      },
    },
    { new: true },
  );
  if (!updated) throw new ApiError(404, 'KYC record not found.');
  await recordAudit(actor, 'kyc.status', 'kyc', userId, { kycApprovedStatus });
  return updated;
}

export async function listKyb(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<Record<string, unknown>> = {};
  const status = typeof query.status === 'string' ? query.status.trim() : '';
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (status) filter.kycApprovedStatus = status;
  if (search) {
    filter.$or = [
      { companyName: new RegExp(escapeRegex(search), 'i') },
      { email: new RegExp(escapeRegex(search), 'i') },
    ];
  }
  const [total, items] = await Promise.all([
    RainKyb.countDocuments(filter),
    RainKyb.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

export async function getKybByUser(userId: string) {
  const kyb = await RainKyb.findOne({ rainUser: parseObjectId(userId, 'user id') }).lean();
  if (!kyb) throw new ApiError(404, 'KYB record not found.');
  return kyb;
}

export async function updateKybStatus(actor: Actor, userId: string, kycApprovedStatus: string) {
  if (!(KYC_STATUSES as readonly string[]).includes(kycApprovedStatus)) {
    throw new ApiError(400, `kycApprovedStatus must be one of: ${KYC_STATUSES.join(', ')}`);
  }
  const updated = await RainKyb.findOneAndUpdate(
    { rainUser: parseObjectId(userId, 'user id') },
    { $set: { kycApprovedStatus } },
    { new: true },
  );
  if (!updated) throw new ApiError(404, 'KYB record not found.');
  await recordAudit(actor, 'kyb.status', 'kyb', userId, { kycApprovedStatus });
  return updated;
}
