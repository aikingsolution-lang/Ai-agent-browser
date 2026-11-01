import type { Response } from 'express';

export interface ApiResponsePayload<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: {
    code?: string;
    /** Same as the top-level message: OpenAI-compatible clients (the extension's AI gateway client) read it here. */
    message?: string;
    details?: any;
  };
  timestamp: string;
}

export function sendSuccess<T>(res: Response, data: T, message?: string, statusCode = 200): Response {
  const payload: ApiResponsePayload<T> = {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(payload);
}

export function sendError(res: Response, message: string, statusCode = 500, code?: string, details?: any): Response {
  const payload: ApiResponsePayload = {
    success: false,
    message,
    error: {
      code,
      message,
      details,
    },
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(payload);
}
