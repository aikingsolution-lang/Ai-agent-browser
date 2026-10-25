# LinkedIn Automation — Read-Only Change Audit (2026-10-25)

Scope: `git diff 953cd77..HEAD` on all LinkedIn-related files. No code modified, no revert executed.
Safety branch: `backup-before-cleanup` created at HEAD (f2f8162). `main` remains checked out.

## 1. LinkedIn-related file inventory

Core engine — `chrome-extension/src/background/agent/linkedin/` (24 files):
applicationEngine.ts, dedicatedJobRunner.ts, dedicatedWindow.ts, dryRunLogger.ts, fitScorer.ts,
formFiller.ts, formQuestionResolver.ts, healthCheck.ts, humanPacing.ts, preflight.ts,
questionSolver.ts, queueManager.ts, rateLimiter.ts, resumeApproval.ts, resumeDraft.ts, selectors.ts,
sessionValidator.ts, stepDetector.ts, stepNavigator.ts, taskBuilder.ts, types.ts, urlUtils.ts,
userQuestionManager.ts, visionFallback.ts

Platform adapter:
- chrome-extension/src/background/agent/platforms/linkedin/linkedinAdapter.ts

Shared dependency (inside agent/linkedin but ALSO imported by Indeed + Naukri adapters — changes ripple into all 3 platforms):
- chrome-extension/src/background/agent/linkedin/formQuestionResolver.ts (imported by dedicatedJobRunner.ts, platforms/indeed/indeedAdapter.ts, platforms/naukri/naukriAdapter.ts, agent/actions/builder.ts)
- chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts (runner tab/window manager)

Storage — `packages/storage/lib/linkedin/` (10 files):
csvExport.ts, dailyQuotaStorage.ts, dryRunStorage.ts, jobQueue.ts, linkedInConfig.ts,
processedJobsStorage.ts, queueSafetyStorage.ts, resumeApproval.ts, runnerStateStorage.ts, urlUtils.ts

Side panel (UI) — `pages/side-panel/src/components/`:
LinkedInApplyDashboard.tsx (main), plus linkedin-touching: LocationAutocompleteInput.tsx,
MultipleJobRolesInput.tsx, ResumeEnrichmentFlashcards.tsx, ResumeProfileView.tsx, SidePanel.tsx

Shared browser layer (used by LinkedIn modal/Easy Apply handling):
- chrome-extension/src/background/browser/page.ts (7,726 lines at HEAD; was 5,515 at baseline — +40%)

## 2. Last-known-good commit

**Primary: `953cd77` (2026-10-18) — "fix(apply): prevent InvalidStateError on file input elements during modal filling"**

Why:
- It is the last real code commit before the Oct-20→25 restructuring wave (the only commit after it until the wave is 7bc2720, docs-only).
- `dd2dea6` (Oct 24) is titled "restore proven Oct 18 apply flow" — the commit itself declares Oct-18 state as the proven-good flow, and deleted 376 lines of wave-era heuristics to get back to it.
- It already contains everything the user wants to keep: Indeed rebuild merge (1049c0b, Oct 9), tab-mode + multi-location (aba2110, Oct 6), quota, credit checks, Easy Apply heuristics of Oct 15 (19049b6).
- So the user's intuition ("before Indeed rebuild / tab-mode / multi-location") points to Oct 6–9, but the evidence shows those changes landed BEFORE Oct 18 and were working; instability is concentrated in Oct 20–25. Reverting before Oct 6 would delete tab mode, quota and multi-location — features that must survive cleanup.

Alternatives:
1. **`19049b6` (2026-10-15) — "refine Easy Apply button targeting and modal detection heuristics"** — one step older; choose it only if the Oct-15/18 targeting refinement itself is suspected.
2. **`b97dadc~1` = `7bc2720` (2026-10-20)** — code-identical to 953cd77 for all LinkedIn files (docs commit); useful only as the exact branch point right before the wave.

## 3. Commits touching LinkedIn files, newest → oldest (953cd77..HEAD, 36 commits)

