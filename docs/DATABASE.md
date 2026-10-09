# Database Architecture & Data Contracts (Firebase Realtime Database)

The backend stores all of its data in **Firebase Realtime Database (RTDB)** — the same database and
access pattern as JobForm Automator — through the **Firebase Admin SDK**. MongoDB/Mongoose has been
removed. How the move was done, and how to migrate existing MongoDB data, is in
[FIREBASE_RTDB_MIGRATION.md](./FIREBASE_RTDB_MIGRATION.md).

- **Database:** the JobForm Automator Firebase project's RTDB (`FIREBASE_DATABASE_URL`).
- **Namespace:** every path is under one root node, `nanobrowser/` (`NANOBROWSER_RTDB_ROOT`), so this
  backend never touches JobForm Automator's own nodes (`user`, `users`, `hr`, `payment_records`, …).
- **Access:** server-only. The extension never talks to RTDB directly; the security rules deny all
  client access to `nanobrowser/` and only declare indexes (`backend/firebase/nanobrowser.rtdb-rules.fragment.json`).
- **Code layout:** `backend/src/services/rtdb/` — `client.ts` (the only DB handle + every path),
  `repositories.ts` (the only raw RTDB calls), `records.ts` (stored shapes), `serializers.ts` (API
  shapes), `rtdbUtils.ts` / `mappers.ts` (safety helpers). Domain services (`credit.service.ts`,
  `trial.service.ts`, …) use the repositories; controllers use the services.

---

## Data layout

All timestamps are stored as Unix milliseconds and returned by the API as ISO-8601 strings (as with
MongoDB). Every per-user node is keyed by the Firebase uid.

| Path (under `nanobrowser/`) | Contents | Replaces (Mongo) |
|---|---|---|
| `users/{uid}/profile` | name, email, role, status, googleLinked, googleId, picture, legacyId | `users` (non-auth fields; passwords live in Firebase Auth) |
| `trial_flags/{uid}` | `{ hasUsedTrial, trialUsedAt }` | `User.hasUsedTrial / trialUsedAt` |
| `subscription_plans/{code}` | plan config | `plans` |
| `subscriptions/{uid}` | current subscription (Mongo field names: `planCodeSnapshot`, …) | `subscriptions` (+ "one active per user" index) |
| `subscription_history/{uid}/{subscriptionId}` | older subscriptions (migrated data) | `subscriptions` |
| `provider_subscriptions/{razorpaySubId}` | `{ uid, subscriptionId }` | unique `providerSubscriptionId` index |
| `credit_balances/{uid}` | allocated / used / remaining credits, period | `usercreditbalances` |
| `credit_ledger/{uid}/{entryId}` | append-only audit entries (`runId` copied to top level) | `creditledgers` |
| `credit_ledger_meta/{uid}/count` | ledger size for paginated totals | `countDocuments` |
| `credit_idempotency/{uid}/{sha256(key)}` | `{ status: PENDING \| COMPLETED, entryId }` | unique `idempotencyKey` index |
| `career_brains/{uid}` | Career Brain profile + `tier` + `dailyQuota` | `careerbrains` |
| `job_applications/{uid}/{appId}` | job applications | `jobapplications` |
| `job_application_keys/{uid}/{sha256(jobId)}` | appId owning that jobId | unique `{userId, jobId}` index |
| `job_applications_meta/{uid}/count` | total for pagination | `countDocuments` |
| `llm_usage/{uid}/{usageId}` | LLM usage logs | `llmusagelogs` |
| `llm_usage_meta/{uid}/count` | total for pagination | `countDocuments` |
| `processed_webhooks/{eventKey}` | webhook idempotency ledger (payload stored as JSON text) | `webhookledgers` |
| `_migrations/mongo_to_rtdb/…` | migration markers and run summaries | — |
| `_health/ping` | read by the readiness probe | — |

`refreshtokens` has no equivalent: sessions are managed by Firebase Auth.

### Stored-shape notes
- `career_brains/{uid}`: the API fields `skillExperience` (`Record<skill, years>`) and `customAnswers`
  (`Record<question, answer>`) are stored as `skillExperienceList` / `customAnswersList` entry lists,
  because user text such as `Node.js`, `C#` or `Pune/Delhi?` cannot be an RTDB key. The API rebuilds the maps.
- Arrays are stored by RTDB as index-keyed objects and empty arrays/objects are not stored at all;
  serializers always return arrays/objects with the old Mongoose defaults.

## Indexes

Declared in `backend/firebase/nanobrowser.rtdb-rules.fragment.json` (the test suite fails any query
that isn't covered):

| Path | `.indexOn` | Used by |
|---|---|---|
| `nanobrowser/subscriptions` | `status` | bulk expiry reconciliation (cron) |
| `nanobrowser/credit_ledger/$uid` | `createdAt`, `runId` | history pagination, refunds per agent run |
| `nanobrowser/job_applications/$uid` | `updatedAt`, `status` | listing, status filter |
| `nanobrowser/llm_usage/$uid` | `createdAt`, `idempotencyKey` | usage history, LLM idempotency |

## Integrity guarantees

| Guarantee | How |
|---|---|
| Credits never go negative; concurrent deductions are safe | transaction on `credit_balances/{uid}` |
| An idempotency key deducts/refunds once | transaction claim on `credit_idempotency/{uid}/…` before the balance changes |
| One trial per user, ever | transaction claim on `trial_flags/{uid}` |
| One current subscription per user | single node `subscriptions/{uid}` |
| A Razorpay subscription belongs to one user | transaction claim on `provider_subscriptions/{id}` |
| One application per `{user, jobId}` | transaction claim on `job_application_keys/{uid}/{hash}` |
| A webhook event is processed once (stuck events reclaimed after 2 min) | transaction claim on `processed_webhooks/{eventKey}` |
| Subscription change + credit allocation + ledger entry land together | one multi-location `update()` |
| Daily quota never exceeds the plan limit | transaction on `career_brains/{uid}/dailyQuota` |
| User isolation | every path is built from the authenticated uid and validated (`assertSafeUid`) |
