/**
 * firebase-admin.ts
 *
 * Firebase Admin SDK singleton for the NanoBrowser Express backend.
 * Follows the same pattern as JobForm Automator's lib/firebase-admin.ts:
 *   - one app guarded by getApps()
 *   - credentials from FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY / FIREBASE_PROJECT_ID
 *   - if credentials are missing, initialise in project-only mode so the process still starts
 *   - Auth and Database are initialised independently, so one failing never blocks the other
 *
 * SECURITY: everything here is SERVER-ONLY. The Admin SDK bypasses RTDB security rules, so
 * every service that writes through `adminDb` scopes its paths to the authenticated uid.
 */

import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

function getOrCreateAdminApp(): App {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    return existingApps[0];
  }

  const projectId = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_ADMIN_PRIVATE_KEY;
  const databaseURL = env.FIREBASE_DATABASE_URL;

  if (!clientEmail || !privateKey) {
    if (env.NODE_ENV !== 'test') {
      logger.warn(
        '⚠️  [Firebase Admin] FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY not set. Initialisation deferred; ' +
          'database-backed routes will return 503 until credentials are provided.',
      );
    }
    return initializeApp({ projectId: projectId || 'demo-project', databaseURL });
  }

  try {
    const app = initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      databaseURL,
      storageBucket: env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`,
    });
    logger.info('✅ [Firebase Admin] Initialised with service account credentials.');
    return app;
  } catch (err: any) {
    logger.error(`❌ [Firebase Admin] Failed to initialise with cert: ${err.message}`);
    return initializeApp({ projectId: projectId || 'demo-project', databaseURL });
  }
}

// `let` exports are live bindings: setFirebaseAdminForTesting() below swaps them for every importer.
export let adminApp: App | null = null;
export let adminAuth: Auth | null = null;
export let adminDb: Database | null = null;

try {
  adminApp = getOrCreateAdminApp();
} catch (e: any) {
  logger.warn(`⚠️  [Firebase Admin] App initialisation deferred: ${e.message}`);
}

if (adminApp) {
  try {
    adminAuth = getAuth(adminApp);
  } catch (e: any) {
    logger.warn(`⚠️  [Firebase Admin] Auth initialisation deferred: ${e.message}`);
  }

  try {
    adminDb = getDatabase(adminApp);
  } catch (e: any) {
    if (env.NODE_ENV !== 'test') {
      logger.warn(`⚠️  [Firebase Admin] Database initialisation deferred: ${e.message}`);
    }
  }
}

/** True when a service account was configured (not just project-only mode). */
export function hasAdminCredentials(): boolean {
  return Boolean(env.FIREBASE_ADMIN_CLIENT_EMAIL && env.FIREBASE_ADMIN_PRIVATE_KEY);
}

/**
 * Test-only: replaces the RTDB / Auth handles (e.g. with the in-memory RTDB used by the test suite).
 * Refuses to run outside NODE_ENV=test so production can never be pointed at a fake.
 */
export function setFirebaseAdminForTesting(overrides: { db?: Database | null; auth?: Auth | null }): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error('setFirebaseAdminForTesting() is only available when NODE_ENV=test');
  }
  if ('db' in overrides) adminDb = overrides.db ?? null;
  if ('auth' in overrides) adminAuth = overrides.auth ?? null;
}
