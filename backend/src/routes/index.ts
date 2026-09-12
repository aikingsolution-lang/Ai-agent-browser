import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { authRouter } from './auth.routes.js';
import { subscriptionRouter } from './subscription.routes.js';
import { creditRouter } from './credit.routes.js';
import { webhookRouter } from './webhook.routes.js';
import { llmRouter } from './llm.routes.js';
import { resumeRouter } from './resume.routes.js';
import { jobApplicationRouter } from './jobApplication.routes.js';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { checkEntitlement } from '../middleware/entitlement.middleware.js';
import { checkCredits } from '../middleware/credit.middleware.js';

export const v1Router: Router = Router();

// Mount routes under /api/v1
v1Router.use('/', healthRouter);
v1Router.use('/auth', authRouter);
v1Router.use('/subscription', subscriptionRouter);
v1Router.use('/credits', creditRouter);
v1Router.use('/webhooks', webhookRouter);
v1Router.use('/llm', llmRouter);
v1Router.use('/resume', resumeRouter);
v1Router.use('/job-applications', jobApplicationRouter);

// Test harness endpoints for entitlement verification tests
if (env.NODE_ENV === 'test') {
  v1Router.get('/test-protected-feature', authenticate, checkEntitlement, (_req, res) => {
    res.status(200).json({ success: true, message: 'Access granted to premium feature' });
  });
  v1Router.get('/test-entitled-feature', authenticate, checkEntitlement, (_req, res) => {
    res.status(200).json({ success: true, message: 'Access granted' });
  });
  v1Router.get('/test-metered-feature', authenticate, checkCredits(5), (_req, res) => {
    res.status(200).json({ success: true, message: 'Access granted to metered feature' });
  });
}
