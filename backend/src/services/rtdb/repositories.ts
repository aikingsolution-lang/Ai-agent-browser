/**
 * repositories.ts
 *
 * Data-access layer: the only place that issues raw Firebase RTDB operations. Domain services
 * (credit.service.ts, trial.service.ts, …) call these; controllers never touch the database.
 *
 * TRANSACTION RULES (verified against the firebase-admin RTDB SDK):
 *   1. RTDB first calls the update function with the locally cached value — `null` when nothing
 *      is cached, even if the node exists on the server — then re-runs it with the server value
 *      if that guess was wrong. Returning `undefined` aborts immediately with no re-run, so an
 *      update function must never abort just because it saw `null`.
 *   2. The function can run several times; any outcome flag it sets is reset at the top of each
 *      run so only the final run's outcome is used.
 *   3. "Claim" transactions (create-if-absent) use the same shape as JobForm Automator's
 *      processed_payments claim: `current === null ? newValue : undefined`. Aborting is correct
 *      there because a non-null value means someone already owns the claim; when the abort happens
 *      on a re-run the returned snapshot is the server value.
 *   4. When a check-then-modify decides "no change" on real data, it returns the current value
 *      unchanged (as automator's rate limiter does) instead of aborting, so the decision is always
 *      confirmed against the server.
 *
 * Related writes that Mongo did as separate statements are combined into one multi-location
 * `update()` here, which RTDB applies atomically.
 */

import { ServerValue } from 'firebase-admin/database';
import type { DataSnapshot } from 'firebase-admin/database';
import { dbRef, paths, rootRef } from './client.js';
import { hashKey, stripUndefined } from './rtdbUtils.js';
import type {
  CareerBrainRecord,
  CreditBalanceRecord,
  CreditLedgerRecord,
  DailyQuotaRecord,
  IdempotencyClaimRecord,
  JobApplicationRecord,
  LlmUsageRecord,
  PlanRecord,
  ProviderSubscriptionLinkRecord,
  SubscriptionRecord,
  SubscriptionStatus,
  TrialFlagRecord,
  UserProfileRecord,
  WebhookLedgerRecord,
} from './records.js';

/** Multi-location update map: full path (from paths.*) → value. null deletes. */
export type UpdateMap = Record<string, unknown>;

/** Applies a multi-location update atomically. Values are stripped of `undefined` first. */
export async function applyUpdates(updates: UpdateMap): Promise<void> {
  const clean: UpdateMap = {};
  for (const [path, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    clean[path] = value === null || isServerValue(value) ? value : stripUndefined(value);
  }
  if (Object.keys(clean).length === 0) return;
  await rootRef().update(clean);
}

function isServerValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '.sv' in (value as object);
}

/** Atomic server-side counter increment, usable inside applyUpdates(). */
export function increment(delta: number): object {
  return ServerValue.increment(delta);
}

async function readVal<T>(path: string): Promise<T | null> {
  const snap = await dbRef(path).get();
  return snap.exists() ? (snap.val() as T) : null;
}

/** Children of a query snapshot in query order. */
function childrenOf<T>(snap: DataSnapshot): T[] {
  const out: T[] = [];
  snap.forEach(child => {
    out.push(child.val() as T);
    return false;
  });
  return out;
}

async function readCount(path: string): Promise<number | null> {
  const value = await readVal<number>(path);
  return typeof value === 'number' ? value : null;
}

/**
 * Newest-first pagination over a per-user list ordered by a numeric child.
 * Reads only the newest `page * limit` children instead of the whole list.
 */
async function pageNewestFirst<T>(listPath: string, orderField: string, page: number, limit: number): Promise<T[]> {
  const snap = await dbRef(listPath)
    .orderByChild(orderField)
    .limitToLast(page * limit)
    .get();
  const items = childrenOf<T>(snap).reverse();
  return items.slice((page - 1) * limit, page * limit);
}

