/**
 * subscriptionLifecycle.service.ts
 *
 * Paid subscription lifecycle (checkout, payment verification, cancellation, Razorpay webhooks),
 * backed by Firebase RTDB. Business rules are unchanged from the Mongo version; only storage moved:
 *
 *   nanobrowser/subscriptions/{uid}                        current subscription
 *   nanobrowser/provider_subscriptions/{razorpaySubKey}    razorpay subscription id -> owner
 *                                                          (was the unique index on providerSubscriptionId)
 *   nanobrowser/processed_webhooks/{eventKey}              webhook idempotency ledger
 *                                                          (was the WebhookLedger collection)
 *
 * Subscription changes and their credit allocation are written in one atomic multi-location update.
 */

import { RazorpayService } from './razorpay.service.js';
import { CreditService } from './credit.service.js';
import { ProfileService } from './profile.service.js';
import { PlanService } from './planSeed.service.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { paths } from './rtdb/client.js';
import { applyUpdates, SubscriptionRepository, UserProfileRepository, WebhookRepository } from './rtdb/repositories.js';
import { isSafeKey, keyForExternalId, toMs } from './rtdb/rtdbUtils.js';
import { toSubscriptionDto, type SubscriptionDto } from './rtdb/serializers.js';
import { ENTITLED_STATUSES, type SubscriptionRecord } from './rtdb/records.js';

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
  userId: string;
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
  eventCreatedAt?: Date | number;
}

const WEBHOOK_STUCK_AFTER_MS = 120000; // 2 minutes
const DAY_MS = 24 * 60 * 60 * 1000;

function isEntitled(sub: SubscriptionRecord | null): sub is SubscriptionRecord {
  return Boolean(sub && ENTITLED_STATUSES.includes(sub.status));
}

