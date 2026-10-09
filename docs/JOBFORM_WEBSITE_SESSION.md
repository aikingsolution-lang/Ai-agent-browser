# JobForm Automator website session & premium status

NanoBrowser follows the user's **JobForm Automator** account, the same way the JobForm Automator
extension does. Both products use the same Firebase project (`jobform-automator-website`), so a
website session is a normal NanoBrowser session.

## Sign-in / sign-out sync

```
jobformautomator.com page ── DOM event ──▶ content script ──▶ background ──▶ backend GET /auth/me
  userLoggedIn {uid,idToken,refreshToken}  (jobformWebsiteBridge.ts)  (websiteSessionSync.ts)  (verifies the ID token)
  onLogout                                                                     │
  paymentSuccessfull                                                           ▼
                                                      chrome.storage.local: nanobrowser_auth_session
```

| Website event | What the extension does |
|---|---|
| `userLoggedIn` (sign-in page, Google sign-in) | backend verifies the ID token (an expired one is refreshed first) and its uid must equal the announced uid → session stored (`source: 'website'`), then subscription, premium status and credits are read from the backend |
| `onLogout` (settings, account deletion) | extension session cleared |
| `paymentSuccessfull` | subscription / premium status re-read from the backend at 0, 3, 7, 15 and 30 s; the event's `uid` / `plan` are ignored |
| *(any website page loads)* | the website's stored state is reported: `IsLogin` = "true" plus its Firebase candidate session (`firebase:authUser:<apiKey>:[DEFAULT]` in localStorage) → same verified sign-in as `userLoggedIn` (an existing session of the same account is kept as is); neither present → signed out |

The page-load report exists because the website does not announce everything: a session that
already existed (user signed in earlier, now on the home page) is never announced, and the navbar
"Logout" (`components/Navbar.jsx`) signs out without an `onLogout` event. Partial states (flag
without session, recruiter-only session) are ignored.

- **Who can send these:** only the extension's content script in the **top frame** of
  `https://www.jobformautomator.com` or `https://jobformautomator.com`
  (`JOBFORM_WEBSITE_ORIGINS` in `packages/shared/lib/config.ts`). The background re-checks
  `sender.id`, `sender.tab`, `sender.frameId === 0`, `sender.url` and `sender.origin`. Other sites,
  iframes and look-alike hosts are ignored. On the website the content script runs at
  `document_start` (top frame, bridge only), so a session announced while the page loads is not
  missed.
- **JobForm Automator is the only login and registration.** Signed out, the side panel shows a
  single "Login with JobForm Automator" button that opens the website sign-in page (email, Google
  and sign-up all happen there). The extension has no email/password, Google or registration flow
  of its own any more (the `identity` permission is gone). After signing in on the website, the
  side panel switches to the signed-in view by itself.
- **Signing out in the extension** clears the extension session only; nothing is sent to the
  website or Firebase, so the website stays signed in (as with the JobForm Automator extension).
  Website pages then do not sign the extension back in (`nanobrowser_website_autologin_paused`)
  until "Login with JobForm Automator" is clicked or the user signs in on the website again; the
  button opens the sign-in page, and a website that is still signed in signs the extension back in
  without entering credentials.
- **Token refresh:** ID tokens last one hour. The extension refreshes them with the refresh token
  through Firebase's Secure Token API (public Web API key, `FIREBASE_WEB_API_KEY` in
  `packages/shared/lib/config.ts`), falling back to the backend's `POST /auth/refresh`. A dead
  refresh token (revoked, expired, account disabled) — or one that returns another uid — signs the
  extension out; an outage keeps the session for a later retry. Tokens are refreshed before the
  background hands them to the LLM gateway, so a session survives browser restarts.
- **No passwords or server secrets in the extension.** It stores only the Firebase ID and refresh
  tokens in `chrome.storage.local`, as before.

## Account isolation

Local account data (Career Brain, job queue / processed jobs / runner state, tailored-resume
approvals, dry-run records, LinkedIn search settings, chat history, pending refunds) belongs to the
uid recorded in `nanobrowser_account_owner`. Every sign-in goes through `startAccountSession()`
(`packages/storage/lib/auth/accountSession.ts`): when a **different** account signs in, the
previous account's data is wiped before the new session is stored, and nothing (subscription,
credits, premium) carries over. The same account signing in again keeps its data. Device settings
(LLM providers, general settings) are kept. Status responses that arrive after an account switch
are dropped.

## Premium status (JobForm Automator plans)

- **Source of truth:** `user/{uid}/Payment` in the JobForm Automator RTDB, written only by JobForm
  Automator's server after Razorpay verification (`/api/payment/confirm`, webhook, rewards) — its
  security rules stop browsers from setting `Status: "Premium"`.
- **Read by the backend only** (`backend/src/services/jobformPremium.service.ts`, read-only, never
  writes JobForm Automator data) with a copy of JobForm Automator's rule
  (`lib/interview/premium.ts`): `Status` "Premium" (or legacy `SubscriptionType` "Premium") and an
  `End_Date` that has not passed; `SubscriptionType` "Diamond" → Diamond.
- **Exposed** as `premium` in `GET /api/v1/subscription/me`
  (`{ tier: 'Free'|'Premium'|'Diamond', isPremium, endDate, expired, … }`, or `null` if it could not
  be read — treated as not premium). Always for the uid in the verified ID token.
- The extension stores a copy in the session for display (header badge, plans modal). Editing it
  grants nothing and it is overwritten by the next check (sign-in, payment event, plans modal,
  every 5 minutes while the side panel is open). An end date that passes locally only turns it off.

**Not decided yet (product):** a JobForm Automator Premium/Diamond plan is recognised and shown, but
it does **not** change NanoBrowser credits, daily limits or entitlement — those still come from
NanoBrowser's own plans. Mapping JobForm Automator plans onto NanoBrowser limits is a pricing
decision; once made, it belongs in the backend (e.g. `ProfileService.getDailyLimitForUser`,
`checkEntitlement`), using `JobformPremiumService.getStatus()`.

## NanoBrowser's own plans (Razorpay)

Unchanged: checkout, signature verification and webhooks run on the backend
(`/subscription/checkout`, `/subscription/verify-payment`, `/webhooks/razorpay`). The side panel
and options page no longer mark a plan as active in local storage when checkout *starts*; the local
plan mirror used by the options page's "Premium Mode" now follows `GET /subscription/me`.

## Configuration

| Where | Variable | Notes |
|---|---|---|
| backend | `FIREBASE_WEB_API_KEY` | public Web API key of the project (JobForm Automator's `NEXT_PUBLIC_FIREBASE_API_KEY`); needed by `/auth/login` and `/auth/refresh` |
| extension | `FIREBASE_WEB_API_KEY` in `packages/shared/lib/config.ts` | defaults to the JobForm Automator public key (same key the website and the JobForm Automator extension ship) |
| extension | `JOBFORM_WEBSITE_ORIGINS` | allowed website origins (keep the copy in `pages/content/src/jobformWebsiteBridge.ts` in sync) |

## Tests

- `backend/src/tests/websiteSession.test.ts` — premium rule, `/subscription/me` premium status
  (expiry, revocation, isolation, read-only), `/auth/me` token checks, `/auth/refresh`.
- `chrome-extension/src/background/services/__tests__/websiteSessionSync.test.ts` — sender checks,
  website sign-in / sign-out, token refresh and expiry, account switching, payment re-checks.
