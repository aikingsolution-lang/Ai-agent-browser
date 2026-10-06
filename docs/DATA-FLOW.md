# Complete End-to-End Data Flows

This document details the exact file-by-file and function-by-function execution paths for every major user action.

---

## Flow 1: Candidate Resume Upload & CareerBrain Initialization
1. **User Action**: User uploads a resume PDF in Side Panel (`ResumeProfileView.tsx`).
2. **Client**: File is dispatched via `backendApiClient.post('/resume/generate', formData)`.
3. **Backend Middleware**:
   - `correlationId.middleware.ts`: Generates correlation ID.
   - `authenticate.ts`: Validates JWT token, attaches `req.user`.
   - `upload.middleware.ts` (Multer): Buffers PDF file into memory.
4. **Controller**: `ResumeController.generateResume` (`backend/src/controllers/resume.controller.ts`).
5. **Service**:
   - `ResumeParserService.extractRawText`: Parses PDF text with `pdf-parse`.
   - `ResumeParserService.extractStructuredData`: Invokes LLM to extract skills, experience, and golden answers.
   - `ProfileService.createOrUpdateFromResume`: Upserts MongoDB `CareerBrain` record.
6. **Response**: HTTP 200 with `ParsedResumeData`.
7. **Client State**: SidePanel updates `careerBrainStore` in Chrome Local Storage.

---

## Flow 2: Autonomous Job Application Execution (LinkedIn Tab Mode)
1. **User Action**: User enters "Full Stack Developer", selects "Remote", toggles "Tab Mode", and clicks **Start** in `LinkedInApplyDashboard.tsx`.
2. **Extension Event**: Invokes `dedicatedJobRunner.startAutonomousJobLoop(options)` in `dedicatedJobRunner.ts`.
3. **Pre-Flight Checks**:
   - `validateProfileCompleteness`: Ensures resume and name exist in `careerBrainStore`.
   - `DailyQuotaManager.getRemainingQuota`: Verifies daily limit not exceeded.
   - `backendApiClient.get('/subscription/me')`: Verifies active entitlement.
4. **Tab Acquisition**:
   - `dedicatedWindowManager.acquireRunnerTab('linkedin.com')`: Creates new tab in active window, attaches CDP debugger, injects visual banner.
5. **Navigation & Search**:
   - `linkedinAdapter.buildSearchUrl`: Constructs sanitized URL with role keywords and Easy Apply filters.
   - Tab navigates to search page.
6. **Discovery & Evaluation Loop**:
   - Content script harvests job cards -> `linkedinAdapter.extractJobListings`.
   - Runner opens job -> `evaluateDeepRelevance`: Computes fit score.
   - If fit score >= threshold:
     - `linkedinAdapter.clickApplyButton`: Opens Easy Apply modal.
     - `formQuestionResolver.resolveModalFieldWithAudit`: Resolves questions using CareerBrain.
     - `linkedinAdapter.fillFieldsAndProceed`: Steps through multi-page modal.
     - `linkedinAdapter.submitApplication`: Confirms final submission.
7. **Post-Submission Recording**:
   - Calls backend: `POST /api/v1/job-applications` (Saves to MongoDB).
   - Increments local `processedJobsStore` and `dailyQuotaStorage`.
   - Deducts credit from user account.
8. **Pacing Delay**:
   - `humanPacing.getNaturalDelay`: Sleeps for randomized interval (15-45s) before next job.
