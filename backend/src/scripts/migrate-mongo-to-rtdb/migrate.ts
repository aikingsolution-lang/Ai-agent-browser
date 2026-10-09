/**
 * MongoDB → Firebase RTDB migration orchestrator.
 *
 * Reads every collection of the old Mongo backend (read-only) and writes the same data to the
 * nanobrowser/ namespace in the shape the RTDB services use. Nothing in MongoDB is modified.
 *
 * Per user (keyed by Firebase uid):
 *   users/{uid}/profile, trial_flags/{uid}, subscriptions/{uid}, subscription_history/{uid}/*,
 *   provider_subscriptions/*, credit_balances/{uid}, credit_ledger/{uid}/*, credit_idempotency/{uid}/*,
 *   career_brains/{uid}, job_applications/{uid}/*, job_application_keys/{uid}/*, llm_usage/{uid}/*,
 *   per-user counters, and finally _migrations/mongo_to_rtdb/users/{uid} (the completion marker).
 * Global: subscription_plans/*, processed_webhooks/*.
 *
 * Re-running is safe: records keep their Mongo ids as keys, users with a completion marker are
 * skipped, and a user whose profile carries the same legacyId (an interrupted earlier run) is
 * resumed. Existing RTDB data that did NOT come from this migration is never overwritten unless
 * --overwrite is given.
 */

import { paths } from '../../services/rtdb/client.js';
import { assertSafeUid, hashKey, keyForExternalId, newId, todayString } from '../../services/rtdb/rtdbUtils.js';
import type { SubscriptionRecord } from '../../services/rtdb/records.js';
import type { RtdbTarget } from './target.js';
import {
  idOf,
  pickCurrentSubscription,
  transformCareerBrain,
  transformCreditBalance,
  transformJobApplication,
  transformLedgerEntry,
  transformLlmUsage,
  transformPlan,
  transformSubscription,
  transformTrialFlag,
  transformUserProfile,
  transformWebhook,
} from './transform.js';
import {
  emptyStats,
  MONGO_COLLECTIONS,
  type EntityName,
  type MigrationReport,
  type MongoDoc,
  type MongoSource,
} from './types.js';

export type UidStrategy = 'mongo-id' | 'email';
export type MigrationPart = 'plans' | 'webhooks' | 'users';

export interface MigrationOptions {
  uidStrategy: UidStrategy;
  /** Explicit mapping: Mongo user id (hex) or lower-cased email → Firebase uid. Wins over the strategy. */
  uidMap?: Record<string, string>;
  /** Firebase Auth lookup for the `email` strategy (read-only). */
  lookupUidByEmail?: (email: string) => Promise<string | null>;
  overwrite?: boolean;
  only?: MigrationPart[];
  /** Migrate just one user (Mongo id or email). */
  user?: string;
  now?: number;
  runId?: string;
}

async function collect(source: MongoSource, collection: string, filter: Record<string, unknown>): Promise<MongoDoc[]> {
  const docs: MongoDoc[] = [];
  for await (const doc of source.find(collection, filter)) docs.push(doc);
  return docs;
}

function newestByUpdatedAt<T extends { updatedAt?: number; createdAt?: number }>(items: T[]): T {
  return [...items].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0];
}

