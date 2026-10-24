import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

/**
 * Local copy of the daily application quota, for display only. The backend counts applications
 * and enforces the limit (GET /profile/quota, reserve/commit/release); nothing stored here can
 * allow an application, so clearing or editing it changes nothing but what is shown.
 */
export interface DailyQuotaData {
  /** UTC day (YYYY-MM-DD) the counters belong to. */
  dateString: string;
  appliedCount: number;
  maxDailyQuota: number;
  isPausedDueToQuota: boolean;
  nextResumeTimestamp: number | null;
  activePlanCode?: string;
  remaining?: number;
  reservedCount?: number;
  isPaid?: boolean;
  /** ISO time of the next reset (next UTC midnight). */
  resetsAt?: string;
  /** When this copy was last refreshed from the backend (ms). */
  syncedAt?: number;
  /** Account the backend returned these numbers for. */
  uid?: string | null;
}

/** Fields of the backend quota response used by the display copy. */
export interface ServerQuotaSnapshot {
  day: string;
  applied: number;
  reserved: number;
  limit: number;
  remaining: number;
  plan: string;
  isPaid: boolean;
  resetsAt: string;
}

const utcToday = (now = Date.now()) => new Date(now).toISOString().split('T')[0];
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Validates a backend quota response. Anything incomplete or malformed (for example the older
 * backend's response, which has no plan, day or limit fields) is rejected, so it is never shown
 * or used as if it were verified.
 */
export function parseServerQuota(raw: unknown): ServerQuotaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(q.day)) return null;
  if (!isCount(q.applied) || !isCount(q.reserved) || !isCount(q.remaining)) return null;
  if (!isCount(q.limit) || q.limit === 0) return null;
  if (typeof q.plan !== 'string' || !q.plan.trim()) return null;
  if (typeof q.isPaid !== 'boolean') return null;
  if (typeof q.resetsAt !== 'string' || Number.isNaN(Date.parse(q.resetsAt))) return null;
  return {
    day: q.day,
    applied: q.applied,
    reserved: q.reserved,
    limit: q.limit,
    remaining: q.remaining,
    plan: q.plan.trim().toLowerCase(),
    isPaid: q.isPaid,
    resetsAt: q.resetsAt,
  };
}

/** What the UI may show about the daily quota. */
export type QuotaDisplay =
  | {
      /** Not verified for this account and day (not loaded yet, stale, or the backend failed). */
      status: 'unverified';
    }
  | {
      status: 'ready';
      used: number;
      limit: number;
      remaining: number;
      plan: string;
      isPaid: boolean;
      exhausted: boolean;
      resetsAt: string | null;
    };

const PREMIUM_PLANS = new Set(['premium', 'diamond']);

/**
 * Numbers to show for the signed-in account. The stored copy is used only if the backend returned
 * it for this account and today (UTC). If the verified JobForm Automator Premium status
 * (`premiumActive`, checked by the backend at `premiumCheckedAt`) is newer than the copy and
 * disagrees with its plan, the copy is stale: a Premium account is never shown as FREE, and an
 * ended Premium is not kept. Counts are clamped: never negative, never more used than the limit.
 */
export function getQuotaDisplay(
  data: DailyQuotaData | null | undefined,
  options: { uid: string | null | undefined; premiumActive?: boolean; premiumCheckedAt?: number; now?: number },
): QuotaDisplay {
  const { uid, premiumActive, premiumCheckedAt, now = Date.now() } = options;
  if (!uid || !data || data.uid !== uid || !data.syncedAt) return { status: 'unverified' };
  if (data.dateString !== utcToday(now)) return { status: 'unverified' };

  const limit = data.maxDailyQuota;
  if (!isCount(limit) || limit === 0 || !isCount(data.appliedCount)) return { status: 'unverified' };
  const plan = (data.activePlanCode || '').toLowerCase();
  if (!plan) return { status: 'unverified' };
  const isPaid = data.isPaid === true;
  const premiumIsNewer = premiumCheckedAt === undefined || !(premiumCheckedAt < data.syncedAt);
  if (premiumIsNewer && premiumActive === true && !isPaid) return { status: 'unverified' };
  if (premiumIsNewer && premiumActive === false && PREMIUM_PLANS.has(plan)) return { status: 'unverified' };

  const used = Math.min(data.appliedCount, limit);
  const reserved = isCount(data.reservedCount) ? data.reservedCount : 0;
  const remaining = Math.max(0, Math.min(isCount(data.remaining) ? data.remaining : limit, limit - used - reserved));
  return {
    status: 'ready',
    used,
    limit,
    remaining,
    plan,
    isPaid,
    exhausted: remaining === 0,
    resetsAt: data.resetsAt && !Number.isNaN(Date.parse(data.resetsAt)) ? data.resetsAt : null,
  };
}

export const DEFAULT_DAILY_QUOTA: DailyQuotaData = {
  dateString: utcToday(),
  appliedCount: 0,
  maxDailyQuota: 10,
  isPausedDueToQuota: false,
  nextResumeTimestamp: null,
  activePlanCode: 'free',
};

const storage = createStorage<DailyQuotaData>('linkedin_daily_quota', DEFAULT_DAILY_QUOTA, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type DailyQuotaStorageType = BaseStorage<DailyQuotaData> & {
  getQuotaData: () => Promise<DailyQuotaData>;
  applyServerQuota: (quota: unknown, uid: string | null) => Promise<DailyQuotaData | null>;
};

export const dailyQuotaStore: DailyQuotaStorageType = {
  ...storage,

  /** The last backend quota as stored (use getQuotaDisplay to decide whether it can be shown). */
  async getQuotaData(): Promise<DailyQuotaData> {
    return (await storage.get()) || DEFAULT_DAILY_QUOTA;
  },

  /** Stores a backend quota for `uid`; a malformed response is ignored (returns null). */
  async applyServerQuota(quota: unknown, uid: string | null): Promise<DailyQuotaData | null> {
    const parsed = parseServerQuota(quota);
    if (!parsed || !uid) return null;
    const resetAt = Date.parse(parsed.resetsAt);
    const next: DailyQuotaData = {
      dateString: parsed.day,
      appliedCount: parsed.applied,
      maxDailyQuota: parsed.limit,
      remaining: parsed.remaining,
      reservedCount: parsed.reserved,
      activePlanCode: parsed.plan,
      isPaid: parsed.isPaid,
      resetsAt: parsed.resetsAt,
      isPausedDueToQuota: parsed.remaining <= 0,
      nextResumeTimestamp: parsed.remaining <= 0 ? resetAt : null,
      syncedAt: Date.now(),
      uid,
    };
    await storage.set(next);
    return next;
  },
};

export default dailyQuotaStore;
