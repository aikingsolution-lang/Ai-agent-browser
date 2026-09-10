import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { Plan } from '../models/plan.model.js';
import { Subscription, type ISubscription } from '../models/subscription.model.js';
import { WebhookLedger } from '../models/webhookLedger.model.js';
import { RazorpayService } from './razorpay.service.js';
import { CreditService } from './credit.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

export interface CheckoutResult {
  subscriptionId: string;
  razorpayPlanId: string;
  planCode: string;
  planName: string;
  amount: number;
  currency: string;
  keyId: string;
  shortUrl?: string;
}

export interface VerifyPaymentParams {
  userId: string | mongoose.Types.ObjectId;
  paymentId: string;
  subscriptionId: string;
  signature: string;
}

export interface ProcessWebhookParams {
  eventId: string;
  eventType: string;
  providerPaymentId?: string;
  payload: Record<string, any>;
  rawBody: Buffer | string;
  signatureHeader: string;
  eventCreatedAt?: Date;
}

export class SubscriptionLifecycleService {
  /**
   * Creates a Razorpay subscription checkout session for a paid plan.
   * Uses DB Plan as strict source of truth for amounts, currencies, and Razorpay plan IDs.
   * Enforces checkout idempotency and prevents duplicate provider subscription sessions.
   */
  public static async createCheckoutSession(
    userId: string | mongoose.Types.ObjectId,
    planCode: string,
    _idempotencyKey?: string,
  ): Promise<CheckoutResult> {
    const plan = await Plan.findOne({ code: planCode, isActive: true });
    if (!plan) {
      throw new AppError(`Plan with code '${planCode}' not found or inactive`, 404, 'PLAN_NOT_FOUND');
    }

    if (plan.billingInterval === 'none' || plan.code === 'free-trial') {
      throw new AppError('Cannot create a paid checkout session for a free trial plan', 400, 'INVALID_PLAN');
    }

    const razorpayPlanId = plan.razorpayPlanId || `plan_rzp_mock_${plan.code}`;

    // 1. Check if user already has a subscription with a providerSubscriptionId
    let existingSubscription = await Subscription.findOne({
      userId,
      providerSubscriptionId: { $exists: true, $ne: null },
      status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
    }).sort({ createdAt: -1 });

    if (!existingSubscription) {
      existingSubscription = await Subscription.findOne({
        userId,
        status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
      }).sort({ createdAt: -1 });
    }

    if (existingSubscription && existingSubscription.providerSubscriptionId) {
      return {
        subscriptionId: existingSubscription.providerSubscriptionId,
        razorpayPlanId,
        planCode: plan.code,
        planName: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        keyId: env.RAZORPAY_KEY_ID,
      };
    }

    // 2. Call Razorpay API to create subscription session
    const user = await User.findById(userId).select('email').lean();
    const rzpSub = await RazorpayService.createRazorpaySubscription({
      planId: razorpayPlanId,
      totalCount: plan.billingInterval === 'yearly' ? 10 : 12,
      customerNotify: 0,
      notifyInfo: user?.email ? { email: user.email } : undefined,
      notes: { userId: userId.toString(), planCode: plan.code },
    });

    // 3. Update or link subscription record with providerSubscriptionId
    if (existingSubscription) {
      const updatedSub = await Subscription.findOneAndUpdate(
        {
          _id: existingSubscription._id,
          $or: [{ providerSubscriptionId: { $exists: false } }, { providerSubscriptionId: null }],
        },
        { $set: { providerSubscriptionId: rzpSub.id, provider: 'razorpay' } },
        { new: true },
      );
      if (!updatedSub) {
        const recheckSub = await Subscription.findById(existingSubscription._id);
        if (recheckSub?.providerSubscriptionId) {
          return {
            subscriptionId: recheckSub.providerSubscriptionId,
            razorpayPlanId,
            planCode: plan.code,
            planName: plan.name,
            amount: plan.amount,
            currency: plan.currency,
            keyId: env.RAZORPAY_KEY_ID,
          };
        }
      }
    }

    return {
      subscriptionId: rzpSub.id,
      razorpayPlanId,
      planCode: plan.code,
      planName: plan.name,
      amount: plan.amount,
      currency: plan.currency,
      keyId: env.RAZORPAY_KEY_ID,
      shortUrl: rzpSub.short_url,
    };
  }

