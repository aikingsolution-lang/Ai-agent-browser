/**
 * jobformPremium.service.ts
 *
 * JobForm Automator premium status for a NanoBrowser user (same Firebase project, same uid).
 *
 * Source of truth: `user/{uid}/Payment` in the JobForm Automator Realtime Database. It is written
 * only by JobForm Automator's server routes after Razorpay verification (/api/payment/confirm,
 * the Razorpay webhook, reward claims); its security rules stop browsers from granting
 * themselves Premium. This backend only READS it (outside the nanobrowser/ namespace) and never
 * writes JobForm Automator data.
 *
 * The rule is a copy of JobForm Automator's lib/interview/premium.ts (the same function its
 * website and server use), so both products always agree on who is premium.
 */

import { getRtdb } from './rtdb/client.js';
import { assertSafeUid } from './rtdb/rtdbUtils.js';

export type JobformTier = 'Free' | 'Premium' | 'Diamond';

export interface JobformPaymentRecord {
  Status?: string | null;
  SubscriptionType?: string | null;
  Start_Date?: string | null;
  End_Date?: string | null;
  [key: string]: unknown;
}

export interface JobformPremiumStatus {
  source: 'jobform-automator';
  tier: JobformTier;
  isPremium: boolean;
  /** Plan stored by JobForm Automator ("Premium", "Diamond", "FreeTrialStarted", …), if any. */
  subscriptionType: string | null;
  startDate: string | null;
  /** ISO end of the paid period; null when there is none. */
  endDate: string | null;
  /** A paid record exists but its End_Date has passed. */
  expired: boolean;
  checkedAt: string;
}

/**
 * Parses the stored End_Date format ("2025-08-10 17:29:55", written in UTC) as well as plain ISO
 * strings. Returns null when the value is missing or unparseable. (Copy of JobForm Automator.)
 */
export function parsePaymentDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.includes(' ') ? value.replace(' ', 'T') + 'Z' : value;
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Paid access requires Status "Premium" (or the legacy SubscriptionType "Premium") and an End_Date
 * that has not passed. Diamond is a Premium subscription with SubscriptionType "Diamond".
 * (Copy of JobForm Automator's getSubscriptionTier.)
 */
export function getSubscriptionTier(
  payment: JobformPaymentRecord | null | undefined,
  now: Date = new Date(),
): JobformTier {
  if (!payment || typeof payment !== 'object') return 'Free';

  const isPaid = payment.Status === 'Premium' || payment.SubscriptionType === 'Premium';
  if (!isPaid) return 'Free';

  if (payment.End_Date) {
    const endDate = parsePaymentDate(payment.End_Date);
    // An unparseable End_Date keeps the historical behavior of trusting the status.
    if (endDate && endDate <= now) return 'Free';
  }

  return payment.SubscriptionType === 'Diamond' ? 'Diamond' : 'Premium';
}

export function toJobformPremiumStatus(
  payment: JobformPaymentRecord | null | undefined,
  now: Date = new Date(),
): JobformPremiumStatus {
  const record = payment && typeof payment === 'object' ? payment : null;
  const tier = getSubscriptionTier(record, now);
  const isPaidRecord = Boolean(record && (record.Status === 'Premium' || record.SubscriptionType === 'Premium'));
  const end = parsePaymentDate(record?.End_Date);
  const start = parsePaymentDate(record?.Start_Date);
  return {
    source: 'jobform-automator',
    tier,
    isPremium: tier !== 'Free',
    subscriptionType: typeof record?.SubscriptionType === 'string' ? record.SubscriptionType : null,
    startDate: start ? start.toISOString() : null,
    endDate: end ? end.toISOString() : null,
    expired: isPaidRecord && tier === 'Free',
    checkedAt: now.toISOString(),
  };
}

export class JobformPremiumService {
  /** Reads user/{uid}/Payment (read-only) and applies JobForm Automator's premium rule. */
  public static async getStatus(uid: string): Promise<JobformPremiumStatus> {
    assertSafeUid(uid);
    const snapshot = await getRtdb().ref(`user/${uid}/Payment`).get();
    return toJobformPremiumStatus(snapshot.exists() ? snapshot.val() : null);
  }
}
