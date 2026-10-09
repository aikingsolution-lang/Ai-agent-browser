/**
 * credit.service.ts
 *
 * Credit balances and the credit ledger, backed by Firebase RTDB (previously the Mongo
 * UserCreditBalance and CreditLedger collections). Public methods and result shapes are the same
 * as the Mongo version.
 *
 *   nanobrowser/credit_balances/{uid}                 current balance
 *   nanobrowser/credit_ledger/{uid}/{entryId}         append-only audit trail
 *   nanobrowser/credit_ledger_meta/{uid}/count        ledger size (for paginated totals)
 *   nanobrowser/credit_idempotency/{uid}/{keyHash}    idempotency claims
 *
 * Mongo guarantees and their RTDB equivalents:
 *   - `remainingCredits >= amount` guard + `$inc`  → transaction on the balance node.
 *   - unique CreditLedger.idempotencyKey + compensating rollback → a claim node taken in a
 *     transaction BEFORE the balance changes (JobForm Automator's processed_payments pattern), so a
 *     key can only ever deduct once. Claims are scoped per user (the Mongo index was global, which
 *     let one user's key collide with another user's).
 *   - balance upsert + ledger insert → one atomic multi-location update.
 */

import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { newId, sleep, toMs } from './rtdb/rtdbUtils.js';
import { applyUpdates, CreditRepository, type UpdateMap } from './rtdb/repositories.js';
import { paths } from './rtdb/client.js';
import {
  toCreditBalanceDto,
  toCreditLedgerDto,
  type CreditBalanceDto,
  type CreditLedgerDto,
} from './rtdb/serializers.js';
import type { CreditBalanceRecord, CreditLedgerRecord, CreditTransactionType } from './rtdb/records.js';

export interface InitializeCreditsParams {
  userId: string;
  subscriptionId: string;
  allocatedCredits: number;
  periodStart: Date | number;
  periodEnd: Date | number;
  description?: string;
  type?: CreditTransactionType;
}

export interface DeductCreditsParams {
  userId: string;
  amount: number;
  description: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
}

export interface DeductCreditsResult {
  balance: CreditBalanceDto;
  ledgerEntry: CreditLedgerDto;
  isIdempotentRetry: boolean;
}

/** A PENDING claim older than this belongs to a request that died mid-way and may be taken over. */
const STALE_CLAIM_MS = 2 * 60 * 1000;
/** How long a concurrent duplicate waits for the in-flight request with the same key (~3s total). */
const CLAIM_WAIT_STEPS_MS = [50, 100, 200, 300, 500, 700, 1000];

type ClaimState = { kind: 'OWNED' } | { kind: 'COMPLETED'; entryId: string };

function runIdOf(metadata?: Record<string, any>): string | undefined {
  const runId = metadata?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
}

