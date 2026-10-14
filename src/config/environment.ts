/**
 * Configuration — same pattern as the other US services' src/config/environment.ts.
 */

function parseTrustProxy(value: string | undefined): number | false {
  if (value === undefined || value === '') return 1;
  const lower = value.toLowerCase();
  if (lower === 'false') return false;
  const hops = Number(value);
  if (Number.isFinite(hops) && hops >= 0) return hops;
  return 1;
}

const NON_PROD_ENVS = new Set(['development', 'dev', 'test', 'staging', 'local', 'qa']);
const NODE_ENV = (process.env.NODE_ENV || 'development').trim().toLowerCase();
const IS_PROD = !NON_PROD_ENVS.has(NODE_ENV);

const DEFAULT_JWT_SECRET = 'change-me-in-env';

function parseAllowlist(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  NODE_ENV,
  IS_PROD,
  PORT: process.env.PORT || 8004,
  SERVICE_NAME: process.env.SERVICE_NAME || 'admin-service',

  MONGODB_URL: process.env.MONGODB_URL || 'mongodb://localhost:27017/neo-bank-us',

  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || DEFAULT_JWT_SECRET,
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '8h',

  LOG_LEVEL: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  LOG_PRETTY: process.env.LOG_PRETTY ? process.env.LOG_PRETTY === 'true' : !IS_PROD,

  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT || '10mb',

  ADMIN_BOOTSTRAP_EMAIL: (process.env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase(),
  ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD || '',
  ADMIN_BOOTSTRAP_FIRST_NAME: process.env.ADMIN_BOOTSTRAP_FIRST_NAME || 'Admin',
  ADMIN_BOOTSTRAP_LAST_NAME: process.env.ADMIN_BOOTSTRAP_LAST_NAME || 'Operator',

  ADMIN_IP_ALLOWLIST: parseAllowlist(process.env.ADMIN_IP_ALLOWLIST),
} as const;

export type Config = typeof config;

export function validateConfig(): string[] {
  const warnings: string[] = [];

  if (config.IS_PROD && config.JWT_ACCESS_SECRET === DEFAULT_JWT_SECRET) {
    warnings.push('JWT_ACCESS_SECRET is using the insecure default value in production.');
  }
  if (!process.env.MONGODB_URL) {
    warnings.push('MONGODB_URL is not set; using the local default.');
  }
  if (config.IS_PROD && config.ADMIN_BOOTSTRAP_PASSWORD) {
    warnings.push(
      'ADMIN_BOOTSTRAP_PASSWORD is set in production. Remove it after the first admin exists.',
    );
  }

  for (const warning of warnings) {
    console.warn(`[config] ${warning}`);
  }
  return warnings;
}
