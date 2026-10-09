# MongoDB → Firebase Realtime Database

The NanoBrowser backend no longer uses MongoDB. It now uses the **JobForm Automator Firebase
Realtime Database**, following the same patterns as JobForm Automator (Firebase Admin SDK singleton,
uid-keyed data, server-only writes, transactions, `stripUndefined`, safe keys). This document covers
the architecture, the rules/index setup, and how to move existing MongoDB data.

Data contracts and the full path list: [DATABASE.md](./DATABASE.md).

---

## 1. Architecture

```
Chrome extension ──HTTPS + Firebase ID token──▶ Express backend (Cloud Run)
                                                   │  routes → controllers → services → rtdb/repositories
                                                   ▼
                              Firebase Admin SDK (FIREBASE_ADMIN_* service account)
                                                   ▼
                     JobForm Automator Realtime Database  ──  /nanobrowser/**   (this backend)
                                                          ──  /user, /users, /hr, … (JobForm Automator)
```

- **One namespace.** Every NanoBrowser path is below `nanobrowser/` (`NANOBROWSER_RTDB_ROOT`).
  JobForm Automator already uses root nodes that the first draft of this migration collided with —
  `users/{emailKey}` (public read, writable by any signed-in user) and `payment_records/{uid}/…` —
  so nothing is written at the root any more. The test suite checks that a full user lifecycle
  writes nothing outside the namespace.
- **Server-only.** The extension never reads or writes RTDB directly. The Admin SDK bypasses the
  security rules, so every service builds its paths from the authenticated uid and validates every
  segment (`assertSafeUid` / `isSafeKey`, as in JobForm Automator).
- **Fail closed.** Without Firebase credentials the server still starts, `/health` is 200, `/ready`
  is 503 and every database-backed route returns 503.

## 2. Security rules and indexes (manual, not deployed automatically)

JobForm Automator's `database.rules.json` already denies everything at the root, so `nanobrowser/`
is server-only without any change. What it is missing is the **indexes** the backend's queries need.
Merge this block into the `"rules"` object of JobForm Automator's `database.rules.json` (do **not**
deploy a separate rules file for this backend — RTDB has one rules file per database, and deploying
another one would replace JobForm Automator's rules):

```json
"nanobrowser": {
  ".read": false,
  ".write": false,
  "subscriptions": { ".indexOn": ["status"] },
  "credit_ledger": { "$uid": { ".indexOn": ["createdAt", "runId"] } },
  "job_applications": { "$uid": { ".indexOn": ["updatedAt", "status"] } },
  "llm_usage": { "$uid": { ".indexOn": ["createdAt", "idempotencyKey"] } }
}
```

The same block is in `backend/firebase/nanobrowser.rtdb-rules.fragment.json` (the tests read it).
**It has already been added to JobForm Automator's `database.rules.json`** (local change, not yet
deployed). To deploy: Firebase console → Realtime Database → Rules, compare the live rules with the
repository file (they should differ only by the `nanobrowser` block), paste the file and publish.
**The indexes are required before the backend serves traffic:** the live rehearsal showed that the
Realtime Database server rejects these `orderByChild(...).get()` queries without them
("Index not defined, add \".indexOn\" …"), so credit history, refunds by run, LLM usage history /
idempotency, job-application listing and trial reconciliation fail until the block is deployed.

## 3. Environment

| Variable | Notes |
|---|---|
| `FIREBASE_PROJECT_ID` | `jobform-automator-website` |
| `FIREBASE_DATABASE_URL` | `https://jobform-automator-website-default-rtdb.firebaseio.com` |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | service-account email (same variable name as JobForm Automator) |
| `FIREBASE_ADMIN_PRIVATE_KEY` | secret; Secret Manager on Cloud Run |
| `NANOBROWSER_RTDB_ROOT` | optional, default `nanobrowser` (e.g. `staging_nanobrowser` for a rehearsal) |

`MONGO_URI` is no longer read by the server. Keep the existing secret (unmounted) until the data
migration below has been verified.

## 4. RTDB differences handled in code

