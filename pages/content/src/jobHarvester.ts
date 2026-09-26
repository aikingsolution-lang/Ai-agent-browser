// pages/content/src/jobHarvester.ts

export interface HarvestedJob {
  id: string;
  url: string;
  title: string;
}

/**
 * Human-like scrolling to trigger lazy-loading of job cards
 */
async function smoothScrollContainer(container: HTMLElement, targetCards: number): Promise<void> {
  let previousHeight = 0;
  let scrollAttempts = 0;

  return new Promise(resolve => {
    const scrollInterval = setInterval(() => {
      const cards = container.querySelectorAll(
        'li.jobs-search-results__list-item, li.scaffold-layout__list-item, div.job-card-container, div[data-job-id]',
      );

      // Stop if we hit our target or if scrolling is stuck (reached bottom)
      if (cards.length >= targetCards || scrollAttempts > 15) {
        clearInterval(scrollInterval);
        resolve();
        return;
      }

      container.scrollBy(0, 500 + Math.random() * 200);

      if (container.scrollHeight === previousHeight) {
        scrollAttempts++;
      } else {
        scrollAttempts = 0;
        previousHeight = container.scrollHeight;
      }
    }, 1200); // 1.2s delay mimics human reading pace
  });
}

/**
 * Main Harvester Function
 */
export async function extractJobs(targetCount: number = 15): Promise<HarvestedJob[]> {
  const currentUrl = window.location.href;
  const isJobSearchPage =
    currentUrl.includes('/jobs/search') ||
    currentUrl.includes('/jobs/search-results') ||
    currentUrl.includes('/jobs/collections') ||
    currentUrl.includes('linkedin.com/jobs');

  if (!isJobSearchPage) {
    console.warn('[NanoBrowser] Not on a LinkedIn job search page.');
    return [];
  }

  // 1. Locate the left pane container
  const scrollContainer =
    document.querySelector<HTMLElement>(
      '.jobs-search-results-list, .scaffold-layout__list-container, .jobs-search-results-list__list',
    ) ||
    document.querySelector<HTMLElement>('div[data-view-name="job-card"]')?.parentElement ||
    document.documentElement;

  if (!scrollContainer) {
    console.error('[NanoBrowser] Job list container not found.');
    return [];
  }

  // 2. Trigger lazy-loading
  console.log('[NanoBrowser] Starting human-paced scroll...');
  await smoothScrollContainer(scrollContainer, targetCount);

  // 3. Extract and filter cards
  const jobCards = scrollContainer.querySelectorAll(
    'li.jobs-search-results__list-item, li.scaffold-layout__list-item, div.job-card-container, div[data-job-id]',
  );
  const validJobs: HarvestedJob[] = [];

  for (const card of Array.from(jobCards)) {
    if (validJobs.length >= targetCount) break;

    const textContent = card.textContent || '';

    // FILTER: Ignore jobs already applied to or missing "Easy Apply"
    if (textContent.includes('Applied') || !textContent.includes('Easy Apply')) {
      continue;
    }

    const linkElement = card.querySelector<HTMLAnchorElement>(
      'a.job-card-container__link, a.job-card-list__title, a.job-card-container__link--cursor-pointer, a[href*="/jobs/view/"], a[href*="currentJobId="]',
    );
    if (!linkElement) continue;

    // SANITIZE: Clean the URL (remove tracking parameters)
    const rawUrl = linkElement.href;
    const jobIdMatch = rawUrl.match(/(?:\/jobs\/view\/|currentJobId=)(\d+)/);

    if (jobIdMatch && jobIdMatch[1]) {
      const jobId = jobIdMatch[1];
      const cleanUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
      const titleElement = card.querySelector<HTMLElement>(
        'a.job-card-list__title, .job-card-container__link, .artdeco-entity-lockup__title',
      );
      const title = (
        titleElement?.innerText ||
        titleElement?.textContent ||
        linkElement.innerText ||
        linkElement.textContent ||
        'LinkedIn Job'
      ).trim();

      // Deduplication check
      if (!validJobs.some(job => job.id === jobId)) {
        validJobs.push({ id: jobId, url: cleanUrl, title });
      }
    }
  }

  console.log(`[NanoBrowser] Harvested ${validJobs.length} clean Easy Apply jobs.`);
  return validJobs;
}

/**
 * Message Listener for Background Commands
 */
export function initJobHarvester() {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === 'START_HARVESTING') {
      const count = request.targetCount || 15;
      extractJobs(count).then(jobs => {
        // Send harvested jobs back to the background Queue Manager
        chrome.runtime.sendMessage({
          type: 'HARVESTED_JOBS',
          jobs,
        });
        sendResponse({ status: 'success', count: jobs.length });
      });
      return true; // Keep message channel open for async response
    }
    return false;
  });
}