/** Counts children by reading the list once — only used when a counter node is missing. */
async function countChildren(listPath: string): Promise<number> {
  const snap = await dbRef(listPath).get();
  return snap.exists() ? snap.numChildren() : 0;
}

// ── Users ─────────────────────────────────────────────────────────────────────

export class UserProfileRepository {
  static get(uid: string): Promise<UserProfileRecord | null> {
    return readVal<UserProfileRecord>(paths.userProfile(uid));
  }

  static async set(uid: string, record: UserProfileRecord): Promise<void> {
    await dbRef(paths.userProfile(uid)).set(stripUndefined(record));
  }

  static async exists(uid: string): Promise<boolean> {
    const snap = await dbRef(`${paths.userProfile(uid)}/createdAt`).get();
    return snap.exists();
  }
}

// ── Plans ─────────────────────────────────────────────────────────────────────

export class PlanRepository {
  static get(code: string): Promise<PlanRecord | null> {
    return readVal<PlanRecord>(paths.plan(code));
  }

  static async list(): Promise<PlanRecord[]> {
    const all = await readVal<Record<string, PlanRecord>>(paths.plans());
    return all ? Object.values(all) : [];
  }

  /** Creates the plan only if no plan with that code exists. Returns true when it was created. */
  static async createIfMissing(plan: PlanRecord): Promise<boolean> {
    const result = await dbRef(paths.plan(plan.code)).transaction(current =>
      current === null ? stripUndefined(plan) : undefined,
    );
    return result.committed;
  }

  static async update(code: string, patch: Partial<PlanRecord>): Promise<void> {
    await dbRef(paths.plan(code)).update(stripUndefined(patch));
  }
}

// ── Trial flags & subscriptions ───────────────────────────────────────────────

export class SubscriptionRepository {
  static getTrialFlag(uid: string): Promise<TrialFlagRecord | null> {
    return readVal<TrialFlagRecord>(paths.trialFlag(uid));
  }

  /**
   * Atomically claims the user's one free trial. Returns false when the trial was already used.
   * Replaces User.hasUsedTrial plus the Mongo partial unique index {userId, isTrial: true}.
   */
  static async claimTrialFlag(uid: string, now: number): Promise<boolean> {
    let alreadyUsed = false;
    const result = await dbRef(paths.trialFlag(uid)).transaction((current: TrialFlagRecord | null) => {
      alreadyUsed = false;
      if (current && current.hasUsedTrial) {
        alreadyUsed = true;
        return current; // confirm against the server, change nothing
      }
      return { hasUsedTrial: true, trialUsedAt: now };
    });
    return result.committed && !alreadyUsed;
  }

  static async releaseTrialFlag(uid: string): Promise<void> {
    await dbRef(paths.trialFlag(uid)).remove();
  }

  static getCurrent(uid: string): Promise<SubscriptionRecord | null> {
    return readVal<SubscriptionRecord>(paths.subscription(uid));
  }

  /** Writes the current subscription only if the user has none. Returns true when it was created. */
  static async createCurrentIfMissing(uid: string, record: SubscriptionRecord): Promise<boolean> {
    const result = await dbRef(paths.subscription(uid)).transaction(current =>
      current === null ? stripUndefined(record) : undefined,
    );
    return result.committed;
  }

  /**
   * Applies `mutate` to the user's current subscription atomically. `mutate` returns the new
   * record, or null for "no change". Returns the subscription after the transaction and whether
   * it changed.
   */
  static async transactCurrent(
    uid: string,
    mutate: (current: SubscriptionRecord) => SubscriptionRecord | null,
  ): Promise<{ changed: boolean; subscription: SubscriptionRecord | null }> {
    let changed = false;
    const result = await dbRef(paths.subscription(uid)).transaction((current: SubscriptionRecord | null) => {
      changed = false;
      if (current === null) return null; // empty (or not cached yet): leave as-is; RTDB re-runs if it isn't empty
      const next = mutate(structuredClone(current));
      if (next === null) return current;
      changed = true;
      return stripUndefined(next);
    });
    return {
      changed: result.committed && changed,
      subscription: (result.snapshot.val() as SubscriptionRecord | null) ?? null,
    };
  }

