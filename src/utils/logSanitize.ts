const SENSITIVE_KEY =
  /password|secret|token|authorization|signature|api[_-]?key|refresh[_-]?token|access[_-]?token|otp|cvv|iban|account[_-]?number|ssn|passport|client[_-]?secret/i;

export function stripQueryFromUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (value.includes('?') && (value.startsWith('http') || value.startsWith('/'))) {
      return stripQueryFromUrl(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeForLog(val, depth + 1);
    }
    return out;
  }

  return value;
}

export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.Authorization',
  'body.password',
  'body.confirmPassword',
  'body.token',
  'body.accessToken',
  'password',
  'secret',
  'otp',
] as const;
