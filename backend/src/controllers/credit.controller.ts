import crypto from 'node:crypto';
import { hasVerifiedJobformPremium } from '../middleware/entitlement.middleware.js';
import type { Request, Response, NextFunction } from 'express';
import { CreditService } from '../services/credit.service.js';
import { creditHistoryQuerySchema } from '../schemas/credit.schema.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { AppError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const ALLOWED_FAILED_REFUND_REASONS = [
  'max_attempts_exceeded',
  'max_age_exceeded',
  'client_dropped',
  'network_failure',
] as const;

export type FailedRefundReason = (typeof ALLOWED_FAILED_REFUND_REASONS)[number];

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
      // Verified JobForm Automator Premium covers AI use; the balance is kept for accounting only.
      const premiumCovered = await hasVerifiedJobformPremium(userId);

      if (!balance) {
        sendSuccess(
          res,
          {
            allocatedCredits: 0,
            usedCredits: 0,
            remainingCredits: 0,
            periodStart: null,
            periodEnd: null,
            isLowBalance: !premiumCovered,
            premiumCovered,
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
          isLowBalance: isLowBalance && !premiumCovered,
          premiumCovered,
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

  /**
   * POST /api/v1/credits/refund
   * Refunds credits back to user for a specific agent run.
   * Server calculates the refund amount from the CreditLedger for the given runId.
   */
  public static async refundCredits(req: Request, res: Response, next: NextFunction): Promise<void> {
    const requestId =
      (req.headers['x-request-id'] as string) || (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
    const userId = req.user?._id?.toString() || req.user?.uid;
    const rawRunId = req.body?.runId;
    const runId = typeof rawRunId === 'string' ? rawRunId.trim() : undefined;

    try {
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      if (!runId || typeof rawRunId !== 'string' || runId === '') {
        throw new AppError('runId is required for refund', 400, 'INVALID_RUN_ID');
      }

      const result = await CreditService.refundRunCredits({
        userId,
        runId,
      });

      logger.info('[CreditController.refundCredits] Refund processed', {
        requestId,
        userId,
        runId,
        outcome: 'SUCCESS',
        refundedAmount: result.refundedAmount,
        remainingCredits: result.balance.remainingCredits,
      });

      sendSuccess(
        res,
        {
          remainingCredits: result.balance.remainingCredits,
          usedCredits: result.balance.usedCredits,
          allocatedCredits: result.balance.allocatedCredits,
          refundedAmount: result.refundedAmount,
          runId: result.runId,
        },
        'Credits refunded successfully',
      );
    } catch (error: any) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      const errorCode = error instanceof AppError ? error.code : 'INTERNAL_SERVER_ERROR';

      logger.error('[CreditController.refundCredits] Refund failed', {
        requestId,
        userId: userId || 'anonymous',
        runId: runId || (typeof rawRunId === 'string' ? rawRunId : 'invalid'),
        outcome: 'FAILED',
        statusCode,
        errorCode,
        errorMessage: error?.message || 'Unknown error',
        stack: statusCode === 500 ? error?.stack : undefined,
      });

      next(error);
    }
  }

  /**
   * POST /api/v1/credits/refund/report-failed
   * Reports dropped client refund attempts for support inspection and auditing.
   */
  public static async reportFailedRefund(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const { runId, idempotencyKey, reason } = req.body;
      if (!runId || !idempotencyKey || typeof runId !== 'string' || typeof idempotencyKey !== 'string') {
        throw new AppError('runId and idempotencyKey are required', 400, 'INVALID_INPUT');
      }

      const rawReason = String(reason || '')
        .trim()
        .toLowerCase();
      if (!ALLOWED_FAILED_REFUND_REASONS.includes(rawReason as FailedRefundReason)) {
        throw new AppError(
          `Invalid refund failure reason. Must be one of: ${ALLOWED_FAILED_REFUND_REASONS.join(', ')}`,
          400,
          'INVALID_REASON',
        );
      }

      const result = await CreditService.reportFailedRefund({
        userId,
        runId: runId.trim(),
        idempotencyKey: idempotencyKey.trim(),
        reason: rawReason,
      });

      sendSuccess(res, result, 'Failed refund reported successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/credits/reconcile
   * Scans unapplied runs that were charged and automatically refunds them.
   * Gated behind ENABLE_CREDITS_RECONCILE feature flag (default false).
   */
  public static async reconcileUnapplied(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!env.ENABLE_CREDITS_RECONCILE) {
        throw new AppError('Credits reconciliation feature is currently disabled', 403, 'FEATURE_DISABLED');
      }

      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const result = await CreditService.reconcileUnappliedRuns(userId);
      sendSuccess(res, result, 'Reconciliation completed');
    } catch (error) {
      next(error);
    }
  }
}
