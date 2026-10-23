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
import {
  applyUpdates,
  SubscriptionRepository,
  UserProfileRepository,
  WebhookRepository,
  type UpdateMap,
} from './rtdb/repositories.js';
import { hashKey, isSafeKey, keyForExternalId, stripUndefined, toMs } from './rtdb/rtdbUtils.js';
import { toSubscriptionDto, type SubscriptionDto } from './rtdb/serializers.js';
import { ENTITLED_STATUSES, type PlanRecord, type SubscriptionRecord } from './rtdb/records.js';

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
/** An unpaid checkout for the same plan is reused (same Razorpay subscription and payment page) for this long. */
const CHECKOUT_REUSE_MS = 12 * 60 * 60 * 1000;

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
   * Creates (or reuses) a Razorpay subscription checkout for a paid plan.
   *
   * The Razorpay subscription is linked to the authenticated user and to the plan being bought
   * before anything is paid, whatever the user's current subscription is (trial, expired trial or
   * another paid plan), so every payment event resolves to this user and this plan. Nothing is
   * granted here: the plan starts only when Razorpay confirms the payment (webhook or the signed
   * checkout callback).
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

    // 1. Already paying for this plan: there is nothing to buy
    const current = await SubscriptionRepository.getCurrent(userId);
    if (current && current.status === 'ACTIVE' && !current.isTrial && current.planCodeSnapshot === plan.code) {
      throw new AppError(`You are already subscribed to the ${plan.name}`, 409, 'ALREADY_SUBSCRIBED');
    }

    // 2. The same unpaid checkout started again: return it instead of creating another one
    const pending = await SubscriptionRepository.getCheckoutSession(userId, plan.code);
    if (pending && Date.now() - pending.createdAt < CHECKOUT_REUSE_MS) {
      const link = await SubscriptionRepository.getProviderLink(keyForExternalId(pending.providerSubscriptionId));
      if (link && link.uid === userId && (link.status === 'PENDING' || link.status === 'AUTHENTICATED')) {
        return sessionFor(pending.providerSubscriptionId, link.shortUrl);
      }
    }

    // 3. New Razorpay subscription, linked to this user and plan from the start
    const profile = await UserProfileRepository.get(userId);
    const rzpSub = await RazorpayService.createRazorpaySubscription({
      planId: razorpayPlanId,
      totalCount: plan.billingInterval === 'yearly' ? 10 : 12,
      customerNotify: 0,
      notifyInfo: profile?.email ? { email: profile.email } : undefined,
      notes: { userId, planCode: plan.code },
    });

    const now = Date.now();
    const claim = await SubscriptionRepository.claimProviderLink(keyForExternalId(rzpSub.id), {
      uid: userId,
      subscriptionId: '',
      providerSubscriptionId: rzpSub.id,
      linkedAt: now,
      planCode: plan.code,
      status: 'PENDING',
      shortUrl: rzpSub.short_url,
      updatedAt: now,
    });
    if (claim.ownerUid !== userId) {
      throw new AppError(
        'Razorpay subscription ID is already linked to another user account',
        409,
        'SUBSCRIPTION_ALREADY_LINKED',
      );
    }
    await SubscriptionRepository.setCheckoutSession(userId, plan.code, {
      providerSubscriptionId: rzpSub.id,
      createdAt: now,
    });

    return sessionFor(rzpSub.id, rzpSub.short_url);
  }

  /**
   * Verifies the signed Razorpay checkout callback and starts the plan bought in that checkout.
   * The checkout must belong to the caller; a repeated callback is idempotent.
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

    // 2. Cross-user ownership check: the checkout must belong to the caller
    const link = await SubscriptionRepository.getProviderLink(keyForExternalId(subscriptionId));
    if (link && link.uid !== userId) {
      throw new AppError('Razorpay subscription ID belongs to another user account', 403, 'FORBIDDEN');
    }

    // 3. Idempotency: this purchase is already the user's active plan
    const current = await SubscriptionRepository.getCurrent(userId);
    if (
      current &&
      current.status === 'ACTIVE' &&
      !current.isTrial &&
      current.providerSubscriptionId === subscriptionId
    ) {
      return { subscription: toSubscriptionDto(current), hasActiveEntitlement: true, isIdempotentRetry: true };
    }

    // 4. The plan bought in this checkout
    if (!link?.planCode) {
      throw new AppError('No checkout found for this payment', 404, 'CHECKOUT_NOT_FOUND');
    }
    const plan = await PlanService.getActivePlan(link.planCode);
    if (!plan) {
      throw new AppError(`Plan '${link.planCode}' not found or inactive`, 404, 'PLAN_NOT_FOUND');
    }

    const activated = await this.startPaidSubscription({
      uid: userId,
      plan,
      providerSubscriptionId: subscriptionId,
      current,
      hasLink: true,
      eventTimestamp: Date.now(),
      paymentId,
    });

    logger.info(`Verified payment ${paymentId} for ${subscriptionId}: ${plan.code} is now ACTIVE for user ${userId}`);
    return { subscription: toSubscriptionDto(activated), hasActiveEntitlement: true, isIdempotentRetry: false };
  }

  /**
   * Makes `plan` the user's active paid subscription after a confirmed payment, replacing the
   * current record (trial, expired, or another plan — kept in subscription history) and allocating
   * the plan's credits, all in one atomic update. A replaced paid plan is cancelled at Razorpay so
   * the user is not billed twice. The record id is derived from the Razorpay subscription, so
   * concurrent events for the same purchase write the same record.
   */
  private static async startPaidSubscription(params: {
    uid: string;
    plan: PlanRecord;
    providerSubscriptionId: string;
    current: SubscriptionRecord | null;
    hasLink: boolean;
    eventTimestamp: number;
    paidCount?: number;
    paymentId?: string;
  }): Promise<SubscriptionRecord> {
    const { uid, plan, providerSubscriptionId, current, hasLink, eventTimestamp, paidCount, paymentId } = params;
    const now = Date.now();
    const periodEnd = now + (plan.billingInterval === 'yearly' ? 365 : 30) * DAY_MS;
    const subscriptionId = `sub_rzp_${hashKey(providerSubscriptionId).slice(0, 24)}`;

    const record: SubscriptionRecord = stripUndefined({
      subscriptionId,
      uid,
      planId: plan.legacyId || plan.code,
      planCodeSnapshot: plan.code,
      planNameSnapshot: plan.name,
      amountSnapshot: plan.amount,
      currencySnapshot: plan.currency,
      billingIntervalSnapshot: plan.billingInterval,
      creditsSnapshot: plan.creditsPerBillingPeriod,
      rateLimitSnapshot: plan.rateLimitPerMinute,
      provider: 'razorpay' as const,
      providerSubscriptionId,
      status: 'ACTIVE' as const,
      isTrial: false,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastEventTimestamp: eventTimestamp,
      providerPaidCount: paidCount,
      lastProviderPaymentId: paymentId,
      createdAt: now,
      updatedAt: now,
    });

    const allocation = await CreditService.buildAllocationUpdates({
      userId: uid,
      subscriptionId,
      allocatedCredits: plan.creditsPerBillingPeriod,
      periodStart: now,
      periodEnd,
      description: `${plan.name} activation (${plan.creditsPerBillingPeriod} credits)`,
      type: 'SUBSCRIPTION_RENEWAL',
    });

    const providerKey = keyForExternalId(providerSubscriptionId);
    const updates: UpdateMap = {
      [paths.subscription(uid)]: record,
      ...allocation.updates,
      [paths.checkoutSession(uid, plan.code)]: null,
    };
    if (hasLink) {
      updates[`${paths.providerSubscription(providerKey)}/status`] = 'ACTIVE';
      updates[`${paths.providerSubscription(providerKey)}/subscriptionId`] = subscriptionId;
      updates[`${paths.providerSubscription(providerKey)}/updatedAt`] = now;
    } else {
      updates[paths.providerSubscription(providerKey)] = {
        uid,
        subscriptionId,
        providerSubscriptionId,
        linkedAt: now,
        planCode: plan.code,
        status: 'ACTIVE',
        updatedAt: now,
      };
    }

    let replacedProviderId: string | undefined;
    if (current && current.subscriptionId !== subscriptionId) {
      updates[paths.subscriptionHistoryEntry(uid, current.subscriptionId)] = stripUndefined({
        ...current,
        status: ENTITLED_STATUSES.includes(current.status) ? 'CANCELLED' : current.status,
        endedAt: current.endedAt ?? now,
        updatedAt: now,
      });
      if (
        !current.isTrial &&
        current.providerSubscriptionId &&
        current.providerSubscriptionId !== providerSubscriptionId
      ) {
        replacedProviderId = current.providerSubscriptionId;
        updates[`${paths.providerSubscription(keyForExternalId(replacedProviderId))}/status`] = 'SUPERSEDED';
      }
    }

    await applyUpdates(updates);

    if (replacedProviderId) {
      await RazorpayService.cancelRazorpaySubscription(replacedProviderId).catch((error: Error) =>
        logger.error(
          `Plan change for user ${uid}: could not cancel replaced Razorpay subscription ${replacedProviderId} — cancel it manually to stop billing: ${error.message}`,
        ),
      );
    }
    await upgradeToPremiumSafely(uid);
    logger.info(
      `Started ${plan.code} for user ${uid} (Razorpay ${providerSubscriptionId}) until ${new Date(periodEnd).toISOString()}`,
    );
    return record;
  }

  /** A renewal charge on the user's current paid plan: new period and a fresh credit allocation. */
  private static async renewPaidSubscription(
    subscription: SubscriptionRecord,
    eventTimestamp: number,
    paymentRef: string,
    paidCount?: number,
    paymentId?: string,
  ): Promise<void> {
    const now = Date.now();
    const durationDays = subscription.billingIntervalSnapshot === 'yearly' ? 365 : 30;
    const newEnd = now + durationDays * DAY_MS;
    const next = withoutField(
      stripUndefined({
        ...subscription,
        status: 'ACTIVE' as const,
        currentPeriodStart: now,
        currentPeriodEnd: newEnd,
        lastEventTimestamp: eventTimestamp,
        providerPaidCount: paidCount ?? subscription.providerPaidCount,
        lastProviderPaymentId: paymentId ?? subscription.lastProviderPaymentId,
        updatedAt: now,
      }),
      'pastDueStartedAt',
    );
    // The period change and the credits commit together.
    const allocation = await CreditService.buildAllocationUpdates({
      userId: subscription.uid,
      subscriptionId: subscription.subscriptionId,
      allocatedCredits: subscription.creditsSnapshot,
      periodStart: now,
      periodEnd: newEnd,
      description: `Renewal credit top-up (${paymentRef})`,
      type: 'SUBSCRIPTION_RENEWAL',
    });
    await applyUpdates({ [paths.subscription(subscription.uid)]: next, ...allocation.updates });
    await upgradeToPremiumSafely(subscription.uid);
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
        const providerKey = keyForExternalId(rzpSubId);
        const link = await SubscriptionRepository.getProviderLink(providerKey);
        const notes: Record<string, unknown> = subEntity?.notes ?? {};
        // The buyer: the checkout link (written for the authenticated user at checkout), else the
        // server-set Razorpay notes of a subscription created before links recorded the plan.
        const uid = link?.uid ?? (typeof notes.userId === 'string' && isSafeKey(notes.userId) ? notes.userId : null);
        const current = uid ? await SubscriptionRepository.getCurrent(uid) : null;
        const isCurrentPaid = Boolean(current && current.providerSubscriptionId === rzpSubId && !current.isTrial);
        const now = Date.now();
        const timestamp = toMs(eventCreatedAt) ?? now;

        // Stale Event Protection (events for the user's current subscription)
        if (
          current &&
          current.providerSubscriptionId === rzpSubId &&
          current.lastEventTimestamp &&
          timestamp < current.lastEventTimestamp
        ) {
          logger.info(`Ignored stale webhook event '${eventType}' for subscription ${current.subscriptionId}`);
          await WebhookRepository.markProcessed(eventKey, now);
          return { success: true, message: 'Stale event ignored', isDuplicate: true };
        }

        if (uid && (eventType === 'subscription.activated' || eventType === 'subscription.charged')) {
          // A confirmed payment: the plan bought in this checkout becomes (or stays) the user's plan
          const planCode =
            link?.planCode ??
            (typeof notes.planCode === 'string' ? notes.planCode : undefined) ??
            (isCurrentPaid ? current!.planCodeSnapshot : undefined);
          const plan = planCode ? await PlanService.getActivePlan(planCode) : null;
          const paidCount = typeof subEntity?.paid_count === 'number' ? subEntity.paid_count : undefined;
          const chargePaymentId: string | undefined = payload.payment?.entity?.id;

          if (!plan) {
            logger.error(`Paid event '${eventType}' for ${rzpSubId}: plan '${planCode}' unknown, not applied`);
          } else if (isCurrentPaid && current!.planCodeSnapshot === plan.code) {
            const alreadyApplied =
              (chargePaymentId !== undefined && current!.lastProviderPaymentId === chargePaymentId) ||
              (paidCount !== undefined &&
                current!.providerPaidCount !== undefined &&
                paidCount <= current!.providerPaidCount);
            if (eventType === 'subscription.charged' && !alreadyApplied) {
              await this.renewPaidSubscription(current!, timestamp, paymentId, paidCount, chargePaymentId);
            } else if (current!.status !== 'ACTIVE') {
              await applyUpdates({
                [paths.subscription(uid)]: withoutField(
                  { ...current!, status: 'ACTIVE' as const, lastEventTimestamp: timestamp, updatedAt: now },
                  'pastDueStartedAt',
                ),
              });
            }
          } else if (link?.status === 'SUPERSEDED' || link?.status === 'CANCELLED') {
            logger.error(
              `Paid event '${eventType}' for ${link.status} Razorpay subscription ${rzpSubId} (user ${uid}): not applied, review manually`,
            );
          } else {
            await this.startPaidSubscription({
              uid,
              plan,
              providerSubscriptionId: rzpSubId,
              current,
              hasLink: Boolean(link),
              eventTimestamp: timestamp,
              paidCount,
              paymentId: chargePaymentId,
            });
          }
        } else if (eventType === 'subscription.authenticated') {
          // The customer approved the mandate; access starts only when the payment is confirmed.
          if (link && !isCurrentPaid) {
            await SubscriptionRepository.updateProviderLink(providerKey, { status: 'AUTHENTICATED', updatedAt: now });
          }
        } else if (eventType === 'subscription.halted' || eventType === 'payment.failed') {
          if (isCurrentPaid) {
            await applyUpdates({
              [paths.subscription(uid!)]: {
                ...current!,
                status: 'PAST_DUE',
                pastDueStartedAt: now,
                lastEventTimestamp: timestamp,
                updatedAt: now,
              },
            });
          } else if (link) {
            // An unpaid checkout failed: the user's current plan is untouched.
            await SubscriptionRepository.updateProviderLink(providerKey, { status: 'FAILED', updatedAt: now });
          }
        } else if (eventType === 'subscription.cancelled') {
          if (isCurrentPaid) {
            const subscription = current!;
            const next: SubscriptionRecord = payload.immediate
              ? { ...subscription, status: 'CANCELLED', endedAt: now, lastEventTimestamp: timestamp, updatedAt: now }
              : {
                  ...subscription,
                  cancelAtPeriodEnd: true,
                  canceledAt: now,
                  lastEventTimestamp: timestamp,
                  updatedAt: now,
                };
            await applyUpdates({ [paths.subscription(uid!)]: next });
          } else if (link && link.status !== 'SUPERSEDED') {
            await SubscriptionRepository.updateProviderLink(providerKey, { status: 'CANCELLED', updatedAt: now });
            if (link.planCode) await SubscriptionRepository.clearCheckoutSession(link.uid, link.planCode);
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
