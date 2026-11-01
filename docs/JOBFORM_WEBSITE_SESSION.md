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
| `paymentSuccessfull` `{ uid, plan }` | plan re-read from the backend until it covers `plan` (0, 3, 7, 15, 30 … 120 s), then credits and quota; a `uid` other than the signed-in account changes nothing (see "Buying Premium / Diamond") |
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

**What the plan gives in the extension** (backend, from `JobformPremiumService`), the same for Premium
and Diamond, all enforced by the backend:

- up to 300 applications a day instead of 10 (`ApplicationQuotaService`);
- **Premium Mode (built-in Cloud API)**: AI through the backend gateway without drawing credits
  (`premiumCovered`), on the built-in Nova models, within 1,000 AI tasks per UTC month
  (`PremiumAiAllowanceService`, env `PREMIUM_MONTHLY_AI_TASK_LIMIT`). A task is one `x-run-id`; the
  extension sends one for every gateway model (`newAiTaskId()`), Auto Apply runs keep their
  `easy_apply_` / `auto_loop_` ids and are limited by the daily quota instead. The options page's
  "API Mode" unlocks Premium Mode for a verified Premium / Diamond plan and shows the server's count
  (`GET /llm/premium-allowance`); there is no local counter any more. A modified client could avoid
  the task count (by reusing or relabelling run ids); the gateway's 60 requests/minute limit stays.

## Buying Premium / Diamond (as the JobForm Automator extension does)

The extension takes no payment itself, exactly like the JobForm Automator extension (noah-master):
the website runs the purchase and the extension follows the account. Side panel "Plans & credits"
and options "Premium Plans" (`useJobformPayment` → `packages/shared/lib/jobformPayment.ts`):

1. **Plans and prices** are read from the website's own configuration,
   `settings/subscription_configs/candidates` (public read; what the pricing page shows): Basic (Free),
   Premium (`priceINR` / `priceUSD`, "1 Month"), Diamond ("Until Hired"). A plan without a configured
   price is not shown; no price is built into the extension.
2. **"Choose Premium / Diamond"** opens the website's checkout page in a new tab, with the same link
   its pricing page builds: `/payment?plan=Diamond&price=₹5,999&currency=INR&for=candidate`. The
   currency follows the checkout page's own rule (geolocation-db.com: India → INR, else USD), because
   that page charges the link's amount in the currency it detects; if the lookup fails, the pricing
   page opens instead and the website chooses. Nothing is requested when the button is clicked, so it
   cannot hang (the old Starter / Pro / Power buttons waited for a backend checkout that never
   returned a payment link; see below).
3. **Payment** happens on the website: its server creates the Razorpay order at the configured price
   (`/api/payment/order`; the `price` in the link is only displayed, never charged), Razorpay
   Checkout runs, then `/api/payment/confirm` verifies the signature and the payment (order, account,
   currency, amount), captures it if it is only authorized, and writes `user/{uid}/Payment` once
   (`processed_payments`). The Razorpay webhook does the same if the tab is closed first. The website
   fires `paymentSuccessfull` only after that (website branch `feature/extension-payments`, see
   `E:\in progress\automator_payments`).
4. **Unlock:** the website fires `paymentSuccessfull` `{ uid, plan }` (the event the JobForm
   Automator extension forwards as `paymentProcessed`). The background re-reads the plan from the
   backend at 0, 3, 7, 15, 30 … 120 s until it covers the paid plan (an upgrade from Premium waits for
   Diamond), then refreshes credits and today's quota. The event's `uid` must be the account signed in
   here (otherwise "paid with a different account" is shown and nothing is re-checked); its `plan` is
   only what to wait for. The plans views also re-check every 15 s and on window focus while waiting
   (20 minutes), in case the event was missed.

**Differences from noah-master, on purpose:** noah-master sets `userStatus` to the event's plan and
writes `user/{uid}/Payment` from the extension on `paymentProcessed`. Its content script runs on every
site, so any page could fire the event, and the database rules now reject browser writes to
`Payment` anyway. Here the event only triggers a re-check; the plan comes from the record the
website's server wrote. noah-master's "Upgrade" opens `/payment` without `for=candidate`, which
skips the website's server-side activation; the link here is the pricing page's full link.

## NanoBrowser's own plans (Razorpay)

The Starter / Pro / Power credit plans are **no longer sold** in the extension UI. Why their buttons
never opened a payment page: the production backend has `plan_rzp_mock_pro` / `plan_rzp_mock_power`
as the Razorpay plan ids (the `RAZORPAY_PLAN_ID_PRO` / `_POWER` defaults);
`RazorpayService.createRazorpaySubscription` treats those as mock mode and returns a subscription
without `short_url`, so the window had nothing to open ("Subscription order generated…"), and the
call had no timeout. The backend keeps its checkout, verification and webhooks
(`/subscription/checkout`, `/subscription/verify-payment`, `/webhooks/razorpay`) so existing
subscriptions keep working, and the plans window still shows an active credit plan. The local plan
mirror used by the options page's "Premium Mode" follows `GET /subscription/me`.

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
  website sign-in / sign-out, token refresh and expiry, account switching, payment re-checks
  (upgrade waits for Diamond, another account's payment, quota after payment).
- `chrome-extension/src/background/services/__tests__/jobformPayment.test.ts` — plans from the
  website configuration, the checkout link (same as the pricing page's), currency rule, timeouts.
