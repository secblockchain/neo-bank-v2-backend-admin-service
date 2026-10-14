import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { config } from '../config/environment';
import { PINO_REDACT_PATHS } from '../utils/logSanitize';

export interface LogContext {
  requestId?: string;
  userId?: string;
}

export const asyncStorage = new AsyncLocalStorage<LogContext>();

export function getRequestId(): string | undefined {
  return asyncStorage.getStore()?.requestId;
}

function createTransport(): pino.TransportSingleOptions | undefined {
  if (!config.LOG_PRETTY) return undefined;
  return {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' },
  };
}

const transportOptions = createTransport();
const transport = transportOptions ? pino.transport(transportOptions) : undefined;

const logger = pino(
  {
    level: config.LOG_LEVEL,
    base: { service: config.SERVICE_NAME, env: config.NODE_ENV },
    mixin(): Partial<LogContext> {
      const store = asyncStorage.getStore();
      const context: Partial<LogContext> = {};
      if (store?.requestId) context.requestId = store.requestId;
      if (store?.userId) context.userId = store.userId;
      return context;
    },
    redact: {
      paths: [...PINO_REDACT_PATHS],
      censor: '[REDACTED]',
    },
  },
  transport,
);

export default logger;
