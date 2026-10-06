# Error Handling & Fault Tolerance Guide

## 1. Backend Global Error Architecture
- **Central Handler**: `backend/src/middleware/errorHandler.ts`.
- **Custom Error Class**: `AppError(message, statusCode, code, details)`.
- **Standardized API Error Response Contract**:
  ```json
  {
    "success": false,
    "error": {
      "message": "Human-readable explanation",
      "code": "MACHINE_READABLE_CODE",
      "statusCode": 400,
      "details": []
    }
  }
  ```

---

## 2. Specialized Error Mappers
1. **Zod Validation Errors**: Mapped to HTTP 400 with itemized field paths and messages.
2. **Mongoose Duplicate Key Errors (`E11000`)**: Mapped to HTTP 409 Conflict with duplicate field name.
3. **JWT Errors**: Mapped to HTTP 401 (`TOKEN_EXPIRED`, `INVALID_TOKEN`).
4. **Unhandled Exceptions**: Caught by global handler, logged via Winston with correlation ID, and returns HTTP 500 in production without leaking internal stack traces.

---

## 3. Extension Automation Resilience & Self-Healing
1. **Form Validation Failures**: `formErrorInspector.ts` detects red warning labels or unfulfilled required inputs, re-evaluates fields using alternative selectors, or safely aborts the job application before clicking submit.
2. **Debugger Detach Recovery**: If the user closes the automation tab or clicks "Cancel" on Chrome's debugger banner, `handleDebuggerDetach` safely stops the runner, cleans up state, and issues an automatic credit refund via `/api/v1/credits/refund`.
3. **Session Interruption Recovery**: On extension service worker startup, `recoverInterruptedRunOnStartup()` scans for incomplete runner sessions and resets the runner state to `IDLE`.
