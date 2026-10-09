import { defineConfig } from 'vitest/config';

/**
 * `vitest run`                    → in-memory RTDB + in-memory Auth (no Firebase project is ever reached)
 * `vitest run --mode rtdb-live`   → same suite against the REAL Realtime Database, in a throw-away
 *                                   staging_nanobrowser_<timestamp> namespace (deleted after each test
 *                                   file). Credentials come from backend/.env or the environment.
 */
export default defineConfig(({ mode }) => {
  const live = mode === 'rtdb-live' || process.env.RTDB_TEST_TARGET === 'live';

  const env: Record<string, string> = live
    ? {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        RTDB_TEST_TARGET: 'live',
        NANOBROWSER_RTDB_ROOT: process.env.NANOBROWSER_RTDB_ROOT?.startsWith('staging_')
          ? process.env.NANOBROWSER_RTDB_ROOT
          : `staging_nanobrowser_${Date.now()}`,
      }
    : {
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        RTDB_TEST_TARGET: 'memory',
        // Never let a local backend/.env point the test run at a real Firebase project.
        FIREBASE_ADMIN_CLIENT_EMAIL: '',
        FIREBASE_ADMIN_PRIVATE_KEY: '',
        FIREBASE_DATABASE_URL: '',
        NEXT_PUBLIC_FIREBASE_DATABASE_URL: '',
        FIREBASE_PROJECT_ID: 'nanobrowser-test',
        NANOBROWSER_RTDB_ROOT: 'nanobrowser',
      };

  return {
    test: {
      fileParallelism: false,
      environment: 'node',
      // Real network round trips (and RTDB transaction retries) are much slower than memory.
      testTimeout: live ? 180000 : 15000,
      hookTimeout: 180000,
      setupFiles: ['./src/tests/globalSetup.ts'],
      env,
    },
  };
});