export class CreditService {
  /**
   * Builds the atomic update that resets a user's balance for a subscription period and records
   * the allocation in the ledger. Callers can merge it with other writes (e.g. the subscription
   * itself) so both land together.
   */
  public static async buildAllocationUpdates(
    params: InitializeCreditsParams,
  ): Promise<{ updates: UpdateMap; balance: CreditBalanceRecord; entry: CreditLedgerRecord }> {
    const {
      userId,
      subscriptionId,
      allocatedCredits,
      periodStart,
      periodEnd,
      description = 'Initial subscription credit allocation',
      type = 'TRIAL_ALLOCATION',
    } = params;

    if (!Number.isInteger(allocatedCredits) || allocatedCredits < 0) {
      throw new AppError('Allocated credits must be a non-negative integer', 400, 'INVALID_AMOUNT');
    }

    const now = Date.now();
    const existing = await CreditRepository.getBalance(userId);
    const balance: CreditBalanceRecord = {
      subscriptionId,
      allocatedCredits,
      usedCredits: 0,
      remainingCredits: allocatedCredits,
      periodStart: toMs(periodStart) ?? now,
      periodEnd: toMs(periodEnd) ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const entry: CreditLedgerRecord = {
      entryId: newId('cl'),
      uid: userId,
      subscriptionId,
      amount: allocatedCredits,
      balanceBefore: existing ? existing.remainingCredits : 0,
      balanceAfter: allocatedCredits,
      type,
      description,
      createdAt: now,
    };

    return {
      updates: { [paths.creditBalance(userId)]: balance, ...CreditRepository.ledgerAppendUpdates(userId, entry) },
      balance,
      entry,
    };
  }

  /**
   * Initializes or resets credits for a user subscription.
   * Atomically writes the balance and an allocation entry in the ledger.
   */
  public static async initializeCreditsForSubscription(params: InitializeCreditsParams): Promise<CreditBalanceDto> {
    const { updates, balance } = await this.buildAllocationUpdates(params);
    await applyUpdates(updates);
    logger.info(
      `Initialized ${params.allocatedCredits} credits (${params.type ?? 'TRIAL_ALLOCATION'}) for user ${params.userId} on subscription ${params.subscriptionId}`,
    );
    return toCreditBalanceDto(params.userId, balance);
  }

  /** Takes the idempotency claim for `key`, waiting briefly for a concurrent request using the same key. */
  private static async acquireClaim(uid: string, key: string): Promise<ClaimState> {
    for (let attempt = 0; attempt <= CLAIM_WAIT_STEPS_MS.length; attempt++) {
      const now = Date.now();
      const { claimed, existing } = await CreditRepository.claimIdempotency(uid, key, now);
      if (claimed) return { kind: 'OWNED' };

      if (existing?.status === 'COMPLETED' && existing.entryId) {
        return { kind: 'COMPLETED', entryId: existing.entryId };
      }
      if (existing?.status === 'PENDING' && existing.createdAt < now - STALE_CLAIM_MS) {
        if (await CreditRepository.reclaimStaleIdempotency(uid, key, now - STALE_CLAIM_MS, now)) {
          logger.warn(`Reclaimed stale idempotency claim '${key}' for user ${uid}`);
          return { kind: 'OWNED' };
        }
      }
      if (attempt < CLAIM_WAIT_STEPS_MS.length) await sleep(CLAIM_WAIT_STEPS_MS[attempt]);
    }
    throw new AppError(
      'A request with this idempotency key is still being processed. Retry shortly.',
      409,
      'IDEMPOTENCY_KEY_IN_PROGRESS',
    );
  }

  private static async idempotentResult(uid: string, entryId: string): Promise<DeductCreditsResult> {
    const [entry, balance] = await Promise.all([
      CreditRepository.getLedgerEntry(uid, entryId),
      CreditRepository.getBalance(uid),
    ]);
    if (!entry || !balance) {
      throw new AppError('Idempotent result is no longer available', 409, 'IDEMPOTENCY_RESULT_MISSING');
    }
    return {
      balance: toCreditBalanceDto(uid, balance),
      ledgerEntry: toCreditLedgerDto(entry),
      isIdempotentRetry: true,
    };
  }

  /**
   * Atomically deducts credits from a user's balance.
   * Never lets the balance go negative; a given idempotencyKey deducts at most once.
   */
  public static async deductCredits(params: DeductCreditsParams): Promise<DeductCreditsResult> {
    const { userId, amount, description, idempotencyKey, metadata } = params;

    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new AppError('Deduction amount must be a positive integer', 400, 'INVALID_AMOUNT');
    }

    if (idempotencyKey) {
      const claim = await this.acquireClaim(userId, idempotencyKey);
      if (claim.kind === 'COMPLETED') {
        logger.info(`Idempotent retry detected for key '${idempotencyKey}', returning existing result`);
        return this.idempotentResult(userId, claim.entryId);
      }
    }

    let deducted = false;
    try {
      const now = Date.now();
      const result = await CreditRepository.deduct(userId, amount, now);

      if (result.outcome === 'NO_BALANCE' || !result.balance) {
        throw new AppError('No credit balance found for user. Please contact support.', 402, 'INSUFFICIENT_CREDITS');
      }
      if (result.outcome === 'INSUFFICIENT') {
        throw new AppError(
          `Insufficient credit balance. Required: ${amount}, Available: ${result.balance.remainingCredits}`,
          402,
          'INSUFFICIENT_CREDITS',
        );
      }
      deducted = true;

      const entry: CreditLedgerRecord = {
        entryId: newId('cl'),
        uid: userId,
        subscriptionId: result.balance.subscriptionId,
        amount: -amount,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        type: 'USAGE_DEDUCTION',
        description,
        idempotencyKey,
        runId: runIdOf(metadata),
        metadata: metadata || {},
        createdAt: now,
      };

      await applyUpdates({
        ...CreditRepository.ledgerAppendUpdates(userId, entry),
        ...(idempotencyKey
          ? CreditRepository.idempotencyCompleteUpdates(userId, idempotencyKey, entry.entryId, now)
          : {}),
      });

      return {
        balance: toCreditBalanceDto(userId, result.balance),
        ledgerEntry: toCreditLedgerDto(entry),
        isIdempotentRetry: false,
      };
    } catch (error) {
      if (deducted) {
        // The ledger write failed after the balance changed: put the credits back (compensating
        // step, as the Mongo version did) so balance and ledger never disagree.
        await CreditRepository.refund(userId, amount, Date.now()).catch(refundErr =>
          logger.error(`Compensating refund failed for user ${userId}: ${refundErr?.message}`),
        );
      }
      if (idempotencyKey) {
        await CreditRepository.releaseIdempotency(userId, idempotencyKey).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Atomically refunds credits back to a user's balance.
   */
  public static async refundCredits(params: {
    userId: string;
    amount: number;
    description: string;
    idempotencyKey?: string;
    metadata?: Record<string, any>;
  }): Promise<{ balance: CreditBalanceDto; ledgerEntry: CreditLedgerDto }> {
    const { userId, amount, description, idempotencyKey, metadata } = params;

    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new AppError('Refund amount must be a positive integer', 400, 'INVALID_AMOUNT');
    }

    if (idempotencyKey) {
      const claim = await this.acquireClaim(userId, idempotencyKey);
      if (claim.kind === 'COMPLETED') {
        const { balance, ledgerEntry } = await this.idempotentResult(userId, claim.entryId);
        return { balance, ledgerEntry };
      }
    }

    let refunded = false;
    try {
      const now = Date.now();
      const result = await CreditRepository.refund(userId, amount, now);
      if (result.outcome !== 'APPLIED' || !result.balance) {
        throw new AppError('Credit balance not found', 404, 'BALANCE_NOT_FOUND');
      }
      refunded = true;

      const entry: CreditLedgerRecord = {
        entryId: newId('cl'),
        uid: userId,
        subscriptionId: result.balance.subscriptionId,
        amount,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter,
        type: 'REFUND',
        description,
        idempotencyKey,
        runId: runIdOf(metadata),
        metadata: metadata || {},
        createdAt: now,
      };

      await applyUpdates({
        ...CreditRepository.ledgerAppendUpdates(userId, entry),
        ...(idempotencyKey
          ? CreditRepository.idempotencyCompleteUpdates(userId, idempotencyKey, entry.entryId, now)
          : {}),
      });

      return { balance: toCreditBalanceDto(userId, result.balance), ledgerEntry: toCreditLedgerDto(entry) };
    } catch (error) {
      if (refunded) {
        await CreditRepository.deduct(userId, amount, Date.now()).catch(err =>
          logger.error(`Compensating refund reversal failed for user ${userId}: ${err?.message}`),
        );
      }
      if (idempotencyKey) {
        await CreditRepository.releaseIdempotency(userId, idempotencyKey).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Securely and idempotently refunds credits incurred during a specific agent run.
   * Computes the exact amount deducted from the ledger for the given runId and userId.
   * Rejects duplicate refunds for the same runId.
   */
  public static async refundRunCredits(params: {
    userId: string;
    runId: string;
  }): Promise<{ refundedAmount: number; runId: string; balance: CreditBalanceDto }> {
    const { userId, runId } = params;

    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      throw new AppError('A valid runId is required for refund', 400, 'INVALID_RUN_ID');
    }

    const cleanRunId = runId.trim();
    const runEntries = await CreditRepository.findLedgerByRunId(userId, cleanRunId);

    // 1. Already refunded? Return the earlier result.
    const existingRefund = runEntries.find(entry => entry.type === 'REFUND');
    if (existingRefund) {
      logger.info(`Run ${cleanRunId} has already been refunded. Idempotent return.`);
      const currentBalance = await CreditRepository.getBalance(userId);
      if (!currentBalance) throw new AppError('Credit balance not found', 404, 'BALANCE_NOT_FOUND');
      return {
        refundedAmount: existingRefund.amount,
        runId: cleanRunId,
        balance: toCreditBalanceDto(userId, currentBalance),
      };
    }

    // 2. Sum all USAGE_DEDUCTION entries tagged with this runId
    const usageEntries = runEntries.filter(entry => entry.type === 'USAGE_DEDUCTION');
    if (usageEntries.length === 0) {
      throw new AppError(`No billable usage found for runId: ${cleanRunId}`, 404, 'RUN_NOT_FOUND');
    }

    const totalToRefund = usageEntries.reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
    if (totalToRefund <= 0) {
      throw new AppError(`No credits were deducted for runId: ${cleanRunId}`, 400, 'NOTHING_TO_REFUND');
    }

    // 3. Refund once per run: the idempotency claim makes concurrent refunds of the same run safe.
    const refundResult = await this.refundCredits({
      userId,
      amount: totalToRefund,
      description: `Automatic refund for failed agent run (${cleanRunId})`,
      idempotencyKey: `refund_run_${cleanRunId}`,
      metadata: {
        runId: cleanRunId,
        deductionEntriesCount: usageEntries.length,
      },
    });

    return {
      refundedAmount: refundResult.ledgerEntry.amount,
      runId: cleanRunId,
      balance: refundResult.balance,
    };
  }

  /**
   * Admin top-up (scripts/topup_credits.ts): sets allocated and remaining credits to `credits`
   * (usedCredits untouched, as the old Mongo script did) and records an ADMIN_ADJUSTMENT entry.
   */
  public static async adminSetBalance(userId: string, credits: number, reason: string): Promise<CreditBalanceDto> {
    if (!Number.isInteger(credits) || credits < 0) {
      throw new AppError('Credits must be a non-negative integer', 400, 'INVALID_AMOUNT');
    }
    const now = Date.now();
    let before = 0;
    const result = await CreditRepository.setBalanceForAdmin(userId, credits, now, previous => {
      before = previous;
    });
    const entry: CreditLedgerRecord = {
      entryId: newId('cl'),
      uid: userId,
      subscriptionId: result.subscriptionId,
      amount: credits - before,
      balanceBefore: before,
      balanceAfter: credits,
      type: 'ADMIN_ADJUSTMENT',
      description: reason,
      createdAt: now,
    };
    await applyUpdates(CreditRepository.ledgerAppendUpdates(userId, entry));
    return toCreditBalanceDto(userId, result);
  }

  /**
   * Retrieves current credit balance for a user.
   */
  public static async getCreditBalance(userId: string): Promise<CreditBalanceDto | null> {
    const balance = await CreditRepository.getBalance(userId);
    return balance ? toCreditBalanceDto(userId, balance) : null;
  }

  /**
   * Retrieves paginated credit history for a user sorted by newest first.
   */
  public static async getCreditHistory(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ items: CreditLedgerDto[]; total: number; page: number; limit: number }> {
    const { items, total } = await CreditRepository.listLedger(userId, page, limit);
    return { items: items.map(toCreditLedgerDto), total, page, limit };
  }
}
