# Comprehensive Security, Workflow & Device Access Audit

## 1. Executive Summary & Purpose
This document provides an exhaustive architectural, security, and privacy audit of the **JobPilot AI (NanoBrowser)** Chrome Extension and Backend ecosystem. 

It explicitly documents:
1. **The End-to-End Extension Workflow**: How the extension operates from installation to autonomous job application.
2. **User Device Access Audit**: Exactly what physical, software, and browser resources the extension accesses on the user's computer, with strict verification of zero unauthorized hardware/file access.
3. **Data Privacy & Transmission Boundaries**: What data remains local to the user's machine versus what leaves via encrypted network channels.
4. **Threat Vector Analysis**: Defense-in-depth posture across authentication, CDP automation, and payment gateways.

---

## 2. End-to-End Extension Workflow

The extension operates as a local client-side autonomous agent packaged under **Chrome Manifest V3**:

```
[1. User Installation & Launch]
       │
       ▼
[2. Side Panel Initialization (Chrome sidePanel API)]
       │
       ▼
[3. Local Profile Setup (Career Brain in chrome.storage.local)]
       │  • User enters name, contact, education, target roles
       │  • User attaches resume files (PDF/DOCX)
       │  • Sensitive data saved exclusively in local browser storage
       ▼
[4. LLM & Backend Authentication]
       │  • User logs in via JWT or custom API Key (Gemini, OpenAI, Groq)
       │  • Credit balance verified via HTTPS (Cloud Run backend)
       ▼
[5. Dedicated Runner Tab Initialization]
       │  • Extension opens a dedicated window/tab on LinkedIn / Naukri / Indeed
       │  • Puppeteer-core attaches via Chrome DevTools Protocol (`chrome.debugger`)
       │  • Chrome displays standard debugging notification banner
       ▼
[6. Search & Job Discovery]
       │  • Injects search queries for candidate's target roles and locations
       │  • Filters out closed, promoted-external, or already-applied jobs
       ▼
[7. Autonomous Form Resolution Loop]
       │  • Detects Easy Apply modal dialog
       │  • Identifies interactive form fields (text, radio, dropdowns, typeaheads)
       │  • Resolves answers using 3-Tier Hierarchy:
       │      Tier 1: Extension Career Brain (Local Ground Truth)
       │      Tier 2: Injected Platform Profile Snapshot
       │      Tier 3: Zero-Hallucination LLM Reasoner (Cached in questionMemory)
       ▼
[8. Submission & Post-Apply Cleanup]
       │  • Verifies all required fields and agreement disclosures
       │  • Clicks submit and confirms platform receipt
       │  • Dismisses post-submit confirmation dialog
       │  • Detaches `chrome.debugger` session immediately upon run completion
```

---

## 3. User Device Access & Hardware Permissions Audit

A comprehensive review of what permissions and hardware resources the extension accesses on the user's physical computer:

| Device / System Resource | Access Status | Nature of Access | Technical Verification & Safeguards |
| :--- | :---: | :--- | :--- |
| **Physical Hard Drive / OS Files** | ❌ **NO ACCESS** | The extension has **zero access** to the user's operating system, files, folders, Desktop, or personal documents. | Browser sandbox strictly blocks arbitrary file access. Resumes are only accessed when the user explicitly uploads them via standard HTML `<input type="file">`. |
| **Webcam / Camera** | ❌ **NO ACCESS** | The extension never requests, contains, or accesses camera streams. | `getUserMedia({ video: true })` does not exist in the codebase. No camera permissions in Manifest. |
| **GPS / Geolocation Hardware** | ❌ **NO ACCESS** | The extension never tracks the physical device location via GPS or network triangulation. | `geolocation` permission is absent from `manifest.js`. Only the city manually typed in the profile is used. |
| **OS Keystroke / Global Keylogging** | ❌ **NO ACCESS** | The extension cannot log keystrokes outside of its own UI. | Sandboxed Chrome Extension security model prevents global keyboard/mouse hooks. |
| **Microphone Hardware** | ⚠️ **OPTIONAL (On-Demand Only)** | Accessed **strictly and only if** the user clicks the voice input icon in the AI Chat tab. | Uses standard `navigator.mediaDevices.getUserMedia({ audio: true })`. Tracks are immediately stopped (`track.stop()`) as soon as speech recognition completes. Never runs in the background. |
| **Local Browser Storage** | ✅ **LOCAL ONLY** | `chrome.storage.local` & `unlimitedStorage`. | Stores user profile, resume text, application logs, and settings **on the user's machine**. This data is not uploaded to external databases. |
| **Active Browser Tabs** | ✅ **SCOPED** | `tabs`, `activeTab`, `webNavigation`. | Used to open, navigate, and monitor job portal tabs (LinkedIn, Indeed, Naukri) during an autonomous apply run. |
| **Chrome Debugger (`chrome.debugger`)** | ✅ **CONTROLLED** | Uses Chrome DevTools Protocol (CDP) via Puppeteer-core. | Controls **only the designated runner tab**. Chrome displays a visible top notification banner ("*Nanobrowser started debugging this browser*"). Automatically detached when applying stops. |
| **Cookies** | ✅ **SCOPED** | `cookies`. | Used exclusively for website session synchronization between the SaaS web portal and the extension. Does not harvest third-party session cookies. |

