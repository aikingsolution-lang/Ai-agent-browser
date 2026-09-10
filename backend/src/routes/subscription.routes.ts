import { Router } from 'express';
import { SubscriptionController } from '../controllers/subscription.controller.js';
import { CheckoutController } from '../controllers/checkout.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export const subscriptionRouter: Router = Router();

// GET /api/v1/subscription/me (requires authentication, accessible even when trial is expired)
subscriptionRouter.get('/me', authenticate, SubscriptionController.getMySubscription);

// GET /api/v1/subscription/plans (public endpoint)
subscriptionRouter.get('/plans', SubscriptionController.getPlans);

// POST /api/v1/subscription/checkout (requires authentication)
subscriptionRouter.post('/checkout', authenticate, CheckoutController.checkout);

// POST /api/v1/subscription/verify-payment (requires authentication)
subscriptionRouter.post('/verify-payment', authenticate, CheckoutController.verifyPayment);

// POST /api/v1/subscription/trial/activate (requires authentication)
subscriptionRouter.post('/trial/activate', authenticate, SubscriptionController.activateFreeTrial);

// POST /api/v1/subscription/cancel (requires authentication)
subscriptionRouter.post('/cancel', authenticate, CheckoutController.cancel);
