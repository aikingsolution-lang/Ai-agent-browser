import { Router } from 'express';
import { validate } from '../middleware/validate.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { uploadResume } from '../middleware/upload.middleware.js';
import { generateResumeSchema } from '../schemas/resume.schema.js';
import { ResumeController } from '../controllers/resume.controller.js';

export const resumeRouter: Router = Router();

// Generation of tailored resumes
resumeRouter.post('/generate', validate(generateResumeSchema), ResumeController.generateResume);

// Upload & Parse raw resume (PDF/DOCX) and sync to the user's CareerBrain profile
resumeRouter.post(
  '/upload-and-parse',
  authenticate,
  uploadResume.single('resume'),
  ResumeController.uploadAndParseResume,
);
