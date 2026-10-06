# PROJECT_STATUS.md

**Current Technical Status & Architecture Audit**  
*Document Generated: October 1, 2026*  
*Repository Root:* `c:\Users\ASUS\OneDrive\Desktop\nanobrowser`

---

## 1. PROJECT OVERVIEW

### Summary
This project is a commercial, subscription-based autonomous job application agent and AI browser assistant. Built on a fork of NanoBrowser, it operates as a Manifest V3 Chrome Extension coupled with a Node.js/TypeScript backend API. The core capability is automated, multi-step job hunting across LinkedIn, Naukri, and Indeed: it parses candidates' resumes, matches Job Descriptions (JDs) against candidate skills, fills complex ATS screening forms without fabricating verifiable facts, asks the candidate questions in real time when information is missing, and tracks verified submissions. All user access, LLM execution budgets, and application allowances are governed by a metered credit ledger and Razorpay recurring subscription system.

### Exact Tech Stack & Versions

| Layer | Technology / Package | Exact Version | Purpose / Configuration |
|---|---|---|---|
| **Monorepo Engine** | Turbo (Turborepo) | `^2.5.3` | Multi-package workspace orchestrator |
| **Package Manager** | PNPM | `pnpm-workspace.yaml` | Monorepo dependency management |
| **Frontend Framework** | React | `18.3.1` | Side panel UI & Options dashboard |
| **Extension Platform** | Chrome Extension Manifest V3 | `0.1.13` | Chrome Extension API (`sidePanel`, `debugger`, `storage`, `alarms`) |
| **Bundler & Build Tool** | Vite | `^6.4.1` | High-speed ESM bundling for background, content, sidepanel, options |
| **Extension Automation** | Puppeteer Core | `^24.31.0` | Chrome DevTools Protocol (CDP) DOM interaction via extension debugger |
| **LangChain (Extension)**| `@langchain/core` / `@langchain/openai` | `0.3.79` / `0.6.16` | Model orchestration & OpenAI-compatible proxy invocation |
| **Styling** | Tailwind CSS | `^3.4.17` | Utility-first responsive styling for Side Panel and Options |
| **Backend Runtime** | Node.js | `^22.5.5` | ECMAScript Module (`"type": "module"`) backend service |
| **Backend Framework** | Express.js | `^4.21.0` | REST API framework for auth, billing, LLM gateway |
| **Database / ODM** | MongoDB / Mongoose | `^8.7.0` | Document database for users, credits, subscriptions, profiles |
| **Schema Validation** | Zod | `^3.23.8` (backend) / `^3.25.76` (ext) | Runtime request payload validation |
| **Authentication** | JSON Web Tokens (`jsonwebtoken`) / `bcryptjs` | `^9.0.2` / `^2.4.3` | Bearer token auth & salted password hashing |
| **Document Parsers** | `pdf-parse` / `mammoth` | `^2.4.5` / `^1.12.3` | PDF and DOCX text extraction for resume parsing |
| **Payment Gateway** | Razorpay REST API | Standard v1 REST | Subscriptions, hosted checkout, HMAC-SHA256 webhooks |
| **Primary Cloud LLM** | AWS Bedrock (Converse API) | AWS Bedrock Runtime | `amazon.nova-lite-v1:0` (primary auto-apply/copilot), `anthropic.claude-3-5-sonnet-20240620-v1:0`, `anthropic.claude-3-haiku-20240307-v1:0`, `amazon.nova-pro-v1:0`, `amazon.nova-micro-v1:0` |
| **Local LLM Fallbacks** | Groq, OpenAI, Ollama, Gemini, DeepSeek, Anthropic, Cerebras, xAI | Various `@langchain/*` | Client-side configurable direct API keys |
| **Testing Suites** | Vitest | `^2.1.1` (backend) / `2.1.9` (ext) | Unit, integration, and security guardrail test runners |

---

## 2. ARCHITECTURE

### High-Level Architecture Diagram

