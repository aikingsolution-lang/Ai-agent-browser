import type { Request, Response, NextFunction } from 'express';
import type { AnyZodObject } from 'zod';
import { sendError } from '../utils/apiResponse.js';

export function validate(schema: AnyZodObject) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync(req.body);
      req.body = parsed;
      next();
    } catch (error: any) {
      if (error.name === 'ZodError') {
        const issues = error.errors.map((e: any) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        sendError(res, 'Validation error', 400, 'VALIDATION_ERROR', issues);
        return;
      }
      next(error);
    }
  };
}