| Mongo behaviour | RTDB handling |
|---|---|
| `undefined` fields are ignored | RTDB rejects them synchronously → every write goes through `stripUndefined` |
| any string can be a map key | `.`, `#`, `$`, `/`, `[`, `]` are illegal → user-keyed maps stored as entry lists; external ids hashed when unsafe |
| `findOneAndUpdate` with a guard | transactions that never abort on the first `null` read (RTDB calls the update function with `null` before it knows the stored value — verified against the SDK in `rtdbContract.test.ts`) |
| unique indexes | claim nodes written in transactions (`credit_idempotency`, `trial_flags`, `provider_subscriptions`, `job_application_keys`, `processed_webhooks`) |
| multi-document writes | one multi-location `update()` (subscription + balance + ledger) |
| `skip/limit` + `countDocuments` | `orderByChild(...).limitToLast(page*limit)` + per-user counters |
| `Date` fields | Unix ms in storage, ISO strings in API responses (unchanged API) |

## 5. Migrating existing MongoDB data

Script: `backend/src/scripts/migrate-mongo-to-rtdb/` (`pnpm -F @nanobrowser/backend migrate:mongo-to-rtdb -- …`).

- **MongoDB is only read** (`find`, `countDocuments`, `listCollections`). Use a read-only database
  user; the driver uses `readPreference=secondaryPreferred`.
- **Dry run is the default.** Writing needs `--execute --confirm-project <FIREBASE_PROJECT_ID>`.
- Mongo ids are preserved (record keys or `legacyId`), timestamps are preserved, and every user's
  data is written under their Firebase uid.
- Re-runs are safe: each user gets a completion marker; interrupted users are resumed; RTDB data
  that did not come from the migration is never overwritten unless `--overwrite` is passed.

### What is migrated

| MongoDB | RTDB |
|---|---|
| `users` | `users/{uid}/profile`, `trial_flags/{uid}` (password hashes are **not** copied) |
| `plans` | `subscription_plans/{code}` (existing plans are kept unless `--overwrite`) |
| `subscriptions` | `subscriptions/{uid}` (current) + `subscription_history/{uid}/*`, `provider_subscriptions/*` |
| `usercreditbalances` | `credit_balances/{uid}` |
| `creditledgers` | `credit_ledger/{uid}/*`, `credit_idempotency/{uid}/*`, counter |
| `jobapplications` | `job_applications/{uid}/*`, `job_application_keys/{uid}/*`, counter |
| `careerbrains` | `career_brains/{uid}` (maps → entry lists) |
| `llmusagelogs` | `llm_usage/{uid}/*`, counter |
| `webhookledgers` | `processed_webhooks/*` |
| `refreshtokens` | not migrated (Firebase Auth owns sessions) — counted in the report |

### Which Firebase uid each Mongo user gets — step 1: Firebase Auth import

RTDB data is keyed by Firebase uid, so the Mongo users first get Firebase Auth accounts:
`pnpm migrate:auth-users` (`src/scripts/migrate-mongo-to-rtdb/auth-import-cli.ts`).

- New users are imported with **uid = Mongo `_id`**, their **bcrypt password hash** (they keep their
  password), Google sign-in linked (`google.com` + their Google id), and suspended users disabled.
- If the email **already has a Firebase account** (the Auth project is shared with JobForm
  Automator), no account is created: the Mongo user is mapped to the existing uid (their NanoBrowser
  data is stored under it). `--existing-email skip` leaves such users out instead.
- Accounts already imported by an earlier run are recognised by uid; re-runs are safe.
- It writes the uid map (`--uid-map-out uid-map.json`) that step 2 uses (`--uid-map uid-map.json`).
  Users missing from the map fall back to uid = Mongo `_id`.

Other options for step 2 without step 1: `--uid-strategy email` (map to existing Firebase accounts by
email, read-only) or a hand-written `--uid-map`.

### Procedure

All commands run in `backend/` with these in `backend/.env` (gitignored, never commit it):
`FIREBASE_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`,
`FIREBASE_DATABASE_URL` (the JobForm Automator values) and `MIGRATION_MONGO_URI` (a **read-only**
MongoDB user). Nothing below writes anything without `--execute --confirm-project`.

