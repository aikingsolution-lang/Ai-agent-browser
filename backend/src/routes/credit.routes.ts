import { Router } from 'express';
import { CreditController } from '../controllers/credit.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { readApiRateLimiter } from '../middleware/rateLimiter.js';

export const creditRouter: Router = Router();

// Require authentication & dedicated read rate limiter for all credit routes
creditRouter.use(authenticate);
creditRouter.use(readApiRateLimiter);

// GET /api/v1/credits/balance
creditRouter.get('/balance', CreditController.getBalance);

// GET /api/v1/credits/history
creditRouter.get('/history', CreditController.getHistory);
