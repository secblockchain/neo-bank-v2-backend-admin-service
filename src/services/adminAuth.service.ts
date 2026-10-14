import bcrypt from 'bcryptjs';
import { config } from '../config/environment';
import { ADMIN_ROLE, isAdminRole, permissionsForRole } from '../enums/adminRoles';
import { AdminAccount, IAdminAccount } from '../models/admin.models';
import { ApiError } from '../utils/ApiError';
import { generateAdminAccessToken } from '../utils/jwt';
import { parseObjectId } from '../utils/query';
import { Actor, recordAudit } from './audit.service';

const PUBLIC_ADMIN =
  'email firstName lastName role active createdAt updatedAt sessionsInvalidatedAt';

export function toPublicAdmin(admin: IAdminAccount) {
  return {
    id: String(admin._id),
    email: admin.email,
    firstName: admin.firstName,
    lastName: admin.lastName,
    role: admin.role,
    active: admin.active,
    permissions: permissionsForRole(admin.role),
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
  };
}

export async function loginAdmin(email: string, password: string) {
  const admin = await AdminAccount.findOne({ email: email.toLowerCase() }).select('+password');
  if (!admin || !admin.active) {
    throw new ApiError(401, 'Invalid email or password.');
  }
  const matches = await bcrypt.compare(password, admin.password);
  if (!matches) {
    throw new ApiError(401, 'Invalid email or password.');
  }
  const accessToken = generateAdminAccessToken({
    userId: String(admin._id),
    email: admin.email,
    role: admin.role,
  });
  return { accessToken, admin: toPublicAdmin(admin) };
}

export async function logoutAdmin(actor: Actor) {
  await AdminAccount.updateOne({ _id: actor.id }, { $set: { sessionsInvalidatedAt: new Date() } });
  await recordAudit(actor, 'admin.logout', 'admin', actor.id);
}

export async function listAdmins() {
  const admins = await AdminAccount.find().select(PUBLIC_ADMIN).sort({ createdAt: -1 });
  return admins.map((admin) => toPublicAdmin(admin));
}

export async function createAdmin(
  actor: Actor,
  input: { email: string; password: string; firstName: string; lastName: string; role: string },
) {
  if (!isAdminRole(input.role)) {
    throw new ApiError(400, 'Unknown admin role.');
  }
  if (input.password.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters.');
  }
  const password = await bcrypt.hash(input.password, 12);
  const admin = await AdminAccount.create({
    email: input.email.toLowerCase(),
    password,
    firstName: input.firstName,
    lastName: input.lastName,
    role: input.role,
    active: true,
  });
  await recordAudit(actor, 'admin.create', 'admin', String(admin._id), { role: input.role });
  return toPublicAdmin(admin);
}

export async function updateAdminRole(actor: Actor, userId: string, role: string) {
  if (!isAdminRole(role)) throw new ApiError(400, 'Unknown admin role.');
  if (actor.id === userId) throw new ApiError(400, 'You cannot change your own role.');
  const admin = await AdminAccount.findById(parseObjectId(userId, 'admin id'));
  if (!admin) throw new ApiError(404, 'Admin not found.');
  admin.role = role;
  admin.sessionsInvalidatedAt = new Date();
  await admin.save();
  await recordAudit(actor, 'admin.role', 'admin', userId, { role });
  return toPublicAdmin(admin);
}

export async function ensureBootstrapAdmin(): Promise<void> {
  if (!config.ADMIN_BOOTSTRAP_EMAIL || !config.ADMIN_BOOTSTRAP_PASSWORD) return;
  const existing = await AdminAccount.findOne({ email: config.ADMIN_BOOTSTRAP_EMAIL });
  if (existing) return;
  const password = await bcrypt.hash(config.ADMIN_BOOTSTRAP_PASSWORD, 12);
  await AdminAccount.create({
    email: config.ADMIN_BOOTSTRAP_EMAIL,
    password,
    firstName: config.ADMIN_BOOTSTRAP_FIRST_NAME,
    lastName: config.ADMIN_BOOTSTRAP_LAST_NAME,
    role: ADMIN_ROLE.SUPER_ADMIN,
    active: true,
  });
}
