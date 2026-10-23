import type { Request, Response, NextFunction } from 'express';
import { TrialService } from '../services/trial.service.js';
import { JobformPremiumService } from '../services/jobformPremium.service.js';
import type { SubscriptionDto } from '../services/rtdb/serializers.js';
import { isRtdbAvailable } from '../services/rtdb/client.js';
import { AppError } from './errorHandler.js';
import { logger } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Request {
      subscription?: SubscriptionDto;
      /** The user's AI use is covered by a verified JobForm Automator Premium/Diamond subscription. */
      premiumCovered?: boolean;
    }
  }
}

/**
 * Verified JobForm Automator Premium (user/{uid}/Payment, written only by the website's server after
 * Razorpay verification). A read failure counts as "not Premium".
 */
export async function hasVerifiedJobformPremium(userId: string): Promise<boolean> {
  try {
    return (await JobformPremiumService.getStatus(userId)).isPremium;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[Entitlement] Could not read JobForm Automator premium status for ${userId}: ${message}`);
    return false;
  }
}

export async function checkEntitlement(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new AppError('Authentication required to access this resource', 401, 'UNAUTHORIZED');
    }

    // Fail-closed check if the database is not configured
    if (!isRtdbAvailable()) {
      throw new AppError('Service temporarily unavailable, cannot verify entitlement', 503, 'SERVICE_UNAVAILABLE');
    }

    // Real-time check & atomic expiration of trial, 72h past_due, or ended cancelled subscriptions
    await TrialService.expireSubscriptionIfEnded(userId);
    await TrialService.healUserTrialSubscriptionIfEligible(userId);

    // Current active, trialing, or past_due subscription (one subscription node per user)
    const subscription = await TrialService.getCurrentSubscriptionDto(userId);
    const hasSubscription = Boolean(subscription && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(subscription.status));

    // JobForm Automator Premium includes AI Auto Apply, whatever the state of the separate credit plans.
    const premiumCovered = await hasVerifiedJobformPremium(userId);

    if (!hasSubscription && !premiumCovered) {
      throw new AppError(
        'Your free trial has expired or you do not have an active subscription. Please upgrade to a paid plan.',
        403,
        'SUBSCRIPTION_EXPIRED',
      );
    }

    if (subscription) req.subscription = subscription;
    req.premiumCovered = premiumCovered;
    next();
  } catch (error) {
    next(error);
  }
}
