import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { checkEntitlement } from '../middleware/entitlement.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { llmRateLimiter } from '../middleware/rateLimiter.js';
import { llmChatCompletionSchema } from '../schemas/llm.schema.js';
import { LlmController } from '../controllers/llm.controller.js';

export const llmRouter: Router = Router();

const chatHandlers = [
  authenticate,
  checkEntitlement,
  llmRateLimiter,
  validate(llmChatCompletionSchema),
  LlmController.chatCompletion,
];

llmRouter.post('/chat', ...chatHandlers);
llmRouter.post('/chat/completions', ...chatHandlers);

llmRouter.get('/usage', authenticate, LlmController.getUsageHistory);
