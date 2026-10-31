/**
 * Diagnostic utilities for LinkedIn split-pane view and Easy Apply detection.
 * Designed to be completely resilient: never throws even if DOM, details pane,
 * window, or selectors are completely missing, null, or detached.
 */

export interface LinkedInSplitPaneDiag {
  urlPath: string;
  viewportWidth: number;
  detailsMatchesJobId: boolean;
  detailsJobIdFound: string | null;
  currentJobIdInUrl: string | null;
}

export interface LinkedInEasyApplyFailureDiag {
  headingText: string;
  isPaneLoading: boolean;
  hasSpinner: boolean;
  isEmptyHeading: boolean;
  buttonsAndLinks: string[];
  selectorResults: Record<string, boolean>;
  selectorSummary: string;
}

/**
 * Inspects the LinkedIn page for split-pane state and checks whether the details pane
 * is showing the target jobId.
 * Safe to call with any root, document, or window (including undefined/null).
 */
export function inspectLinkedInSplitPane(
  targetJobId: string,
  doc?: Document | null,
  win?: Window | null,
): LinkedInSplitPaneDiag {
  const currentDoc = doc !== undefined ? doc : typeof document !== 'undefined' ? document : null;
  const currentWin = win !== undefined ? win : typeof window !== 'undefined' ? window : null;

  const urlPath = currentWin?.location?.pathname || '';
  const search = currentWin?.location?.search || '';
  const viewportWidth = currentWin?.innerWidth || 0;

  let currentJobIdInUrl: string | null = null;
  try {
    if (search) {
      const params = new URLSearchParams(search);
      currentJobIdInUrl = params.get('currentJobId');
    }
  } catch {}

  if (!currentDoc) {
    const urlMatches = Boolean(
      targetJobId && (currentJobIdInUrl === targetJobId || (urlPath && urlPath.includes(targetJobId))),
    );
    return {
      urlPath,
      viewportWidth,
      detailsMatchesJobId: urlMatches,
      detailsJobIdFound: urlMatches ? targetJobId : currentJobIdInUrl,
      currentJobIdInUrl,
    };
  }

  // Look for details container
  let detailsRoot: HTMLElement | null = null;
  try {
    if (typeof currentDoc.querySelector === 'function') {
      detailsRoot = currentDoc.querySelector(
        '.jobs-search__job-details--container, .scaffold-layout__detail, [data-view-name="job-details"], .jobs-details__main-content, [data-view-name="job-details-top-card"], .job-view-layout, .jobs-unified-top-card',
      ) as HTMLElement | null;
    }
  } catch {}

  let detailsMatchesJobId = false;
  let detailsJobIdFound: string | null = null;

  if (detailsRoot && typeof detailsRoot.querySelector === 'function') {
    if (targetJobId) {
      try {
        const directMatch = detailsRoot.querySelector(
          `[href*="${targetJobId}"], [data-job-id="${targetJobId}"], [componentkey*="${targetJobId}"]`,
        );
        if (directMatch || detailsRoot.getAttribute('data-job-id') === targetJobId) {
          detailsMatchesJobId = true;
          detailsJobIdFound = targetJobId;
        }
      } catch {}
    }

    if (!detailsJobIdFound) {
      try {
        // Find what jobId IS in detailsRoot, if any
        const anyJobEl = detailsRoot.querySelector('[data-job-id], a[href*="/jobs/view/"]');
        if (anyJobEl) {
          const dataId = anyJobEl.getAttribute('data-job-id');
          if (dataId) {
            detailsJobIdFound = dataId;
          } else {
            const href = anyJobEl.getAttribute('href') || '';
            const m = href.match(/\/jobs\/view\/(\d+)/);
            if (m && m[1]) detailsJobIdFound = m[1];
          }
        }
      } catch {}
    }
  }

  // Compare with URL if not matched in DOM
  if (!detailsMatchesJobId && targetJobId) {
    if (currentJobIdInUrl === targetJobId || (urlPath && urlPath.includes(`/jobs/view/${targetJobId}`))) {
      detailsMatchesJobId = true;
      if (!detailsJobIdFound) detailsJobIdFound = targetJobId;
    }
  }

  return {
    urlPath,
    viewportWidth,
    detailsMatchesJobId,
    detailsJobIdFound,
    currentJobIdInUrl,
  };
}

/**
 * Inspects details pane buttons, links, spinners, and selectors when Easy Apply is not found.
 * Never throws even when container, details pane or document is missing.
 */
