/**
 * jobApplication.service.ts
 *
 * Job applications, backed by Firebase RTDB (previously the Mongo JobApplication collection, which
 * the controller queried directly).
 *
 *   nanobrowser/job_applications/{uid}/{appId}
 *   nanobrowser/job_application_keys/{uid}/{jobKey} -> appId     unique {userId, platform, jobId}
 *   nanobrowser/job_applications_meta/{uid}/count                  total for pagination
 *
 * Records live under the owner's uid, so one user can never read or update another user's
 * applications (the Mongo version filtered every query by userId).
 *
 * The extension posts one record per application attempt it made: APPLIED for a verified
 * submission, FAILED when it could not complete the form, NEEDS_MANUAL_REVIEW when it submitted but
 * could not confirm the result. A verified submission is final — a later attempt for the same job
 * never downgrades it.
 */

import { JobApplicationRepository } from './rtdb/repositories.js';
import { isSafeKey, newId } from './rtdb/rtdbUtils.js';
import { toJobApplicationDto, type JobApplicationDto } from './rtdb/serializers.js';
import type { JobApplicationRecord, JobApplicationStatus } from './rtdb/records.js';

export { JOB_APPLICATION_STATUSES, JOB_APPLICATION_PLATFORMS } from './rtdb/records.js';
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
  jobDescription?: string;
  companyWebsite?: string;
  failureReason?: string;
}

/** The new value when one was sent, otherwise what the record already had. */
const keep = (incoming: string | undefined, previous: string | undefined): string => incoming || previous || '';

export class JobApplicationService {
  /** Upserts the application for {uid, platform, jobId} (Mongo: findOneAndUpdate with upsert). */
  public static async recordApplication(uid: string, input: RecordApplicationInput): Promise<JobApplicationDto> {
    const now = Date.now();
    const unscopedAppId = await this.findUnscopedAppId(uid, input.jobId, input.platform);
    const { appId, isNew } = unscopedAppId
      ? { appId: unscopedAppId, isNew: false }
      : await JobApplicationRepository.claimJobKey(uid, input.jobId, input.platform, newId('ja'));
    const existing = isNew ? null : await JobApplicationRepository.get(uid, appId);

    if (existing?.status === 'APPLIED' && input.status !== 'APPLIED') {
      return toJobApplicationDto(existing);
    }
    // Re-syncing a submission that was already recorded keeps the time it was first verified.
    const resync = existing?.status === 'APPLIED';

    const record: JobApplicationRecord = {
      appId,
      uid,
      jobId: input.jobId,
      title: keep(input.title, existing?.title) || 'Unknown Title',
      company: keep(input.company, existing?.company) || 'Unknown Company',
      location: keep(input.location, existing?.location),
      salaryRange: keep(input.salaryRange, existing?.salaryRange),
      fitScore: Math.min(100, Math.max(0, input.fitScore || existing?.fitScore || 0)),
      platform: input.platform,
      applicationUrl: keep(input.applicationUrl, existing?.applicationUrl),
      status: input.status,
      appliedAt: resync ? (existing?.appliedAt ?? input.appliedAt) : input.appliedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const jobDescription = keep(input.jobDescription, existing?.jobDescription);
    if (jobDescription) record.jobDescription = jobDescription;
    const companyWebsite = keep(input.companyWebsite, existing?.companyWebsite);
    if (companyWebsite) record.companyWebsite = companyWebsite;
    if (input.status !== 'APPLIED' && input.failureReason) record.failureReason = input.failureReason;

    // Count it as new when this call claimed the job, or when an earlier claim never got its record written.
    await JobApplicationRepository.save(uid, record, isNew || !existing);
    return toJobApplicationDto(record);
  }

  /** The user's application for a jobId on a platform (LinkedIn when not given), or null. */
  public static async findByJobId(uid: string, jobId: string, platform?: string): Promise<JobApplicationDto | null> {
    if (!jobId) return null;
    const appId =
      (await JobApplicationRepository.getAppIdForJob(uid, jobId, platform)) ??
      (platform ? await this.findUnscopedAppId(uid, jobId, platform) : null);
    if (!appId) return null;
    const record = await JobApplicationRepository.get(uid, appId);
    return record ? toJobApplicationDto(record) : null;
  }

  /**
   * Records written before job keys were scoped by platform (and every record the Mongo migration
   * imported) are keyed by the bare job id. Such a record still owns its job when it belongs to the
   * same non-LinkedIn platform, so recording that job again updates it instead of adding a duplicate.
   */
  private static async findUnscopedAppId(uid: string, jobId: string, platform: string): Promise<string | null> {
    if (platform === 'linkedin') return null;
    const appId = await JobApplicationRepository.getAppIdForJob(uid, jobId);
    if (!appId) return null;
    const record = await JobApplicationRepository.get(uid, appId);
    return record?.platform === platform ? appId : null;
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
