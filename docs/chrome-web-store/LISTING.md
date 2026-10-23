# Chrome Web Store submission pack — JobForm Automator

Everything to enter in the Chrome Web Store Developer Dashboard for the release package
`dist-zip/extension-*.zip` built with `pnpm clean:bundle && pnpm zip`. Field names follow the dashboard tabs.
Requirements were checked against developer.chrome.com/docs/webstore (October 2026); confirm in the live dashboard.

## Package

- Upload the zip from `dist-zip/`. Version in the package: `0.1.13` (a new store item can start at any version; to
  upload into an existing item instead, the version must be higher than that item's published version — the previous
  JobForm Automator item is at 2.30).
- The store assigns a new extension ID on first upload. The listing URL becomes
  `https://chromewebstore.google.com/detail/<slug>/<new-id>`; set it in the website's `lib/chrome-extension.ts`.

## Store listing tab

**Item name (from the package, 69/75 characters)**

JobForm Automator: AI Auto Apply, Autofill Most Forms & Auto Email HR

**Summary (from the package, 123/132 characters)**

AI job assistant: auto apply on LinkedIn, Naukri & Indeed, autofill application forms from your résumé, and find HR emails.

**Description**

```
JobForm Automator is an AI job-application assistant that works in Chrome's side panel. Sign in with your JobForm Automator account, add your résumé once, and let the assistant handle the repetitive parts of applying.

What it does
• Auto apply: searches LinkedIn, Naukri and Indeed for the roles you choose and works through Easy Apply and quick-apply forms, answering screening questions from your résumé profile.
• Fill application forms: reads the form on the page you are on — including employer career sites — and fills it from your profile, so you can review before you submit.
• Auto Email HR: enter a job title and it collects matching openings and publicly listed HR email addresses from Google search results, then sends the list to your JobForm Automator dashboard so you can review and email recruiters.
• Résumé profile: upload your résumé to build a reusable profile with your skills, experience, education and saved answers to common questions.
• Application tracking: daily limits, run status and history for every application.

How it works
The side panel runs automations only when you start them. During a run, the extension reads the page you are applying on and sends its content, your instructions and the profile details needed for the form to the JobForm Automator AI service (Amazon Bedrock models). You can also connect your own AI provider key in Settings.

Credits and plans
AI automation uses credits from your JobForm Automator account. Plans and credits are available at jobformautomator.com/pricing.

Privacy
Your résumé profile, job applications, AI responses and credit usage are stored with your account. We do not sell your data or use it for advertising. Details: https://jobformautomator.com/privacy

Requires a JobForm Automator account (jobformautomator.com).
```

**Category:** Workflow & Planning (fallback: Tools). **Language:** English.

**Graphic assets (in this folder)**

| Dashboard field | File | Status |
| --- | --- | --- |
| Store icon (128×128, required) | `store-icon-128x128.png` | Same icon as the package; your published JobForm icon. |
| Screenshot 1 (1280×800, at least one required) | `screenshot-1-sign-in-1280x800.png` | Real side-panel capture of the release build, on a branded background. |
| Screenshot 2 (1280×800) | `screenshot-2-settings-1280x800.png` | Real Settings page of the release build. |
| Screenshots 3–5 (recommended) | — | Capture while signed in: Auto Apply dashboard, Résumé profile, Auto Email results (see below). |
| Small promo tile (440×280, optional) | `promo-tile-440x280.png` | Logo and product name. |
| Marquee (1400×560, optional) | — | Only needed to be eligible for featuring. |

To capture the signed-in screens: load `dist/` unpacked (or install the published item), sign in, dock the side panel
on a job page, and take 1280×800 captures (Chrome DevTools device toolbar → Responsive 1280×800 →
"Capture screenshot"). Don't include real candidate data you don't want public.

**Additional fields**

- Official URL: jobformautomator.com (requires verifying the domain in Google Search Console with the publisher's
  Google account).
- Homepage URL: https://jobformautomator.com
- Support URL: https://jobformautomator.com/contactUs
- Mature content: No.

## Privacy practices tab

**Single purpose**

