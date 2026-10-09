/**
 * trial.service.ts
 *
 * Free trial and subscription expiry, backed by Firebase RTDB (previously Mongo User +
 * Subscription). Public methods match the Mongo version; subscriptions are returned in the same
 * JSON shape (see serializers.ts).
 *
 *   nanobrowser/trial_flags/{uid}     one-time "trial used" flag (was User.hasUsedTrial / trialUsedAt)
 *   nanobrowser/subscriptions/{uid}   current subscription (one node per user replaces the Mongo
 *                                     partial unique index on active subscriptions)
 */

import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { paths } from './rtdb/client.js';
import { applyUpdates, CreditRepository, SubscriptionRepository, type UpdateMap } from './rtdb/repositories.js';
import { newId, toMs } from './rtdb/rtdbUtils.js';
import { toSubscriptionDto, type SubscriptionDto } from './rtdb/serializers.js';
import { ENTITLED_STATUSES, type PlanRecord, type SubscriptionRecord } from './rtdb/records.js';
import { CreditService } from './credit.service.js';
import { PlanService } from './planSeed.service.js';

export interface TrialRemainingInfo {
  isExpired: boolean;
  remainingMs: number;
  remainingHours: number;
  remainingDays: number;
}

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const PAST_DUE_GRACE_MS = 72 * 3600 * 1000;

/**
 * The three expiry rules of the Mongo version:
 *   1. TRIALING whose trialEndDate has passed
 *   2. PAST_DUE for more than 72 hours
 *   3. ACTIVE with cancelAtPeriodEnd whose currentPeriodEnd has passed
 */
export function shouldExpire(sub: SubscriptionRecord, now: number): boolean {
  if (sub.status === 'TRIALING') return typeof sub.trialEndDate === 'number' && sub.trialEndDate <= now;
  if (sub.status === 'PAST_DUE') {
    return typeof sub.pastDueStartedAt === 'number' && sub.pastDueStartedAt <= now - PAST_DUE_GRACE_MS;
  }
  if (sub.status === 'ACTIVE') {
    return Boolean(sub.cancelAtPeriodEnd) && typeof sub.currentPeriodEnd === 'number' && sub.currentPeriodEnd <= now;
  }
  return false;
}

/** Builds a trial subscription record from the free-trial plan. */
function trialSubscriptionRecord(uid: string, plan: PlanRecord, trialStart: number, trialEnd: number, now: number) {
  const record: SubscriptionRecord = {
    subscriptionId: newId('sub'),
    uid,
    planId: plan.legacyId || plan.code,
    planCodeSnapshot: plan.code,
    planNameSnapshot: plan.name,
    amountSnapshot: plan.amount,
    currencySnapshot: plan.currency,
    billingIntervalSnapshot: plan.billingInterval,
    creditsSnapshot: plan.creditsPerBillingPeriod,
    rateLimitSnapshot: plan.rateLimitPerMinute,
    provider: 'manual',
    status: 'TRIALING',
    isTrial: true,
    trialStartDate: trialStart,
    trialEndDate: trialEnd,
    currentPeriodStart: trialStart,
    currentPeriodEnd: trialEnd,
    cancelAtPeriodEnd: false,
    createdAt: now,
    updatedAt: now,
  };
  return record;
}

export class TrialService {
  /** The user's current subscription record (any status), or null. */
  public static getCurrentSubscription(userId: string): Promise<SubscriptionRecord | null> {
    return SubscriptionRepository.getCurrent(userId);
  }

  /** The user's current subscription in API shape (any status), or null. */
  public static async getCurrentSubscriptionDto(userId: string): Promise<SubscriptionDto | null> {
    const subscription = await SubscriptionRepository.getCurrent(userId);
    return subscription ? toSubscriptionDto(subscription) : null;
  }

  /** Whether the user has ever consumed their one free trial. */
  public static async hasUsedTrial(userId: string): Promise<boolean> {
    const flag = await SubscriptionRepository.getTrialFlag(userId);
    return Boolean(flag?.hasUsedTrial);
  }