```
+----------------------------------------------------------------------------------------------------+
|                                    CHROME BROWSER EXTENSION (MV3)                                  |
|                                                                                                    |
|  +------------------------------+  +-------------------------------+  +-------------------------+  |
|  |       Side Panel UI          |  |       Options Dashboard       |  |      Content Script     |  |
|  |  (LinkedInApplyDashboard,    |  |    (ApplicationAnalytics,     |  |  (buildDomTree, click   |  |
|  |   ResumeProfileView, Chat,   |  |     CareerBrainSettings)      |  |   listeners, overlays)  |  |
|  |   Career Copilot, Questions) |  |                               |  |                         |  |
|  +--------------+---------------+  +---------------+---------------+  +------------+------------+  |
|                 |                                  |                               |               |
|                 +------------------+---------------+-------------------------------+               |
|                                    | Long-lived Port / Chrome Runtime Messages                     |
|                                    v                                                               |
|  +----------------------------------------------------------------------------------------------+  |
|  |                             Background Service Worker (index.ts)                             |  |
|  |                                                                                              |  |
|  |   * DedicatedJobRunner (Loop, Pacing, Recovery, Abort Controller)                            |  |
|  |   * DedicatedWindowManager (Manages isolated runner window & tab)                            |  |
|  |   * FormQuestionResolver (4-stage matching: Rules -> Golden -> LLM -> Ask User)             |  |
|  |   * Platform Adapters: LinkedIn (CDP), Naukri (DOM), Indeed (DOM)                            |  |
|  |   * Intelligence Suite: evaluateDeepRelevance, checkBlacklist, inspectAndHealFormErrors      |  |
|  |   * CareerCopilotEngine (Markdown chat, Profile inspection, Dynamic Cover Letter generator)  |  |
|  |   * ActiveModelHelper / Scoped LLM (Routes calls to Backend Gateway or BYO Provider)         |  |
|  |   * Chrome Local Storage Stores (careerBrainStore, processedJobsStore, dailyQuotaStore, etc) |  |
|  +-----------------------------------+----------------------------------------------------------+  |
+--------------------------------------|-------------------------------------------------------------+
                                       |
                     HTTP / JSON REST  | (Bearer JWT Token, x-run-id)
                                       v
+----------------------------------------------------------------------------------------------------+
|                                       NODE.JS / EXPRESS BACKEND                                    |
|                                     (http://localhost:5000/api/v1)                                 |
|                                                                                                    |
|  +-----------------+  +------------------+  +--------------------+  +---------------------------+  |
|  |   /auth Router  |  |  /credits Router |  | /subscription Rtr  |  |        /llm Router        |  |
|  | (register,login,|  | (balance,history,|  | (plans, checkout,  |  | (chat/completions gateway,|  |
|  |  getMe, logout) |  |  refundCredits)  |  |  verify, activate) |  |  token-to-credit ledger)  |  |
|  +--------+--------+  +--------+---------+  +---------+----------+  +-------------+-------------+  |
|           |                    |                      |                           |                |
|  +--------+--------+  +--------+---------+            |             +-------------+-------------+  |
|  | /profile Router |  | /resume Router   |            |             |     /webhooks/razorpay    |  |
|  | (get, sync,     |  | (upload-and-     |            |             | (HMAC-SHA256 signature,   |  |
|  |  quota checks)  |  |  parse, generate)|            |             |  atomic ledger, auto-renew|  |
|  +--------+--------+  +--------+---------+            |             +-------------+-------------+  |
+-----------|--------------------|----------------------|---------------------------|----------------+
            |                    |                      |                           |
            v                    v                      v                           |
+-----------------------+ +--------------------+ +--------------------+             |
|   MONGODB DATABASE    | |    AWS BEDROCK     | |  RAZORPAY GATEWAY  |             |
|                       | |   (Converse API)   | |                    |             |
| * users               | |                    | | * Subscriptions    |<------------+
| * careerbrains        | | * amazon.nova-lite | | * Invoices         |
| * plans               | | * claude-3-5-sonnet| | * Webhook Events   |
| * subscriptions       | | * amazon.nova-pro  | +--------------------+
| * usercreditbalances  | |                    |
| * creditledgers       | +----------^---------+
| * llmusagelogs        |            |
| * jobapplications     |            +--- (Backend calls Bedrock Bearer Token via HTTPS)
| * webhookledgers      |
+-----------------------+
```

### Major Modules & Files Inventory

#### Backend (`/backend/src`)
- [`src/server.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/server.ts): Express server entry point; connects to MongoDB, starts background trial-expiration cron worker, binds HTTP listener to port (default `5000`).
- [`src/app.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/app.ts): Express application configuration; registers Helmet, Morgan logging, dynamic CORS headers (`chrome-extension://*`), JSON body parsers, and mounts `/api/v1` routes.
- [`src/config/env.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/config/env.ts): Strict Zod runtime validation of environment variables; enforces non-mock production keys.
- [`src/config/database.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/config/database.ts): Mongoose connection lifecycle manager with connection pooling and health checks.
- [`src/models/user.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/user.model.ts): User collection schema; email, bcrypt password hash, role (`user`/`admin`), and one-time trial flag (`hasUsedTrial`).
- [`src/models/careerBrain.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/careerBrain.model.ts): Candidate master profile; skills, experience history, notice period, location preferences, golden answers, and server-side daily apply quotas.
- [`src/models/plan.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/plan.model.ts): Subscription tier definitions; price in paise, credit allocations, rate limits, and Razorpay plan IDs.
- [`src/models/subscription.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/subscription.model.ts): Active user subscription state machine (`TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELLED`, `EXPIRED`).
- [`src/models/userCreditBalance.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/userCreditBalance.model.ts): Materialized balance of allocated, used, and remaining credits per user.
- [`src/models/creditLedger.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/creditLedger.model.ts): Append-only audit ledger recording every credit delta (`TRIAL_ALLOCATION`, `USAGE_DEDUCTION`, `REFUND`, `RENEWAL`).
- [`src/models/llmUsageLog.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/llmUsageLog.model.ts): Detailed telemetry log of every LLM completion: model, token usage, latency, credits deducted, and run ID metadata.
- [`src/models/webhookLedger.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/webhookLedger.model.ts): Idempotent ledger for incoming payment webhooks with stuck-state recovery.
- [`src/models/jobApplication.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/jobApplication.model.ts): Server-side job application tracking schema with job status lifecycle.
- [`src/services/auth.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/auth.service.ts): Handles user registration, bcrypt authentication, and JWT signing.
- [`src/services/credit.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/credit.service.ts): Atomic credit balance deductions, refund reconciliations by `runId`, and ledger generation.
- [`src/services/llm.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/llm.service.ts): Managed proxy gateway calculating credit requirements, enforcing pre-checks, checking idempotency, and dispatching to provider.
- [`src/services/llm/bedrockLlmProvider.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/llm/bedrockLlmProvider.ts): Direct AWS Bedrock Converse API HTTP client implementing strict message turn alternation, Markdown JSON cleansing, and error mapping.
- [`src/services/razorpay.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/razorpay.service.ts): Razorpay subscription creator and HMAC-SHA256 signature verifier with non-production mock fallback.
- [`src/services/subscriptionLifecycle.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/subscriptionLifecycle.service.ts): Subscription state transitions, payment verifications, and webhook event processing.
- [`src/services/resumeParser.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/resumeParser.service.ts): In-memory PDF/DOCX text extraction and LLM structured resume extraction.
- [`src/services/resumeGenerator.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/resumeGenerator.service.ts): Low-level binary PDF 1.4 compiler generating keyword-tailored resumes.
- [`src/workers/trialExpiration.worker.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/workers/trialExpiration.worker.ts): Cron task running every 15 minutes to mark expired trial subscriptions as `EXPIRED`.