  /** Subscriptions with a given status (needs `.indexOn: ["status"]` on subscriptions). */
  static async listByStatus(status: SubscriptionStatus): Promise<SubscriptionRecord[]> {
    const snap = await dbRef(paths.subscriptions()).orderByChild('status').equalTo(status).get();
    return childrenOf<SubscriptionRecord>(snap);
  }

  static async listHistory(uid: string): Promise<SubscriptionRecord[]> {
    const all = await readVal<Record<string, SubscriptionRecord>>(paths.subscriptionHistory(uid));
    return all ? Object.values(all) : [];
  }

  static getProviderLink(providerKey: string): Promise<ProviderSubscriptionLinkRecord | null> {
    return readVal<ProviderSubscriptionLinkRecord>(paths.providerSubscription(providerKey));
  }

  /**
   * Links a Razorpay subscription id to one user (the Mongo unique index on
   * Subscription.providerSubscriptionId). Returns the owner after the claim.
   */
  static async claimProviderLink(
    providerKey: string,
    link: ProviderSubscriptionLinkRecord,
  ): Promise<{ ownerUid: string; claimedNow: boolean }> {
    const result = await dbRef(paths.providerSubscription(providerKey)).transaction(
      (current: ProviderSubscriptionLinkRecord | null) => (current === null ? stripUndefined(link) : undefined),
    );
    if (result.committed) return { ownerUid: link.uid, claimedNow: true };
    const existing = result.snapshot.val() as ProviderSubscriptionLinkRecord | null;
    if (existing) return { ownerUid: existing.uid, claimedNow: false };
    // Aborted without a value: re-read to be certain.
    const fresh = await this.getProviderLink(providerKey);
    return { ownerUid: fresh?.uid ?? link.uid, claimedNow: false };
  }
}

// ── Credits ───────────────────────────────────────────────────────────────────

export type BalanceMutationOutcome = 'APPLIED' | 'INSUFFICIENT' | 'NO_BALANCE';

export interface BalanceMutationResult {
  outcome: BalanceMutationOutcome;
  balanceBefore: number;
  balanceAfter: number;
  balance: CreditBalanceRecord | null;
}

export class CreditRepository {
  static getBalance(uid: string): Promise<CreditBalanceRecord | null> {
    return readVal<CreditBalanceRecord>(paths.creditBalance(uid));
  }

  /** Every user's balance — used only by admin scripts. */
  static async listBalances(): Promise<Record<string, CreditBalanceRecord>> {
    return (await readVal<Record<string, CreditBalanceRecord>>(paths.creditBalances())) ?? {};
  }

  /** Atomically subtracts `amount` if remainingCredits >= amount (the Mongo `$gte` + `$inc` guard). */
  static async deduct(uid: string, amount: number, now: number): Promise<BalanceMutationResult> {
    let outcome: BalanceMutationOutcome = 'NO_BALANCE';
    let balanceBefore = 0;
    let balanceAfter = 0;
    const result = await dbRef(paths.creditBalance(uid)).transaction((current: CreditBalanceRecord | null) => {
      outcome = 'NO_BALANCE';
      if (current === null) return null;
      balanceBefore = current.remainingCredits;
      balanceAfter = current.remainingCredits;
      if (current.remainingCredits < amount) {
        outcome = 'INSUFFICIENT';
        return current;
      }
      outcome = 'APPLIED';
      balanceAfter = current.remainingCredits - amount;
      return {
        ...current,
        usedCredits: (current.usedCredits || 0) + amount,
        remainingCredits: balanceAfter,
        updatedAt: now,
      };
    });
    return {
      outcome: result.committed ? outcome : 'NO_BALANCE',
      balanceBefore,
      balanceAfter,
      balance: (result.snapshot.val() as CreditBalanceRecord | null) ?? null,
    };
  }

