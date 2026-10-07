import type {
  IPlatformAdapter,
  IJobQueueItem,
  IPlatformSession,
  IApplicationResult,
  IPlatformExecutionContext,
  SupportedPlatform,
} from '../types';
import type Page from '../../../browser/page';
import { createLogger } from '@src/background/log';
import { queueSafetyStore, isCandidateNameOrInvalidTitle, sanitizeRoleSearchQuery } from '@extension/storage';
import { indeedPacing, INDEED_PACING_CONFIG, type IndeedPacing } from './indeedPacing';
import { resolveIndeedQuestion, type IIndeedAnswerResult } from './indeedResolver';
import { solveQuestionAutonomousWithLLM } from '../../linkedin/formQuestionResolver';
import { getActiveChatModel } from '../../activeModelHelper';

const logger = createLogger('IndeedAdapter');

export const CAPTCHA_MANUAL_SOLVE_TIMEOUT_MS = 60_000; // 60s total window for manual verification
export const CAPTCHA_POLL_INTERVAL_MS = 3_000; // 3s polling interval

export class IndeedAdapter implements IPlatformAdapter {
  public readonly platformId: SupportedPlatform = 'indeed';
  public readonly displayName: string = 'Indeed';
  public readonly domainMatches: string[] = ['indeed.com'];
  public readonly pacing: IndeedPacing = indeedPacing;
  public captchaManualSolveTimeoutMs: number = CAPTCHA_MANUAL_SOLVE_TIMEOUT_MS;
  public captchaPollIntervalMs: number = CAPTCHA_POLL_INTERVAL_MS;

  /**
   * Matches any Indeed domain URL (e.g., indeed.com, in.indeed.com, uk.indeed.com)
   */
  public isMatchingUrl(url: string): boolean {
    if (!url) return false;
    return url.toLowerCase().includes('indeed.com');
  }

  /**
   * Builds an Indeed search URL preserving India domain routing and clean query parameters.
   * Defensively prevents personal candidate names (e.g. "MUBASSHIR ALI") from being used as search queries.
   */
  public buildSearchUrl(
    role: string,
    location: string,
    start?: number,
    candidateName?: string | (string | undefined | null)[],
    easyApplyOnly: boolean = true,
  ): string {
    const cleanRole = sanitizeRoleSearchQuery(role, candidateName, 'Software Engineer');
    let cleanLoc = (location || '').trim();

    // Check if location points to India or Indian cities
    const isIndia =
      /\b(india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|noida|gurgaon|gurugram|kolkata|ahmedabad|jaipur|ind)\b/i.test(
        cleanLoc,
      ) ||
      (!cleanLoc && (Intl.DateTimeFormat().resolvedOptions().timeZone || '').includes('Calcutta'));

    const baseUrl = isIndia ? 'https://in.indeed.com/jobs' : 'https://www.indeed.com/jobs';

    // On in.indeed.com, strip redundant country suffix (e.g. "Bengaluru, India" -> "Bengaluru")
    if (isIndia && cleanLoc) {
      cleanLoc = cleanLoc
        .replace(/,\s*india\b/gi, '')
        .replace(/,\s*in\b/gi, '')
        .trim();
    }

    const params = new URLSearchParams();
    params.set('q', cleanRole);
    if (cleanLoc) {
      params.set('l', cleanLoc);
    }
    if (typeof start === 'number' && start > 0) {
      params.set('start', String(start));
    }
    if (easyApplyOnly) {
      // Indeed's composite filter slot for "Easily apply" (iafilter)
      params.set('sc', '0kf:iafilter();');
    }

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Checks whether the current page or tab presents a Cloudflare or CAPTCHA challenge.
   * Strictly passive inspection — zero programmatic interaction.
   */
  public async checkCaptchaPresent(puppeteerPage?: any, tabId?: number): Promise<boolean> {
    const evaluateCaptchaDOM = () => {
      // 1. Page Title Check (Cloudflare / Indeed security challenge titles)
      const title = (document.title || '').toLowerCase();
      if (
        title.includes('just a moment') ||
        title.includes('attention required') ||
        title.includes('security check') ||
        title.includes('verify you are human') ||
        title.includes('additional verification') ||
        title.includes('cloudflare') ||
        title.includes('blocked - indeed.com') ||
        title.startsWith('blocked')
      ) {
        return true;
      }

      // Helper: check if element is attached and rendered visibly
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle ? window.getComputedStyle(htmlEl) : (htmlEl as any).style;
        if (
          style &&
          (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0)
        ) {
          return false;
        }
        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      // Helper: check if an element is an invisible or non-interactive Google reCAPTCHA v3 badge
      const isRecaptchaV3Badge = (el: Element): boolean => {
        // Class or container checks for grecaptcha badge
        if (
          el.closest?.('.grecaptcha-badge, [data-badge], .grecaptcha-logo') ||
          el.classList?.contains('grecaptcha-badge') ||
          el.classList?.contains('grecaptcha-logo')
        ) {
          return true;
        }
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        const style = window.getComputedStyle ? window.getComputedStyle(htmlEl) : (htmlEl as any).style;
        const isFixed = style && (style.position === 'fixed' || style.position === 'absolute');
        // v3 badge is typically ~256x60 or smaller in the lower corner or offscreen
        if (isFixed && rect.width <= 260 && rect.height <= 80) {
          return true;
        }
        // Sub-100px iframes are tiny tracking badges, never active challenge modals
        if (rect.width < 100 || rect.height < 100) {
          return true;
        }
        return false;
      };

      // 2. Active Cloudflare Turnstile / Challenge Stage elements (must be visible and substantial)
      const cloudflareSelectors = [
        '#challenge-stage',
        '#challenge-form',
        'div#challenge-running',
        '.cf-turnstile',
        '#px-captcha',
      ];
      for (const sel of cloudflareSelectors) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width >= 50 && rect.height >= 50) {
            return true;
          }
        }
      }

      // 3. Active Cloudflare / Turnstile iframes (must be visible and >= 50px)
      const cfIframes = Array.from(
        document.querySelectorAll(
          'iframe[src*="challenges.cloudflare.com" i], iframe[src*="turnstile" i], iframe[src*="cloudflare" i]',
        ),
      );
      for (const iframe of cfIframes) {
        if (isVisible(iframe)) {
          const rect = (iframe as HTMLElement).getBoundingClientRect();
          if (rect.width >= 50 && rect.height >= 50) {
            return true;
          }
        }
      }

      // 4. Interactive hCaptcha or reCAPTCHA v2 checkbox / image challenges
      // MUST be genuinely large and visible (width > 100px AND height > 100px).
      // Explicitly EXCLUDES invisible / corner reCAPTCHA v3 badges.
      const captchaIframes = Array.from(
        document.querySelectorAll('iframe[src*="hcaptcha" i], iframe[src*="recaptcha" i]'),
      );
      for (const iframe of captchaIframes) {
        if (isRecaptchaV3Badge(iframe)) {
          continue;
        }
        if (isVisible(iframe)) {
          const rect = (iframe as HTMLElement).getBoundingClientRect();
          // Active challenge modal or interactive checkbox: both dimensions must exceed 100px
          if (rect.width > 100 && rect.height > 100) {
            return true;
          }
        }
      }

      // 5. Body Text Check: ONLY explicit blocking phrases (NEVER matching 'recaptcha' or generic disclaimers)
      const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
      if (
        bodyText.includes('verify you are human') ||
        bodyText.includes('checking your browser before accessing') ||
        bodyText.includes('additional verification required') ||
        bodyText.includes('request blocked') ||
        bodyText.includes('you have been blocked') ||
        (bodyText.includes('ray id') && bodyText.includes('cloudflare'))
      ) {
        return true;
      }

