/**
 * Daily application quota — client side of the backend's ApplicationQuotaService.
 *
 * The backend counts successful applications per account and UTC day and enforces the limit
 * (free 10/day, Premium/Diamond 300, paid plans their own). Every submission path:
 *   1. reserveApplication(jobKey) before submitting — refused when the limit is reached;
 *   2. commitApplication(jobKey) after a verified submission — counted once per job and day;
 *   3. releaseApplication(jobKey) when nothing was submitted (or the next job is reserved).
 * Anything the backend cannot confirm is treated as "not allowed" (fail closed). The local copy in
 * chrome.storage is for display only.
 */

import { authStorage, dailyQuotaStore, sessionUserId, type DailyQuotaData } from '@extension/storage';
import { backendApiClient, type ApplicationQuota } from '@extension/shared';
import { createLogger } from '@src/background/log';

const logger = createLogger('DailyQuota');

export type { DailyQuotaData };

export interface QuotaCheck {
  allowed: boolean;
  remaining: number;
  currentCount: number;
  maxQuota: number;
  reason?: 'quota_exceeded' | 'error';
  resetsAt?: string;
  isPaid?: boolean;
  /** The job was already counted today, so this attempt uses no new slot. */
  alreadyCounted?: boolean;
}

export const DAILY_RESUME_ALARM_NAME = 'linkedin_daily_quota_resume';

/** Commits that could not reach the backend, retried on the next quota call (cleared on account switch). */
const PENDING_COMMITS_KEY = 'linkedin_pending_quota_commits';

interface PendingCommit {
  jobKey: string;
  uid: string | null;
}

/**
 * Stable key for one job application, the same for reserve and commit: "<platform>:<job id>".
 * The platform comes from the job URL when not given; without a job id the URL itself is used.
 */
export function applicationKey(jobId: string | number | null | undefined, url?: string, platform?: string): string {
  let host = '';
  let path = '';
  try {
    if (url) {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
      path = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    }
  } catch {
    // keep the raw url below
  }
  const source =
    platform ||
    (host.endsWith('linkedin.com')
      ? 'linkedin'
      : host.endsWith('naukri.com')
        ? 'naukri'
        : host.includes('indeed.')
          ? 'indeed'
          : 'external');
  const id = jobId !== null && jobId !== undefined && String(jobId).trim() ? String(jobId).trim() : path || url || '';
  return `${source}:${id || `unknown-${Date.now()}`}`;
}

/** User-facing message for a refused quota check. */
export function quotaStopMessage(check: QuotaCheck): string {
  if (check.reason === 'error') {
    return "Couldn't verify your daily application limit with the server. Check your connection and try again.";
  }
  const reset = check.resetsAt ? new Date(check.resetsAt).toLocaleString() : 'tomorrow';
  const upgrade = check.isPaid ? '' : ' Upgrade to Premium on jobformautomator.com for up to 300 applications a day.';
  return `Daily application limit reached (${check.currentCount}/${check.maxQuota}). It resets at ${reset}.${upgrade}`;
}

export class DailyQuotaManager {
  /** The slot each runner currently holds (one job at a time per runner). */
  private static held = new Map<string, string>();

  /** Last known quota (display copy). */
  static getQuotaData(): Promise<DailyQuotaData> {
    return dailyQuotaStore.getQuotaData();
  }

  /** Whether a new application can start now, according to the backend. */
  static async canApplyToday(): Promise<QuotaCheck> {
    try {
      await this.flushPendingCommits();
      const quota = await backendApiClient.getProfileQuota();
      if (!quota) return await this.unavailable();
      await this.remember(quota);
      return this.toCheck(quota, quota.remaining > 0);
    } catch (err) {
      logger.error('Quota check failed, not allowing new applications:', err);
      return this.unavailable();
    }
  }

  /**
   * Holds a slot for `jobKey` before submitting. `owner` names the runner: its previous
   * uncommitted slot is released first, so skipped or failed jobs never keep a slot.
   */
  static async reserveApplication(jobKey: string, owner: string): Promise<QuotaCheck> {
    try {
      await this.flushPendingCommits();
      const previous = this.held.get(owner);
      if (previous && previous !== jobKey) {
        this.held.delete(owner);
        await backendApiClient.releaseApplicationSlot(previous);
      }

      const slot = await backendApiClient.reserveApplicationSlot(jobKey);
      if (slot.quota) await this.remember(slot.quota);

      switch (slot.status) {
        case 'granted':
          this.held.set(owner, jobKey);
          return this.toCheck(slot.quota, true);
        case 'already_counted':
          return { ...this.toCheck(slot.quota, true), alreadyCounted: true };
        case 'limit_reached':
          if (slot.quota) await this.scheduleResumeAlarm(slot.quota.resetsAt);
          return { ...this.toCheck(slot.quota, false), reason: 'quota_exceeded' };
        default:
          logger.warning(`Could not reserve an application slot for ${jobKey}: ${slot.message ?? 'unavailable'}`);
          return this.unavailable();
      }
    } catch (err) {
      logger.error('Reserving an application slot failed:', err);
      return this.unavailable();
    }
  }

