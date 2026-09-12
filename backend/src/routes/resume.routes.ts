import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { generateResumeSchema } from '../schemas/resume.schema.js';
import { ResumeController } from '../controllers/resume.controller.js';

export const resumeRouter: Router = Router();

resumeRouter.post('/generate', validate(generateResumeSchema), ResumeController.generateResume);