export function inspectLinkedInEasyApplyFailure(container?: Element | Document | null): LinkedInEasyApplyFailureDiag {
  let root: Element | Document | null = null;
  try {
    if (container !== undefined) {
      root = container;
    } else if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      root = document.querySelector(
        '.jobs-search__job-details--container, .scaffold-layout__detail, [data-view-name="job-details"], .jobs-details__main-content, [data-view-name="job-details-top-card"], .job-view-layout, .jobs-unified-top-card',
      );
    }
  } catch {
    root = null;
  }

  if (!root || typeof root.querySelector !== 'function') {
    return {
      headingText: '<details pane missing>',
      isPaneLoading: false,
      hasSpinner: false,
      isEmptyHeading: true,
      buttonsAndLinks: [],
      selectorResults: {
        'button.jobs-apply-button': false,
        btn_text_easy_apply: false,
        aria_label_easy_apply: false,
        svg_icon_easy_apply: false,
        jobs_apply_button_class: false,
      },
      selectorSummary: 'details pane missing',
    };
  }

  // 1. Heading text
  let headingText = '';
  try {
    const headingEl = root.querySelector(
      'h1, h2, [data-view-name="job-details-top-card"] h1, [data-view-name="job-details-top-card"] h2, .jobs-unified-top-card__job-title, .job-details-jobs-unified-top-card__job-title',
    );
    headingText = (headingEl?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  } catch {}
  const isEmptyHeading = headingText.length === 0;

  // 2. Spinners / loading indicator
  let hasSpinner = false;
  try {
    const spinnerEl = root.querySelector(
      '.artdeco-loader, .artdeco-spinner, [data-test-async-loader], .jobs-details__main-content--loading, .loading-indicator, .jobs-details-skeleton, .ghost-card, [class*="skeleton"], [class*="shimmer"]',
    );
    hasSpinner = Boolean(spinnerEl);
  } catch {}
  const isPaneLoading = hasSpinner || isEmptyHeading;

  // 3. Visible buttons and links inside the details pane (max 15 items, 40 chars each)
  const buttonsAndLinks: string[] = [];
  try {
    const candidateElements =
      typeof root.querySelectorAll === 'function'
        ? (Array.from(root.querySelectorAll('button, a, [role="button"]')) as HTMLElement[])
        : [];

    for (const el of candidateElements) {
      if (buttonsAndLinks.length >= 15) break;
      // Exclude left search pane elements if root happens to encompass document
      if (
        typeof el.closest === 'function' &&
        el.closest('.jobs-search-results-list, .scaffold-layout__list, ul.scaffold-layout__list-container')
      ) {
        continue;
      }
      const rawText = (el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').trim();
      const cleanText = rawText.replace(/\s+/g, ' ').slice(0, 40);
      if (cleanText) {
        const tag = el.tagName ? el.tagName.toLowerCase() : 'el';
        buttonsAndLinks.push(`<${tag}> ${cleanText}`);
      }
    }
  } catch {}

  // 4. Selector match/fail checks for Easy Apply button
  const selectorResults: Record<string, boolean> = {
    'button.jobs-apply-button': false,
    btn_text_easy_apply: false,
    aria_label_easy_apply: false,
    svg_icon_easy_apply: false,
    jobs_apply_button_class: false,
  };

  try {
    selectorResults['button.jobs-apply-button'] = Boolean(root.querySelector('button.jobs-apply-button'));
    selectorResults['svg_icon_easy_apply'] = Boolean(root.querySelector('svg[data-test-icon*="easy-apply"]'));
    selectorResults['jobs_apply_button_class'] = Boolean(root.querySelector('.jobs-apply-button'));

    const candidateButtons =
      typeof root.querySelectorAll === 'function'
        ? (Array.from(root.querySelectorAll('button, a, [role="button"]')) as HTMLElement[])
        : [];

    for (const el of candidateButtons) {
      if (
        typeof el.closest === 'function' &&
        el.closest('.jobs-search-results-list, .scaffold-layout__list, ul.scaffold-layout__list-container')
      ) {
        continue;
      }
      const text = (el.textContent || '').trim();
      const aria = (el.getAttribute?.('aria-label') || '').trim();
      if (/\beasy\s*apply\b/i.test(text)) {
        selectorResults['btn_text_easy_apply'] = true;
      }
      if (/\beasy\s*apply\b/i.test(aria)) {
        selectorResults['aria_label_easy_apply'] = true;
      }
    }
  } catch {}

  const matchedSelectors = Object.entries(selectorResults)
    .filter(([, matched]) => matched)
    .map(([sel]) => sel);

  const selectorSummary =
    matchedSelectors.length > 0 ? `matched: [${matchedSelectors.join(', ')}]` : 'all Easy Apply selectors failed';

  return {
    headingText: headingText || '<empty>',
    isPaneLoading,
    hasSpinner,
    isEmptyHeading,
    buttonsAndLinks,
    selectorResults,
    selectorSummary,
  };
}

/**
 * Summarizes cards found on the search page (once per run).
 */
export function summarizeLinkedInCardScan(cards: Array<{ jobId: string; title: string; company: string }>): {
  total: number;
  validCount: number;
  first3Summary: string;
  consoleLog: string;
  liveActivityLine: string;
} {
  const total = cards.length;
  const validCards = cards.filter(c => Boolean(c.title?.trim() && c.company?.trim()));
  const validCount = validCards.length;

  const first3 = cards
    .slice(0, 3)
    .map((c, i) => `#${i + 1} "${c.title?.trim() || '<empty>'}" @ "${c.company?.trim() || '<empty>'}" (id=${c.jobId})`);

  const first3Summary = first3.join(' | ') || '<none>';

  const consoleLog = `[LinkedInCardScanDiag] Cards found: ${total} | Non-empty title & company: ${validCount}/${total} | First 3: [${first3Summary}]`;
  const liveActivityLine = `[Diag] Cards: ${total} total, ${validCount} valid | Top: ${first3Summary}`;

  return {
    total,
    validCount,
    first3Summary,
    consoleLog,
    liveActivityLine,
  };
}