      return false;
    };

    if (puppeteerPage) {
      try {
        const isPresent = await puppeteerPage.evaluate(evaluateCaptchaDOM);
        if (isPresent) return true;
      } catch {
        // Non-critical evaluation failure
      }
    }

    if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: evaluateCaptchaDOM,
        });
        if (results && results.some(r => r.result === true)) {
          return true;
        }
      } catch {
        // Non-critical execution failure
      }
    }

    return false;
  }

  /**
   * Passive CAPTCHA inspection for a specific Chrome tab across all frames.
   */
  public async checkCaptchaPresentOnTab(tabId: number): Promise<boolean> {
    return this.checkCaptchaPresent(undefined, tabId);
  }

  /**
   * Waits for manual CAPTCHA / Cloudflare challenge resolution by the user in the runner window.
   * Gives the user a short window (e.g. 60 seconds) to solve it manually before falling back
   * to a platform pause.
   *
   * CRITICAL GUARANTEE: Zero programmatic interaction with any challenge elements.
   * Only passive detection polling.
   */
  public async waitForManualCaptchaResolution(
    tabId?: number,
    puppeteerPage?: any,
    context?: IPlatformExecutionContext,
    jobTitle?: string,
  ): Promise<{ solved: boolean; aborted: boolean }> {
    const userMessage =
      "Indeed needs you to verify you're human — click the runner tab and complete the check. We'll check automatically every few seconds.";
    logger.info(`[IndeedAdapter] ${userMessage}`);

    // Focus runner window if Chrome tabs/windows API is available so user sees challenge
    if (typeof chrome !== 'undefined' && chrome.windows) {
      try {
        if (tabId && chrome.tabs) {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        }
      } catch {
        // Non-critical window focus error
      }
    }

    // Notify Live Activity with actionable temporary state
    context?.onLiveActivity?.({
      jobId: context.runId || 'indeed_job',
      url: (puppeteerPage?.url?.() as string) || '',
      title: jobTitle || 'Indeed Job',
      company: 'Indeed',
      status: 'needs_verification',
      reason: userMessage,
      creditsUsed: 0,
    });

    if (context?.portToSend) {
      try {
        context.portToSend.postMessage({
          type: 'LINKEDIN_STATUS_UPDATE',
          text: `⚠️ ${userMessage}`,
          status: 'info',
        });
      } catch {}
    }

    const startTime = Date.now();
    while (Date.now() - startTime < this.captchaManualSolveTimeoutMs) {
      // Check immediately for Stop button / cancellation
      if (context?.signal?.aborted) {
        logger.info('[IndeedAdapter] Stop requested during verification wait window.');
        return { solved: false, aborted: true };
      }

      // Interruptible passive wait
      const waitResult = await this.pacing.waitFieldInteraction(
        context?.signal,
        this.captchaPollIntervalMs,
        this.captchaPollIntervalMs,
      );
      if (waitResult.wasAborted || context?.signal?.aborted) {
        logger.info('[IndeedAdapter] Verification wait cancelled by user.');
        return { solved: false, aborted: true };
      }

      // Check if challenge cleared (PASSIVE CHECK ONLY — zero programmatic interaction)
      let isStillPresent = false;
      if (tabId && (await this.checkCaptchaPresentOnTab(tabId))) {
        isStillPresent = true;
      } else if (puppeteerPage && (await this.checkCaptchaPresent(puppeteerPage, tabId))) {
        isStillPresent = true;
      } else if (!tabId && !puppeteerPage) {
        isStillPresent = await this.checkCaptchaPresent();
      }

      await new Promise(r => setTimeout(r, 2));

      if (!isStillPresent) {
        logger.info('[IndeedAdapter] Verification solved — resuming application.');
        context?.onLiveActivity?.({
          jobId: context.runId || 'indeed_job',
          url: (puppeteerPage?.url?.() as string) || '',
          title: jobTitle || 'Indeed Job',
          company: 'Indeed',
          status: 'running',
          reason: 'Verification solved — resuming application...',
          creditsUsed: 0,
        });

        if (context?.portToSend) {
          try {
            context.portToSend.postMessage({
              type: 'LINKEDIN_STATUS_UPDATE',
              text: '✅ Verification solved — resuming application...',
              status: 'ok',
            });
          } catch {}
        }

        return { solved: true, aborted: false };
      }
    }

    logger.warning(`[IndeedAdapter] Manual verification window (${this.captchaManualSolveTimeoutMs / 1000}s) expired.`);
    return { solved: false, aborted: false };
  }

  /**
   * Zero-interaction CAPTCHA handler that immediately pauses Indeed for today.
   */
  public async handleCaptchaDetected(jobTitle?: string): Promise<IApplicationResult> {
    logger.warning(
      `[IndeedAdapter] CAPTCHA / Bot Challenge detected for "${jobTitle || 'job'}". Pausing Indeed for today.`,
    );
    try {
      await queueSafetyStore.pausePlatformForToday('indeed', 'Indeed requested additional verification');
    } catch (err) {
      logger.error('[IndeedAdapter] Failed to set platform pause in queueSafetyStore:', err);
    }
    return {
      status: 'failed',
      reason: 'Indeed Captcha/Bot Challenge detected',
    };
  }

  /**
   * Detects logged-in vs logged-out state via live Indeed DOM.
   * Prevents false positives by verifying absence of "Sign in" buttons and exact profile links.
   */
  public async validateSession(page: Page): Promise<IPlatformSession> {
    try {
      const evaluateSessionDOM = () => {
        const url = window.location.href.toLowerCase();
        const isAuthUrl =
          url.includes('/auth') ||
          url.includes('/account/login') ||
          url.includes('/account/register') ||
          url.includes('secure.indeed.com');

        const hasLoginForm = !!(
          document.querySelector('form[action*="/auth" i]') ||
          document.querySelector('form#emailform') ||
          document.querySelector('input[name="__email"]') ||
          document.querySelector('#login-email-input') ||
          (document.querySelector('input[type="email"]') && isAuthUrl)
        );

        const hasSignInButton = Array.from(document.querySelectorAll('a, button')).some(el => {
          const text = (el.textContent || '').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const href = (el.getAttribute('href') || '').toLowerCase();
          const dataGnav = (el.getAttribute('data-gnav-element-name') || '').toLowerCase();
          if (dataGnav === 'signin') return true;
          if (
            (text === 'sign in' || text === 'sign in / register' || aria === 'sign in') &&
            (href.includes('/auth') || href.includes('secure.indeed.com') || href === '')
          ) {
            return true;
          }
          return false;
        });

        const hasProfileIndicator = !!(
          document.querySelector('a[data-gnav-element-name="Profile"]') ||
          document.querySelector('button[data-gnav-element-name="Profile"]') ||
          document.querySelector('a[data-gnav-element-name="UserMenu"]') ||
          document.querySelector('button[data-gnav-element-name="UserMenu"]') ||
          document.querySelector('button[data-gnav-element-name="AccountMenu"]') ||
          document.querySelector('button[id*="user-menu" i]') ||
          document.querySelector('.gnav-AccountMenu') ||
          document.querySelector('[data-testid="gnav-profile-menu"]') ||
          document.querySelector('a[href*="account.indeed.com/myaccess" i]') ||
          document.querySelector('a[href*="/myjobs" i]') ||
          document.querySelector('a[href^="https://account.indeed.com"]') ||
          document.querySelector('a[href^="/account?"]') ||
          document.querySelector('a[href^="/account/"]')
        );

        const isLoggedIn = hasProfileIndicator && !hasSignInButton && !isAuthUrl;
        const isLoginWall = isAuthUrl || hasLoginForm;

        return {
          isLoggedIn,
          isLoginWall,
        };
      };

      if (page.puppeteerPage) {
        return await page.puppeteerPage.evaluate(evaluateSessionDOM);
      }

      if (typeof chrome !== 'undefined' && chrome.scripting && page.tabId) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: page.tabId },
          func: evaluateSessionDOM,
        });
        if (results && results[0]?.result) {
          return results[0].result;
        }
      }

      return { isLoggedIn: false, isLoginWall: false };
    } catch (err) {
      logger.warning('[IndeedAdapter] Session check error:', err);
      return { isLoggedIn: false, isLoginWall: false };
    }
  }

  /**
   * Ensures the "Easily apply" filter is activated on the Indeed search results page.
   * If not already active:
   * 1. Checks if 'iafilter' is present in page URL or if the filter pill is already active.
   * 2. Finds the "Easily apply" pill in the filter bar (as shown underneath search inputs).
   * 3. Dispatches mouse click events to activate it.
   * 4. Handles any popover confirmation dialog if rendered.
   */
  public async ensureEasilyApplyFilterActive(page: Page): Promise<{ active: boolean; clicked: boolean }> {
    try {
      const evaluateFilterDOM = async () => {
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        function isVisible(el: HTMLElement | null): boolean {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function dispatchHumanClick(el: HTMLElement) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          if (typeof el.focus === 'function') el.focus();
          const mouseOpts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
          el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
          el.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
          el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
          el.click();
        }

        // Helper: Find active Indeed filter popover / dropdown if already open
        const findOpenPopover = (): HTMLElement | null => {
          const dialogCandidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[role="dialog"], [role="listbox"], [role="menu"], [data-testid*="popover" i], div[class*="popover" i], div[class*="dropdown" i], div[id*="popover" i], div[class*="yosegi-FilterDialog" i]',
            ),
          );
          for (const d of dialogCandidates) {
            if (!isVisible(d)) continue;
            const text = (d.innerText || d.textContent || '').toLowerCase();
            if (
              text.includes('easily apply on indeed') ||
              (text.includes('easily apply') && (text.includes('update') || text.includes('reset')))
            ) {
              return d;
            }
          }
          return null;
        };

        // Helper: Handle popover selection and confirmation
        const handlePopover = async (pop: HTMLElement): Promise<boolean> => {
          // 1. Locate the "Easily apply on Indeed" option
          const optionCandidates = Array.from(
            pop.querySelectorAll<HTMLElement>(
              'li, [role="option"], [role="menuitem"], [role="checkbox"], [role="radio"], label, div, a, button, span',
            ),
          );

          let targetOption: HTMLElement | null = null;
          for (const opt of optionCandidates) {
            if (!isVisible(opt)) continue;
            const text = (opt.innerText || opt.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (text === 'easily apply on indeed' || (text.includes('easily apply on indeed') && text.length < 50)) {
              targetOption = opt;
              break;
            }
          }

          if (!targetOption) {
            for (const opt of optionCandidates) {
              if (!isVisible(opt)) continue;
              const text = (opt.innerText || opt.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
              if (
                (text.includes('easily apply') || text.includes('easy apply')) &&
                !text.includes('all jobs') &&
                text.length < 50
              ) {
                targetOption = opt;
                break;
              }
            }
          }

          if (targetOption) {
            const input =
              targetOption.querySelector<HTMLInputElement>('input') ||
              pop.querySelector<HTMLInputElement>('input[value*="iafilter" i], input[id*="easily-apply" i]');
            if (input && !input.checked) {
              dispatchHumanClick(input);
            } else {
              dispatchHumanClick(targetOption);
            }
            await sleep(400);
          }

          // 2. Click the "Update" button
          const actionButtons = Array.from(
            pop.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"], a'),
          );
          const updateBtn = actionButtons.find(b => {
            if (!isVisible(b)) return false;
            const bText = (b.innerText || b.textContent || '').trim().toLowerCase();
            return (
              bText === 'update' ||
              bText.includes('update') ||
              bText === 'done' ||
              bText === 'apply' ||
              bText.includes('show jobs')
            );
          });

          if (updateBtn) {
            dispatchHumanClick(updateBtn);
            await sleep(600);
            return true;
          }

          return Boolean(targetOption);
        };

        // Step 1: Check if popover is ALREADY open (e.g. from previous action)
        let popover = findOpenPopover();
        if (popover) {
          const success = await handlePopover(popover);
          return { active: true, clicked: success, found: true };
        }

        // Step 2: Locate the filter pill in the filter carousel/toolbar
        const allCandidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, a, [role="button"], li button, li a, [data-testid*="filter" i], div[class*="pill" i], div[class*="filter" i], span[role="button"]',
          ),
        );

        let filterPill: HTMLElement | null = null;
        for (const el of allCandidates) {
          if (!isVisible(el)) continue;

          // Exclude anything inside job cards, job preview, or apply buttons
          if (
            el.closest('#jobsearch-ViewjobPaneWrapper') ||
            el.closest('.jobsearch-JobComponent') ||
            el.closest('.job_seen_beacon') ||
            el.closest('.cardOutline') ||
            el.closest('#mosaic-provider-jobcards') ||
            el.closest('#viewJobButtonContainer')
          ) {
            continue;
          }

          const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          const testid = (el.getAttribute('data-testid') || '').toLowerCase();

          const isMatch =
            rawText.includes('easily apply') ||
            rawText.includes('easy apply') ||
            aria.includes('easily apply') ||
            aria.includes('easy apply') ||
            id.includes('easily-apply') ||
            id.includes('easilyapply') ||
            testid.includes('easily-apply') ||
            testid.includes('easilyapply');

          if (isMatch) {
            filterPill = el.closest('button, a, [role="button"]') || el;
            break;
          }
        }

        if (!filterPill) {
          return { active: false, clicked: false, found: false };
        }

        // Step 3: Check if already active
        const style = window.getComputedStyle(filterPill);
        const bg = style.backgroundColor;
        const isDarkBg =
          bg !== 'rgba(0, 0, 0, 0)' &&
          bg !== 'transparent' &&
          bg !== 'rgb(255, 255, 255)' &&
          bg !== 'rgb(243, 242, 241)';
        const isAriaPressed =
          filterPill.getAttribute('aria-pressed') === 'true' ||
          filterPill.getAttribute('aria-checked') === 'true' ||
          filterPill.getAttribute('aria-selected') === 'true';
        const isClassSelected =
          filterPill.classList.contains('active') ||
          filterPill.classList.contains('selected') ||
          filterPill.classList.contains('is-active') ||
          filterPill.classList.contains('yosegi-FilterPill-selected') ||
          filterPill.parentElement?.classList.contains('selected') ||
          filterPill.parentElement?.classList.contains('active');
        const hasNumberBadge = /\b\d+\b|✓|✔/.test(filterPill.textContent || '');

        const isActuallyActive = isAriaPressed || isClassSelected || (isDarkBg && hasNumberBadge);
        const isAriaExpanded = filterPill.getAttribute('aria-expanded') === 'true';

        if (isActuallyActive && !isAriaExpanded) {
          return { active: true, clicked: false, found: true };
        }

        // Step 4: Click the filter pill to open the popover or toggle
        dispatchHumanClick(filterPill);
        await sleep(600);

        // Check if popover opened after clicking
        popover = findOpenPopover();
        if (popover) {
          const success = await handlePopover(popover);
          return { active: true, clicked: success, found: true };
        }

        // If it was a direct anchor navigation
        if (filterPill instanceof HTMLAnchorElement && filterPill.href && filterPill.href.includes('indeed.com')) {
          if (window.location.href !== filterPill.href) {
            window.location.href = filterPill.href;
          }
        }

        return { active: true, clicked: true, found: true };
      };

      if (page.puppeteerPage) {
        const res = (await page.puppeteerPage.evaluate(evaluateFilterDOM)) as {
          active?: boolean;
          clicked?: boolean;
        } | null;
        return { active: Boolean(res?.active), clicked: Boolean(res?.clicked) };
      }

      if (typeof chrome !== 'undefined' && chrome.scripting && page.tabId) {
        const execRes = await chrome.scripting
          .executeScript({ target: { tabId: page.tabId }, func: evaluateFilterDOM })
          .catch(() => []);
        const r = execRes?.[0]?.result as { active?: boolean; clicked?: boolean } | null;
        return { active: Boolean(r?.active), clicked: Boolean(r?.clicked) };
      }

      return { active: false, clicked: false };
    } catch (err) {
      logger.warning('[IndeedAdapter] Error activating Easily apply filter:', err);
      return { active: false, clicked: false };
    }
  }

  /**
   * Extracts job cards from Indeed search results with strict two-signal Quick Apply detection.
   * Confirms both leaf badge element AND text line confirmation, excluding any external indicators.
   */
  public async extractJobCards(page: Page): Promise<IJobQueueItem[]> {
    try {
      // Proactively ensure Easily apply filter is activated on search results before extracting
      const filterRes = await this.ensureEasilyApplyFilterActive(page).catch(() => ({ active: false, clicked: false }));
      if (filterRes.clicked) {
        logger.info('[IndeedAdapter] Activated "Easily apply" filter pill. Waiting for results to refresh...');
        await new Promise(r => setTimeout(r, 3500));
      }

      const evaluateJobCardsDOM = () => {
        // Guard against "No results found" banners
        const noResultsBanner = document.querySelector(
          '.jobsearch-NoResult-header, .no_results, [data-testid="no-results-header"], .jobsearch-NoResult, #searchSummary .no-results',
        );
        const bodyText = document.body ? document.body.innerText : '';
        if (
          noResultsBanner ||
          bodyText.includes('did not match any jobs') ||
          bodyText.includes('No jobs found matching')
        ) {
          return [];
        }

        // Prefer div.job_seen_beacon to avoid nested multi-level duplicates (li -> cardOutline -> job_seen_beacon)
        const rawCards = Array.from(document.querySelectorAll('div.job_seen_beacon'));
        const cards = rawCards.length > 0 ? rawCards : Array.from(document.querySelectorAll('div.cardOutline'));

        const seenJk = new Set<string>();
        const seenSignatures = new Set<string>();
        const results: Array<{
          platform: 'indeed';
          jobId: string;
          title: string;
          company: string;
          location?: string;
          salary?: string;
          url: string;
          isQuickApply: boolean;
        }> = [];

        for (const card of cards) {
          try {
            const htmlCard = card as HTMLElement;

            // 0. Filter out hidden/zero-size honeypot decoys injected by Indeed
            const rect = htmlCard.getBoundingClientRect();
            const style = window.getComputedStyle(htmlCard);
            if (
              rect.width === 0 ||
              rect.height === 0 ||
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0'
            ) {
              continue;
            }

            // 1. Extract Canonical Job Key (jk)
            // Indeed renders the true canonical job ID in the inner title span: <span id="jobTitle-{jk}">
            const titleSpan = htmlCard.querySelector('span[id^="jobTitle-"]');
            let jk = '';
            if (titleSpan && titleSpan.id) {
              jk = titleSpan.id.replace('jobTitle-', '').trim();
            }

            if (!jk) {
              jk =
                htmlCard.getAttribute('data-jk') || htmlCard.querySelector('[data-jk]')?.getAttribute('data-jk') || '';
            }

            const linkEl = htmlCard.querySelector(
              'h2.jobTitle a, a.jcs-JobTitle, a[data-jk], a[id^="job_"], a[href*="/viewjob" i], a[href*="/rc/clk" i]',
            ) as HTMLAnchorElement | null;

            if (!jk && linkEl) {
              jk = linkEl.getAttribute('data-jk') || '';
              if (!jk) {
                const href = linkEl.getAttribute('href') || linkEl.href || '';
                const match = href.match(/[?&](?:jk|vjk)=([a-zA-Z0-9_-]+)/i);
                if (match) jk = match[1];
              }
              if (!jk && linkEl.id && linkEl.id.startsWith('job_')) {
                jk = linkEl.id.replace('job_', '');
              }
            }

            if (!jk) {
              const idAttr = htmlCard.getAttribute('id') || '';
              const match = idAttr.match(/job_([a-zA-Z0-9]+)/);
              if (match) jk = match[1];
            }

            // Detect synthetic honeypot pattern (sequential hex sliding window e.g. 123456789abcdef0)
            const isHoneypotJk =
              /01234567|12345678|23456789|3456789a|456789ab|56789abc|6789abcd|789abcde|890abcdef|9abcdef0/i.test(jk);
            if (isHoneypotJk) {
              continue;
            }

            if (!jk || seenJk.has(jk)) continue;

            // 2. Extract Title
            const title = (
              titleSpan?.textContent ||
              linkEl?.textContent ||
              htmlCard.querySelector('h2.jobTitle')?.textContent ||
              ''
            ).trim();
            if (!title) continue;

            // 3. Extract Company
            const companyEl = htmlCard.querySelector(
              '[data-testid="company-name"], .companyName, .company_location span',
            );
            const company = (companyEl?.textContent || '').trim();

            // Signature deduplication (same title + company on same search page)
            const signature = `${title.toLowerCase()}|${company.toLowerCase()}`;
            if (seenSignatures.has(signature)) {
              continue;
            }

            seenJk.add(jk);
            seenSignatures.add(signature);

            // 4. Extract Location
            const locEl = card.querySelector('[data-testid="text-location"], .companyLocation');
            const location = (locEl?.textContent || '').trim();

            // 5. Extract Salary snippet
            const salaryEl = card.querySelector(
              'div.metadata.salary-snippet-container, div[data-testid="attribute_snippet_testid"], .salary-snippet',
            );
            const salary = (salaryEl?.textContent || '').trim();

            // 6. Two-Signal Quick Apply Detection
            const cardText = (htmlCard.innerText || htmlCard.textContent || '').toLowerCase();
            const textLines = (htmlCard.innerText || htmlCard.textContent || '')
              .split('\n')
              .map((l: string) => l.trim().toLowerCase())
              .filter(Boolean);

            // Signal 1: DOM Badge Element Check
            const hasBadgeElement = Array.from(card.querySelectorAll('*')).some(el => {
              const text = (el.textContent || '').trim().toLowerCase();
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              const isEasilyApplyText =
                text === 'easily apply' || text === 'apply with your indeed resume' || aria === 'easily apply';
              const hasIaClass =
                typeof el.className === 'string' &&
                (el.className.includes('iaIcon') ||
                  el.className.includes('ia-badge') ||
                  el.className.includes('indeedApply'));
              return isEasilyApplyText || hasIaClass;
            });

            // Signal 2: Independent Text Line Confirmation
            const hasEasilyApplyLine = textLines.some(
              (l: string) => l === 'easily apply' || l.startsWith('easily apply'),
            );

            // Signal 3: Negative Exclusion Filter (External Application indicators)
            const isExternal =
              cardText.includes('apply on company site') ||
              cardText.includes('apply directly') ||
              cardText.includes('apply on employer site') ||
              cardText.includes('apply via company') ||
              textLines.some((l: string) => l.includes('company site') || l.includes('apply directly'));

            const isFilterActiveOnPage =
              window.location.search.includes('iafilter') || window.location.href.includes('iafilter');

            // Quick Apply Detection:
            // 1. If Easily apply filter is active on page, non-external cards are Indeed Apply.
            // 2. Otherwise, require badge element, text line, or card text explicitly containing "easily apply".
            // 3. In all cases, strictly exclude external redirect indicators.
            const isQuickApply =
              !isExternal &&
              (isFilterActiveOnPage ||
                (hasBadgeElement && hasEasilyApplyLine) ||
                cardText.includes('easily apply') ||
                cardText.includes('apply with indeed'));

            const domain = window.location.hostname.includes('in.indeed.com') ? 'in.indeed.com' : 'www.indeed.com';
            const fullUrl = `https://${domain}/viewjob?jk=${jk}`;

            results.push({
              platform: 'indeed',
              jobId: jk,
              title,
              company,
              location: location || undefined,
              salary: salary || undefined,
              url: fullUrl,
              isQuickApply,
            });
          } catch {
            // Skip unparseable card
          }
        }

        return results;
      };

      if (page.puppeteerPage) {
        return await page.puppeteerPage.evaluate(evaluateJobCardsDOM);
      }

      if (typeof chrome !== 'undefined' && chrome.scripting && page.tabId) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: page.tabId },
          func: evaluateJobCardsDOM,
        });
        if (results && results[0]?.result) {
          return results[0].result;
        }
      }

      return [];
    } catch (err) {
      logger.error('[IndeedAdapter] Error extracting job cards:', err);
      return [];
    }
  }

  /**
   * Constructs an Indeed run queue with STRICT Quick Apply filtering.
   * Only jobs where isQuickApply === true enter the queue.
   * Never backfills with external listings.
   */
  public async buildJobQueue(
    page: Page,
    options: {
      maxJobs?: number;
      isJobProcessed?: (jobId: string) => Promise<boolean>;
      onJobSkipped?: (job: IJobQueueItem, reason: string) => void;
    } = {},
  ): Promise<{
    queue: IJobQueueItem[];
    totalScanned: number;
    totalQuickApply: number;
    logMessage: string;
  }> {
    const maxJobs = options.maxJobs || 10;
    const allJobs = await this.extractJobCards(page);
    const totalScanned = allJobs.length;

    // Filter to ONLY genuine Quick Apply jobs
    const quickApplyJobs = allJobs.filter(j => j.isQuickApply === true && !(j as any).isExternal);
    const totalQuickApply = quickApplyJobs.length;

    const queue: IJobQueueItem[] = [];
    for (const job of quickApplyJobs) {
      if (options.isJobProcessed) {
        const isProcessed = await options.isJobProcessed(job.jobId);
        if (isProcessed) {
          if (options.onJobSkipped) {
            options.onJobSkipped(job, 'Already applied previously');
          }
          continue;
        }
      }
      queue.push(job);
      if (queue.length >= maxJobs) break;
    }

    let logMessage = '';
    if (queue.length === 0) {
      logMessage = `No direct "Easily apply" jobs found among the ${totalScanned} scanned listings on Indeed (all require external company sites).`;
    } else if (queue.length < maxJobs) {
      logMessage = `Only ${queue.length} Quick Apply jobs found on this page out of ${totalScanned} total postings (capped at max ${maxJobs}).`;
    } else {
      logMessage = `Queued ${queue.length} eligible Indeed "Easily apply" jobs for this run (capped at max ${maxJobs}).`;
    }

    logger.info(`[IndeedAdapter] ${logMessage}`);
    return {
      queue,
      totalScanned,
      totalQuickApply,
      logMessage,
    };
  }

  /**
   * Applies to an Indeed Quick Apply job.
   * Features:
   * 1. Multi-strategy Apply button detection (selectors -> container -> text-match -> aria/testid)
   * 2. Zero-interaction CAPTCHA checkpoints at 4 critical points:
   *    - Checkpoint 1: Initial navigation
   *    - Checkpoint 2: Immediately after clicking Apply button
   *    - Checkpoint 3: Modal / SmartApply window detection
   *    - Checkpoint 4: Start of each multi-step form transition
   * 3. Randomized human-like pacing at every action and transition
   * 4. Multi-step form progression with loop / stuck detection
   */
  public async applyToJob(job: IJobQueueItem, context: IPlatformExecutionContext): Promise<IApplicationResult> {
    if (!job || !job.url) {
      return { status: 'skipped', reason: 'Invalid job details' };
    }

    if (context.signal?.aborted) {
      return { status: 'skipped', reason: 'Stopped by user' };
    }

    const page = context.page;
    const puppeteerPage = page?.puppeteerPage;

    context.onLiveActivity?.({
      jobId: job.jobId,
      url: job.url,
      title: job.title,
      company: job.company,
      status: 'running',
      reason: 'Navigating to job details...',
      creditsUsed: 0,
    });

    // 1. Navigation to job details
    try {
      if (puppeteerPage) {
        await puppeteerPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(async () => {
          if (page.navigateTo) await page.navigateTo(job.url).catch(() => {});
        });
      } else if (page.navigateTo) {
        await page.navigateTo(job.url).catch(() => {});
      } else if (typeof chrome !== 'undefined' && chrome.tabs && page.tabId) {
        await chrome.tabs.update(page.tabId, { url: job.url });
      }
    } catch (navErr) {
      logger.warning(`[IndeedAdapter] Navigation error for "${job.title}":`, navErr);
    }

    // Pacing delay for page settle
    await this.pacing.waitPageSettle(context.signal);
    if (context.signal?.aborted) return { status: 'skipped', reason: 'Stopped by user' };

    // CHECKPOINT 1: Navigation CAPTCHA check
    if (await this.checkCaptchaPresent(puppeteerPage, page.tabId)) {
      const waitResult = await this.waitForManualCaptchaResolution(page.tabId, puppeteerPage, context, job.title);
      if (waitResult.aborted) return { status: 'skipped', reason: 'Stopped by user' };
      if (!waitResult.solved) return this.handleCaptchaDetected(job.title);
      await this.pacing.waitPageSettle(context.signal);
    }

    // 2. Pre-check: Already Applied check
    const evaluateAlreadyApplied = () => {
      const selectors = [
        'div.ia-AppliedBadge',
        'div[class*="AppliedBadge" i]',
        '[data-testid="myJobsStatePill"]',
        'button[disabled*="applied" i]',
        'span[data-testid="myJobsStatePill"]',
        '.jobsearch-JobInfoHeader-actions [class*="applied" i]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return true;
      }

      const actionHeader = document.querySelector(
        '#jobsearch-ViewJobButtons-container, .jobsearch-JobInfoHeader-actions, #viewJobButtonContainer, [data-testid="primary-apply-action"]',
      );
      const headerText = (actionHeader?.textContent || '').toLowerCase();
      const appliedKeywords = [
        'you applied to this job',
        'applied on indeed',
        'you have applied to this job',
        "you've applied to this job",
      ];
      return appliedKeywords.some(kw => headerText.includes(kw));
    };

    let alreadyApplied = false;
    if (puppeteerPage) {
      alreadyApplied = await puppeteerPage.evaluate(evaluateAlreadyApplied).catch(() => false);
    } else if (typeof chrome !== 'undefined' && chrome.scripting && page.tabId) {
      const res = await chrome.scripting
        .executeScript({ target: { tabId: page.tabId }, func: evaluateAlreadyApplied })
        .catch(() => []);
      alreadyApplied = Boolean(res?.[0]?.result);
    }

    if (alreadyApplied) {
      logger.info(`[IndeedAdapter] Already applied to "${job.title}". Skipping cleanly.`);
      return { status: 'skipped', reason: 'Already applied on Indeed.' };
    }

    // 3. Multi-Strategy Apply Button Detection & Click (with up to 8 retries for dynamic hydration)
    const evaluateApplyButton = () => {
      function isVisible(el: HTMLElement | null): boolean {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      let btn: HTMLElement | null = null;
      let matchedStrategy = '';

      // Strategy 1: Primary CSS selectors & known testids/IDs
      const primarySelectors = [
        '[data-testid="viewjob-indeed-apply"]',
        '[data-testid="primary-apply-action"] a',
        '[data-testid="primary-apply-action"] button',
        '#indeedApplyButton',
        'button[data-testid="indeedApplyButton"]',
        'button.indeed-apply-button',
        'button.ia-IndeedApplyButton',
        'button[id*="indeedApply" i]',
        'div.jobsearch-IndeedApplyButton button',
        'div[data-testid="indeedApplyButton"] button',
        '[data-testid="jobsearch-IndeedApplyButton"] button',
        'a[data-testid="indeedApplyButton"]',
        'a.indeed-apply-button',
        '#jobsearch-ViewJobButtons-container button',
        '#viewJobButtonContainer button',
      ];

      for (const sel of primarySelectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el && isVisible(el)) {
          btn = el;
          matchedStrategy = `selector: "${sel}"`;
          break;
        }
      }

      // Strategy 2: Container-based button search
      if (!btn) {
        const containers = document.querySelectorAll(
          '[data-testid="primary-apply-action"], #jobsearch-ViewJobButtons-container, .jobsearch-JobInfoHeader-actions, #viewJobButtonContainer, [data-testid="jobsearch-IndeedApplyButton"], [data-testid="viewJob-applyButton"]',
        );
        for (const c of Array.from(containers)) {
          const cBtns = Array.from(c.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
          for (const cb of cBtns) {
            if (isVisible(cb)) {
              const t = (cb.textContent || '').trim().toLowerCase();
              if (t.includes('apply') || cb.getAttribute('aria-label')?.toLowerCase().includes('apply')) {
                btn = cb;
                matchedStrategy = `container-button: "${t}"`;
                break;
              }
            }
          }
          if (btn) break;
        }
      }

      // Strategy 3: Text content matching on visible interactives
      if (!btn) {
        const interactives = Array.from(
          document.querySelectorAll(
            'button, [role="button"], a.is-primary, a[class*="button" i], a[class*="btn" i], a[href*="apply" i]',
          ),
        ) as HTMLElement[];
        for (const el of interactives) {
          if (!isVisible(el)) continue;
          const bText = (el.textContent || '').trim().toLowerCase();
          if (
            bText === 'apply now' ||
            bText === 'easily apply' ||
            bText === 'easy apply' ||
            bText === 'apply' ||
            bText.startsWith('apply now') ||
            bText.startsWith('easily apply')
          ) {
            btn = el;
            matchedStrategy = `text-match: "${bText}"`;
            break;
          }
        }
      }

      // Strategy 4: ARIA label & Data attribute matching
      if (!btn) {
        const ariaElements = Array.from(
          document.querySelectorAll('[aria-label*="apply" i], [data-testid*="apply" i]'),
        ) as HTMLElement[];
        for (const el of ariaElements) {
          if (isVisible(el)) {
            const label = (el.getAttribute('aria-label') || el.getAttribute('data-testid') || '').toLowerCase();
            if (label.includes('apply')) {
              btn = el;
              matchedStrategy = `aria-or-testid: "${label}"`;
              break;
            }
          }
        }
      }

      if (!btn) return { found: false, isExternal: false, strategy: '', text: '' };

      const btnText = (btn.textContent || '').trim();
      const btnTextLower = btnText.toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const externalIndicators = [
        'apply on company site',
        'apply on employer website',
        'apply on employer site',
        "apply on employer's website",
        'apply directly on company',
        'continue to apply',
        'apply externally',
      ];

      const isExternal =
        externalIndicators.some(ind => btnTextLower.includes(ind) || ariaLabel.includes(ind)) ||
        (btn.tagName === 'A' &&
          !!(btn as HTMLAnchorElement).href &&
          !(btn as HTMLAnchorElement).href.includes('indeed.com') &&
          !(btn as HTMLAnchorElement).href.includes('smartapply'));

      // Click the button if not external
      if (!isExternal) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.focus();
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        btn.click();
      }

      return { found: true, isExternal, strategy: matchedStrategy, text: btnText };
    };

    let applyBtnResult = { found: false, isExternal: false, strategy: '', text: '' };
    for (let retry = 0; retry < 8; retry++) {
      if (puppeteerPage) {
        applyBtnResult = await puppeteerPage
          .evaluate(evaluateApplyButton)
          .catch(() => ({ found: false, isExternal: false, strategy: '', text: '' }));
      } else if (typeof chrome !== 'undefined' && chrome.scripting && page.tabId) {
        const res = await chrome.scripting
          .executeScript({ target: { tabId: page.tabId }, func: evaluateApplyButton })
          .catch(() => []);
        applyBtnResult = res?.[0]?.result || { found: false, isExternal: false, strategy: '', text: '' };
      }

      if (applyBtnResult.found) break;
      await this.pacing.waitFieldInteraction(context.signal, 600, 800);
    }

    if (!applyBtnResult.found) {
      const sessionAfterRetries = await this.validateSession(page);
      if (sessionAfterRetries.isLoginWall) {
        logger.warning(`[IndeedAdapter] Session logged out / Auth wall on job page for "${job.title}".`);
        return {
          status: 'skipped',
          reason: 'Indeed session appears logged out — please sign in to Indeed in the runner window to continue.',
        };
      }
      logger.warning(`[IndeedAdapter] No active Apply button found for "${job.title}" after retries.`);
      return { status: 'skipped', reason: 'No active Apply button found.' };
    }

    if (applyBtnResult.isExternal) {
      logger.info(
        `[IndeedAdapter] External application button detected ("${applyBtnResult.text}"). Skipping with 0 credits.`,
      );
      return { status: 'skipped', reason: 'Requires applying directly on company site.' };
    }

    // Snapshot pre-existing tab IDs to prevent treating existing tabs as new external tabs
    const preExistingTabIds = new Set<number>();
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const tabs = await chrome.tabs.query({});
        tabs.forEach(t => {
          if (t.id) preExistingTabIds.add(t.id);
        });
      } catch {}
    }

    logger.info(`[IndeedAdapter] Clicked Apply button ("${applyBtnResult.text}" via ${applyBtnResult.strategy}).`);
    await this.pacing.waitFieldInteraction(context.signal);
    if (context.signal?.aborted) return { status: 'skipped', reason: 'Stopped by user' };

    // CHECKPOINT 2: Apply-Click CAPTCHA check
    if (await this.checkCaptchaPresent(puppeteerPage, page.tabId)) {
      const waitResult = await this.waitForManualCaptchaResolution(page.tabId, puppeteerPage, context, job.title);
      if (waitResult.aborted) return { status: 'skipped', reason: 'Stopped by user' };
      if (!waitResult.solved) return this.handleCaptchaDetected(job.title);
      await this.pacing.waitPageSettle(context.signal);
    }

    // 4. Modal & SmartApply Window Detection (Wait up to 10s)
    let activeTabId = page.tabId;
    let modalDetected = false;

    for (let waitSec = 0; waitSec < 10; waitSec++) {
      await new Promise(r => setTimeout(r, 1000));
      if (context.signal?.aborted) return { status: 'skipped', reason: 'Stopped by user' };

      // CHECKPOINT 3: Modal/Tab CAPTCHA check on main tab
      if (await this.checkCaptchaPresent(puppeteerPage, page.tabId)) {
        const waitResult = await this.waitForManualCaptchaResolution(page.tabId, puppeteerPage, context, job.title);
        if (waitResult.aborted) return { status: 'skipped', reason: 'Stopped by user' };
        if (!waitResult.solved) return this.handleCaptchaDetected(job.title);
        await this.pacing.waitPageSettle(context.signal);
      }

      // Step A: Check if modal or form container appeared on the current page FIRST
      const evaluateInlineModal = () => {
        const u = window.location.href.toLowerCase();
        if (u.includes('smartapply') || u.includes('indeedapply')) return true;
        if (
          document.querySelector(
            'div.ia-BasePage, #indeedapply-modal, iframe[id*="indeedapply" i], iframe[src*="smartapply" i], [data-testid*="ia-Container"], .ia-ResumeSelection, [data-testid="ResumeCard"]',
          )
        ) {
          return true;
        }
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        return btns.some(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          return t === 'continue' || t === 'next' || t.includes('review') || t.includes('submit');
        });
      };

      let hasInlineModal = false;
      if (puppeteerPage) {
        hasInlineModal = await puppeteerPage.evaluate(evaluateInlineModal).catch(() => false);
      } else if (typeof chrome !== 'undefined' && chrome.scripting && page.tabId) {
        const res = await chrome.scripting
          .executeScript({ target: { tabId: page.tabId, allFrames: true }, func: evaluateInlineModal })
          .catch(() => []);
        hasInlineModal = Boolean(res?.some(r => r.result === true));
      }

      if (hasInlineModal) {
        modalDetected = true;
        activeTabId = page.tabId;
        logger.info(
          `[IndeedAdapter] Inline application container or action buttons detected on page tab ${page.tabId}`,
        );
        break;
      }

      // Step B: Only if not inline, check if a genuinely new tab opened for SmartApply or external site
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        try {
          const allTabs = await chrome.tabs.query({});
          const newTabs = allTabs.filter(t => t.id && !preExistingTabIds.has(t.id));

          // Check if new tab is for SmartApply
          const smartTab = newTabs.find(t => {
            const u = (t.url || '').toLowerCase();
            return u.includes('smartapply') || u.includes('indeedapply') || u.includes('indeed.com/apply');
          });
          if (smartTab?.id) {
            activeTabId = smartTab.id;
            modalDetected = true;
            logger.info(`[IndeedAdapter] SmartApply detected in new tab ${activeTabId} (${smartTab.url})`);

            // CHECKPOINT 3: Modal/Tab CAPTCHA check on new smartapply tab
            if (await this.checkCaptchaPresentOnTab(activeTabId)) {
              const waitResult = await this.waitForManualCaptchaResolution(activeTabId, undefined, context, job.title);
              if (waitResult.aborted) return { status: 'skipped', reason: 'Stopped by user' };
              if (!waitResult.solved) return this.handleCaptchaDetected(job.title);
              await this.pacing.waitPageSettle(context.signal);
            }
            break;
          }

          // Check if a genuinely new tab is external (company site)
          const externalTab = newTabs.find(
            t =>
              t.id &&
              t.id !== page.tabId &&
              !(t.url || '').toLowerCase().includes('indeed.com') &&
              !(t.url || '').toLowerCase().includes('smartapply'),
          );
          if (externalTab?.id) {
            logger.info(`[IndeedAdapter] External application tab opened (${externalTab.url}). Closing and skipping.`);
            await chrome.tabs.remove(externalTab.id).catch(() => {});
            return { status: 'skipped', reason: 'Job requires external application on employer website.' };
          }
        } catch {
          // Non-critical tab query error
        }
      }
    }

    if (!modalDetected) {
      logger.warning(`[IndeedAdapter] No modal or application container detected for "${job.title}".`);
    }

    context.onLiveActivity?.({
      jobId: job.jobId,
      url: job.url,
      title: job.title,
      company: job.company,
      status: 'modal_opened',
      reason: 'Application form detected',
      creditsUsed: 0,
    });

    // 5. Multi-Step Form Progression Loop (up to 12 steps)
    const maxSteps = 12;
    let previousFingerprint = '';
    let consecutiveSameStepCount = 0;

    await this.disableBeforeUnload(activeTabId, puppeteerPage);

    for (let step = 1; step <= maxSteps; step++) {
      if (context.signal?.aborted) {
        return { status: 'skipped', reason: 'Stopped by user' };
      }

      if (step === 1) {
        // Allow SmartApply SPA 1.5s to hydrate its initial component (e.g. resume selection module)
        await new Promise(r => setTimeout(r, 1500));
      }

      // CHECKPOINT 4: Form Step Transition CAPTCHA check
      if (await this.checkCaptchaPresentOnTab(activeTabId)) {
        const waitResult = await this.waitForManualCaptchaResolution(activeTabId, puppeteerPage, context, job.title);
        if (waitResult.aborted) {
          if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
            await chrome.tabs.remove(activeTabId).catch(() => {});
          }
          return { status: 'skipped', reason: 'Stopped by user' };
        }
        if (!waitResult.solved) {
          if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
            await chrome.tabs.remove(activeTabId).catch(() => {});
          }
          return this.handleCaptchaDetected(job.title);
        }
        await this.pacing.waitPageSettle(context.signal);
      }

      // Check if application was already submitted / completed
      const isSuccess = await this.checkApplicationSubmitted(activeTabId, puppeteerPage);
      if (isSuccess) {
        logger.info(`[IndeedAdapter] Application submitted successfully for "${job.title}"!`);
        if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
          await chrome.tabs.remove(activeTabId).catch(() => {});
        }
        return { status: 'applied', creditsUsed: 1 };
      }

      // 1. Handle resume picker step if present
      await this.handleResumeStep(activeTabId, puppeteerPage, context.careerBrain);

      // 2. Scan and fill all unfilled fields on current step BEFORE looking for progression buttons
      const filledCount = await this.scanAndFillCurrentStepFields(activeTabId, puppeteerPage, context, job);
      if (filledCount > 0) {
        logger.info(`[IndeedAdapter] Step ${step}: Filled ${filledCount} field(s) with human-like pacing.`);
      }

      // 3. Find primary action button for current step with retry polling (up to 6 retries)
      let stepAction = await this.findStepActionButton(activeTabId, puppeteerPage);
      if (!stepAction.found) {
        for (let retry = 1; retry <= 6; retry++) {
          await new Promise(r => setTimeout(r, 1000));
          if (context.signal?.aborted) break;

          // Scroll down to reveal lazy-loaded action footer / buttons
          await this.scrollTabDown(activeTabId, puppeteerPage);
          stepAction = await this.findStepActionButton(activeTabId, puppeteerPage);
          if (stepAction.found) {
            logger.info(`[IndeedAdapter] Found step action button "${stepAction.text}" on retry ${retry}.`);
            break;
          }
        }
      }

      if (!stepAction.found) {
        // Re-check success one more time in case confirmation rendered
        const finalSuccess = await this.checkApplicationSubmitted(activeTabId, puppeteerPage);
        if (finalSuccess) {
          if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
            await chrome.tabs.remove(activeTabId).catch(() => {});
          }
          return { status: 'applied', creditsUsed: 1 };
        }

        logger.info(`[IndeedAdapter] No further progression buttons found at step ${step}.`);
        break;
      }

      // Loop / Stuck Detection: detect if same step repeats consecutively
      const currentFingerprint = `${stepAction.text}:${stepAction.inputCount || 0}`;
      if (currentFingerprint === previousFingerprint) {
        consecutiveSameStepCount++;
        if (consecutiveSameStepCount >= 2) {
          // Attempt auto-healing validation errors before aborting
          logger.info(`[IndeedAdapter] Step ${step}: Detected repeated step; attempting validation error auto-heal...`);
          await this.autoHealValidationErrors(activeTabId, puppeteerPage, context, job);
        }
        if (consecutiveSameStepCount >= 3) {
          logger.warning(
            `[IndeedAdapter] Form stuck on step "${stepAction.text}" for 3 consecutive attempts. Exiting cleanly.`,
          );
          if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
            await chrome.tabs.remove(activeTabId).catch(() => {});
          }
          return { status: 'skipped', reason: 'Form requires unanswered required fields or manual input.' };
        }
      } else {
        consecutiveSameStepCount = 0;
        previousFingerprint = currentFingerprint;
      }

      logger.info(
        `[IndeedAdapter] Step ${step}: Clicking "${stepAction.text}" (${stepAction.type}) with human-like pacing...`,
      );

      // Pacing delay before step action
      await this.pacing.waitStepTransition(context.signal);
      if (context.signal?.aborted) return { status: 'skipped', reason: 'Stopped by user' };

      // Click step action button
      await this.clickStepActionButton(activeTabId, puppeteerPage, stepAction.selector || stepAction.text);

      if (stepAction.type === 'submit') {
        logger.info(`[IndeedAdapter] Submit button clicked for "${job.title}". Waiting for submission confirmation...`);
        let submissionConfirmed = false;
        // Wait up to 15 seconds for submission network request and confirmation rendering
        for (let waitSec = 0; waitSec < 15; waitSec++) {
          await new Promise(r => setTimeout(r, 1000));
          if (context.signal?.aborted) return { status: 'skipped', reason: 'Stopped by user' };

          submissionConfirmed = await this.checkApplicationSubmitted(activeTabId, puppeteerPage);
          if (submissionConfirmed) break;

          // Check if validation errors appeared after submit attempt
          const hasErrors = await this.autoHealValidationErrors(activeTabId, puppeteerPage, context, job);
          if (hasErrors) {
            logger.info(`[IndeedAdapter] Validation errors appeared on submit; healed! Re-clicking submit button...`);
            await this.pacing.waitFieldInteraction(context.signal);
            await this.clickStepActionButton(activeTabId, puppeteerPage, stepAction.selector || stepAction.text);
          }
        }

        if (submissionConfirmed) {
          logger.info(`[IndeedAdapter] Application submitted successfully for "${job.title}"!`);
          if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
            await chrome.tabs.remove(activeTabId).catch(() => {});
          }
          return { status: 'applied', creditsUsed: 1 };
        }
      }

      // Settle delay for step transition
      await this.pacing.waitStepTransition(context.signal);

      // Post-click auto-heal: check if red validation errors appeared after clicking
      const healedAfterClick = await this.autoHealValidationErrors(activeTabId, puppeteerPage, context, job);
      if (healedAfterClick) {
        logger.info(`[IndeedAdapter] Step ${step}: Post-click validation error healed! Re-triggering action button...`);
        await this.pacing.waitFieldInteraction(context.signal);
        await this.clickStepActionButton(activeTabId, puppeteerPage, stepAction.selector || stepAction.text);
        await this.pacing.waitStepTransition(context.signal);
      }
    }

    // Final check for submission after progression loop
    const postLoopSuccess = await this.checkApplicationSubmitted(activeTabId, puppeteerPage);
    if (postLoopSuccess) {
      if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
        await chrome.tabs.remove(activeTabId).catch(() => {});
      }
      return { status: 'applied', creditsUsed: 1 };
    }

    if (activeTabId !== page.tabId && typeof chrome !== 'undefined' && chrome.tabs) {
      await chrome.tabs.remove(activeTabId).catch(() => {});
    }

    return { status: 'skipped', reason: 'Application reached step limit without final confirmation.' };
  }

  /**
   * Helper: Checks whether the application was successfully submitted.
   */
  public async checkApplicationSubmitted(tabId: number, puppeteerPage?: any): Promise<boolean> {
    const evaluateSubmittedDOM = () => {
      const u = window.location.href.toLowerCase();
      if (
        u.includes('/postapply') ||
        u.includes('/post-apply') ||
        u.includes('post_apply') ||
        u.includes('postapply') ||
        u.includes('/applied') ||
        u.includes('applied=true') ||
        u.includes('status=applied') ||
        u.includes('indeedapply/postapply') ||
        u.includes('smartapply/postapply')
      ) {
        return true;
      }

      const bodyText = (document.body?.innerText || '').toLowerCase();
      const successTexts = [
        'your application has been submitted',
        'application submitted',
        'your application was submitted',
        'your application was submitted to',
        'successfully applied',
        'application was sent',
        'your application has been sent',
        'application sent',
        'application complete',
        'thank you for applying',
        'you applied to this job',
        'nice! your application was submitted',
        'return to job search',
      ];
      if (successTexts.some(st => bodyText.includes(st))) return true;

      const successSelectors = [
        'div.ia-AppliedBadge',
        'div[data-testid="post-apply"]',
        'div.ia-PostApply',
        '#post-apply-container',
        '[data-testid*="postapply" i]',
        '[data-testid*="post-apply" i]',
        '[data-testid*="application-submitted" i]',
        'button[disabled*="applied" i]',
      ];
      return successSelectors.some(sel => !!document.querySelector(sel));
    };

    if (puppeteerPage && tabId === puppeteerPage.target?.()?.tabId) {
      return await puppeteerPage.evaluate(evaluateSubmittedDOM).catch(() => false);
    }

    if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      const res = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: evaluateSubmittedDOM })
        .catch(() => []);
      return Boolean(res?.some(r => r.result === true));
    }

    return false;
  }

  /**
   * Helper: Discovers primary action button (Submit, Review, Continue, Next) on current form step.
   * Explicitly prioritizes SUBMIT buttons first so "Submit your application" is never misclassified as "continue".
   */
  public async findStepActionButton(
    tabId: number,
    puppeteerPage?: any,
  ): Promise<{
    found: boolean;
    type?: 'submit' | 'review' | 'continue';
    text?: string;
    selector?: string;
    inputCount?: number;
  }> {
    const evaluateStepActionDOM = () => {
      function isVisible(el: HTMLElement | null): boolean {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const inputCount = document.querySelectorAll('input:not([type="hidden"]), select, textarea').length;

      // Collect all interactive elements in DOM order
      const allButtons = Array.from(
        document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a.is-primary'),
      ) as HTMLElement[];

      // 1. SUBMIT BUTTON CHECK (Highest Priority): Text, ARIA label, testid, or type
      for (const b of allButtons) {
        if (!isVisible(b)) continue;
        const text = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
        const testid = (b.getAttribute('data-testid') || '').toLowerCase();
        const bType = (b.getAttribute('type') || '').toLowerCase();

        const isSubmitText =
          text.includes('submit your application') ||
          text.includes('submit application') ||
          text === 'submit' ||
          aria.includes('submit your application') ||
          aria.includes('submit application') ||
          aria === 'submit';

        const isSubmitAttr =
          testid.includes('submit-button') ||
          testid.includes('submit_button') ||
          testid.includes('submitapplication') ||
          b.classList.contains('ia-submitButton') ||
          b.classList.contains('ia-SubmitButton') ||
          (bType === 'submit' && (text.length === 0 || text.includes('submit')));

        if (isSubmitText || isSubmitAttr) {
          b.setAttribute('data-nano-action-btn', 'submit');
          return {
            found: true,
            type: 'submit' as const,
            text: (b.textContent || 'Submit your application').trim(),
            selector: '[data-nano-action-btn="submit"]',
            inputCount,
          };
        }
      }

      // 2. REVIEW BUTTON CHECK
      for (const b of allButtons) {
        if (!isVisible(b)) continue;
        const text = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
        const testid = (b.getAttribute('data-testid') || '').toLowerCase();

        if (
          text.includes('review your application') ||
          text.includes('review application') ||
          text === 'review' ||
          aria.includes('review') ||
          testid.includes('review-button')
        ) {
          b.setAttribute('data-nano-action-btn', 'review');
          return {
            found: true,
            type: 'review' as const,
            text: (b.textContent || 'Review your application').trim(),
            selector: '[data-nano-action-btn="review"]',
            inputCount,
          };
        }
      }

      // 3. FORWARD / CONTINUE BUTTON CHECK
      for (const b of allButtons) {
        if (!isVisible(b)) continue;
        const text = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
        const testid = (b.getAttribute('data-testid') || '').toLowerCase();

        // Skip buttons that might be back/cancel buttons
        if (text === 'back' || text === 'cancel' || text === 'previous' || aria.includes('back')) {
          continue;
        }

        const isForwardText =
          text === 'continue' ||
          text === 'next' ||
          text.includes('continue') ||
          text.includes('save and continue') ||
          text.includes('save & continue') ||
          text === 'proceed' ||
          aria.includes('continue') ||
          aria.includes('next');

        const isForwardAttr =
          testid.includes('continue-button') ||
          testid.includes('ia-navigation-continue') ||
          testid.includes('continue') ||
          b.classList.contains('ia-continueButton') ||
          b.classList.contains('ia-BasePage-primaryButton') ||
          b.classList.contains('ia-SmartApplyCard-primaryButton');

        if (isForwardText || isForwardAttr) {
          b.setAttribute('data-nano-action-btn', 'continue');
          return {
            found: true,
            type: 'continue' as const,
            text: (b.textContent || 'Continue').trim(),
            selector: '[data-nano-action-btn="continue"]',
            inputCount,
          };
        }
      }

      return { found: false, inputCount };
    };

    if (puppeteerPage && tabId === puppeteerPage.target?.()?.tabId) {
      return await puppeteerPage.evaluate(evaluateStepActionDOM).catch(() => ({ found: false }));
    }

    if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      const res = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: evaluateStepActionDOM })
        .catch(() => []);
      const matched = res?.find(r => r.result?.found);
      return matched?.result || { found: false };
    }

    return { found: false };
  }

  /**
   * Helper: Clicks discovered step action button with full Pointer, Mouse, and Form events.
   */
  public async clickStepActionButton(tabId: number, puppeteerPage?: any, selectorOrText?: string): Promise<boolean> {
    const evaluateClickDOM = (target: string) => {
      function isVisible(el: HTMLElement | null): boolean {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      let btn: HTMLElement | null = null;
      if (target.startsWith('button') || target.startsWith('[') || target.startsWith('#') || target.startsWith('.')) {
        const matches = Array.from(document.querySelectorAll(target)) as HTMLElement[];
        btn = matches.find(el => isVisible(el)) || matches[0] || null;
      }
      if (!btn) {
        const lower = target.toLowerCase();
        const allButtons = Array.from(
          document.querySelectorAll(
            'button, [role="button"], input[type="submit"], input[type="button"], a.is-primary',
          ),
        ) as HTMLElement[];
        btn =
          allButtons.find(b => isVisible(b) && (b.textContent || '').trim().toLowerCase() === lower) ||
          allButtons.find(b => isVisible(b) && (b.textContent || '').trim().toLowerCase().includes(lower)) ||
          null;
      }

      if (btn) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.focus();
        const opts = { bubbles: true, cancelable: true, view: window };
        try {
          btn.dispatchEvent(new PointerEvent('pointerdown', opts));
          btn.dispatchEvent(new MouseEvent('mousedown', opts));
          btn.dispatchEvent(new PointerEvent('pointerup', opts));
          btn.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch (e) {}

        btn.click();

        try {
          btn.dispatchEvent(new MouseEvent('click', opts));
        } catch (e) {}

        // Fallback for HTML5 forms: requestSubmit dispatches form submit event that React listens to
        const form = (btn as HTMLButtonElement).form || btn.closest('form');
        if (form && (btn.getAttribute('type') === 'submit' || /submit/i.test(btn.textContent || ''))) {
          try {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit(btn as HTMLButtonElement);
            }
          } catch (e) {}
        }
        return true;
      }
      return false;
    };

    if (puppeteerPage && tabId === puppeteerPage.target?.()?.tabId) {
      return await puppeteerPage.evaluate(evaluateClickDOM, selectorOrText || '').catch(() => false);
    }

    if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      const res = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: evaluateClickDOM, args: [selectorOrText || ''] })
        .catch(() => []);
      return Boolean(res?.some(r => r.result === true));
    }

    return false;
  }

  /**
   * Helper: Handles resume selection step if present on current form.
   * Ensures candidate's default Indeed resume or first option is selected.
   */
  public async handleResumeStep(tabId: number, puppeteerPage?: any, _careerBrain?: any): Promise<boolean> {
    const evaluateResumeDOM = () => {
      const resumeSelectors = [
        '[data-testid="resume-select"]',
        'input[name*="resume" i]',
        'input[id*="resume" i]',
        'div[data-testid*="resume" i]',
        'div.ia-ResumeCard',
        '[data-testid="ResumeCard"]',
        '.ia-ResumeSelection',
        '.ia-ResumeCard-container',
      ];
      const hasResumeContainer = resumeSelectors.some(s => !!document.querySelector(s));
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hasResumeText =
        bodyText.includes('select a resume') ||
        bodyText.includes('add a resume') ||
        bodyText.includes('choose a resume') ||
        (bodyText.includes('resume') && (bodyText.includes('continue') || bodyText.includes('next')));
      if (!hasResumeContainer && !hasResumeText) return false;

      const radios = Array.from(
        document.querySelectorAll(
          'input[type="radio"][name*="resume" i], input[type="radio"][id*="resume" i], input[type="radio"]',
        ),
      ) as HTMLInputElement[];

      if (radios.length > 0) {
        const alreadyChecked = radios.some(r => r.checked || r.getAttribute('aria-checked') === 'true');
        if (!alreadyChecked) {
          const first = radios[0];
          first.click();
          first.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }

      // Check clickable resume card tiles / radio groups
      const resumeCards = Array.from(
        document.querySelectorAll(
          '[data-testid*="ResumeCard"], .ia-ResumeCard, div[role="radio"][aria-label*="resume" i]',
        ),
      ) as HTMLElement[];
      if (resumeCards.length > 0) {
        const isAnyCardSelected = resumeCards.some(
          c =>
            c.getAttribute('aria-checked') === 'true' ||
            c.classList.contains('selected') ||
            !!c.querySelector('input:checked'),
        );
        if (!isAnyCardSelected) {
          resumeCards[0].click();
          return true;
        }
      }

      return false;
    };

    if (puppeteerPage && tabId === puppeteerPage.target?.()?.tabId) {
      return await puppeteerPage.evaluate(evaluateResumeDOM).catch(() => false);
    }
    if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      const res = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: evaluateResumeDOM })
        .catch(() => []);
      return Boolean(res?.some(r => r.result === true));
    }
    return false;
  }

  /**
   * Disables browser beforeunload prompts on the given tab so automated navigation is never blocked.
   */
  public async disableBeforeUnload(tabId?: number, puppeteerPage?: any): Promise<void> {
    if (!tabId && !puppeteerPage) return;
    const evalDisable = () => {
      try {
        window.onbeforeunload = null;
        window.addEventListener(
          'beforeunload',
          e => {
            e.stopImmediatePropagation();
          },
          true,
        );
      } catch {}
    };
    if (puppeteerPage && (!tabId || tabId === puppeteerPage.target?.()?.tabId)) {
      await puppeteerPage.evaluate(evalDisable).catch(() => {});
    } else if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: evalDisable }).catch(() => []);
    }
  }

  /**
   * Scrolls the page / container down to bring buttons into view or trigger lazy rendering.
   */
  public async scrollTabDown(tabId?: number, puppeteerPage?: any): Promise<void> {
    if (!tabId && !puppeteerPage) return;
    const evalScroll = () => {
      try {
        window.scrollBy(0, 450);
        const scrollable = document.querySelector(
          'main, .ia-BasePage, #indeedapply-modal, div[class*="container" i], div[class*="content" i]',
        );
        if (scrollable) {
          scrollable.scrollTop += 450;
        }
      } catch {}
    };
    if (puppeteerPage && (!tabId || tabId === puppeteerPage.target?.()?.tabId)) {
      await puppeteerPage.evaluate(evalScroll).catch(() => {});
    } else if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: evalScroll }).catch(() => []);
    }
  }

  /**
   * Helper: Scans the current form step for unfilled required inputs, resolves them via
   * rules -> golden answers -> autonomous LLM fallback, and fills them with human-like pacing.
   */
  public async scanAndFillCurrentStepFields(
    tabId: number,
    puppeteerPage: any,
    context: IPlatformExecutionContext,
    job: IJobQueueItem,
  ): Promise<number> {
    const evaluateScanDOM = () => {
      function isElementVisible(el: HTMLElement): boolean {
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type')?.toLowerCase();
        if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
          const parent =
            el.closest('label, div[class*="checkbox" i], div[class*="radio" i], div[class*="field" i]') ||
            el.parentElement;
          if (parent) {
            const pStyle = window.getComputedStyle(parent);
            if (pStyle.display === 'none' || pStyle.visibility === 'hidden') return false;
            const pRect = parent.getBoundingClientRect();
            if (pRect.width > 0 && pRect.height > 0) return true;
          }
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const inputs = Array.from(
        document.querySelectorAll(
          'input, select, textarea, [role="checkbox"], [role="radio"], [role="combobox"], button[aria-haspopup="listbox"], button.ia-Dropdown, button[data-testid*="select" i]',
        ),
      ) as HTMLElement[];

      const customSelectButtons = Array.from(document.querySelectorAll('button')).filter(b => {
        const txt = (b.textContent || '').trim().toLowerCase();
        return txt.includes('select an option') || txt.includes('choose an option');
      });
      for (const cb of customSelectButtons) {
        if (!inputs.includes(cb)) inputs.push(cb);
      }

      const visibleInputs = inputs.filter(
        el => isElementVisible(el) && !('disabled' in el && (el as HTMLInputElement).disabled),
      );

      const handledRadioGroups = new Set<string>();
      const fieldsToProcess: Array<{
        index: number;
        labelText: string;
        fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date';
        options: string[];
        isFilled: boolean;
      }> = [];

      visibleInputs.forEach((el, idx) => {
        el.setAttribute('data-nano-field-idx', String(idx));
        function cleanText(t: string | null | undefined): string {
          if (!t) return '';
          const s = t.trim().replace(/\s+/g, ' ');
          if (/answer these questions|questions from the employer|fields marked with|report the job/i.test(s)) {
            return '';
          }
          return s;
        }

        const ariaLabel = cleanText(el.getAttribute('aria-label'));
        const labelledById = el.getAttribute('aria-labelledby');
        const ariaLabelledByText = cleanText(labelledById ? document.getElementById(labelledById)?.textContent : '');
        const labelFor = el.id ? cleanText(document.querySelector(`label[for="${el.id}"]`)?.textContent) : '';
        const closestLabel = cleanText(el.closest('label')?.textContent);
        const parentLabel = cleanText(el.parentElement?.querySelector('label')?.textContent);
        const fieldset = el.closest('fieldset');
        const legend = cleanText(fieldset ? fieldset.querySelector('legend')?.textContent : '');

        const questionCard = el.closest(
          'div[class*="Question" i], div[data-testid*="question" i], div[class*="question" i], div[class*="FormField" i], div[class*="field" i]',
        );
        let cardHeading = '';
        if (questionCard && !questionCard.classList.contains('ia-BasePage-component')) {
          const headingEl = questionCard.querySelector(
            'label, [class*="label" i], [class*="heading" i], [class*="title" i], [id*="label" i], span, p',
          );
          cardHeading = cleanText(headingEl?.textContent);
        }

        const prevSiblingText = cleanText(
          el.previousElementSibling?.textContent || el.parentElement?.previousElementSibling?.textContent,
        );
        const placeholder = cleanText(el.getAttribute('placeholder'));
        const name = cleanText(el.getAttribute('name'));

        const labelText = (
          ariaLabel ||
          ariaLabelledByText ||
          labelFor ||
          legend ||
          closestLabel ||
          parentLabel ||
          cardHeading ||
          prevSiblingText ||
          placeholder ||
          name ||
          ''
        ).trim();

        const tagName = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const ariaHasPopup = el.getAttribute('aria-haspopup');
        const inputType = (el.getAttribute('type') || '').toLowerCase();
        let fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date' = 'text';

        const labelLower = labelText.toLowerCase();
        const hasCalendar =
          inputType === 'date' ||
          Boolean(
            el.parentElement?.querySelector(
              'svg[aria-label*="calendar" i], [class*="calendar" i], [class*="DatePicker" i], button[aria-label*="calendar" i]',
            ) ||
              el
                .closest('div[class*="Question" i], div[class*="field" i]')
                ?.querySelector('svg[aria-label*="calendar" i], [class*="calendar" i], [class*="DatePicker" i]'),
          );
        const isDateByLabel =
          labelLower.includes('date of birth') ||
          labelLower.includes('birth date') ||
          labelLower === 'dob' ||
          labelLower.includes('last working day') ||
          labelLower.includes('start date') ||
          labelLower.includes('end date');

        if (hasCalendar || isDateByLabel) {
          fieldType = 'date';
        } else if (
          tagName === 'select' ||
          role === 'combobox' ||
          ariaHasPopup === 'listbox' ||
          el.classList.contains('ia-Dropdown') ||
          (tagName === 'button' && (el.textContent || '').toLowerCase().includes('select an option'))
        ) {
          fieldType = 'select';
        } else if (inputType === 'radio' || role === 'radio') {
          fieldType = 'radio';
        } else if (inputType === 'checkbox' || role === 'checkbox') {
          fieldType = 'checkbox';
        } else if (
          inputType === 'number' ||
          labelLower.includes('salary') ||
          labelLower.includes('ctc') ||
          labelLower.includes('experience')
        ) {
          fieldType = 'number';
        }

        const options: string[] = [];
        if (fieldType === 'select') {
          if (tagName === 'select') {
            const optEls = Array.from(el.querySelectorAll('option'));
            for (const o of optEls) {
              const t = (o.textContent || o.value || '').trim();
              if (t && !/select\s*an\s*option|choose\s*an\s*option/i.test(t) && !options.includes(t)) options.push(t);
            }
          } else {
            const controlsId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            const listbox = controlsId
              ? document.getElementById(controlsId)
              : (questionCard || el.closest('.ia-BasePage-component'))?.querySelector(
                  '[role="listbox"], ul, div[class*="menu" i]',
                ) || document.querySelector('[role="listbox"]');
            if (listbox) {
              const itemEls = Array.from(listbox.querySelectorAll('[role="option"], li, button'));
              for (const item of itemEls) {
                const t = (item.textContent || '').trim();
                if (t && !/select\s*an\s*option|choose\s*an\s*option/i.test(t) && !options.includes(t)) options.push(t);
              }
            }
          }
        } else if (fieldType === 'radio') {
          const groupName = el.getAttribute('name') || el.closest('fieldset')?.id || '';
          if (groupName && handledRadioGroups.has(groupName)) {
            return;
          }
          const siblings = (
            groupName
              ? Array.from(document.querySelectorAll(`input[name="${groupName}"]`))
              : fieldset
                ? Array.from(fieldset.querySelectorAll('input[type="radio"], [role="radio"]'))
                : (questionCard || el.parentElement)?.querySelectorAll('input[type="radio"], [role="radio"]')
                  ? Array.from(
                      (questionCard || el.parentElement)!.querySelectorAll('input[type="radio"], [role="radio"]'),
                    )
                  : [el]
          ) as HTMLInputElement[];
          for (const sib of siblings) {
            const sibText = (sib.closest('label')?.textContent || sib.value || '').trim();
            if (sibText && !options.includes(sibText)) options.push(sibText);
          }
        } else if (fieldType === 'checkbox') {
          const groupName = el.getAttribute('name');
          const siblings = (
            groupName
              ? Array.from(document.querySelectorAll(`input[name="${groupName}"]`))
              : fieldset
                ? Array.from(fieldset.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
                : (questionCard || el.parentElement)?.querySelectorAll('input[type="checkbox"], [role="checkbox"]')
                  ? Array.from(
                      (questionCard || el.parentElement)!.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
                    )
                  : [el]
          ) as HTMLInputElement[];
          for (const sib of siblings) {
            const sibText = (sib.closest('label')?.textContent || sib.value || '').trim();
            if (sibText && !options.includes(sibText)) options.push(sibText);
          }
        }

        let isFilled = false;
        if (fieldType === 'radio') {
          const groupName = el.getAttribute('name') || el.closest('fieldset')?.id || '';
          const siblings = (
            groupName ? Array.from(document.querySelectorAll(`input[name="${groupName}"]`)) : [el]
          ) as HTMLInputElement[];
          isFilled = siblings.some(s => s.checked || s.getAttribute('aria-checked') === 'true');
          if (groupName) handledRadioGroups.add(groupName);
        } else if (fieldType === 'checkbox') {
          isFilled = (el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true';
        } else if (fieldType === 'select') {
          if (tagName === 'select') {
            const selEl = el as HTMLSelectElement;
            const chosenText = selEl.selectedIndex >= 0 ? selEl.options[selEl.selectedIndex]?.text || '' : '';
            isFilled = selEl.selectedIndex > 0 && !/select\s*an\s*option|choose\s*an\s*option/i.test(chosenText);
          } else {
            const txt = (el.textContent || '').trim().toLowerCase();
            isFilled = !txt.includes('select an option') && !txt.includes('choose an option') && txt.length > 0;
          }
        } else {
          isFilled = ((el as HTMLInputElement).value || '').trim().length > 0;
        }

        // If field has active validation error in DOM, force isFilled = false to allow healing
        const isInvalid =
          el.getAttribute('aria-invalid') === 'true' ||
          el.classList.contains('is-invalid') ||
          el.classList.contains('has-error') ||
          Boolean(
            questionCard?.querySelector('.ia-Feedback-error, [class*="error" i], div[role="alert"]') ||
              el.parentElement?.querySelector('[class*="error" i]'),
          );
        if (isInvalid) {
          isFilled = false;
        }

        fieldsToProcess.push({
          index: idx,
          labelText,
          fieldType,
          options,
          isFilled,
        });
      });

      return fieldsToProcess;
    };

    let fields: Array<{
      index: number;
      labelText: string;
      fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date';
      options: string[];
      isFilled: boolean;
    }> = [];

    if (puppeteerPage && tabId === puppeteerPage.target?.()?.tabId) {
      fields = await puppeteerPage.evaluate(evaluateScanDOM).catch(() => []);
    } else if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      const res = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: evaluateScanDOM })
        .catch(() => []);
      fields = res?.[0]?.result || [];
    }

    let filledCount = 0;
    for (const f of fields) {
      if (f.isFilled || !f.labelText) continue;

      let answer = resolveIndeedQuestion(f.labelText, f.fieldType, f.options, context.careerBrain);
      const labelLo = f.labelText.toLowerCase();

      // Conditional "If yes..." follow-up fields:
      const isConditionalIfYes =
        /^(?:if\s+(?:yes|so|applicable|checked|other)|if\s+you\s+(?:answered\s+yes|are|have|were))\b/i.test(labelLo) ||
        /\bif\s+yes\b/i.test(labelLo);
      if (isConditionalIfYes) {
        answer = { value: '', confidence: 0.99, source: 'profile' };
      }

      const isBasicIdentityField =
        f.fieldType === 'text' &&
        (labelLo === 'first name' ||
          labelLo === 'last name' ||
          labelLo === 'full name' ||
          labelLo === 'email' ||
          labelLo === 'phone' ||
          labelLo === 'phone no' ||
          labelLo === 'phone number' ||
          labelLo === 'mobile' ||
          labelLo.includes('github') ||
          labelLo.includes('linkedin'));

      const isDirectConsentField =
        f.fieldType === 'checkbox' &&
        (labelLo.includes('consent') ||
          labelLo.includes('agree') ||
          labelLo.includes('policy') ||
          labelLo.includes('terms'));

      // Lazily resolve scopedLLM if not yet initialized on context
      if (!context.scopedLLM) {
        try {
          context.scopedLLM = (await getActiveChatModel(context.runId)) ?? undefined;
        } catch {}
      }

      // If scopedLLM is available, ALWAYS USE LLM for employer questions, screening, salary, notice period, and dropdowns,
      // OR whenever the answer was not found confidently (low confidence, empty, or default fallback)!
      const isUnansweredOrLowConfidence = !answer.value || answer.confidence < 0.9 || answer.source === 'default';
      const shouldUseLLM =
        Boolean(context.scopedLLM) &&
        !isConditionalIfYes &&
        (!isBasicIdentityField || isUnansweredOrLowConfidence) &&
        !isDirectConsentField;

      if (shouldUseLLM) {
        try {
          logger.info(
            `[IndeedAdapter] 🧠 Asking LLM to resolve field: "${f.labelText}" (${f.fieldType}, ${f.options.length} options)`,
          );
          const llmFieldType =
            f.fieldType === 'select'
              ? 'dropdown'
              : ['text', 'number', 'radio', 'checkbox'].includes(f.fieldType)
                ? (f.fieldType as 'text' | 'number' | 'radio' | 'checkbox')
                : 'text';
          const llmRes = await solveQuestionAutonomousWithLLM(
            { label: f.labelText, fieldType: llmFieldType, options: f.options },
            context.careerBrain,
            context.scopedLLM,
          );
          if (llmRes.success && llmRes.answer) {
            answer = { value: llmRes.answer, confidence: 0.99, source: 'profile' };
            logger.info(`[IndeedAdapter] ✅ LLM resolved "${f.labelText}" -> "${answer.value}"`);
          }
        } catch (err) {
          logger.warning(`[IndeedAdapter] LLM field resolution fallback error, using rule answer:`, err);
        }
      }

      // Sanitize numeric salary fields (prevent corrupted concatenation from profile ranges like 6000001200000)
      const isSalaryQuestion = /\b(salary|ctc|compensation|pay|remuneration|package|drawn)\b/i.test(labelLo);

      const isExperienceQuestion =
        /\b(how many years|years of|experience with|experience do you have|years with|work experience)\b/i.test(
          labelLo,
        );

      if (
        isSalaryQuestion &&
        (f.fieldType === 'number' ||
          (f.fieldType === 'text' &&
            (labelLo.includes('salary') || labelLo.includes('ctc') || labelLo.includes('drawn'))))
      ) {
        const rawAns = String(answer.value).trim();
        const isLPA = /lpa|lakh|lac/i.test(rawAns);
        const rangeMatch = rawAns.match(
          /([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*(?:-|to)\s*([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/i,
        );
        if (rangeMatch) {
          let n = parseFloat(rangeMatch[1].replace(/,/g, ''));
          if (isLPA || (n > 0 && n <= 100)) n *= 100000;
          answer.value = String(Math.round(n));
        } else {
          const digits = rawAns.replace(/[^0-9]/g, '');
          let n = parseFloat(digits);
          if (!isNaN(n)) {
            if (isLPA || (n > 0 && n <= 100)) n *= 100000;
            if (digits.length > 8 && labelLo.includes('salary')) {
              answer.value = digits.slice(0, 6);
            } else {
              answer.value = String(Math.round(n));
            }
          }
        }
      } else if (isExperienceQuestion && (f.fieldType === 'number' || f.fieldType === 'text')) {
        const rawAns = String(answer.value).trim();
        const numMatch = rawAns.match(/([0-9]+(?:\.[0-9]+)?)/);
        if (numMatch) {
          const n = parseFloat(numMatch[1]);
          // Cap experience between 0 and 99 (Indeed constraint: "Answer cannot be greater than 99")
          const capped = Math.min(99, Math.max(0, Math.round(n)));
          answer.value = String(capped);
        } else {
          answer.value = '0';
        }
      }

      // Format date fields strictly as DD/MM/YYYY
      if (
        f.fieldType === 'date' ||
        /\b(date\s+of\s+birth|dob|birth\s+date|working\s+day|start\s+date|end\s+date)\b/i.test(labelLo)
      ) {
        const rawVal = (answer.value || '').trim();
        const ddmmyyyy = rawVal.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
        const yyyymmdd = rawVal.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (ddmmyyyy) {
          answer.value = `${ddmmyyyy[1].padStart(2, '0')}/${ddmmyyyy[2].padStart(2, '0')}/${ddmmyyyy[3]}`;
        } else if (yyyymmdd) {
          answer.value = `${yyyymmdd[3].padStart(2, '0')}/${yyyymmdd[2].padStart(2, '0')}/${yyyymmdd[1]}`;
        } else {
          if (labelLo.includes('working day') || labelLo.includes('start') || labelLo.includes('end')) {
            const today = new Date();
            answer.value = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
          } else {
            const rawDob = context.careerBrain?.dateOfBirth || '2000-01-01';
            const parts = rawDob.split(/[-/]/);
            answer.value =
              parts.length === 3 && parts[0].length === 4
                ? `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`
                : '01/01/2000';
          }
        }
      }

      // Align dropdown/select answers to one of the provided options
      if ((f.fieldType === 'select' || f.options.length > 0) && f.options.length > 0) {
        const validOpts = f.options.filter(o => !/select\s*an\s*option|choose\s*an\s*option|select\.\.\./i.test(o));
        if (validOpts.length > 0) {
          const valLo = answer.value.toLowerCase().trim();
          const exact = validOpts.find(o => o.toLowerCase().trim() === valLo);
          if (exact) {
            answer.value = exact;
          } else {
            const partial = validOpts.find(o => o.toLowerCase().includes(valLo) || valLo.includes(o.toLowerCase()));
            if (partial) {
              answer.value = partial;
            } else {
              answer.value = validOpts[0];
            }
          }
        }
      }

      // Log Live Activity update
      context.onLiveActivity?.({
        jobId: job.jobId,
        url: job.url,
        title: job.title,
        company: job.company,
        status: 'running',
        reason: `[${answer.source}] "${f.labelText.slice(0, 30)}" -> "${answer.value.slice(0, 25)}"`,
        creditsUsed: 0,
      });

      // Pacing delay before field interaction
      await this.pacing.waitFieldInteraction(context.signal);
      if (context.signal?.aborted) break;

      // Fill in DOM
      const evaluateFillDOM = (targetIdx: number, targetType: string, val: string) => {
        function isElementVisible(el: HTMLElement): boolean {
          if (!el) return false;
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type')?.toLowerCase();
          if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
            const parent =
              el.closest('label, div[class*="checkbox" i], div[class*="radio" i], div[class*="field" i]') ||
              el.parentElement;
            if (parent) {
              const pStyle = window.getComputedStyle(parent);
              if (pStyle.display === 'none' || pStyle.visibility === 'hidden') return false;
              const pRect = parent.getBoundingClientRect();
              if (pRect.width > 0 && pRect.height > 0) return true;
            }
          }
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function setReactInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
          input.focus();
          input.dispatchEvent(new Event('focus', { bubbles: true }));
          const tracker = (input as any)._valueTracker;
          if (tracker) {
            tracker.setValue('');
          }
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            input instanceof HTMLTextAreaElement
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype,
            'value',
          )?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(input, value);
          } else {
            input.value = value;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        let el = document.querySelector(`[data-nano-field-idx="${targetIdx}"]`) as
          | (HTMLElement & HTMLInputElement & HTMLSelectElement)
          | null;
        if (!el) {
          const inputs = Array.from(
            document.querySelectorAll(
              'input, select, textarea, [role="checkbox"], [role="radio"], [role="combobox"], button[aria-haspopup="listbox"], button.ia-Dropdown, button[data-testid*="select" i]',
            ),
          ) as HTMLElement[];

          const customSelectButtons = Array.from(document.querySelectorAll('button')).filter(b => {
            const txt = (b.textContent || '').trim().toLowerCase();
            return txt.includes('select an option') || txt.includes('choose an option');
          });
          for (const cb of customSelectButtons) {
            if (!inputs.includes(cb)) inputs.push(cb);
          }

          const visibleInputs = inputs.filter(
            element => isElementVisible(element) && !('disabled' in element && (element as HTMLInputElement).disabled),
          );
          el = (visibleInputs[targetIdx] as (HTMLElement & HTMLInputElement & HTMLSelectElement) | undefined) || null;
        }
        if (!el) return false;

        if (targetType === 'select') {
          if (el.tagName.toLowerCase() === 'select') {
            el.focus();
            let chosenVal: string | null = null;
            let matchedIndex = -1;
            const searchVal = val.toLowerCase().trim();
            const searchDigits = val.replace(/[^0-9]/g, '');

            // 1. Direct text or value match (ignoring empty and placeholder options)
            for (let i = 0; i < el.options.length; i++) {
              const optText = (el.options[i].text || '').trim().toLowerCase();
              const optVal = (el.options[i].value || '').trim().toLowerCase();
              if (!optText && !optVal) continue;
              if (/^(select|choose)(\s+an?\s+option|\s+a\s+country|\.\.\.)?$|^--$|^\s*$/i.test(optText)) continue;
              if (/^(select|choose)$/i.test(optVal)) continue;

              const isDirectMatch =
                (optText && optText === searchVal) ||
                (optVal && optVal === searchVal) ||
                (optText && searchVal.length > 1 && optText.includes(searchVal)) ||
                (optVal && searchVal.length > 1 && optVal.includes(searchVal)) ||
                (optText.length > 2 && searchVal.includes(optText)) ||
                (searchVal.length > 2 && optText.startsWith(searchVal.slice(0, 3))) ||
                (searchVal === 'india' && (optVal === 'in' || optText === 'india' || optText.includes('india')));

              if (isDirectMatch) {
                matchedIndex = i;
                chosenVal = el.options[i].value;
                break;
              }
            }

            // 1.5 Country specific match (if searchVal is India or IN)
            if (matchedIndex === -1 && (searchVal.includes('india') || searchVal === 'in')) {
              for (let i = 0; i < el.options.length; i++) {
                const optText = (el.options[i].text || '').trim().toLowerCase();
                const optVal = (el.options[i].value || '').trim().toLowerCase();
                if (optText.includes('india') || optVal === 'in' || optText === 'in') {
                  matchedIndex = i;
                  chosenVal = el.options[i].value;
                  break;
                }
              }
            }

            // 2. Numeric salary / experience match
            if (matchedIndex === -1 && searchDigits.length >= 2) {
              for (let i = 0; i < el.options.length; i++) {
                const optDigits = (el.options[i].text || '').replace(/[^0-9]/g, '');
                if (
                  optDigits.includes(searchDigits) ||
                  searchDigits.includes(optDigits) ||
                  (searchDigits.length >= 4 &&
                    optDigits.length >= 4 &&
                    optDigits.slice(0, 4) === searchDigits.slice(0, 4))
                ) {
                  matchedIndex = i;
                  chosenVal = el.options[i].value;
                  break;
                }
              }
            }

            // 3. Fallback to first non-placeholder option
            if (matchedIndex === -1 && el.options.length > 1) {
              for (let i = 1; i < el.options.length; i++) {
                const optText = (el.options[i].text || '').trim().toLowerCase();
                if (!/select\s*an\s*option|choose\s*an\s*option|select\s*a\s*country|^--|^\s*$/i.test(optText)) {
                  matchedIndex = i;
                  chosenVal = el.options[i].value;
                  break;
                }
              }
            }

            if (matchedIndex >= 0 && chosenVal !== null) {
              el.selectedIndex = matchedIndex;
              if (el.options[matchedIndex]) {
                el.options[matchedIndex].selected = true;
              }
              const tracker = (el as any)._valueTracker;
              if (tracker) {
                tracker.setValue('');
              }
              const nativeSelectSetter = Object.getOwnPropertyDescriptor(
                window.HTMLSelectElement.prototype,
                'value',
              )?.set;
              if (nativeSelectSetter) {
                nativeSelectSetter.call(el, chosenVal);
              } else {
                el.value = chosenVal;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
            }
            return true;
          } else {
            // Combobox or custom button dropdown or text input acting as dropdown
            el.focus();
            if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') {
              setReactInputValue(el, val);
            }
            el.click();
            const controlsId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
            let listbox = controlsId ? document.getElementById(controlsId) : null;
            if (!listbox) {
              listbox =
                el
                  .closest(
                    'div[class*="Dropdown" i], div[class*="combobox" i], div[class*="field" i], div[class*="Question" i]',
                  )
                  ?.querySelector('[role="listbox"], ul[class*="menu" i], div[class*="menu" i], [role="menu"]') ||
                document.querySelector('[role="listbox"], ul[class*="menu" i], div[class*="menu" i], [role="menu"]');
            }
            if (listbox) {
              const options = Array.from(
                listbox.querySelectorAll('[role="option"], li, button, div[class*="option" i]'),
              ) as HTMLElement[];
              const validOptions = options.filter(
                o =>
                  !/select\s*an\s*option|choose\s*an\s*option|select\s*a\s*country|^--|^\s*$/i.test(
                    (o.textContent || '').trim(),
                  ),
              );
              const targetOpts = validOptions.length > 0 ? validOptions : options;
              const searchVal = val.toLowerCase().trim();
              const searchDigits = val.replace(/[^0-9]/g, '');

              let opt = targetOpts.find(o => {
                const t = (o.textContent || '').toLowerCase().trim();
                return (
                  t === searchVal ||
                  (searchVal.length > 2 && t.includes(searchVal)) ||
                  (t.length > 2 && searchVal.includes(t)) ||
                  (searchVal === 'india' && (t.includes('india') || t === 'in'))
                );
              });

              if (!opt && searchDigits.length >= 2) {
                opt = targetOpts.find(o => {
                  const oDigits = (o.textContent || '').replace(/[^0-9]/g, '');
                  return (
                    oDigits.includes(searchDigits) ||
                    searchDigits.includes(oDigits) ||
                    (searchDigits.length >= 4 &&
                      oDigits.length >= 4 &&
                      oDigits.slice(0, 4) === searchDigits.slice(0, 4))
                  );
                });
              }

              if (opt) {
                opt.click();
                return true;
              } else if (targetOpts.length > 0) {
                targetOpts[0].click();
                return true;
              }
            } else if (el.tagName.toLowerCase() === 'input') {
              el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            }
            return true;
          }
        } else if (targetType === 'radio') {
          const groupName = el.getAttribute('name');
          const siblings = groupName
            ? (Array.from(document.querySelectorAll(`input[name="${groupName}"]`)) as HTMLElement[])
            : [el];
          const opt =
            siblings.find(s =>
              (s.closest('label')?.textContent || (s as HTMLInputElement).value || '')
                .toLowerCase()
                .includes(val.toLowerCase()),
            ) || siblings[0];
          if (opt) {
            opt.focus();
            opt.click();
            opt.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        } else if (targetType === 'checkbox') {
          const impliesYes =
            val.toLowerCase().includes('yes') ||
            val.toLowerCase().includes('consent') ||
            val.toLowerCase().includes('agree');
          if (impliesYes && !(el as HTMLInputElement).checked) {
            el.focus();
            el.click();
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        } else if (targetType === 'date' || el.getAttribute('type') === 'date') {
          let dateStr = val;
          if (el.getAttribute('type') === 'date') {
            const parts = val.split(/[-/]/);
            if (parts.length === 3 && parts[2].length === 4) {
              dateStr = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            }
          }
          setReactInputValue(el, dateStr);
          return true;
        } else {
          setReactInputValue(el, val);
          return true;
        }
        return false;
      };

      if (puppeteerPage && tabId === puppeteerPage.target?.()?.tabId) {
        await puppeteerPage.evaluate(evaluateFillDOM, f.index, f.fieldType, answer.value).catch(() => {});
      } else if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
        await chrome.scripting
          .executeScript({
            target: { tabId, allFrames: true },
            func: evaluateFillDOM,
            args: [f.index, f.fieldType, answer.value],
          })
          .catch(() => {});
      }

      filledCount++;
    }

    return filledCount;
  }

  /**
   * Helper: Auto-heals validation errors in the Indeed application DOM.
   * If red error banners appear or required fields were missed, identifies them,
   * re-resolves them via rules / LLM, fills them, and returns true so the runner can re-advance.
   */
  public async autoHealValidationErrors(
    tabId: number,
    puppeteerPage: any,
    context: IPlatformExecutionContext,
    job: IJobQueueItem,
  ): Promise<boolean> {
    const evaluateErrorDOM = () => {
      function isElementVisible(el: HTMLElement): boolean {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const errorContainers = Array.from(
        document.querySelectorAll(
          '.ia-Feedback-error, [aria-invalid="true"], [data-testid*="error" i], div[class*="error" i], span[class*="error" i], div[role="alert"]',
        ),
      ).filter(el => isElementVisible(el as HTMLElement));

      const invalidInputs = Array.from(
        document.querySelectorAll('[aria-invalid="true"], input:invalid, select:invalid, textarea:invalid'),
      ).filter(el => isElementVisible(el as HTMLElement));

      return errorContainers.length > 0 || invalidInputs.length > 0;
    };

    let hasErrors = false;
    if (puppeteerPage && tabId === puppeteerPage.target?.()?.tabId) {
      hasErrors = await puppeteerPage.evaluate(evaluateErrorDOM).catch(() => false);
    } else if (typeof chrome !== 'undefined' && chrome.scripting && tabId) {
      const res = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: evaluateErrorDOM })
        .catch(() => []);
      hasErrors = Boolean(res?.some(r => r.result === true));
    }

    if (!hasErrors) return false;

    logger.warning(`[IndeedAdapter] Validation errors detected on tab ${tabId}. Running auto-heal...`);
    // Re-scan and fill any empty or invalid fields
    const healedCount = await this.scanAndFillCurrentStepFields(tabId, puppeteerPage, context, job);
    return healedCount > 0;
  }
}

export const indeedAdapter = new IndeedAdapter();
export { indeedPacing, INDEED_PACING_CONFIG };
