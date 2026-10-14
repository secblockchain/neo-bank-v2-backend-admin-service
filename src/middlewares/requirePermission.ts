import { Request, Response, NextFunction } from 'express';
import { ADMIN_PERMISSION, ADMIN_ROLE, roleHasPermission } from '../enums/adminRoles';
import { ApiError } from '../utils/ApiError';

export function requirePermission(...permissions: ADMIN_PERMISSION[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.admin?.role;
    if (!role || !permissions.every((permission) => roleHasPermission(role, permission))) {
      throw new ApiError(403, 'You do not have permission to perform this action.');
    }
    next();
  };
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.admin?.role !== ADMIN_ROLE.SUPER_ADMIN) {
    throw new ApiError(403, 'Super admin privileges required.');
  }
  next();
}
