import type { Request, Response, NextFunction } from 'express';
import { ProfileService } from '../services/profile.service.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';

export class ProfileController {
  /**
   * GET /api/v1/profile
   * Retrieves stored Career Brain profile for authenticated user.
   */
  public static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id.toString();
      const profile = await ProfileService.getProfile(userId);

      sendSuccess(res, profile, 'Profile retrieved successfully', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/v1/profile
   * Upserts Career Brain profile from Chrome extension.
   */
  public static async syncProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id.toString();
      const profileData = req.body;

      if (!profileData) {
        sendError(res, 'Profile payload is required', 400, 'MISSING_PAYLOAD');
        return;
      }

      const updated = await ProfileService.syncProfile(userId, profileData);
      sendSuccess(res, updated, 'Profile synced successfully', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/profile/quota
   * Retrieves active daily quota status (with lazy date reset).
   */
  public static async getQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id.toString();
      const quota = await ProfileService.getQuota(userId);

      sendSuccess(res, quota, 'Quota status retrieved', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/profile/quota/check-and-increment
   * Atomically validates and increments application count with $inc.
   */
  public static async checkAndIncrementQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id.toString();
      const quotaResult = await ProfileService.checkAndIncrementQuota(userId);

      if (!quotaResult.allowed) {
        sendError(
          res,
          `Daily application limit reached (${quotaResult.appliedToday}/${quotaResult.dailyLimit}). Upgrade to Premium to unlock 100 jobs/day.`,
          429,
          'QUOTA_EXCEEDED',
          quotaResult,
        );
        return;
      }

      sendSuccess(res, quotaResult, 'Quota validated and incremented successfully', 200);
    } catch (error) {
      next(error);
    }
  }
}
