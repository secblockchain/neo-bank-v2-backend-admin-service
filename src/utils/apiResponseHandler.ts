import { Response } from 'express';

export interface ApiResponse<T, M = Record<string, unknown>> {
  success: boolean;
  message: string;
  data: T | null;
  meta?: M;
  requestId?: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  details?: string | object | Array<{ field: string; message: string }>;
  timestamp: string;
  requestId?: string;
  stack?: string;
}

export interface ResponseOptions {
  requestId?: string;
  headers?: Record<string, string>;
  cacheControl?: string;
}

export function sendResponse<T, M = Record<string, unknown>>(
  res: Response,
  statusCode: number,
  payload: Omit<ApiResponse<T, M>, 'timestamp' | 'requestId'>,
  options: ResponseOptions = {},
) {
  const { requestId, headers, cacheControl } = options;

  if (headers) {
    Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  }
  if (cacheControl) {
    res.setHeader('Cache-Control', cacheControl);
  }

  res.status(statusCode).json({
    ...payload,
    timestamp: new Date().toISOString(),
    requestId,
  });
}

export function sendErrorResponse(
  res: Response,
  statusCode: number,
  payload: Omit<ApiErrorResponse, 'timestamp' | 'requestId'>,
  options: ResponseOptions = {},
) {
  const { requestId } = options;

  const body: Record<string, unknown> = {
    success: false,
    message: payload.message,
    timestamp: new Date().toISOString(),
    requestId,
  };

  if (payload.details !== undefined && payload.details !== '') {
    body.details = payload.details;
  }
  if (payload.stack) {
    body.stack = payload.stack;
  }

  res.status(statusCode).json(body);
}

export function sendSuccessResponse<M = Record<string, unknown>>(
  res: Response,
  data: object | object[],
  message: string = 'Success',
  meta?: M,
  options?: ResponseOptions,
) {
  return sendResponse(res, 200, { success: true, message, data, meta }, options);
}

export function sendCreatedResponse<M = Record<string, unknown>>(
  res: Response,
  data: object | object[],
  message: string = 'Resource created successfully',
  meta?: M,
  options?: ResponseOptions,
) {
  return sendResponse(res, 201, { success: true, message, data, meta }, options);
}

export function sendPaginatedResponse(
  res: Response,
  data: object[],
  page: number,
  limit: number,
  total: number,
  message: string = 'Data retrieved successfully',
  options?: ResponseOptions,
) {
  const totalPages = Math.ceil(total / limit);
  return sendResponse<object[]>(
    res,
    200,
    {
      success: true,
      message,
      data,
      meta: {
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    },
    options,
  );
}
