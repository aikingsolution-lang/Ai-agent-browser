import type { Request, Response, NextFunction } from 'express';
import { TrialService } from '../services/trial.service.js';
import type { SubscriptionDto } from '../services/rtdb/serializers.js';
import { isRtdbAvailable } from '../services/rtdb/client.js';
import { AppError } from './errorHandler.js';

declare global {
  namespace Express {
    interface Request {
      subscription?: SubscriptionDto;
    }
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

    if (!subscription || !['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(subscription.status)) {
      throw new AppError(
        'Your free trial has expired or you do not have an active subscription. Please upgrade to a paid plan.',
        403,
        'SUBSCRIPTION_EXPIRED',
      );
    }

    req.subscription = subscription;
    next();
  } catch (error) {
    next(error);
  }
}
