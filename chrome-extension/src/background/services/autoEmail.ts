import { fetchHrEmailForCompany } from './emailExtractor';

export interface AutoEmailJob {
  id: string;
  title: string;
  company: string;
  location: string;
  category: string;
  email: string | null;
}

export interface AutoEmailProgress {
  type: 'SCRAPING' | 'EXTRACTING' | 'PROGRESS' | 'COMPLETE' | 'ERROR';
  message: string;
  jobsFound?: number;
  company?: string;
  remaining?: number;
  results?: AutoEmailJob[];
}

export type AutoEmailProgressCallback = (progress: AutoEmailProgress) => void;

// Module-level state so stop signal works across async boundaries
let isRunning = false;
let shouldStop = false;

export function isAutoEmailRunning(): boolean {
  return isRunning;
}

export function stopAutoEmail(): void {
  shouldStop = true;
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Waits up to `ms` ms, checking shouldStop every 500 ms for responsiveness
async function waitWithStop(ms: number): Promise<void> {
  const steps = Math.ceil(ms / 500);
  for (let i = 0; i < steps; i++) {
    if (shouldStop) return;
    await wait(Math.min(500, ms - i * 500));
  }
}

/**
 * Mirrors noah-master's updateEmailsForAllJobs delivery step:
 *   1. Open the JobForm Automator Automation Hub tab (production URL).
 *   2. Wait for it to reach 'complete'.
 *   3. Send the jobs via chrome.tabs.sendMessage({ action: "sendEmailsToWebsite" }).
 *   4. The content script (jobformWebsiteBridge) dispatches CustomEvent("emailsData")
 *      so the React app on the page can ingest the results.
 *
 * Retries up to 15 times at 1-second intervals, matching noah-master's retry logic.
 */
function deliverResultsToAutomationHub(jobs: AutoEmailJob[]): void {
  const hubUrl = 'https://www.jobformautomator.com/dashboard/automation-hub';

  chrome.tabs.create({ url: hubUrl, active: true }, tab => {
    if (!tab?.id) return;
    const tabId = tab.id;

    const listener = (_updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (_updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);

      // Brief delay then attempt with retries — matches noah-master's 1.5s initial wait
      setTimeout(() => {
        let retries = 0;
        const maxRetries = 15;

        const attemptSend = () => {
          chrome.tabs.sendMessage(
            tabId,
            { action: 'sendEmailsToWebsite', data: jobs },
            (response: { success?: boolean } | undefined) => {
              if (chrome.runtime.lastError || !response?.success) {
                if (retries < maxRetries) {
                  retries++;
                  setTimeout(attemptSend, 1000);
                }
              }
            },
          );
        };

        attemptSend();
      }, 1500);
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Open a tab and resolve with its tabId once it reaches status 'complete'. */
function openTabAndWait(url: string, active: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active }, tab => {
      if (chrome.runtime.lastError || !tab?.id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Tab creation failed'));
        return;
      }
      const tabId = tab.id;
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error('Tab load timed out after 30 seconds'));
      }, 30000);

      const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab) => {
        if (t.id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timeout);
        resolve(tabId);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

/**
 * Ported from noah-master content.js scrollToBottom() + extractJobsFromPage().
 * Injected into the Google Jobs tab via executeScript.
 * Scrolls to exhaust infinite scroll, then reads .GoEOPd card children.
 */
async function scrapeGoogleJobsTab(tabId: number): Promise<{ title: string; company: string; location: string }[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injectionResults: any[] = await (chrome.scripting.executeScript as any)({
    target: { tabId },
    func: async () => {
      // Inline wait helper — func must be self-contained, no outer scope refs
      function waitMs(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
      }

      // scrollToBottom — same logic as noah-master content.js lines 4676–4702
      let lastCount = 0;
      let noChangeRounds = 0;
      while (true) {
        const cards = document.querySelectorAll('.GoEOPd');
        if (cards.length > 0) {
          (cards[cards.length - 1] as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else {
          window.scrollTo(0, document.body.scrollHeight);
        }
        await waitMs(2000);
        const newCount = document.querySelectorAll('.GoEOPd').length;
        if (newCount === lastCount) {
          noChangeRounds++;
          if (noChangeRounds >= 2) break;
        } else {
          noChangeRounds = 0;
        }
        lastCount = newCount;
      }

      // extractJobsFromPage — same logic as noah-master content.js lines 4704–4733
      const columns = document.querySelectorAll('.GoEOPd');
      const seenSignatures = new Set<string>();
      const jobs: { title: string; company: string; location: string }[] = [];

      columns.forEach(col => {
        const children = col.children;
        if (children.length < 2) return;
        const title = (children[0]?.textContent || '').trim();
        const company = (children[1]?.textContent || '').trim();
        const locationRaw = (children[2]?.textContent || '').trim();
        const location = locationRaw.split('•')[0].trim();
        if (!title) return;
        const sig = `${title}|${company}`;
        if (seenSignatures.has(sig)) return;
        seenSignatures.add(sig);
        jobs.push({ title, company, location });
      });

      return jobs;
    },
  });

  return (injectionResults?.[0]?.result as { title: string; company: string; location: string }[]) ?? [];
}

/**
 * Full Auto Email workflow:
 *   1. Open Google Jobs tab (active) and scrape job cards
 *   2. Close the Google Jobs tab
 *   3. For each unique company: fetch HR email via Google search (5 s throttle)
 *   4. Report all progress via `onProgress` callback
 *
 * Ported from noah-master background.js updateEmailsForAllJobs +
 * updateMissingJobEmails + fetchHREmailForCompany pipeline.
 * Adapted to NanoBrowser's port-based messaging instead of IndexedDB + localhost delivery.
 */
export async function runAutoEmailWorkflow(jobTitle: string, onProgress: AutoEmailProgressCallback): Promise<void> {
  if (isRunning) {
    onProgress({ type: 'ERROR', message: 'Auto Email is already running. Stop the current run first.' });
    return;
  }

  isRunning = true;
  shouldStop = false;

  try {
    // ── Step 1: Open Google Jobs tab and scrape ──────────────────────────────
    onProgress({ type: 'SCRAPING', message: `Searching Google Jobs for "${jobTitle}"…` });

    // Same URL format as noah-master background.js lines 2957–2958
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(jobTitle)}&ibp=htl;jobs`;

    let jobsTabId: number;
    try {
      jobsTabId = await openTabAndWait(searchUrl, true);
    } catch (e) {
      onProgress({
        type: 'ERROR',
        message: `Could not open Google Jobs tab: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    // Extra 2 s for Google Jobs UI to fully initialize (same as noah-master line 2976)
    await wait(2000);

    let rawJobs: { title: string; company: string; location: string }[] = [];
    try {
      rawJobs = await scrapeGoogleJobsTab(jobsTabId);
    } catch (e) {
      chrome.tabs.remove(jobsTabId).catch(() => {});
      onProgress({ type: 'ERROR', message: `Scraping failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    // Keep the jobs tab open — the user wants to see the search results.
    // Only the silent email-extraction tabs (created inside fetchHrEmailForCompany) are closed.

    if (rawJobs.length === 0) {
      onProgress({
        type: 'ERROR',
        message: `No jobs found on Google Jobs for "${jobTitle}". Try a more specific search query (e.g. "React Developer Dehradun").`,
      });
      return;
    }

    if (shouldStop) {
      onProgress({ type: 'COMPLETE', message: 'Stopped by user before email extraction.', results: [] });
      return;
    }

    onProgress({
      type: 'EXTRACTING',
      message: `Found ${rawJobs.length} job listings. Starting HR email extraction…`,
      jobsFound: rawJobs.length,
    });

    // ── Step 2: Build job records ────────────────────────────────────────────
    const jobs: AutoEmailJob[] = rawJobs.map((j, i) => ({
      id: `${jobTitle}-${i}`,
      title: j.title,
      company: j.company,
      location: j.location,
      category: jobTitle,
      email: null,
    }));

    // ── Step 3: Extract HR email for each unique company ─────────────────────
    // Deduplicate companies but update ALL matching job records (same pattern as noah-master)
    const uniqueCompanies = [...new Set(jobs.map(j => j.company).filter(Boolean))];
    let remaining = uniqueCompanies.length;

    for (const company of uniqueCompanies) {
      if (shouldStop) break;

      onProgress({
        type: 'PROGRESS',
        message: `Fetching HR email for "${company}"… (${remaining} remaining)`,
        company,
        remaining,
      });

      try {
        const email = await fetchHrEmailForCompany(company);
        jobs.forEach(j => {
          if (j.company === company) j.email = email ?? 'Not found';
        });
      } catch {
        jobs.forEach(j => {
          if (j.company === company) j.email = 'Error';
        });
      }

      remaining--;

      // 5-second throttle between companies — same as noah-master background.js line 3320
      if (remaining > 0 && !shouldStop) {
        await waitWithStop(5000);
      }
    }

    // ── Step 4: Report results ───────────────────────────────────────────────
    const foundCount = jobs.filter(j => j.email && j.email !== 'Not found' && j.email !== 'Error').length;

    onProgress({
      type: 'COMPLETE',
      message: shouldStop
        ? `Stopped. Found HR emails for ${foundCount} of ${uniqueCompanies.length} companies.`
        : `Complete! Found HR emails for ${foundCount} of ${uniqueCompanies.length} companies.`,
      results: jobs,
    });

    // Deliver results to JobForm Automator Automation Hub — mirrors noah-master's
    // updateEmailsForAllJobs final step (open hub tab → sendEmailsToWebsite message).
    if (jobs.length > 0) {
      deliverResultsToAutomationHub(jobs);
    }
  } finally {
    isRunning = false;
    shouldStop = false;
  }
}
