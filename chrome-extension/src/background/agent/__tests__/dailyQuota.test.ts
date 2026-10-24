import { describe, it, expect, beforeEach, vi } from 'vitest';

const { storageData } = vi.hoisted(() => {
  const data: Record<string, any> = {};
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const local = {
    get: async (keys?: string | string[] | null) => {
      if (!keys) return clone(data);
      const res: Record<string, any> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) res[k] = clone(data[k]);
      return res;
    },
    set: async (items: Record<string, any>) => {
      for (const [k, v] of Object.entries(items)) data[k] = clone(v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    onChanged: { addListener: () => undefined },
  };
  (globalThis as any).chrome = {
    storage: { local, sync: local, session: local, onChanged: { addListener: () => undefined } },
    alarms: { create: async () => undefined },
    runtime: { id: 'test', getURL: (p: string) => p },
  };
  return { storageData: data };
});

import { backendApiClient, type ApplicationQuota } from '@extension/shared';
import { authStorage, dailyQuotaStore, getQuotaDisplay, parseServerQuota } from '@extension/storage';
import { DailyQuotaManager, applicationKey, quotaStopMessage } from '../linkedin/rateLimiter';

function quota(fields: Partial<ApplicationQuota> = {}): ApplicationQuota {
  const applied = fields.applied ?? 0;
  const limit = fields.limit ?? 10;
  const reserved = fields.reserved ?? 0;
  const remaining = fields.remaining ?? Math.max(0, limit - applied - reserved);
  return {
    day: '2026-10-23',
    timezone: 'UTC',
    resetsAt: '2026-10-24T00:00:00.000Z',
    applied,
    reserved,
    limit,
    remaining,
    plan: 'free',
    isPaid: false,
    allowed: remaining > 0,
    appliedToday: applied,
    dailyLimit: limit,
    tier: 'free',
    lastResetDate: '2026-10-23',
    ...fields,
  };
}

const signedInAs = (uid: string) =>
  vi.spyOn(authStorage, 'getSession').mockResolvedValue({ token: 't', user: { id: uid, uid, _id: uid } } as any);

describe('Daily quota client (server-authoritative)', () => {
  beforeEach(async () => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    vi.restoreAllMocks();
    signedInAs('me');
    // Drop any slot a previous test left held
    (DailyQuotaManager as any).held.clear();
  });

  it('fails closed when the backend cannot confirm the quota', async () => {
    vi.spyOn(backendApiClient, 'getProfileQuota').mockResolvedValue(null);
    const check = await DailyQuotaManager.canApplyToday();
    expect(check).toMatchObject({ allowed: false, reason: 'error' });
    expect(quotaStopMessage(check)).toContain("Couldn't verify");
  });

  it('follows the server count, and clearing local storage cannot reset it', async () => {
    vi.spyOn(backendApiClient, 'getProfileQuota').mockResolvedValue(quota({ applied: 10, limit: 10 }));
    expect(await DailyQuotaManager.canApplyToday()).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
      currentCount: 10,
      maxQuota: 10,
      remaining: 0,
    });
    expect(storageData.linkedin_daily_quota).toMatchObject({ appliedCount: 10, maxDailyQuota: 10, remaining: 0 });

    for (const key of Object.keys(storageData)) delete storageData[key];
    expect((await DailyQuotaManager.canApplyToday()).allowed).toBe(false);
  });

  it('reserve: granted, already counted, limit reached (with upgrade prompt) and unavailable', async () => {
    const reserve = vi.spyOn(backendApiClient, 'reserveApplicationSlot');

    reserve.mockResolvedValueOnce({ status: 'granted', quota: quota({ applied: 3, reserved: 1 }) });
    expect(await DailyQuotaManager.reserveApplication('linkedin:1', 'runner')).toMatchObject({
      allowed: true,
      currentCount: 3,
    });

    reserve.mockResolvedValueOnce({ status: 'already_counted', quota: quota({ applied: 4 }) });
    expect(await DailyQuotaManager.reserveApplication('linkedin:1', 'runner')).toMatchObject({
      allowed: true,
      alreadyCounted: true,
    });

    reserve.mockResolvedValueOnce({ status: 'limit_reached', quota: quota({ applied: 10 }) });
    const blocked = await DailyQuotaManager.reserveApplication('linkedin:11', 'runner');
    expect(blocked).toMatchObject({ allowed: false, reason: 'quota_exceeded', currentCount: 10, maxQuota: 10 });
    expect(quotaStopMessage(blocked)).toContain('Daily application limit reached (10/10)');
    expect(quotaStopMessage(blocked)).toContain('Upgrade to Premium');

    reserve.mockResolvedValueOnce({ status: 'unavailable', quota: null });
    expect(await DailyQuotaManager.reserveApplication('linkedin:12', 'runner')).toMatchObject({
      allowed: false,
      reason: 'error',
    });
  });

  it('paid users at their limit are not told to upgrade', () => {
    const msg = quotaStopMessage({
      allowed: false,
      reason: 'quota_exceeded',
      currentCount: 300,
      maxQuota: 300,
      remaining: 0,
      isPaid: true,
    });
    expect(msg).toContain('(300/300)');
    expect(msg).not.toContain('Upgrade');
  });

  it("a runner's next job releases the slot of its previous, uncommitted job", async () => {
    vi.spyOn(backendApiClient, 'reserveApplicationSlot').mockResolvedValue({ status: 'granted', quota: quota() });
    const release = vi.spyOn(backendApiClient, 'releaseApplicationSlot').mockResolvedValue(quota());

    await DailyQuotaManager.reserveApplication('linkedin:skipped', 'runner');
    await DailyQuotaManager.reserveApplication('linkedin:next', 'runner');
    expect(release).toHaveBeenCalledWith('linkedin:skipped');

    // A committed job is not released afterwards
    vi.spyOn(backendApiClient, 'commitApplicationSlot').mockResolvedValue({
      counted: true,
      quota: quota({ applied: 1 }),
    });
    await DailyQuotaManager.commitApplication('linkedin:next');
    release.mockClear();
    await DailyQuotaManager.releaseOwner('runner');
    expect(release).not.toHaveBeenCalled();
  });

  it('a commit that cannot reach the backend is retried before the next quota check', async () => {
    const commit = vi
      .spyOn(backendApiClient, 'commitApplicationSlot')
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503 }))
      .mockResolvedValue({ counted: true, quota: quota({ applied: 1 }) });

    await DailyQuotaManager.commitApplication('naukri:42');
    expect(storageData.linkedin_pending_quota_commits).toEqual([{ jobKey: 'naukri:42', uid: 'me' }]);

    vi.spyOn(backendApiClient, 'getProfileQuota').mockResolvedValue(quota({ applied: 1 }));
    await DailyQuotaManager.canApplyToday();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(storageData.linkedin_pending_quota_commits).toEqual([]);
  });

  it("another account's pending commit is never sent with this account", async () => {
    storageData.linkedin_pending_quota_commits = [{ jobKey: 'linkedin:theirs', uid: 'someone-else' }];
    const commit = vi.spyOn(backendApiClient, 'commitApplicationSlot');
    vi.spyOn(backendApiClient, 'getProfileQuota').mockResolvedValue(quota());
    await DailyQuotaManager.canApplyToday();
    expect(commit).not.toHaveBeenCalled();
    expect(storageData.linkedin_pending_quota_commits).toEqual([]);
  });

  it('the older backend response is treated as unverified: no run starts and nothing is stored', async () => {
    const legacy = { allowed: true, appliedToday: 0, dailyLimit: 15, remaining: 15, tier: 'free', lastResetDate: 'x' };
    vi.spyOn(backendApiClient as any, 'request').mockResolvedValue({ success: true, data: legacy });
    vi.spyOn(backendApiClient as any, 'ensureToken').mockResolvedValue(undefined);
    (backendApiClient as any).token = 'token';
    expect(await backendApiClient.getProfileQuota()).toBeNull();
    expect(await DailyQuotaManager.canApplyToday()).toMatchObject({ allowed: false, reason: 'error' });
    expect(storageData.linkedin_daily_quota).toBeUndefined();
  });

  it('builds one stable key per job for reserve and commit', () => {
    expect(applicationKey('3912345678', 'https://www.linkedin.com/jobs/view/3912345678/?refId=x')).toBe(
      'linkedin:3912345678',
    );
    expect(applicationKey('abc', 'https://www.naukri.com/job-listings-abc')).toBe('naukri:abc');
    expect(applicationKey('k1', 'https://in.indeed.com/viewjob?jk=k1')).toBe('indeed:k1');
    expect(applicationKey(null, 'https://careers.example.com/apply/7?utm=1')).toBe(
      'external:https://careers.example.com/apply/7',
    );
    expect(applicationKey('9', undefined, 'linkedin')).toBe('linkedin:9');
  });
});

