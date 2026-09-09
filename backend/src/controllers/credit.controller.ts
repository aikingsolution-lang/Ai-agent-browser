import { Request, Response, NextFunction } from 'express';
import { CreditService } from '../services/credit.service.js';
import { creditHistoryQuerySchema } from '../schemas/credit.schema.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { AppError } from '../middleware/errorHandler.js';

export class CreditController {
  /**
   * GET /api/v1/credits/balance
   * Returns current credit balance for authenticated user.
   */
  public static async getBalance(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const balance = await CreditService.getCreditBalance(userId);

      if (!balance) {
        sendSuccess(
          res,
          {
            allocatedCredits: 0,
            usedCredits: 0,
            remainingCredits: 0,
            periodStart: null,
            periodEnd: null,
            isLowBalance: true,
          },
          'User credit balance retrieved',
        );
        return;
      }

      const isLowBalance = balance.remainingCredits <= Math.ceil(balance.allocatedCredits * 0.1);

      sendSuccess(
        res,
        {
          allocatedCredits: balance.allocatedCredits,
          usedCredits: balance.usedCredits,
          remainingCredits: balance.remainingCredits,
          periodStart: balance.periodStart,
          periodEnd: balance.periodEnd,
          isLowBalance,
        },
        'User credit balance retrieved',
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/credits/history
   * Returns paginated credit audit ledger for authenticated user.
   */
  public static async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const { page, limit } = creditHistoryQuerySchema.parse(req.query);
      const result = await CreditService.getCreditHistory(userId, page, limit);

      sendSuccess(
        res,
        {
          items: result.items,
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
            totalPages: Math.ceil(result.total / result.limit),
          },
        },
        'Credit history retrieved',
      );
    } catch (error) {
      next(error);
    }
  }
}
