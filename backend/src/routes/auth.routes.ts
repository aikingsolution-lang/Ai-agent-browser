import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';

import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  logoutSchema,
  googleAuthSchema,
} from '../schemas/auth.schema.js';
import { authLoginRateLimiter, authRegisterRateLimiter } from '../middleware/rateLimiter.js';

export const authRouter: Router = Router();

authRouter.post('/register', authRegisterRateLimiter, validate(registerSchema), AuthController.register);

authRouter.post('/login', authLoginRateLimiter, validate(loginSchema), AuthController.login);

authRouter.post('/google', authLoginRateLimiter, validate(googleAuthSchema), AuthController.google);

authRouter.post('/refresh', authLoginRateLimiter, validate(refreshTokenSchema), AuthController.refresh);

authRouter.get('/me', authenticate, AuthController.getMe);

authRouter.post('/logout', validate(logoutSchema), AuthController.logout);