  /** Atomically adds `amount` back (usedCredits never goes below zero). */
  static async refund(uid: string, amount: number, now: number): Promise<BalanceMutationResult> {
    let outcome: BalanceMutationOutcome = 'NO_BALANCE';
    let balanceBefore = 0;
    let balanceAfter = 0;
    const result = await dbRef(paths.creditBalance(uid)).transaction((current: CreditBalanceRecord | null) => {
      outcome = 'NO_BALANCE';
      if (current === null) return null;
      outcome = 'APPLIED';
      balanceBefore = current.remainingCredits;
      balanceAfter = current.remainingCredits + amount;
      return {
        ...current,
        usedCredits: Math.max(0, (current.usedCredits || 0) - amount),
        remainingCredits: balanceAfter,
        updatedAt: now,
      };
    });
    return {
      outcome: result.committed ? outcome : 'NO_BALANCE',
      balanceBefore,
      balanceAfter,
      balance: (result.snapshot.val() as CreditBalanceRecord | null) ?? null,
    };
  }

  /** Admin top-up: allocated = remaining = credits; creates the balance if missing. */
  static async setBalanceForAdmin(
    uid: string,
    credits: number,
    now: number,
    onPrevious: (previousRemaining: number) => void,
  ): Promise<CreditBalanceRecord> {
    const fallbackSubscriptionId = (await readVal<string>(`${paths.subscription(uid)}/subscriptionId`)) ?? '';
    const result = await dbRef(paths.creditBalance(uid)).transaction((current: CreditBalanceRecord | null) => {
      onPrevious(current?.remainingCredits ?? 0);
      return {
        subscriptionId: current?.subscriptionId ?? fallbackSubscriptionId,
        allocatedCredits: credits,
        usedCredits: current?.usedCredits ?? 0,
        remainingCredits: credits,
        periodStart: current?.periodStart ?? now,
        periodEnd: current?.periodEnd ?? now + 30 * 24 * 60 * 60 * 1000,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
    });
    return result.snapshot.val() as CreditBalanceRecord;
  }

  /** Update-map entries that append one ledger entry and bump the per-user counter. */
  static ledgerAppendUpdates(uid: string, entry: CreditLedgerRecord): UpdateMap {
    return {
      [paths.creditLedgerEntry(uid, entry.entryId)]: entry,
      [paths.creditLedgerCount(uid)]: increment(1),
    };
  }

  static getLedgerEntry(uid: string, entryId: string): Promise<CreditLedgerRecord | null> {
    return readVal<CreditLedgerRecord>(paths.creditLedgerEntry(uid, entryId));
  }

  /** Ledger entries for one agent run (needs `.indexOn: ["runId"]` on credit_ledger/$uid). */
  static async findLedgerByRunId(uid: string, runId: string): Promise<CreditLedgerRecord[]> {
    const snap = await dbRef(paths.creditLedger(uid)).orderByChild('runId').equalTo(runId).get();
    return childrenOf<CreditLedgerRecord>(snap);
  }

  static async listLedger(
    uid: string,
    page: number,
    limit: number,
  ): Promise<{ items: CreditLedgerRecord[]; total: number }> {
    const items = await pageNewestFirst<CreditLedgerRecord>(paths.creditLedger(uid), 'createdAt', page, limit);
    const total = (await readCount(paths.creditLedgerCount(uid))) ?? (await countChildren(paths.creditLedger(uid)));
    return { items, total };
  }

  static idempotencyKeyHash(key: string): string {
    return hashKey(key);
  }

  static getIdempotencyClaim(uid: string, key: string): Promise<IdempotencyClaimRecord | null> {
    return readVal<IdempotencyClaimRecord>(paths.creditIdempotency(uid, hashKey(key)));
  }

  /** Claims an idempotency key (create-if-absent). Returns the existing claim when it was taken. */
  static async claimIdempotency(
    uid: string,
    key: string,
    now: number,
  ): Promise<{ claimed: boolean; existing: IdempotencyClaimRecord | null }> {
    const claim: IdempotencyClaimRecord = { idempotencyKey: key, status: 'PENDING', createdAt: now };
    const result = await dbRef(paths.creditIdempotency(uid, hashKey(key))).transaction(
      (current: IdempotencyClaimRecord | null) => (current === null ? claim : undefined),
    );
    if (result.committed) return { claimed: true, existing: null };
    return { claimed: false, existing: (result.snapshot.val() as IdempotencyClaimRecord | null) ?? null };
  }

  /** Takes over a PENDING claim older than `staleBefore` (its owner crashed). */
  static async reclaimStaleIdempotency(uid: string, key: string, staleBefore: number, now: number): Promise<boolean> {
    let reclaimed = false;
    const result = await dbRef(paths.creditIdempotency(uid, hashKey(key))).transaction(
      (current: IdempotencyClaimRecord | null) => {
        reclaimed = false;
        if (current === null) {
          reclaimed = true;
          return { idempotencyKey: key, status: 'PENDING', createdAt: now };
        }
        if (current.status === 'PENDING' && current.createdAt < staleBefore) {
          reclaimed = true;
          return { ...current, createdAt: now };
        }
        return current;
      },
    );
    return result.committed && reclaimed;
  }

  static idempotencyCompleteUpdates(uid: string, key: string, entryId: string, now: number): UpdateMap {
    const base = paths.creditIdempotency(uid, hashKey(key));
    return {
      [`${base}/status`]: 'COMPLETED',
      [`${base}/entryId`]: entryId,
      [`${base}/completedAt`]: now,
    };
  }

  static async releaseIdempotency(uid: string, key: string): Promise<void> {
    await dbRef(paths.creditIdempotency(uid, hashKey(key))).remove();
  }

  static async recordFailedRefund(
    uid: string,
    record: {
      runId: string;
      idempotencyKey: string;
      reason: string;
      reportedAt: number;
    },
  ): Promise<void> {
    await dbRef(paths.failedRefund(uid, record.runId)).set(stripUndefined(record));
  }

  static async getAllLedger(uid: string): Promise<CreditLedgerRecord[]> {
    const snap = await dbRef(paths.creditLedger(uid)).get();
    return childrenOf<CreditLedgerRecord>(snap);
  }

  static async recordReconcileAudit(
    uid: string,
    record: {
      auditId: string;
      runId: string;
      amount: number;
      timestamp: number;
      reason: string;
    },
  ): Promise<void> {
    await dbRef(paths.reconcileAuditLogEntry(uid, record.auditId)).set(stripUndefined(record));
  }
}

// ── CareerBrain ───────────────────────────────────────────────────────────────

export class CareerBrainRepository {
  static get(uid: string): Promise<CareerBrainRecord | null> {
    return readVal<CareerBrainRecord>(paths.careerBrain(uid));
  }

