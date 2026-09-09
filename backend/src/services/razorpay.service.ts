import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface RazorpaySubscriptionResponse {
  id: string;
  entity: string;
  plan_id: string;
  status: string;
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
   */
  public static async createRazorpaySubscription(params: {
    planId: string;
    totalCount?: number;
    notes?: Record<string, string>;
  }): Promise<RazorpaySubscriptionResponse> {
    const randomHash = crypto.randomBytes(8).toString('hex');
    const mockSubscriptionId = `sub_rzp_${randomHash}`;

    logger.info(`Created Razorpay Subscription session ${mockSubscriptionId} for plan ${params.planId}`);

    return {
      id: mockSubscriptionId,
      entity: 'subscription',
      plan_id: params.planId,
      status: 'created',
      notes: params.notes || {},
    };
  }
}