describe('What the side panel shows for the daily quota', () => {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const nextMidnight = new Date(
    Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1),
  ).toISOString();
  const server = (fields: Partial<ApplicationQuota> = {}) =>
    quota({ day: today, lastResetDate: today, resetsAt: nextMidnight, ...fields });
  const premium = (fields: Partial<ApplicationQuota> = {}) =>
    server({ limit: 300, plan: 'premium', isPaid: true, tier: 'premium', ...fields });

  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
  });

  async function shown(serverQuota: unknown, options: Partial<Parameters<typeof getQuotaDisplay>[1]> = {}) {
    const stored = await dailyQuotaStore.applyServerQuota(serverQuota, 'me');
    return getQuotaDisplay(stored, { uid: 'me', ...options });
  }

  it('free account: 0 / 10 used, 10 remaining', async () => {
    expect(await shown(server())).toEqual({
      status: 'ready',
      used: 0,
      limit: 10,
      remaining: 10,
      plan: 'free',
      isPaid: false,
      exhausted: false,
      resetsAt: nextMidnight,
    });
  });

  it('Premium account: 0 / 300 used, 300 remaining (Diamond too)', async () => {
    expect(await shown(premium(), { premiumActive: true })).toMatchObject({
      status: 'ready',
      used: 0,
      limit: 300,
      remaining: 300,
      plan: 'premium',
      isPaid: true,
    });
    expect(await shown(premium({ plan: 'diamond' }), { premiumActive: true })).toMatchObject({ plan: 'diamond' });
  });

  it('used = 10 of 10 (free) and 300 of 300 (Premium): limit reached, 0 remaining', async () => {
    expect(await shown(server({ applied: 10 }))).toMatchObject({ used: 10, limit: 10, remaining: 0, exhausted: true });
    expect(await shown(premium({ applied: 300 }), { premiumActive: true })).toMatchObject({
      used: 300,
      limit: 300,
      remaining: 0,
      exhausted: true,
    });
    expect(await shown(premium({ applied: 10 }), { premiumActive: true })).toMatchObject({
      used: 10,
      remaining: 290,
      exhausted: false,
    });
  });

  it('never more used than the limit, never negative remaining', async () => {
    expect(await shown(server({ applied: 12, remaining: 0 }))).toMatchObject({ used: 10, remaining: 0 });
    expect(await shown(server({ applied: 8, reserved: 3, remaining: 5 }))).toMatchObject({ used: 8, remaining: 0 });
  });

  it('rejects the older backend response and any undefined, NaN, negative or non-numeric value', async () => {
    const legacy = {
      allowed: true,
      appliedToday: 0,
      dailyLimit: 15,
      remaining: 15,
      tier: 'free',
      lastResetDate: today,
    };
    expect(parseServerQuota(legacy)).toBeNull();
    for (const bad of [
      { limit: undefined },
      { limit: Number.NaN },
      { limit: 0 },
      { applied: -1 },
      { remaining: -3 },
      { applied: '2' },
      { plan: '' },
      { isPaid: 'yes' },
      { day: undefined },
      { resetsAt: 'soon' },
    ]) {
      expect(parseServerQuota(server(bad as Partial<ApplicationQuota>))).toBeNull();
    }
    expect(await dailyQuotaStore.applyServerQuota(legacy, 'me')).toBeNull();
    expect(storageData.linkedin_daily_quota).toBeUndefined();
    expect(getQuotaDisplay(await dailyQuotaStore.getQuotaData(), { uid: 'me' })).toEqual({ status: 'unverified' });
  });

  it('is shown only for the account and the UTC day it was verified for', async () => {
    const stored = await dailyQuotaStore.applyServerQuota(server(), 'me');
    expect(getQuotaDisplay(stored, { uid: 'me' }).status).toBe('ready');
    expect(getQuotaDisplay(stored, { uid: 'someone-else' }).status).toBe('unverified');
    expect(getQuotaDisplay(stored, { uid: null }).status).toBe('unverified');
    expect(getQuotaDisplay(stored, { uid: 'me', now: now + 86_400_000 }).status).toBe('unverified');
  });

  it('a newer verified Premium status overrides a stale FREE copy until the quota is re-read', async () => {
    const free = await dailyQuotaStore.applyServerQuota(server(), 'me');
    // Premium verified after this copy (e.g. a payment): never shown as FREE
    expect(getQuotaDisplay(free, { uid: 'me', premiumActive: true, premiumCheckedAt: free!.syncedAt! + 1 })).toEqual({
      status: 'unverified',
    });
    // Premium ended after a Premium copy: not kept
    const paid = await dailyQuotaStore.applyServerQuota(premium(), 'me');
    expect(getQuotaDisplay(paid, { uid: 'me', premiumActive: false, premiumCheckedAt: paid!.syncedAt! + 1 })).toEqual({
      status: 'unverified',
    });
    // The quota re-read after the status check is newer, so it is shown
    expect(
      getQuotaDisplay(paid, { uid: 'me', premiumActive: true, premiumCheckedAt: paid!.syncedAt! - 1 }).status,
    ).toBe('ready');
  });

  it('nothing shown is ever undefined, null or NaN', async () => {
    for (const fields of [{}, { applied: 10 }, { applied: 999, remaining: 0 }, { reserved: 4, applied: 3 }]) {
      const view = await shown(server(fields));
      if (view.status !== 'ready') throw new Error('expected a verified quota');
      for (const value of [view.used, view.limit, view.remaining]) expect(Number.isFinite(value)).toBe(true);
      expect(view.used).toBeLessThanOrEqual(view.limit);
      expect(view.remaining).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(view)).not.toMatch(/undefined|NaN|null/);
    }
  });
});
