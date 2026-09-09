import { Router, raw } from 'express';
import { WebhookController } from '../controllers/webhook.controller.js';

export const webhookRouter: Router = Router();

// POST /api/v1/webhooks/razorpay
// Uses express.raw() to preserve raw Buffer for HMAC signature verification
webhookRouter.post(
  '/razorpay',
  raw({ type: 'application/json', limit: '1mb' }),
  WebhookController.handleRazorpayWebhook,
);