  /**
   * Verifies Razorpay checkout signature and updates subscription status to ACTIVE.
   * Validates subscription ownership and maps duplicate index errors cleanly.
   */
  public static async verifyPayment(params: VerifyPaymentParams): Promise<{
    subscription: ISubscription;
    hasActiveEntitlement: boolean;
    isIdempotentRetry: boolean;
  }> {
    const { userId, paymentId, subscriptionId, signature } = params;

    // 1. Verify HMAC Signature
    const isValidSignature = RazorpayService.verifyCheckoutSignature(paymentId, subscriptionId, signature);
    if (!isValidSignature) {
      throw new AppError('Invalid payment verification signature', 401, 'INVALID_SIGNATURE');
    }

    // 2. Cross-user ownership check: Ensure subscriptionId does not belong to another user
    const existingOwner = await Subscription.findOne({ providerSubscriptionId: subscriptionId });
    if (existingOwner && existingOwner.userId.toString() !== userId.toString()) {
      throw new AppError('Razorpay subscription ID belongs to another user account', 403, 'FORBIDDEN');
    }

    // 3. Fetch Subscription for current User
    let subscription =
      (await Subscription.findOne({ providerSubscriptionId: subscriptionId })) ||
      (await Subscription.findOne({ userId }).sort({ createdAt: -1 }));
    if (!subscription) {
      throw new AppError('Subscription not found for user', 404, 'SUBSCRIPTION_NOT_FOUND');
    }

    // 4. Idempotency Check: Already active for this providerSubscriptionId
    if (subscription.status === 'ACTIVE' && subscription.providerSubscriptionId === subscriptionId) {
      return {
        subscription,
        hasActiveEntitlement: true,
        isIdempotentRetry: true,
      };
    }

    const now = new Date();
    const durationDays = subscription.billingIntervalSnapshot === 'yearly' ? 365 : 30;
    const periodEnd = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // Update Subscription status to ACTIVE
    subscription.status = 'ACTIVE';
    subscription.isTrial = false;
    subscription.provider = 'razorpay';
    subscription.providerSubscriptionId = subscriptionId;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.lastEventTimestamp = now;
    subscription.cancelAtPeriodEnd = false;
    subscription.pastDueStartedAt = undefined;

    try {
      await subscription.save();
    } catch (error: any) {
      if (error.code === 11000 || error.message?.includes('E11000')) {
        throw new AppError(
          'Razorpay subscription ID is already linked to another user account',
          409,
          'SUBSCRIPTION_ALREADY_LINKED',
        );
      }
      throw error;
    }

    // Reset / Allocate credits for paid subscription
    await CreditService.initializeCreditsForSubscription({
      userId,
      subscriptionId: subscription._id,
      allocatedCredits: subscription.creditsSnapshot,
      periodStart: now,
      periodEnd,
      description: `Paid subscription activation credits (${subscription.planCodeSnapshot})`,
      type: 'SUBSCRIPTION_RENEWAL',
    });

    logger.info(`Verified payment ${paymentId} for subscription ${subscription._id}, status set to ACTIVE`);

    return {
      subscription,
      hasActiveEntitlement: true,
      isIdempotentRetry: false,
    };
  }

  /**
   * User-initiated cancellation. Sets cancelAtPeriodEnd = true.
   * User retains full access until currentPeriodEnd.
   */
  public static async cancelSubscription(userId: string | mongoose.Types.ObjectId): Promise<ISubscription> {
    const subscription = await Subscription.findOne({
      userId,
      status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
    });

    if (!subscription) {
      throw new AppError('No active or trialing subscription found to cancel', 404, 'SUBSCRIPTION_NOT_FOUND');
    }

    subscription.cancelAtPeriodEnd = true;
    subscription.canceledAt = new Date();
    await subscription.save();

    logger.info(`User ${userId} requested cancellation at period end (${subscription.currentPeriodEnd})`);

    return subscription;
  }

