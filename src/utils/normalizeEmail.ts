/**
 * Normalize an e-mail the same way customer-service auth / pilot checks do
 * (express-validator `normalizeEmail()` defaults): lower-case, and for Gmail /
 * Outlook / Yahoo / iCloud strip subaddress / dots as those providers ignore them.
 *
 * Returns null when the value is not a plausible e-mail address.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const OUTLOOK_DOMAINS = new Set([
  'hotmail.com',
  'live.com',
  'outlook.com',
  'msn.com',
]);
const YAHOO_DOMAINS = new Set([
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'ymail.com',
  'rocketmail.com',
]);
const ICLOUD_DOMAINS = new Set(['icloud.com', 'me.com', 'mac.com']);

function stripSubaddress(local: string, separator: string): string {
  const idx = local.indexOf(separator);
  return idx === -1 ? local : local.slice(0, idx);
}

export function normalizeEmailAddress(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 254) return null;
  if (!EMAIL_RE.test(trimmed)) return null;

  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;

  let local = trimmed.slice(0, at).toLowerCase();
  let domain = trimmed.slice(at + 1).toLowerCase();

  if (GMAIL_DOMAINS.has(domain)) {
    local = stripSubaddress(local, '+').replace(/\./g, '');
    domain = 'gmail.com';
  } else if (OUTLOOK_DOMAINS.has(domain)) {
    local = stripSubaddress(local, '+');
  } else if (YAHOO_DOMAINS.has(domain)) {
    local = stripSubaddress(local, '-');
  } else if (ICLOUD_DOMAINS.has(domain)) {
    local = stripSubaddress(local, '+');
  }

  if (!local || !domain) return null;
  return `${local}@${domain}`;
}
