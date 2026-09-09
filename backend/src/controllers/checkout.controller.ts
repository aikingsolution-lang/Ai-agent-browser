import { Request, Response, NextFunction } from 'express';
import { SubscriptionLifecycleService } from '../services/subscriptionLifecycle.service.js';
import {
  checkoutInputSchema,
  verifyPaymentInputSchema,
  cancelSubscriptionSchema,
} from '../schemas/subscription.schema.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { AppError } from '../middleware/errorHandler.js';

export class CheckoutController {
  /**
   * POST /api/v1/subscription/checkout
   * Creates a Razorpay checkout session for a selected paid plan.
   */
  public static async checkout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const input = checkoutInputSchema.parse(req.body);
      const result = await SubscriptionLifecycleService.createCheckoutSession(
        userId,
        input.planCode,
        input.idempotencyKey,
      );

      sendSuccess(res, result, 'Checkout session created successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/subscription/verify-payment
   * Verifies Razorpay payment signature and activates paid subscription.
   */
  public static async verifyPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const input = verifyPaymentInputSchema.parse(req.body);
      const result = await SubscriptionLifecycleService.verifyPayment({
        userId,
        paymentId: input.razorpayPaymentId,
        subscriptionId: input.razorpaySubscriptionId,
        signature: input.razorpaySignature,
      });

      sendSuccess(
        res,
        {
          subscription: result.subscription,
          hasActiveEntitlement: result.hasActiveEntitlement,
          isIdempotentRetry: result.isIdempotentRetry,
        },
        result.isIdempotentRetry ? 'Payment already verified' : 'Payment verified and subscription activated',
        200,
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/subscription/cancel
   * Requests cancellation at period end.
   */
  public static async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?._id?.toString();
      if (!userId) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      cancelSubscriptionSchema.parse(req.body || {});
      const subscription = await SubscriptionLifecycleService.cancelSubscription(userId);

      sendSuccess(
        res,
        {
          subscription,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          currentPeriodEnd: subscription.currentPeriodEnd,
        },
        'Subscription scheduled for cancellation at current period end',
      );
    } catch (error) {
      next(error);
    }
  }
}
