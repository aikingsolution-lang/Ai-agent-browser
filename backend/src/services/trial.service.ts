import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { Plan } from '../models/plan.model.js';
import { Subscription, type ISubscription } from '../models/subscription.model.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { PlanSeedService } from './planSeed.service.js';
import { CreditService } from './credit.service.js';

export interface TrialRemainingInfo {
  isExpired: boolean;
  remainingMs: number;
  remainingHours: number;
  remainingDays: number;
}

export class TrialService {
  /**
   * Creates a 5-day free trial subscription for a user and allocates initial trial credits.
   * Enforces single free trial per user via permanent user flag & partial unique index.
   */
  public static async createFreeTrial(
    userId: string | mongoose.Types.ObjectId,
    session?: mongoose.ClientSession,
  ): Promise<ISubscription> {
    // Check if user has already used a free trial permanently
    const user = await User.findById(userId).session(session || null);
    if (!user) {
      throw new AppError('User not found', 444, 'USER_NOT_FOUND');
    }

    if (user.hasUsedTrial) {
      throw new AppError(
        'User is not eligible for a free trial or already has an active subscription',
        409,
        'TRIAL_ALREADY_EXISTS',
      );
    }

    let plan = await Plan.findOne({ code: 'free-trial' });

    if (!plan) {
      plan = await PlanSeedService.seedDefaultPlans();
    }

    if (!plan) {
      throw new AppError('Failed to initialize default free-trial plan', 500, 'INTERNAL_SERVER_ERROR');
    }

    const now = new Date();
    const trialEndDate = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000); // 5 days exact

    try {
      const subscriptionDocs = await Subscription.create(
        [
          {
            userId,
            planId: plan._id,
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
            currentPeriodStart: now,
            currentPeriodEnd: trialEndDate,
            trialStartDate: now,
            trialEndDate,
            cancelAtPeriodEnd: false,
          },
        ],
        session ? { session } : {},
      );

      const subscription = subscriptionDocs[0];

      // Mark user as having permanently consumed their trial allocation
      await User.findByIdAndUpdate(
        userId,
        { $set: { hasUsedTrial: true, trialUsedAt: now } },
        session ? { session } : {},
      );

      // Initialize credits from subscription plan snapshot
      await CreditService.initializeCreditsForSubscription({
        userId,
        subscriptionId: subscription._id,
        allocatedCredits: subscription.creditsSnapshot,
        periodStart: now,
        periodEnd: trialEndDate,
        description: `Initial ${subscription.planNameSnapshot} credit allocation`,
        type: 'TRIAL_ALLOCATION',
        session,
      });

      logger.info(
        `Created 5-day free trial subscription ${subscription._id} and allocated ${subscription.creditsSnapshot} credits for user ${userId}`,
      );
      return subscription;
    } catch (error: any) {
      if (error.code === 11000 || error.message?.includes('E11000')) {
        throw new AppError(
          'User is not eligible for a free trial or already has an active subscription',
          409,
          'TRIAL_ALREADY_EXISTS',
        );
      }
      throw error;
    }
  }

  /**
   * On-demand real-time check to expire subscriptions whose duration/grace period has ended.
   * Atomically transitions status to 'EXPIRED' for:
   * 1. TRIALING subscriptions where trialEndDate <= now (and trialEndDate is not null)
   * 2. PAST_DUE subscriptions where pastDueStartedAt <= now - 72 hours
   * 3. ACTIVE subscriptions with cancelAtPeriodEnd=true where currentPeriodEnd <= now
   */
  public static async expireTrialIfEnded(userId: string | mongoose.Types.ObjectId): Promise<ISubscription | null> {
    const now = new Date();
    const pastDueCutoff = new Date(now.getTime() - 72 * 3600 * 1000); // 72 hours exact

    const expiredSub = await Subscription.findOneAndUpdate(
      {
        userId,
        status: { $ne: 'EXPIRED' },
        $or: [
          { status: 'TRIALING', trialEndDate: { $exists: true, $ne: null, $lte: now } },
          { status: 'PAST_DUE', pastDueStartedAt: { $exists: true, $ne: null, $lte: pastDueCutoff } },
          { status: 'ACTIVE', cancelAtPeriodEnd: true, currentPeriodEnd: { $exists: true, $ne: null, $lte: now } },
        ],
      },
      {
        $set: { status: 'EXPIRED', endedAt: now },
      },
      { new: true },
    );

    if (expiredSub) {
      logger.info(
        `On-demand subscription expiration executed for user ${userId} (Sub: ${expiredSub._id}, Previous Status: ${expiredSub.status})`,
      );
    }

    return expiredSub;
  }

  /**
   * Alias for expireTrialIfEnded for general subscription lifecycle checks.
   */
  public static async expireSubscriptionIfEnded(
    userId: string | mongoose.Types.ObjectId,
  ): Promise<ISubscription | null> {
    return this.expireTrialIfEnded(userId);
  }

  /**
   * Bulk reconciliation method for server startup and periodic cron worker.
   * Atomically expires past-due trials, expired PAST_DUE subscriptions (>72h),
   * and ended cancelled ACTIVE subscriptions.
   */
  public static async reconcileExpiredTrials(): Promise<number> {
    const now = new Date();
    const pastDueCutoff = new Date(now.getTime() - 72 * 3600 * 1000);

    const [res1, res2, res3] = await Promise.all([
      Subscription.updateMany(
        { status: 'TRIALING', trialEndDate: { $exists: true, $ne: null, $lte: now } },
        { $set: { status: 'EXPIRED', endedAt: now } },
      ),
      Subscription.updateMany(
        { status: 'PAST_DUE', pastDueStartedAt: { $exists: true, $ne: null, $lte: pastDueCutoff } },
        { $set: { status: 'EXPIRED', endedAt: now } },
      ),
      Subscription.updateMany(
        { status: 'ACTIVE', cancelAtPeriodEnd: true, currentPeriodEnd: { $exists: true, $ne: null, $lte: now } },
        { $set: { status: 'EXPIRED', endedAt: now } },
      ),
    ]);

    const totalModified = res1.modifiedCount + res2.modifiedCount + res3.modifiedCount;

    if (totalModified > 0) {
      logger.info(
        `Reconciled ${totalModified} expired subscription(s) (Trials: ${res1.modifiedCount}, PastDue: ${res2.modifiedCount}, Cancelled: ${res3.modifiedCount})`,
      );
    }
    return totalModified;
  }

  /**
   * Helper to calculate remaining trial duration.
   */
  public static calculateTrialRemaining(trialEndDate: Date): TrialRemainingInfo {
    const now = new Date().getTime();
    const end = new Date(trialEndDate).getTime();
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
