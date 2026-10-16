import { PilotUser, RainUser } from '../models/domain.models';
import { ApiError } from '../utils/ApiError';
import { normalizeEmailAddress } from '../utils/normalizeEmail';
import { Actor, recordAudit } from './audit.service';

const NOTE_MAX_LENGTH = 500;
const ADDED_BY_MAX_LENGTH = 120;

function requireNormalized(email: string): string {
  const normalized = normalizeEmailAddress(email);
  if (!normalized) throw new ApiError(400, `"${email}" is not a valid e-mail address.`);
  return normalized;
}

function trimmedNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw new ApiError(400, `"note" must be at most ${NOTE_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

export async function listPilots(
  query: { search?: string; active?: boolean },
  skip: number,
  limit: number,
) {
  const filter: Record<string, unknown> = {};
  if (typeof query.active === 'boolean') filter.active = query.active;
  if (query.search?.trim()) {
    filter.email = { $regex: query.search.trim().toLowerCase(), $options: 'i' };
  }

  const [total, items] = await Promise.all([
    PilotUser.countDocuments(filter),
    PilotUser.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { items, total };
}

/**
 * Add a customer to the pilot, or re-activate a previously removed one.
 * Only existing RainUser accounts can be added.
 */
export async function addPilot(actor: Actor, email: string, note?: string) {
  const normalized = requireNormalized(email);
  if ((await RainUser.exists({ email: normalized })) === null) {
    throw new ApiError(
      404,
      `No registered user found for "${email}". Only existing customers can be added.`,
    );
  }

  const set: Record<string, unknown> = {
    active: true,
    deactivatedAt: null,
    addedBy: actor.email.slice(0, ADDED_BY_MAX_LENGTH),
  };
  const cleanedNote = trimmedNote(note);
  if (cleanedNote !== undefined) set.note = cleanedNote;

  const pilot = await PilotUser.findOneAndUpdate(
    { email: normalized },
    { $set: set, $setOnInsert: { email: normalized } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await recordAudit(actor, 'pilot.add', 'pilot', normalized, {
    note: cleanedNote ?? null,
  });

  return pilot;
}

/** Soft-deactivate an active pilot. Returns 404 when they were not actively on the list. */
export async function deactivatePilot(actor: Actor, email: string) {
  const normalized = requireNormalized(email);
  const result = await PilotUser.findOneAndUpdate(
    { email: normalized, active: true },
    { $set: { active: false, deactivatedAt: new Date() } },
    { new: true },
  );
  if (!result) {
    throw new ApiError(404, `No active pilot found for "${email}".`);
  }

  await recordAudit(actor, 'pilot.deactivate', 'pilot', normalized);
  return result;
}
