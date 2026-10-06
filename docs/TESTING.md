# Testing Strategy & Test Suite Guide

## 1. Test Harness Overview
The repository utilizes **Vitest** for fast unit and integration testing:
- **Backend Tests**: `backend/src/tests/`
- **Extension Tests**: `chrome-extension/src/background/agent/__tests__/`

---

## 2. Executing Tests

### Running Chrome Extension Tests (153 Tests)
```bash
cd chrome-extension
pnpm vitest run
```

Verified test coverage includes:
- `roleResolution.test.ts`: Ensures candidate names are never used as job search titles.
- `dedicatedJobRunner.tabMode.test.ts`: Tab mode creation, boundary checks, and teardown.
- `indeedAdapter.test.ts`: Indeed search URL construction, pagination, and question parsing.
- `indeedPacing.test.ts`: Anti-detection human delay intervals.
- `semanticMatching.test.ts`: Resume skill similarity vector matching.
- `verification.test.ts`: Modal field resolution verification.

### Running Backend Unit & Integration Tests
```bash
cd backend
pnpm test
```

Verified test coverage includes:
- `auth.test.ts`: Registration, login, JWT issuance, refresh rotation, and reuse revocation.
- `credit.test.ts`: Atomic deduction concurrency, balance overdraft prevention, and idempotent retry.
- `payment.test.ts`: Razorpay signature verification and webhook idempotency.
- `trial.test.ts`: 7-day trial provisioning and expiration worker reconciliation.
- `llm.test.ts`: Model token calculation, credit metering, and usage logging.
