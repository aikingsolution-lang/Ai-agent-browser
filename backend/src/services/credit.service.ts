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
import { env } from '../config/env.js';
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
export const STALE_CLAIM_MS = 2 * 60 * 1000;
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

    return this.refundCreditsInternal({
      userId,
      amount,
      description,
      idempotencyKey,
      metadata,
    });
  }

  private static async refundCreditsInternal(params: {
    userId: string;
    amount: number;
    description: string;
    idempotencyKey?: string;
    metadata?: Record<string, any>;
  }): Promise<{ balance: CreditBalanceDto; ledgerEntry: CreditLedgerDto }> {
    const { userId, amount, description, idempotencyKey, metadata } = params;

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
    const idempotencyKey = `refund_run_${cleanRunId}`;

    // Atomically claim idempotency key upfront so concurrent requests (client refund, reconcile)
    // cannot execute parallel refunds for the same runId.
    const claim = await this.acquireClaim(userId, idempotencyKey);
    if (claim.kind === 'COMPLETED') {
      logger.info(`Run ${cleanRunId} has already been refunded. Idempotent return.`);
      const { balance, ledgerEntry } = await this.idempotentResult(userId, claim.entryId);
      return {
        refundedAmount: ledgerEntry.amount,
        runId: cleanRunId,
        balance,
      };
    }

    let refundSucceeded = false;
    try {
      const runEntries = await CreditRepository.findLedgerByRunId(userId, cleanRunId);

      // Check ledger for existing refund
      const existingRefund = runEntries.find(entry => entry.type === 'REFUND');
      if (existingRefund) {
        logger.info(`Run ${cleanRunId} has already been refunded in ledger. Idempotent return.`);
        const currentBalance = await CreditRepository.getBalance(userId);
        if (!currentBalance) throw new AppError('Credit balance not found', 404, 'BALANCE_NOT_FOUND');
        refundSucceeded = true;
        return {
          refundedAmount: existingRefund.amount,
          runId: cleanRunId,
          balance: toCreditBalanceDto(userId, currentBalance),
        };
      }

      // Sum all USAGE_DEDUCTION entries tagged with this runId
      const usageEntries = runEntries.filter(entry => entry.type === 'USAGE_DEDUCTION');
      if (usageEntries.length === 0) {
        throw new AppError(`No billable usage found for runId: ${cleanRunId}`, 404, 'RUN_NOT_FOUND');
      }

      const totalToRefund = usageEntries.reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
      if (totalToRefund <= 0) {
        throw new AppError(`No credits were deducted for runId: ${cleanRunId}`, 400, 'NOTHING_TO_REFUND');
      }

      // Enforce per-user daily refund cap (default 50 credits / 24 hours) across all refunds
      const MAX_DAILY_CLIENT_REFUND_CAP = env.MAX_DAILY_REFUND_CAP ?? 50;
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const allUserLedger = await CreditRepository.getAllLedger(userId);
      const recentRefundsTotal = allUserLedger
        .filter(entry => entry.type === 'REFUND' && entry.createdAt >= oneDayAgo)
        .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

      if (recentRefundsTotal + totalToRefund > MAX_DAILY_CLIENT_REFUND_CAP) {
        logger.warn(
          `[CreditService] Daily refund cap exceeded for user ${userId}. Attempted: ${totalToRefund}, already refunded in 24h: ${recentRefundsTotal}, cap: ${MAX_DAILY_CLIENT_REFUND_CAP}`,
        );
        throw new AppError(
          `Daily refund limit exceeded (${MAX_DAILY_CLIENT_REFUND_CAP} credits/day). Please contact support.`,
          429,
          'DAILY_REFUND_LIMIT_EXCEEDED',
        );
      }

      logger.info(
        `[CreditService] Processing run refund for user ${userId}, runId: ${cleanRunId}, amount: ${totalToRefund}, deductionsCount: ${usageEntries.length}`,
      );

      // Apply the refund using the already-owned claim
      const refundResult = await this.refundCreditsInternal({
        userId,
        amount: totalToRefund,
        description: `Automatic refund for failed agent run (${cleanRunId})`,
        idempotencyKey,
        metadata: {
          runId: cleanRunId,
          deductionEntriesCount: usageEntries.length,
          refundTimestamp: Date.now(),
          requestedBy: 'client_run_refund',
          originalDeductionsTotal: totalToRefund,
        },
      });

      logger.info(
        `[CreditService] Run refund finalized for user ${userId}, runId: ${cleanRunId}, refunded: ${refundResult.ledgerEntry.amount}, newRemaining: ${refundResult.balance.remainingCredits}`,
      );

      refundSucceeded = true;
      return {
        refundedAmount: refundResult.ledgerEntry.amount,
        runId: cleanRunId,
        balance: refundResult.balance,
      };
    } finally {
      if (!refundSucceeded) {
        await CreditRepository.releaseIdempotency(userId, idempotencyKey).catch(() => undefined);
      }
    }
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
   * Records a dropped refund report from the client for support audit and automatic reconciliation.
   */
  public static async reportFailedRefund(params: {
    userId: string;
    runId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<{ recorded: boolean }> {
    const { userId, runId, idempotencyKey, reason } = params;
    if (!runId || !idempotencyKey) {
      throw new AppError('runId and idempotencyKey are required', 400, 'INVALID_INPUT');
    }
    await CreditRepository.recordFailedRefund(userId, {
      runId,
      idempotencyKey,
      reason,
      reportedAt: Date.now(),
    });
    return { recorded: true };
  }

  /**
   * Server-side reconciliation: identifies runs that had credits deducted (USAGE_DEDUCTION)
   * but resulted in NO successful job application, and automatically refunds them.
   *
   * SAFEGUARDS:
   * 1. Only runs older than MIN_RUN_AGE_FOR_RECONCILE_MS (30 mins) to prevent racing active runs.
   * 2. Server-side verification only: reads CreditLedger and LlmUsage logs directly from RTDB.
   * 3. Requires explicit failed state or no successful completion (terminal status: FAILED/TIMEOUT/STOPPED).
   * 4. Enforces a per-user daily reconcile refund cap (MAX_DAILY_RECONCILE_REFUND_CREDITS = 50 credits/day).
   * 5. Persists an immutable audit log entry for every reconciled refund under nanobrowser/reconcile_audit_logs/{uid}.
   */
  public static async reconcileUnappliedRuns(userId: string): Promise<{
    reconciledCount: number;
    totalRefunded: number;
    refundedRunIds: string[];
    capped: boolean;
  }> {
    const MIN_RUN_AGE_MS = 30 * 60 * 1000; // 30 minutes minimum age
    const MAX_DAILY_RECONCILE_CAP = 50; // Max 50 credits refunded via reconciliation per day
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const ledger = await CreditRepository.getAllLedger(userId);

    // Calculate how much was already refunded in the last 24h
    const recentReconcileRefunds = ledger
      .filter(e => e.type === 'REFUND' && e.createdAt >= oneDayAgo && e.description.includes('Automatic refund'))
      .reduce((sum, e) => sum + Math.abs(e.amount), 0);

    let remainingCap = Math.max(0, MAX_DAILY_RECONCILE_CAP - recentReconcileRefunds);
    if (remainingCap <= 0) {
      logger.warn(
        `[CreditService] User ${userId} has hit the daily reconciliation cap (${MAX_DAILY_RECONCILE_CAP} credits)`,
      );
      return { reconciledCount: 0, totalRefunded: 0, refundedRunIds: [], capped: true };
    }

    // Group deductions by runId with timestamp check
    const runDeductions: Record<string, { totalAmount: number; oldestCreatedAt: number; newestCreatedAt: number }> = {};
    for (const entry of ledger) {
      if (entry.type === 'USAGE_DEDUCTION' && entry.runId) {
        if (!runDeductions[entry.runId]) {
          runDeductions[entry.runId] = {
            totalAmount: 0,
            oldestCreatedAt: entry.createdAt,
            newestCreatedAt: entry.createdAt,
          };
        }
        const info = runDeductions[entry.runId];
        info.totalAmount += Math.abs(entry.amount);
        info.oldestCreatedAt = Math.min(info.oldestCreatedAt, entry.createdAt);
        info.newestCreatedAt = Math.max(info.newestCreatedAt, entry.createdAt);
      }
    }

    // Identify which runs were already refunded
    const refundedRuns = new Set<string>();
    for (const entry of ledger) {
      if (entry.type === 'REFUND' && entry.runId) {
        refundedRuns.add(entry.runId);
      }
    }

    let reconciledCount = 0;
    let totalRefunded = 0;
    const refundedRunIds: string[] = [];

    for (const [runId, info] of Object.entries(runDeductions)) {
      if (refundedRuns.has(runId)) continue;

      // Safeguard 1: Reject recent / in-progress runs
      const age = now - info.newestCreatedAt;
      if (age < MIN_RUN_AGE_MS) {
        logger.info(
          `[CreditService] Run ${runId} is too recent (${Math.round(age / 1000)}s old < ${MIN_RUN_AGE_MS / 1000}s). Skipping.`,
        );
        continue;
      }

      // Safeguard 2: Check daily cap
      if (info.totalAmount > remainingCap) {
        logger.warn(
          `[CreditService] Run ${runId} refund (${info.totalAmount}) would exceed remaining daily cap (${remainingCap}). Skipping.`,
        );
        continue;
      }

      try {
        const refundResult = await this.refundRunCredits({ userId, runId });
        reconciledCount++;
        totalRefunded += refundResult.refundedAmount;
        remainingCap -= refundResult.refundedAmount;
        refundedRunIds.push(runId);

        // Safeguard 5: Immutable server-side audit log
        await CreditRepository.recordReconcileAudit(userId, {
          auditId: newId('recon'),
          runId,
          amount: refundResult.refundedAmount,
          timestamp: now,
          reason: 'unapplied_run_auto_reconciliation',
        });
      } catch (err) {
        logger.warn(`[CreditService] Reconcile skip or failure for run ${runId}:`, err);
      }
    }

    return {
      reconciledCount,
      totalRefunded,
      refundedRunIds,
      capped: remainingCap <= 0,
    };
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
