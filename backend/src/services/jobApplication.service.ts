/**
 * jobApplication.service.ts
 *
 * Job applications, backed by Firebase RTDB (previously the Mongo JobApplication collection, which
 * the controller queried directly).
 *
 *   nanobrowser/job_applications/{uid}/{appId}
 *   nanobrowser/job_application_keys/{uid}/{sha256(jobId)} -> appId   unique {userId, jobId}
 *   nanobrowser/job_applications_meta/{uid}/count                      total for pagination
 *
 * Records live under the owner's uid, so one user can never read or update another user's
 * applications (the Mongo version filtered every query by userId).
 */

import { JobApplicationRepository } from './rtdb/repositories.js';
import { isSafeKey, newId } from './rtdb/rtdbUtils.js';
import { toJobApplicationDto, type JobApplicationDto } from './rtdb/serializers.js';
import type { JobApplicationRecord, JobApplicationStatus } from './rtdb/records.js';

export { JOB_APPLICATION_STATUSES } from './rtdb/records.js';
export type { JobApplicationStatus } from './rtdb/records.js';

export interface RecordApplicationInput {
  jobId: string;
  title: string;
  company: string;
  location: string;
  salaryRange: string;
  fitScore: number;
  platform: string;
  applicationUrl: string;
  status: JobApplicationStatus;
  appliedAt: number;
}

export class JobApplicationService {
  /** Upserts the application for {uid, jobId} (Mongo: findOneAndUpdate with upsert). */
  public static async recordApplication(uid: string, input: RecordApplicationInput): Promise<JobApplicationDto> {
    const now = Date.now();
    const { appId, isNew } = await JobApplicationRepository.claimJobKey(uid, input.jobId, newId('ja'));
    const existing = isNew ? null : await JobApplicationRepository.get(uid, appId);

    const record: JobApplicationRecord = {
      appId,
      uid,
      jobId: input.jobId,
      title: input.title,
      company: input.company,
      location: input.location,
      salaryRange: input.salaryRange,
      fitScore: Math.min(100, Math.max(0, input.fitScore)),
      platform: input.platform,
      applicationUrl: input.applicationUrl,
      status: input.status,
      appliedAt: input.appliedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // Count it as new when this call claimed the job, or when an earlier claim never got its record written.
    await JobApplicationRepository.save(uid, record, isNew || !existing);
    return toJobApplicationDto(record);
  }

  /** The user's application for a jobId, or null. */
  public static async findByJobId(uid: string, jobId: string): Promise<JobApplicationDto | null> {
    if (!jobId) return null;
    const appId = await JobApplicationRepository.getAppIdForJob(uid, jobId);
    if (!appId) return null;
    const record = await JobApplicationRepository.get(uid, appId);
    return record ? toJobApplicationDto(record) : null;
  }

  /** Newest-updated first, optionally filtered by exact status. */
  public static async listApplications(
    uid: string,
    options: { status?: string; page: number; limit: number },
  ): Promise<{ items: JobApplicationDto[]; total: number }> {
    const { status, page, limit } = options;
    const result = status
      ? await JobApplicationRepository.listByStatus(uid, status, page, limit)
      : await JobApplicationRepository.list(uid, page, limit);
    return { items: result.items.map(toJobApplicationDto), total: result.total };
  }

  /** Updates the status of one of the user's applications. Returns null if it doesn't exist. */
  public static async updateStatus(uid: string, appId: string, status: string): Promise<JobApplicationDto | null> {
    if (!isSafeKey(appId)) return null;
    const existing = await JobApplicationRepository.get(uid, appId);
    if (!existing) return null;
    const fields = { status: status as JobApplicationStatus, updatedAt: Date.now() };
    await JobApplicationRepository.patch(uid, appId, fields);
    return toJobApplicationDto({ ...existing, ...fields });
  }
}
