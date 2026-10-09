import { afterAll } from 'vitest';
import { setFirebaseAdminForTesting, hasAdminCredentials } from '../config/firebase-admin.js';
import { RTDB_ROOT } from '../services/rtdb/client.js';
import { assertLiveTestNamespace, isLiveRtdb, memoryAuth, memoryDb, testDb } from './helpers/firebaseTestEnv.js';

if (isLiveRtdb) {
  // Live mode: real Realtime Database (staging_* namespace only), in-memory Auth.
  assertLiveTestNamespace();
  setFirebaseAdminForTesting({ auth: memoryAuth as any });
  afterAll(async () => {
    await testDb.ref(RTDB_ROOT).remove();
  });
} else {
  // Global safety: the default run must never reach a real Firebase project. vitest.config.ts blanks
  // every Firebase credential; fail loudly if one still got through.
  if (hasAdminCredentials()) {
    throw new Error(
      'FATAL SAFETY VIOLATION: Firebase Admin credentials are set while running tests. Tests must only use the in-memory RTDB.',
    );
  }

  // Every service reads Firebase through config/firebase-admin.ts, so swapping the handles here routes
  // all database and auth calls to the in-memory implementations.
  setFirebaseAdminForTesting({ db: memoryDb as any, auth: memoryAuth as any });
}
