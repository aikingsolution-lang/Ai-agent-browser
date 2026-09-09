import mongoose from 'mongoose';
import { UserCreditBalance, type IUserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger, type ICreditLedger, type CreditTransactionType } from '../models/creditLedger.model.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

export interface InitializeCreditsParams {
  userId: string | mongoose.Types.ObjectId;
  subscriptionId: string | mongoose.Types.ObjectId;
  allocatedCredits: number;
  periodStart: Date;
  periodEnd: Date;
  description?: string;
  type?: CreditTransactionType;
  session?: mongoose.ClientSession;
}

export interface DeductCreditsParams {
  userId: string | mongoose.Types.ObjectId;
  amount: number;
  description: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
}

export interface DeductCreditsResult {
  balance: IUserCreditBalance;
  ledgerEntry: ICreditLedger;
  isIdempotentRetry: boolean;
}

export class CreditService {
  /**
   * Initializes or resets credits for a user subscription.
   * Atomically upserts UserCreditBalance and writes an initial CreditLedger entry.
   */
  public static async initializeCreditsForSubscription(params: InitializeCreditsParams): Promise<IUserCreditBalance> {
    const {
      userId,
      subscriptionId,
      allocatedCredits,
      periodStart,
      periodEnd,
      description = 'Initial subscription credit allocation',
      type = 'TRIAL_ALLOCATION',
      session,
    } = params;

    const queryOptions: mongoose.QueryOptions = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    };
    if (session) {
      queryOptions.session = session;
    }

    // 0. Fetch existing balance for balanceBefore calculation
    const existingBalance = await UserCreditBalance.findOne({ userId }).session(session || null);
    const balanceBefore = existingBalance ? existingBalance.remainingCredits : 0;

    // 1. Upsert real-time user credit balance
    const balance = await UserCreditBalance.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          subscriptionId,
          allocatedCredits,
          usedCredits: 0,
          remainingCredits: allocatedCredits,
          periodStart,
          periodEnd,
        },
      },
      queryOptions,
    );

    if (!balance) {
      throw new AppError('Failed to initialize user credit balance', 500, 'INTERNAL_SERVER_ERROR');
    }

    // 2. Write immutable transaction audit entry into CreditLedger
    await CreditLedger.create(
      [
        {
          userId,
          subscriptionId,
          amount: allocatedCredits,
          balanceBefore,
          balanceAfter: allocatedCredits,
          type,
          description,
        },
      ],
      session ? { session } : {},
    );

    logger.info(
      `Initialized ${allocatedCredits} credits (${type}) for user ${userId} on subscription ${subscriptionId}`,
    );

    return balance;
  }

  /**
   * Atomically deducts credits from a user's balance.
   * Enforces remainingCredits >= amount at database execution level to prevent negative balances.
   * Enforces strict idempotency via idempotencyKey with atomic compensating rollback under concurrency.
   */
  public static async deductCredits(
    params: DeductCreditsParams,
    session?: mongoose.ClientSession,
  ): Promise<DeductCreditsResult> {
    const { userId, amount, description, idempotencyKey, metadata } = params;

    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new AppError('Deduction amount must be a positive integer', 400, 'INVALID_AMOUNT');
    }

    // 1. Idempotency Pre-Check
    if (idempotencyKey) {
      const existingLedger = await CreditLedger.findOne({ idempotencyKey }).session(session || null);
      if (existingLedger) {
        const currentBalance = await UserCreditBalance.findOne({ userId }).session(session || null);
        logger.info(`Idempotent retry detected for key '${idempotencyKey}', returning existing result`);
        return {
          balance: currentBalance!,
          ledgerEntry: existingLedger,
          isIdempotentRetry: true,
        };
      }
    }

    // 2. Atomic Credit Deduction (remainingCredits >= amount guard condition)
    const updateOptions: mongoose.QueryOptions = { new: true };
    if (session) {
      updateOptions.session = session;
    }

    const updatedBalance = await UserCreditBalance.findOneAndUpdate(
      {
        userId,
        remainingCredits: { $gte: amount },
      },
      {
        $inc: {
          usedCredits: amount,
          remainingCredits: -amount,
        },
      },
      updateOptions,
    );

    if (!updatedBalance) {
      const existingBalance = await UserCreditBalance.findOne({ userId }).session(session || null);
      if (!existingBalance) {
        throw new AppError('No credit balance found for user. Please contact support.', 402, 'INSUFFICIENT_CREDITS');
      }
      throw new AppError(
        `Insufficient credit balance. Required: ${amount}, Available: ${existingBalance.remainingCredits}`,
        402,
        'INSUFFICIENT_CREDITS',
      );
    }

    const balanceBefore = updatedBalance.remainingCredits + amount;

    // 3. Log transaction entry in CreditLedger
    try {
      const ledgerDocs = await CreditLedger.create(
        [
          {
            userId,
            subscriptionId: updatedBalance.subscriptionId,
            amount: -amount,
            balanceBefore,
            balanceAfter: updatedBalance.remainingCredits,
            type: 'USAGE_DEDUCTION',
            description,
            idempotencyKey,
            metadata: metadata || {},
          },
        ],
        session ? { session } : {},
      );

      return {
        balance: updatedBalance,
        ledgerEntry: ledgerDocs[0],
        isIdempotentRetry: false,
      };
    } catch (error: any) {
      if (error.code === 11000 || error.message?.includes('E11000')) {
        // Race condition: another concurrent request with same idempotencyKey created ledger entry first.
        // Compensating step: Revert the credit deduction on UserCreditBalance
        const restoredBalance = await UserCreditBalance.findOneAndUpdate(
          { userId },
          {
            $inc: {
              usedCredits: -amount,
              remainingCredits: amount,
            },
          },
          updateOptions,
        );

        // Fetch the winning ledger entry for this idempotency key
        const winningLedger = await CreditLedger.findOne({ idempotencyKey }).session(session || null);

        logger.info(`Concurrent idempotency race caught and compensated for key '${idempotencyKey}' (user ${userId})`);

        return {
          balance: restoredBalance!,
          ledgerEntry: winningLedger!,
          isIdempotentRetry: true,
        };
      }
      throw error;
    }
  }

  /**
   * Retrieves current credit balance for a user.
   */
  public static async getCreditBalance(userId: string | mongoose.Types.ObjectId): Promise<IUserCreditBalance | null> {
    return UserCreditBalance.findOne({ userId });
  }

  /**
   * Retrieves paginated credit history for a user sorted by newest first.
   */
  public static async getCreditHistory(
    userId: string | mongoose.Types.ObjectId,
    page = 1,
    limit = 20,
  ): Promise<{ items: ICreditLedger[]; total: number; page: number; limit: number }> {
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      CreditLedger.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      CreditLedger.countDocuments({ userId }),
    ]);

    return {
      items,
      total,
      page,
      limit,
    };
  }
}