| # | Commit | Date | Message |
|---|--------|------|---------|
| 1 | f2f8162 | 10-25 | fix(apply): exclude LinkedIn footer language panel from modal detection |
| 2 | 43d708a | 10-24 | fix(apply): fail fast when LinkedIn silently rejects form advancement |
| 3 | dbac3b1 | 10-24 | fix(apply): Phase 5 - resilient job-details wait, 24h failed-job cache, draft resume auto-upload |
| 4 | 662b9d2 | 10-24 | fix(apply): discover and click LinkedIn question-library button groups |
| 5 | 2543651 | 10-24 | fix(apply): verify form fills, instrument skip reasons, and arbitrate borderline matches |
| 6 | f5b6d27 | 10-24 | fix(apply): verify modal step advancement and never discard filled drafts |
| 7 | d7ede5c | 10-24 | fix(linkedin): enforce strict sequential completion before next job and enhance button polling resilience |
| 8 | dd2dea6 | 10-24 | fix(linkedin): restore proven Oct 18 apply flow, preserve prefilled inputs, and robust action button click |
| 9 | 7f217fc | 10-24 | fix(quota): resilient daily quota verification with token refresh and cached fallback |
| 10 | 271df45 | 10-24 | fix(linkedin): unblock disabled next button, force forward click, and fallback city inference |
| 11 | b6e4fa2 | 10-24 | fix(linkedin): preserve filled inputs, scroll to bottom before next click, and auto-close combobox |
| 12 | 666aac3 | 10-24 | Verified daily-limit display, side panel redesign, version 3.0.0 |
| 13 | 7db92df | 10-24 | fix(apply): broaden modal action button detection across footers, actionbars, and direct click fallback |
| 14 | 9c434f4 | 10-24 | fix(apply): auto-scroll modal content, prevent premature discard on multi-field steps |
| 15 | 969610e | 10-24 | feat(apply): implement Split-Pane Search stream processing with dual-engine fallback |
| 16 | c0440a7 | 10-24 | fix(apply): prevent premature modal dismiss, fix job-card exclusion and button fallback |
| 17 | 7ab82bf | 10-24 | fix(apply): dual-engine CDP and chrome.scripting fallback for modal submission and lifecycle |
| 18 | fd2f0b8 | 10-24 | fix(apply): robust easy apply button selector and dual-engine modal detection |
| 19 | d26a66f | 10-24 | fix(quota): proactive token refresh and resilient local fallback for job application quota |
| 20 | b098503 | 10-24 | fix(linkedin): add chrome.scripting fallback, fix premature tab url check, and remove obsolete f_LF query |
| 21 | 4bc4b74 | 10-23 | fix(linkedin): multi-page pagination, robust tab navigation, and alternate role fallback |
| 22 | 8a0b274 | 10-23 | feat(ui): disable Auto Email feature card from side panel |
| 23 | 5fe3cc1 | 10-23 | fix(linkedin): support f_WT=2 workplace type for remote searches and optimize result scan pacing |
| 24 | 004c634 | 10-23 | JobForm Automator release: rebrand, daily limits, checkout and Premium fixes |
| 25 | de0c8f6 | 10-23 | Fix email extraction and LinkedIn apply flow |
| 26 | 0dd0fda | 10-22 | fix(apply): implement bulletproof handling for 5 real-world stress scenarios |
| 27 | c96e350 | 10-22 | fix(apply): prevent premature discard and ensure robust modal action button detection |
| 28 | 012c6aa | 10-22 | fix(apply): prevent clicking search filter pill instead of Easy Apply button and eliminate document.body modal fallback |
| 29 | a48ad34 | 10-22 | fix(runner): ensure DOM settlement checks target, notify SidePanel on run exit to prevent freeze, and restore search scan wait |
| 30 | fd3f224 | 10-22 | perf(pacing): dynamic DOM settlement replaces 10s of fixed sleeps, optimized 1.5-2.5s jitter |
| 31 | d3866ba | 10-22 | fix(linkedin): direct navigation on queue items, robust Easy Apply click without double-dispatch, and modal priority |
| 32 | e3c9b09 | 10-22 | feat(platform): add Indeed resume upload watcher, Naukri OTP auto-resume, and runner tab switch button |
| 33 | 3110dd9 | 10-21 | test(scenarios): add comprehensive end-to-end user test suite |
| 34 | fda554d | 10-21 | feat(apply): add Tier 2 platform profile enrichment, new account resume upload watcher, and question memory caching |
| 35 | 65dcc0b | 10-21 | feat(apply): add Checkpoint Guardian, smart city typeahead, and phone normalization |
| 36 | b97dadc | 10-20 | feat(apply): implement DOM settlement engine, 500ms pacing, and multi-tier resume matching |

## 4. Classification — A) KEEP

