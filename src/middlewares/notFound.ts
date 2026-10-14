import { Request, Response } from 'express';
import { sendErrorResponse } from '../utils/apiResponseHandler';

export function notFoundHandler(req: Request, res: Response): void {
  sendErrorResponse(
    res,
    404,
    { success: false, message: `Route not found: ${req.method} ${req.path}` },
    { requestId: req.requestId },
  );
}
