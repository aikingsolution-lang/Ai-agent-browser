import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';

import { registerSchema, loginSchema } from '../schemas/auth.schema.js';
import { authLoginRateLimiter, authRegisterRateLimiter } from '../middleware/rateLimiter.js';

export const authRouter: Router = Router();

authRouter.post('/register', authRegisterRateLimiter, validate(registerSchema), AuthController.register);

authRouter.post('/login', authLoginRateLimiter, validate(loginSchema), AuthController.login);

authRouter.get('/me', authenticate, AuthController.getMe);

authRouter.post('/logout', AuthController.logout);
