# Project Handover Document

## 1. Executive Summary
**NanoBrowser (JobPilot)** is a production-ready, commercial AI browser extension and SaaS platform designed for autonomous job hunting. The repository is a monorepo consisting of:
- A Manifest V3 Chrome Extension powered by Puppeteer/CDP in-browser automation.
- An Express.js 4 backend with MongoDB, Razorpay subscription billing, AWS Bedrock Claude 3.5 Sonnet / OpenAI LLM proxying, and credit balance management.
- React 18 frontend interfaces (SidePanel, Options Dashboard, Content Harvesters).

The system is architected to allow job seekers to upload a resume, automatically generate a rich structured `CareerBrain` profile, configure search preferences, and launch an autonomous runner that navigates LinkedIn, Naukri, or Indeed, reads job postings, assesses fit, answers complex application questions, and submits applications autonomously.

---

## 2. Handover Team Roles & Responsibilities

| Subsystem | Core Technologies | Primary Responsibilities |
|---|---|---|
| **Backend API & Data** | Express 4, Mongoose 8, Node.js 20 | Authentication, credit ledger, Razorpay webhooks, trial expiration cron, LLM gateway. |
| **Extension Engine** | Chrome MV3, Puppeteer Core, CDP | Autonomous runner loop, browser tab management, DOM element interaction, anti-detection pacing. |
| **Platform Adapters** | TypeScript, DOM Selectors | Specific logic for LinkedIn Easy Apply, Naukri Fast Forward, Indeed Instant Apply. |
| **AI & Intelligence** | Bedrock Claude 3.5, LangChain, OpenAI | Resume parsing, candidate target role resolution, semantic question matching, form healing. |
| **Frontend UI** | React 18, Vite, TailwindCSS | Side panel application manager, settings dashboard, authentication gate, real-time log viewers. |

---

## 3. Current Deployment Status

| Component | Target Runtime | Deployment Mechanism | Status |
|---|---|---|---|
| **Backend API** | Node.js (AWS EC2 / Render / Railway) | Docker / Node process (`npm start`) | Production Ready |
| **Database** | MongoDB Atlas (Replica Set) | Managed Mongoose connection | Production Ready |
| **Payment Gateway** | Razorpay Live API | Webhooks + Checkout API | Configured & Tested |
| **LLM Gateway** | AWS Bedrock (us-east-1) | Bearer Token / IAM | Active |
| **Chrome Extension** | Google Chrome Web Store / Unpacked | Zip package via `pnpm zip` | Packaged in `dist-zip/` |

---

## 4. Critical Developer Contacts & Upstream Services
- **Razorpay Dashboard**: Subscription plans, payment verification, and webhook event logs (`https://dashboard.razorpay.com`).
- **AWS Bedrock Console**: Bedrock Claude 3.5 Sonnet runtime access in `us-east-1` (`https://console.aws.amazon.com/bedrock`).
- **Chrome Developer Dashboard**: Extension publishing and manifest compliance (`https://chrome.google.com/webstore/devconsole`).
- **MongoDB Atlas**: Database cluster monitoring and performance indexes (`https://cloud.mongodb.com`).

---

## 5. 30-Day Transition Roadmap & Handoff Checklist
- [x] Complete code audit and file inventory documented in `docs/`.
- [x] Verified full build across all 8 monorepo workspaces via `pnpm build`.
- [x] Verified test suite passing (153 unit tests in extension).
- [ ] Setup production staging environment with dedicated MongoDB replica set.
- [ ] Connect Razorpay live keys and verify webhook endpoint over HTTPS.
- [ ] Setup Sentry / Datadog error monitoring on backend.
- [ ] Review Google Chrome Web Store review guidelines for Manifest V3 permissions.
