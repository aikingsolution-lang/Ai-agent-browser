/**
 * firebaseTestEnv.ts
 *
 * Shared Firebase test environment, installed into config/firebase-admin.ts by globalSetup.ts.
 *
 *   Default:   in-memory RTDB (with the production `.indexOn` rules enforced) + in-memory Auth.
 *              vitest.config.ts blanks every Firebase credential, so no test can reach Firebase.
 *   Live mode: `pnpm test:rtdb-live` — the same suite against the REAL Realtime Database, inside a
 *              throw-away `staging_*` namespace that is deleted after every test file. Auth stays
 *              in memory, so Firebase Auth is never touched. Tests that would write outside the
 *              namespace (e.g. simulated JobForm Automator data at the root) are skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminDb, hasAdminCredentials } from '../../config/firebase-admin.js';
import { RTDB_ROOT } from '../../services/rtdb/client.js';
import { MemoryDatabase, indexRulesFrom } from './memoryRtdb.js';
import { MemoryAuth, idTokenFor } from './memoryAuth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULES_FRAGMENT_PATH = path.resolve(here, '../../../firebase/nanobrowser.rtdb-rules.fragment.json');

export function loadRulesFragment(): Record<string, any> {
  return JSON.parse(fs.readFileSync(RULES_FRAGMENT_PATH, 'utf8'));
}

/** True when the suite runs against the real Realtime Database (RTDB_TEST_TARGET=live). */
export const isLiveRtdb = process.env.RTDB_TEST_TARGET === 'live';

const LIVE_NAMESPACE = /^staging_[A-Za-z0-9_]+$/;

/** Refuses to run live tests anywhere except a throw-away staging_* namespace. */
export function assertLiveTestNamespace(): void {
  if (!hasAdminCredentials() || !adminDb) {
    throw new Error(
      'Live RTDB tests need FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY and FIREBASE_DATABASE_URL.',
    );
  }
  if (!LIVE_NAMESPACE.test(RTDB_ROOT)) {
    throw new Error(`Live RTDB tests only run inside a staging_* namespace (NANOBROWSER_RTDB_ROOT is "${RTDB_ROOT}").`);
  }
}

export const memoryDb = new MemoryDatabase();
memoryDb.setIndexRules(indexRulesFrom(loadRulesFragment()));

export const memoryAuth = new MemoryAuth();

/** The database the tests use: in-memory by default, the real RTDB (staging namespace) in live mode. */
export const testDb: any = isLiveRtdb ? adminDb : memoryDb;

/** Clears all test data: the in-memory DB, or the whole staging namespace in live mode. */
export async function resetFirebase(): Promise<void> {
  memoryAuth.reset();
  if (isLiveRtdb) {
    assertLiveTestNamespace();
    await testDb.ref(RTDB_ROOT).remove();
  } else {
    memoryDb.reset();
  }
}

/** True when nothing exists under the namespace (used to prove dry runs write nothing). */
export async function namespaceIsEmpty(): Promise<boolean> {
  return !(await testDb.ref(RTDB_ROOT).get()).exists();
}

/** Creates a Firebase Auth user (in memory) and returns its uid plus a Bearer header value. */
export async function createTestUser(props: { email?: string; name?: string; uid?: string } = {}) {
  const record = await memoryAuth.createUser({
    uid: props.uid,
    email: props.email ?? `user-${Math.random().toString(36).slice(2, 10)}@test.local`,
    displayName: props.name ?? 'Test User',
    password: 'Password123!',
  });
  return {
    uid: record.uid,
    email: record.email!,
    token: idTokenFor(record.uid),
    auth: `Bearer ${idTokenFor(record.uid)}`,
  };
}

/** Reads a raw node (absolute path, e.g. paths.subscription(uid)). */
export function readNode(dbPath: string): any {
  return testDb
    .ref(dbPath)
    .get()
    .then((snapshot: any) => snapshot.val());
}

export { idTokenFor };
