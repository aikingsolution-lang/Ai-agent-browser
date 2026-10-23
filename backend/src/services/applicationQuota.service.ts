/**
 * Daily job-application quota — the server is the only source of truth.
 *
 * Limits (per verified account, per UTC calendar day):
 *   - free users (including the free trial):                    10 successful applications
 *   - JobForm Automator Premium or Diamond (user/{uid}/Payment): 300, as in the JobForm Automator extension
 *   - active paid NanoBrowser plans keep their limits:           starter 50, pro 100, power 500
 * A user with several entitlements gets the highest limit. Premium is read server-side only.
 *
 * Accounting is reserve → commit / release, keyed by job, in one RTDB transaction per call:
 *   - reserve holds a slot before a submission; it is refused once applied + held slots reach the limit,
 *     so concurrent runs cannot overshoot;
 *   - commit records a successful submission exactly once per job and day (retries never count twice);
 *   - release frees the slot of a submission that did not happen; unreleased slots expire.
 */

import { randomUUID } from 'crypto';
import { dbRef, paths } from './rtdb/client.js';
import { SubscriptionRepository } from './rtdb/repositories.js';
import { hashKey } from './rtdb/rtdbUtils.js';
import { JobformPremiumService } from './jobformPremium.service.js';

export const FREE_DAILY_APPLICATION_LIMIT = 10;
export const JOBFORM_PREMIUM_DAILY_APPLICATION_LIMIT = 300;
export const PAID_PLAN_DAILY_APPLICATION_LIMITS: Readonly<Record<string, number>> = {
  starter: 50,
  pro: 100,
  power: 500,
};
const UNKNOWN_PAID_PLAN_DAILY_LIMIT = 50;
/** A held slot that is neither committed nor released is given back after this long. */
export const RESERVATION_TTL_MS = 20 * 60 * 1000;

export type ApplicationPlan = 'free' | 'premium' | 'diamond' | string;

export interface ApplicationEntitlement {
  limit: number;
  plan: ApplicationPlan;
  isPaid: boolean;
}

export interface ApplicationQuotaView {
  day: string;
  timezone: 'UTC';
  /** ISO time of the next reset (next UTC midnight). */
  resetsAt: string;
  applied: number;
  reserved: number;
  limit: number;
  remaining: number;
  plan: ApplicationPlan;
  isPaid: boolean;
  // Fields the extension already reads from GET /profile/quota.
  allowed: boolean;
  appliedToday: number;
  dailyLimit: number;
  tier: 'free' | 'premium';
  lastResetDate: string;
}

interface StoredQuota {
  day: string;
  applied: number;
  committed?: Record<string, number>;
  reservations?: Record<string, number>;
}

