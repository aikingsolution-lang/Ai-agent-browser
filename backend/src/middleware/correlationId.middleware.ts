import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const existingId = req.headers['x-request-id'] as string;
  const requestId = existingId || `req_${crypto.randomUUID()}`;

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  next();
}