  /** Cheap existence check (reads one small child, not the whole profile). */
  static async exists(uid: string): Promise<boolean> {
    const snap = await dbRef(paths.careerBrainField(uid, 'createdAt')).get();
    return snap.exists();
  }

  static async set(uid: string, record: CareerBrainRecord): Promise<void> {
    await dbRef(paths.careerBrain(uid)).set(stripUndefined(record));
  }

  /** Creates the profile only if none exists. Returns true when it was created. */
  static async createIfMissing(uid: string, record: CareerBrainRecord): Promise<boolean> {
    const result = await dbRef(paths.careerBrain(uid)).transaction(current =>
      current === null ? stripUndefined(record) : undefined,
    );
    return result.committed;
  }

  /** Partial update; keys may be nested paths such as "dailyQuota/dailyLimit". */
  static async update(uid: string, patch: Record<string, unknown>): Promise<void> {
    await dbRef(paths.careerBrain(uid)).update(stripUndefined(patch));
  }

  static getQuota(uid: string): Promise<DailyQuotaRecord | null> {
    return readVal<DailyQuotaRecord>(paths.careerBrainField(uid, 'dailyQuota'));
  }

  static getTier(uid: string): Promise<'free' | 'premium' | null> {
    return readVal<'free' | 'premium'>(paths.careerBrainField(uid, 'tier'));
  }

