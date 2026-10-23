import type { Request, Response, NextFunction } from 'express';
import { ProfileService } from '../services/profile.service.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { ApplicationQuotaService, type ApplicationQuotaView } from '../services/applicationQuota.service.js';

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
   * Today's application quota (UTC day): applied, held slots, limit for the verified plan, reset time.
   */
  public static async getQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const quota = await ApplicationQuotaService.getStatus(req.user!._id.toString());
      sendSuccess(res, quota, 'Quota status retrieved', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/profile/quota/reserve { jobKey }
   * Holds a slot before a submission. 429 QUOTA_EXCEEDED when the daily limit is reached.
   */
  public static async reserveApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await ApplicationQuotaService.reserve(req.user!._id.toString(), req.body.jobKey);
      if (!result.granted) {
        sendError(res, dailyLimitMessage(result.quota), 429, 'QUOTA_EXCEEDED', result.quota);
        return;
      }
      sendSuccess(res, result, 'Application slot reserved', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/profile/quota/commit { jobKey }
   * Records a successful submission (once per job and day).
   */
  public static async commitApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await ApplicationQuotaService.commit(req.user!._id.toString(), req.body.jobKey);
      sendSuccess(res, result, result.counted ? 'Application counted' : 'Application already counted', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/profile/quota/release { jobKey }
   * Frees the slot of a submission that did not happen.
   */
  public static async releaseApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const quota = await ApplicationQuotaService.release(req.user!._id.toString(), req.body.jobKey);
      sendSuccess(res, { quota }, 'Application slot released', 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/profile/quota/check-and-increment (legacy, no job key)
   * Counts one application if a slot is free.
   */
  public static async checkAndIncrementQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { allowed, quota } = await ApplicationQuotaService.checkAndIncrement(req.user!._id.toString());
      if (!allowed) {
        sendError(res, dailyLimitMessage(quota), 429, 'QUOTA_EXCEEDED', quota);
        return;
      }
      sendSuccess(res, quota, 'Quota validated and incremented successfully', 200);
    } catch (error) {
      next(error);
    }
  }
}

function dailyLimitMessage(quota: ApplicationQuotaView): string {
  const upgrade = quota.isPaid ? '' : ' Upgrade to Premium for up to 300 applications a day.';
  return `Daily application limit reached (${quota.applied}/${quota.limit}). It resets at ${quota.resetsAt}.${upgrade}`;
}