| Commit | File / function | What changed | Why KEEP | Risk if reverted |
|--------|-----------------|--------------|----------|------------------|
| f2f8162 | page.ts: all 10 findActiveModal variants, isEasyApplyModalOpen, isGenuineVisibleModal, verifyApplicationConfirmation, clickEasyApplyButton.isFilterOrNav, 3 document-level primaryBtn loops | Excludes LinkedIn footer "Select language" sheet from modal detection | Fixes the footer click-storm bug verified live; bundle markers verified | Footer panel gets treated as Easy Apply modal again → false opens/click storms |
| 43d708a | dedicatedJobRunner.ts: applySingleLinkedInJobInSplitPane (stuck-step guard), page.ts auto-upload | Fails fast after N identical modal steps instead of looping silently | Prevents infinite loops burning time/credits | Silent stuck loops return |
| dbac3b1 | dedicatedJobRunner.ts (4a wait), resumeDraft.ts (new, 207 lines), processedJobsStorage.ts | 24h negative cache for failed jobs, draft resume auto-upload | Stops hammering the same failing job; uploads resume on upload-page | Failed jobs retried every run; upload-page stuck |
| 662b9d2 | page.ts discoverModalFormFields / fillModalFieldDirect, dedicatedJobRunner.ts | Detect + click button-group questions as required fields | Fixes unanswered required radio/button groups | Button-group questions left empty → failed submits |
| 2543651 | dedicatedJobRunner.ts (recordSkip instrumentation), deepRelevanceMatcher arbitration (score 40–60 LLM re-judge), page.ts fill verification | Skip-reason visibility + borderline arbitration + fill fidelity checks | False-negative skips reduced; every skip now has a reason in Live Activity | Blind skips return |
| f5b6d27 | page.ts fillAndSubmitModal step verification, dedicatedJobRunner.ts | Verify modal advanced after Next; never discard filled drafts | Prevents re-filling same step / data loss | Draft loss + duplicate filling |
| d7ede5c | dedicatedJobRunner.ts (strict sequential completion), inspectAndHealFormErrors | Wait until previous modal fully closed before next job; 6-retry button polling; validation healing | No overlapping modals between jobs | Next job clicks land on previous modal |
| dd2dea6 | page.ts (net −376 lines) | Removed wave-era over-heuristics (title-guessing, apply-title detection) — restored Oct-18 modal detection | De-clutters detection back to proven heuristics | N/A — this is itself the "restore" commit |
| 7f217fc / d26a66f / 666aac3 | rateLimiter.ts, dailyQuotaStorage.ts, applicationEngine.ts | Token refresh + local quota fallback + uid-scoped quota cache | Prevents false quota blocks from slow server | Runs blocked by transient server errors |
| 65dcc0b | dedicatedJobRunner.ts waitForManualCheckpointResolution, formQuestionResolver.ts (city typeahead, phone normalization) | Pauses on Arkose/CAPTCHA/OTP, resumes after user solves | Prevents account flagging by auto-clicking through security checks | Account lockout risk |
| fda554d | dedicatedJobRunner.ts enrichMissingCareerBrainFromPlatform, formQuestionResolver.ts (question memory caching) | Tier-2 profile enrichment from page DOM; answer memory cache | Helps new/incomplete profiles fill forms | New accounts fail on missing name/title |
| e3c9b09 | LinkedInApplyDashboard.tsx only (for LinkedIn) | Runner tab switch button (UI) | User control, no engine change for LinkedIn | Button gone |
| 3110dd9 | __tests__ | Test suite only | No runtime behavior | Test coverage lost |
| 004c634 / 8a0b274 / 666aac3 | side panel, storage | Rebrand, daily-limit display, disable Auto Email card | Product/UI, no apply mechanics | UI regressions only |
| 0dd0fda | dedicatedJobRunner.ts, page.ts | Rate-limit dialog re-check after Easy Apply click; improved dismiss | Prevents treating rate-limit as "modal opened" | Rate-limit page misread as form |
| 5fe3cc1 | applicationEngine.ts, linkedinAdapter.ts | f_WT=2 for remote searches | Remote jobs actually get found | Remote searches return on-site jobs |
| 4bc4b74 | dedicatedJobRunner.ts (pagination loop start=0/25/50, navigateLinkedInTab), linkedinAdapter.ts | 3 pages per location + alternate-role fallback | Batch cap fillable; duplicate-tab navigation fixed | Fewer jobs found |
| b098503 | dedicatedWindow.ts, dedicatedJobRunner.ts | Waits for tab URL commit (fixes empty tab.url), removes obsolete f_LF param | Fixes premature tab check | Runner tab url race returns |
| fd2f0b8 | page.ts clickEasyApplyButton | Added `.jobs-search__job-details`, `.scaffold-layout__detail` container selectors; broader candidate selectors | Matches the new 2026 LinkedIn job-details layout | Easy Apply button not found on new UI |
| c0440a7 | page.ts validateModalFormState, dismiss paths | Prevents premature modal dismiss; job-card exclusion | Real dismissal bug fixed | Modals dismissed mid-fill |
| c96e350 | page.ts | Discard only on exact "discard" match + old-draft guard | Stops accidental discard of filled forms | Filled drafts discarded |
| 012c6aa | page.ts clickEasyApplyButton, findActiveModal | Excludes search filter pills/nav from button matching; removed document.body modal fallback | Stops clicking filter pill instead of Easy Apply; safer modal pick | Filter pill clicked again; body-fallback false positives return |
| 9c434f4 / 7db92df / b6e4fa2 / 271df45 | page.ts modal helpers, formQuestionResolver.ts | Auto-scroll modal, broaden action-button detection, preserve prefilled inputs, auto-close combobox, force forward click, city fallback | Fixes real modal-filling failures | Filling regressions return |
| d3866ba / a48ad34 | dedicatedJobRunner.ts | Direct navigation fallback for queue items; SidePanel run-exit notify; scan wait restore | Fixes jobs with empty card data + UI freeze | UI freeze + missed jobs return |
| de0c8f6 | services/autoEmail.ts, emailExtractor.ts, LinkedInApplyDashboard.tsx | Auto Email feature + email extraction | Separate feature; LinkedIn apply-flow changes minimal | Feature lost |

