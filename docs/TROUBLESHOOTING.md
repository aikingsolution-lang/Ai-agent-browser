# Troubleshooting & Runbook

## 1. Common Issues & Solutions

### A. MongoDB Connection Failure
- **Symptom**: Backend crashes on startup with `MongooseServerSelectionError`.
- **Cause**: MongoDB is not running locally on port 27017 or `MONGO_URI` is incorrect.
- **Fix**: Ensure MongoDB service is running (`net start MongoDB` or `docker run -p 27017:27017 mongo`) or verify connection string in `backend/.env`.

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
