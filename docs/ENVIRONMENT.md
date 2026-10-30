# Environment Variables Configuration & Audit

## 1. Schema Validation Overview
Environment variables for the backend are validated at startup in `backend/src/config/env.ts` using **Zod**. If any required variable fails validation, the server crashes immediately with an explicit error trace.

---

## 2. Complete Environment Variable Inventory

| Variable Name | Required | Default / Fallback | Type | Description |
|---|---|---|---|---|
| `PORT` | No | `5000` | Number | HTTP listening port for Express backend. |
| `NODE_ENV` | No | `development` | Enum (`development`, `production`, `test`) | Node runtime mode. Suppresses logs in test. |
| `CORS_ORIGIN` | No | `*` | String (Comma-separated) | Allowed origins for browser CORS headers. |
| `FIREBASE_PROJECT_ID` | **Yes** | — (`NEXT_PUBLIC_FIREBASE_PROJECT_ID` also accepted) | String | Firebase project that hosts the Realtime Database (the JobForm Automator project). |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | **Yes** | — | String | Service-account client email (same name as JobForm Automator). Without it, database routes return 503. |
| `FIREBASE_ADMIN_PRIVATE_KEY` | **Yes** (secret) | — | String (PEM, `\n` escapes allowed) | Service-account private key. Store in Secret Manager, never in the extension build. |
| `FIREBASE_DATABASE_URL` | **Yes** | — (`NEXT_PUBLIC_FIREBASE_DATABASE_URL` also accepted) | URL | Realtime Database URL. |
| `NANOBROWSER_RTDB_ROOT` | No | `nanobrowser` | String | Namespace node every backend path lives under (keeps the data apart from JobForm Automator's nodes). |
| `MIGRATION_MONGO_URI` | Migration only | — | String | Read-only MongoDB URI used only by `src/scripts/migrate-mongo-to-rtdb`. The server never reads it. |
| `LOG_LEVEL` | No | `info` | Enum (`error`, `warn`, `info`, `http`, `debug`) | Winston logging verbosity level. |
| `JWT_SECRET` | **Yes** (Prod) | `super_secret_jwt_key_must_be_changed...` | String (Min 16 chars) | Secret key for signing HS256 access tokens. |
| `JWT_EXPIRES_IN` | No | `15m` | String | Access token expiration duration. |
| `JWT_REFRESH_SECRET` | **Yes** (Prod) | `super_secret_jwt_refresh_key_must_be...` | String (Min 16 chars) | Secret key for signing HS256 refresh tokens. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | String | Refresh token expiration duration. |
| `RAZORPAY_KEY_ID` | **Yes** (Prod) | `rzp_test_mock_key_id_12345` | String | Commercial payment Key ID from Razorpay. |
| `RAZORPAY_KEY_SECRET` | **Yes** (Prod) | `rzp_test_mock_key_secret_67890` | String | Commercial payment Secret from Razorpay. |
| `RAZORPAY_WEBHOOK_SECRET` | **Yes** (Prod) | `rzp_test_mock_webhook_secret_abcde` | String | Webhook HMAC verification secret. |
| `LLM_PROVIDER` | No | `gemini` | Enum (`gemini`, `bedrock`) | Active managed LLM provider for the backend proxy gateway. |
| `GEMINI_API_KEY` | **Yes** (when using Gemini) | `""` | String | API Key for Google Gemini (Google AI Studio / Secret Manager). |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | String | Model identifier for Google Gemini (e.g. `gemini-2.5-flash`, `gemini-2.5-pro`). |
| `AWS_BEDROCK_API_KEY` | **Yes** (when using Bedrock) | `mock_bedrock_api_key` | String | Bearer token / runtime key for AWS Bedrock. |
| `AWS_BEDROCK_REGION` | No | `us-east-1` | String | AWS region hosting Bedrock models. |
| `OPENAI_API_KEY` | Optional | `undefined` | String | Fallback OpenAI API key for GPT-4o models. |
| `LLM_DEFAULT_MODEL` | No | `gemini-2.5-flash` | String | Default model identifier for LLM proxy (validated against `ALLOWED_MODELS`). |

---

## 3. Security Recommendations for Production
> [!CAUTION]
> The default values in `env.ts` are designed for painless local developer onboarding. In a production deployment:
> 1. `JWT_SECRET` and `JWT_REFRESH_SECRET` MUST be replaced with cryptographically random strings (min 64 chars).
> 2. `CORS_ORIGIN` MUST NOT be set to `*`. Set it to specific origins: `https://app.yourdomain.com,chrome-extension://<EXTENSION_ID>`.
> 3. Never commit `.env` files to version control.