## 5. Classification — B) REVERT CANDIDATE

| Commit | File / function | What changed | Why REVERT CANDIDATE | Risk to LinkedIn flow |
|--------|-----------------|--------------|----------------------|-----------------------|
| 969610e | dedicatedJobRunner.ts: startAutonomousJobLoop rewritten (+1276/−1251), new processPageCards, applySingleLinkedInJobInSplitPane; startNaukriJobLoop added in same file; page.ts +144 | Architecture change: "gather queue first, then process" → "process cards in-page as they are read" (Split-Pane stream processing) | Biggest single change in the window (1 day before your Easy Apply click failure report). Restructures the whole per-job flow; interleaves Naukri code into the LinkedIn runner. Old flow was proven (dd2dea6 references Oct-18 flow). | If the in-page card→details handoff misbehaves, Easy Apply click targets the wrong pane or the page is mid-navigation — matching your current screenshot (card selected, button visible, click not landing). Reverting restores the proven queue flow. |
| 7ab82bf + c0440a7 + b098503 (partial) | page.ts: every in-page function duplicated as puppeteer-evaluate + chrome.scripting.executeScript copies; 10 findActiveModal variants | Dual-engine fallback duplication | page.ts grew 5,515→7,726 lines (+40%). Every future fix must be applied 10× (the footer fix was 83 insertions / 29 deletions for this reason) — high drift risk. chrome.scripting path rarely exercised (puppeteer CDP is primary). | Keeping it is a maintenance risk, not an immediate flow risk. Simplification (single shared findActiveModal + single engine with fallback) is safer than blind revert. |
| b97dadc (partial) | page.ts waitForDomSettlement; dedicatedJobRunner.ts multi-tier resume auto-select | DOM settlement engine replacing fixed sleeps | If quiet-period (200ms) fires too early, job lists/cards get read before render → "No jobs found" or partial card reads. Needs live timing verification. | Premature card reads → skipped jobs / bad titles. |
| fd3f224 | dedicatedJobRunner.ts pacing | Fixed sleeps (3–4s) → dynamic settlement + 1.5–2.5s jitter | Aggressive pacing may trigger LinkedIn rate limiting; the 10-24 commits added "detectPlatformRateLimit" right after, suggesting limits were hit. | Rate-limit page instead of job list. |

## 6. Classification — C) UNSURE (needs live test)

| Commit | File / function | What changed | Question to answer live |
|--------|-----------------|--------------|-------------------------|
| 969610e | processPageCards / applySingleLinkedInJobInSplitPane | Split-pane processing + pacing 1.5–2.5s between candidates | Does the right pane reliably show the clicked card before clickEasyApplyButton fires? |
| b97dadc | waitForDomSettlement (page.ts) | DOM settlement with maxWaitMs/quietPeriodMs | Do cards render fully before readJobListFromSearchPane reads them? |
| fd3f224 | interruptibleSleep call sites | Sleep 3–4s → 1.2–2.5s | Any rate-limit pages or half-loaded lists? |
| 0dd0fda | dismissEasyApplyModal(4000) after rate-limit check | Auto-dismiss after rate-limit detection | Does it ever dismiss a real Easy Apply modal that opened slowly? |
| c96e350 | [data-test-modal] selector addition | Broadened generic dialog detection | Any false positives (non-apply dialogs) now that footer is excluded? |
| 65dcc0b | phone normalization + city typeahead in formQuestionResolver | New resolver outputs | Do phone formats pass LinkedIn validation on real forms? |

