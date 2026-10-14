import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import pinoHttp from 'pino-http';
import logger, { asyncStorage } from '../lib/logger';

const SKIP_LOG_PATHS = new Set(['/favicon.ico']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function resolveRequestId(headerValue: string | undefined): string {
  if (typeof headerValue === 'string' && REQUEST_ID_PATTERN.test(headerValue)) {
    return headerValue;
  }
  return randomUUID();
}

function getRequestPath(req: IncomingMessage): string {
  const url = req.url ?? '';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

export function resolveClientIp(req: Request): string | undefined {
  if (typeof req.ip === 'string' && req.ip.length > 0) return req.ip;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim();
  }
  return req.socket?.remoteAddress;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.get('X-Request-ID'));
  req.requestId = requestId;
  req.clientIp = resolveClientIp(req);
  res.setHeader('X-Request-ID', requestId);
  asyncStorage.run({ requestId }, () => next());
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as Request).requestId ?? randomUUID(),
  autoLogging: {
    ignore: (req) => SKIP_LOG_PATHS.has(getRequestPath(req)),
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req(req: IncomingMessage) {
      return {
        method: req.method,
        url: getRequestPath(req),
        userAgent: req.headers['user-agent'],
      };
    },
    res(res: ServerResponse) {
      return { statusCode: res.statusCode };
    },
  },
});
