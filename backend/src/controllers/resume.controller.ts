import type { Request, Response, NextFunction } from 'express';
import { ResumeGeneratorService } from '../services/resumeGenerator.service.js';

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
}