## 7. LinkedIn-behavior-altering changes made for Indeed / Naukri (or shared)

In the window (953cd77..HEAD):
- **formQuestionResolver.ts** (shared by LinkedIn + Indeed + Naukri): changed in 65dcc0b (city typeahead, phone normalization), fda554d (question memory caching), 3110dd9 (tests), b6e4fa2 (combobox auto-close), 271df45 (city inference fallback). Every one of these changes LinkedIn's question-answering output.
- **969610e**: added `startNaukriJobLoop` inside dedicatedJobRunner.ts and restructured the LinkedIn loop around a shared pattern — LinkedIn flow altered while adding Naukri.
- **e3c9b09**: Indeed resume-upload watcher + Naukri OTP resume — for LinkedIn only the side-panel runner-tab switch button (UI).
- **fda554d**: "new account resume upload watcher" — shared runner logic used by LinkedIn too.

Before the baseline (already inside 953cd77, listed for completeness):
- **1049c0b (Oct 9, merge)**: Indeed rebuild — applicationEngine.ts +183, questionSolver.ts +172, dedicatedJobRunner.ts +68, formQuestionResolver.ts +35. These modified LinkedIn core files during Indeed work.
- **aba2110 (Oct 6)**: introduced both the dedicated-runner-tab mode AND multi-location ("Location(s)=") for LinkedIn.

## 8. Cleanup plan (ordered, one step at a time — NOT executed)

Precondition: `git checkout main`, branch `backup-before-cleanup` exists at f2f8162. After every step: `pnpm typecheck && pnpm test` + live run.

1. **Restore proven queue flow** — `git revert 969610e` (expect conflicts in dedicatedJobRunner.ts — resolve by keeping later phases' fixes inside the old loop; if too tangled, alternative: `git checkout 953cd77 -- chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts` then re-apply the KEEP fixes from the table above manually).
   Test: full LinkedIn run — search → "Queued N eligible jobs" → per-job apply; Easy Apply modal opens; Live Activity shows running → applied.
2. **Easy Apply click diagnostics** (only if click still fails): small patch to clickEasyApplyButton logging matched selector / rejected candidates / button outerHTML into the `reason` string returned to Live Activity.
   Test: one manual job; read Live Activity reason.
3. **DOM settlement timing** — `git revert b97dadc` (only the waitForDomSettlement pieces; keep multi-tier resume select).
   Test: job cards fully loaded with correct titles; no "Unknown Company".
4. **Pacing** — `git revert fd3f224` only if rate limiting is observed live.
   Test: 10-job run; no rate-limit page.
5. **De-duplicate page.ts** — replace the 10 findActiveModal variants with one shared function + one shared isFooterPanel helper; keep dual-engine wrappers but generate them from the single impl.
   Test: modal open/detect on 2 different Easy Apply forms (single-page + split-pane).
6. **Dual-engine cleanup (optional)** — if CDP attach is proven stable across 3 runs, remove chrome.scripting executeScript duplicates (revert 7ab82bf + c0440a7 partial).
   Test: modal fill + submit on both engines; confirm fallback still works by detaching debugger once.
7. **Re-verify footer fix** — after all steps, confirm footer exclusion still present in the single shared findActiveModal.
   Test: footer language panel must never be clicked.

## 9. Manual verification checklist after cleanup

1. **Search**: role/location URL correct; remote searches get f_WT=2; pagination start=0/25/50; alternate-role fallback fires when <3 applied.
2. **Easy Apply modal**: blue button click opens modal on new 2026 UI; footer "Select language" panel never clicked; "missing qualifications" beta banner does not block modal detection.
3. **Question answering**: text inputs, dropdowns, button groups, numeric salary field, phone (normalization), city typeahead, combobox auto-close — all fill correctly.
4. **Daily quota**: reserve/refund per job; local fallback on server error; run halts at limit with clear message.
5. **Stop button**: mid-run stop interrupts sleep/loop; cleanupRun fires; side panel doesn't freeze.
6. **Tab mode**: dedicated tab opens in current window; closing tab stops run with message; runner tab switch button works.
7. **Negative cache**: failed job skipped next 24h with reason in Live Activity.
8. **Draft resume**: upload-page auto-upload works; filled drafts never discarded on step change.
9. **Rate limit**: platform rate-limit detection pauses instead of false "modal opened".
10. **Borderline arbitration**: skip/apply LLM re-judge in 40–60 band; refund on skip.
