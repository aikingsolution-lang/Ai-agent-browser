# Business Logic & Domain Rules Reference

## 1. Candidate Job Application Quotas
- **Daily Caps**:
  - Free Trial: Maximum 10 applications per calendar day.
  - Pro Plan: Maximum 100 applications per calendar day.
  - Enterprise Plan: Custom / Unlimited.
- **Quota Reset**: Quotas reset daily at midnight (UTC/local timezone according to server `getTodayString()`).
- **Enforcement**: Dual-layer check in `DailyQuotaManager` (client Chrome storage) and `ProfileService.checkAndIncrementQuota` (MongoDB backend).

---

## 2. Anti-Detection & Human Pacing Rules
Automated job applications run the risk of triggering portal bot detection. The system enforces strict pacing rules:
- **Randomized Intervals**:
  - Between page navigations: 3,000ms – 7,000ms.
  - Between form input keystrokes: 50ms – 150ms per character.
  - Between sequential job applications: 15,000ms – 45,000ms.
- **Session Duration Limit**: Single continuous runner sessions automatically pause or complete after applying to a maximum of 25 jobs in one burst.

---

## 3. Resume-to-Job Matching Rules
- **Candidate Name Safeguard**:
  - In `resolveTargetRoleFromResumeWithLLM`, the LLM is explicitly barred from using the candidate's personal name as a job search query.
  - If resolved title matches candidate's name or is under 3 characters, `isCandidateNameOrInvalidTitle` rejects it and falls back to explicit user preferences.
- **Skill Experience Rules**:
  - Years of experience for a skill are only extracted if explicitly stated or computed from dated professional roles.
  - Generates calibrated golden screening answers for legal authorization, notice period, and sponsorship.
