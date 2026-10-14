import { Request, Response } from 'express';
import { sendSuccessResponse } from '../../utils/apiResponseHandler';
import { config } from '../../config/environment';

export const getHealth = (req: Request, res: Response) => {
  sendSuccessResponse(res, { service: config.SERVICE_NAME, status: 'ok' }, 'ok', undefined, {
    requestId: req.requestId,
  });
};
