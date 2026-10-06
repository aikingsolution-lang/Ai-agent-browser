# Frontend UI Architecture (SidePanel & Options)

## 1. Overview & UI Topology
The frontend surfaces are located in `pages/` and built with **React 18.3**, **Vite 5.4**, and **TailwindCSS 3.4**.
1. **SidePanel** (`pages/side-panel/`):
   - The primary user dashboard rendered inside Chrome's native Side Panel.
   - Contains:
     - `AuthGateView.tsx` / `AuthModal.tsx`: Registration, login, and Google OAuth sign-in.
     - `LinkedInApplyDashboard.tsx`: Job automation controls, target role input, location search, platform selector, tab/window mode switch, daily quota meter, real-time live log feed.
     - `ResumeProfileView.tsx`: Resume upload, parsed CareerBrain review, golden screening answers editor.
     - `UsageHistoryView.tsx`: Transaction history and credit ledger viewer.
     - `PremiumPlansModal.tsx`: In-app subscription plan selection and checkout.
2. **Options Page** (`pages/options/`):
   - Full-page settings dashboard rendered at `chrome-extension://<id>/options/index.html`.
   - Contains:
     - `ModelSettings.tsx`: Custom LLM provider configuration (OpenAI, Anthropic, Ollama, custom baseURL).
     - `CareerBrainSettings.tsx`: Deep editing of candidate work history, education, and skill tags.
     - `ApplicationAnalytics.tsx`: High-level charts of jobs applied, success rates, and fit scores.
     - `FirewallSettings.tsx`: URL whitelisting and safety rules.
     - `ResumeApprovals.tsx`: Review history of resumes attached to applications.

---

## 2. State Management & Storage Listeners
- Instead of Redux or heavy client state libraries, the frontend relies on **Typed Chrome Storage Local** (`packages/storage/`).
- Custom hooks (e.g., `useStorage`) bind React component state directly to Chrome storage changes via `chrome.storage.onChanged`.
- **Benefit**: Any update initiated by the background service worker (such as log lines, job counters, or runner state changes) immediately re-renders the Side Panel UI with zero IPC message boilerplate.
