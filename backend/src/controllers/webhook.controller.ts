import { Request, Response, NextFunction } from 'express';
import { SubscriptionLifecycleService } from '../services/subscriptionLifecycle.service.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { AppError } from '../middleware/errorHandler.js';

export class WebhookController {
  /**
   * POST /api/v1/webhooks/razorpay
   * Handles incoming Razorpay server-to-server webhook events.
   * Expects raw request body Buffer for HMAC SHA256 signature verification.
   */
  public static async handleRazorpayWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const signatureHeader = req.headers['x-razorpay-signature'] as string;
      if (!signatureHeader) {
        throw new AppError('Missing x-razorpay-signature header', 401, 'INVALID_SIGNATURE');
      }

      const rawBody = (req as any).rawBody || req.body;
      if (!rawBody || (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string')) {
        throw new AppError('Invalid raw request body for webhook verification', 400, 'BAD_REQUEST');
      }

      let payload: any;
      try {
        const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
        payload = JSON.parse(bodyStr);
      } catch {
        throw new AppError('Invalid JSON payload in webhook body', 400, 'INVALID_PAYLOAD');
      }

      const eventId = payload.event_id || (req.headers['x-razorpay-event-id'] as string) || `evt_mock_${Date.now()}`;
      const eventType = payload.event || 'unknown';

      let providerPaymentId: string | undefined;
      if (payload.payload?.payment?.entity?.id) {
        providerPaymentId = payload.payload.payment.entity.id;
      } else if (payload.payload?.subscription?.entity?.payment_id) {
        providerPaymentId = payload.payload.subscription.entity.payment_id;
      }

      const eventCreatedAt = payload.created_at ? new Date(payload.created_at * 1000) : new Date();

      const result = await SubscriptionLifecycleService.processWebhook({
        eventId,
        eventType,
        providerPaymentId,
        payload: payload.payload || payload,
        rawBody,
        signatureHeader,
        eventCreatedAt,
      });

      sendSuccess(res, null, result.message, 200);
    } catch (error) {
      next(error);
    }
  }
}