interface QuotaState {
  day: string;
  applied: number;
  committed: Record<string, number>;
  reservations: Record<string, number>;
}

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export function nextUtcMidnight(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

function normalize(stored: StoredQuota | null | undefined, now: number): QuotaState {
  const today = utcDay(now);
  if (!stored || stored.day !== today) return { day: today, applied: 0, committed: {}, reservations: {} };
  const reservations: Record<string, number> = {};
  for (const [key, expiresAt] of Object.entries(stored.reservations ?? {})) {
    if (typeof expiresAt === 'number' && expiresAt > now) reservations[key] = expiresAt;
  }
  return {
    day: today,
    applied: Math.max(0, Number(stored.applied) || 0),
    committed: { ...(stored.committed ?? {}) },
    reservations,
  };
}

function toStored(state: QuotaState): StoredQuota {
  const stored: StoredQuota = { day: state.day, applied: state.applied };
  if (Object.keys(state.committed).length > 0) stored.committed = state.committed;
  if (Object.keys(state.reservations).length > 0) stored.reservations = state.reservations;
  return stored;
}

function toView(state: QuotaState, entitlement: ApplicationEntitlement, now: number): ApplicationQuotaView {
  const reserved = Object.keys(state.reservations).length;
  const remaining = Math.max(0, entitlement.limit - state.applied - reserved);
  return {
    day: state.day,
    timezone: 'UTC',
    resetsAt: nextUtcMidnight(now),
    applied: state.applied,
    reserved,
    limit: entitlement.limit,
    remaining,
    plan: entitlement.plan,
    isPaid: entitlement.isPaid,
    allowed: remaining > 0,
    appliedToday: state.applied,
    dailyLimit: entitlement.limit,
    tier: entitlement.isPaid ? 'premium' : 'free',
    lastResetDate: state.day,
  };
}

export class ApplicationQuotaService {
  /** Highest daily limit among the user's verified entitlements. */
  public static async resolveEntitlement(uid: string): Promise<ApplicationEntitlement> {
    const [subscription, jobformPremium] = await Promise.all([
      SubscriptionRepository.getCurrent(uid),
      JobformPremiumService.getStatus(uid),
    ]);

    let entitlement: ApplicationEntitlement = { limit: FREE_DAILY_APPLICATION_LIMIT, plan: 'free', isPaid: false };
    if (jobformPremium.isPremium) {
      entitlement = {
        limit: JOBFORM_PREMIUM_DAILY_APPLICATION_LIMIT,
        plan: jobformPremium.tier === 'Diamond' ? 'diamond' : 'premium',
        isPaid: true,
      };
    }
    if (subscription?.status === 'ACTIVE') {
      const code = subscription.planCodeSnapshot;
      const planLimit = PAID_PLAN_DAILY_APPLICATION_LIMITS[code] ?? UNKNOWN_PAID_PLAN_DAILY_LIMIT;
      if (planLimit > entitlement.limit) entitlement = { limit: planLimit, plan: code || 'paid', isPaid: true };
    }
    return entitlement;
  }

  public static async getStatus(uid: string, now = Date.now()): Promise<ApplicationQuotaView> {
    const entitlement = await this.resolveEntitlement(uid);
    const stored = (await dbRef(paths.applicationQuota(uid)).get()).val() as StoredQuota | null;
    return toView(normalize(stored, now), entitlement, now);
  }

  /** Holds a slot for `jobKey`. A job already counted today is granted without using a slot. */
  public static async reserve(
    uid: string,
    jobKey: string,
    now = Date.now(),
  ): Promise<{ granted: boolean; alreadyCounted: boolean; quota: ApplicationQuotaView }> {
    const entitlement = await this.resolveEntitlement(uid);
    const key = hashKey(jobKey);
    let granted = false;
    let alreadyCounted = false;
    const state = await this.transact(uid, now, current => {
      granted = false;
      alreadyCounted = false;
      if (current.committed[key]) {
        granted = true;
        alreadyCounted = true;
        return;
      }
      const held = Object.keys(current.reservations).length;
      if (current.reservations[key] || current.applied + held < entitlement.limit) {
        current.reservations[key] = now + RESERVATION_TTL_MS;
        granted = true;
      }
    });
    return { granted, alreadyCounted, quota: toView(state, entitlement, now) };
  }

  /** Records a successful submission once per job and day, and frees its held slot. */
  public static async commit(
    uid: string,
    jobKey: string,
    now = Date.now(),
  ): Promise<{ counted: boolean; quota: ApplicationQuotaView }> {
    const entitlement = await this.resolveEntitlement(uid);
    const key = hashKey(jobKey);
    let counted = false;
    const state = await this.transact(uid, now, current => {
      counted = false;
      delete current.reservations[key];
      if (current.committed[key]) return;
      // Counted even without a live reservation: the application was submitted.
      current.committed[key] = now;
      current.applied += 1;
      counted = true;
    });
    return { counted, quota: toView(state, entitlement, now) };
  }

  /** Frees the slot held for a submission that did not happen. Already-counted jobs are unaffected. */
  public static async release(uid: string, jobKey: string, now = Date.now()): Promise<ApplicationQuotaView> {
    const entitlement = await this.resolveEntitlement(uid);
    const key = hashKey(jobKey);
    const state = await this.transact(uid, now, current => {
      delete current.reservations[key];
    });
    return toView(state, entitlement, now);
  }

  /** Legacy one-shot check-and-increment (no job key): counts a new application if a slot is free. */
  public static async checkAndIncrement(
    uid: string,
    now = Date.now(),
  ): Promise<{ allowed: boolean; quota: ApplicationQuotaView }> {
    const jobKey = `legacy:${randomUUID()}`;
    const reservation = await this.reserve(uid, jobKey, now);
    if (!reservation.granted) return { allowed: false, quota: reservation.quota };
    const { quota } = await this.commit(uid, jobKey, now);
    return { allowed: true, quota };
  }

  private static async transact(uid: string, now: number, mutate: (state: QuotaState) => void): Promise<QuotaState> {
    const result = await dbRef(paths.applicationQuota(uid)).transaction((stored: StoredQuota | null) => {
      const state = normalize(stored, now);
      mutate(state);
      return toStored(state);
    });
    return normalize(result.snapshot.val() as StoredQuota | null, now);
  }
}
