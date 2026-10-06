# Database Architecture & Data Contracts (MongoDB / Mongoose)

The backend uses **Mongoose 8.7.0** on **MongoDB**. All collections use schema-level validations, immutable audit records where appropriate, and compound indexes to support high-throughput read/write operations.

---

## Complete Model Inventory (10 Collections)

### 1. `User` (`backend/src/models/user.model.ts`)
- **Collection**: `users`
- **Fields**:
  - `name`: String (required, trimmed)
  - `email`: String (required, unique, lowercased, trimmed)
  - `passwordHash`: String (select: false)
  - `role`: String (enum: `'user'`, `'admin'`, default: `'user'`)
  - `status`: String (enum: `'active'`, `'suspended'`, default: `'active'`)
  - `googleLinked`: Boolean (default: false)
  - `googleId`: String (optional)
  - `hasUsedTrial`: Boolean (default: false)
  - `timestamps`: createdAt, updatedAt
- **Indexes**:
  - `email: 1` (Unique)

---

### 2. `UserCreditBalance` (`backend/src/models/userCreditBalance.model.ts`)
- **Collection**: `usercreditbalances`
- **Fields**:
  - `userId`: ObjectId (ref: User, required, unique)
  - `subscriptionId`: ObjectId (ref: Subscription, required)
  - `allocatedCredits`: Number (min: 0)
  - `usedCredits`: Number (min: 0, default: 0)
  - `remainingCredits`: Number (min: 0)
  - `periodStart`: Date
  - `periodEnd`: Date
- **Indexes**:
  - `userId: 1` (Unique)
  - `userId: 1, remainingCredits: 1` (Compound index for balance checking)

---

### 3. `CreditLedger` (`backend/src/models/creditLedger.model.ts`)
- **Collection**: `creditledgers`
- **Purpose**: Append-only, immutable financial and usage transaction audit log.
- **Fields**:
  - `userId`: ObjectId (ref: User, required)
  - `subscriptionId`: ObjectId (ref: Subscription, required)
  - `amount`: Number (negative for deductions, positive for allocations/refunds)
  - `balanceBefore`: Number
  - `balanceAfter`: Number
  - `type`: Enum (`'TRIAL_ALLOCATION'`, `'SUBSCRIPTION_RENEWAL'`, `'USAGE_DEDUCTION'`, `'REFUND'`, `'MANUAL_ADJUSTMENT'`)
  - `description`: String
  - `idempotencyKey`: String (sparse, unique partial index)
  - `metadata`: Mixed ({ runId, requestId, model, ... })
- **Indexes**:
  - `idempotencyKey: 1` (Unique, partial filter: `{ idempotencyKey: { $type: "string" } }`)
  - `userId: 1, createdAt: -1` (Fast transaction history sorting)
  - `userId: 1, 'metadata.runId': 1` (Fast run refund aggregation)

---

### 4. `Subscription` (`backend/src/models/subscription.model.ts`)
- **Collection**: `subscriptions`
- **Fields**:
  - `userId`: ObjectId (ref: User, required)
  - `planId`: ObjectId (ref: Plan, required)
  - `planCodeSnapshot`: String
  - `planNameSnapshot`: String
  - `amountSnapshot`: Number
  - `currencySnapshot`: String
  - `billingIntervalSnapshot`: Enum (`'monthly'`, `'yearly'`, `'none'`)
  - `creditsSnapshot`: Number
  - `status`: Enum (`'TRIALING'`, `'ACTIVE'`, `'PAST_DUE'`, `'CANCELLED'`, `'EXPIRED'`)
  - `isTrial`: Boolean (default: false)
  - `trialStartDate`, `trialEndDate`: Date
  - `provider`: Enum (`'none'`, `'razorpay'`)
  - `providerSubscriptionId`: String (sparse)
  - `currentPeriodStart`, `currentPeriodEnd`: Date
  - `cancelAtPeriodEnd`: Boolean (default: false)
  - `lastEventTimestamp`: Date (for stale webhook protection)
- **Indexes**:
  - `userId: 1` (Unique for active/trialing states)
  - `userId: 1, isTrial: 1` (Unique partial index)
  - `status: 1, isTrial: 1, trialEndDate: 1` (Worker cron index)

---

### 5. `Plan` (`backend/src/models/plan.model.ts`)
- **Collection**: `plans`
- **Fields**: `code` (unique), `name`, `description`, `amount`, `currency`, `billingInterval`, `creditsPerBillingPeriod`, `razorpayPlanId`, `isActive`, `features`.

---

### 6. `RefreshToken` (`backend/src/models/refreshToken.model.ts`)
- **Collection**: `refreshtokens`
- **Fields**: `userId`, `tokenHash` (SHA-256 hash of raw token, unique), `expiresAt` (TTL index: `{ expires: 0 }`), `revokedAt`, `replacedByTokenHash`.

---

### 7. `WebhookLedger` (`backend/src/models/webhookLedger.model.ts`)
- **Collection**: `webhookledgers`
- **Fields**: `eventId` (unique), `eventType`, `providerPaymentId`, `status` (`'PROCESSING'`, `'PROCESSED'`, `'FAILED'`), `payload`, `errorMessage`, `processedAt`.

---

### 8. `LlmUsageLog` (`backend/src/models/llmUsageLog.model.ts`)
- **Collection**: `llmusagelogs`
- **Fields**: `requestId`, `userId`, `provider`, `model`, `promptTokens`, `completionTokens`, `totalTokens`, `creditsDeducted`, `latencyMs`, `status`, `errorMessage`, `idempotencyKey`, `metadata`.

---

### 9. `JobApplication` (`backend/src/models/jobApplication.model.ts`)
- **Collection**: `jobapplications`
- **Fields**: `userId`, `jobId`, `title`, `company`, `location`, `salaryRange`, `fitScore`, `platform`, `status`, `appliedAt`.
- **Indexes**: `userId: 1, jobId: 1` (Unique).

---

### 10. `CareerBrain` (`backend/src/models/careerBrain.model.ts`)
- **Collection**: `careerbrains`
- **Fields**: `userId` (unique), `fullName`, `email`, `phone`, `currentLocation`, `totalExperienceYears`, `skills`, `skillExperience`, `workExperience`, `goldenAnswers`, `dailyApplicationLimit`, `appliedCountToday`, `lastApplicationDate`, `tier`.