1. **Back up MongoDB** (Atlas snapshot or `mongodump`). Do not delete or modify it.
2. **Deploy the index rules** (section 2).
3. **Live check of the backend** against the real database (throw-away `staging_*` namespace, deleted afterwards; Firebase Auth is not touched):
   ```bash
   pnpm test:rtdb-live
   ```
4. **Dry runs** (read-only everywhere):
   ```bash
   pnpm migrate:auth-users -- --uid-map-out ./uid-map.json --report ./auth-dry-run.json
   pnpm migrate:mongo-to-rtdb -- --dry-run --uid-map ./uid-map.json --report ./migration-dry-run.json
   ```
   Review counts, mapped-to-existing-account users, skipped / duplicate / orphan records and issues.
5. **Trial with one test account**: import a single known account, then sign in with its old
   password and with Google to confirm the hash import (bcrypt `$2a$`) works on your project:
   ```bash
   pnpm migrate:auth-users -- --user test@example.com --uid-map-out ./uid-map-test.json --execute --confirm-project jobform-automator-website
   ```
6. **Rehearsal on a scratch namespace** (optional, recommended): set
   `NANOBROWSER_RTDB_ROOT=staging_nanobrowser` in `backend/.env`, run step 7's data migration
   command, spot-check through a staging backend, delete `staging_nanobrowser` in the console,
   and set the variable back.
7. **Freeze writes** to the old backend (maintenance window), then:
   ```bash
   pnpm migrate:auth-users -- --uid-map-out ./uid-map.json --execute --confirm-project jobform-automator-website --report ./auth.json
   pnpm migrate:mongo-to-rtdb -- --uid-map ./uid-map.json --execute --confirm-project jobform-automator-website --report ./migration.json
   ```
8. **Verify**: compare both reports with the dry runs; spot-check balances, subscriptions and Career
   Brains through the API; re-run step 4 — every user should be "alreadyImported" / "alreadyMigrated".
9. **Switch traffic** to the RTDB backend. Keep MongoDB and the `MONGO_URI` secret untouched until
   the new system has run correctly for an agreed period.

Do the migration **before** users start using the RTDB backend: a user who signs in first gets a
fresh free trial in RTDB, and the migration will then report that uid as a conflict instead of
overwriting it (`--overwrite` replaces it with the Mongo data).

### Rollback

The data migration only adds nodes under the namespace. To undo a run, delete `nanobrowser/` (or the
rehearsal namespace) in the Firebase console and redeploy the previous backend — MongoDB was never
changed. Imported Firebase Auth accounts (listed in `importedUids` of `auth.json`) can be deleted in
the Firebase console or with `auth.deleteUsers()`; accounts that already existed were never modified.

## 6. Tests

`pnpm -F @nanobrowser/backend test` runs everything against an in-memory RTDB
(`src/tests/helpers/memoryRtdb.ts`) that reproduces RTDB's write validation, transaction semantics,
array storage, ordering and `.indexOn` requirements. `rtdbContract.test.ts` checks the in-memory
database against the real `firebase-admin` SDK (offline). No test can reach a real Firebase project
or MongoDB.

`pnpm -F @nanobrowser/backend test:rtdb-live` runs the same suite against the **real** Realtime
Database (credentials from `backend/.env`) inside a throw-away `staging_nanobrowser_<timestamp>` node
that is deleted after every test file; it refuses to run in any namespace not starting with
`staging_`. Auth stays in memory, and tests that write simulated JobForm Automator data at the
root are skipped.

## 7. Admin scripts

| Script | Purpose |
|---|---|
| `src/scripts/activate_pro_user.ts --email … --plan pro [--execute]` | manually activate a paid plan |
| `src/scripts/topup_credits.ts --uid … --credits 500 [--execute]` | set a user's credits (ADMIN_ADJUSTMENT ledger entry) |
| `src/scripts/migrate-mongo-to-rtdb` | one-off data migration (section 5) |

All are dry runs unless `--execute` is given.
