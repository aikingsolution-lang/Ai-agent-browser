# Complete Backend API Reference

All application endpoints are served under the `/api/v1` prefix (except top-level health probes).
Base URL: `http://localhost:5000/api/v1`

---

## 1. System Health Probes

### GET `/health`
- **Auth**: None
- **Purpose**: Liveness and readiness probe for orchestration platforms (Kubernetes / ECS).
- **Response**: `200 OK`
  ```json
  { "status": "ok", "timestamp": "2026-10-05T12:00:00.000Z", "uptime": 124.5 }
  ```

---

## 2. Authentication (`/api/v1/auth`)

### POST `/api/v1/auth/register`
- **Rate Limit**: 10 req / 15 min
- **Auth**: None
- **Request Body**:
  ```json
  { "name": "Jane Doe", "email": "jane@example.com", "password": "Password123!" }
  ```
- **Success Response**: `201 Created`
  ```json
  {
    "success": true,
    "data": {
      "user": { "id": "67...", "name": "Jane Doe", "email": "jane@example.com", "role": "user" },
      "token": "eyJhbGciOiJIUzI1Ni...",
      "refreshToken": "eyJhbGciOiJIUzI1Ni...",
      "subscription": { "status": "TRIALING", "trialEndDate": "2026-10-12T..." }
    }
  }
  ```
- **Errors**: `409 Conflict` (EMAIL_EXISTS), `400 Bad Request` (Validation failure).

### POST `/api/v1/auth/login`
- **Rate Limit**: 10 req / 15 min
- **Request Body**:
  ```json
  { "email": "jane@example.com", "password": "Password123!" }
  ```
- **Success Response**: `200 OK` (Returns user, token, refreshToken).
- **Errors**: `401 Unauthorized` (INVALID_CREDENTIALS, ACCOUNT_SUSPENDED).

### POST `/api/v1/auth/google`
- **Request Body**: `{ "token": "<GoogleAccessToken>" }`
- **Purpose**: Authenticates or provisions user using Google OAuth v3. Automatically links existing accounts.

### POST `/api/v1/auth/refresh`
- **Request Body**: `{ "refreshToken": "eyJhbGciOi..." }`
- **Purpose**: Issues new Access Token and rotates Refresh Token. Detects reuse attacks and revokes all user sessions if reuse is detected.

### GET `/api/v1/auth/me`
- **Auth**: Bearer JWT required
- **Response**: Returns authenticated user profile and subscription status.

### POST `/api/v1/auth/logout`
- **Auth**: None (Takes `refreshToken` in body)
- **Purpose**: Revokes refresh token in database.

---

## 3. Subscriptions & Payments (`/api/v1/subscription`)

### GET `/api/v1/subscription/plans`
- **Auth**: None
- **Response**: List of active subscription plans (`free-trial`, `pro-monthly`, `enterprise-monthly`).

### GET `/api/v1/subscription/me`
- **Auth**: Bearer JWT
- **Response**: Current user subscription, period start/end, trial status, and plan details.

### POST `/api/v1/subscription/checkout`
- **Auth**: Bearer JWT
- **Request Body**: `{ "planCode": "pro-monthly" }`
- **Response**: Razorpay subscription session ID, keyId, and plan snapshot.

### POST `/api/v1/subscription/verify-payment`
- **Auth**: Bearer JWT
- **Request Body**:
  ```json
  {
    "paymentId": "pay_xyz123",
    "subscriptionId": "sub_abc456",
    "signature": "hmac_signature_hex"
  }
  ```
- **Response**: `200 OK` updates subscription to ACTIVE, resets/allocates credits, upgrades CareerBrain tier.

### POST `/api/v1/subscription/trial/activate`
- **Auth**: Bearer JWT
- **Purpose**: Activates initial 7-day free trial with 50 credits if user has not yet used it.

### POST `/api/v1/subscription/cancel`
- **Auth**: Bearer JWT
- **Purpose**: Sets `cancelAtPeriodEnd = true`. User retains access until period end.

---

## 4. Credits & Ledger (`/api/v1/credits`)

### GET `/api/v1/credits/balance`
- **Auth**: Bearer JWT
- **Response**: Current allocated, used, and remaining credit balance.

### GET `/api/v1/credits/history?page=1&limit=20`
- **Auth**: Bearer JWT
- **Response**: Paginated transaction log from `CreditLedger`.

### POST `/api/v1/credits/refund`
- **Auth**: Bearer JWT
- **Request Body**: `{ "runId": "run_123456" }`
- **Purpose**: Idempotently refunds credits consumed during a failed agent run.

---

## 5. Webhooks (`/api/v1/webhooks`)