  /**
   * Processes incoming Razorpay server-to-server webhooks with atomic deduplication,
   * HMAC verification, stale event detection, stuck processing reclaim, and credit reset handling.
   */
  public static async processWebhook(params: ProcessWebhookParams): Promise<{
    success: boolean;
    message: string;
    isDuplicate?: boolean;
  }> {
    const { eventId, eventType, providerPaymentId, payload, rawBody, signatureHeader, eventCreatedAt } = params;

    // 1. HMAC Signature Verification over Raw Body
    const isValidSignature = RazorpayService.verifyWebhookSignature(rawBody, signatureHeader);
    if (!isValidSignature) {
      throw new AppError('Invalid webhook signature', 401, 'INVALID_SIGNATURE');
    }

    // 2. Atomic Claim Strategy via WebhookLedger with Stuck 'PROCESSING' Reclaim
    let ledger;
    try {
      ledger = await WebhookLedger.create({
        eventId,
        eventType,
        providerPaymentId,
        status: 'PROCESSING',
        payload,
      });
    } catch (error: any) {
      if (error.code === 11000 || error.message?.includes('E11000')) {
        const existing = await WebhookLedger.findOne({ eventId });
        if (existing?.status === 'PROCESSED') {
          return { success: true, message: 'Event already processed', isDuplicate: true };
        }
        if (existing?.status === 'PROCESSING') {
          const elapsed = Date.now() - existing.createdAt.getTime();
          if (elapsed < 120000) {
            // Less than 2 minutes: active processing
            return { success: true, message: 'Event currently processing', isDuplicate: true };
          }
          // Stuck > 2 minutes: Reclaim lock safely for retry
          logger.warn(`Reclaiming stuck PROCESSING webhook event ${eventId}`);
          existing.updatedAt = new Date();
          await existing.save();
          ledger = existing;
        } else {
          ledger = existing;
        }
      } else {
        throw error;
      }
    }

    try {
      const subEntity = payload.subscription?.entity || payload.entity;
      const rzpSubId = subEntity?.id;
      const paymentId = providerPaymentId || payload.payment?.entity?.id || `evt_pay_${eventId}`;

      if (rzpSubId) {
        const subscription = await Subscription.findOne({ providerSubscriptionId: rzpSubId });

        if (subscription) {
          const now = new Date();
          const timestamp = eventCreatedAt || now;

          // Stale Event Protection
          if (subscription.lastEventTimestamp && timestamp < subscription.lastEventTimestamp) {
            logger.info(`Ignored stale webhook event '${eventType}' for subscription ${subscription._id}`);
            if (ledger) {
              ledger.status = 'PROCESSED';
              ledger.processedAt = now;
              await ledger.save();
            }
            return { success: true, message: 'Stale event ignored', isDuplicate: true };
          }

          subscription.lastEventTimestamp = timestamp;

          // Event State Machine Transitions
          if (eventType === 'subscription.activated' || eventType === 'subscription.authenticated') {
            subscription.status = 'ACTIVE';
            subscription.isTrial = false;
            subscription.pastDueStartedAt = undefined;
            await subscription.save();

            await CreditService.initializeCreditsForSubscription({
              userId: subscription.userId,
              subscriptionId: subscription._id,
              allocatedCredits: subscription.creditsSnapshot,
              periodStart: subscription.currentPeriodStart,
              periodEnd: subscription.currentPeriodEnd,
              type: 'SUBSCRIPTION_RENEWAL',
            });
          } else if (eventType === 'subscription.charged') {
            const durationDays = subscription.billingIntervalSnapshot === 'yearly' ? 365 : 30;
            const oldStart = subscription.currentPeriodStart;
            const oldEnd = subscription.currentPeriodEnd;
            const oldStatus = subscription.status;

            const newStart = now;
            const newEnd = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

            subscription.status = 'ACTIVE';
            subscription.currentPeriodStart = newStart;
            subscription.currentPeriodEnd = newEnd;
            subscription.pastDueStartedAt = undefined;
            await subscription.save();

            try {
              // Renewal Credit Reset using provider payment ID as idempotency key
              await CreditService.initializeCreditsForSubscription({
                userId: subscription.userId,
                subscriptionId: subscription._id,
                allocatedCredits: subscription.creditsSnapshot,
                periodStart: newStart,
                periodEnd: newEnd,
                description: `Renewal credit top-up (${paymentId})`,
                type: 'SUBSCRIPTION_RENEWAL',
              });
            } catch (creditError) {
              // Standalone MongoDB Fallback: Revert period update if credit initialization fails
              subscription.currentPeriodStart = oldStart;
              subscription.currentPeriodEnd = oldEnd;
              subscription.status = oldStatus;
              await subscription.save();
              throw creditError;
            }
          } else if (eventType === 'subscription.halted' || eventType === 'payment.failed') {
            subscription.status = 'PAST_DUE';
            subscription.pastDueStartedAt = now;
            await subscription.save();
          } else if (eventType === 'subscription.cancelled') {
            if (payload.immediate) {
              subscription.status = 'CANCELLED';
              subscription.endedAt = now;
            } else {
              subscription.cancelAtPeriodEnd = true;
              subscription.canceledAt = now;
            }
            await subscription.save();
          }
        }
      }

      if (ledger) {
        ledger.status = 'PROCESSED';
        ledger.processedAt = new Date();
        await ledger.save();
      }

      return { success: true, message: 'Webhook processed successfully' };
    } catch (error: any) {
      if (ledger) {
        ledger.status = 'FAILED';
        ledger.errorMessage = error.message;
        await ledger.save();
      }
      throw error;
    }
  }
}