  /** Records a verified submission. Never throws; an unreachable backend gets the commit later. */
  static async commitApplication(jobKey: string): Promise<void> {
    this.forget(jobKey);
    try {
      const { counted, quota } = await backendApiClient.commitApplicationSlot(jobKey);
      await this.remember(quota);
      logger.info(`Application ${counted ? 'counted' : 'already counted'}: ${quota.applied}/${quota.limit} today`);
      if (quota.remaining <= 0) await this.scheduleResumeAlarm(quota.resetsAt);
    } catch (err) {
      logger.warning(`Could not record application ${jobKey}; will retry:`, err);
      await this.queuePendingCommit(jobKey);
    }
  }

  /** Frees the slot of an application that was not submitted (best effort; slots also expire). */
  static async releaseApplication(jobKey: string): Promise<void> {
    this.forget(jobKey);
    const quota = await backendApiClient.releaseApplicationSlot(jobKey);
    if (quota) await this.remember(quota);
  }

  /** Frees the slot held by a runner that stopped. */
  static async releaseOwner(owner: string): Promise<void> {
    const jobKey = this.held.get(owner);
    if (jobKey) await this.releaseApplication(jobKey);
  }

  private static forget(jobKey: string): void {
    for (const [owner, key] of this.held) if (key === jobKey) this.held.delete(owner);
  }

  private static toCheck(quota: ApplicationQuota | null, allowed: boolean): QuotaCheck {
    return {
      allowed,
      remaining: quota?.remaining ?? 0,
      currentCount: quota?.applied ?? 0,
      maxQuota: quota?.limit ?? 0,
      resetsAt: quota?.resetsAt,
      isPaid: quota?.isPaid,
      reason: allowed ? undefined : 'quota_exceeded',
    };
  }

  private static async unavailable(): Promise<QuotaCheck> {
    const cached = await dailyQuotaStore.getQuotaData().catch(() => null);
    return {
      allowed: false,
      reason: 'error',
      remaining: 0,
      currentCount: cached?.appliedCount ?? 0,
      maxQuota: cached?.maxDailyQuota ?? 0,
      resetsAt: cached?.resetsAt,
      isPaid: cached?.isPaid,
    };
  }

  private static async remember(quota: ApplicationQuota): Promise<void> {
    await dailyQuotaStore.applyServerQuota(quota).catch(() => undefined);
  }

  private static async currentUid(): Promise<string | null> {
    const session = await authStorage.getSession().catch(() => null);
    return sessionUserId(session?.user) ?? null;
  }

  private static async queuePendingCommit(jobKey: string): Promise<void> {
    const stored = await chrome.storage.local.get(PENDING_COMMITS_KEY);
    const list: PendingCommit[] = Array.isArray(stored?.[PENDING_COMMITS_KEY]) ? stored[PENDING_COMMITS_KEY] : [];
    if (!list.some(item => item.jobKey === jobKey)) list.push({ jobKey, uid: await this.currentUid() });
    await chrome.storage.local.set({ [PENDING_COMMITS_KEY]: list });
  }

  private static async flushPendingCommits(): Promise<void> {
    const stored = await chrome.storage.local.get(PENDING_COMMITS_KEY).catch(() => null);
    const list: PendingCommit[] = Array.isArray(stored?.[PENDING_COMMITS_KEY]) ? stored![PENDING_COMMITS_KEY] : [];
    if (list.length === 0) return;
    const uid = await this.currentUid();
    const remaining: PendingCommit[] = [];
    for (const item of list) {
      if (item.uid && item.uid !== uid) continue; // belongs to another account: never count it here
      try {
        const { quota } = await backendApiClient.commitApplicationSlot(item.jobKey);
        await this.remember(quota);
      } catch {
        remaining.push(item);
      }
    }
    await chrome.storage.local.set({ [PENDING_COMMITS_KEY]: remaining });
  }

  private static async scheduleResumeAlarm(resetsAt: string): Promise<void> {
    const when = Date.parse(resetsAt);
    if (!Number.isFinite(when) || typeof chrome === 'undefined' || !chrome.alarms) return;
    try {
      await chrome.alarms.create(DAILY_RESUME_ALARM_NAME, { when: when + 60_000 });
    } catch (err) {
      logger.warning('Failed to schedule the daily quota reset alarm:', err);
    }
  }
}