---

## 4. Network Transmission & Data Privacy Audit

### What Data Leaves the Device:
1. **User Authentication & Credits**: HTTPS requests to `https://nanobrowser-backend-336340854879.asia-south1.run.app` for JWT login and credit balance queries.
2. **AI Screening Question Resolution**: When an employer asks a custom question that is not answered in the candidate's profile, the question and a sanitized resume snippet are sent to the user's selected LLM provider (Google Gemini, OpenAI, or Groq) over encrypted TLS.

### What Data NEVER Leaves the Device:
1. **Raw OS Environment**: No system files, host environment variables, or private computer details are transmitted.
2. **Passwords & Private Credentials**: Passwords for LinkedIn, Naukri, or Indeed are **never read, logged, or sent**; the extension operates on existing logged-in browser cookies locally.
3. **Application History**: Stored strictly in local indexed browser storage (`chrome.storage.local`).

---

## 5. Threat Vector Analysis & Backend Security

### A. Authentication & Session Management
- **Audit Findings**:
  - JWT tokens signed using HS256 with strict minimum length requirements on secrets (16 chars minimum, recommended 64).
  - Passwords hashed using bcrypt (12 rounds).
  - Refresh tokens are hashed using SHA-256 before storage in MongoDB; raw refresh tokens never reside in the database.
  - Automatic **Token Reuse Detection** invalidates all sessions for an account if an old refresh token is presented.
- **Risk Rating**: **LOW**.

### B. Financial Transactions & Webhooks
- **Audit Findings**:
  - Webhooks use strict HMAC-SHA256 signature verification over raw binary Buffer.
  - Idempotent processing via `WebhookLedger` prevents double-crediting or replay attacks.
  - Cross-user ownership validation ensures a user cannot claim a subscription created by another account.
- **Risk Rating**: **LOW**.

### C. Injection & Data Validation
- **Audit Findings**:
  - Zod schemas validate all incoming HTTP bodies, queries, and route params.
  - MongoDB queries utilize strongly-typed Mongoose models, mitigating standard NoSQL injection vectors.
  - Candidate search queries are sanitized before URL construction (`sanitizeRoleSearchQuery`).
- **Risk Rating**: **LOW**.

### D. Cross-Origin Resource Sharing (CORS) & Headers
- **Audit Findings**:
  - Helmet middleware applies secure headers.
  - Production `CORS_ORIGIN` restricts origins to specific domains and the Chrome extension ID.
- **Risk Rating**: **LOW**.

---

## 6. Audit Conclusion & Compliance Sign-Off
- **Device Access Compliance**: The extension requests the minimum necessary permissions required for autonomous web interaction. It does not monitor, harvest, or access unauthorized computer hardware.
- **Chrome Web Store Policy**: Follows the principle of least privilege under Manifest V3. The use of `debugger` is justified exclusively for autonomous job application navigation in the designated runner tab.
- **User Transparency**: All background operations are accompanied by on-screen visual activity logs, and Chrome's native CDP banner clearly notifies the user whenever browser automation is active.
