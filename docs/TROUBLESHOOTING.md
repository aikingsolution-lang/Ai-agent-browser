# Troubleshooting & Runbook

## 1. Common Issues & Solutions

### A. Database Unavailable (Firebase Realtime Database)
- **Symptom**: `/ready` returns 503 and API routes return `503 SERVICE_UNAVAILABLE`; the startup log says "Firebase Realtime Database not configured" or "Database initialisation deferred".
- **Cause**: `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY` or `FIREBASE_DATABASE_URL` is missing or wrong (the private key must keep its `\n` line breaks).
- **Fix**: Set the four `FIREBASE_*` variables in `backend/.env` (or Cloud Run secrets) — see [ENVIRONMENT.md](./ENVIRONMENT.md). `GET /ready` reports `database.state`, `latencyMs` and whether a service account is configured.
- **Queries slow / "Using an unspecified index" warnings**: the `nanobrowser` `.indexOn` rules are missing — see [FIREBASE_RTDB_MIGRATION.md](./FIREBASE_RTDB_MIGRATION.md#2-security-rules-and-indexes-manual-not-deployed-automatically).

### B. Chrome Debugger Detached Banner Appears
- **Symptom**: User clicks "Cancel" on Chrome's native debugger notification at the top of the browser.
- **Behavior**: Extension detects debugger detach, halts runner cleanly, and automatically refunds credits for incomplete runs.
- **Fix**: Re-trigger run from Side Panel.

### C. Razorpay Webhook Signature Mismatch
- **Symptom**: Webhook returns HTTP 401 `INVALID_SIGNATURE`.
- **Cause**: Webhook payload was parsed as string or modified before HMAC verification, or secret mismatch.
- **Fix**: Verify `RAZORPAY_WEBHOOK_SECRET` matches Razorpay dashboard. Note that the webhook uses `express.raw()` to preserve raw binary Buffer.

### D. Job Search Displays Candidate Name Instead of Role
- **Symptom**: Search query field displays "Jane Doe" instead of "Software Engineer".
- **Fix**: Already guarded by `isCandidateNameOrInvalidTitle` and `sanitizeRoleSearchQuery`. Verify candidate has filled target role preferences in CareerBrain.
