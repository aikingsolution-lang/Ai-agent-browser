# Important File Map & Architecture Inventory

This document provides a comprehensive inventory of all critical source files across the monorepo, explaining their purpose, callers, dependencies, side effects, and criticality.

---

## 1. Backend Core (`backend/src/`)

### `backend/src/server.ts`
- **Purpose**: Main backend entry point. Connects to MongoDB, starts HTTP listener, initializes trial worker cron.
- **Imports**: `./app.js`, `./config/env.js`, `./config/database.js`, `./utils/logger.js`, `./workers/trialExpiration.worker.js`, `./services/planSeed.service.js`.
- **Side Effects**: Binds port (default 5000), initiates DB connection pool, starts recurring cron.
- **Safe to Modify**: Yes, for clustering or graceful shutdown enhancements. Breaks whole server if misconfigured.

### `backend/src/app.ts`
- **Purpose**: Configures Express application pipeline, Helmet, CORS, Morgan logging, correlation IDs, body parsing, route mounting, 404, and global error handling.
- **Exports**: `createApp(): express.Application`
- **Criticality**: **CRITICAL**. Any syntax or middleware order error breaks all API endpoints.

### `backend/src/config/env.ts`
- **Purpose**: Type-safe environment variable parsing using Zod. Provides validated `env` object.
- **Criticality**: **CRITICAL**. Crashes server on boot if required variables fail schema validation.

### `backend/src/config/database.ts`
- **Purpose**: Establishes Mongoose connection with retry logic and lifecycle listeners.

---

## 2. Backend Services (`backend/src/services/`)

### `backend/src/services/auth.service.ts`
- **Purpose**: User registration, bcrypt hashing (cost factor 12), JWT token generation, refresh token rotation, Google OAuth linking, and trial initialization.
- **Key Methods**: `registerUser`, `loginUser`, `refreshTokens`, `revokeRefreshToken`, `loginWithGoogle`.
- **Side Effects**: Writes to `User`, `RefreshToken`, `Subscription`, `UserCreditBalance`, `CreditLedger`.
- **Downstream Effects**: Any change to token payload breaks client authorization.

### `backend/src/services/credit.service.ts`
- **Purpose**: Atomic credit deduction, balance queries, transaction ledger logging, and failed-run refunds.
- **Key Methods**:
  - `initializeCreditsForSubscription`: Upserts balance and records ledger.
  - `deductCredits`: Enforces `remainingCredits >= amount` guard with concurrency rollback.
  - `refundCredits`: Adds credits back and writes `REFUND` ledger entry.
  - `refundRunCredits`: Calculates total deducted for a given `runId` and refunds idempotently.

### `backend/src/services/subscriptionLifecycle.service.ts`
- **Purpose**: Razorpay integration, checkout session creation, payment signature verification, webhook processing, subscription state machine.
- **Key Methods**: `createCheckoutSession`, `verifyPayment`, `cancelSubscription`, `processWebhook`.
- **Downstream Effects**: Financial and monetization accuracy depends entirely on this file.

### `backend/src/services/llm.service.ts`
- **Purpose**: LLM completions proxy, credit pre-checking, token calculation, usage logging.
- **Key Methods**: `calculateRequiredCredits`, `processChatCompletion`, `processStreamCompletion`.

### `backend/src/services/resumeParser.service.ts`
- **Purpose**: PDF/DOCX text extraction (pdf-parse, mammoth) and LLM-assisted structured extraction into `ParsedResumeData`.

---

## 3. Chrome Extension Background Agent (`chrome-extension/src/background/agent/`)

### `chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts`
- **Purpose**: The brain of the autonomous job search engine. Orchestrates discovery, filtering, navigation, modal answering, submission, quota tracking, and error recovery across LinkedIn, Naukri, and Indeed.
- **Lines**: 4,324 lines.
- **Key Exports**: `DedicatedJobRunner` class, `dedicatedJobRunner` singleton, `resolveTargetRoleFromResumeWithLLM`, `checkJobSkillRelevance`.
- **Criticality**: **HIGHEST**. Core business logic of the client extension.

### `chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts`
- **Purpose**: Manages the browser context for the runner—supports both pop-up window mode and dedicated in-window tab mode. Handles tab creation, focus, and clean teardown.

### `chrome-extension/src/background/agent/linkedin/formQuestionResolver.ts`
- **Purpose**: Resolves unknown questions inside job application modals using rule matching, CareerBrain golden answers, and LLM autonomous solving.

### `chrome-extension/src/background/agent/platforms/platformRegistry.ts`
- **Purpose**: Unified registry mapping `SupportedPlatform` ('linkedin', 'naukri', 'indeed') to platform adapters.

### `chrome-extension/src/background/agent/platforms/linkedin/linkedinAdapter.ts`
- **Purpose**: LinkedIn DOM interaction: job search URL builder, search results extraction, Easy Apply modal detection, next step clicking, submission confirmation.

### `chrome-extension/src/background/agent/platforms/naukri/naukriAdapter.ts`
- **Purpose**: Naukri portal adapter: search URL construction, job tile scraping, chatbot/modal questionnaire filler.

### `chrome-extension/src/background/agent/platforms/indeed/indeedAdapter.ts`
- **Purpose**: Indeed job search adapter: pagination, Indeed Apply modal detection, radio/select question handling.

---

## 4. Frontend & Shared Packages

### `pages/side-panel/src/SidePanel.tsx`
- **Purpose**: Main React entry point for the Side Panel UI. Manages views (Chat, Automation Dashboard, Profile, AuthGate, Usage).

### `pages/side-panel/src/components/LinkedInApplyDashboard.tsx`
- **Purpose**: The control panel for the autonomous runner. Role input, location selection, platform toggles, quota displays, start/stop buttons, live log feed.

### `packages/storage/lib/profile/careerBrain.ts`
- **Purpose**: Schema and Chrome Storage wrapper for candidate profile, skills, work experience, and screening answers.

### `packages/shared/lib/backend-api-client.ts`
- **Purpose**: HTTP client wrapper configured with token refreshing, correlation IDs, and standard error handling.
