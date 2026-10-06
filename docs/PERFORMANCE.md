# Performance Audit & Optimization Guide

## 1. Backend Performance
- **Connection Pooling**: Mongoose maintains pooled connections to MongoDB.
- **Index Optimization**: All critical query paths utilize compound indexes:
  - Credit Balance: `{ userId: 1, remainingCredits: 1 }`
  - Subscriptions: `{ status: 1, isTrial: 1, trialEndDate: 1 }`
  - Ledgers: `{ userId: 1, 'metadata.runId': 1 }`
- **Response Payloads**: Responses are compressed and paginated (default 20 items).

---

## 2. Chrome Extension & Memory Usage
- **Service Worker Lifecycle**: Chrome MV3 terminates idle service workers. The runner maintains an active keep-alive alarm (`startKeepAlive()`) only while a job run is actively executing, releasing resources upon completion.
- **DOM Leaks**: Injected content scripts detach observers once modal completion or navigation triggers.
