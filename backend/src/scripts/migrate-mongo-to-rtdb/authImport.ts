/**
 * Firebase Auth user import for the MongoDB → RTDB migration (step 1 of 2).
 *
 * RTDB data is keyed by Firebase uid, but the old users only exist in MongoDB. This step gives every
 * Mongo user a Firebase Auth account and produces the uid map the data migration (step 2) uses:
 *
 *   - Email already has a Firebase account (the Auth project is shared with JobForm Automator):
 *     no import; the Mongo user is mapped to that existing uid (or skipped with --existing-email skip).
 *   - A Firebase account with uid = Mongo _id already exists (an earlier run): mapped, not re-imported.
 *   - Otherwise: imported with uid = Mongo _id, the bcrypt password hash (users keep their password),
 *     Google sign-in linked via providerData, and suspended users disabled.
 *
 * MongoDB is only read. Firebase Auth is only read unless `execute` is true.
 */

import type { MongoDoc, MongoSource } from './types.js';
import { MONGO_COLLECTIONS } from './types.js';
import { idOf } from './transform.js';

/** Minimal slice of firebase-admin Auth used here (the in-memory test Auth implements it too). */
export interface AuthImportTarget {
  getUsers(
    identifiers: Array<{ uid: string } | { email: string }>,
  ): Promise<{ users: Array<{ uid: string; email?: string }> }>;
  importUsers(
    users: any[],
    options?: { hash: { algorithm: 'BCRYPT' } },
  ): Promise<{
    successCount: number;
    failureCount: number;
    errors: Array<{ index: number; error: { message: string; code?: string } }>;
  }>;
}

export interface AuthImportOptions {
  execute: boolean;
  /** What to do when the email already has a Firebase account: map to it (default) or skip the user. */
  existingEmail?: 'map' | 'skip';
  /** Only this user (Mongo id or email). */
  user?: string;
}

export interface AuthImportReport {
  mode: 'dry-run' | 'execute';
  read: number;
  toImport: number;
  imported: number;
  alreadyImported: number;
  mappedToExistingAccount: number;
  skipped: number;
  failed: number;
  withPassword: number;
  withGoogle: number;
  withoutCredentials: number;
  disabled: number;
  /** Accounts created by this run (for rollback). */
  importedUids: string[];
  issues: Array<{ legacyId: string; kind: 'skipped' | 'failed' | 'mapped' | 'warning'; reason: string }>;
}

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const LOOKUP_BATCH = 50; // getUsers accepts up to 100 identifiers; each user is looked up by uid and email
const IMPORT_BATCH = 1000;

function importRecord(doc: MongoDoc, legacyId: string, email: string) {
  const record: Record<string, any> = {
    uid: legacyId,
    email,
    emailVerified: Boolean(doc.googleLinked || doc.googleId),
    disabled: doc.status === 'suspended',
  };
  if (doc.name) record.displayName = String(doc.name).trim().slice(0, 100);
  if (doc.picture) record.photoURL = String(doc.picture);
  const createdAt = doc.createdAt instanceof Date ? doc.createdAt : doc.createdAt ? new Date(doc.createdAt) : null;
  if (createdAt && !Number.isNaN(createdAt.getTime())) record.metadata = { creationTime: createdAt.toUTCString() };
  if (typeof doc.passwordHash === 'string' && BCRYPT_HASH.test(doc.passwordHash)) {
    record.passwordHash = Buffer.from(doc.passwordHash);
  }
  if (doc.googleId) {
    record.providerData = [
      {
        uid: String(doc.googleId),
        providerId: 'google.com',
        email,
        displayName: record.displayName,
        photoURL: record.photoURL,
      },
    ];
  }
  return record;
}