### POST `/api/v1/webhooks/razorpay`
- **Headers**: `x-razorpay-signature: <hex_digest>`
- **Body**: Raw JSON Buffer
- **Handled Events**:
  - `subscription.activated`, `subscription.authenticated`: Sets status `ACTIVE`, allocates renewal credits.
  - `subscription.charged`: Advances billing period, top-ups credits.
  - `subscription.halted`, `payment.failed`: Sets status `PAST_DUE`.
  - `subscription.cancelled`: Cancels subscription.
  - `payment.captured`: Upgrades CareerBrain to premium.

---

## 6. Managed LLM Gateway (`/api/v1/llm`)

### POST `/api/v1/llm/chat` & POST `/api/v1/llm/chat/completions`
- **Auth**: Bearer JWT + Credit Check
- **Request Body**:
  ```json
  {
    "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "messages": [{ "role": "user", "content": "Extract skills..." }],
    "temperature": 0.2,
    "maxTokens": 1000
  }
  ```
- **Response**: Standard OpenAI-compatible chat completion object + `creditsDeducted` field.
- **Header `x-run-id`**: the task the request belongs to. Verified JobForm Automator Premium / Diamond
  accounts use the built-in models (`amazon.nova-lite-v1:0`, `amazon.nova-micro-v1:0`) without
  credits, within `PREMIUM_MONTHLY_AI_TASK_LIMIT` AI tasks per UTC month (default 1,000): every request
  of one run id counts once, Auto Apply runs (`easy_apply_*`, `auto_loop_*`) are not counted, a request
  without a run id is a task of its own. Other models draw credits. When the month's tasks are used up,
  an account with a credit plan falls back to credits; otherwise **402 `PREMIUM_AI_TASK_LIMIT_REACHED`**.
- **Errors** carry the message in `error.message` too (OpenAI-compatible clients read it there).

### GET `/api/v1/llm/premium-allowance`
- **Auth**: Bearer JWT
- **Response**: `{ tier, included, month, limit, used, remaining, resetsAt, coveredModels }` — this month's
  built-in Cloud API ("Premium Mode") allowance, counted by the server.

### GET `/api/v1/llm/usage`
- **Auth**: Bearer JWT
- **Response**: Paginated log of LLM requests and token consumptions.

---

## 7. Resume & CareerBrain (`/api/v1/resume` & `/api/v1/profile`)

### POST `/api/v1/resume/generate`
- **Auth**: Bearer JWT (Multer upload: `resume` file field - PDF or DOCX)
- **Response**: Extracted candidate name, contact, skills, work experience, and golden screening answers.

### GET `/api/v1/profile` & PUT `/api/v1/profile`
- **Auth**: Bearer JWT
- **Purpose**: Read/update synced CareerBrain profile in MongoDB.

### GET `/api/v1/profile/quota` & POST `/api/v1/profile/quota/check-and-increment`
- **Auth**: Bearer JWT
- **Purpose**: Manages server-side daily job application quota (e.g. Free: 10/day, Pro: 100/day).

---

## 8. Job Application Tracking (`/api/v1/job-applications`)

The extension reports every application attempt it makes on LinkedIn, Naukri or Indeed
(`chrome-extension/src/background/services/applicationHistory.ts`). Records are stored at
`nanobrowser/job_applications/{uid}/{appId}`; the JobForm Automator website reads that node server
side for Automation Hub → Auto Apply, so its field names are a contract with the dashboard.

### POST `/api/v1/job-applications`
- **Auth**: Bearer JWT
- **Request Body**:
  ```json
  {
    "jobId": "250925012345",
    "platform": "naukri",
    "jobTitle": "Node.js Developer",
    "company": "TCS",
    "location": "Noida",
    "salaryRange": "6-9 Lacs PA",
    "applicationUrl": "https://www.naukri.com/job-listings-...-250925012345",
    "status": "APPLIED",
    "appliedAt": "2026-11-01T10:30:00.000Z",
    "jobDescription": "optional, capped at 2000 chars",
    "companyWebsite": "optional http(s) URL",
    "failureReason": "optional, kept only for FAILED / NEEDS_MANUAL_REVIEW"
  }
  ```
- **Status**: `APPLIED` (platform confirmed the submission), `NEEDS_MANUAL_REVIEW` (submit clicked,
  confirmation not readable), `FAILED` (attempted, not completed), plus the older queue statuses.
- **Platform**: lower-cased; inferred from `applicationUrl` when omitted (LinkedIn otherwise).
- **Response**: the application record. One record per `{ userId, platform, jobId }` — reporting the
  same job again updates it (a failed attempt followed by a success becomes one `APPLIED` record),
  and an `APPLIED` record is never downgraded by a later attempt (it keeps its first `appliedAt`).

### GET `/api/v1/job-applications/check/:jobId[?platform=naukri|indeed]`
- **Auth**: Bearer JWT
- **Response**: `{ "exists": true | false, "application": {...} | null }` — `exists` is false for a
  `FAILED` attempt so it can be retried. LinkedIn when `platform` is omitted.
