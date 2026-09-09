import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface RazorpaySubscriptionResponse {
  id: string;
  entity: string;
  plan_id: string;
  status: string;
  short_url?: string;
  current_start?: number;
  current_end?: number;
  charge_at?: number;
  notes?: Record<string, any>;
}

export class RazorpayService {
  /**
   * Verifies the HMAC SHA256 signature returned by Razorpay checkout on frontend/extension.
   * Signature string format: razorpay_payment_id + '|' + razorpay_subscription_id
   */
  public static verifyCheckoutSignature(paymentId: string, subscriptionId: string, signature: string): boolean {
    if (!paymentId || !subscriptionId || !signature) {
      return false;
    }

    try {
      const body = `${paymentId}|${subscriptionId}`;
      const expectedSignature = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

      const expectedBuf = Buffer.from(expectedSignature, 'utf8');
      const receivedBuf = Buffer.from(signature, 'utf8');

      if (expectedBuf.length !== receivedBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch (error: any) {
      logger.error(`Error verifying checkout signature: ${error.message}`);
      return false;
    }
  }

  /**
   * Verifies the HMAC SHA256 signature on incoming Razorpay server-to-server webhook requests.
   * Computed over the EXACT raw HTTP request body Buffer.
   */
  public static verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string): boolean {
    if (!rawBody || !signatureHeader) {
      return false;
    }

    try {
      const expectedSignature = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

      const expectedBuf = Buffer.from(expectedSignature, 'utf8');
      const receivedBuf = Buffer.from(signatureHeader, 'utf8');

      if (expectedBuf.length !== receivedBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch (error: any) {
      logger.error(`Error verifying webhook signature: ${error.message}`);
      return false;
    }
  }

  /**
   * Creates a Razorpay Subscription session.
   * Calls real Razorpay API when valid keys are configured, or falls back to mock session for test runner.
   */
  public static async createRazorpaySubscription(params: {
    planId: string;
    totalCount?: number;
    notes?: Record<string, string>;
  }): Promise<RazorpaySubscriptionResponse> {
    const isMockKey =
      !env.RAZORPAY_KEY_ID ||
      !env.RAZORPAY_KEY_SECRET ||
      env.RAZORPAY_KEY_ID.includes('placeholder') ||
      env.RAZORPAY_KEY_ID.includes('mock') ||
      env.RAZORPAY_KEY_ID.includes('test_key_id') ||
      params.planId.startsWith('plan_rzp_mock_');

    if (isMockKey || env.NODE_ENV === 'test') {
      const randomHash = crypto.randomBytes(8).toString('hex');
      const mockSubscriptionId = `sub_rzp_${randomHash}`;

      logger.info(`[Mock Mode] Created Razorpay Subscription session ${mockSubscriptionId} for plan ${params.planId}`);

      return {
        id: mockSubscriptionId,
        entity: 'subscription',
        plan_id: params.planId,
        status: 'created',
        notes: params.notes || {},
      };
    }

    // Real Razorpay API HTTP Request
    try {
      const authHeader = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
      const response = await fetch('https://api.razorpay.com/v1/subscriptions', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan_id: params.planId,
          total_count: params.totalCount || 12,
          quantity: 1,
          customer_notify: 1,
          notes: params.notes || {},
        }),
      });

      const data = (await response.json()) as Record<string, any>;

      if (!response.ok) {
        const errorMsg = data?.error?.description || `Razorpay API returned HTTP ${response.status}`;
        logger.error(`Razorpay API subscription creation failed: ${errorMsg}`);

        // Fallback for dev mode if plan_id is not registered on Razorpay Dashboard yet
        if (env.NODE_ENV !== 'production') {
          const randomHash = crypto.randomBytes(8).toString('hex');
          const mockSubscriptionId = `sub_rzp_${randomHash}`;
          logger.warn(
            `Fallback to mock subscription session ${mockSubscriptionId} due to Razorpay API error: ${errorMsg}. Create plan '${params.planId}' on Razorpay Dashboard to use real subscription links.`,
          );
          return {
            id: mockSubscriptionId,
            entity: 'subscription',
            plan_id: params.planId,
            status: 'created',
            notes: params.notes || {},
          };
        }

        throw new Error(errorMsg);
      }

      logger.info(
        `[Real Razorpay API] Created subscription ${data.id} (URL: ${data.short_url}) for plan ${params.planId}`,
      );

      return {
        id: data.id,
        entity: data.entity || 'subscription',
        plan_id: data.plan_id || params.planId,
        status: data.status || 'created',
        short_url: data.short_url,
        charge_at: data.charge_at,
        notes: data.notes || params.notes || {},
      };
    } catch (error: any) {
      logger.error(`Error invoking Razorpay API: ${error.message}`);
      if (env.NODE_ENV !== 'production') {
        const randomHash = crypto.randomBytes(8).toString('hex');
        const mockSubscriptionId = `sub_rzp_${randomHash}`;
        logger.warn(`Fallback to mock subscription session ${mockSubscriptionId}`);
        return {
          id: mockSubscriptionId,
          entity: 'subscription',
          plan_id: params.planId,
          status: 'created',
          notes: params.notes || {},
        };
      }
      throw error;
    }
  }
}