export async function runAuthImport(
  source: MongoSource,
  auth: AuthImportTarget,
  options: AuthImportOptions,
): Promise<{ report: AuthImportReport; uidMap: Record<string, string> }> {
  const report: AuthImportReport = {
    mode: options.execute ? 'execute' : 'dry-run',
    read: 0,
    toImport: 0,
    imported: 0,
    alreadyImported: 0,
    mappedToExistingAccount: 0,
    skipped: 0,
    failed: 0,
    withPassword: 0,
    withGoogle: 0,
    withoutCredentials: 0,
    disabled: 0,
    importedUids: [],
    issues: [],
  };
  const uidMap: Record<string, string> = {};
  const userFilter = options.user?.trim().toLowerCase();
  const seenEmails = new Map<string, string>();

  // 1. Read users (MongoDB is only read)
  const users: Array<{ doc: MongoDoc; legacyId: string; email: string }> = [];
  for await (const doc of source.find(MONGO_COLLECTIONS.users)) {
    const legacyId = idOf(doc._id)!;
    const email = String(doc.email || '')
      .trim()
      .toLowerCase();
    if (userFilter && userFilter !== legacyId.toLowerCase() && userFilter !== email) continue;
    report.read++;
    if (!email) {
      report.skipped++;
      report.issues.push({ legacyId, kind: 'skipped', reason: 'no email address' });
      continue;
    }
    if (seenEmails.has(email)) {
      report.skipped++;
      report.issues.push({
        legacyId,
        kind: 'skipped',
        reason: `duplicate email (also Mongo user ${seenEmails.get(email)})`,
      });
      continue;
    }
    seenEmails.set(email, legacyId);
    users.push({ doc, legacyId, email });
  }

  // 2. Classify against Firebase Auth (read-only lookups)
  const toImport: Array<{ legacyId: string; record: Record<string, any> }> = [];
  for (let i = 0; i < users.length; i += LOOKUP_BATCH) {
    const batch = users.slice(i, i + LOOKUP_BATCH);
    const { users: found } = await auth.getUsers(batch.flatMap(u => [{ uid: u.legacyId }, { email: u.email }]));
    const byUid = new Map(found.map(user => [user.uid, user]));
    const byEmail = new Map(found.filter(user => user.email).map(user => [user.email!.toLowerCase(), user]));

    for (const { doc, legacyId, email } of batch) {
      if (byUid.has(legacyId)) {
        report.alreadyImported++;
        uidMap[legacyId] = legacyId;
        continue;
      }
      const existing = byEmail.get(email);
      if (existing) {
        if (options.existingEmail === 'skip') {
          report.skipped++;
          report.issues.push({
            legacyId,
            kind: 'skipped',
            reason: `email already has Firebase account ${existing.uid}`,
          });
        } else {
          report.mappedToExistingAccount++;
          uidMap[legacyId] = existing.uid;
          report.issues.push({
            legacyId,
            kind: 'mapped',
            reason: `email already has Firebase account ${existing.uid}; data will be stored under it`,
          });
        }
        continue;
      }
      const record = importRecord(doc, legacyId, email);
      if (record.passwordHash) report.withPassword++;
      else if (typeof doc.passwordHash === 'string' && doc.passwordHash) {
        report.issues.push({
          legacyId,
          kind: 'warning',
          reason: 'password hash is not bcrypt; imported without a password',
        });
      }
      if (record.providerData) report.withGoogle++;
      if (!record.passwordHash && !record.providerData) {
        report.withoutCredentials++;
        report.issues.push({
          legacyId,
          kind: 'warning',
          reason: 'no password or Google link; the user must reset the password',
        });
      }
      if (record.disabled) report.disabled++;
      toImport.push({ legacyId, record });
    }
  }
  report.toImport = toImport.length;

  // 3. Import (execute only), in batches; per-user failures are reported and left out of the uid map
  for (let i = 0; i < toImport.length; i += IMPORT_BATCH) {
    const batch = toImport.slice(i, i + IMPORT_BATCH);
    if (!options.execute) {
      for (const { legacyId } of batch) uidMap[legacyId] = legacyId;
      continue;
    }
    const needsHash = batch.some(item => item.record.passwordHash);
    const result = await auth.importUsers(
      batch.map(item => item.record),
      needsHash ? { hash: { algorithm: 'BCRYPT' } } : undefined,
    );
    const failedIndexes = new Set(result.errors.map(error => error.index));
    for (const error of result.errors) {
      report.failed++;
      report.issues.push({ legacyId: batch[error.index].legacyId, kind: 'failed', reason: error.error.message });
    }
    batch.forEach((item, index) => {
      if (!failedIndexes.has(index)) {
        report.imported++;
        report.importedUids.push(item.legacyId);
        uidMap[item.legacyId] = item.legacyId;
      }
    });
  }

  return { report, uidMap };
}