/** Removes optional keys (RTDB deletes a field when it is absent from a whole-record write). */
function withoutField<T extends object, K extends keyof T>(record: T, key: K): T {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

async function upgradeToPremiumSafely(userId: string): Promise<void> {
  try {
    await ProfileService.upgradeToPremium(userId);
  } catch (e: any) {
    logger.warn(`Failed to upgrade Career Brain tier for user ${userId}: ${e.message}`);
  }
}

export class SubscriptionLifecycleService {
  /**
   * Creates a Razorpay subscription checkout session for a paid plan.
   * Uses the stored plan as the source of truth for amounts, currencies, and Razorpay plan IDs.
   * Reuses an existing provider subscription instead of creating a duplicate session.
   */
  public static async createCheckoutSession(
    userId: string,
    planCode: string,
    _idempotencyKey?: string,
  ): Promise<CheckoutResult> {
    const plan = await PlanService.getActivePlan(planCode);
    if (!plan) {
      throw new AppError(`Plan with code '${planCode}' not found or inactive`, 404, 'PLAN_NOT_FOUND');
    }

    if (plan.billingInterval === 'none' || plan.code === 'free-trial') {
      throw new AppError('Cannot create a paid checkout session for a free trial plan', 400, 'INVALID_PLAN');
    }

    const razorpayPlanId = plan.razorpayPlanId || `plan_rzp_mock_${plan.code}`;
    const sessionFor = (providerSubscriptionId: string, shortUrl?: string): CheckoutResult => ({
      subscriptionId: providerSubscriptionId,
      razorpayPlanId,
      planCode: plan.code,
      planName: plan.name,
      amount: plan.amount,
      currency: plan.currency,
      keyId: env.RAZORPAY_KEY_ID,
      ...(shortUrl ? { shortUrl } : {}),
    });

    // 1. Reuse the provider subscription already linked to the active subscription
    const existingSubscription = await SubscriptionRepository.getCurrent(userId);
    if (isEntitled(existingSubscription) && existingSubscription.providerSubscriptionId) {
      return sessionFor(existingSubscription.providerSubscriptionId);
    }

    // 2. Call Razorpay API to create subscription session
    const profile = await UserProfileRepository.get(userId);
    const rzpSub = await RazorpayService.createRazorpaySubscription({
      planId: razorpayPlanId,
      totalCount: plan.billingInterval === 'yearly' ? 10 : 12,
      customerNotify: 0,
      notifyInfo: profile?.email ? { email: profile.email } : undefined,
      notes: { userId, planCode: plan.code },
    });

    // 3. Link the provider subscription id to the active subscription (only if none is linked yet)
    if (isEntitled(existingSubscription)) {
      const now = Date.now();
      const linked = await SubscriptionRepository.transactCurrent(userId, sub =>
        isEntitled(sub) && !sub.providerSubscriptionId
          ? { ...sub, providerSubscriptionId: rzpSub.id, provider: 'razorpay', updatedAt: now }
          : null,
      );

      if (linked.changed && linked.subscription) {
        await SubscriptionRepository.claimProviderLink(keyForExternalId(rzpSub.id), {
          uid: userId,
          subscriptionId: linked.subscription.subscriptionId,
          providerSubscriptionId: rzpSub.id,
          linkedAt: now,
        });
      } else if (linked.subscription?.providerSubscriptionId) {
        // A concurrent checkout linked its session first: return that one.
        return sessionFor(linked.subscription.providerSubscriptionId);
      }
    }

    return sessionFor(rzpSub.id, rzpSub.short_url);
  }

  /**
   * Verifies the Razorpay checkout signature and activates the subscription.
   * Validates subscription ownership across users.
   */
  public static async verifyPayment(params: VerifyPaymentParams): Promise<{
    subscription: SubscriptionDto;
    hasActiveEntitlement: boolean;
    isIdempotentRetry: boolean;
  }> {
    const { userId, paymentId, subscriptionId, signature } = params;

    // 1. Verify HMAC Signature
    const isValidSignature = RazorpayService.verifyCheckoutSignature(paymentId, subscriptionId, signature);
    if (!isValidSignature) {
      throw new AppError('Invalid payment verification signature', 401, 'INVALID_SIGNATURE');
    }

    // 2. Cross-user ownership check: the subscriptionId must not belong to another user
    const providerKey = keyForExternalId(subscriptionId);
    const existingOwner = await SubscriptionRepository.getProviderLink(providerKey);
    if (existingOwner && existingOwner.uid !== userId) {
      throw new AppError('Razorpay subscription ID belongs to another user account', 403, 'FORBIDDEN');
    }

    // 3. Fetch the user's subscription
    const subscription = await SubscriptionRepository.getCurrent(userId);
    if (!subscription) {
      throw new AppError('Subscription not found for user', 404, 'SUBSCRIPTION_NOT_FOUND');
    }

    // 4. Idempotency Check: Already active for this providerSubscriptionId
    if (subscription.status === 'ACTIVE' && subscription.providerSubscriptionId === subscriptionId) {
      return {
        subscription: toSubscriptionDto(subscription),
        hasActiveEntitlement: true,
        isIdempotentRetry: true,
      };
    }

    // 5. Claim the provider subscription id for this user (unique across users)
    const now = Date.now();
    const link = await SubscriptionRepository.claimProviderLink(providerKey, {
      uid: userId,
      subscriptionId: subscription.subscriptionId,
      providerSubscriptionId: subscriptionId,
      linkedAt: now,
    });
    if (link.ownerUid !== userId) {
      throw new AppError(
        'Razorpay subscription ID is already linked to another user account',
        409,
        'SUBSCRIPTION_ALREADY_LINKED',
      );
    }

    const durationDays = subscription.billingIntervalSnapshot === 'yearly' ? 365 : 30;
    const periodEnd = now + durationDays * DAY_MS;

    const activated: SubscriptionRecord = withoutField(
      {
        ...subscription,
        status: 'ACTIVE',
        isTrial: false,
        provider: 'razorpay',
        providerSubscriptionId: subscriptionId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        lastEventTimestamp: now,
        cancelAtPeriodEnd: false,
        updatedAt: now,
      },
      'pastDueStartedAt',
    );

    // Subscription status + paid credit allocation in one atomic update
    const allocation = await CreditService.buildAllocationUpdates({
      userId,
      subscriptionId: subscription.subscriptionId,
      allocatedCredits: subscription.creditsSnapshot,
      periodStart: now,
      periodEnd,
      description: `Paid subscription activation credits (${subscription.planCodeSnapshot})`,
      type: 'SUBSCRIPTION_RENEWAL',
    });
    await applyUpdates({ [paths.subscription(userId)]: activated, ...allocation.updates });

    // Upgrade Career Brain tier to Premium (100 jobs/day)
    await upgradeToPremiumSafely(userId);

    logger.info(`Verified payment ${paymentId} for subscription ${subscription.subscriptionId}, status set to ACTIVE`);

    return {
      subscription: toSubscriptionDto(activated),
      hasActiveEntitlement: true,
      isIdempotentRetry: false,
    };
  }

  /**
   * Admin activation of a plan (scripts/activate_pro_user.ts): makes `planCode` the user's ACTIVE
   * subscription for `durationDays`, allocates the plan credits and upgrades the Career Brain tier.
   * An existing subscription record is updated in place (same id), as the old Mongo script did.
   */
  public static async activatePlanManually(
    userId: string,
    planCode: string,
    durationDays = 30,
  ): Promise<SubscriptionDto> {
    const plan = await PlanService.getActivePlan(planCode);
    if (!plan) {
      throw new AppError(`Plan '${planCode}' not found or inactive`, 404, 'PLAN_NOT_FOUND');
    }
    const now = Date.now();
    const periodEnd = now + durationDays * DAY_MS;
    const previous = await SubscriptionRepository.getCurrent(userId);
    const subscriptionId = previous?.subscriptionId ?? `sub_manual_${plan.code}_${now.toString(36)}`;

    const activated: SubscriptionRecord = {
      subscriptionId,
      uid: userId,
      planId: plan.legacyId || plan.code,
      planCodeSnapshot: plan.code,
      planNameSnapshot: plan.name,
      amountSnapshot: plan.amount,
      currencySnapshot: plan.currency,
      billingIntervalSnapshot: plan.billingInterval,
      creditsSnapshot: plan.creditsPerBillingPeriod,
      rateLimitSnapshot: plan.rateLimitPerMinute,
      provider: previous?.provider ?? 'manual',
      providerSubscriptionId: previous?.providerSubscriptionId,
      status: 'ACTIVE',
      isTrial: false,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastEventTimestamp: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    const allocation = await CreditService.buildAllocationUpdates({
      userId,
      subscriptionId,
      allocatedCredits: plan.creditsPerBillingPeriod,
      periodStart: now,
      periodEnd,
      description: `Manual ${plan.name} activation (${plan.creditsPerBillingPeriod} credits)`,
      type: 'SUBSCRIPTION_RENEWAL',
    });
    await applyUpdates({ [paths.subscription(userId)]: activated, ...allocation.updates });
    await upgradeToPremiumSafely(userId);

    logger.info(`Manually activated plan ${plan.code} for user ${userId} until ${new Date(periodEnd).toISOString()}`);
    return toSubscriptionDto(activated);
  }

  /**
   * User-initiated cancellation. Sets cancelAtPeriodEnd = true.
   * User retains full access until currentPeriodEnd.
   */
  public static async cancelSubscription(userId: string): Promise<SubscriptionDto> {
    const now = Date.now();
    const { changed, subscription } = await SubscriptionRepository.transactCurrent(userId, sub =>
      isEntitled(sub) ? { ...sub, cancelAtPeriodEnd: true, canceledAt: now, updatedAt: now } : null,
    );

    if (!changed || !subscription) {
      throw new AppError('No active or trialing subscription found to cancel', 404, 'SUBSCRIPTION_NOT_FOUND');
    }

    logger.info(
      `User ${userId} requested cancellation at period end (${new Date(subscription.currentPeriodEnd).toISOString()})`,
    );

    return toSubscriptionDto(subscription);
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

    // 2. Atomic claim of the event, with stuck 'PROCESSING' reclaim
    const eventKey = keyForExternalId(String(eventId));
    const claimOutcome = await WebhookRepository.claim(
      eventKey,
      {
        eventId: String(eventId),
        eventType,
        providerPaymentId,
        payloadJson: JSON.stringify(payload ?? {}),
      },
      Date.now(),
      WEBHOOK_STUCK_AFTER_MS,
    );

    if (claimOutcome === 'ALREADY_PROCESSED') {
      return { success: true, message: 'Event already processed', isDuplicate: true };
    }
    if (claimOutcome === 'IN_FLIGHT') {
      return { success: true, message: 'Event currently processing', isDuplicate: true };
    }
    if (claimOutcome === 'RECLAIMED') {
      logger.warn(`Reclaiming stuck PROCESSING webhook event ${eventId}`);
    }

    try {
      const subEntity = payload.subscription?.entity || payload.entity;
      const rzpSubId: string | undefined = typeof subEntity?.id === 'string' ? subEntity.id : undefined;
      const paymentId = providerPaymentId || payload.payment?.entity?.id || `evt_pay_${eventId}`;

      if (rzpSubId) {
        const link = await SubscriptionRepository.getProviderLink(keyForExternalId(rzpSubId));
        const subscription = link ? await SubscriptionRepository.getCurrent(link.uid) : null;

        if (subscription && subscription.providerSubscriptionId === rzpSubId) {
          const uid = subscription.uid;
          const now = Date.now();
          const timestamp = toMs(eventCreatedAt) ?? now;

          // Stale Event Protection
          if (subscription.lastEventTimestamp && timestamp < subscription.lastEventTimestamp) {
            logger.info(`Ignored stale webhook event '${eventType}' for subscription ${subscription.subscriptionId}`);
            await WebhookRepository.markProcessed(eventKey, now);
            return { success: true, message: 'Stale event ignored', isDuplicate: true };
          }

          // Event State Machine Transitions
          if (eventType === 'subscription.activated' || eventType === 'subscription.authenticated') {
            const next = withoutField(
              {
                ...subscription,
                status: 'ACTIVE' as const,
                isTrial: false,
                lastEventTimestamp: timestamp,
                updatedAt: now,
              },
              'pastDueStartedAt',
            );
            const allocation = await CreditService.buildAllocationUpdates({
              userId: uid,
              subscriptionId: subscription.subscriptionId,
              allocatedCredits: subscription.creditsSnapshot,
              periodStart: subscription.currentPeriodStart,
              periodEnd: subscription.currentPeriodEnd,
              type: 'SUBSCRIPTION_RENEWAL',
            });
            await applyUpdates({ [paths.subscription(uid)]: next, ...allocation.updates });
            await upgradeToPremiumSafely(uid);
          } else if (eventType === 'subscription.charged') {
            const durationDays = subscription.billingIntervalSnapshot === 'yearly' ? 365 : 30;
            const newStart = now;
            const newEnd = now + durationDays * DAY_MS;
            const next = withoutField(
              {
                ...subscription,
                status: 'ACTIVE' as const,
                currentPeriodStart: newStart,
                currentPeriodEnd: newEnd,
                lastEventTimestamp: timestamp,
                updatedAt: now,
              },
              'pastDueStartedAt',
            );
            // Renewal credit reset; the period change and the credits commit together (the Mongo
            // version needed a manual revert when the credit write failed).
            const allocation = await CreditService.buildAllocationUpdates({
              userId: uid,
              subscriptionId: subscription.subscriptionId,
              allocatedCredits: subscription.creditsSnapshot,
              periodStart: newStart,
              periodEnd: newEnd,
              description: `Renewal credit top-up (${paymentId})`,
              type: 'SUBSCRIPTION_RENEWAL',
            });
            await applyUpdates({ [paths.subscription(uid)]: next, ...allocation.updates });
            await upgradeToPremiumSafely(uid);
          } else if (eventType === 'subscription.halted' || eventType === 'payment.failed') {
            await applyUpdates({
              [paths.subscription(uid)]: {
                ...subscription,
                status: 'PAST_DUE',
                pastDueStartedAt: now,
                lastEventTimestamp: timestamp,
                updatedAt: now,
              },
            });
          } else if (eventType === 'subscription.cancelled') {
            const next: SubscriptionRecord = payload.immediate
              ? { ...subscription, status: 'CANCELLED', endedAt: now, lastEventTimestamp: timestamp, updatedAt: now }
              : {
                  ...subscription,
                  cancelAtPeriodEnd: true,
                  canceledAt: now,
                  lastEventTimestamp: timestamp,
                  updatedAt: now,
                };
            await applyUpdates({ [paths.subscription(uid)]: next });
          }
        }
      }

      // Handle standalone or subscription payment.captured
      if (eventType === 'payment.captured') {
        const paymentEntity = payload.payment?.entity || payload.entity;
        const capturedSubId = paymentEntity?.subscription_id || rzpSubId;
        let targetUserId: unknown = paymentEntity?.notes?.userId || payload.order?.entity?.notes?.userId;

        if (!targetUserId && typeof capturedSubId === 'string') {
          const link = await SubscriptionRepository.getProviderLink(keyForExternalId(capturedSubId));
          if (link) {
            targetUserId = link.uid;
          }
        }

        if (typeof targetUserId === 'string' && isSafeKey(targetUserId)) {
          await upgradeToPremiumSafely(targetUserId);
          logger.info(`Upgraded Career Brain to Premium for user ${targetUserId} via payment.captured`);
        }
      }

      await WebhookRepository.markProcessed(eventKey, Date.now());
      return { success: true, message: 'Webhook processed successfully' };
    } catch (error: any) {
      await WebhookRepository.markFailed(eventKey, error?.message || 'Webhook processing failed', Date.now()).catch(
        () => undefined,
      );
      throw error;
    }
  }
}
