import { Request, Response, NextFunction } from 'express';
import { AdminAccount } from '../models/admin.models';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { asyncStorage } from '../lib/logger';

export const authenticateAdmin = async (req: Request, _res: Response, next: NextFunction) => {
  // Prefer Authorization so a browser cookie from the customer app (same localhost
  // domain) cannot override an explicit admin Bearer token.
  const bearer = req
    .header('Authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim();
  const token = bearer || req.cookies?.accessToken || req.cookies?.adminAccessToken;

  if (!token) {
    throw new ApiError(401, 'Access denied. No token provided.');
  }

  const decoded = verifyAccessToken(token);
  if (decoded.principal !== 'admin' || !decoded.userId) {
    throw new ApiError(401, 'Invalid token. Admin session required.');
  }

  const admin = await AdminAccount.findById(decoded.userId);
  if (!admin || !admin.active) {
    throw new ApiError(401, 'Invalid token. Admin not found.');
  }

  if (
    admin.sessionsInvalidatedAt &&
    typeof decoded.iat === 'number' &&
    decoded.iat <= Math.floor(admin.sessionsInvalidatedAt.getTime() / 1000)
  ) {
    throw new ApiError(401, 'Invalid token. Session has ended.');
  }

  req.user = decoded;
  req.admin = admin;
  req.accessToken = token;

  const store = asyncStorage.getStore();
  if (store) store.userId = String(admin._id);

  next();
};