#### Frontend Extension (`/chrome-extension`, `/packages`, `/pages`)
- [`chrome-extension/src/background/index.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/index.ts): Central extension service worker; listens to extension ports, routes commands, handles debugger attachment, and wires runner lifecycle.
- [`chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts): Main autonomous execution orchestrator; executes search, left-pane discovery, pure DOM pre-checks, modal multi-step progression, anti-ban pacing, and instant 0ms abortion.
- [`chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts): Manages an isolated secondary browser window for job hunting; traps window closures to stop runs.
- [`chrome-extension/src/background/agent/linkedin/formQuestionResolver.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/formQuestionResolver.ts): Core 4-stage question-filling pipeline; matches profile data, searches golden Q&A, generates narrative answers, and prompts users for unknown facts.
- [`chrome-extension/src/background/agent/intelligence/`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/intelligence/): Algorithm suite for 0-credit deep JD relevance evaluation, negative keyword/blacklist checking, experience gap detection, and DOM form validation self-healing.
- [`chrome-extension/src/background/agent/copilot/careerCopilotEngine.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/copilot/careerCopilotEngine.ts): Interactive Career Copilot brain; inspects profile, parses conversational updates into CareerBrain, and dynamically crafts 3-paragraph tailored cover letters.
- [`chrome-extension/src/background/agent/activeModelHelper.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/activeModelHelper.ts): Resolves active chat models, prioritizing local BYO providers before falling back to localhost:5000 Bedrock gateway.
- [`packages/storage/lib/profile/careerBrain.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/packages/storage/lib/profile/careerBrain.ts): Extension client storage and bidirectional synchronization layer with MongoDB CareerBrain profile.
- [`packages/storage/lib/linkedin/csvExport.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/packages/storage/lib/linkedin/csvExport.ts): RFC 4180 UTF-8 BOM CSV generator exporting strictly verified applied jobs.
- [`packages/shared/lib/backend-api-client.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/packages/shared/lib/backend-api-client.ts): Client library wrapping all backend endpoints with automatic Bearer token injection and error wrapping.
- [`pages/side-panel/src/SidePanel.tsx`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/pages/side-panel/src/SidePanel.tsx): Primary extension UI; displays active tasks, live activity updates, real-time candidate prompt modals, and Career Copilot chat.
- [`pages/options/src/components/ApplicationAnalytics.tsx`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/pages/options/src/components/ApplicationAnalytics.tsx): Web-based applications dashboard with filtering, search, metrics, and CSV export.

---

## 3. FEATURES IMPLEMENTED (WITH FILE REFERENCES)

### 3.1 Authentication
- **Status:** **Fully Working** (Email & Password with JWT). **No OAuth** is implemented.
- **Implementation:**
  - Backend: [`backend/src/routes/auth.routes.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/routes/auth.routes.ts), [`backend/src/controllers/auth.controller.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/controllers/auth.controller.ts), [`backend/src/services/auth.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/auth.service.ts).
  - Extension: [`packages/storage/lib/auth/authStorage.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/packages/storage/lib/auth/authStorage.ts), [`packages/shared/lib/backend-api-client.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/packages/shared/lib/backend-api-client.ts).
- **Mechanism:**
  - `POST /api/v1/auth/register`: Validates name, email, and password (min 8 chars) via Zod; checks unique email; hashes password via `bcryptjs` (salt rounds 10); creates user; automatically triggers 5-day free trial subscription with 1,000 credits (`TRIAL_ALLOCATION`); returns signed JWT (expires in 15m) and user metadata. Sets `hasUsedTrial = true` on the user record.
  - `POST /api/v1/auth/login`: Rate-limited (5 req/15m); compares password hash; generates new JWT; returns user and active subscription status.
  - `GET /api/v1/auth/me`: Authenticated endpoint validating JWT Bearer token via [`auth.middleware.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/middleware/auth.middleware.ts); returns current user details.
  - `POST /api/v1/auth/logout`: Stateless acknowledgement; extension clears `nanobrowser_auth_session` in `chrome.storage.local`.
- **Known Limitations:**
  - No OAuth (Google/GitHub/LinkedIn) routes exist.
  - Refresh tokens are not implemented; users must re-authenticate when the 15-minute token expires unless renewed by login.

### 3.2 Job Auto-Apply Flow & Field Resolution
- **Status:** **Fully Working** on LinkedIn (CDP / Easy Apply). **Partially Working** on Naukri & Indeed (Search scanning & card extraction working; live form submission depends on platform DOM variations).
- **Implementation:**
  - Orchestrator: [`chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts)
  - Dedicated Window: [`chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts)
  - Resolution Pipeline: [`chrome-extension/src/background/agent/linkedin/formQuestionResolver.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/formQuestionResolver.ts)
  - Intelligence Suite: [`chrome-extension/src/background/agent/intelligence/`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/intelligence/)
  - Naukri Adapter: [`chrome-extension/src/background/agent/platforms/naukri/naukriAdapter.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/platforms/naukri/naukriAdapter.ts)
  - Indeed Adapter: [`chrome-extension/src/background/agent/platforms/indeed/indeedAdapter.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/platforms/indeed/indeedAdapter.ts)
