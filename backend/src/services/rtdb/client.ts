/**
 * client.ts
 *
 * Single entry point to the Firebase Realtime Database for the whole backend, plus the map of
 * every path this backend reads or writes.
 *
 * NAMESPACE
 *   All Ai-agent-browser data lives under one root node (default `nanobrowser`, configurable via
 *   NANOBROWSER_RTDB_ROOT). The database is shared with JobForm Automator, which already owns
 *   top-level nodes such as `user`, `users`, `hr`, `payment_records`, `processed_payments`,
 *   `jobApplications` and `interview_credits`. Keeping everything under one prefix guarantees this
 *   backend can never read, overwrite or collide with automator data, and lets the security rules
 *   lock the whole subtree to server-only access with a single entry.
 *
 * Every path builder validates its segments (assertSafeUid / assertSafeKey), so a malformed uid or
 * id can never escape its user's subtree.
 */

import type { Database, Reference } from 'firebase-admin/database';
import { adminDb } from '../../config/firebase-admin.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { assertSafeKey, assertSafeUid } from './rtdbUtils.js';

function resolveRoot(value: string): string {
  // One or more safe segments, e.g. "nanobrowser" or "staging/nanobrowser".
  const segments = value.split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('NANOBROWSER_RTDB_ROOT must not be empty');
  segments.forEach(segment => assertSafeKey(segment, 'NANOBROWSER_RTDB_ROOT segment'));
  return segments.join('/');
}

export const RTDB_ROOT = resolveRoot(env.NANOBROWSER_RTDB_ROOT);

const uidSeg = (uid: string): string => {
  assertSafeUid(uid);
  return uid;
};

const keySeg = (key: string, label: string): string => {
  assertSafeKey(key, label);
  return key;
};

/** Every path used by this backend. All of them are below RTDB_ROOT. */
export const paths = {
  root: () => RTDB_ROOT,
  health: () => `${RTDB_ROOT}/_health/ping`,

  userProfile: (uid: string) => `${RTDB_ROOT}/users/${uidSeg(uid)}/profile`,
  trialFlag: (uid: string) => `${RTDB_ROOT}/trial_flags/${uidSeg(uid)}`,

  plans: () => `${RTDB_ROOT}/subscription_plans`,
  plan: (code: string) => `${RTDB_ROOT}/subscription_plans/${keySeg(code, 'plan code')}`,

  subscriptions: () => `${RTDB_ROOT}/subscriptions`,
  subscription: (uid: string) => `${RTDB_ROOT}/subscriptions/${uidSeg(uid)}`,
  subscriptionHistory: (uid: string) => `${RTDB_ROOT}/subscription_history/${uidSeg(uid)}`,
  subscriptionHistoryEntry: (uid: string, subscriptionId: string) =>
    `${RTDB_ROOT}/subscription_history/${uidSeg(uid)}/${keySeg(subscriptionId, 'subscription id')}`,
  providerSubscription: (key: string) =>
    `${RTDB_ROOT}/provider_subscriptions/${keySeg(key, 'provider subscription key')}`,

  creditBalance: (uid: string) => `${RTDB_ROOT}/credit_balances/${uidSeg(uid)}`,
  creditBalances: () => `${RTDB_ROOT}/credit_balances`,
  creditLedger: (uid: string) => `${RTDB_ROOT}/credit_ledger/${uidSeg(uid)}`,
  creditLedgerEntry: (uid: string, entryId: string) =>
    `${RTDB_ROOT}/credit_ledger/${uidSeg(uid)}/${keySeg(entryId, 'ledger entry id')}`,
  creditLedgerCount: (uid: string) => `${RTDB_ROOT}/credit_ledger_meta/${uidSeg(uid)}/count`,
  creditIdempotency: (uid: string, keyHash: string) =>
    `${RTDB_ROOT}/credit_idempotency/${uidSeg(uid)}/${keySeg(keyHash, 'idempotency key hash')}`,
  failedRefunds: (uid: string) => `${RTDB_ROOT}/failed_refunds/${uidSeg(uid)}`,
  failedRefund: (uid: string, runId: string) =>
    `${RTDB_ROOT}/failed_refunds/${uidSeg(uid)}/${keySeg(runId, 'failed refund run id')}`,
  reconcileAuditLogs: (uid: string) => `${RTDB_ROOT}/reconcile_audit_logs/${uidSeg(uid)}`,
  reconcileAuditLogEntry: (uid: string, entryId: string) =>
    `${RTDB_ROOT}/reconcile_audit_logs/${uidSeg(uid)}/${keySeg(entryId, 'reconcile audit log id')}`,

  careerBrain: (uid: string) => `${RTDB_ROOT}/career_brains/${uidSeg(uid)}`,
  careerBrainField: (uid: string, field: 'createdAt' | 'dailyQuota' | 'tier' | 'updatedAt') =>
    `${RTDB_ROOT}/career_brains/${uidSeg(uid)}/${field}`,

  jobApplications: (uid: string) => `${RTDB_ROOT}/job_applications/${uidSeg(uid)}`,
  jobApplication: (uid: string, appId: string) =>
    `${RTDB_ROOT}/job_applications/${uidSeg(uid)}/${keySeg(appId, 'application id')}`,
  jobApplicationKey: (uid: string, jobKey: string) =>
    `${RTDB_ROOT}/job_application_keys/${uidSeg(uid)}/${keySeg(jobKey, 'job key')}`,
  jobApplicationCount: (uid: string) => `${RTDB_ROOT}/job_applications_meta/${uidSeg(uid)}/count`,

  llmUsage: (uid: string) => `${RTDB_ROOT}/llm_usage/${uidSeg(uid)}`,
  llmUsageEntry: (uid: string, usageId: string) =>
    `${RTDB_ROOT}/llm_usage/${uidSeg(uid)}/${keySeg(usageId, 'usage id')}`,
  llmUsageCount: (uid: string) => `${RTDB_ROOT}/llm_usage_meta/${uidSeg(uid)}/count`,

  webhook: (eventKey: string) => `${RTDB_ROOT}/processed_webhooks/${keySeg(eventKey, 'webhook event key')}`,

  migrationRun: (runId: string) => `${RTDB_ROOT}/_migrations/mongo_to_rtdb/runs/${keySeg(runId, 'migration run id')}`,
  migrationUser: (uid: string) => `${RTDB_ROOT}/_migrations/mongo_to_rtdb/users/${uidSeg(uid)}`,
};

/** True when Firebase Admin has a database handle (credentials and databaseURL configured). */
export function isRtdbAvailable(): boolean {
  return adminDb !== null;
}

/** The Admin RTDB handle, or a 503 when Firebase Admin isn't configured (fail closed). */
export function getRtdb(): Database {
  if (!adminDb) {
    throw new AppError('Database temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
  }
  return adminDb;
}

export function dbRef(path: string): Reference {
  return getRtdb().ref(path);
}

/** Root reference, used for atomic multi-location updates whose keys are full paths from paths.*. */
export function rootRef(): Reference {
  return getRtdb().ref();
}

/**
 * Lightweight round trip used by the readiness probe: a real server read of a tiny node,
 * bounded by a timeout so a hung connection can't hang the probe.
 */
export async function pingRtdb(timeoutMs = 3000): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  if (!adminDb) {
    return { ok: false, latencyMs: 0, error: 'Firebase Admin database is not initialised' };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      adminDb.ref(paths.health()).get(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RTDB ping timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - started, error: err?.message || 'RTDB ping failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
