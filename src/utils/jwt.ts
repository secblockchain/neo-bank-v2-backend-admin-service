import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config/environment';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  principal: 'admin';
  iat?: number;
  exp?: number;
}

const ACCESS_EXPIRES_IN = config.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'];

export const generateAdminAccessToken = (
  payload: Omit<JwtPayload, 'principal' | 'iat' | 'exp'>,
): string =>
  jwt.sign({ ...payload, principal: 'admin' }, config.JWT_ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRES_IN,
  });

/**
 * Short-lived customer session for admin impersonation. Not an admin token.
 * Customer / US-provider auth treat `impersonatedBy` as a read-only session
 * (mutations return 403 except logout). Expires in 15 minutes.
 */
export const generateImpersonationToken = (payload: {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  impersonatedBy: string;
}): string =>
  jwt.sign(
    {
      userId: payload.userId,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      accountType: 'rain',
      impersonatedBy: payload.impersonatedBy,
      tokenKind: 'impersonation',
    },
    config.JWT_ACCESS_SECRET,
    { expiresIn: '15m' },
  );

export const verifyAccessToken = (token: string): JwtPayload =>
  jwt.verify(token, config.JWT_ACCESS_SECRET) as JwtPayload;
