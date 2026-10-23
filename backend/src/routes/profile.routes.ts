import { Router } from 'express';
import { ProfileController } from '../controllers/profile.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { applicationSlotSchema } from '../schemas/quota.schema.js';

export const profileRouter: Router = Router();

// All profile endpoints are strictly authenticated
profileRouter.use(authenticate);

// Profile CRUD / Sync
profileRouter.get('/', ProfileController.getProfile);
profileRouter.put('/', ProfileController.syncProfile);

// Server-side Quota endpoints
profileRouter.get('/quota', ProfileController.getQuota);
profileRouter.post('/quota/check-and-increment', ProfileController.checkAndIncrementQuota);
profileRouter.post('/quota/reserve', validate(applicationSlotSchema), ProfileController.reserveApplication);
profileRouter.post('/quota/commit', validate(applicationSlotSchema), ProfileController.commitApplication);
profileRouter.post('/quota/release', validate(applicationSlotSchema), ProfileController.releaseApplication);
