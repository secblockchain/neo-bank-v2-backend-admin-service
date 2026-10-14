import { Request, Response, NextFunction } from 'express';
import { config } from '../config/environment';
import { SecuritySettings } from '../models/admin.models';
import { ApiError } from '../utils/ApiError';

const KILL_SWITCH_SAFE = new Set([
  '/security/kill-switch',
  '/security/settings',
  '/admins/me/permissions',
  '/auth/logout',
]);

function adminPath(req: Request): string {
  const path = req.path || '';
  const marker = '/admin';
  const index = path.indexOf(marker);
  return index === -1 ? path : path.slice(index + marker.length);
}

export async function adminGuard(req: Request, _res: Response, next: NextFunction) {
  const settings = await SecuritySettings.findOne({ key: 'default' }).lean();
  const allowlist = [...config.ADMIN_IP_ALLOWLIST, ...(settings?.ipAllowlist ?? [])];
  if (allowlist.length > 0 && (!req.clientIp || !allowlist.includes(req.clientIp))) {
    throw new ApiError(403, 'This IP address is not allowed to use the admin API.');
  }

  if (req.method === 'GET' || KILL_SWITCH_SAFE.has(adminPath(req))) {
    return next();
  }

  if (settings?.killSwitch) {
    throw new ApiError(423, 'Admin write operations are disabled by the kill switch.');
  }
  next();
}
