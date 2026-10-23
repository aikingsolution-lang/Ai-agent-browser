# JobForm Automator Chrome Extension — Privacy Policy

Last updated: October 23, 2026

Published at: https://jobformautomator.com/privacy

This policy explains what the **JobForm Automator: AI Auto Apply, Autofill Most Forms & Auto Email HR** Chrome
extension (the "extension") collects, how it is used, who it is shared with, and the choices you have. It is
operated by JobForm Automator ("we", "us"). Our website, jobformautomator.com, is covered by our separate website
Privacy Policy at https://jobformautomator.com/policy.

## Summary

- You sign in with your JobForm Automator account. The extension does not work without signing in.
- When you start an automation (auto apply, form filling or an AI task), the extension reads the page you are
  working on and sends its content, your instructions and the profile details needed to fill the form to our AI
  service, which uses Amazon Bedrock models.
- Your résumé profile, job applications, AI responses, credits and subscription are stored with your account on our
  servers.
- Auto Email collects publicly listed HR email addresses from Google search results in your browser and passes them to
  your JobForm Automator account page so you can review and send emails.
- We do not sell your data, use it for advertising, or use it to determine creditworthiness.

## Information the extension processes

### 1. Account and sign-in

When you sign in on jobformautomator.com, the extension receives your JobForm Automator sign-in session from the
website: your account ID, name, email address and sign-in tokens. Our server verifies the session before the extension
uses it. The extension keeps the session in its local storage on your device and refreshes the tokens through Google's
Firebase authentication service. The extension only uses the job-seeker (candidate) sign-in; recruiter (HR) sign-ins
on the website are never read.

### 2. Subscription, premium status and credits

To provide paid features, we process your plan, subscription status, premium tier, trial status, credit balance and a
record of credits used and refunded for each AI request. Payments are processed by Razorpay. We receive payment and
subscription identifiers and payment event details from Razorpay; we do not receive your full card number.

### 3. Résumé and profile

When you upload a résumé, the file is sent to our server, the text is extracted by our AI service, and the extracted
résumé text and profile details are stored with your account. These may include your name, email address, phone
number, skills, work experience, education and grades, salary expectations, preferred locations, profile links (for
example LinkedIn, GitHub or portfolio) and answers you save for common application questions. The uploaded file itself
is not stored on our servers. The extension also keeps your profile, résumé files and automation settings in its
local storage on your device.

### 4. Job applications

When the extension applies to a job for you, we record the job's ID, title, company, location, salary range, match
score, job platform, application link, application status and time, and we count applications per day to enforce
daily limits. Your job queue and automation history are also kept in the extension's local storage.

### 5. Web page content during automation

The extension's script is present on the web pages you visit so it can work on job sites and application forms, but
it only reads and sends page content for an automation you start. During an automation, the extension reads the
current page — visible text, form fields, buttons, links, the page address and the titles of your open tabs — and
sends this, together with your instructions and the profile details needed to answer the form, to the AI service to
decide the next step. Screenshots of the page are sent only if you turn on vision in Settings, or when the LinkedIn
Easy Apply fallback needs a screenshot of the application dialog. To submit applications, the extension types into
and clicks on those pages through Chrome's debugging interface; the sites you apply on receive the information you
submit to them.

Before LinkedIn automation, the extension checks whether your LinkedIn sign-in cookies exist and when they expire.
This happens on your device; cookie values are never sent to us.

### 6. Auto Email (HR contact discovery)

When you run Auto Email with a job title, the extension opens Google search pages in your browser and collects job
titles, company names, locations and email addresses that are publicly listed in those results. It passes this list to
your JobForm Automator account page on jobformautomator.com, where it is kept in that page's browser storage for you to
review, edit and send emails. Emails are sent by the JobForm Automator website service, which is covered by our website
Privacy Policy. The extension does not send this list to its own server.

### 7. AI responses and logs

Our server stores the text of each AI response along with the model used, tokens, credits charged, timing and status,
so that credits can be accounted for and problems investigated. Our server logs record requests (time, address and
status) and may include short excerpts of AI requests and the full AI responses for troubleshooting.