  /**
   * Atomic read-modify-write of the daily quota node. When the node is empty (or not cached yet)
   * `mutate` receives `seed` — the same `normalizeState(raw) ?? seed` approach as JobForm
   * Automator's consumeInterviewCredit: if the node really exists, RTDB rejects the seeded write
   * and re-runs `mutate` with the stored value. `mutate` must always return the quota to store.
   */
  static async transactQuota(
    uid: string,
    seed: DailyQuotaRecord,
    mutate: (current: DailyQuotaRecord) => DailyQuotaRecord,
  ): Promise<DailyQuotaRecord> {
    const result = await dbRef(paths.careerBrainField(uid, 'dailyQuota')).transaction(
      (current: DailyQuotaRecord | null) => mutate(current ? { ...current } : { ...seed }),
    );
    return (result.snapshot.val() as DailyQuotaRecord | null) ?? seed;
  }
}

// ── Job applications ──────────────────────────────────────────────────────────

export class JobApplicationRepository {
  static jobKey(jobId: string): string {
    return hashKey(jobId);
  }

  /**
   * Claims the {uid, jobId} pair (the Mongo unique index). Returns the application id that owns
   * the pair and whether this call created the claim.
   */
  static async claimJobKey(
    uid: string,
    jobId: string,
    candidateAppId: string,
  ): Promise<{ appId: string; isNew: boolean }> {
    const result = await dbRef(paths.jobApplicationKey(uid, this.jobKey(jobId))).transaction(
      (current: string | null) => (current === null ? candidateAppId : undefined),
    );
    if (result.committed) return { appId: candidateAppId, isNew: true };
    const existing = result.snapshot.val() as string | null;
    if (existing) return { appId: existing, isNew: false };
    const fresh = await readVal<string>(paths.jobApplicationKey(uid, this.jobKey(jobId)));
    return { appId: fresh ?? candidateAppId, isNew: !fresh };
  }

  static getAppIdForJob(uid: string, jobId: string): Promise<string | null> {
    return readVal<string>(paths.jobApplicationKey(uid, this.jobKey(jobId)));
  }

  static get(uid: string, appId: string): Promise<JobApplicationRecord | null> {
    return readVal<JobApplicationRecord>(paths.jobApplication(uid, appId));
  }

  /** Writes the record; `countAsNew` bumps the per-user counter in the same atomic update. */
  static async save(uid: string, record: JobApplicationRecord, countAsNew: boolean): Promise<void> {
    const updates: UpdateMap = { [paths.jobApplication(uid, record.appId)]: record };
    if (countAsNew) updates[paths.jobApplicationCount(uid)] = increment(1);
    await applyUpdates(updates);
  }

  /** Field-level update of an existing application (doesn't rewrite the other fields). */
  static async patch(uid: string, appId: string, fields: Partial<JobApplicationRecord>): Promise<void> {
    await dbRef(paths.jobApplication(uid, appId)).update(stripUndefined(fields));
  }

  static async list(
    uid: string,
    page: number,
    limit: number,
  ): Promise<{ items: JobApplicationRecord[]; total: number }> {
    const items = await pageNewestFirst<JobApplicationRecord>(paths.jobApplications(uid), 'updatedAt', page, limit);
    const total =
      (await readCount(paths.jobApplicationCount(uid))) ?? (await countChildren(paths.jobApplications(uid)));
    return { items, total };
  }