- **Field Resolution Pipeline (4 Stages):**
  1. **Stage 1: Pure Rule-Based (0 LLM Cost):** Resolves standard contact fields (first name, last name, email, phone, location/city, current title), notice period, current/expected salary, years of experience, standard URLs (GitHub, LinkedIn, portfolio), and common boolean/compliance questions (e.g. "Will you now or in the future require sponsorship?", "Are you legally authorized to work?"). Also automatically drafts tailored cover letters for free-form pitch fields using candidate highlights.
  2. **Stage 2: Golden Answers Lookup (0 LLM Cost):** Fuzzy-matches question strings against candidate's custom `goldenAnswers` array stored in CareerBrain.
  3. **Stage 3: Autonomous LLM Solver:** For subjective/narrative questions or complex dropdowns (e.g. "Describe your experience with containerization"), sends context to the scoped LLM gateway. Enforces zero-invention for factual numbers.
  4. **Stage 4: Candidate Prompt Fallback:** For unresolvable factual questions, sends an `ASK_USER_QUESTION` or `ASK_USER_QUESTION_BATCH` message to the Side Panel. The user has 10 seconds to answer; if timed out or answered, the result is automatically saved to `goldenAnswers` or `skillExperience` in CareerBrain for future zero-click applications.
- **Safety, Pacing & Controls:**
  - Pre-application 0-credit blacklist and negative keyword filters.
  - Deep JD fit score thresholding (`minFitScore`, default 70%) and experience gap filter (`maxExperienceGapYears`, default 3 years).
  - Anti-ban randomized pacing delays (5–10s) between job submissions.
  - Instantaneous 0ms stop via `AbortController` and `interruptibleSleep`; immediate window closure and state synchronization across the background worker and UI.

### 3.3 LLM Gateway Integration
- **Status:** **Fully Working**.
- **Implementation:**
  - Gateway Controller: [`backend/src/controllers/llm.controller.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/controllers/llm.controller.ts)
  - Service & Credit Accounting: [`backend/src/services/llm.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/llm.service.ts)
  - Bedrock Provider: [`backend/src/services/llm/bedrockLlmProvider.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/llm/bedrockLlmProvider.ts)
  - Schema & Model Registry: [`backend/src/schemas/llm.schema.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/schemas/llm.schema.ts)
  - Extension Router: [`chrome-extension/src/background/agent/activeModelHelper.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/activeModelHelper.ts)
- **Supported Models on Bedrock:**
  - `amazon.nova-lite-v1:0` (Default auto-apply & copilot engine)
  - `amazon.nova-micro-v1:0`
  - `amazon.nova-pro-v1:0`
  - `anthropic.claude-3-5-sonnet-20240620-v1:0`
  - `anthropic.claude-3-haiku-20240307-v1:0`
- **Credit Accounting & Logic:**
  - Token-to-credit formula: Standard models (`nova-lite`, `nova-micro`, `haiku`) cost 1 credit per 1,000 tokens (minimum 1). Premium models (`claude-3-5-sonnet`, `nova-pro`) cost 2 credits per 1,000 tokens (minimum 2).
  - Pre-execution balance validation ensures user has enough credits before invoking AWS Bedrock.
  - Deductions are tagged with `x-run-id`. If an auto-apply task fails or skips, `backendApiClient.refundCredits(jobRunId)` triggers an atomic refund in `CreditLedger`.

### 3.4 Credits & Billing Ledger
- **Status:** **Fully Working**.
- **Implementation:**
  - Backend Models: [`creditLedger.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/creditLedger.model.ts), [`userCreditBalance.model.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/userCreditBalance.model.ts).
  - Service: [`backend/src/services/credit.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/credit.service.ts).
  - Routes & Controller: [`credit.routes.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/routes/credit.routes.ts), [`credit.controller.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/controllers/credit.controller.ts).
- **Mechanism:**
  - Materialized balance maintained in `usercreditbalances` with fields: `allocatedCredits`, `usedCredits`, `remainingCredits`.
  - Immutable audit trail in `creditledgers` recording `balanceBefore` and `balanceAfter` on every operation.
  - Transaction types: `TRIAL_ALLOCATION`, `SUBSCRIPTION_RENEWAL`, `USAGE_DEDUCTION`, `REFUND`, `ADMIN_ADJUSTMENT`, `PERIOD_EXPIRATION`.
  - Atomicity guaranteed via Mongoose transactions / conditional updates (`$inc`, `$gte: amount`).

### 3.5 Payment & Razorpay Subscription Flow
- **Status:** **Fully Working** (Supports both live Razorpay API and mock development mode).
- **Implementation:**
  - Service: [`backend/src/services/razorpay.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/razorpay.service.ts)
  - Lifecycle: [`backend/src/services/subscriptionLifecycle.service.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/services/subscriptionLifecycle.service.ts)
  - Controller: [`backend/src/controllers/checkout.controller.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/controllers/checkout.controller.ts)
  - Webhooks: [`backend/src/controllers/webhook.controller.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/controllers/webhook.controller.ts)
- **Lifecycle Capabilities:**
  - `POST /subscription/checkout`: Creates Razorpay subscription session or returns mock session if test keys are used.
  - `POST /subscription/verify-payment`: Verifies checkout HMAC SHA-256 signature (`paymentId|subscriptionId`) using `RAZORPAY_KEY_SECRET`. Activates subscription, resets period dates, allocates plan credits, and upgrades Career Brain to Premium (100 jobs/day).
  - `POST /webhooks/razorpay`: Accepts raw Buffer payloads; verifies `x-razorpay-signature` against `RAZORPAY_WEBHOOK_SECRET`; tracks deduplication in `WebhookLedger`; handles `subscription.activated`, `subscription.charged` (monthly renewal & credit top-up), `subscription.cancelled`, `subscription.halted`, and `payment.failed`.

