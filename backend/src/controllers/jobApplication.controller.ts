import type { Request, Response, NextFunction } from 'express';
import {
  JobApplicationService,
  JOB_APPLICATION_PLATFORMS,
  JOB_APPLICATION_STATUSES,
} from '../services/jobApplication.service.js';
import type { JobApplicationStatus } from '../services/jobApplication.service.js';

/** Single-line text, whitespace collapsed, capped at `max` characters ('' when absent). */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** An absolute http(s) URL, or '' — never a javascript:/data: link the dashboard would render. */
function httpUrl(value: unknown, max: number): string {
  const raw = text(value, max);
  try {
    return /^https?:$/.test(new URL(raw).protocol) ? raw : '';
  } catch {
    return '';
  }
}

/**
 * The job board an application belongs to: the posted platform (lower-cased; anything that isn't a
 * simple id becomes "other"), else the one in the application URL, else LinkedIn (the original
 * default, from when LinkedIn was the only platform).
 */
export function normalizePlatform(platform: unknown, applicationUrl: string): string {
  const posted = text(platform, 64).toLowerCase();
  if (posted) return /^[a-z0-9_-]{1,32}$/.test(posted) ? posted : 'other';
  let host = '';
  try {
    host = new URL(applicationUrl).hostname.toLowerCase();
  } catch {
    // not a URL
  }
  if (host.endsWith('naukri.com')) return 'naukri';
  if (/(^|\.)indeed\./.test(host)) return 'indeed';
  return JOB_APPLICATION_PLATFORMS[0];
}

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
        jobDescription,
        companyWebsite,
        failureReason,
      } = req.body;

      const finalTitle = text(jobTitle || title, 300);
      const finalCompany = text(company, 300);
      const finalUrl = text(applicationUrl, 2000);
      const finalJobId = text(
        jobId || finalUrl || `${finalCompany || 'Unknown Company'}-${finalTitle || 'Unknown Title'}`,
        500,
      );

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
        location: text(location, 300),
        salaryRange: text(salaryRange, 200),
        fitScore: typeof fitScore === 'number' && Number.isFinite(fitScore) ? fitScore : 0,
        platform: normalizePlatform(platform, finalUrl),
        applicationUrl: finalUrl,
        status: finalStatus,
        appliedAt: Number.isFinite(parsedAppliedAt) ? parsedAppliedAt : Date.now(),
        jobDescription: text(jobDescription, 2000),
        companyWebsite: httpUrl(companyWebsite, 500),
        failureReason: text(failureReason, 300),
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
   * GET /api/v1/job-applications/check/:jobId[?platform=naukri|indeed] (LinkedIn when omitted)
   * A FAILED attempt is not an application, so it never blocks a retry.
   */
  static async checkDuplicate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id;
      const jobId = req.params.jobId || req.params.userId;
      const platform = req.query.platform ? normalizePlatform(req.query.platform, '') : undefined;

      const existing = await JobApplicationService.findByJobId(userId, jobId, platform);

      res.status(200).json({
        success: true,
        exists: existing !== null && existing.status !== 'FAILED',
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
