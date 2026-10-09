// chrome-extension/src/background/agent/platforms/indeed/indeedAdapter.ts
import type {
  IPlatformAdapter,
  IJobQueueItem,
  IPlatformSession,
  IApplicationResult,
  IPlatformExecutionContext,
  SupportedPlatform,
} from '../types';
import type Page from '../../../browser/page';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { Dialog } from 'puppeteer-core/lib/esm/puppeteer/api/Dialog.js';
import type { ICareerBrain } from '@extension/storage';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { INDEED_SELECTORS } from './selectors';
import { resolveIndeedQuestion } from './indeedResolver';
import { solveQuestionAutonomousWithLLM } from '../../linkedin/formQuestionResolver';
import { queueSafetyStore } from '@extension/storage';
import { createLogger } from '@src/background/log';

const logger = createLogger('IndeedAdapter');

export class IndeedAdapter implements IPlatformAdapter {
  public readonly platformId: SupportedPlatform = 'indeed';
  public readonly displayName: string = 'Indeed';
  public readonly domainMatches: string[] = ['indeed.com'];

  public isMatchingUrl(url: string): boolean {
    if (!url) return false;
    return url.toLowerCase().includes('indeed.com');
  }

  public buildSearchUrl(role: string, location: string): string {
    const cleanRole = (role || 'Software Engineer').trim();
    let cleanLoc = (location || '').trim();

    // Check if location points to India or Indian cities
    const isIndia =
      /\b(india|bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|noida|gurgaon|gurugram|kolkata|ahmedabad|jaipur|ind)\b/i.test(
        cleanLoc,
      ) ||
      (!cleanLoc && (Intl.DateTimeFormat().resolvedOptions().timeZone || '').includes('Calcutta'));

    const baseUrl = isIndia ? 'https://in.indeed.com/jobs' : 'https://www.indeed.com/jobs';

    // On in.indeed.com, strip redundant country (e.g. "Bengaluru, India" -> "Bengaluru")
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

    return `${baseUrl}?${params.toString()}`;
  }

  public async validateSession(page: Page): Promise<IPlatformSession> {
    try {
      const puppeteerPage = page.puppeteerPage;
      if (!puppeteerPage) {
        return { isLoggedIn: false, isLoginWall: false };
      }

      const sessionInfo = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        const url = window.location.href.toLowerCase();
        const isAuthUrl = url.includes('/auth') || url.includes('/account/login') || url.includes('/account/register');

        const hasLoginForm = !!(
          document.querySelector('form[action*="/auth" i]') ||
          document.querySelector('input[name="__email"]') ||
          document.querySelector('#login-email-input')
        );

        const hasUserProfile = selectors.LOGGED_IN_INDICATORS.some(sel => !!document.querySelector(sel));

        return {
          isLoggedIn: hasUserProfile,
          isLoginWall: isAuthUrl || (hasLoginForm && !hasUserProfile),
        };
      }, INDEED_SELECTORS);

