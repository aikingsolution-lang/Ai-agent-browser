import type { Request, Response, NextFunction } from 'express';
import { TrialService } from '../services/trial.service.js';
import { PlanService } from '../services/planSeed.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { JobformPremiumService, type JobformPremiumStatus } from '../services/jobformPremium.service.js';
import { logger } from '../utils/logger.js';

/**
 * JobForm Automator premium status (read-only, server-side). null when it can't be read right now,
 * which clients must treat as "not premium" (never as "keep the last known value").
 */
async function readJobformPremium(userId: string): Promise<JobformPremiumStatus | null> {
  try {
    return await JobformPremiumService.getStatus(userId);
  } catch (error: any) {
    logger.warn(`[Subscription] Could not read JobForm Automator premium status for ${userId}: ${error?.message}`);
    return null;
  }
}

export class SubscriptionController {
  /**
   * GET /api/v1/subscription/me
   * Returns authenticated user's current subscription details & trial status.
   * Public to authenticated users even if trial is expired!
   */
  public static async getMySubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      // 1. On-demand subscription expiration check & auto-healing for 5-day trial window
      await TrialService.expireSubscriptionIfEnded(userId);
      await TrialService.healUserTrialSubscriptionIfEligible(userId);

      // 2. Check the permanent trial eligibility flag
      const hasUsedTrial = await TrialService.hasUsedTrial(userId);

      // 3. Fetch the user's current subscription
      let subscription = await TrialService.getCurrentSubscriptionDto(userId);

      if (!subscription && !hasUsedTrial) {
        // Auto-provision 5-day free trial ONLY for brand-new users who have NEVER used a trial before
        try {
          subscription = await TrialService.createFreeTrial(userId);
        } catch {
          subscription = await TrialService.getCurrentSubscriptionDto(userId);
        }
      }

      const premium = await readJobformPremium(userId);

      if (!subscription) {
        res.status(200).json({
          success: true,
          data: {
            subscription: null,
            status: hasUsedTrial ? 'EXPIRED' : 'NONE',
            hasActiveEntitlement: false,
            trialInfo: null,
            message: hasUsedTrial
              ? 'Your free trial has already been used. Please subscribe to a paid plan to continue.'
              : undefined,
            premium,
          },
        });
        return;
      }

      const hasActiveEntitlement = ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(subscription.status);

      let trialInfo = null;
      if (subscription.isTrial && subscription.trialEndDate) {
        trialInfo = TrialService.calculateTrialRemaining(subscription.trialEndDate);
      }

      res.status(200).json({
        success: true,
        data: {
          subscription,
          status: subscription.status,
          hasActiveEntitlement,
          trialInfo,
          premium,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/subscription/plans
   * Public endpoint to list all available active plans.
   */
  public static async getPlans(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const plans = await PlanService.getActivePlans();
      res.status(200).json({
        success: true,
        data: { plans },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/subscription/trial/activate
   * Manually activates/provisions 5-day free trial for users who registered without a trial.
   */
  public static async activateFreeTrial(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const subscription = await TrialService.createFreeTrial(userId);
      const trialInfo = TrialService.calculateTrialRemaining(subscription.trialEndDate!);

      res.status(200).json({
        success: true,
        message: 'Free trial activated successfully',
        data: {
          subscription,
          status: subscription.status,
          hasActiveEntitlement: true,
          trialInfo,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
