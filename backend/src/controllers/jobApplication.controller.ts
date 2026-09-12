import type { Request, Response, NextFunction } from 'express';
import { JobApplication } from '../models/jobApplication.model.js';

export class JobApplicationController {
  /**
   * Records or updates a job application attempt.
   * POST /api/v1/job-applications
   */
  static async recordApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId, jobId, title, company, location, salaryRange, fitScore, status, appliedAt } = req.body;

      const application = await JobApplication.findOneAndUpdate(
        { userId, jobId },
        {
          userId,
          jobId,
          title,
          company,
          location: location || '',
          salaryRange: salaryRange || '',
          fitScore: fitScore || 0,
          status: status || 'QUEUED',
          appliedAt: appliedAt ? new Date(appliedAt) : null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      res.status(200).json({
        success: true,
        data: application,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Checks if a user has already applied to a specific job.
   * GET /api/v1/job-applications/check/:userId/:jobId
   */
  static async checkDuplicate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId, jobId } = req.params;

      const existing = await JobApplication.findOne({ userId, jobId });

      res.status(200).json({
        success: true,
        exists: Boolean(existing),
        application: existing || null,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Lists job applications for a user.
   * GET /api/v1/job-applications/:userId
   */
  static async listApplications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      const { status, limit = '50', page = '1' } = req.query;

      const query: Record<string, unknown> = { userId };
      if (status) query.status = status;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);

      const [applications, total] = await Promise.all([
        JobApplication.find(query)
          .sort({ updatedAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        JobApplication.countDocuments(query),
      ]);

      res.status(200).json({
        success: true,
        data: applications,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Updates application status (e.g. from PENDING_RESUME_APPROVAL to QUEUED / APPLIED).
   * PATCH /api/v1/job-applications/:id/status
   */
  static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const application = await JobApplication.findByIdAndUpdate(id, { status }, { new: true });

      if (!application) {
        res.status(404).json({ success: false, message: 'Application not found.' });
        return;
      }

      res.status(200).json({
        success: true,
        data: application,
      });
    } catch (error) {
      next(error);
    }
  }
}