      return sessionInfo;
    } catch (err) {
      logger.warning('[IndeedAdapter] Session check error:', err);
      return { isLoggedIn: false, isLoginWall: false };
    }
  }

  public async extractJobCards(page: Page): Promise<IJobQueueItem[]> {
    try {
      const puppeteerPage = page.puppeteerPage;
      if (!puppeteerPage) return [];

      const rawJobs = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        const results: Array<{
          jobId: string;
          title: string;
          company: string;
          url: string;
          location?: string;
          salary?: string;
          isQuickApply?: boolean;
          isExternal?: boolean;
          descriptionSnippet?: string;
        }> = [];

        // Check if Indeed displayed a "No results found" warning
        const noResultsBanner = document.querySelector(
          '.jobsearch-NoResult-header, .no_results, [data-testid="no-results-header"], .jobsearch-NoResult, #searchSummary .no-results',
        );
        const bodyText = document.body ? document.body.innerText : '';
        if (
          noResultsBanner ||
          bodyText.includes('did not match any jobs') ||
          bodyText.includes('No jobs found matching')
        ) {
          // If Indeed explicitly reported 0 results for query, don't scrape fallback recommendations
          return [];
        }

        const seenJk = new Set<string>();
        const cards = Array.from(document.querySelectorAll(selectors.JOB_CARDS.join(', ')));

        for (const el of cards) {
          try {
            // Find job key (jk or vjk)
            let jk = el.getAttribute('data-jk') || el.getAttribute('data-vjk') || '';
            const linkEl = (el.querySelector(selectors.JOB_TITLE.join(', ')) ||
              el.querySelector(
                'a[href*="/viewjob" i], a[href*="/rc/clk" i], a[href*="/pagead/clk" i]',
              )) as HTMLAnchorElement | null;

            if (!jk && linkEl) {
              const href = linkEl.getAttribute('href') || linkEl.href || '';
              const match = href.match(/[?&](?:jk|vjk)=([a-zA-Z0-9_-]+)/i);
              if (match) jk = match[1];
            }
            if (!jk) {
              const dataId = el.getAttribute('id') || '';
              const match = dataId.match(/job_([a-zA-Z0-9]+)/);
              if (match) jk = match[1];
            }

            const title = (linkEl?.textContent || '').trim();
            if (!title) continue;

            const companyEl = el.querySelector(selectors.COMPANY_NAME.join(', '));
            const company = (companyEl?.textContent || '').trim();

            const uniqueKey = jk || (title + '::' + company).toLowerCase();
            if (seenJk.has(uniqueKey)) {
              continue;
            }
            seenJk.add(uniqueKey);

            const locEl = el.querySelector(selectors.LOCATION.join(', '));
            const location = (locEl?.textContent || '').trim();

            const salEl = el.querySelector(selectors.SALARY.join(', '));
            const salary = (salEl?.textContent || '').trim();

            // Check if card has "Easily apply" badge vs external apply indicators
            const textContent = (el.textContent || '').toLowerCase();
            const hasExternal = selectors.CARD_EXTERNAL_INDICATORS.some(ind => textContent.includes(ind));
            const hasEasyApply =
              !hasExternal &&
              (selectors.EASILY_APPLY_BADGE.some(b => !!el.querySelector(b)) ||
                textContent.includes('easily apply') ||
                textContent.includes('apply with your indeed resume'));

            // Extract job snippet
            const snippetEl = el.querySelector(
              '.job-snippet, [data-testid="job-snippet"], [class*="job-snippet" i], .underShelfFooter, ul.css-1y5l8r, table.jobCard_mainContent',
            );
            const snippet = (snippetEl?.textContent || '').trim().replace(/\s+/g, ' ');

            const origin = window.location.origin || 'https://in.indeed.com';
            let fullUrl = '';
            if (jk) {
              fullUrl = `${origin}/viewjob?jk=${jk}`;
            } else if (linkEl?.href && linkEl.href.startsWith('http')) {
              fullUrl = linkEl.href;
            } else if (linkEl?.getAttribute('href')) {
              try {
                fullUrl = new URL(linkEl.getAttribute('href')!, origin).href;
              } catch {
                // Intentionally silent: href may be relative or javascript: URI; fallback URL is assigned below
              }
            }
            if (!fullUrl && jk) {
              fullUrl = `https://www.indeed.com/viewjob?jk=${jk}`;
            }
            if (!fullUrl.startsWith('http')) {
              fullUrl = `${origin}/jobs?q=${encodeURIComponent(title)}`;
            }

            results.push({
              jobId: jk || String(Math.abs(hashString(title + company))),
              title,
              company,
              url: fullUrl,
              location,
              salary,
              isQuickApply: hasEasyApply,
              isExternal: hasExternal,
              descriptionSnippet: snippet,
            });
          } catch {
            // Intentionally silent: skip non-standard job card element in DOM feed
          }
        }

        function hashString(s: string): number {
          let hash = 0;
          for (let i = 0; i < s.length; i++) {
            hash = (hash << 5) - hash + s.charCodeAt(i);
            hash |= 0;
          }
          return hash;
        }

        return results;
      }, INDEED_SELECTORS);

      const seen = new Set<string>();
      return rawJobs
        .filter(j => {
          const key = j.jobId || j.url;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(j => ({
          ...j,
          platform: 'indeed' as const,
        }));
    } catch (err) {
      logger.error('[IndeedAdapter] Failed to extract job cards:', err);
      return [];
    }
  }

  public async applyToJob(job: IJobQueueItem, context: IPlatformExecutionContext): Promise<IApplicationResult> {
    const { page, careerBrain, portToSend, onLiveActivity } = context;
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) {
      return { status: 'failed', reason: 'Browser page instance unavailable' };
    }

    if (portToSend) {
      try {
        portToSend.postMessage({
          type: 'LINKEDIN_STATUS_UPDATE',
          text: `💼 [Indeed] Navigating to "${job.title}" at ${job.company}...`,
          status: 'info',
        });
      } catch {
        // Intentionally silent: port may be closed or disconnected
      }
    }

    // Auto-accept any browser dialogs (e.g. "Leave site? Changes you made may not be saved")
    const dialogHandler = async (dialog: Dialog) => {
      try {
        logger.info(`[IndeedAdapter] Auto-accepting dialog: ${dialog.message()}`);
        await dialog.accept();
      } catch {
        // Intentionally silent: dialog may already have been dismissed by browser
      }
    };
    puppeteerPage.on('dialog', dialogHandler);

    let activeTabId: number = page.tabId;

    const handleCaptchaDetected = async (jobTitle: string): Promise<IApplicationResult> => {
      const captchaMsg =
        "Indeed requested additional verification — pausing Indeed auto-apply for today to protect your account. You can solve it manually by opening Indeed directly if you'd like to continue browsing there.";
      logger.warning(
        `[IndeedAdapter] Cloudflare / Bot Challenge detected on "${jobTitle}". Halting application immediately to protect account.`,
      );

      // Defense-in-depth: pause platform for today in storage directly
      await queueSafetyStore
        .pausePlatformForToday('indeed', 'Indeed requested additional verification')
        .catch(() => {});

      if (onLiveActivity) {
        onLiveActivity({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'failed',
          reason: captchaMsg,
          creditsUsed: 0,
        });
      }

      return {
        status: 'failed',
        reason: 'Indeed Captcha/Bot Challenge detected',
      };
    };

    if (context.signal?.aborted) {
      return { status: 'skipped', reason: 'Application stopped by user' };
    }

    try {
      // Clean up any stray smartapply popup tabs from previous runs
      try {
        const existingTabs = await chrome.tabs.query({});
        for (const t of existingTabs) {
          if (t.id && t.id !== page.tabId && (t.url || '').toLowerCase().includes('smartapply')) {
            await chrome.tabs.remove(t.id).catch(err => {
              logger.debug('[IndeedAdapter] Non-critical error cleaning old smartapply tab:', err);
            });
          }
        }
      } catch (cleanErr) {
        logger.debug('[IndeedAdapter] Non-critical error querying tabs for cleanup:', cleanErr);
      }

      logger.info(`[IndeedAdapter] Navigating to Indeed job: ${job.title} (${job.url})`);

      // 1. Sanitize & ensure absolute URL
      const currentOrigin = puppeteerPage.url().includes('in.indeed.com')
        ? 'https://in.indeed.com'
        : 'https://www.indeed.com';

      let targetUrl = (job.url || '').trim();
      // If valid Indeed job key is present, canonical viewjob URL is the most reliable and avoid redirect aborts
      if (job.jobId && /^[a-zA-Z0-9_-]+$/.test(job.jobId) && job.jobId.length >= 8) {
        targetUrl = `${currentOrigin}/viewjob?jk=${job.jobId}`;
      } else if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        if (targetUrl.startsWith('/')) {
          targetUrl = `${currentOrigin}${targetUrl}`;
        } else {
          try {
            targetUrl = new URL(targetUrl, currentOrigin).href;
          } catch {
            targetUrl = `${currentOrigin}/jobs?q=${encodeURIComponent(job.title)}`;
          }
        }
      }

      // Disable beforeunload on current page to prevent navigation hangs
      await chrome.scripting
        .executeScript({
          target: { tabId: page.tabId, allFrames: true },
          func: () => {
            window.onbeforeunload = null;
            window.addEventListener(
              'beforeunload',
              e => {
                e.preventDefault();
                (e as BeforeUnloadEvent).returnValue = '';
              },
              { capture: true },
            );
          },
        })
        .catch(err => {
          logger.debug('[IndeedAdapter] Non-critical beforeunload override error:', err);
        });

      // 1. Navigate to job URL if not already there or if stuck in smartapply
      const currentUrl = puppeteerPage.url().toLowerCase();
      if (!currentUrl.includes(job.jobId) || currentUrl.includes('smartapply')) {
        let navSuccess = false;
        let lastNavError: unknown = null;

        for (let navAttempt = 1; navAttempt <= 2; navAttempt++) {
          if (context.signal?.aborted) {
            return { status: 'skipped', reason: 'Application stopped by user' };
          }
          try {
            await page.navigateTo(targetUrl);
            navSuccess = true;
            break;
          } catch (navErr: unknown) {
            lastNavError = navErr;
            const navErrMsg = navErr instanceof Error ? navErr.message : String(navErr);
            if (
              context.signal?.aborted ||
              navErrMsg.includes('No tab with given id') ||
              navErrMsg.includes('Target closed') ||
              navErrMsg.includes('Session closed')
            ) {
              return { status: 'skipped', reason: 'Application stopped by user' };
            }

            // Check if page already landed on the job or viewjob despite net::ERR_ABORTED
            const pageUrl = puppeteerPage.url().toLowerCase();
            if (job.jobId && pageUrl.includes(job.jobId)) {
              navSuccess = true;
              break;
            }

            logger.warning(
              `[IndeedAdapter] Navigation attempt ${navAttempt} via page.navigateTo failed (${navErrMsg}), attempting fallback direct goto...`,
            );
            try {
              await puppeteerPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              navSuccess = true;
              break;
            } catch (gotoErr: unknown) {
              lastNavError = gotoErr;
              const gotoErrMsg = gotoErr instanceof Error ? gotoErr.message : String(gotoErr);
              if (
                context.signal?.aborted ||
                gotoErrMsg.includes('No tab with given id') ||
                gotoErrMsg.includes('Target closed') ||
                gotoErrMsg.includes('Session closed')
              ) {
                return { status: 'skipped', reason: 'Application stopped by user' };
              }
              const pageUrlAfterGoto = puppeteerPage.url().toLowerCase();
              if (job.jobId && pageUrlAfterGoto.includes(job.jobId)) {
                navSuccess = true;
                break;
              }
              logger.warning(`[IndeedAdapter] Direct goto attempt ${navAttempt} failed (${gotoErrMsg})`);
              if (navAttempt < 2) {
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          }
        }

        if (!navSuccess) {
          if (context.signal?.aborted) {
            return { status: 'skipped', reason: 'Application stopped by user' };
          }
          throw lastNavError || new Error(`Failed to navigate to ${targetUrl}`);
        }
        await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 2500)));
      }

      // Disable beforeunload again after page loads
      await chrome.scripting
        .executeScript({
          target: { tabId: page.tabId, allFrames: true },
          func: () => {
            window.onbeforeunload = null;
          },
        })
        .catch(() => {});

      // 2. Check for Cloudflare / Captcha Challenge on initial navigation
      const hasCaptcha = await this.checkCaptchaPresent(puppeteerPage);
      if (hasCaptcha) {
        return await handleCaptchaDetected(job.title);
      }

      // 3. Check if already applied (using specific badges and action header containers to avoid false positives in job descriptions)
      const alreadyApplied = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        for (const sel of selectors.ALREADY_APPLIED_SELECTORS) {
          const el = document.querySelector(sel);
          if (el) return true;
        }
        const actionHeader = document.querySelector(
          '#jobsearch-ViewJobButtons-container, .jobsearch-JobInfoHeader-actions, #viewJobButtonContainer',
        );
        const headerText = (actionHeader?.textContent || '').toLowerCase();
        return selectors.ALREADY_APPLIED_INDICATORS.some(ind => headerText.includes(ind));
      }, INDEED_SELECTORS);

      if (alreadyApplied) {
        return { status: 'skipped', reason: 'You already applied to this job on Indeed.' };
      }

      // 4. Resilient Multi-Strategy Apply Button Detection & Click (with up to 8s retry for dynamic rendering)
      let applyResult = { found: false, isExternal: false, strategy: '', text: '' };
      for (let retries = 0; retries < 8; retries++) {
        applyResult = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
          function isVisible(el: HTMLElement): boolean {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }

          let btn: HTMLElement | null = null;
          let matchedStrategy = '';

          // Strategy 1: Primary CSS selectors & known testids/IDs
          for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
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
              '#jobsearch-ViewJobButtons-container, .jobsearch-JobInfoHeader-actions, #viewJobButtonContainer, [data-testid="jobsearch-IndeedApplyButton"], [data-testid="viewJob-applyButton"], div[class*="JobInfoHeader-actions" i]',
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

          // Strategy 3: Text content matching on all visible interactive elements
          if (!btn) {
            const interactives = Array.from(
              document.querySelectorAll(
                'button, [role="button"], a.is-primary, a[class*="button" i], a[class*="btn" i], a[class*="apply" i], a[href*="apply" i]',
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
                bText.startsWith('easily apply') ||
                bText.includes('apply on employer') ||
                bText.includes('apply on company')
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
              document.querySelectorAll('[aria-label*="apply" i], [data-testid*="apply" i], [title*="apply" i]'),
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
          const isExternal =
            selectors.EXTERNAL_APPLY_INDICATORS.some(ind => btnTextLower.includes(ind) || ariaLabel.includes(ind)) ||
            (btn.tagName === 'A' &&
              !!(btn as HTMLAnchorElement).href &&
              !(btn as HTMLAnchorElement).href.includes('indeed.com') &&
              !(btn as HTMLAnchorElement).href.includes('smartapply'));

          // Perform robust click directly if not external
          if (!isExternal) {
            btn.scrollIntoView({ behavior: 'instant', block: 'center' });
            btn.focus();
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            btn.click();
          }

          return { found: true, isExternal, strategy: matchedStrategy, text: btnText };
        }, INDEED_SELECTORS);

        if (applyResult.found) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!applyResult.found) {
        // Collect detailed DOM diagnostics for debugging selector drift
        const domDiagnostics = await puppeteerPage
          .evaluate(() => {
            function isVisible(el: HTMLElement): boolean {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }

            const allButtons = Array.from(
              document.querySelectorAll(
                'button, [role="button"], a[class*="button" i], a.is-primary, a[href*="apply" i]',
              ),
            ) as HTMLElement[];
            const sample = allButtons.slice(0, 15).map(b => ({
              tag: b.tagName,
              text: (b.textContent || '').trim().slice(0, 40),
              ariaLabel: b.getAttribute('aria-label') || undefined,
              testId: b.getAttribute('data-testid') || undefined,
              id: b.id || undefined,
              visible: isVisible(b),
              href: (b as HTMLAnchorElement).href ? (b as HTMLAnchorElement).href.slice(0, 60) : undefined,
            }));

            return {
              url: window.location.href,
              title: document.title,
              totalCandidateButtons: allButtons.length,
              buttons: sample,
            };
          })
          .catch(() => null);

        logger.warning(
          `[IndeedAdapter] No active Apply button found for "${job.title}" after 8 retries. DOM Diagnostics: ${JSON.stringify(
            domDiagnostics,
          )}`,
        );

        return { status: 'skipped', reason: 'No active Apply button found.' };
      }

      if (applyResult.isExternal) {
        logger.info(
          `[IndeedAdapter] Detected external application button ("${applyResult.text}" via ${applyResult.strategy}). Skipping with 0 credits.`,
        );
        return { status: 'skipped', reason: 'Requires applying directly on company site.' };
      }

      logger.info(
        `[IndeedAdapter] Successfully detected and clicked Apply button ("${applyResult.text}" via ${applyResult.strategy}).`,
      );

      // Checkpoint 2: Check for Cloudflare / Captcha Challenge immediately after clicking Apply
      if (await this.checkCaptchaPresent(puppeteerPage)) {
        return await handleCaptchaDetected(job.title);
      }

      // Wait up to 10 seconds for the application modal or popup tab to appear
      activeTabId = page.tabId;
      for (let waitSec = 0; waitSec < 10; waitSec++) {
        await new Promise(r => setTimeout(r, 1000));

        // Checkpoint 3: Check for Cloudflare / Captcha Challenge during modal/tab detection
        if (
          (await this.checkCaptchaPresent(puppeteerPage)) ||
          (activeTabId !== page.tabId && (await this.checkCaptchaPresentOnTab(activeTabId)))
        ) {
          return await handleCaptchaDetected(job.title);
        }

        // 1. Check if a new tab or window opened for smartapply
        try {
          const allTabs = await chrome.tabs.query({});
          const smartTab = allTabs.find(t => {
            const u = (t.url || '').toLowerCase();
            return u.includes('smartapply') || u.includes('indeedapply');
          });
          if (smartTab?.id) {
            activeTabId = smartTab.id;
            logger.info(`[IndeedAdapter] Found smartapply in tab ${activeTabId} (url: ${smartTab.url})`);
            if (await this.checkCaptchaPresentOnTab(activeTabId)) {
              return await handleCaptchaDetected(job.title);
            }
            break;
          }
        } catch (tabErr) {
          logger.debug('[IndeedAdapter] Non-critical error checking smartapply tab:', tabErr);
        }

        // 2. Check if current page has indeedapply iframe or modal or action buttons
        const checkModal = await chrome.scripting
          .executeScript({
            target: { tabId: page.tabId, allFrames: true },
            func: () => {
              const u = window.location.href.toLowerCase();
              if (u.includes('smartapply') || u.includes('indeedapply')) return true;
              if (
                document.querySelector(
                  'div.ia-BasePage, #indeedapply-modal, iframe[id*="indeedapply" i], iframe[src*="smartapply" i], iframe[name*="indeedapply" i]',
                )
              ) {
                return true;
              }
              const btns = Array.from(document.querySelectorAll('button, [role="button"], a.is-primary'));
              return btns.some(b => {
                const t = (b.textContent || '').trim().toLowerCase();
                return (
                  t === 'continue' ||
                  t === 'next' ||
                  t.includes('review your application') ||
                  t.includes('submit your application') ||
                  t === 'save and continue'
                );
              });
            },
          })
          .catch(() => []);

        if (checkModal.some(r => r.result === true)) {
          logger.info(`[IndeedAdapter] Application container or buttons detected on page tab ${page.tabId}`);
          activeTabId = page.tabId;
          break;
        }
      }

      // Check if clicking Apply button opened an external website tab (e.g. Workday, Greenhouse, Lever)
      try {
        const allTabs = await chrome.tabs.query({});
        const externalTab = allTabs.find(
          t =>
            t.id &&
            t.id !== page.tabId &&
            !(t.url || '').toLowerCase().includes('indeed.com') &&
            !(t.url || '').toLowerCase().includes('smartapply'),
        );
        if (externalTab?.id) {
          logger.info(
            `[IndeedAdapter] External application tab opened (${externalTab.url}). Closing tab and skipping job.`,
          );
          await chrome.tabs.remove(externalTab.id).catch(tabErr => {
            logger.debug('[IndeedAdapter] Non-critical error removing external tab:', tabErr);
          });
          return {
            status: 'skipped',
            reason: 'Job requires external application on employer website.',
          };
        }
      } catch (extTabErr) {
        logger.debug('[IndeedAdapter] Non-critical error checking external tab:', extTabErr);
      }

      // Check if current tab was redirected away from Indeed
      const currentTabUrl = puppeteerPage.url().toLowerCase();
      if (!currentTabUrl.includes('indeed.com') && !currentTabUrl.includes('smartapply')) {
        logger.info(`[IndeedAdapter] Main tab redirected to external site (${currentTabUrl}). Skipping.`);
        return {
          status: 'skipped',
          reason: 'Redirected to external company website.',
        };
      }

      // 6. Multi-Step Flow (up to 15 steps) using chrome.scripting across all frames
      const maxSteps = 15;
      let applicationSubmitted = false;
      let previousStepFingerprint = '';
      let consecutiveSameStepCount = 0;

      // Helper to check for submission success across frames and tabs
      const checkSuccessAcrossTabs = async (): Promise<boolean> => {
        const isDoneResults = await chrome.scripting
          .executeScript({
            target: { tabId: activeTabId, allFrames: true },
            func: (selectors: typeof INDEED_SELECTORS) => {
              const url = window.location.href.toLowerCase();
              if (
                url.includes('/postapply') ||
                url.includes('/post-apply') ||
                url.includes('/applied') ||
                url.includes('indeedapply/postapply') ||
                url.includes('smartapply/postapply')
              ) {
                return true;
              }
              const bodyText = (document.body?.innerText || '').toLowerCase();
              if (selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind))) return true;
              if (selectors.SUCCESS_SELECTORS?.some(sel => !!document.querySelector(sel))) return true;
              return false;
            },
            args: [INDEED_SELECTORS],
          })
          .catch(() => []);

        if (isDoneResults.some(r => r.result === true)) return true;

        if (page.tabId && page.tabId !== activeTabId) {
          const parentDoneResults = await chrome.scripting
            .executeScript({
              target: { tabId: page.tabId, allFrames: true },
              func: (selectors: typeof INDEED_SELECTORS) => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                if (selectors.ALREADY_APPLIED_INDICATORS.some(ind => bodyText.includes(ind))) return true;
                if (document.querySelector('div.ia-AppliedBadge, button[disabled*="applied" i]')) return true;
                return false;
              },
              args: [INDEED_SELECTORS],
            })
            .catch(() => []);
          if (parentDoneResults.some(r => r.result === true)) return true;
        }

        return false;
      };

      for (let step = 1; step <= maxSteps; step++) {
        if (context.signal?.aborted) {
          return { status: 'skipped', reason: 'Application stopped by user' };
        }

        // Checkpoint 4: Check for Cloudflare / Captcha Challenge at the start of each step transition
        if (
          (await this.checkCaptchaPresentOnTab(activeTabId)) ||
          (page.tabId && page.tabId !== activeTabId && (await this.checkCaptchaPresentOnTab(page.tabId)))
        ) {
          return await handleCaptchaDetected(job.title);
        }

        logger.info(`[IndeedAdapter] Handling application step ${step} on tab ${activeTabId}...`);

        // Check if application is already submitted in ANY frame or tab
        if (await checkSuccessAcrossTabs()) {
          logger.info('[IndeedAdapter] Successfully submitted Indeed application (confirmed via success indicator)!');
          applicationSubmitted = true;
          break;
        }

        // Detect stuck step (e.g. clicking continue but page does not advance)
        const stepFingerprints = await chrome.scripting
          .executeScript({
            target: { tabId: activeTabId, allFrames: true },
            func: () => {
              const heading = (
                document.querySelector('h1, h2, h3, [class*="heading" i], [class*="title" i]')?.textContent || ''
              ).trim();
              const inputNames = Array.from(document.querySelectorAll('input, select, textarea'))
                .map(i => i.getAttribute('name') || i.id || i.getAttribute('placeholder') || '')
                .filter(Boolean)
                .slice(0, 8)
                .join(',');
              return `${heading}::${inputNames}`;
            },
          })
          .catch(() => []);

        const currentFingerprint = stepFingerprints
          .map(r => r.result)
          .filter(Boolean)
          .join(' | ');
        if (currentFingerprint && currentFingerprint === previousStepFingerprint) {
          consecutiveSameStepCount++;
          logger.warning(
            `[IndeedAdapter] Step ${step}: Same step detected (${consecutiveSameStepCount} consecutive times: "${currentFingerprint.slice(0, 60)}")`,
          );
          if (consecutiveSameStepCount >= 2) {
            logger.info(`[IndeedAdapter] Step ${step}: Attempting auto-heal for unfulfilled fields on stuck step...`);
            await this.autoHealValidationErrors(activeTabId, careerBrain, context.scopedLLM);
            await new Promise(r => setTimeout(r, 600));
          }
          if (consecutiveSameStepCount >= 3) {
            logger.error(`[IndeedAdapter] Step ${step}: Step failed to advance 3 times consecutively. Aborting.`);
            return {
              status: 'failed',
              reason: `Application incomplete: stuck at step "${currentFingerprint.split('::')[0] || step}" (required fields or validation preventing advance)`,
            };
          }
        } else {
          consecutiveSameStepCount = 0;
          previousStepFingerprint = currentFingerprint;
        }

        // Fill any visible questions/inputs on this step across all frames
        await this.fillIndeedStepFields(activeTabId, careerBrain, context.scopedLLM);
        await new Promise(r => setTimeout(r, 600));

        // Find and click action button (Submit OR Forward) across all frames
        let buttonClicked = false;
        let isSubmitAction = false;
        let clickedButtonText = '';

        for (let clickAttempt = 0; clickAttempt < 6; clickAttempt++) {
          const actionResults = await chrome.scripting
            .executeScript({
              target: { tabId: activeTabId, allFrames: true },
              func: (selectors: typeof INDEED_SELECTORS) => {
                function isElementVisible(el: HTMLElement): boolean {
                  if (!el) return false;
                  const style = window.getComputedStyle(el);
                  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                }

                function isElementEnabled(el: HTMLElement): boolean {
                  if ('disabled' in el && (el as HTMLInputElement | HTMLButtonElement).disabled) return false;
                  if (el.getAttribute('aria-disabled') === 'true') return false;
                  return true;
                }

                function triggerClick(el: HTMLElement) {
                  el.scrollIntoView({ behavior: 'instant', block: 'center' });
                  el.focus();
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                  el.click();
                }

                // Check for loading spinner
                const spinner = document.querySelector('svg.ia-LoadingSpinner, svg[aria-label="Loading"], .is-loading');
                if (spinner && isElementVisible(spinner as HTMLElement)) {
                  return { clicked: false, isSubmit: false, loading: true, text: 'loading_spinner', diag: [] };
                }

                const allButtons = Array.from(
                  document.querySelectorAll(
                    'button, [role="button"], a.is-primary, input[type="button"], input[type="submit"]',
                  ),
                ) as HTMLElement[];

                const visibleButtons = allButtons.filter(b => isElementVisible(b) && isElementEnabled(b));

                // 1. SUBMIT DETECTION (Priority 1)
                for (const sel of selectors.SUBMIT_BUTTON_SELECTORS) {
                  const btn = document.querySelector(sel) as HTMLElement | null;
                  if (btn && isElementVisible(btn) && isElementEnabled(btn)) {
                    const txt = (btn.textContent || (btn as HTMLInputElement).value || '').trim();
                    triggerClick(btn);
                    return { clicked: true, isSubmit: true, loading: false, text: txt || 'Submit Selector', diag: [] };
                  }
                }

                const headingText = (
                  document.querySelector('h1, h2, h3, [class*="heading" i]')?.textContent || ''
                ).toLowerCase();
                const isReviewStep = headingText.includes('review');

                for (const b of visibleButtons) {
                  const t = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
                  const testId = (b.getAttribute('data-testid') || '').toLowerCase();
                  const ariaLabel = (b.getAttribute('aria-label') || '').toLowerCase();
                  const className = (b.className || '').toLowerCase();

                  const isExplicitSubmit =
                    testId === 'submit-button' ||
                    testId.includes('submit') ||
                    className.includes('submitbutton') ||
                    className.includes('submit-button') ||
                    ariaLabel.includes('submit') ||
                    t.includes('submit your application') ||
                    t.includes('submit application') ||
                    t.includes('submit my application') ||
                    t.includes('submit to employer') ||
                    t === 'submit' ||
                    t.startsWith('submit');

                  const isReviewSubmit =
                    isReviewStep && (t.includes('apply') || t.includes('finish') || t.includes('complete application'));

                  if (isExplicitSubmit || isReviewSubmit) {
                    triggerClick(b);
                    return { clicked: true, isSubmit: true, loading: false, text: t || 'Submit Button', diag: [] };
                  }
                }

                // 2. FORWARD / CONTINUE DETECTION (Priority 2)
                for (const sel of selectors.FORWARD_BUTTON_SELECTORS) {
                  const btn = document.querySelector(sel) as HTMLElement | null;
                  if (btn && isElementVisible(btn) && isElementEnabled(btn)) {
                    const txt = (btn.textContent || (btn as HTMLInputElement).value || '').trim().toLowerCase();
                    const isSub = txt.includes('submit');
                    triggerClick(btn);
                    return {
                      clicked: true,
                      isSubmit: isSub,
                      loading: false,
                      text: txt || 'Forward Selector',
                      diag: [],
                    };
                  }
                }

                for (const b of visibleButtons) {
                  const t = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
                  if (!t) continue;

                  const isMatch =
                    t === 'continue' ||
                    t.startsWith('continue') ||
                    t.includes('continue') ||
                    t === 'next' ||
                    t.includes('next') ||
                    t.includes('review your application') ||
                    t.includes('review application') ||
                    t.includes('save and continue') ||
                    t.includes('save & continue') ||
                    t === 'save' ||
                    b.getAttribute('data-testid') === 'continue-button' ||
                    b.getAttribute('data-testid') === 'save-button' ||
                    b.getAttribute('aria-label')?.toLowerCase().includes('continue');

                  if (isMatch) {
                    triggerClick(b);
                    return { clicked: true, isSubmit: false, loading: false, text: t, diag: [] };
                  }
                }

                // 3. Fallback: Check for "Skip" button (e.g. optional Review work experience)
                for (const b of visibleButtons) {
                  const t = (b.textContent || '').trim().toLowerCase();
                  if (t === 'skip' || t.startsWith('skip')) {
                    triggerClick(b);
                    return { clicked: true, isSubmit: false, loading: false, text: 'Skip (optional step)', diag: [] };
                  }
                }

                const diag = visibleButtons.map(b => ({
                  tag: b.tagName,
                  text: (b.textContent || '').trim().slice(0, 30),
                  disabled: !isElementEnabled(b),
                  testId: b.getAttribute('data-testid') || '',
                }));

                return { clicked: false, isSubmit: false, loading: false, text: '', diag };
              },
              args: [INDEED_SELECTORS],
            })
            .catch(() => []);

          const hit = actionResults.find(r => r.result?.clicked === true);
          if (hit && hit.result) {
            buttonClicked = true;
            clickedButtonText = hit.result.text || '';
            isSubmitAction = hit.result.isSubmit || clickedButtonText.toLowerCase().includes('submit');
            break;
          }

          const isLoading = actionResults.some(r => r.result?.loading === true);
          if (isLoading) {
            logger.info(`[IndeedAdapter] Step ${step}: Button in loading state, waiting...`);
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }

          if (clickAttempt === 5) {
            for (const r of actionResults) {
              if (r.result?.diag?.length) {
                logger.info(
                  `[IndeedAdapter] Step ${step} Frame ${r.frameId} visible buttons: ${JSON.stringify(r.result.diag)}`,
                );
              }
            }
          }

          await new Promise(r => setTimeout(r, 1200));
        }

        // Handle Submit Button Click
        if (buttonClicked && isSubmitAction) {
          logger.info(
            `[IndeedAdapter] Clicked Submit button ("${clickedButtonText}"). Waiting for submission confirmation...`,
          );
          let confirmed = false;
          for (let poll = 0; poll < 8; poll++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await checkSuccessAcrossTabs()) {
              logger.info('[IndeedAdapter] Application submission confirmed!');
              confirmed = true;
              break;
            }
          }

          if (confirmed) {
            applicationSubmitted = true;
            break;
          }

          // Check if submit button is gone and no error appeared
          const stillHasSubmit = await chrome.scripting
            .executeScript({
              target: { tabId: activeTabId, allFrames: true },
              func: () => {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                return btns.some(b => (b.textContent || '').toLowerCase().includes('submit your application'));
              },
            })
            .catch(() => []);

          if (!stillHasSubmit.some(r => r.result === true)) {
            logger.info('[IndeedAdapter] Final submit button was clicked and processed (button no longer present).');
            applicationSubmitted = true;
            break;
          }

          logger.warning(
            '[IndeedAdapter] Submit button still visible after click. Attempting to heal validation errors...',
          );
          await this.autoHealValidationErrors(activeTabId, careerBrain, context.scopedLLM);
          continue;
        }

        // Handle No Action Button Found
        if (!buttonClicked) {
          // Check if already completed
          if (await checkSuccessAcrossTabs()) {
            applicationSubmitted = true;
            break;
          }

          // Try auto-healing validation errors
          const healed = await this.autoHealValidationErrors(activeTabId, careerBrain, context.scopedLLM);
          if (healed) {
            logger.info(`[IndeedAdapter] Healed validation errors before failure check. Re-trying step ${step}...`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          logger.warning(`[IndeedAdapter] No forward or submit button found at step ${step}.`);
          if (step === 1) {
            return {
              status: 'skipped',
              reason: 'No Indeed Easy Apply modal found (external or unsupported application format)',
            };
          }
          return {
            status: 'failed',
            reason: `Application incomplete: reached step ${step} without finding Next/Submit button`,
          };
        }

        // Forward Button Clicked (Continue / Next / Review)
        logger.info(`[IndeedAdapter] Clicked "${clickedButtonText}" for step ${step}. Waiting for next step...`);
        await new Promise(r => setTimeout(r, 2000));

        // Check if a red validation error appeared (e.g. "Choose an option to continue" / consent error)
        const healedAfterClick = await this.autoHealValidationErrors(activeTabId, careerBrain, context.scopedLLM);
        if (healedAfterClick) {
          logger.info(`[IndeedAdapter] Step ${step}: Validation error healed! Re-triggering forward button...`);
          await new Promise(r => setTimeout(r, 600));
          await chrome.scripting
            .executeScript({
              target: { tabId: activeTabId, allFrames: true },
              func: () => {
                const btns = Array.from(
                  document.querySelectorAll('button, [role="button"], a.is-primary'),
                ) as HTMLElement[];
                for (const b of btns) {
                  const t = (
                    b.textContent ||
                    ('value' in b ? (b as HTMLButtonElement | HTMLInputElement).value : '') ||
                    ''
                  )
                    .trim()
                    .toLowerCase();
                  if (
                    t === 'continue' ||
                    t.startsWith('continue') ||
                    t === 'next' ||
                    t.includes('review') ||
                    t === 'save and continue'
                  ) {
                    b.scrollIntoView({ behavior: 'instant', block: 'center' });
                    b.focus();
                    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    b.click();
                    return true;
                  }
                }
                return false;
              },
            })
            .catch(() => []);
          await new Promise(r => setTimeout(r, 2500));
        } else {
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      if (applicationSubmitted) {
        return { status: 'applied', creditsUsed: 1 };
      }

      return {
        status: 'failed',
        reason: 'Indeed Apply reached step limit without final submission confirmation',
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        context.signal?.aborted ||
        errMsg.includes('No tab with given id') ||
        errMsg.includes('Target closed') ||
        errMsg.includes('Session closed') ||
        errMsg.includes('Execution context was destroyed') ||
        errMsg.includes('net::ERR_ABORTED')
      ) {
        logger.info(`[IndeedAdapter] Job run stopped cleanly during execution (${errMsg}).`);
        return { status: 'skipped', reason: 'Application stopped by user' };
      }
      logger.error('[IndeedAdapter] Error applying to Indeed job:', err);
      return { status: 'failed', reason: errMsg || 'Application error' };
    } finally {
      await chrome.scripting
        .executeScript({
          target: { tabId: page.tabId, allFrames: true },
          func: () => {
            window.onbeforeunload = null;
          },
        })
        .catch(unloadErr => {
          logger.debug('[IndeedAdapter] Resetting beforeunload in finally non-critical error:', unloadErr);
        });

      puppeteerPage.off('dialog', dialogHandler);

      if (activeTabId && activeTabId !== page.tabId) {
        try {
          await chrome.tabs.remove(activeTabId);
        } catch (tabRemoveErr) {
          logger.debug('[IndeedAdapter] Closing secondary application tab non-critical error:', tabRemoveErr);
        }
      }
    }
  }

  private async fillIndeedStepFields(
    tabId: number,
    careerBrain: ICareerBrain,
    scopedLLM?: BaseChatModel,
  ): Promise<void> {
    try {
      const scanResults = await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            const url = window.location.href.toLowerCase();
            const isApplyContext =
              url.includes('smartapply') ||
              url.includes('indeedapply') ||
              url.includes('apply.indeed') ||
              !!document.querySelector(
                'div.ia-BasePage, div[class*="SmartApply" i], div[class*="ia-" i], div[role="dialog"], #indeedapply-modal, [data-testid*="smartapply" i]',
              ) ||
              document.querySelectorAll('input, select, textarea').length > 0;
            if (!isApplyContext) return [];

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

            return inputs
              .filter(el => isElementVisible(el) && !('disabled' in el && (el as HTMLInputElement).disabled))
              .map((el, idx) => {
                function cleanText(t: string | null | undefined): string {
                  if (!t) return '';
                  const s = t.trim().replace(/\s+/g, ' ');
                  if (/answer these questions|questions from the employer|fields marked with|report the job/i.test(s)) {
                    return '';
                  }
                  return s;
                }

                // 1. Direct ARIA attributes on input element
                const ariaLabel = cleanText(el.getAttribute('aria-label'));
                const labelledById = el.getAttribute('aria-labelledby');
                const ariaLabelledByText = cleanText(
                  labelledById ? document.getElementById(labelledById)?.textContent : '',
                );

                // 2. Associated HTML <label>
                const labelFor = el.id ? cleanText(document.querySelector(`label[for="${el.id}"]`)?.textContent) : '';
                const closestLabel = cleanText(el.closest('label')?.textContent);
                const parentLabel = cleanText(el.parentElement?.querySelector('label')?.textContent);

                // 3. Fieldset legend (for radio/checkbox groups)
                const fieldset = el.closest('fieldset');
                const legend = cleanText(fieldset ? fieldset.querySelector('legend')?.textContent : '');

                // 4. Specific question card wrapper (NEVER whole-page .ia-BasePage-component!)
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

                // 5. Preceding sibling element
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
                let fieldType = 'text';

                // Check for Date field (calendar icon, date type, or date keywords)
                const labelLower = labelText.toLowerCase();
                const hasCalendar =
                  inputType === 'date' ||
                  Boolean(
                    el.parentElement?.querySelector(
                      'svg[aria-label*="calendar" i], [class*="calendar" i], [class*="DatePicker" i], button[aria-label*="calendar" i]',
                    ) ||
                      el
                        .closest('div[class*="Question" i], div[class*="field" i]')
                        ?.querySelector(
                          'svg[aria-label*="calendar" i], [class*="calendar" i], [class*="DatePicker" i]',
                        ),
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
                      const t = (o.textContent || '').trim();
                      if (t && !t.toLowerCase().includes('select') && !options.includes(t)) options.push(t);
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
                        if (t && !t.toLowerCase().includes('select an option') && !options.includes(t)) options.push(t);
                      }
                    }
                  }
                } else if (fieldType === 'radio') {
                  const container = questionCard || el.parentElement;
                  const groupName = el.getAttribute('name');
                  const siblings = (
                    groupName
                      ? Array.from(document.querySelectorAll(`input[name="${groupName}"]`))
                      : fieldset
                        ? Array.from(fieldset.querySelectorAll('input[type="radio"], [role="radio"]'))
                        : container
                          ? Array.from(container.querySelectorAll('input[type="radio"], [role="radio"]'))
                          : []
                  ) as HTMLInputElement[];
                  for (const sib of siblings) {
                    const sibText = (sib.closest('label')?.textContent || sib.value || '').trim();
                    if (sibText && !options.includes(sibText)) options.push(sibText);
                  }
                } else if (fieldType === 'checkbox') {
                  const container = questionCard || el.parentElement;
                  const groupName = el.getAttribute('name');
                  const siblings = (
                    groupName
                      ? Array.from(document.querySelectorAll(`input[name="${groupName}"]`))
                      : fieldset
                        ? Array.from(fieldset.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
                        : container
                          ? Array.from(container.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
                          : []
                  ) as HTMLInputElement[];
                  for (const sib of siblings) {
                    const sibText = (sib.closest('label')?.textContent || sib.value || '').trim();
                    if (sibText && !options.includes(sibText)) options.push(sibText);
                  }
                }

                return {
                  index: idx,
                  labelText,
                  fieldType,
                  options,
                };
              });
          },
        })
        .catch(() => []);

      for (const frameResult of scanResults) {
        const frameId = frameResult.frameId;
        const fields = frameResult.result || [];
        if (!fields.length) continue;

        for (const f of fields) {
          if (!f.labelText) continue;
          const mappedFieldType = (
            ['text', 'number', 'radio', 'dropdown', 'select', 'checkbox', 'date'].includes(f.fieldType)
              ? f.fieldType
              : 'text'
          ) as 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date';
          let answer = resolveIndeedQuestion(f.labelText, mappedFieldType, f.options, careerBrain);

          // If the question is outside simple static contact/consent fields, or presents multiple-choice options,
          // ALWAYS ask the autonomous LLM to make the optimal, qualifying determination!
          const labelLo = f.labelText.toLowerCase();

          // Conditional "If yes..." follow-up fields:
          const isConditionalIfYes =
            /^(?:if\s+(?:yes|so|applicable|checked|other)|if\s+you\s+(?:answered\s+yes|are|have|were))\b/i.test(
              labelLo,
            ) || /\bif\s+yes\b/i.test(labelLo);
          if (isConditionalIfYes) {
            // Never let LLM or rules fill invented dates/text for conditional follow-ups!
            answer = { value: '', confidence: 0.99, source: 'profile' };
          }

          const isBasicIdentityField =
            f.fieldType === 'text' &&
            (labelLo === 'first name' ||
              labelLo === 'last name' ||
              labelLo === 'full name' ||
              labelLo === 'email' ||
              labelLo === 'email address' ||
              labelLo === 'phone' ||
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

          const isDeterministicMatch = answer.confidence >= 0.95;

          const shouldUseLLM =
            scopedLLM &&
            !isConditionalIfYes &&
            !isDeterministicMatch &&
            ((!isBasicIdentityField && !isDirectConsentField) || answer.confidence < 0.9);

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
                {
                  label: f.labelText,
                  fieldType: llmFieldType,
                  options: f.options,
                },
                careerBrain,
                scopedLLM,
              );
              if (llmRes.success && llmRes.answer) {
                answer = { value: llmRes.answer, confidence: 0.99, source: 'profile' };
                logger.info(`[IndeedAdapter] ✅ LLM resolved "${f.labelText}" -> "${answer.value}"`);
              }
            } catch (err) {
              logger.warning(`[IndeedAdapter] LLM field resolution fallback error, using rule answer:`, err);
            }
          }

          // Clean & format the resolved answer value
          if (
            f.fieldType === 'date' ||
            /\b(date\s+of\s+birth|dob|birth\s+date|working\s+day|start\s+date|end\s+date)\b/i.test(labelLo)
          ) {
            // Strict DD/MM/YYYY formatting for Indeed date fields
            const rawVal = (answer.value || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(rawVal)) {
              const [y, m, d] = rawVal.split('-');
              answer.value = `${d}/${m}/${y}`;
            } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawVal)) {
              const parts = rawVal.split('/');
              answer.value = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
            } else if (!/^\d{2}\/\d{2}\/\d{4}$/.test(rawVal)) {
              if (labelLo.includes('birth') || labelLo.includes('dob')) {
                answer.value = '01/01/2000';
              } else {
                const today = new Date();
                answer.value = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
              }
            }
          } else if (/\b(current\s+company|present\s+company|employer|company\s+name)\b/i.test(labelLo)) {
            // Guarantee actual candidate company instead of placeholder
            answer.value =
              careerBrain.workExperience?.[0]?.company ||
              (careerBrain.hasWorkExperience === false ? 'None' : 'Self-Employed');
          } else if (f.fieldType === 'number' || /\b(salary|ctc|compensation)\b/i.test(labelLo)) {
            // Ensure salary or numeric inputs are clean numbers
            const numMatch = (answer.value || '').match(/(\d+[\d,.]*)/);
            if (numMatch) {
              answer.value = numMatch[1].replace(/,/g, '');
            }
          }

          await chrome.scripting
            .executeScript({
              target: { tabId, frameIds: [frameId] },
              func: async (idx: number, val: string, fType: string) => {
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

                async function simulateHumanTyping(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
                  input.focus();
                  input.dispatchEvent(new Event('focus', { bubbles: true }));

                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    input instanceof HTMLTextAreaElement
                      ? window.HTMLTextAreaElement.prototype
                      : window.HTMLInputElement.prototype,
                    'value',
                  )?.set;

                  let current = '';
                  for (let i = 0; i < value.length; i++) {
                    current += value[i];
                    if (nativeInputValueSetter) {
                      nativeInputValueSetter.call(input, current);
                    } else {
                      input.value = current;
                    }
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    // 15-35ms human-like typing jitter
                    await new Promise(r => setTimeout(r, 15 + Math.floor(Math.random() * 20)));
                  }

                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  input.dispatchEvent(new Event('blur', { bubbles: true }));
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
                const el = visibleInputs[idx] as (HTMLElement & HTMLInputElement & HTMLSelectElement) | undefined;
                if (!el) return;

                if (fType === 'select') {
                  if (el.tagName.toLowerCase() === 'select') {
                    el.focus();
                    let matched = false;
                    for (let i = 0; i < el.options.length; i++) {
                      if (
                        el.options[i].text.toLowerCase().includes(val.toLowerCase()) ||
                        el.options[i].value.toLowerCase().includes(val.toLowerCase())
                      ) {
                        el.selectedIndex = i;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        matched = true;
                        break;
                      }
                    }
                    if (!matched && el.options.length > 1 && el.selectedIndex <= 0) {
                      el.selectedIndex = 1;
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                  } else {
                    // Custom Combobox / Listbox trigger button (e.g. Indeed's "Select an option" custom dropdown)
                    el.focus();
                    el.click();

                    await new Promise(r => setTimeout(r, 250));

                    // 1. Check if a search input appeared inside the dropdown (e.g. "Search to select an option")
                    const searchInput = (document.querySelector(
                      'input[placeholder*="search" i], input[placeholder*="select an option" i], input[role="searchbox"]',
                    ) ||
                      el
                        .closest('.ia-BasePage-component, div[class*="field" i]')
                        ?.querySelector('input[type="text"]')) as HTMLInputElement;

                    if (searchInput && isElementVisible(searchInput)) {
                      setReactInputValue(searchInput, val || '');
                      await new Promise(r => setTimeout(r, 150));
                    }

                    // 2. Select matching item from popup listbox / menu
                    const listbox = document.querySelector(
                      '[role="listbox"], ul[class*="list" i], div[class*="menu" i], div[id*="dropdown" i]',
                    );
                    const optionItems = Array.from(
                      (listbox || document).querySelectorAll(
                        '[role="option"], li, button[class*="item" i], div[class*="option" i]',
                      ),
                    ).filter(item => isElementVisible(item as HTMLElement)) as HTMLElement[];

                    const valLo = (val || '').toLowerCase().trim();
                    let matchedItem = optionItems.find(item => {
                      const itemTxt = (item.textContent || '').toLowerCase().trim();
                      if (itemTxt === valLo) return true;
                      if (valLo && itemTxt.includes(valLo)) return true;
                      if (valLo && valLo.includes(itemTxt)) return true;
                      if (
                        valLo.includes('immediate') &&
                        (itemTxt.includes('immediate') || itemTxt.includes('15 days') || itemTxt.includes('serving'))
                      )
                        return true;
                      if (
                        (valLo.includes('bengaluru') || valLo.includes('bangalore')) &&
                        (itemTxt.includes('bengaluru') || itemTxt.includes('bangalore'))
                      )
                        return true;
                      if (valLo.includes('remote') && itemTxt.includes('remote')) return true;
                      return false;
                    });

                    if (!matchedItem && optionItems.length > 0) {
                      matchedItem =
                        optionItems.find(item => {
                          const txt = (item.textContent || '').toLowerCase();
                          return !txt.includes('select an option') && !txt.includes('choose an option');
                        }) || optionItems[0];
                    }

                    if (matchedItem) {
                      matchedItem.focus();
                      matchedItem.click();
                      matchedItem.dispatchEvent(
                        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
                      );
                      matchedItem.dispatchEvent(new Event('change', { bubbles: true }));
                      await new Promise(r => setTimeout(r, 150));
                    }
                  }
                } else if (fType === 'radio') {
                  const rText = (
                    el.closest('label')?.textContent ||
                    el.parentElement?.textContent ||
                    el.getAttribute('aria-label') ||
                    el.value ||
                    ''
                  )
                    .toLowerCase()
                    .trim();
                  const valLo = (val || '').toLowerCase().trim();
                  const isMatch =
                    rText === valLo ||
                    (valLo.length > 0 && rText.includes(valLo)) ||
                    (rText.length > 0 && valLo.includes(rText)) ||
                    (valLo.startsWith('y') && (rText.includes('yes') || (el.value || '').toLowerCase() === 'yes')) ||
                    (valLo.startsWith('n') && (rText.includes('no') || (el.value || '').toLowerCase() === 'no')) ||
                    (valLo.includes('consent') && (rText.includes('consent') || rText.includes('agree'))) ||
                    (el.value || '').toLowerCase() === valLo;

                  if (isMatch) {
                    el.focus();
                    el.click();
                    let nowChecked = el.checked === true || el.getAttribute('aria-checked') === 'true';
                    if (!nowChecked) {
                      const lbl = el.closest('label');
                      if (lbl) {
                        lbl.click();
                        nowChecked = el.checked === true || el.getAttribute('aria-checked') === 'true';
                      }
                    }
                    if (!nowChecked) {
                      el.checked = true;
                      el.setAttribute('aria-checked', 'true');
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }
                } else if (fType === 'checkbox') {
                  const isChecked = el.checked === true || el.getAttribute('aria-checked') === 'true';
                  const valLo = (val || '').toLowerCase().trim();
                  const boxText = (
                    el.closest('label')?.textContent ||
                    el.parentElement?.textContent ||
                    el.getAttribute('aria-label') ||
                    el.value ||
                    ''
                  )
                    .toLowerCase()
                    .trim();

                  // 1. Direct consent / agreement checkbox
                  const isConsentCheck =
                    valLo.startsWith('y') ||
                    valLo === 'true' ||
                    valLo.includes('consent') ||
                    valLo.includes('agree') ||
                    valLo.includes('accept') ||
                    valLo.includes('acknowledge') ||
                    valLo.includes('policy') ||
                    valLo.includes('terms') ||
                    boxText.includes('consent') ||
                    boxText.includes('agree') ||
                    boxText.includes('policy') ||
                    boxText.includes('terms') ||
                    boxText.includes('acknowledge');

                  // 2. Option checkbox (e.g. timezone "EST", location, skill)
                  const isOptionMatch =
                    Boolean(valLo) &&
                    Boolean(boxText) &&
                    (boxText === valLo ||
                      valLo
                        .split(',')
                        .map(s => s.trim())
                        .includes(boxText) ||
                      boxText.includes(valLo) ||
                      valLo.includes(boxText));

                  const shouldCheck = isConsentCheck || isOptionMatch;

                  if (!isChecked && shouldCheck) {
                    el.focus();
                    el.click();

                    let nowChecked = el.checked === true || el.getAttribute('aria-checked') === 'true';
                    if (!nowChecked) {
                      const lbl = el.closest('label');
                      if (lbl) {
                        lbl.click();
                        nowChecked = el.checked === true || el.getAttribute('aria-checked') === 'true';
                      }
                    }

                    if (!nowChecked) {
                      el.checked = true;
                      el.setAttribute('aria-checked', 'true');
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }
                } else {
                  // For text / date / textarea:
                  if (val === '') {
                    const cur = (el.value || '').trim().toLowerCase();
                    if (cur.startsWith('approx') || cur === 'yes' || cur === 'no') {
                      setReactInputValue(el, '');
                    }
                    return;
                  }

                  const isDateField =
                    fType === 'date' ||
                    el.getAttribute('type') === 'date' ||
                    el.getAttribute('placeholder')?.toLowerCase().includes('yyyy') ||
                    /^\d{2}\/\d{2}\/\d{4}$/.test(val);

                  if (isDateField) {
                    el.focus();
                    setReactInputValue(el, val);
                    return;
                  }

                  const curVal = (el.value || '').trim().toLowerCase();
                  if (!curVal || curVal === 'yes' || curVal === 'no') {
                    await simulateHumanTyping(el, val || '');
                  }
                }
              },
              args: [f.index, answer.value, f.fieldType],
            })
            .catch(() => {});

          await new Promise(r => setTimeout(r, 100));
        }
      }

      // Safety pass across all frames: ensure every visible radio group has at least one selection
      await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          func: () => {
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

            // 1. Radio safety pass: ensure every visible radio group has at least one selection
            const radios = (
              Array.from(document.querySelectorAll('input[type="radio"], [role="radio"]')) as HTMLInputElement[]
            ).filter(el => isElementVisible(el) && !el.disabled);

            const radioGroups = new Map<string, HTMLInputElement[]>();
            radios.forEach((r, idx) => {
              const name = r.getAttribute('name') || r.closest('fieldset')?.id || `group_${Math.floor(idx / 4)}`;
              if (!radioGroups.has(name)) radioGroups.set(name, []);
              radioGroups.get(name)!.push(r);
            });

            for (const groupRadios of radioGroups.values()) {
              const anyChecked = groupRadios.some(r => r.checked || r.getAttribute('aria-checked') === 'true');
              if (!anyChecked && groupRadios.length > 0) {
                const preferred =
                  groupRadios.find(r => {
                    const txt = (r.closest('label')?.textContent || r.value || '').toLowerCase();
                    return txt.startsWith('yes') || txt.includes('consent') || txt.includes('agree');
                  }) || groupRadios[0];

                try {
                  preferred.focus();
                  preferred.click();
                  let nowChecked = preferred.checked || preferred.getAttribute('aria-checked') === 'true';
                  if (!nowChecked) {
                    const lbl = preferred.closest('label');
                    if (lbl) {
                      lbl.click();
                      nowChecked = preferred.checked || preferred.getAttribute('aria-checked') === 'true';
                    }
                  }
                  if (!nowChecked) {
                    preferred.checked = true;
                    preferred.setAttribute('aria-checked', 'true');
                    preferred.dispatchEvent(new Event('input', { bubbles: true }));
                    preferred.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                } catch {
                  // Intentionally silent in DOM script: radio button focus/click fallback
                }
              }
            }

            // 2. Checkbox safety pass: ensure required checkbox groups have at least one selection (e.g. timezone EST, CST...)
            const checkboxes = (
              Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) as HTMLInputElement[]
            ).filter(el => isElementVisible(el) && !el.disabled);

            const checkboxGroups = new Map<string, HTMLInputElement[]>();
            checkboxes.forEach((cb, idx) => {
              const container =
                cb.closest('fieldset, .ia-BasePage-component, div[class*="field" i], div[class*="question" i]') ||
                cb.parentElement;
              const groupKey = container?.id || cb.getAttribute('name') || `cb_group_${Math.floor(idx / 4)}`;
              if (!checkboxGroups.has(groupKey)) checkboxGroups.set(groupKey, []);
              checkboxGroups.get(groupKey)!.push(cb);
            });

            for (const groupCbs of checkboxGroups.values()) {
              const anyChecked = groupCbs.some(c => c.checked || c.getAttribute('aria-checked') === 'true');
              if (!anyChecked && groupCbs.length > 0) {
                const container = groupCbs[0].closest(
                  'fieldset, .ia-BasePage-component, div[class*="field" i], div[class*="question" i]',
                );
                const containerText = (container?.textContent || '').toLowerCase();
                const isRequired =
                  containerText.includes('*') ||
                  containerText.includes('required') ||
                  containerText.includes('choose an option');

                if (isRequired) {
                  const preferred =
                    groupCbs.find(c => {
                      const txt = (c.closest('label')?.textContent || c.value || '').toLowerCase();
                      return (
                        txt.includes('est') ||
                        txt.includes('eastern') ||
                        txt.startsWith('yes') ||
                        txt.includes('consent') ||
                        txt.includes('agree')
                      );
                    }) || groupCbs[0];

                  try {
                    preferred.focus();
                    preferred.click();
                    let nowChecked =
                      (preferred as HTMLInputElement).checked || preferred.getAttribute('aria-checked') === 'true';
                    if (!nowChecked) {
                      const lbl = preferred.closest('label');
                      if (lbl) {
                        lbl.click();
                        nowChecked =
                          (preferred as HTMLInputElement).checked || preferred.getAttribute('aria-checked') === 'true';
                      }
                    }
                    if (!nowChecked) {
                      (preferred as HTMLInputElement).checked = true;
                      preferred.setAttribute('aria-checked', 'true');
                      preferred.dispatchEvent(new Event('input', { bubbles: true }));
                      preferred.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  } catch {
                    // Intentionally silent in DOM script: checkbox focus/click fallback
                  }
                }
              }
            }

            // 3. Consent Checkbox Guarantee: any visible unchecked checkbox with "consent", "agree", "policy", "terms"
            // MUST be checked before advancing, as applications cannot proceed without employer consent!
            for (const cb of checkboxes) {
              const isChecked = (cb as HTMLInputElement).checked || cb.getAttribute('aria-checked') === 'true';
              if (!isChecked) {
                const container =
                  cb.closest(
                    'fieldset, .ia-BasePage-component, div[class*="field" i], div[class*="question" i], label',
                  ) || cb.parentElement;
                const txt = (container?.textContent || cb.getAttribute('aria-label') || '').toLowerCase();
                const isConsent =
                  txt.includes('consent') ||
                  txt.includes('agree') ||
                  txt.includes('policy') ||
                  txt.includes('terms') ||
                  txt.includes('acknowledge');

                if (isConsent) {
                  try {
                    cb.focus();
                    cb.click();
                    let nowChecked = (cb as HTMLInputElement).checked || cb.getAttribute('aria-checked') === 'true';
                    if (!nowChecked) {
                      const lbl = cb.closest('label');
                      if (lbl) {
                        lbl.click();
                        nowChecked = (cb as HTMLInputElement).checked || cb.getAttribute('aria-checked') === 'true';
                      }
                    }
                    if (!nowChecked) {
                      (cb as HTMLInputElement).checked = true;
                      cb.setAttribute('aria-checked', 'true');
                      cb.dispatchEvent(new Event('input', { bubbles: true }));
                      cb.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  } catch {
                    // Intentionally silent in DOM script: consent checkbox fallback
                  }
                }
              }
            }

            // 4. Dropdown safety pass: check for any required custom dropdown button still displaying "Select an option" / "Choose an option"
            // or native select still at selectedIndex <= 0
            const nativeSelects = (Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]).filter(
              el => isElementVisible(el) && !el.disabled,
            );
            for (const sel of nativeSelects) {
              if (sel.selectedIndex <= 0 && sel.options.length > 1) {
                try {
                  sel.selectedIndex = 1;
                  sel.dispatchEvent(new Event('change', { bubbles: true }));
                  sel.dispatchEvent(new Event('blur', { bubbles: true }));
                } catch {
                  // Intentionally silent in DOM script: native select option change fallback
                }
              }
            }

            const unselectedButtons = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).filter(
              b => {
                if (!isElementVisible(b) || b.disabled) return false;
                const txt = (b.textContent || '').trim().toLowerCase();
                return txt.includes('select an option') || txt.includes('choose an option');
              },
            );
            for (const btn of unselectedButtons) {
              try {
                btn.focus();
                btn.click();
                const listbox = document.querySelector(
                  '[role="listbox"], ul[class*="list" i], div[class*="menu" i], div[id*="dropdown" i]',
                );
                const items = Array.from(
                  (listbox || document).querySelectorAll(
                    '[role="option"], li, button[class*="item" i], div[class*="option" i]',
                  ),
                ) as HTMLElement[];
                const validItem = items.find(item => {
                  const t = (item.textContent || '').toLowerCase().trim();
                  return t && !t.includes('select an option') && !t.includes('choose an option');
                });
                if (validItem) {
                  validItem.focus();
                  validItem.click();
                  validItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  validItem.dispatchEvent(new Event('change', { bubbles: true }));
                }
              } catch {
                // Intentionally silent in DOM script: custom dropdown button click fallback
              }
            }
          },
        })
        .catch(passErr => {
          logger.debug('[IndeedAdapter] Non-critical error during form safety pass:', passErr);
        });
    } catch (err) {
      logger.warning('[IndeedAdapter] Error filling step fields:', err);
    }
  }

  /**
   * Auto-heals validation errors in the Indeed application DOM.
   * If red error banners like "Choose an option to continue" or unchecked required checkboxes appear,
   * this identifies the errored fields, ticks missing consent checkboxes, calls LLM for unknown questions,
   * fills the fields, and returns true so the runner can re-advance.
   */
  private async autoHealValidationErrors(
    tabId: number,
    careerBrain: ICareerBrain,
    scopedLLM?: BaseChatModel,
  ): Promise<boolean> {
    try {
      const errorScan = await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          func: () => {
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

            // Find red error messages or invalid inputs
            const errorContainers = Array.from(
              document.querySelectorAll(
                '.ia-Feedback-error, [aria-invalid="true"], [data-testid*="error" i], div[class*="error" i], span[class*="error" i], p[class*="error" i], div[class*="feedback" i], div[role="alert"]',
              ),
            ).filter(el => {
              if (!isElementVisible(el as HTMLElement)) return false;
              const txt = (el.textContent || '').trim().toLowerCase();
              return (
                txt.includes('choose') ||
                txt.includes('select') ||
                txt.includes('required') ||
                txt.includes('valid') ||
                txt.includes('error') ||
                txt.includes('fill') ||
                txt.includes('option') ||
                txt.includes('agree') ||
                txt.includes('consent')
              );
            });

            const invalidInputs = Array.from(
              document.querySelectorAll('[aria-invalid="true"], input:invalid, select:invalid, textarea:invalid'),
            ).filter(el => isElementVisible(el as HTMLElement));

            if (!errorContainers.length && !invalidInputs.length) return { hasErrors: false, fieldsToFix: [] };

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

            const allInputs = inputs.filter(
              el => isElementVisible(el) && !('disabled' in el && (el as HTMLInputElement).disabled),
            );

            const handledRadioGroups = new Set<string>();
            const fieldsToFix: Array<{
              index: number;
              type: string;
              label: string;
              options: string[];
              errorMsg: string;
            }> = [];

            allInputs.forEach((el, idx) => {
              const tagName = el.tagName.toLowerCase();
              const role = el.getAttribute('role');
              const ariaHasPopup = el.getAttribute('aria-haspopup');
              const fType =
                el.getAttribute('type') === 'checkbox' || role === 'checkbox'
                  ? 'checkbox'
                  : el.getAttribute('type') === 'radio' || role === 'radio'
                    ? 'radio'
                    : tagName === 'select' ||
                        role === 'combobox' ||
                        ariaHasPopup === 'listbox' ||
                        el.classList.contains('ia-Dropdown') ||
                        (tagName === 'button' && (el.textContent || '').toLowerCase().includes('select an option'))
                      ? 'select'
                      : 'text';

              const isInvalid = el.getAttribute('aria-invalid') === 'true';
              const isUncheckedCheckbox =
                fType === 'checkbox' && !(el as HTMLInputElement).checked && el.getAttribute('aria-checked') !== 'true';

              const container =
                el.closest('fieldset, .ia-BasePage-component, div[class*="field" i], div[class*="question" i]') ||
                el.parentElement;
              const fieldset = el.closest('fieldset');
              const hasNearbyError = container ? errorContainers.some(err => container.contains(err)) : false;

              let isUncheckedRadioGroup = false;
              let siblingOptions: string[] = [];

              if (fType === 'radio') {
                const groupName = el.getAttribute('name') || el.closest('fieldset')?.id || '';
                if (groupName && handledRadioGroups.has(groupName)) {
                  return;
                }

                const siblings = groupName
                  ? (Array.from(document.querySelectorAll(`input[name="${groupName}"]`)) as HTMLElement[])
                  : container
                    ? (Array.from(container.querySelectorAll('input[type="radio"], [role="radio"]')) as HTMLElement[])
                    : [el];

                const anyChecked = siblings.some(
                  s => (s as HTMLInputElement).checked || s.getAttribute('aria-checked') === 'true',
                );

                if (!anyChecked) {
                  isUncheckedRadioGroup = true;
                  if (groupName) handledRadioGroups.add(groupName);
                }

                siblingOptions = siblings
                  .map(s => (s.closest('label')?.textContent || (s as HTMLInputElement).value || '').trim())
                  .filter(Boolean);
              }

              const isRequiredEmpty =
                el.hasAttribute('required') &&
                !(el as HTMLInputElement).value &&
                fType !== 'radio' &&
                fType !== 'checkbox';

              const isConsentCheckbox =
                isUncheckedCheckbox &&
                Boolean(
                  (container?.textContent || el.closest('label')?.textContent || '')
                    .toLowerCase()
                    .match(/consent|agree|policy|terms|acknowledge/i),
                );

              if (
                isInvalid ||
                (isUncheckedCheckbox && (hasNearbyError || isConsentCheckbox)) ||
                hasNearbyError ||
                isUncheckedRadioGroup ||
                isRequiredEmpty
              ) {
                let label = '';
                if (fType === 'radio') {
                  const groupLegend = container?.querySelector(
                    'legend, [role="heading"], h3, h4, [class*="header" i], [class*="title" i]',
                  )?.textContent;
                  label = (
                    groupLegend ||
                    container?.querySelector('p, span')?.textContent ||
                    el.closest('label')?.textContent ||
                    el.getAttribute('aria-label') ||
                    ''
                  ).trim();
                } else {
                  label = (
                    el.closest('label')?.textContent ||
                    container?.querySelector('legend, label, p, span')?.textContent ||
                    el.getAttribute('aria-label') ||
                    el.getAttribute('name') ||
                    ''
                  ).trim();
                }

                const errorMsg =
                  errorContainers.find(err => container?.contains(err))?.textContent?.trim() ||
                  (fType === 'radio' ? 'Choose an option to continue' : 'Required');

                let options: string[] = [];
                if (fType === 'radio') {
                  options = siblingOptions;
                } else if (fType === 'select') {
                  if (tagName === 'select') {
                    options = Array.from((el as HTMLSelectElement).querySelectorAll('option'))
                      .map(o => (o.textContent || '').trim())
                      .filter(t => t && !t.toLowerCase().includes('select'));
                  } else {
                    const listbox = document.querySelector(
                      '[role="listbox"], ul[class*="list" i], div[class*="menu" i]',
                    );
                    if (listbox) {
                      options = Array.from(listbox.querySelectorAll('[role="option"], li, button'))
                        .map(i => (i.textContent || '').trim())
                        .filter(t => t && !t.toLowerCase().includes('select an option'));
                    }
                  }
                } else if (fType === 'checkbox') {
                  const groupName = el.getAttribute('name');
                  const siblings = groupName
                    ? (Array.from(document.querySelectorAll(`input[name="${groupName}"]`)) as HTMLElement[])
                    : fieldset
                      ? (Array.from(
                          fieldset.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
                        ) as HTMLElement[])
                      : container
                        ? (Array.from(
                            container.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
                          ) as HTMLElement[])
                        : [];
                  options = siblings
                    .map(s => (s.closest('label')?.textContent || (s as HTMLInputElement).value || '').trim())
                    .filter(Boolean);
                }

                fieldsToFix.push({
                  index: idx,
                  type: fType,
                  label,
                  options,
                  errorMsg,
                });
              }
            });

            return { hasErrors: true, fieldsToFix };
          },
        })
        .catch(() => []);

      const hit = errorScan.find(r => r.result?.hasErrors);
      if (!hit || !hit.result || !hit.result.fieldsToFix.length) {
        return false;
      }

      logger.warning(
        `[IndeedAdapter] Auto-healing ${hit.result.fieldsToFix.length} validation errors on tab ${tabId}...`,
      );

      const frameId = hit.frameId;
      for (const fix of hit.result.fieldsToFix) {
        // If it's a checkbox (e.g. timezone EST, CST, or "I consent"), solve and tick the matching option!
        if (fix.type === 'checkbox') {
          let targetAnswer = 'consent';
          if (fix.options && fix.options.length > 0) {
            const isTz = fix.options.some(o => /est|cst|mst|pst/i.test(o));
            if (isTz) {
              targetAnswer = fix.options.find(o => /est|eastern/i.test(o)) || fix.options[0];
            } else {
              targetAnswer = fix.options[0];
            }
          } else {
            const labelLower = (fix.label || '').toLowerCase();
            if (labelLower.match(/consent|agree|policy|terms|acknowledge/i)) {
              targetAnswer = 'consent';
            }
          }
          logger.info(`[IndeedAdapter] Auto-healing checkbox: Ticking "${fix.label || 'Checkbox'}" (${targetAnswer})`);
          await chrome.scripting
            .executeScript({
              target: { tabId, frameIds: [frameId] },
              func: (idx: number, optVal: string) => {
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
                const el = visibleInputs[idx] as HTMLInputElement | undefined;
                if (!el) return;

                const container =
                  el.closest('fieldset, .ia-BasePage-component, div[class*="field" i], div[class*="question" i]') ||
                  el.parentElement;
                const cbs = container
                  ? (Array.from(
                      container.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
                    ) as HTMLInputElement[])
                  : [el];
                const optLo = (optVal || '').toLowerCase();
                const matchedCb =
                  cbs.find(c => {
                    const t = (c.closest('label')?.textContent || c.value || '').toLowerCase();
                    return t.includes(optLo) || optLo.includes(t);
                  }) || el;

                matchedCb.focus();
                matchedCb.click();
                let nowChecked = matchedCb.checked === true || matchedCb.getAttribute('aria-checked') === 'true';
                if (!nowChecked) {
                  const lbl = matchedCb.closest('label');
                  if (lbl) {
                    lbl.click();
                    nowChecked = matchedCb.checked === true || matchedCb.getAttribute('aria-checked') === 'true';
                  }
                }
                if (!nowChecked) {
                  matchedCb.checked = true;
                  matchedCb.setAttribute('aria-checked', 'true');
                  matchedCb.dispatchEvent(new Event('input', { bubbles: true }));
                  matchedCb.dispatchEvent(new Event('change', { bubbles: true }));
                }
              },
              args: [fix.index, targetAnswer],
            })
            .catch(() => {});
          continue;
        }

        // If it's a radio or text question, use LLM to solve the exact error!
        let resolvedAnswer = 'Yes';
        if (scopedLLM) {
          try {
            logger.info(
              `[IndeedAdapter] Calling LLM to resolve errored question: "${fix.label}" (error: ${fix.errorMsg})`,
            );
            const llmFieldType =
              fix.type === 'select'
                ? 'dropdown'
                : ['text', 'number', 'radio', 'checkbox'].includes(fix.type)
                  ? (fix.type as 'text' | 'number' | 'radio' | 'checkbox')
                  : 'text';
            const llmSol = await solveQuestionAutonomousWithLLM(
              {
                label: `${fix.label} (Validation error: ${fix.errorMsg})`,
                fieldType: llmFieldType,
                options: fix.options,
                required: true,
              },
              careerBrain,
              scopedLLM,
            );
            if (llmSol.success && llmSol.answer) {
              resolvedAnswer = llmSol.answer;
              logger.info(`[IndeedAdapter] LLM resolved error for "${fix.label}" -> "${resolvedAnswer}"`);
            }
          } catch (e) {
            logger.warning('[IndeedAdapter] LLM error resolution failed, using rule fallback:', e);
            const mappedType = (
              ['text', 'number', 'radio', 'dropdown', 'select', 'checkbox', 'date'].includes(fix.type)
                ? fix.type
                : 'text'
            ) as 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date';
            const rMatch = resolveIndeedQuestion(fix.label, mappedType, fix.options, careerBrain);
            resolvedAnswer = rMatch.value;
          }
        } else {
          const mappedType = (
            ['text', 'number', 'radio', 'dropdown', 'select', 'checkbox', 'date'].includes(fix.type) ? fix.type : 'text'
          ) as 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date';
          const rMatch = resolveIndeedQuestion(fix.label, mappedType, fix.options, careerBrain);
          resolvedAnswer = rMatch.value;
        }

        const fixLabelLo = (fix.label || '').toLowerCase();
        if (
          fix.type === 'date' ||
          /\b(date\s+of\s+birth|dob|birth\s+date|working\s+day|start\s+date|end\s+date)\b/i.test(fixLabelLo)
        ) {
          const rawVal = (resolvedAnswer || '').trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(rawVal)) {
            const [y, m, d] = rawVal.split('-');
            resolvedAnswer = `${d}/${m}/${y}`;
          } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawVal)) {
            const parts = rawVal.split('/');
            resolvedAnswer = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
          } else if (!/^\d{2}\/\d{2}\/\d{4}$/.test(rawVal)) {
            if (fixLabelLo.includes('birth') || fixLabelLo.includes('dob')) {
              resolvedAnswer = '01/01/2000';
            } else {
              const today = new Date();
              resolvedAnswer = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
            }
          }
        } else if (/\b(current\s+company|present\s+company|employer|company\s+name)\b/i.test(fixLabelLo)) {
          if (!resolvedAnswer || /placeholder|your\s+current|here|company\s+name/i.test(resolvedAnswer)) {
            resolvedAnswer =
              careerBrain.workExperience?.[0]?.company ||
              (careerBrain.hasWorkExperience === false ? 'None' : 'Self-Employed');
          }
        } else if (fix.type === 'number' || /\b(salary|ctc|compensation)\b/i.test(fixLabelLo)) {
          const numMatch = (resolvedAnswer || '').match(/(\d+[\d,.]*)/);
          if (numMatch) {
            resolvedAnswer = numMatch[1].replace(/,/g, '');
          }
        }

        // Fill resolved answer into DOM
        await chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [frameId] },
            func: async (idx: number, val: string, fType: string) => {
              function isElementVisible(el: HTMLElement): boolean {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              }

              function setReactInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
                input.focus();
                input.dispatchEvent(new Event('focus', { bubbles: true }));

                const nativeSetter = Object.getOwnPropertyDescriptor(
                  input instanceof HTMLTextAreaElement
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype,
                  'value',
                )?.set;

                if (nativeSetter) {
                  nativeSetter.call(input, value);
                } else {
                  input.value = value;
                }

                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
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
              const el = visibleInputs[idx] as (HTMLElement & HTMLInputElement & HTMLSelectElement) | undefined;
              if (!el) return;

              if (fType === 'radio') {
                const groupName = el.getAttribute('name');
                const container =
                  el.closest('fieldset, div[class*="field" i], div[class*="question" i]') || el.parentElement;
                const siblings = groupName
                  ? (Array.from(document.querySelectorAll(`input[name="${groupName}"]`)) as HTMLElement[])
                  : container
                    ? (Array.from(container.querySelectorAll('input[type="radio"], [role="radio"]')) as HTMLElement[])
                    : [el];

                const valLo = (val || '').toLowerCase().trim();
                const matched =
                  siblings.find(s => {
                    const sTxt = (
                      s.closest('label')?.textContent ||
                      ('value' in s ? (s as HTMLInputElement).value : '') ||
                      ''
                    )
                      .toLowerCase()
                      .trim();
                    return (
                      sTxt === valLo ||
                      (valLo.length > 0 && sTxt.includes(valLo)) ||
                      (sTxt.length > 0 && valLo.includes(sTxt))
                    );
                  }) || siblings[0];

                if (matched) {
                  matched.focus();
                  matched.click();
                  (matched as HTMLInputElement).checked = true;
                  matched.setAttribute('aria-checked', 'true');
                  matched.dispatchEvent(new Event('input', { bubbles: true }));
                  matched.dispatchEvent(new Event('change', { bubbles: true }));
                  matched.closest('label')?.click();
                }
              } else if (fType === 'select') {
                if (el.tagName.toLowerCase() === 'select') {
                  el.focus();
                  for (let i = 0; i < el.options.length; i++) {
                    if (el.options[i].text.toLowerCase().includes(val.toLowerCase())) {
                      el.selectedIndex = i;
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                      break;
                    }
                  }
                  if (el.selectedIndex <= 0 && el.options.length > 1) {
                    el.selectedIndex = 1;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  el.dispatchEvent(new Event('blur', { bubbles: true }));
                } else {
                  el.focus();
                  el.click();
                  await new Promise(r => setTimeout(r, 250));

                  const searchInput = (document.querySelector(
                    'input[placeholder*="search" i], input[placeholder*="select an option" i], input[role="searchbox"]',
                  ) ||
                    el
                      .closest('.ia-BasePage-component, div[class*="field" i]')
                      ?.querySelector('input[type="text"]')) as HTMLInputElement;

                  if (searchInput && isElementVisible(searchInput)) {
                    setReactInputValue(searchInput, val || '');
                    await new Promise(r => setTimeout(r, 150));
                  }

                  const listbox = document.querySelector(
                    '[role="listbox"], ul[class*="list" i], div[class*="menu" i], div[id*="dropdown" i]',
                  );
                  const items = Array.from(
                    (listbox || document).querySelectorAll(
                      '[role="option"], li, button[class*="item" i], div[class*="option" i]',
                    ),
                  ).filter(it => isElementVisible(it as HTMLElement)) as HTMLElement[];
                  const valLo = (val || '').toLowerCase().trim();
                  let target = items.find(it => {
                    const txt = (it.textContent || '').toLowerCase().trim();
                    if (txt === valLo) return true;
                    if (valLo && (txt.includes(valLo) || valLo.includes(txt))) return true;
                    if (
                      valLo.includes('immediate') &&
                      (txt.includes('immediate') || txt.includes('15 days') || txt.includes('serving'))
                    )
                      return true;
                    if (
                      (valLo.includes('bengaluru') || valLo.includes('bangalore')) &&
                      (txt.includes('bengaluru') || txt.includes('bangalore'))
                    )
                      return true;
                    return false;
                  });

                  if (!target && items.length > 0) {
                    target =
                      items.find(it => {
                        const txt = (it.textContent || '').toLowerCase();
                        return !txt.includes('select an option') && !txt.includes('choose an option');
                      }) || items[0];
                  }

                  if (target) {
                    target.focus();
                    target.click();
                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 150));
                  }
                }
              } else {
                setReactInputValue(el, val);
              }
            },
            args: [fix.index, resolvedAnswer, fix.type],
          })
          .catch(() => {});
      }

      return true;
    } catch (err) {
      logger.warning('[IndeedAdapter] Error in autoHealValidationErrors:', err);
      return false;
    }
  }

  public async checkCaptchaPresent(puppeteerPage: PuppeteerPage): Promise<boolean> {
    try {
      return await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        const title = (document.title || '').toLowerCase();
        if (
          title.includes('just a moment') ||
          title.includes('attention required') ||
          title.includes('security check') ||
          title.includes('verify you are human') ||
          title.includes('additional verification') ||
          title.includes('cloudflare')
        ) {
          return true;
        }

        const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
        if (
          bodyText.includes('additional verification required') ||
          bodyText.includes('verify you are human') ||
          bodyText.includes('ray id for this request') ||
          bodyText.includes('troubleshooting cloudflare errors') ||
          (bodyText.includes('cloudflare') && bodyText.includes('ray id'))
        ) {
          return true;
        }

        for (const sel of selectors.CAPTCHA_CONTAINERS) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            const style = window.getComputedStyle(el);
            if (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              (el.offsetWidth > 0 || el.offsetHeight > 0)
            ) {
              return true;
            }
          }
        }
        return false;
      }, INDEED_SELECTORS);
    } catch {
      return false;
    }
  }

  public async checkCaptchaPresentOnTab(tabId: number): Promise<boolean> {
    if (!tabId) return false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (selectors: typeof INDEED_SELECTORS) => {
          const title = (document.title || '').toLowerCase();
          if (
            title.includes('just a moment') ||
            title.includes('attention required') ||
            title.includes('security check') ||
            title.includes('verify you are human') ||
            title.includes('additional verification') ||
            title.includes('cloudflare')
          ) {
            return true;
          }

          const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
          if (
            bodyText.includes('additional verification required') ||
            bodyText.includes('verify you are human') ||
            bodyText.includes('ray id for this request') ||
            bodyText.includes('troubleshooting cloudflare errors') ||
            (bodyText.includes('cloudflare') && bodyText.includes('ray id'))
          ) {
            return true;
          }

          for (const sel of selectors.CAPTCHA_CONTAINERS) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el) {
              const style = window.getComputedStyle(el);
              if (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (el.offsetWidth > 0 || el.offsetHeight > 0)
              ) {
                return true;
              }
            }
          }
          return false;
        },
        args: [INDEED_SELECTORS],
      });
      return results.some(r => r.result === true);
    } catch {
      return false;
    }
  }
}

export const indeedAdapter = new IndeedAdapter();
