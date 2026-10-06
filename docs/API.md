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

### POST `/api/v1/job-applications`
- **Auth**: Bearer JWT
- **Request Body**:
  ```json
  {
    "jobId": "urn:li:fsd_jobPosting:12345",
    "platform": "linkedin",
    "title": "Senior Frontend Engineer",
    "company": "Tech Corp",
    "location": "Bengaluru, India",
    "status": "APPLIED",
    "fitScore": 88
  }
  ```
- **Response**: Created application record. Deduplicates on `{ userId, jobId }`.

### GET `/api/v1/job-applications/check/:jobId`
- **Auth**: Bearer JWT
- **Response**: `{ "applied": true | false }`
