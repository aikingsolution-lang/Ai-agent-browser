import { Router } from 'express';
import { JobApplicationController } from '../controllers/jobApplication.controller.js';

export const jobApplicationRouter: Router = Router();

jobApplicationRouter.post('/', JobApplicationController.recordApplication);
jobApplicationRouter.get('/check/:userId/:jobId', JobApplicationController.checkDuplicate);
jobApplicationRouter.get('/:userId', JobApplicationController.listApplications);
jobApplicationRouter.patch('/:id/status', JobApplicationController.updateStatus);
