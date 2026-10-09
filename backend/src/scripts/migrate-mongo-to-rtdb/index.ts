/**
 * MongoDB → Firebase RTDB migration CLI.
 *
 *   pnpm -F @nanobrowser/backend migrate:mongo-to-rtdb -- [options]
 *   (or: npx tsx src/scripts/migrate-mongo-to-rtdb/index.ts [options])
 *
 * DRY RUN IS THE DEFAULT. Nothing is written to Firebase unless --execute is given together with
 * --confirm-project <FIREBASE_PROJECT_ID>. MongoDB is only ever read (find / countDocuments).
 *
 * Source (one of):
 *   --mongo-uri <uri>          live MongoDB (or env MIGRATION_MONGO_URI, then MONGO_URI). Use a read-only user.
 *   --mongo-db <name>          database name if not in the URI
 *   --from-export <dir>        mongoexport output: <dir>/<collection>.json (Extended JSON)
 *
 * Users → Firebase uid:
 *   --uid-strategy mongo-id    (default) uid = the Mongo user _id (import Auth users with the same uid)
 *   --uid-strategy email       uid = existing Firebase Auth user with the same email (read-only lookup)
 *   --uid-map <file.json>      { "<mongoUserId or email>": "<firebaseUid>" } — overrides the strategy
 *
 * Scope / safety:
 *   --dry-run                  (default) read, transform and report only
 *   --execute                  write to Firebase RTDB (requires --confirm-project)
 *   --confirm-project <id>     must equal FIREBASE_PROJECT_ID
 *   --only plans,webhooks,users
 *   --user <mongoId|email>     migrate a single user
 *   --overwrite                replace RTDB data that did not come from this migration
 *   --no-rtdb-check            dry run without reading RTDB (no Firebase credentials needed)
 *   --report <file.json>       write the full JSON report
 */

import fs from 'node:fs';
import { adminAuth, adminDb, hasAdminCredentials } from '../../config/firebase-admin.js';
import { env } from '../../config/env.js';
import { RTDB_ROOT } from '../../services/rtdb/client.js';
import { createExportFileSource, createMongoSource } from './source.js';
import { createRtdbTarget, type RtdbHandle } from './target.js';
import { runMigration, type MigrationPart, type UidStrategy } from './migrate.js';
import type { MigrationReport, MongoSource } from './types.js';

