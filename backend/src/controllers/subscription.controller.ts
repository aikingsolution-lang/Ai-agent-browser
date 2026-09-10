import type { Request, Response, NextFunction } from 'express';
import { Subscription } from '../models/subscription.model.js';
import { Plan } from '../models/plan.model.js';
import { User } from '../models/user.model.js';
import { TrialService } from '../services/trial.service.js';
import { AppError } from '../middleware/errorHandler.js';

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

      // 1. On-demand subscription expiration check
      await TrialService.expireSubscriptionIfEnded(userId);

      // 2. Fetch user document to verify trial eligibility flag
      const user = await User.findById(userId);

      // 3. Fetch latest subscription for user
      let subscription: any = await Subscription.findOne({ userId }).sort({ createdAt: -1 });

      if (!subscription && !user?.hasUsedTrial) {
        // Auto-provision 5-day free trial ONLY for brand-new users who have NEVER used a trial before
        try {
          subscription = await TrialService.createFreeTrial(userId);
        } catch (trialErr) {
          subscription = await Subscription.findOne({ userId }).sort({ createdAt: -1 });
        }
      }

      if (!subscription) {
        res.status(200).json({
          success: true,
          data: {
            subscription: null,
            status: user?.hasUsedTrial ? 'EXPIRED' : 'NONE',
            hasActiveEntitlement: false,
            trialInfo: null,
            message: user?.hasUsedTrial
              ? 'Your free trial has already been used. Please subscribe to a paid plan to continue.'
              : undefined,
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
      const plans = await Plan.find({ isActive: true }).select('-__v');
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
