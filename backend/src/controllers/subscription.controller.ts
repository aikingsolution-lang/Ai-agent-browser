import type { Request, Response, NextFunction } from 'express';
import { Subscription } from '../models/subscription.model.js';
import { Plan } from '../models/plan.model.js';
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

      // 2. Fetch latest subscription for user
      const subscription = await Subscription.findOne({ userId }).sort({ createdAt: -1 });

      if (!subscription) {
        res.status(200).json({
          success: true,
          data: {
            subscription: null,
            status: 'NONE',
            hasActiveEntitlement: false,
            trialInfo: null,
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
}
