# 📚 NanoBrowser Engineering & Architecture Documentation Index

Welcome to the NanoBrowser technical documentation library. This directory contains comprehensive architectural, design, testing, and deployment references prepared for engineering audits, code reviews, and production QA.

---

## 🏛️ System Architecture & Data Flow
| Document | Purpose |
| :--- | :--- |
| [ARCHITECTURE.md](file:///docs/ARCHITECTURE.md) | High-level system architecture, extension design, and backend SaaS integration |
| [AI-SYSTEM.md](file:///docs/AI-SYSTEM.md) | Agent execution pipeline, Planner-Navigator loop, and LLM reasoning flow |
| [DATA-FLOW.md](file:///docs/DATA-FLOW.md) | End-to-end data flow between Chrome extension, background service worker, and backend |
| [DEPENDENCY-GRAPH.md](file:///docs/DEPENDENCY-GRAPH.md) | Dependency graph across monorepo packages |
| [FILE-MAP.md](file:///docs/FILE-MAP.md) | Complete codebase file map and directory structure breakdown |

---

## ☁️ Cloud & Backend Infrastructure
| Document | Purpose |
| :--- | :--- |
| [GOOGLE_CLOUD_DEPLOYMENT_GUIDE.md](file:///docs/GOOGLE_CLOUD_DEPLOYMENT_GUIDE.md) | Step-by-step Google Cloud Run, Secret Manager & Service Account deployment guide |
| [BACKEND.md](file:///docs/BACKEND.md) | Node.js Express & TypeScript backend architecture and services |
| [DATABASE.md](file:///docs/DATABASE.md) | MongoDB Atlas schema design, models, indexes, and credit ledgers |
| [API.md](file:///docs/API.md) | Complete REST API specification (Auth, Credits, Subscriptions, Resumes, LLM) |
| [AUTH.md](file:///docs/AUTH.md) | Dual authentication specification (JWT pair + Google OAuth2 ID Token flow) |
| [PAYMENTS.md](file:///docs/PAYMENTS.md) | Commercial Razorpay integration, subscription plans, webhooks, and credit allocation |

---

## 🧩 Chrome Extension & Agent Engine
| Document | Purpose |
| :--- | :--- |
| [EXTENSION.md](file:///docs/EXTENSION.md) | Chrome Manifest V3 extension architecture, side panel UI, background service workers |
| [FRONTEND.md](file:///docs/FRONTEND.md) | React 18, Tailwind CSS, Lucide icons, and state management |
| [BUSINESS-LOGIC.md](file:///docs/BUSINESS-LOGIC.md) | Core business logic, LinkedIn Easy Apply engine, and Career Brain parsing |

---

## 🛡️ Security, Quality Assurance & Audit
| Document | Purpose |
| :--- | :--- |
| [SECURITY-AUDIT.md](file:///docs/SECURITY-AUDIT.md) | Security controls, token handling, rate limiters, input sanitization, and secret protection |
| [CODE-REVIEW.md](file:///docs/CODE-REVIEW.md) | Senior engineering code review observations, patterns, and best practices |
| [TESTING.md](file:///docs/TESTING.md) | Testing strategy, Vitest integration suites, mock isolation, and e2e validation |
| [ERROR-HANDLING.md](file:///docs/ERROR-HANDLING.md) | Centralized error handling, HTTP error codes, and graceful fallbacks |
| [PERFORMANCE.md](file:///docs/PERFORMANCE.md) | Performance benchmarks, bundle optimizations, and runtime caching |
| [SCALABILITY.md](file:///docs/SCALABILITY.md) | Cloud Run auto-scaling, database connection pooling, and worker queues |
| [TECHNICAL-DEBT.md](file:///docs/TECHNICAL-DEBT.md) | Technical debt log, resolved items, and future roadmap enhancements |

---

## 🚀 Onboarding & Developer Operations
| Document | Purpose |
| :--- | :--- |
| [NEW-DEVELOPER-QUICKSTART.md](file:///docs/NEW-DEVELOPER-QUICKSTART.md) | 5-minute setup guide for new developers joining the team |
| [DEVELOPMENT-WORKFLOW.md](file:///docs/DEVELOPMENT-WORKFLOW.md) | Git branch conventions, commit standards, build commands, and pull request checklist |
| [ENVIRONMENT.md](file:///docs/ENVIRONMENT.md) | Environment variable definitions across root, backend, and extension |
| [TROUBLESHOOTING.md](file:///docs/TROUBLESHOOTING.md) | Common development and runtime issues with troubleshooting steps |
| [PROJECT-HANDOVER.md](file:///docs/PROJECT-HANDOVER.md) | Engineering handover document for QA and production release |
