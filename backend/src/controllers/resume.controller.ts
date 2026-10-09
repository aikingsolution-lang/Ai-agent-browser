import type { Request, Response, NextFunction } from 'express';
import { ResumeGeneratorService } from '../services/resumeGenerator.service.js';
import { ResumeParserService } from '../services/resumeParser.service.js';
import { ProfileService } from '../services/profile.service.js';
import { AppError } from '../middleware/errorHandler.js';

export class ResumeController {
  /**
   * Generates a tailored PDF resume.
   * POST /api/v1/resume/generate
   */
  static async generateResume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await ResumeGeneratorService.generateTailoredResume(req.body);

      res.status(200).json({
        success: true,
        message: 'Tailored resume generated successfully.',
        data: {
          fileName: result.fileName,
          fileSize: result.fileSize,
          base64Pdf: result.base64Pdf,
          highlightedKeywords: result.highlightedKeywords,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Uploads and parses raw PDF/DOCX resume, then syncs structured data to the CareerBrain profile (RTDB).
   * POST /api/v1/resume/upload-and-parse
   */
  static async uploadAndParseResume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        throw new AppError('No resume file uploaded. Please attach a PDF or Word document.', 400, 'FILE_REQUIRED');
      }

      // The Firebase uid keys the CareerBrain record (`user.id` only existed on Mongoose documents).
      const userId = req.user?.uid;
      if (!userId) {
        throw new AppError('Authentication required to associate parsed resume with Career Brain', 401, 'UNAUTHORIZED');
      }

      // 1. Extract text and run Bedrock AI parsing
      const parseResult = await ResumeParserService.parseResume(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );

      // 2. Persist to the user's CareerBrain profile
      const updatedCareerBrain = await ProfileService.createOrUpdateFromResume(
        userId,
        parseResult.parsedData,
        parseResult.rawText,
        parseResult.fileName,
      );

      res.status(200).json({
        success: true,
        message: 'Resume parsed and Career Brain profile updated successfully.',
        data: {
          fileName: parseResult.fileName,
          fileSize: parseResult.fileSize,
          parsedData: parseResult.parsedData,
          careerBrain: updatedCareerBrain,
          rawText: parseResult.rawText,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