  /** Status filter (needs `.indexOn: ["status"]`), newest first. */
  static async listByStatus(
    uid: string,
    status: string,
    page: number,
    limit: number,
  ): Promise<{ items: JobApplicationRecord[]; total: number }> {
    const snap = await dbRef(paths.jobApplications(uid)).orderByChild('status').equalTo(status).get();
    const all = childrenOf<JobApplicationRecord>(snap).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { items: all.slice((page - 1) * limit, page * limit), total: all.length };
  }
}

// ── LLM usage ─────────────────────────────────────────────────────────────────

export class LlmUsageRepository {
  static async create(uid: string, record: LlmUsageRecord): Promise<void> {
    await applyUpdates({
      [paths.llmUsageEntry(uid, record.usageId)]: record,
      [paths.llmUsageCount(uid)]: increment(1),
    });
  }

  /** Needs `.indexOn: ["idempotencyKey"]` on llm_usage/$uid. */
  static async findByIdempotencyKey(uid: string, key: string): Promise<LlmUsageRecord | null> {
    const snap = await dbRef(paths.llmUsage(uid)).orderByChild('idempotencyKey').equalTo(key).limitToFirst(1).get();
    return childrenOf<LlmUsageRecord>(snap)[0] ?? null;
  }

  static async list(uid: string, page: number, limit: number): Promise<{ items: LlmUsageRecord[]; total: number }> {
    const items = await pageNewestFirst<LlmUsageRecord>(paths.llmUsage(uid), 'createdAt', page, limit);
    const total = (await readCount(paths.llmUsageCount(uid))) ?? (await countChildren(paths.llmUsage(uid)));
    return { items, total };
  }
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export type WebhookClaimOutcome = 'CLAIMED' | 'RECLAIMED' | 'ALREADY_PROCESSED' | 'IN_FLIGHT';

export class WebhookRepository {
  static get(eventKey: string): Promise<WebhookLedgerRecord | null> {
    return readVal<WebhookLedgerRecord>(paths.webhook(eventKey));
  }

  /**
   * Atomically claims a webhook event for processing (replaces the Mongo unique index on
   * WebhookLedger.eventId plus the "stuck PROCESSING > 2 minutes" reclaim).
   */
  static async claim(
    eventKey: string,
    init: Omit<WebhookLedgerRecord, 'status' | 'createdAt' | 'updatedAt'>,
    now: number,
    stuckAfterMs: number,
  ): Promise<WebhookClaimOutcome> {
    let outcome: WebhookClaimOutcome = 'CLAIMED';
    await dbRef(paths.webhook(eventKey)).transaction((current: WebhookLedgerRecord | null) => {
      if (current === null) {
        outcome = 'CLAIMED';
        return stripUndefined({ ...init, status: 'PROCESSING', createdAt: now, updatedAt: now });
      }
      if (current.status === 'PROCESSED') {
        outcome = 'ALREADY_PROCESSED';
        return undefined;
      }
      const startedAt = current.updatedAt ?? current.createdAt ?? 0;
      if (current.status === 'PROCESSING' && now - startedAt < stuckAfterMs) {
        outcome = 'IN_FLIGHT';
        return undefined;
      }
      // Stuck PROCESSING or FAILED: take it over and process again.
      outcome = 'RECLAIMED';
      const { errorMessage: _ignored, ...rest } = current;
      return stripUndefined({ ...rest, status: 'PROCESSING', updatedAt: now });
    });
    return outcome;
  }

  static async markProcessed(eventKey: string, now: number): Promise<void> {
    await dbRef(paths.webhook(eventKey)).update({
      status: 'PROCESSED',
      processedAt: now,
      updatedAt: now,
      errorMessage: null,
    });
  }

  static async markFailed(eventKey: string, message: string, now: number): Promise<void> {
    await dbRef(paths.webhook(eventKey)).update({
      status: 'FAILED',
      errorMessage: message.slice(0, 2000),
      updatedAt: now,
    });
  }
}
