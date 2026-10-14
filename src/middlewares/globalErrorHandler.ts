import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { sendErrorResponse } from '../utils/apiResponseHandler';
import { config } from '../config/environment';
import logger from '../lib/logger';
import { sanitizeForLog, stripQueryFromUrl } from '../utils/logSanitize';

interface ExtendedError extends Error {
  statusCode?: number;
  code?: string;
}

export function globalErrorHandler(
  err: ExtendedError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    logger.error({ message: err.message }, 'Error after headers sent');
    return;
  }

  let statusCode = 500;
  let message = 'Internal Server Error';
  let details: string | object = '';
  let isOperational = false;

  if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid resource ID';
    isOperational = true;
  } else if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation Error';
    isOperational = true;
  } else if (err.code === '11000') {
    statusCode = 409;
    message = 'Duplicate field value entered';
    isOperational = true;
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
    isOperational = true;
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
    isOperational = true;
  } else if (err instanceof SyntaxError && 'body' in err) {
    statusCode = 400;
    message = 'Invalid JSON format';
    isOperational = true;
  }

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details ?? '';
    isOperational = true;

    if (statusCode >= 500 && config.IS_PROD && !err.clientSafe) {
      message = 'Something went wrong';
      details = '';
    }
  }

  if (statusCode >= 500 && !isOperational && config.IS_PROD) {
    message = 'Something went wrong';
  }

  const logPayload = {
    err,
    method: req.method,
    path: stripQueryFromUrl(req.originalUrl),
    requestId: req.requestId,
    body: sanitizeForLog(req.body),
  };
  if (statusCode >= 500) {
    logger.error(logPayload, err.message || 'Unexpected error');
  } else {
    logger.warn(logPayload, err.message || 'Operational error');
  }

  sendErrorResponse(
    res,
    statusCode,
    {
      success: false,
      message,
      ...(details !== '' ? { details } : {}),
      stack: !config.IS_PROD ? err.stack : undefined,
    },
    { requestId: req.requestId },
  );
}