  /**
   * Creates a 5-day free trial subscription for a user and allocates initial trial credits.
   * Enforces a single free trial per user via the permanent trial flag.
   */
  public static async createFreeTrial(userId: string): Promise<SubscriptionDto> {
    const current = await SubscriptionRepository.getCurrent(userId);
    if (current && ENTITLED_STATUSES.includes(current.status)) {
      throw new AppError(
        'User is not eligible for a free trial or already has an active subscription',
        409,
        'TRIAL_ALREADY_EXISTS',
      );
    }

    const plan = await PlanService.getFreeTrialPlan();
    if (!plan) {
      throw new AppError('Failed to initialize default free-trial plan', 500, 'INTERNAL_SERVER_ERROR');
    }

    const now = Date.now();
    const claimed = await SubscriptionRepository.claimTrialFlag(userId, now);
    if (!claimed) {
      throw new AppError(
        'User is not eligible for a free trial or already has an active subscription',
        409,
        'TRIAL_ALREADY_EXISTS',
      );
    }

    try {
      const trialEndDate = now + FIVE_DAYS_MS; // 5 days exact
      const subscription = trialSubscriptionRecord(userId, plan, now, trialEndDate, now);
      const allocation = await CreditService.buildAllocationUpdates({
        userId,
        subscriptionId: subscription.subscriptionId,
        allocatedCredits: subscription.creditsSnapshot,
        periodStart: now,
        periodEnd: trialEndDate,
        description: `Initial ${subscription.planNameSnapshot} credit allocation`,
        type: 'TRIAL_ALLOCATION',
      });

      // Subscription + balance + ledger entry land together, in one atomic update.
      const updates: UpdateMap = { [paths.subscription(userId)]: subscription, ...allocation.updates };
      if (current) {
        // Keep the previous (expired/cancelled) subscription instead of overwriting it.
        updates[paths.subscriptionHistoryEntry(userId, current.subscriptionId)] = current;
      }
      await applyUpdates(updates);

      logger.info(
        `Created 5-day free trial subscription ${subscription.subscriptionId} and allocated ${subscription.creditsSnapshot} credits for user ${userId}`,
      );
      return toSubscriptionDto(subscription);
    } catch (error) {
      // Nothing was written, so give the trial back.
      await SubscriptionRepository.releaseTrialFlag(userId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * On-demand real-time check that expires the user's subscription when its duration or grace
   * period has ended (see shouldExpire). Returns the expired subscription, or null.
   */
  public static async expireTrialIfEnded(userId: string): Promise<SubscriptionDto | null> {
    const now = Date.now();
    const current = await SubscriptionRepository.getCurrent(userId);
    if (!current || !shouldExpire(current, now)) return null;

    const { changed, subscription } = await SubscriptionRepository.transactCurrent(userId, sub =>
      shouldExpire(sub, now) ? { ...sub, status: 'EXPIRED', endedAt: now, updatedAt: now } : null,
    );

    if (changed && subscription) {
      logger.info(
        `On-demand subscription expiration executed for user ${userId} (Sub: ${subscription.subscriptionId}, Previous Status: ${current.status})`,
      );
      return toSubscriptionDto(subscription);
    }
    return null;
  }

  /** Alias for expireTrialIfEnded for general subscription lifecycle checks. */
  public static async expireSubscriptionIfEnded(userId: string): Promise<SubscriptionDto | null> {
    return this.expireTrialIfEnded(userId);
  }

  /**
   * Auto-heals / restores the free trial subscription and credit allocation if a user is within
   * their 5-day trial window (time is the ultimate source of truth).
   */
  public static async healUserTrialSubscriptionIfEligible(userId: string): Promise<SubscriptionDto | null> {
    const flag = await SubscriptionRepository.getTrialFlag(userId);
    if (!flag?.hasUsedTrial) {
      return null;
    }

    const now = Date.now();
    const trialStartDate = flag.trialUsedAt;
    const trialEndDate = trialStartDate + FIVE_DAYS_MS;

    // If the 5-day window has already passed, nothing is eligible for healing
    if (now >= trialEndDate) {
      return null;
    }

    let subscription = await SubscriptionRepository.getCurrent(userId);

    if (subscription && subscription.isTrial) {
      const subStartDate = subscription.trialStartDate ?? trialStartDate;
      const expectedEndDate = subStartDate + FIVE_DAYS_MS;
      const wasCorrupt = !subscription.trialEndDate || subscription.trialEndDate <= subStartDate;

      if (wasCorrupt) {
        const healed = await SubscriptionRepository.transactCurrent(userId, sub => {
          if (!sub.isTrial || (sub.trialEndDate && sub.trialEndDate > subStartDate)) return null;
          const next: SubscriptionRecord = { ...sub, trialStartDate: subStartDate, trialEndDate: expectedEndDate };
          if (next.status === 'TRIALING') {
            next.currentPeriodStart = subStartDate;
            next.currentPeriodEnd = expectedEndDate;
          }
          // Restore TRIALING only when the dates were corrupt and the window is still open.
          if (now < expectedEndDate) {
            next.status = 'TRIALING';
            delete next.endedAt;
          }
          next.updatedAt = now;
          return next;
        });
        if (healed.changed) {
          logger.warn(
            `Fixed corrupted trial dates for user ${userId} (trialEndDate ${new Date(expectedEndDate).toISOString()})`,
          );
        }
        subscription = healed.subscription ?? subscription;
      }
    } else if (!subscription) {
      // Subscription record was lost. Restore the trial for the rest of its window.
      const plan = await PlanService.getFreeTrialPlan();
      if (plan) {
        const restored = trialSubscriptionRecord(userId, plan, trialStartDate, trialEndDate, now);
        if (await SubscriptionRepository.createCurrentIfMissing(userId, restored)) {
          logger.info(`Auto-restored missing trial subscription ${restored.subscriptionId} for user ${userId}`);
        }
        subscription = await SubscriptionRepository.getCurrent(userId);
      }
    }

    if (subscription) {
      // Ensure the user credit balance exists
      const balance = await CreditRepository.getBalance(userId);
      if (!balance) {
        await CreditService.initializeCreditsForSubscription({
          userId,
          subscriptionId: subscription.subscriptionId,
          allocatedCredits: subscription.creditsSnapshot,
          periodStart: trialStartDate,
          periodEnd: trialEndDate,
          description: `Auto-restored ${subscription.planNameSnapshot} credit allocation`,
          type: 'TRIAL_ALLOCATION',
        });
      }
    }

    return subscription ? toSubscriptionDto(subscription) : null;
  }

  /**
   * Bulk reconciliation for server startup and the periodic cron worker: expires ended trials,
   * PAST_DUE subscriptions older than 72h and ended cancelled ACTIVE subscriptions.
   * Each user is expired in its own transaction, so a concurrent renewal can't be overwritten.
   */
  public static async reconcileExpiredTrials(): Promise<number> {
    const now = Date.now();
    const counts = { TRIALING: 0, PAST_DUE: 0, ACTIVE: 0 };

    for (const status of ['TRIALING', 'PAST_DUE', 'ACTIVE'] as const) {
      const candidates = (await SubscriptionRepository.listByStatus(status)).filter(sub => shouldExpire(sub, now));
      for (const candidate of candidates) {
        const { changed } = await SubscriptionRepository.transactCurrent(candidate.uid, sub =>
          shouldExpire(sub, now) ? { ...sub, status: 'EXPIRED', endedAt: now, updatedAt: now } : null,
        );
        if (changed) counts[status]++;
      }
    }

    const totalModified = counts.TRIALING + counts.PAST_DUE + counts.ACTIVE;
    if (totalModified > 0) {
      logger.info(
        `Reconciled ${totalModified} expired subscription(s) (Trials: ${counts.TRIALING}, PastDue: ${counts.PAST_DUE}, Cancelled: ${counts.ACTIVE})`,
      );
    }
    return totalModified;
  }

  /**
   * Helper to calculate remaining trial duration.
   */
  public static calculateTrialRemaining(trialEndDate: Date | string | number): TrialRemainingInfo {
    const now = Date.now();
    const end = toMs(trialEndDate) ?? 0;
    const diff = end - now;

    if (diff <= 0) {
      return { isExpired: true, remainingMs: 0, remainingHours: 0, remainingDays: 0 };
    }

    return {
      isExpired: false,
      remainingMs: diff,
      remainingHours: Math.ceil(diff / (1000 * 60 * 60)),
      remainingDays: Number((diff / (1000 * 60 * 60 * 24)).toFixed(1)),
    };
  }
}
