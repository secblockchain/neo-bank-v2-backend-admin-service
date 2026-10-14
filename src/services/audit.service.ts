import { Types } from 'mongoose';
import { Request } from 'express';
import { AdminAudit } from '../models/admin.models';

export interface Actor {
  id: string;
  email: string;
  ip?: string;
}

export function actorFromRequest(req: Request): Actor {
  return {
    id: String(req.admin?._id || req.user?.userId || ''),
    email: req.admin?.email || req.user?.email || '',
    ip: req.clientIp,
  };
}

export async function recordAudit(
  actor: Actor,
  action: string,
  entityType: string,
  entityId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await AdminAudit.create({
    actorId: new Types.ObjectId(actor.id),
    actorEmail: actor.email,
    action,
    entityType,
    entityId,
    metadata,
    ipAddress: actor.ip,
  });
}
