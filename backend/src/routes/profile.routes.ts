import { Router } from 'express';
import { ProfileController } from '../controllers/profile.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export const profileRouter: Router = Router();

// All profile endpoints are strictly authenticated
profileRouter.use(authenticate);

// Profile CRUD / Sync
profileRouter.get('/', ProfileController.getProfile);
profileRouter.put('/', ProfileController.syncProfile);

// Server-side Quota endpoints
profileRouter.get('/quota', ProfileController.getQuota);
profileRouter.post('/quota/check-and-increment', ProfileController.checkAndIncrementQuota);