### 3.6 Career Copilot & Cover Letter Generator
- **Status:** **Fully Working**.
- **Implementation:**
  - Engine: [`chrome-extension/src/background/agent/copilot/careerCopilotEngine.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/copilot/careerCopilotEngine.ts)
  - UI Components: [`pages/side-panel/src/components/MessageList.tsx`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/pages/side-panel/src/components/MessageList.tsx), [`pages/side-panel/src/components/CopilotCard.tsx`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/pages/side-panel/src/components/CopilotCard.tsx).
- **Capabilities:**
  - Offline deterministic query evaluation: Answers profile queries (`Show my profile`, `skills`, `experience`, `notice period`, `locations`) instantly without LLM token cost.
  - Conversational profile auto-fill: Detects candidate data stated in chat (e.g., "My notice period is 15 days", "I want to work in Bengaluru") and updates CareerBrain.
  - Option 3 Dynamic Cover Letter Generator: Scrapes active tab JD or uses candidate background narrative to generate a 3-paragraph tailored cover letter with a 1-click **"Copy Letter"** UI action card.

### 3.7 Applications Dashboard & CSV Export
- **Status:** **Fully Working**.
- **Implementation:**
  - UI Component: [`pages/options/src/components/ApplicationAnalytics.tsx`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/pages/options/src/components/ApplicationAnalytics.tsx)
  - CSV Generator: [`packages/storage/lib/linkedin/csvExport.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/packages/storage/lib/linkedin/csvExport.ts)
- **Capabilities:**
  - Displays verified applications, match fit percentages, and daily quota consumption.
  - 1-click RFC 4180 CSV export with UTF-8 BOM encoding for Microsoft Excel compatibility.
  - Streamlined output strictly filtered to verified `Applied` jobs, removing clutter columns and displaying: `Platform`, `Job Title`, `Company`, `Status`, `Fit Score (%)`, `Outcome / Reason`, and `Job URL`.

---

## 4. DATABASE SCHEMA

The MongoDB database (`nanobrowser_saas`) contains 9 collections:

### 1. `users`
- **Mongoose Model:** [`User`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/user.model.ts)
- **Fields:**
  - `_id`: `ObjectId` (Primary Key)
  - `name`: `String` (Required, 2-50 chars)
  - `email`: `String` (Required, Unique, Lowercase, Indexed)
  - `passwordHash`: `String` (Required, `select: false`)
  - `role`: `String` (Enum: `'user'`, `'admin'`, Default: `'user'`)
  - `status`: `String` (Enum: `'active'`, `'suspended'`, Default: `'active'`)
  - `hasUsedTrial`: `Boolean` (Default: `false`, Indexed)
  - `trialUsedAt`: `Date` (Optional)
  - `createdAt`: `Date` (Timestamp)
  - `updatedAt`: `Date` (Timestamp)
- **Relationships:** Referenced by `careerbrains`, `subscriptions`, `usercreditbalances`, `creditledgers`, `llmusagelogs`, `jobapplications`.

