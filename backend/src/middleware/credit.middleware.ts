import { Request, Response, NextFunction } from 'express';
import { CreditService } from '../services/credit.service.js';
import { type IUserCreditBalance } from '../models/userCreditBalance.model.js';
import { AppError } from './errorHandler.js';
import { checkDatabaseHealth } from '../config/database.js';

declare global {
  namespace Express {
    interface Request {
      creditBalance?: IUserCreditBalance;
    }
  }
}

/**
 * Middleware to verify a user has sufficient credit balance before executing metered operations.
 * Defaults to requiring at least 1 credit.
 */
export function checkCredits(requiredCredits = 1) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required to access this resource', 401, 'UNAUTHORIZED');
      }

      // Fail-closed check if database is disconnected
      const dbHealth = checkDatabaseHealth();
      if (!dbHealth.isConnected) {
        throw new AppError('Service temporarily unavailable, cannot verify credits', 503, 'SERVICE_UNAVAILABLE');
      }

      const balance = await CreditService.getCreditBalance(userId);

      if (!balance || balance.remainingCredits < requiredCredits) {
        const available = balance ? balance.remainingCredits : 0;
        throw new AppError(
          `Insufficient credit balance. Required: ${requiredCredits}, Available: ${available}. Please upgrade your subscription.`,
          402,
          'INSUFFICIENT_CREDITS',
        );
      }

      req.creditBalance = balance;
      next();
    } catch (error) {
      next(error);
    }
  };
}
