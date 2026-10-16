import { Types } from 'mongoose';
import { RainUser, docId } from '../models/domain.models';

export type UserDisplay = {
  user_email: string | null;
  user_display_name: string | null;
  user_first_name: string | null;
  user_last_name: string | null;
};

function displayName(user: Record<string, unknown>): string | null {
  const first = typeof user.firstName === 'string' ? user.firstName : '';
  const last = typeof user.lastName === 'string' ? user.lastName : '';
  const combined = `${first} ${last}`.trim();
  if (combined) return combined;
  if (typeof user.displayName === 'string' && user.displayName.trim()) return user.displayName;
  if (typeof user.email === 'string' && user.email.trim()) return user.email;
  return null;
}

function collectIds(rows: Record<string, unknown>[], keys: string[]): Types.ObjectId[] {
  const seen = new Set<string>();
  const ids: Types.ObjectId[] = [];
  for (const row of rows) {
    for (const key of keys) {
      const raw = row[key];
      const idStr = docId(raw);
      if (!idStr || seen.has(idStr) || !Types.ObjectId.isValid(idStr)) continue;
      seen.add(idStr);
      ids.push(new Types.ObjectId(idStr));
    }
  }
  return ids;
}

/**
 * Attach non-breaking user display fields onto list rows.
 * Looks up RainUser by any of the given id keys (e.g. user_id, customerId, rainUser).
 */
export async function enrichWithUserDisplay<T extends Record<string, unknown>>(
  rows: T[],
  idKeys: string[] = ['user_id', 'userId', 'customerId', 'rainUser', 'user'],
): Promise<(T & UserDisplay)[]> {
  if (!rows.length) return [];
  const ids = collectIds(rows as Record<string, unknown>[], idKeys);
  if (!ids.length) {
    return rows.map((row) => ({
      ...row,
      user_email: null,
      user_display_name: null,
      user_first_name: null,
      user_last_name: null,
    }));
  }

  const users = await RainUser.find({ _id: { $in: ids } })
    .select('email firstName lastName displayName')
    .lean();
  const byId = new Map(
    users.map((user) => [String(user._id), user as unknown as Record<string, unknown>]),
  );

  return rows.map((row) => {
    let matched: Record<string, unknown> | undefined;
    for (const key of idKeys) {
      const idStr = docId(row[key]);
      if (!idStr) continue;
      const found = byId.get(idStr);
      if (found) {
        matched = found as Record<string, unknown>;
        break;
      }
    }
    return {
      ...row,
      user_email: typeof matched?.email === 'string' ? matched.email : null,
      user_display_name: matched ? displayName(matched) : null,
      user_first_name: typeof matched?.firstName === 'string' ? matched.firstName : null,
      user_last_name: typeof matched?.lastName === 'string' ? matched.lastName : null,
    };
  });
}
