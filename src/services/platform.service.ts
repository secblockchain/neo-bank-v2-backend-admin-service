import { Types } from 'mongoose';
import {
  FeatureFlag,
  FraudCase,
  FRAUD_CASE_STATUSES,
  PendingAction,
  SavedView,
  SecuritySettings,
} from '../models/admin.models';
import { AdminAudit } from '../models/admin.models';
import { ApiError } from '../utils/ApiError';
import { parseObjectId } from '../utils/query';
import { Actor, recordAudit } from './audit.service';
import { setAccountStatus } from './users.service';
import { updateKycStatus } from './kyc.service';
import { setSubscriptionStatus } from './subscriptions.service';

export async function listAudit(skip: number, limit: number) {
  const [total, items] = await Promise.all([
    AdminAudit.countDocuments(),
    AdminAudit.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

export async function listFeatureFlags() {
  return FeatureFlag.find().sort({ key: 1 }).lean();
}

export async function upsertFeatureFlag(
  actor: Actor,
  input: { key: string; description?: string; enabled: boolean },
) {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(key)) {
    throw new ApiError(400, 'Flag key must be 2-64 characters: a-z, 0-9, _ or -.');
  }
  const flag = await FeatureFlag.findOneAndUpdate(
    { key },
    {
      $set: {
        description: input.description ?? '',
        enabled: input.enabled,
        updatedBy: actor.email,
      },
    },
    { new: true, upsert: true },
  );
  await recordAudit(actor, 'feature_flag.upsert', 'feature_flag', key, { enabled: input.enabled });
  return flag;
}

export async function deleteFeatureFlag(actor: Actor, key: string) {
  const deleted = await FeatureFlag.findOneAndDelete({ key: key.toLowerCase() });
  if (!deleted) throw new ApiError(404, 'Feature flag not found.');
  await recordAudit(actor, 'feature_flag.delete', 'feature_flag', key);
  return { deleted: true };
}

export async function listSavedViews(ownerId: string) {
  return SavedView.find({ ownerId }).sort({ updatedAt: -1 }).lean();
}

export async function saveSavedView(
  actor: Actor,
  input: { name: string; resource: string; query?: Record<string, unknown> },
) {
  return SavedView.create({
    ownerId: new Types.ObjectId(actor.id),
    name: input.name.trim(),
    resource: input.resource.trim(),
    query: input.query ?? {},
  });
}

export async function deleteSavedView(actor: Actor, id: string) {
  const deleted = await SavedView.findOneAndDelete({
    _id: parseObjectId(id, 'view id'),
    ownerId: actor.id,
  });
  if (!deleted) throw new ApiError(404, 'Saved view not found.');
  return { deleted: true };
}

export async function listFraudCases(skip: number, limit: number, status?: string) {
  const filter = status ? { status } : {};
  const [total, items] = await Promise.all([
    FraudCase.countDocuments(filter),
    FraudCase.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

export async function createFraudCase(
  actor: Actor,
  input: { title: string; summary?: string; userId?: string },
) {
  const fraudCase = await FraudCase.create({
    title: input.title.trim(),
    summary: input.summary?.trim() ?? '',
    userId: input.userId ? parseObjectId(input.userId, 'user id') : undefined,
    createdBy: actor.email,
    status: 'open',
  });
  await recordAudit(actor, 'fraud.create', 'fraud_case', String(fraudCase._id));
  return fraudCase;
}

export async function updateFraudCaseStatus(actor: Actor, id: string, status: string) {
  if (!(FRAUD_CASE_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `status must be one of: ${FRAUD_CASE_STATUSES.join(', ')}`);
  }
  const fraudCase = await FraudCase.findByIdAndUpdate(
    parseObjectId(id, 'case id'),
    { $set: { status } },
    { new: true },
  );
  if (!fraudCase) throw new ApiError(404, 'Fraud case not found.');
  await recordAudit(actor, 'fraud.status', 'fraud_case', id, { status });
  return fraudCase;
}

export async function addFraudNote(actor: Actor, id: string, body: string) {
  const fraudCase = await FraudCase.findByIdAndUpdate(
    parseObjectId(id, 'case id'),
    { $push: { notes: { authorEmail: actor.email, body: body.trim(), createdAt: new Date() } } },
    { new: true },
  );
  if (!fraudCase) throw new ApiError(404, 'Fraud case not found.');
  return fraudCase;
}

export async function listPendingActions(skip: number, limit: number, status?: string) {
  const filter = status ? { status } : {};
  const [total, items] = await Promise.all([
    PendingAction.countDocuments(filter),
    PendingAction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

export async function proposeAction(
  actor: Actor,
  input: { type: string; payload: Record<string, unknown> },
) {
  const type = input.type.trim();
  if (!type) throw new ApiError(400, 'type is required.');
  const action = await PendingAction.create({
    type,
    payload: input.payload,
    proposedBy: new Types.ObjectId(actor.id),
    proposedByEmail: actor.email,
    status: 'pending',
  });
  await recordAudit(actor, 'pending_action.propose', 'pending_action', String(action._id), {
    type,
  });
  return action;
}

async function applyPendingAction(actor: Actor, type: string, payload: Record<string, unknown>) {
  if (type === 'account_status') {
    return setAccountStatus(
      actor,
      String(payload.userId ?? ''),
      String(payload.accountStatus ?? ''),
    );
  }
  if (type === 'kyc_status') {
    return updateKycStatus(
      actor,
      String(payload.userId ?? ''),
      String(payload.kycApprovedStatus ?? ''),
      typeof payload.rejectionReason === 'string' ? payload.rejectionReason : undefined,
    );
  }
  if (type === 'subscription_status') {
    return setSubscriptionStatus(
      actor,
      String(payload.subscriptionId ?? ''),
      String(payload.status ?? ''),
    );
  }
  if (type === 'card_lock' || type === 'card_unlock' || type === 'card_status') {
    const commerce = await import('./commerce.service');
    const cardId = String(payload.cardId ?? '');
    if (type === 'card_lock') return commerce.lockCard(actor, cardId);
    if (type === 'card_unlock') return commerce.unlockCard(actor, cardId);
    return commerce.setCardStatus(actor, cardId, String(payload.status ?? ''));
  }
  if (type === 'savings_status' || type === 'savings_terminate') {
    const commerce = await import('./commerce.service');
    const planId = String(payload.planId ?? '');
    if (type === 'savings_terminate') {
      return commerce.terminateSavingsPlan(
        actor,
        planId,
        typeof payload.path === 'string' ? payload.path : undefined,
      );
    }
    return commerce.setSavingsStatus(actor, planId, String(payload.status ?? ''));
  }
  return { applied: false, reason: 'Recorded only. This action type has no automatic apply.' };
}

export async function decidePendingAction(
  actor: Actor,
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
) {
  const action = await PendingAction.findById(parseObjectId(id, 'action id'));
  if (!action) throw new ApiError(404, 'Pending action not found.');
  if (action.status !== 'pending') throw new ApiError(409, 'This action is already decided.');
  if (String(action.proposedBy) === actor.id) {
    throw new ApiError(403, 'The proposer cannot approve or reject their own action.');
  }

  let result: unknown = null;
  if (decision === 'approved') {
    result = await applyPendingAction(actor, action.type, action.payload);
  }

  action.status = decision;
  action.decidedBy = new Types.ObjectId(actor.id);
  action.decidedByEmail = actor.email;
  action.decisionNote = note;
  action.decidedAt = new Date();
  await action.save();
  await recordAudit(actor, `pending_action.${decision}`, 'pending_action', id);
  return { action, result };
}

export async function getSecuritySettings() {
  const settings = await SecuritySettings.findOne({ key: 'default' }).lean();
  return settings ?? { key: 'default', killSwitch: false, ipAllowlist: [] };
}

export async function setKillSwitch(actor: Actor, enabled: boolean) {
  const settings = await SecuritySettings.findOneAndUpdate(
    { key: 'default' },
    { $set: { killSwitch: enabled, updatedBy: actor.email }, $setOnInsert: { key: 'default' } },
    { new: true, upsert: true },
  );
  await recordAudit(actor, 'security.kill_switch', 'security', 'default', { enabled });
  return settings;
}

export async function updateIpAllowlist(actor: Actor, ipAllowlist: string[]) {
  const cleaned = [...new Set(ipAllowlist.map((ip) => ip.trim()).filter(Boolean))];
  const settings = await SecuritySettings.findOneAndUpdate(
    { key: 'default' },
    { $set: { ipAllowlist: cleaned, updatedBy: actor.email }, $setOnInsert: { key: 'default' } },
    { new: true, upsert: true },
  );
  await recordAudit(actor, 'security.ip_allowlist', 'security', 'default', {
    count: cleaned.length,
  });
  return settings;
}

export async function revokeAdminSession(actor: Actor, adminId: string) {
  const { AdminAccount } = await import('../models/admin.models');
  const admin = await AdminAccount.findByIdAndUpdate(
    parseObjectId(adminId, 'admin id'),
    { $set: { sessionsInvalidatedAt: new Date() } },
    { new: true },
  ).select('email');
  if (!admin) throw new ApiError(404, 'Admin not found.');
  await recordAudit(actor, 'admin.revoke_session', 'admin', adminId);
  return { revoked: true, email: admin.email };
}