### 2. `careerbrains`
- **Mongoose Model:** [`CareerBrain`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/careerBrain.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `userId`: `ObjectId` (Ref: `User`, Required, Unique, Indexed)
  - `fullName`, `email`, `phoneNumber`, `currentTitle`: `String`
  - `resumeText`: `String`
  - `resumeFileName`, `backgroundNarrative`: `String` (Optional)
  - `skills`: `[String]`
  - `yearsOfExperience`: `Number`
  - `workExperience`: `[IWorkExperienceItem]` (Sub-document array: `company`, `title`, dates, `description`)
  - `workHistory`: `[IWorkExperience]` (Legacy sub-document array)
  - `education`, `college`, `cgpa`: `String`
  - `noticePeriod`, `workAuthorization`: `String`
  - `skillExperience`: `Map` / `Record<string, number>` (Skill-to-years mapping)
  - `salaryExpectation`, `currentLocation`, `preferredLocation`: `String`
  - `preferredLocations`: `[String]`
  - `portfolioUrl`, `githubUrl`, `linkedinUrl`: `String`
  - `goldenAnswers`: `[IGoldenAnswerSchema]` (Sub-documents: `id`, `question`, `answer`, `category`)
  - `customAnswers`: `Map` / `Record<string, string>`
  - `tier`: `String` (Enum: `'free'`, `'premium'`, Default: `'free'`)
  - `dailyQuota`: Object (`appliedToday`, `dailyLimit`, `lastResetDate`)

### 3. `plans`
- **Mongoose Model:** [`Plan`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/plan.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `code`: `String` (Required, Unique, Lowercase; e.g. `'free-trial'`, `'starter'`, `'pro'`, `'power'`)
  - `name`: `String` (Required)
  - `description`: `String` (Required)
  - `amount`: `Number` (Integer paise: e.g. `49900` for ₹499)
  - `currency`: `String` (Default: `'INR'`)
  - `billingInterval`: `String` (Enum: `'none'`, `'monthly'`, `'yearly'`)
  - `creditsPerBillingPeriod`: `Number` (e.g. 1000, 5000, 25000)
  - `rateLimitPerMinute`: `Number`
  - `features`: `[String]`
  - `razorpayPlanId`: `String` (Optional Razorpay plan identifier)
  - `isActive`: `Boolean` (Default: `true`)

### 4. `subscriptions`
- **Mongoose Model:** [`Subscription`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/subscription.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `userId`: `ObjectId` (Ref: `User`, Required, Indexed)
  - `planId`: `ObjectId` (Ref: `Plan`, Required)
  - `planCodeSnapshot`, `planNameSnapshot`, `currencySnapshot`: `String`
  - `amountSnapshot`, `creditsSnapshot`, `rateLimitSnapshot`: `Number`
  - `billingIntervalSnapshot`: `String`
  - `provider`: `String` (Enum: `'manual'`, `'razorpay'`)
  - `providerCustomerId`, `providerSubscriptionId`: `String` (Indexed)
  - `status`: `String` (Enum: `'TRIALING'`, `'ACTIVE'`, `'PAST_DUE'`, `'CANCELLED'`, `'EXPIRED'`)
  - `isTrial`: `Boolean` (Default: `false`)
  - `trialStartDate`, `trialEndDate`: `Date`
  - `currentPeriodStart`, `currentPeriodEnd`: `Date` (Required)
  - `cancelAtPeriodEnd`: `Boolean` (Default: `false`)
  - `canceledAt`, `endedAt`, `pastDueStartedAt`, `lastEventTimestamp`: `Date`

### 5. `usercreditbalances`
- **Mongoose Model:** [`UserCreditBalance`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/userCreditBalance.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `userId`: `ObjectId` (Ref: `User`, Required, Unique, Indexed)
  - `subscriptionId`: `ObjectId` (Ref: `Subscription`, Required, Indexed)
  - `allocatedCredits`: `Number` (Integer)
  - `usedCredits`: `Number` (Integer, Default: `0`)
  - `remainingCredits`: `Number` (Integer, Min: `0`)
  - `periodStart`, `periodEnd`: `Date`

### 6. `creditledgers`
- **Mongoose Model:** [`CreditLedger`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/creditLedger.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `userId`: `ObjectId` (Ref: `User`, Required, Indexed)
  - `subscriptionId`: `ObjectId` (Ref: `Subscription`, Required)
  - `amount`: `Number` (Positive or negative integer delta)
  - `balanceBefore`: `Number` (Integer)
  - `balanceAfter`: `Number` (Integer, Min: `0`)
  - `type`: `String` (Enum: `'TRIAL_ALLOCATION'`, `'SUBSCRIPTION_RENEWAL'`, `'USAGE_DEDUCTION'`, `'REFUND'`, `'ADMIN_ADJUSTMENT'`, `'PERIOD_EXPIRATION'`)
  - `description`: `String`
  - `idempotencyKey`: `String` (Optional, Indexed)
  - `metadata`: `Record<string, any>`

### 7. `llmusagelogs`
- **Mongoose Model:** [`LlmUsageLog`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/llmUsageLog.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `requestId`: `String` (Unique, Indexed)
  - `userId`: `ObjectId` (Ref: `User`, Required, Indexed)
  - `provider`: `String` (Default: `'openai'` / `'bedrock'`)
  - `model`: `String`
  - `promptTokens`, `completionTokens`, `totalTokens`, `creditsDeducted`: `Number`
  - `latencyMs`: `Number`
  - `status`: `String` (Enum: `'SUCCESS'`, `'FAILED'`, `'PARTIAL'`, `'TIMEOUT'`)
  - `errorMessage`, `idempotencyKey`: `String`
  - `metadata`: `Record<string, any>` (Stores `runId`, cached response)

### 8. `jobapplications`
- **Mongoose Model:** [`JobApplication`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/jobApplication.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `userId`: `ObjectId` (Ref: `User`, Required, Indexed)
  - `jobId`: `String` (Required, Compound Indexed with `userId`)
  - `title`, `company`, `location`, `salaryRange`: `String`
  - `fitScore`: `Number`
  - `status`: `String` (Enum: `'QUEUED'`, `'APPLIED'`, `'DRY_RUN_SUCCESS'`, `'NEEDS_MANUAL_REVIEW'`, `'FAILED_MISSING_DATA'`, `'PENDING_RESUME_APPROVAL'`, `'SKIPPED_JOB_REMOVED'`, `'SKIPPED_MISSING_RESUME'`)
  - `appliedAt`: `Date`

### 9. `webhookledgers`
- **Mongoose Model:** [`WebhookLedger`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/models/webhookLedger.model.ts)
- **Fields:**
  - `_id`: `ObjectId`
  - `eventId`: `String` (Required, Unique, Indexed)
  - `eventType`: `String`
  - `providerPaymentId`: `String`
  - `status`: `String` (Enum: `'PROCESSING'`, `'PROCESSED'`, `'FAILED'`)
  - `errorMessage`: `String`
  - `payload`: `Mixed`
  - `processedAt`: `Date`

---

## 5. API ENDPOINTS

All endpoints are prefixed with `/api/v1`.

| Method | Endpoint Path | Purpose | Authentication |
|---|---|---|---|
| `GET` | `/health` / `/health/live` | Liveness health check | Public |
| `GET` | `/ready` / `/health/ready` | Readiness probe (verifies MongoDB connection) | Public |
| `POST` | `/auth/register` | Registers user, hashes password, starts 5-day trial | Public (Rate-limited: 5/15m) |
| `POST` | `/auth/login` | Authenticates user credentials and returns JWT | Public (Rate-limited: 5/15m) |
| `GET` | `/auth/me` | Fetches authenticated user identity | Bearer JWT Required |
| `POST` | `/auth/logout` | Client logout acknowledgement | Public |
| `GET` | `/subscription/plans` | Lists available subscription plans | Public |
| `GET` | `/subscription/me` | Fetches active subscription & trial status | Bearer JWT Required |
| `POST` | `/subscription/checkout` | Generates Razorpay subscription session | Bearer JWT Required |
| `POST` | `/subscription/verify-payment` | Verifies checkout HMAC signature & upgrades tier | Bearer JWT Required |
| `POST` | `/subscription/trial/activate` | Explicitly requests free trial activation | Bearer JWT Required |
| `POST` | `/subscription/cancel` | Flags subscription to cancel at period end | Bearer JWT Required |
| `GET` | `/credits/balance` | Returns allocated, used, and remaining credits | Bearer JWT Required |
| `GET` | `/credits/history` | Returns paginated credit ledger transaction history | Bearer JWT Required |
| `POST` | `/credits/refund` | Refunds deducted credits for failed/skipped runs | Bearer JWT Required |
| `POST` | `/llm/chat` | Cloud Bedrock completions proxy (deducts credits) | Bearer JWT + Entitlement |
| `POST` | `/llm/chat/completions` | OpenAI-compatible Bedrock proxy endpoint | Bearer JWT + Entitlement |
| `GET` | `/llm/usage` | Returns LLM completion telemetry history | Bearer JWT Required |
| `POST` | `/resume/upload-and-parse` | Uploads PDF/DOCX resume & populates CareerBrain | Bearer JWT Required |
| `POST` | `/resume/generate` | Generates keyword-tailored binary PDF resume | Public (Validated body) |
| `GET` | `/profile` | Fetches candidate master profile from MongoDB | Bearer JWT Required |
| `PUT` | `/profile` | Updates candidate profile in MongoDB | Bearer JWT Required |
| `GET` | `/profile/quota` | Checks candidate daily application quota | Bearer JWT Required |
| `POST` | `/profile/quota/check-and-increment`| Atomically validates and increments daily apply count | Bearer JWT Required |
| `POST` | `/job-applications` | Records job application state | Public / Unenforced |
| `GET` | `/job-applications/check/:userId/:jobId` | Checks if job was already applied in MongoDB | Public / Unenforced |
| `GET` | `/job-applications/:userId` | Lists job application history for a user | Public / Unenforced |
| `PATCH`| `/job-applications/:id/status` | Updates job application status | Public / Unenforced |
| `POST` | `/webhooks/razorpay` | Ingests server-to-server Razorpay webhooks | Public (HMAC Signature Verified) |

---

## 6. CONFIGURATION & ENVIRONMENT

### Required Backend Environment Variables (`.env`)

```ini
# Server Runtime
PORT=5000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000,http://localhost:5000,chrome-extension://*
LOG_LEVEL=info

# Database
MONGO_URI=mongodb://127.0.0.1:27017/nanobrowser_saas

# JWT Security
JWT_SECRET=super_secret_jwt_key_must_be_changed_in_production_min_32_chars
JWT_EXPIRES_IN=15m

# Razorpay Commercial Billing
RAZORPAY_KEY_ID=rzp_test_your_key_id_here
RAZORPAY_KEY_SECRET=your_razorpay_key_secret_here
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret_here

# Managed LLM Gateway (AWS Bedrock Runtime)
AWS_BEDROCK_API_KEY=your_bedrock_bearer_token_here
AWS_BEDROCK_REGION=us-east-1
LLM_DEFAULT_MODEL=amazon.nova-lite-v1:0
```

### External Services Setup Checklist

1. **MongoDB Database:**
   - Local MongoDB instance or MongoDB Atlas cluster.
   - Requires unique indexes on `users.email`, `careerbrains.userId`, `usercreditbalances.userId`, `webhookledgers.eventId`, and `llmusagelogs.requestId`.
2. **AWS Bedrock Runtime:**
   - AWS Account with Bedrock model access granted for: `amazon.nova-lite-v1:0`, `anthropic.claude-3-5-sonnet-20240620-v1:0`, `amazon.nova-pro-v1:0`.
   - Bearer API Key / Bedrock runtime token exported as `AWS_BEDROCK_API_KEY` in region `us-east-1` (or configured region).
3. **Razorpay Dashboard:**
   - Razorpay Merchant Account (Test or Live).
   - Subscription plans registered or using defaults (`plan_TZuBsK8wKLB8G6` for Starter).
   - Webhook URL configured pointing to `https://<domain>/api/v1/webhooks/razorpay` subscribed to events: `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.halted`, `payment.captured`, `payment.failed`.

---

## 7. KNOWN ISSUES / INCOMPLETE WORK

Based on a strict inspection of the current code, the following discrepancies, incomplete implementations, and hardcoded values exist:

1. **Hardcoded `localhost:5000` URLs in Extension:**
   - [`packages/shared/lib/backend-api-client.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/packages/shared/lib/backend-api-client.ts#L16): `constructor(baseUrl = 'http://localhost:5000/api/v1')` hardcodes `localhost:5000`.
   - [`chrome-extension/src/background/agent/activeModelHelper.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/activeModelHelper.ts#L53): `baseURL: 'http://localhost:5000/api/v1/llm'` hardcodes `localhost:5000`.
   - [`chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts#L227): `baseURL: 'http://localhost:5000/api/v1/llm'` hardcodes `localhost:5000`.
   - [`chrome-extension/src/background/index.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/index.ts#L97): `baseURL: 'http://localhost:5000/api/v1/llm'` hardcodes `localhost:5000`.
   - *Impact:* The extension cannot communicate with a remote production backend until these URLs are replaced with an environment variable or configurable storage setting.

2. **Orphaned `JobApplication` Backend Route & Port Mismatch:**
   - [`backend/src/routes/jobApplication.routes.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/routes/jobApplication.routes.ts) lacks authentication middleware (`authenticate`), leaving `POST /job-applications` open.
   - The live `dedicatedJobRunner.ts` saves application state into Chrome's local storage (`processedJobsStore`), **not** to the backend MongoDB `jobapplications` collection.
   - The legacy [`chrome-extension/src/background/agent/linkedin/backendClient.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/linkedin/backendClient.ts#L15) hardcodes `http://localhost:3000/api/v1` (an incorrect port, as backend runs on 5000).

3. **Short JWT Lifespan without Refresh Token Flow:**
   - [`backend/src/config/env.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/config/env.ts#L20) sets `JWT_EXPIRES_IN=15m`.
   - The backend does not implement a `POST /auth/refresh` endpoint or refresh token cookie/mechanism.
   - *Impact:* Once 15 minutes elapse, API calls from the extension to `/api/v1/llm` or `/api/v1/profile` fail with 401 Unauthorized unless the user logs in again.

4. **Multi-Platform Auto-Apply Maturity Discrepancy:**
   - **LinkedIn:** Fully mature with CDP debugger control, split-pane extraction, verified Easy Apply modal automation, and error self-healing.
   - **Naukri & Indeed:** The adapters ([`naukriAdapter.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/platforms/naukri/naukriAdapter.ts) and [`indeedAdapter.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/platforms/indeed/indeedAdapter.ts)) have working search URL builders, login checks, and job card extractors, but form submission relies on generic selector fallbacks that may break when ATS modals deviate.

5. **No Admin Panel / Admin Functionality:**
   - Although `User.role` contains `'admin'`, there are no routes or UI screens implemented for an administrator to manage users, manually adjust credits, or inspect tenant subscriptions.

6. **TODOs Present in Codebase:**
   - [`chrome-extension/src/background/agent/actions/builder.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/actions/builder.ts#L141): `// TODO: can not make every action optional, don't know why`
   - [`chrome-extension/src/background/agent/agents/base.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/agents/base.ts#L58): `// TODO: fix this, the name is not correct in production environment`
   - [`chrome-extension/src/background/agent/agents/navigator.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/agents/navigator.ts#L607): `// TODO: wait for 1 second for now, need to optimize this to avoid unnecessary waiting`
   - [`chrome-extension/src/background/agent/helper.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/chrome-extension/src/background/agent/helper.ts#L345): `// TODO: configure the context window size in model config`

---

## 8. DEPLOYMENT STATUS

- **Current Deployment:** **Local Development Only.**
- **Backend Deployment:** The backend has a basic [`Dockerfile`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/Dockerfile), but it exposes port 3000 (mismatched with port 5000 in `env.ts`). It is not currently deployed to any live cloud provider (such as AWS ECS, Render, Railway, or Fly.io).
- **Frontend / Extension Deployment:** Built locally into `dist/` and packaged into `dist-zip/JobPilot-Extension-Latest.zip`. It has not been published to the Chrome Web Store.
- **Production Configuration:** Production mode (`NODE_ENV=production`) is protected by strict validation in [`env.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/config/env.ts), which rejects mock Razorpay keys and mock Bedrock credentials on server boot.

---

## 9. WHAT'S MISSING FOR LAUNCH

To transition this system into a commercially viable, production-ready product, the following work is required:

### 1. Networking & Configuration
- **Dynamic Backend URL Configuration:** Introduce a build-time environment variable (`VITE_BACKEND_API_URL`) or an in-extension settings field so the extension connects to a live HTTPS domain instead of `http://localhost:5000`.
- **Align Dockerfile Port:** Update `backend/Dockerfile` to expose `PORT 5000` to match `env.ts`.

### 2. Authentication & Session Resilience
- **Refresh Token Mechanism:** Implement a secure refresh token flow (e.g. rotating HTTP-only cookies or long-lived refresh tokens) so users remain logged in beyond 15 minutes.
- **OAuth Providers:** Implement Google OAuth (`chrome.identity.getAuthToken` on frontend + Google token verification on backend) for streamlined sign-ins.

### 3. API & Data Alignment
- **Sync Applications to MongoDB:** Connect `dedicatedJobRunner.ts` to `POST /api/v1/job-applications` so applications are persisted in the cloud database alongside Chrome local storage.
- **Add Authentication to Job Application Routes:** Add the `authenticate` middleware to [`backend/src/routes/jobApplication.routes.ts`](file:///c:/Users/ASUS/OneDrive/Desktop/nanobrowser/backend/src/routes/jobApplication.routes.ts).

### 4. Cloud Infrastructure & Security Hardening
- **Deploy Backend on Container Infrastructure:** Deploy `backend` to a production service (AWS ECS/Fargate, Render, or Railway) with HTTPS / SSL termination.
- **Set Up MongoDB Atlas:** Migrate from local `mongodb://127.0.0.1:27017` to a managed MongoDB Atlas replica set with automated backups.
- **Razorpay Production Credentials:** Configure real Razorpay live keys and verify webhook endpoint over a public HTTPS URL.
- **AWS Bedrock Production IAM:** Configure AWS IAM roles or Bedrock API keys with appropriate rate limit quotas in AWS.

### 5. Extension Packaging & Store Submission
- **Extension Privacy Policy:** Create a hosted privacy policy explaining local resume storage and CDP debugger usage.
- **Chrome Web Store Compliance Review:** Prepare store assets, remove any development-mode mock strings, and submit the extension bundle for store review.
