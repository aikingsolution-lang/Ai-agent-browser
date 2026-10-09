import type { Request, Response, NextFunction } from 'express';
import { JobApplicationService, JOB_APPLICATION_STATUSES } from '../services/jobApplication.service.js';
import type { JobApplicationStatus } from '../services/jobApplication.service.js';

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

      const finalTitle = String(jobTitle || title || 'Unknown Title').trim();
      const finalCompany = String(company || 'Unknown Company').trim();
      const finalJobId = String(jobId || applicationUrl || `${finalCompany}-${finalTitle}`).trim();

      let finalStatus: JobApplicationStatus = 'APPLIED';
      if (status) {
        const upper = String(status).toUpperCase();
        if (JOB_APPLICATION_STATUSES.includes(upper as JobApplicationStatus)) {
          finalStatus = upper as JobApplicationStatus;
        }
      }

      const parsedAppliedAt = appliedAt ? new Date(appliedAt).getTime() : Date.now();

      const application = await JobApplicationService.recordApplication(userId, {
        jobId: finalJobId,
        title: finalTitle,
        company: finalCompany,
        location: String(location || '').trim(),
        salaryRange: String(salaryRange || '').trim(),
        fitScore: typeof fitScore === 'number' ? fitScore : 0,
        platform: String(platform || 'linkedin').trim(),
        applicationUrl: String(applicationUrl || '').trim(),
        status: finalStatus,
        appliedAt: Number.isFinite(parsedAppliedAt) ? parsedAppliedAt : Date.now(),
      });

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

      const existing = await JobApplicationService.findByJobId(userId, jobId);

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

      const pageNum = parseInt(page as string, 10) || 1;
      const limitNum = parseInt(limit as string, 10) || 50;

      const { items: applications, total } = await JobApplicationService.listApplications(userId, {
        status: status ? String(status) : undefined,
        page: pageNum,
        limit: limitNum,
      });

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

      const validStatus = String(status || '').toUpperCase() as JobApplicationStatus;
      if (!JOB_APPLICATION_STATUSES.includes(validStatus)) {
        res.status(400).json({ success: false, message: `Invalid status: ${status}` });
        return;
      }

      const application = await JobApplicationService.updateStatus(userId, id, validStatus);

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
