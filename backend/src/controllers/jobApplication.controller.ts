import type { Request, Response, NextFunction } from 'express';
import { JobApplication, JOB_APPLICATION_STATUSES } from '../models/jobApplication.model.js';

export class JobApplicationController {
  /**
   * Records or updates a job application attempt.
   * POST /api/v1/job-applications
   */
  static async recordApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id;
      const {
        jobId,
        title,
        jobTitle,
        company,
        location,
        salaryRange,
        fitScore,
        status,
        appliedAt,
        platform,
        applicationUrl,
      } = req.body;

      const finalTitle = (jobTitle || title || 'Unknown Title').trim();
      const finalCompany = (company || 'Unknown Company').trim();
      const finalJobId = String(jobId || applicationUrl || `${finalCompany}-${finalTitle}`).trim();

      let finalStatus: any = 'APPLIED';
      if (status) {
        const upper = String(status).toUpperCase();
        if (JOB_APPLICATION_STATUSES.includes(upper as any)) {
          finalStatus = upper;
        }
      }

      const application = await JobApplication.findOneAndUpdate(
        { userId, jobId: finalJobId },
        {
          userId,
          jobId: finalJobId,
          title: finalTitle,
          company: finalCompany,
          location: location || '',
          salaryRange: salaryRange || '',
          fitScore: typeof fitScore === 'number' ? fitScore : 0,
          platform: platform || 'linkedin',
          applicationUrl: applicationUrl || '',
          status: finalStatus,
          appliedAt: appliedAt ? new Date(appliedAt) : new Date(),
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
   * GET /api/v1/job-applications/check/:jobId
   */
  static async checkDuplicate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id;
      const jobId = req.params.jobId || req.params.userId;

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
   * GET /api/v1/job-applications
   */
  static async listApplications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id;
      const { status, limit = '50', page = '1' } = req.query;

      const query: Record<string, unknown> = { userId };
      if (status) query.status = status;

      const pageNum = parseInt(page as string, 10) || 1;
      const limitNum = parseInt(limit as string, 10) || 50;

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
   * Updates application status.
   * PATCH /api/v1/job-applications/:id/status
   */
  static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id;
      const { id } = req.params;
      const { status } = req.body;

      const application = await JobApplication.findOneAndUpdate({ _id: id, userId }, { status }, { new: true });

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