```
Help job seekers apply for jobs: automate job applications and application forms on job sites using the user's résumé profile, and collect HR contact emails for job outreach.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| Host permission `<all_urls>` | Job boards and employer application forms can be on any website. The extension reads and fills the application form on the site the user is automating and opens the job pages the user's run targets. |
| `debugger` | Uses the Chrome DevTools Protocol (via chrome.debugger) on the tab being automated to send trusted mouse and keyboard input, navigate, and read the page while filling job applications the user started. All code it runs is bundled in the extension. |
| `scripting` | Injects the extension's own bundled scripts to read form structure and fill fields on the page being automated, and to read Google search results when the user runs Auto Email. |
| `tabs` | Opens, switches and monitors the tabs used for job applications and Auto Email, and reads their URL to know which step of an application is active. |
| `webNavigation` | Lists the frames of a tab so application forms embedded in iframes can be read and filled. |
| `cookies` | Checks that the user's LinkedIn session cookie exists and is unexpired before LinkedIn auto apply, so the user is asked to sign in to LinkedIn instead of the run failing. Cookie values are not transmitted. |
| `storage` | Stores the user's session, résumé profile, settings and application history locally. |
| `unlimitedStorage` | Stores résumé PDF files and application history locally, which can exceed the default storage quota. |
| `alarms` | Keeps long application runs active, resumes after the daily application limit resets, and retries pending credit refunds. |
| `sidePanel` | The extension's main interface is the side panel. |

**Remote code:** "No, I am not using remote code." Basis: an audit of the packaged code found no remotely hosted
scripts, no `eval` of fetched text, and no evaluation of AI output. The only dynamic evaluation is Puppeteer's
bundled helper code, sent to the page through the Debugger API, which the MV3 policy explicitly permits. AI model
responses only select among built-in actions (click, type, navigate…) and never run as code.

**Data usage — collected categories (check these)**

| Category | Collected | What |
| --- | --- | --- |
| Personally identifiable information | Yes | Name, email, phone and résumé details; HR emails collected by Auto Email |
| Health information | No | |
| Financial and payment information | Yes | Subscription and payment records via Razorpay checkout (no card numbers) |
| Authentication information | Yes | JobForm Automator sign-in tokens; optional user-supplied AI provider keys (stored locally) |
| Personal communications | No | |
| Location | Yes | Preferred job locations and location details from the résumé profile |
| Web history | Yes | Page URLs and open-tab titles sent to the AI service during an automation |
| User activity | No | The extension does not monitor the user's clicks or keystrokes |
| Website content | Yes | Page text and form fields of pages being automated |

Certify all three statements (no sale or transfer outside approved use cases; no use unrelated to the single purpose;
no use for creditworthiness or lending).

**Privacy policy URL:** https://jobformautomator.com/privacy — must be deployed before submitting (the page is in the
website repository at `app/privacy/page.tsx`; text mirrors `PRIVACY.md` in this repository).

## Distribution and account

- Visibility: Public (or Unlisted for a first private check). Regions: all, unless restricted for payments.
- Developer account: one-time registration fee, verified contact email, and 2-Step Verification on the publisher's
  Google account (required to publish).
- Trader declaration: selling credits makes the publisher a trader; legal name, address, phone and email are verified
  and shown to users.
- **Test instructions for reviewers (strongly recommended):** the extension does nothing until signed in. Provide a
  dedicated JobForm Automator test account with credits, plus short steps (sign in on jobformautomator.com, open the
  side panel, upload a sample résumé, run "Fill this application" on a sample form).
- Expect a longer review: `debugger` and access to all sites trigger in-depth review (from a few days to a few weeks).

## Search and discoverability

Search terms the listing and website copy should naturally cover (no repetition or keyword lists):
JobForm Automator extension, JobForm Automator Chrome extension, AI auto apply, autofill job applications, auto
email HR, LinkedIn Easy Apply automation, Naukri auto apply, Indeed auto apply, job application assistant.

Done in code:
- Exact product name and a descriptive summary in the package (all locales).
- Privacy page with its own title, description and canonical URL (`app/privacy/page.tsx`).
- One place for the store link on the website (`lib/chrome-extension.ts`), used by every "Add to Chrome" button.

Recommended on the website (not yet implemented):
- A public landing page such as `/chrome-extension` with a unique `<title>` ("JobForm Automator Chrome Extension —
  AI Auto Apply, Autofill & Auto Email HR"), meta description, canonical URL and an "Add to Chrome" link to the
  listing. Today the site's pages render no `<title>` or meta description, because the root layout is a client
  component and no page exports `metadata`; fixing that site-wide matters more than any single page.
- Structured data on that page:

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "JobForm Automator",
  "applicationCategory": "BrowserApplication",
  "operatingSystem": "Chrome",
  "description": "AI job assistant: auto apply on LinkedIn, Naukri and Indeed, autofill application forms from your résumé, and find HR emails.",
  "url": "https://jobformautomator.com/chrome-extension",
  "installUrl": "https://chromewebstore.google.com/detail/<slug>/<new-id>",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "publisher": { "@type": "Organization", "name": "JobForm Automator", "url": "https://jobformautomator.com" }
}
```

  (Use `"price": "0"` only if installing and a starter tier are free; otherwise list the plan prices. Add
  `aggregateRating` only from real store ratings.)
- Pick one canonical host — www or the bare domain — and 301-redirect the other. Both currently serve the same pages
  with separate sign-in state and browser storage.
- Add `sitemap.xml` and `robots.txt` (none today), and link to the listing from the home page and footer.
- Verify the domain in Google Search Console and set it as the listing's Official URL.

Not in our control: store approval, the hours it takes the store to index a new item, whether and when Google
indexes the listing and website pages, and ranking — which depends on ratings, installs, retention, links and time.
Nothing here guarantees indexing or ranking.
