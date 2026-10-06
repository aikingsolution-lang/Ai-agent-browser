import { Router } from 'express';
import { JobApplicationController } from '../controllers/jobApplication.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export const jobApplicationRouter: Router = Router();

// Protect all routes with JWT authentication
jobApplicationRouter.use(authenticate);

jobApplicationRouter.post('/', JobApplicationController.recordApplication);
jobApplicationRouter.get('/check/:jobId', JobApplicationController.checkDuplicate);
jobApplicationRouter.get('/check/:userId/:jobId', JobApplicationController.checkDuplicate);
jobApplicationRouter.get('/', JobApplicationController.listApplications);
jobApplicationRouter.get('/:userId', JobApplicationController.listApplications);
jobApplicationRouter.patch('/:id/status', JobApplicationController.updateStatus);
