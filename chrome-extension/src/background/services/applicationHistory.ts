/**
 * Application history: every application attempt the extension makes on LinkedIn, Naukri or Indeed
 * is reported to the backend (POST /job-applications), which keeps it under the signed-in account.
 * The JobForm Automator dashboard (Automation Hub → Auto Apply) lists it under that platform.
 *
 *   APPLIED              the platform confirmed the submission
 *   NEEDS_MANUAL_REVIEW  the final submit was clicked but its confirmation could not be read
 *   FAILED               the application was started but could not be completed
 *
 * Skipped jobs (already applied, external apply only, low match, closed, captcha) are not
 * applications and are not reported. The backend keeps one record per {account, platform, job} and
 * never downgrades a verified submission, so reporting the same job again is safe.
 *
 * A report that can't reach the backend is queued in chrome.storage.local (one account's data:
 * wiped on an account switch, see ACCOUNT_DATA_STORAGE_KEYS) and retried before the next report,
 * at start-up and every 15 minutes. Reporting never throws, so it can't break an application run.
 */

import { backendApiClient } from '@extension/shared';
import { authStorage, sessionUserId } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('ApplicationHistory');

export const PENDING_APPLICATION_REPORTS_KEY = 'jobform_pending_application_reports';
export const APPLICATION_REPORT_RETRY_ALARM = 'jobform_application_report_retry';
const MAX_QUEUED_REPORTS = 200;
const MAX_QUEUED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ApplicationPlatform = 'linkedin' | 'naukri' | 'indeed';
export type ApplicationOutcome = 'APPLIED' | 'NEEDS_MANUAL_REVIEW' | 'FAILED';

export interface ApplicationReport {
  platform: ApplicationPlatform;
  jobId: string;
  title: string;
  company: string;
  url: string;
  status: ApplicationOutcome;
  location?: string;
  salary?: string;
  description?: string;
  companyWebsite?: string;
  fitScore?: number;
  /** Why a FAILED / NEEDS_MANUAL_REVIEW attempt did not go through. */
  reason?: string;
  /** When the application was submitted or attempted (default: now). */
  at?: number;
}

export type ApplicationPayload = Parameters<typeof backendApiClient.recordJobApplication>[0];

interface QueuedReport {
  uid: string;
  payload: ApplicationPayload;
  queuedAt: number;
}

/**
 * Failure reasons meaning the final submit was clicked but the platform's confirmation could not be
 * read, so the application may have gone through. Sources: DedicatedJobRunner.fillAndSubmitModal
 * (LinkedIn) and NaukriAdapter.applyToJob.
 */
const UNCONFIRMED_SUBMISSION = /clicked but confirmation was not verified|could not be confirmed after clicking/i;

/** Fallback names the runners use when the page gave none; the dashboard shows "Unknown" instead. */
const PLACEHOLDER_NAME =
  /^(linkedin job|loading job\.*|recovered job|company|unknown company|unknown title|n\/a|error|closed tab)$/i;

export function outcomeForFailure(reason: string | undefined): Exclude<ApplicationOutcome, 'APPLIED'> {
  return UNCONFIRMED_SUBMISSION.test(reason || '') ? 'NEEDS_MANUAL_REVIEW' : 'FAILED';
}

