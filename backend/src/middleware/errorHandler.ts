import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { sendError } from '../utils/apiResponse.js';
import { env } from '../config/env.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, code?: string, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(err: Error | AppError, _req: Request, res: Response, _next: NextFunction): void {
  // Handle Mongo duplicate key error (E11000)
  if ((err as any).code === 11000 || err.message?.includes('E11000')) {
    sendError(res, 'Email address is already registered', 409, 'EMAIL_EXISTS');
    return;
  }

  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const code = err instanceof AppError ? err.code : 'INTERNAL_SERVER_ERROR';

  logger.error(`Error [${code}] ${err.message}`, {
    stack: err.stack,
    statusCode,
  });

  // Never leak internal stack traces or raw errors in production
  const message =
    env.NODE_ENV === 'production' && statusCode === 500
      ? 'An unexpected server error occurred. Please try again later.'
      : err.message;

  sendError(res, message, statusCode, code);
}