interface CliArgs {
  execute: boolean;
  confirmProject?: string;
  mongoUri?: string;
  mongoDb?: string;
  fromExport?: string;
  uidStrategy: UidStrategy;
  uidMap?: string;
  only?: MigrationPart[];
  user?: string;
  overwrite: boolean;
  rtdbCheck: boolean;
  report?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, uidStrategy: 'mongo-id', overwrite: false, rtdbCheck: true, help: false };
  const value = (i: number, flag: string) => {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--dry-run':
        args.execute = false;
        break;
      case '--execute':
        args.execute = true;
        break;
      case '--confirm-project':
        args.confirmProject = value(i++, arg);
        break;
      case '--mongo-uri':
        args.mongoUri = value(i++, arg);
        break;
      case '--mongo-db':
        args.mongoDb = value(i++, arg);
        break;
      case '--from-export':
        args.fromExport = value(i++, arg);
        break;
      case '--uid-strategy': {
        const strategy = value(i++, arg);
        if (strategy !== 'mongo-id' && strategy !== 'email')
          throw new Error('--uid-strategy must be mongo-id or email');
        args.uidStrategy = strategy;
        break;
      }
      case '--uid-map':
        args.uidMap = value(i++, arg);
        break;
      case '--only': {
        const parts = value(i++, arg)
          .split(',')
          .map(part => part.trim()) as MigrationPart[];
        for (const part of parts) {
          if (!['plans', 'webhooks', 'users'].includes(part)) throw new Error(`Unknown --only part: ${part}`);
        }
        args.only = parts;
        break;
      }
      case '--user':
        args.user = value(i++, arg);
        break;
      case '--overwrite':
        args.overwrite = true;
        break;
      case '--no-rtdb-check':
        args.rtdbCheck = false;
        break;
      case '--report':
        args.report = value(i++, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage(): string {
  const file = fs.readFileSync(new URL(import.meta.url), 'utf8');
  return file.slice(file.indexOf('/**'), file.indexOf('*/') + 2);
}

function printReport(report: MigrationReport): void {
  const rows = Object.entries(report.entities).map(([entity, s]) => ({ entity, ...s }));
  console.log(`\n=== Mongo → RTDB migration (${report.mode.toUpperCase()}) — run ${report.runId} ===`);
  console.log(`source: ${report.source}`);
  console.log(`target: ${report.target}`);
  console.log(`uid strategy: ${report.uidStrategy}`);
  console.table(rows);
  console.log('users:', report.users);
  console.log('writes:', report.mode === 'dry-run' ? { planned: report.writes } : report.writes);
  if (report.missingCollections.length)
    console.log('collections not found in source:', report.missingCollections.join(', '));
  if (report.sanitizedMetadataKeys) console.log(`metadata keys renamed for RTDB: ${report.sanitizedMetadataKeys}`);
  if (report.issues.length) {
    console.log(
      `\n${report.issues.length} issue(s)${report.issues.length > 50 ? ' (first 50 shown; see --report for all)' : ''}:`,
    );
    for (const issue of report.issues.slice(0, 50)) {
      console.log(
        `  [${issue.kind}] ${issue.entity}${issue.legacyId ? ` ${issue.legacyId}` : ''}${issue.uid ? ` → ${issue.uid}` : ''}: ${issue.reason}`,
      );
    }
  }
  if (report.users.withPassword) {
    console.log(
      `\nNOTE: ${report.users.withPassword} user(s) have bcrypt password hashes in MongoDB. Passwords are not stored in RTDB; ` +
        'those accounts must be imported into Firebase Auth (same uid) for the users to sign in.',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  // ── Safety checks for writes ────────────────────────────────────────────────
  if (args.execute) {
    if (!hasAdminCredentials() || !adminDb) {
      throw new Error(
        '--execute needs Firebase Admin credentials (FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY / FIREBASE_DATABASE_URL).',
      );
    }
    if (!args.confirmProject || args.confirmProject !== env.FIREBASE_PROJECT_ID) {
      throw new Error(
        `--execute requires --confirm-project ${env.FIREBASE_PROJECT_ID ?? '<FIREBASE_PROJECT_ID>'} (the target project).`,
      );
    }
  }

  // ── Source (read-only) ──────────────────────────────────────────────────────
  let source: MongoSource;
  if (args.fromExport) {
    source = createExportFileSource(args.fromExport);
  } else {
    const uri = args.mongoUri || process.env.MIGRATION_MONGO_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('Provide --mongo-uri, MIGRATION_MONGO_URI / MONGO_URI, or --from-export <dir>.');
    source = await createMongoSource(uri, args.mongoDb);
  }

  // ── Target ──────────────────────────────────────────────────────────────────
  const canUseRtdb = Boolean(adminDb) && hasAdminCredentials();
  const db = args.execute || (args.rtdbCheck && canUseRtdb) ? (adminDb as unknown as RtdbHandle) : null;
  if (!args.execute && args.rtdbCheck && !canUseRtdb) {
    console.warn('Firebase credentials not configured: dry run continues without checking RTDB for existing data.');
  }
  const databaseHost = env.FIREBASE_DATABASE_URL ? new URL(env.FIREBASE_DATABASE_URL).host : 'no database configured';
  const target = createRtdbTarget({
    db,
    dryRun: !args.execute,
    label: `${env.FIREBASE_PROJECT_ID ?? '(no project)'} / ${databaseHost} / namespace /${RTDB_ROOT}${db ? '' : ' (not read)'}`,
  });

  let uidMap: Record<string, string> | undefined;
  if (args.uidMap) {
    const raw = JSON.parse(fs.readFileSync(args.uidMap, 'utf8')) as Record<string, string>;
    uidMap = Object.fromEntries(
      Object.entries(raw).map(([key, uid]) => [key.includes('@') ? key.trim().toLowerCase() : key.trim(), uid]),
    );
  }

  const lookupUidByEmail =
    args.uidStrategy === 'email'
      ? async (email: string) => {
          if (!adminAuth || !hasAdminCredentials())
            throw new Error('--uid-strategy email needs Firebase Admin credentials');
          try {
            return (await adminAuth.getUserByEmail(email)).uid;
          } catch (error: any) {
            if (error?.code === 'auth/user-not-found') return null;
            throw error;
          }
        }
      : undefined;

  try {
    const report = await runMigration(source, target, {
      uidStrategy: args.uidStrategy,
      uidMap,
      lookupUidByEmail,
      overwrite: args.overwrite,
      only: args.only,
      user: args.user,
    });
    printReport(report);
    if (args.report) {
      fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
      console.log(`\nReport written to ${args.report}`);
    }
    const failures = Object.values(report.entities).reduce((sum, s) => sum + s.failed, 0);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await source.close();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(error => {
    console.error(`Migration aborted: ${error?.message || error}`);
    process.exit(1);
  });