### 8. Optional features you configure

- **Your own AI provider keys.** If you add an API key for another AI provider (for example OpenAI, Anthropic, Google
  Gemini or OpenRouter), the key is stored in the extension's local storage, and page content and instructions for
  your tasks are sent directly from your browser to that provider under its own privacy policy.
- **Voice input.** If you set up speech-to-text with your own Google Gemini API key, the audio you record is sent to
  Google Gemini for transcription.

### 9. Analytics

The current version of the extension does not send usage analytics. Settings include an analytics switch; if usage
analytics are introduced, they will be limited to task events (started, completed, failed, cancelled) and the website
domain, never page content, and you will be able to turn them off.

## How we use information

We use the information above only to provide and improve the extension's job-application features: verifying your
sign-in, running the automations you start, parsing your résumé, filling application forms, recording applications and
daily limits, managing credits and subscriptions, keeping the service secure and preventing abuse, and fixing problems.

We do not sell your data, share it with data brokers, use it for advertising, or use it to determine
creditworthiness or for lending. People at JobForm Automator do not read your data unless you ask us for help, it is
necessary for security or to comply with the law, or it is aggregated and anonymized for internal operations. Our use
of information received through the extension complies with the Chrome Web Store User Data Policy, including the
Limited Use requirements.

## Service providers

We use these providers to run the extension. They process data on our behalf, under their own terms:

| Provider | Purpose |
| --- | --- |
| Google Firebase (Authentication, Realtime Database) | Sign-in and storage of account, profile, application and credit data |
| Google Cloud Run and Cloud Logging | Hosting our server (Asia South region) and its logs |
| Amazon Web Services (Amazon Bedrock) | AI models for automations and résumé parsing |
| Razorpay | Payments and subscriptions |

When you use Auto Email, Google Search receives the searches your browser makes. AI providers you add yourself and
the websites you apply on receive the data described above.

## Storage and retention

- **On your device:** extension data stays in Chrome's extension storage until you delete it (for example chat
  sessions), remove the extension, or a different account signs in to the extension — the previous account's local
  data is then erased. Signing out keeps your local profile so it is available when you sign back in.
- **On our servers:** account, profile, application, AI response, credit and subscription records are kept while your
  account is active and until you ask us to delete them.

## Your choices and rights

- Sign out from the extension at any time.
- Delete chat sessions in the side panel, and remove your own AI provider keys in Settings.
- Uninstall the extension to remove its local data from your browser.
- Ask us to access, correct or delete your data by emailing contact@jobformautomator.com. See also our Data Deletion
  Policy at https://jobformautomator.com/datadeletionpolicy.

## Security

Data is sent over encrypted HTTPS connections. Our server verifies your sign-in token on every request. Sign-in
tokens and any API keys you add are stored in the extension's local storage on your device, which websites cannot
read; keep your device and browser profile secure.

## Permissions

| Permission | Why the extension needs it |
| --- | --- |
| Access to websites (all sites) | Job boards and employer application forms can be on any website; the extension reads and fills forms on the sites you automate. |
| debugger | Sends trusted clicks and keystrokes and reads pages through Chrome's debugging interface while filling applications. Chrome shows a notice while this is active. |
| scripting | Runs the extension's own bundled scripts on the page being automated to read and fill forms, and to collect search results for Auto Email. |
| tabs | Opens, switches and monitors the tabs used for applications and Auto Email. |
| webNavigation | Finds the frames on a page so forms embedded in frames can be filled. |
| cookies | Checks that you are signed in to LinkedIn before LinkedIn automation (on your device only). |
| storage, unlimitedStorage | Keeps your session, profile, résumé files, settings and history on your device. |
| alarms | Keeps long application runs active, resumes after daily limits reset, and retries credit refunds. |
| sidePanel | Shows the extension's main interface in Chrome's side panel. |

## Children

The extension is designed for job seekers and is not directed to children under 16.

## Changes

We will update this page when the extension's data practices change and revise the "Last updated" date. Significant
changes will also be shown in the extension or on our website.

## Contact

JobForm Automator — contact@jobformautomator.com — https://jobformautomator.com/contactUs
