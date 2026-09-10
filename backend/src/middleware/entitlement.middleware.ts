import { Request, Response, NextFunction } from 'express';
import { Subscription, type ISubscription } from '../models/subscription.model.js';
import { TrialService } from '../services/trial.service.js';
import { AppError } from './errorHandler.js';
import { checkDatabaseHealth } from '../config/database.js';

declare global {
  namespace Express {
    interface Request {
      subscription?: ISubscription;
    }
  }
}

export async function checkEntitlement(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      throw new AppError('Authentication required to access this resource', 401, 'UNAUTHORIZED');
    }

    // Fail-closed check if database is disconnected
    const dbHealth = checkDatabaseHealth();
    if (!dbHealth.isConnected) {
      throw new AppError('Service temporarily unavailable, cannot verify entitlement', 503, 'SERVICE_UNAVAILABLE');
    }

    // Real-time check & atomic expiration of trial, 72h past_due, or ended cancelled subscriptions
    await TrialService.expireSubscriptionIfEnded(userId);

    // Fetch current active, trialing, or past_due subscription (latest first)
    const subscription = await Subscription.findOne({
      userId,
      status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
    }).sort({ createdAt: -1 });

    if (!subscription) {
      throw new AppError(
        'Your free trial has expired or you do not have an active subscription. Please upgrade to a paid plan.',
        403,
        'SUBSCRIPTION_EXPIRED',
      );
    }

    if (subscription.status === 'EXPIRED' || subscription.status === 'CANCELLED') {
      throw new AppError(
        'Your subscription is no longer active. Please subscribe to continue access.',
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
