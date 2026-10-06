# Technical Debt & Known Risks

## 1. Itemized Technical Debt

| Item ID | Component | Description | Impact | Priority |
|---|---|---|---|---|
| **TD-01** | `dedicatedJobRunner.ts` | Monolithic 4,300+ line file combining orchestration, DOM selectors, and pacing. | High cognitive load for maintenance. | High |
| **TD-02** | `TrialExpirationWorker` | Uses `node-cron` inside the web server process instead of a dedicated worker process. | May execute duplicate checks if horizontally scaled. | Medium |
| **TD-03** | Platform Selectors | DOM selectors on LinkedIn and Naukri are subject to periodic frontend redesigns. | Potential breakages if portal DOM classes change. | Medium |
| **TD-04** | Indeed Adapter | Contains deprecated helper scripts in `platforms/indeed/deprecated/`. | Code bloat; should be pruned in next release. | Low |
| **TD-05** | Production Secrets | `env.ts` contains fallback default values for JWT and Razorpay secrets. | Security risk if deployed without setting production environment variables. | Critical |
