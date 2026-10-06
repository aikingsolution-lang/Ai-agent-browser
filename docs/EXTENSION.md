# Chrome Extension (Manifest V3) Architecture

## 1. Overview & Manifest V3 Design
The extension in `chrome-extension/` is built for Google Chrome's **Manifest V3** standard. It operates as an autonomous background agent capable of controlling Chromium pages, listening to DOM events, solving complex questionnaires, and maintaining long-running runner state across browser tab lifecycles.

- **Manifest File**: `chrome-extension/manifest.ts`
- **Permissions**: `storage`, `sidePanel`, `tabs`, `activeTab`, `scripting`, `debugger`, `alarms`, `cookies`.
- **Host Permissions**: `<all_urls>`, `https://*.linkedin.com/*`, `https://*.naukri.com/*`, `https://*.indeed.com/*`.

---

## 2. Background Service Worker & Agent Engine
The background service worker entry point is `chrome-extension/src/background/index.ts`.

### Key Subsystems:
1. **DedicatedJobRunner** (`src/background/agent/linkedin/dedicatedJobRunner.ts`):
   - 4,324 lines of autonomous execution logic.
   - Manages state machine: `IDLE` -> `SEARCHING` -> `EXTRACTING` -> `EVALUATING` -> `APPLYING` -> `SUBMITTED` -> `PACING`.
   - Supports dual runner modes:
     - **`window`**: Launches a dedicated isolated Chrome window.
     - **`tab`**: Creates or reuses a tab within the user's active window, with visual badges, safe boundary navigation checks, and clean shutdown handling if closed mid-run.
   - Built-in defense against bot-detection: randomized human pacing intervals (`humanPacing.ts`), cursor movement simulation, and rate-limited daily application limits.
2. **DedicatedWindowManager** (`src/background/agent/linkedin/dedicatedWindow.ts`):
   - Manages tab acquisition, focus, debugger attachment, and cleanup.
   - Handles `chrome.tabs.onRemoved` and debugger detach events to trigger graceful stops and credit refunds.
3. **Platform Adapters** (`src/background/agent/platforms/`):
   - **LinkedIn Adapter** (`linkedin/linkedinAdapter.ts`): Selects Easy Apply buttons, parses multi-step modals, handles resume dropdowns, checks review step.
   - **Naukri Adapter** (`naukri/naukriAdapter.ts`): Handles chatbot overlays, screening questionnaires, Fast Forward apply buttons.
   - **Indeed Adapter** (`indeed/indeedAdapter.ts`): Handles Indeed Apply modals, radio/select question types, phone/resume screening.
4. **General Agent Executor** (`src/background/agent/executor.ts`):
   - For open-ended browsing queries (PlannerAgent + NavigatorAgent + ActionBuilder).

---

## 3. Injected Content Scripts
- Located in `pages/content/`:
  - `jobHarvester.ts`: Scrapes job listings from search result pages without triggering DOM mutation alarms.
  - `jobApplier.ts`: Injects event listeners and DOM observers to monitor modal rendering and input focus.
