# Function, Class & Component Master Index

This document lists all major exported classes, functions, and components across the codebase.

---

## 1. Backend Classes & Services
- `AuthService` (`backend/src/services/auth.service.ts`): `generateToken`, `generateAndSaveRefreshToken`, `registerUser`, `loginUser`, `refreshTokens`, `loginWithGoogle`.
- `CreditService` (`backend/src/services/credit.service.ts`): `initializeCreditsForSubscription`, `deductCredits`, `refundCredits`, `refundRunCredits`, `getCreditBalance`.
- `SubscriptionLifecycleService` (`backend/src/services/subscriptionLifecycle.service.ts`): `createCheckoutSession`, `verifyPayment`, `cancelSubscription`, `processWebhook`.
- `LlmService` (`backend/src/services/llm.service.ts`): `calculateRequiredCredits`, `processChatCompletion`, `processStreamCompletion`, `getUsageHistory`.
- `TrialService` (`backend/src/services/trial.service.ts`): `createFreeTrial`, `expireTrialIfEnded`, `reconcileExpiredTrials`.
- `ProfileService` (`backend/src/services/profile.service.ts`): `getProfile`, `syncProfile`, `createOrUpdateFromResume`, `checkAndIncrementQuota`.
- `RazorpayService` (`backend/src/services/razorpay.service.ts`): `verifyCheckoutSignature`, `verifyWebhookSignature`, `createRazorpaySubscription`.
- `ResumeParserService` (`backend/src/services/resumeParser.service.ts`): `extractRawText`, `extractStructuredData`.
- `TrialExpirationWorker` (`backend/src/workers/trialExpiration.worker.ts`): `start`, `stop`.

---

## 2. Chrome Extension Background Agent
- `DedicatedJobRunner` (`src/background/agent/linkedin/dedicatedJobRunner.ts`): `getInstance`, `startAutonomousJobLoop`, `stop`, `handleDebuggerDetach`, `recoverInterruptedRunOnStartup`.
- `DedicatedWindowManager` (`src/background/agent/linkedin/dedicatedWindow.ts`): `acquireRunnerTab`, `closeRunnerWindow`, `isDedicatedRunnerOpen`.
- `Executor` (`src/background/agent/executor.ts`): General autonomous browser task executor.
- `linkedinAdapter` (`src/background/agent/platforms/linkedin/linkedinAdapter.ts`): LinkedIn search, modal extraction, and submission adapter.
- `naukriAdapter` (`src/background/agent/platforms/naukri/naukriAdapter.ts`): Naukri portal adapter.
- `indeedAdapter` (`src/background/agent/platforms/indeed/indeedAdapter.ts`): Indeed portal adapter.

---

## 3. Frontend React Components
- `SidePanel` (`pages/side-panel/src/SidePanel.tsx`): Root side panel container.
- `LinkedInApplyDashboard` (`pages/side-panel/src/components/LinkedInApplyDashboard.tsx`): Control center for job runs.
- `ResumeProfileView` (`pages/side-panel/src/components/ResumeProfileView.tsx`): Resume uploader and CareerBrain editor.
- `AuthGateView` (`pages/side-panel/src/components/AuthGateView.tsx`): Authentication gates and login forms.
- `ModelSettings` (`pages/options/src/components/ModelSettings.tsx`): LLM configuration options.
