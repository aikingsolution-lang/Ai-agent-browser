import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { authRouter } from './auth.routes.js';
import { subscriptionRouter } from './subscription.routes.js';
import { creditRouter } from './credit.routes.js';
import { webhookRouter } from './webhook.routes.js';
import { llmRouter } from './llm.routes.js';

export const v1Router: Router = Router();

// Mount routes under /api/v1
v1Router.use('/', healthRouter);
v1Router.use('/auth', authRouter);
v1Router.use('/subscription', subscriptionRouter);
v1Router.use('/credits', creditRouter);
v1Router.use('/webhooks', webhookRouter);
v1Router.use('/llm', llmRouter);