export async function runMigration(
  source: MongoSource,
  target: RtdbTarget,
  options: MigrationOptions,
): Promise<MigrationReport> {
  const now = options.now ?? Date.now();
  const today = todayString();
  const runId = options.runId ?? newId('run');
  const include = (part: MigrationPart) => !options.only || options.only.includes(part);

  const entities = Object.fromEntries(
    (Object.keys(MONGO_COLLECTIONS) as EntityName[]).map(name => [name, emptyStats()]),
  ) as MigrationReport['entities'];

  const report: MigrationReport = {
    runId,
    mode: target.dryRun ? 'dry-run' : 'execute',
    source: source.describe(),
    target: target.describe(),
    startedAt: new Date(now).toISOString(),
    uidStrategy: options.uidMap ? `${options.uidStrategy} + uid map` : options.uidStrategy,
    entities,
    users: { resolved: 0, unresolved: 0, alreadyMigrated: 0, conflicts: 0, withPassword: 0 },
    writes: target.stats,
    sanitizedMetadataKeys: 0,
    missingCollections: [],
    issues: [],
  };

  const existing = new Set(await source.listCollections());
  report.missingCollections = Object.values(MONGO_COLLECTIONS).filter(name => !existing.has(name));

  // ── Plans (global) ──────────────────────────────────────────────────────────
  if (include('plans')) {
    const stats = entities.plans;
    const seen = new Set<string>();
    const entries: Array<[string, unknown]> = [];
    for await (const doc of source.find(MONGO_COLLECTIONS.plans)) {
      stats.read++;
      try {
        const record = transformPlan(doc, now);
        if (!record.code) throw new Error('plan has no code');
        if (seen.has(record.code)) {
          stats.duplicates++;
          report.issues.push({
            entity: 'plans',
            legacyId: idOf(doc._id),
            kind: 'duplicate',
            reason: `duplicate plan code ${record.code}`,
          });
          continue;
        }
        seen.add(record.code);
        const path = paths.plan(record.code);
        if (!options.overwrite && (await target.exists(path))) {
          stats.skipped++;
          report.issues.push({
            entity: 'plans',
            legacyId: record.legacyId,
            kind: 'skipped',
            reason: `plan ${record.code} already exists in RTDB (use --overwrite to replace)`,
          });
          continue;
        }
        entries.push([path, record]);
        stats.migrated++;
      } catch (error: any) {
        stats.failed++;
        report.issues.push({ entity: 'plans', legacyId: idOf(doc._id), kind: 'failed', reason: error.message });
      }
    }
    await target.write(entries);
  }

  // ── Webhook ledger (global) ─────────────────────────────────────────────────
  if (include('webhooks')) {
    const stats = entities.webhooks;
    const seen = new Set<string>();
    let entries: Array<[string, unknown]> = [];
    for await (const doc of source.find(MONGO_COLLECTIONS.webhooks)) {
      stats.read++;
      try {
        const record = transformWebhook(doc, now);
        if (!record.eventId) throw new Error('webhook event has no eventId');
        const key = keyForExternalId(record.eventId);
        if (seen.has(key)) {
          stats.duplicates++;
          continue;
        }
        seen.add(key);
        const path = paths.webhook(key);
        if (!options.overwrite && (await target.exists(path))) {
          stats.skipped++;
          continue;
        }
        entries.push([path, record]);
        stats.migrated++;
        if (entries.length >= 500) {
          await target.write(entries);
          entries = [];
        }
      } catch (error: any) {
        stats.failed++;
        report.issues.push({ entity: 'webhooks', legacyId: idOf(doc._id), kind: 'failed', reason: error.message });
      }
    }
    await target.write(entries);
  }

  // ── Users and everything they own ───────────────────────────────────────────
  if (include('users')) {
    const perUserCollections: EntityName[] = [
      'subscriptions',
      'creditBalances',
      'creditLedger',
      'jobApplications',
      'careerBrains',
      'llmUsage',
    ];
    const totals: Partial<Record<EntityName, number>> = {};
    for (const name of perUserCollections) totals[name] = await source.count(MONGO_COLLECTIONS[name]);

    // Sessions are owned by Firebase Auth now: refresh tokens are counted and deliberately not migrated.
    const refreshTokens = await source.count(MONGO_COLLECTIONS.refreshTokens);
    entities.refreshTokens.read = refreshTokens;
    entities.refreshTokens.skipped = refreshTokens;

    const uidOwners = new Map<string, string>();
    const providerOwners = new Map<string, string>();
    const accounted: Partial<Record<EntityName, number>> = {};
    const account = (name: EntityName, n: number) => {
      accounted[name] = (accounted[name] ?? 0) + n;
    };

    /** Children of a user that won't be migrated are counted as skipped. */
    const skipChildren = async (userId: unknown) => {
      for (const name of perUserCollections) {
        const n = await source.count(MONGO_COLLECTIONS[name], { userId });
        entities[name].skipped += n;
        account(name, n);
      }
    };

    const userFilter = options.user?.trim().toLowerCase();

    for await (const userDoc of source.find(MONGO_COLLECTIONS.users)) {
      const legacyId = idOf(userDoc._id)!;
      const email = String(userDoc.email || '')
        .trim()
        .toLowerCase();
      if (userFilter && userFilter !== legacyId.toLowerCase() && userFilter !== email) continue;

      const stats = entities.users;
      stats.read++;
      if (userDoc.passwordHash) report.users.withPassword++;

      // 1. Resolve the Firebase uid
      let uid: string | undefined = options.uidMap?.[legacyId] ?? (email ? options.uidMap?.[email] : undefined);
      if (!uid && options.uidStrategy === 'mongo-id') uid = legacyId;
      if (!uid && options.uidStrategy === 'email' && email && options.lookupUidByEmail) {
        uid = (await options.lookupUidByEmail(email)) ?? undefined;
      }
      if (!uid) {
        report.users.unresolved++;
        stats.skipped++;
        report.issues.push({
          entity: 'users',
          legacyId,
          kind: 'skipped',
          reason: 'no Firebase uid for this user (strategy/uid map)',
        });
        await skipChildren(userDoc._id);
        continue;
      }
      try {
        assertSafeUid(uid);
      } catch {
        stats.failed++;
        report.issues.push({
          entity: 'users',
          legacyId,
          kind: 'failed',
          reason: `resolved uid is not a valid RTDB key: ${uid}`,
        });
        await skipChildren(userDoc._id);
        continue;
      }
      if (uidOwners.has(uid)) {
        stats.duplicates++;
        report.issues.push({
          entity: 'users',
          legacyId,
          uid,
          kind: 'duplicate',
          reason: `uid already used by Mongo user ${uidOwners.get(uid)}`,
        });
        await skipChildren(userDoc._id);
        continue;
      }
      uidOwners.set(uid, legacyId);
      report.users.resolved++;

      // 2. Conflicts with data already in RTDB
      if (target.canRead && !options.overwrite) {
        if (await target.exists(paths.migrationUser(uid))) {
          report.users.alreadyMigrated++;
          stats.skipped++;
          await skipChildren(userDoc._id);
          continue;
        }
        // A profile carrying this user's legacyId means an earlier run was interrupted: resume it.
        const existingLegacyId = await target.read(`${paths.userProfile(uid)}/legacyId`);
        const existingProfile = await target.exists(paths.userProfile(uid));
        const resumable = existingProfile && existingLegacyId === legacyId;
        const hasNativeData =
          (existingProfile && !resumable) ||
          (!existingProfile &&
            ((await target.exists(paths.subscription(uid))) || (await target.exists(paths.creditBalance(uid)))));
        if (hasNativeData) {
          report.users.conflicts++;
          stats.skipped++;
          report.issues.push({
            entity: 'users',
            legacyId,
            uid,
            kind: 'skipped',
            reason: 'RTDB already has data for this uid that did not come from the migration (use --overwrite)',
          });
          await skipChildren(userDoc._id);
          continue;
        }
      }

      try {
        const owner = userDoc._id;
        const [subs, balances, brains, ledger, jobs, usage] = await Promise.all([
          collect(source, MONGO_COLLECTIONS.subscriptions, { userId: owner }),
          collect(source, MONGO_COLLECTIONS.creditBalances, { userId: owner }),
          collect(source, MONGO_COLLECTIONS.careerBrains, { userId: owner }),
          collect(source, MONGO_COLLECTIONS.creditLedger, { userId: owner }),
          collect(source, MONGO_COLLECTIONS.jobApplications, { userId: owner }),
          collect(source, MONGO_COLLECTIONS.llmUsage, { userId: owner }),
        ]);
        entities.subscriptions.read += subs.length;
        entities.creditBalances.read += balances.length;
        entities.careerBrains.read += brains.length;
        entities.creditLedger.read += ledger.length;
        entities.jobApplications.read += jobs.length;
        entities.llmUsage.read += usage.length;
        account('subscriptions', subs.length);
        account('creditBalances', balances.length);
        account('careerBrains', brains.length);
        account('creditLedger', ledger.length);
        account('jobApplications', jobs.length);
        account('llmUsage', usage.length);

        const core: Array<[string, unknown]> = [];
        const bulk: Array<[string, unknown]> = [];

        // Profile + trial flag
        core.push([paths.userProfile(uid), transformUserProfile(userDoc, now)]);
        const subRecords: SubscriptionRecord[] = subs.map(doc => transformSubscription(doc, uid!, now));
        const trialSub = subRecords.find(sub => sub.isTrial);
        const trialFlag =
          transformTrialFlag(userDoc, now) ??
          (trialSub ? { hasUsedTrial: true, trialUsedAt: trialSub.trialStartDate ?? trialSub.createdAt } : null);
        if (trialFlag) core.push([paths.trialFlag(uid), trialFlag]);

        // Subscriptions: one current + history
        const { current, history, extraEntitled } = pickCurrentSubscription(subRecords);
        if (current) core.push([paths.subscription(uid), current]);
        for (const sub of history) core.push([paths.subscriptionHistoryEntry(uid, sub.subscriptionId), sub]);
        entities.subscriptions.migrated += subRecords.length;
        if (extraEntitled > 0) {
          entities.subscriptions.duplicates += extraEntitled;
          report.issues.push({
            entity: 'subscriptions',
            legacyId,
            uid,
            kind: 'duplicate',
            reason: `${extraEntitled} extra active subscription(s) kept in subscription_history`,
          });
        }
        for (const sub of subRecords) {
          if (!sub.providerSubscriptionId) continue;
          const key = keyForExternalId(sub.providerSubscriptionId);
          const previousOwner = providerOwners.get(key);
          if (previousOwner && previousOwner !== uid) {
            entities.subscriptions.duplicates++;
            report.issues.push({
              entity: 'subscriptions',
              legacyId: sub.subscriptionId,
              uid,
              kind: 'duplicate',
              reason: `Razorpay subscription ${sub.providerSubscriptionId} also belongs to ${previousOwner}; link not written`,
            });
            continue;
          }
          providerOwners.set(key, uid);
          core.push([
            paths.providerSubscription(key),
            {
              uid,
              subscriptionId: sub.subscriptionId,
              providerSubscriptionId: sub.providerSubscriptionId,
              linkedAt: sub.updatedAt,
            },
          ]);
        }

        // Credit balance (unique per user)
        if (balances.length > 0) {
          const records = balances.map(doc => transformCreditBalance(doc, now));
          core.push([paths.creditBalance(uid), newestByUpdatedAt(records)]);
          entities.creditBalances.migrated++;
          if (records.length > 1) {
            entities.creditBalances.duplicates += records.length - 1;
            report.issues.push({
              entity: 'creditBalances',
              legacyId,
              uid,
              kind: 'duplicate',
              reason: `${records.length} balances; kept the most recently updated`,
            });
          }
        }

        // Career Brain (unique per user)
        if (brains.length > 0) {
          const records = brains.map(doc => transformCareerBrain(doc, uid!, now, today));
          core.push([paths.careerBrain(uid), newestByUpdatedAt(records)]);
          entities.careerBrains.migrated++;
          if (records.length > 1) {
            entities.careerBrains.duplicates += records.length - 1;
            report.issues.push({
              entity: 'careerBrains',
              legacyId,
              uid,
              kind: 'duplicate',
              reason: `${records.length} Career Brain documents; kept the most recently updated`,
            });
          }
        }

        // Credit ledger + idempotency claims (so retried requests stay idempotent after the switch)
        const claimedKeys = new Set<string>();
        for (const doc of ledger) {
          const { record, renamedKeys } = transformLedgerEntry(doc, uid, now);
          report.sanitizedMetadataKeys += renamedKeys;
          bulk.push([paths.creditLedgerEntry(uid, record.entryId), record]);
          if (record.idempotencyKey) {
            const keyHash = hashKey(record.idempotencyKey);
            if (claimedKeys.has(keyHash)) {
              entities.creditLedger.duplicates++;
            } else {
              claimedKeys.add(keyHash);
              bulk.push([
                paths.creditIdempotency(uid, keyHash),
                {
                  idempotencyKey: record.idempotencyKey,
                  status: 'COMPLETED',
                  entryId: record.entryId,
                  createdAt: record.createdAt,
                  completedAt: record.createdAt,
                },
              ]);
            }
          }
        }
        entities.creditLedger.migrated += ledger.length;

        // Job applications + {uid, jobId} uniqueness keys
        const jobRecords = jobs.map(doc => transformJobApplication(doc, uid!, now));
        const byJobKey = new Map<string, typeof jobRecords>();
        for (const record of jobRecords) {
          bulk.push([paths.jobApplication(uid, record.appId), record]);
          const key = hashKey(record.jobId);
          byJobKey.set(key, [...(byJobKey.get(key) ?? []), record]);
        }
        for (const [key, records] of byJobKey) {
          bulk.push([paths.jobApplicationKey(uid, key), newestByUpdatedAt(records).appId]);
          if (records.length > 1) {
            entities.jobApplications.duplicates += records.length - 1;
            report.issues.push({
              entity: 'jobApplications',
              legacyId,
              uid,
              kind: 'duplicate',
              reason: `${records.length} applications for one jobId; the newest owns the jobId key`,
            });
          }
        }
        entities.jobApplications.migrated += jobRecords.length;

        // LLM usage logs
        for (const doc of usage) {
          const { record, renamedKeys } = transformLlmUsage(doc, uid, now);
          report.sanitizedMetadataKeys += renamedKeys;
          bulk.push([paths.llmUsageEntry(uid, record.usageId), record]);
        }
        entities.llmUsage.migrated += usage.length;

        // Write: core → lists → counters + completion marker (last, so an interrupted user is resumed)
        await target.write(core);
        await target.write(bulk);
        await target.write([
          [paths.creditLedgerCount(uid), ledger.length],
          [paths.jobApplicationCount(uid), jobRecords.length],
          [paths.llmUsageCount(uid), usage.length],
          [
            paths.migrationUser(uid),
            {
              legacyId,
              runId,
              migratedAt: now,
              counts: {
                subscriptions: subs.length,
                ledger: ledger.length,
                jobApplications: jobs.length,
                llmUsage: usage.length,
              },
            },
          ],
        ]);
        stats.migrated++;
      } catch (error: any) {
        stats.failed++;
        report.issues.push({ entity: 'users', legacyId, uid, kind: 'failed', reason: error.message });
      }
    }

    // Documents whose owner is not a migrated/skipped user (deleted users, or outside --user)
    for (const name of perUserCollections) {
      if (!userFilter) entities[name].orphans = Math.max(0, (totals[name] ?? 0) - (accounted[name] ?? 0));
    }

    if (!target.dryRun) {
      await target.write([
        [paths.migrationRun(runId), { startedAt: now, finishedAt: Date.now(), users: report.users, entities }],
      ]);
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