function clean(value: string | undefined, max: number): string | undefined {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function name(value: string | undefined): string {
  const text = clean(value, 300) || '';
  return PLACEHOLDER_NAME.test(text) ? '' : text;
}

export function toApplicationPayload(report: ApplicationReport): ApplicationPayload {
  return {
    jobId: String(report.jobId).trim(),
    jobTitle: name(report.title),
    company: name(report.company),
    platform: report.platform,
    applicationUrl: report.url,
    location: clean(report.location, 300),
    salaryRange: clean(report.salary, 200),
    fitScore: report.fitScore,
    status: report.status,
    appliedAt: new Date(report.at ?? Date.now()).toISOString(),
    jobDescription: clean(report.description, 2000),
    companyWebsite: clean(report.companyWebsite, 500),
    failureReason: report.status === 'APPLIED' ? undefined : clean(report.reason, 300),
  };
}

/** Offline, server errors and an expired session are worth retrying; any other 4xx never succeeds. */
function isRetryable(err: any): boolean {
  const status = Number(err?.status) || 0;
  return !status || status === 401 || status === 408 || status === 429 || status >= 500;
}

// Queue updates are read-modify-write on chrome.storage, so reports and retries run one at a time.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

async function currentUid(): Promise<string | null> {
  const session = await authStorage.getSession().catch(() => null);
  return session?.token ? sessionUserId(session.user, session.token) : null;
}

async function readQueue(): Promise<QueuedReport[]> {
  const stored = await chrome.storage.local.get(PENDING_APPLICATION_REPORTS_KEY);
  const list = stored?.[PENDING_APPLICATION_REPORTS_KEY];
  return Array.isArray(list) ? list : [];
}

async function writeQueue(list: QueuedReport[]): Promise<void> {
  await chrome.storage.local.set({ [PENDING_APPLICATION_REPORTS_KEY]: list });
}

async function enqueue(item: QueuedReport): Promise<void> {
  const queue = await readQueue();
  const sameJob = (q: QueuedReport) =>
    q.uid === item.uid && q.payload.platform === item.payload.platform && q.payload.jobId === item.payload.jobId;
  // A queued verified submission is never replaced by a later, lesser outcome for the same job.
  if (queue.find(sameJob)?.payload.status === 'APPLIED' && item.payload.status !== 'APPLIED') return;
  await writeQueue([...queue.filter(q => !sameJob(q)), item].slice(-MAX_QUEUED_REPORTS));
}

/** Sends this account's queued reports, oldest first; stops at the first one the backend can't take now. */
async function flushQueue(uid: string): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) return;
  const now = Date.now();
  const remaining: QueuedReport[] = [];
  let reachable = true;
  for (const item of queue) {
    if (item.uid !== uid || now - item.queuedAt > MAX_QUEUED_AGE_MS) continue; // another account's, or stale
    if (!reachable) {
      remaining.push(item);
      continue;
    }
    try {
      await backendApiClient.recordJobApplication(item.payload);
    } catch (err) {
      if (isRetryable(err)) {
        reachable = false;
        remaining.push(item);
      } else {
        logger.warning(`Dropping queued application report the backend rejected:`, err);
      }
    }
  }
  await writeQueue(remaining);
}

/** Adds one application attempt to the signed-in account's history. Never throws. */
export async function reportApplication(report: ApplicationReport): Promise<void> {
  try {
    const uid = await currentUid();
    if (!uid) {
      logger.warning(`Not signed in: "${report.title}" (${report.platform}) is not added to the application history.`);
      return;
    }
    const payload = toApplicationPayload(report);
    await serialized(async () => {
      await flushQueue(uid);
      if ((await currentUid()) !== uid) return; // the account changed meanwhile
      try {
        await backendApiClient.recordJobApplication(payload);
        logger.info(
          `Application history: ${payload.status} "${payload.jobTitle}" at ${payload.company} (${payload.platform})`,
        );
      } catch (err) {
        if (!isRetryable(err)) {
          logger.warning(`Backend rejected the application report for "${payload.jobTitle}":`, err);
          return;
        }
        logger.warning(`Could not reach the backend; application report for "${payload.jobTitle}" will be retried.`);
        await enqueue({ uid, payload, queuedAt: Date.now() });
      }
    });
  } catch (err) {
    logger.warning('Reporting the application failed (non-blocking):', err);
  }
}

/** Retries queued reports for the signed-in account (start-up and periodic alarm). Never throws. */
export async function retryPendingApplicationReports(): Promise<void> {
  try {
    const uid = await currentUid();
    if (uid) await serialized(() => flushQueue(uid));
  } catch (err) {
    logger.warning('Retrying queued application reports failed:', err);
  }
}
