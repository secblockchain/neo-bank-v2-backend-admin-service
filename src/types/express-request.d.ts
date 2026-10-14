import 'express-serve-static-core';
import type { JwtPayload } from '../utils/jwt';
import type { IAdminAccount } from '../models/admin.models';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    clientIp?: string;
    user?: JwtPayload;
    accessToken?: string;
    admin?: IAdminAccount;
  }
}
