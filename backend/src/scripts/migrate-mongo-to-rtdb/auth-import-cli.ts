/**
 * Step 1 of the MongoDB → Firebase migration: create Firebase Auth accounts for the Mongo users.
 *
 *   pnpm -F @nanobrowser/backend migrate:auth-users -- [options]
 *
 * DRY RUN IS THE DEFAULT (Firebase Auth is only read). Accounts are created only with
 * --execute --confirm-project <FIREBASE_PROJECT_ID>. MongoDB is only ever read.
 *
 *   --mongo-uri <uri> | MIGRATION_MONGO_URI    live MongoDB (read-only user recommended)
 *   --mongo-db <name>
 *   --from-export <dir>                        mongoexport files instead of a live MongoDB
 *   --uid-map-out <file.json>                  (required) where to write { mongoUserId: firebaseUid }
 *                                              for step 2: migrate:mongo-to-rtdb --uid-map <file.json>
 *   --existing-email map|skip                  email already has a Firebase account: reuse it (default) or skip
 *   --user <mongoId|email>                     a single user — use this first with a test account
 *   --execute --confirm-project <id>           actually create the accounts
 *   --report <file.json>
 *
 * Passwords: bcrypt hashes from MongoDB are imported as-is (algorithm BCRYPT), so users keep their
 * password. Google users are linked through providerData (google.com + their Google id).
 */

import fs from 'node:fs';
import { adminAuth, hasAdminCredentials } from '../../config/firebase-admin.js';
import { env } from '../../config/env.js';
import { createExportFileSource, createMongoSource } from './source.js';
import { runAuthImport, type AuthImportTarget } from './authImport.js';
import type { MongoSource } from './types.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    const file = fs.readFileSync(new URL(import.meta.url), 'utf8');
    console.log(file.slice(file.indexOf('/**'), file.indexOf('*/') + 2));
    return;
  }
  const execute = process.argv.includes('--execute');
  const uidMapOut = arg('uid-map-out');
  if (!uidMapOut) throw new Error('--uid-map-out <file.json> is required (step 2 needs it).');
  const existingEmail = (arg('existing-email') ?? 'map') as 'map' | 'skip';
  if (!['map', 'skip'].includes(existingEmail)) throw new Error('--existing-email must be map or skip');

  if (!hasAdminCredentials() || !adminAuth) {
    throw new Error(
      'Firebase Admin credentials are required (FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY / FIREBASE_PROJECT_ID).',
    );
  }
  if (execute && arg('confirm-project') !== env.FIREBASE_PROJECT_ID) {
    throw new Error(`--execute requires --confirm-project ${env.FIREBASE_PROJECT_ID ?? '<FIREBASE_PROJECT_ID>'}.`);
  }

  let source: MongoSource;
  const fromExport = arg('from-export');
  if (fromExport) {
    source = createExportFileSource(fromExport);
  } else {
    const uri = arg('mongo-uri') || process.env.MIGRATION_MONGO_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('Provide --mongo-uri, MIGRATION_MONGO_URI / MONGO_URI, or --from-export <dir>.');
    source = await createMongoSource(uri, arg('mongo-db'));
  }

  try {
    const { report, uidMap } = await runAuthImport(source, adminAuth as unknown as AuthImportTarget, {
      execute,
      existingEmail,
      user: arg('user'),
    });

    console.log(
      `\n=== Firebase Auth user import (${report.mode.toUpperCase()}) — project ${env.FIREBASE_PROJECT_ID} ===`,
    );
    console.log(`source: ${source.describe()}`);
    const { issues, importedUids, ...counts } = report;
    console.table([counts]);
    for (const issue of issues.slice(0, 50)) console.log(`  [${issue.kind}] ${issue.legacyId}: ${issue.reason}`);
    if (issues.length > 50) console.log(`  … ${issues.length - 50} more (see --report)`);

    fs.writeFileSync(uidMapOut, JSON.stringify(uidMap, null, 2));
    console.log(
      `\nuid map (${Object.keys(uidMap).length} users) written to ${uidMapOut}${report.mode === 'dry-run' ? ' (planned: dry run)' : ''}`,
    );
    const reportPath = arg('report');
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await source.close();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(error => {
    console.error(`Auth import aborted: ${error?.message || error}`);
    process.exit(1);
  });
