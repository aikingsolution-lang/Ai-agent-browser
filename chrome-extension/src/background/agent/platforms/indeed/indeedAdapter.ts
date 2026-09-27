// chrome-extension/src/background/agent/platforms/indeed/indeedAdapter.ts
import type {
  IPlatformAdapter,
  IJobQueueItem,
  IPlatformSession,
  IApplicationResult,
  IPlatformExecutionContext,
  SupportedPlatform,
} from '../types';
import { INDEED_SELECTORS } from './selectors';
import { resolveIndeedQuestion } from './indeedResolver';
import { solveQuestionAutonomousWithLLM } from '../../linkedin/formQuestionResolver';
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
    const cleanLoc = (location || '').trim();

    const params = new URLSearchParams();
    params.set('q', cleanRole);
    if (cleanLoc) {
      params.set('l', cleanLoc);
    }
    params.set('fromage', '14'); // Last 14 days

    return `https://www.indeed.com/jobs?${params.toString()}`;
  }

  public async validateSession(page: any): Promise<IPlatformSession> {
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

  public async extractJobCards(page: any): Promise<IJobQueueItem[]> {
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
        }> = [];

        const seenJk = new Set<string>();
        const cards = Array.from(document.querySelectorAll(selectors.JOB_CARDS.join(', ')));

        for (const el of cards) {
          try {
            // Find job key (jk)
            let jk = el.getAttribute('data-jk') || '';
            const linkEl = el.querySelector(selectors.JOB_TITLE.join(', ')) as HTMLAnchorElement | null;
            if (!jk && linkEl) {
              const href = linkEl.getAttribute('href') || linkEl.href || '';
              const match = href.match(/[?&]jk=([a-zA-Z0-9]+)/);
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

            // Check if card has "Easily apply" badge
            const textContent = (el.textContent || '').toLowerCase();
            const hasEasyApply =
              selectors.EASILY_APPLY_BADGE.some(b => !!el.querySelector(b)) || textContent.includes('easily apply');

            const fullUrl = jk ? `https://www.indeed.com/viewjob?jk=${jk}` : linkEl?.getAttribute('href') || '';

            results.push({
              jobId: jk || String(Math.abs(hashString(title + company))),
              title,
              company,
              url: fullUrl,
              location,
              salary,
              isQuickApply: hasEasyApply,
            });
          } catch {}
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
        .filter((j: any) => {
          const key = j.jobId || j.url;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((j: any) => ({
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

    // Auto-accept any browser dialogs (e.g. "Leave site? Changes you made may not be saved")
    const dialogHandler = async (dialog: any) => {
      try {
        logger.info(`[IndeedAdapter] Auto-accepting dialog: ${dialog.message()}`);
        await dialog.accept();
      } catch {}
    };
    puppeteerPage.on('dialog', dialogHandler);

    let activeTabId: number = page.tabId;

    try {
      // Clean up any stray smartapply popup tabs from previous runs
      try {
        const existingTabs = await chrome.tabs.query({});
        for (const t of existingTabs) {
          if (t.id && t.id !== page.tabId && (t.url || '').toLowerCase().includes('smartapply')) {
            await chrome.tabs.remove(t.id).catch(() => {});
          }
        }
      } catch {}

      logger.info(`[IndeedAdapter] Navigating to Indeed job: ${job.title} (${job.url})`);

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
                delete (e as any).returnValue;
              },
              { capture: true },
            );
          },
        })
        .catch(() => {});

      // 1. Navigate to job URL if not already there or if stuck in smartapply
      const currentUrl = puppeteerPage.url().toLowerCase();
      if (!currentUrl.includes(job.jobId) || currentUrl.includes('smartapply')) {
        await page.navigateTo(job.url).catch(async () => {
          await puppeteerPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        });
        await new Promise(r => setTimeout(r, 3000));
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

      // 2. Check for Cloudflare / Captcha Challenge (with 20s auto-solve/grace wait)
      let hasCaptcha = await this.checkCaptchaPresent(puppeteerPage);
      if (hasCaptcha) {
        logger.warning(
          `[IndeedAdapter] Cloudflare / Bot Challenge detected on "${job.title}". Waiting up to 20s for auto-verification or user intervention in runner window...`,
        );

        const startTime = Date.now();
        const maxWaitMs = 20000;

        while (Date.now() - startTime < maxWaitMs) {
          await this.attemptTurnstileClick(puppeteerPage, page.tabId).catch(() => {});
          await new Promise(r => setTimeout(r, 2000));

          hasCaptcha = await this.checkCaptchaPresent(puppeteerPage);
          if (!hasCaptcha) {
            logger.info('[IndeedAdapter] Cloudflare challenge passed! Proceeding with job application...');
            break;
          }
        }

        if (hasCaptcha) {
          return {
            status: 'failed',
            reason: 'Indeed Captcha/Bot Challenge detected. Timed out after 20s waiting for solution in runner window.',
          };
        }
      }

      // 3. Check if already applied
      const alreadyApplied = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        const text = (document.body.innerText || '').toLowerCase();
        return selectors.ALREADY_APPLIED_INDICATORS.some(ind => text.includes(ind));
      }, INDEED_SELECTORS);

      if (alreadyApplied) {
        return { status: 'skipped', reason: 'You already applied to this job on Indeed.' };
      }

      // 4. Find Apply Button (with up to 6s retry for dynamic rendering)
      let applyBtn = { found: false, isExternal: false };
      for (let retries = 0; retries < 6; retries++) {
        applyBtn = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
          let btn: HTMLElement | null = null;
          for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && el.offsetParent !== null) {
              btn = el;
              break;
            }
          }

          if (!btn) {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            for (const b of buttons) {
              const bText = (b.textContent || '').trim().toLowerCase();
              if (bText === 'apply now' || bText === 'easily apply' || bText.includes('apply now')) {
                btn = b as HTMLElement;
                break;
              }
            }
          }

          if (!btn) return { found: false, isExternal: false };

          const btnText = (btn.textContent || '').toLowerCase();
          const isExternal = selectors.EXTERNAL_APPLY_INDICATORS.some(ind => btnText.includes(ind));

          return { found: true, isExternal };
        }, INDEED_SELECTORS);

        if (applyBtn.found) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!applyBtn.found) {
        return { status: 'skipped', reason: 'No active Apply button found.' };
      }

      if (applyBtn.isExternal) {
        return { status: 'skipped', reason: 'Requires applying directly on company site.' };
      }

      // 5. Click the Apply button
      logger.info('[IndeedAdapter] Clicking Apply button...');
      await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        function triggerClick(el: HTMLElement) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.focus();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.click();
        }

        for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && el.offsetParent !== null) {
            triggerClick(el);
            return;
          }
        }
        const buttons = Array.from(document.querySelectorAll('button, a'));
        for (const b of buttons) {
          const bText = (b.textContent || '').trim().toLowerCase();
          if (bText === 'apply now' || bText === 'easily apply' || bText.includes('apply now')) {
            triggerClick(b as HTMLElement);
            return;
          }
        }
      }, INDEED_SELECTORS);

      // Wait up to 10 seconds for the application modal or popup tab to appear
      activeTabId = page.tabId;
      for (let waitSec = 0; waitSec < 10; waitSec++) {
        await new Promise(r => setTimeout(r, 1000));

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
            break;
          }
        } catch {}

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

      // 6. Multi-Step Flow (up to 12 steps) using chrome.scripting across all frames
      const maxSteps = 12;
      let applicationSubmitted = false;

      for (let step = 1; step <= maxSteps; step++) {
        logger.info(`[IndeedAdapter] Handling application step ${step} on tab ${activeTabId}...`);

        // Check if application is already submitted in ANY frame
        const isDoneResults = await chrome.scripting
          .executeScript({
            target: { tabId: activeTabId, allFrames: true },
            func: (selectors: typeof INDEED_SELECTORS) => {
              const bodyText = (document.body?.innerText || '').toLowerCase();
              return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
            },
            args: [INDEED_SELECTORS],
          })
          .catch(() => []);

        if (isDoneResults.some(r => r.result === true)) {
          logger.info('[IndeedAdapter] Successfully submitted Indeed application (confirmed via success indicator)!');
          applicationSubmitted = true;
          break;
        }

        // Fill any visible questions/inputs on this step across all frames
        await this.fillIndeedStepFields(activeTabId, careerBrain, context.scopedLLM);
        await new Promise(r => setTimeout(r, 600));

        // Check for Submit button across all frames (ONLY in apply/modal contexts)
        const submitResults = await chrome.scripting
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
                if ((el as any).disabled) return false;
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

              const url = window.location.href.toLowerCase();
              const isApplyContext =
                url.includes('smartapply') ||
                url.includes('indeedapply') ||
                !!document.querySelector('div.ia-BasePage') ||
                !!document.querySelector('#indeedapply-modal');
              if (!isApplyContext) return false;

              for (const sel of selectors.SUBMIT_BUTTON_SELECTORS) {
                const btn = document.querySelector(sel) as HTMLElement | null;
                if (btn && isElementVisible(btn) && isElementEnabled(btn)) {
                  triggerClick(btn);
                  return true;
                }
              }

              const buttons = Array.from(
                document.querySelectorAll('button, [role="button"], input[type="submit"]'),
              ) as HTMLElement[];
              for (const b of buttons) {
                if (!isElementVisible(b) || !isElementEnabled(b)) continue;
                const t = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
                if (
                  t === 'submit your application' ||
                  t === 'submit application' ||
                  t === 'submit' ||
                  t.includes('submit your application')
                ) {
                  triggerClick(b);
                  return true;
                }
              }
              return false;
            },
            args: [INDEED_SELECTORS],
          })
          .catch(() => []);

        const submitClicked = submitResults.some(r => r.result === true);

        if (submitClicked) {
          logger.info('[IndeedAdapter] Clicked Submit button. Waiting for submission confirmation...');
          await new Promise(r => setTimeout(r, 4500));

          // Verify submission success indicator across all frames
          const confirmResults = await chrome.scripting
            .executeScript({
              target: { tabId: activeTabId, allFrames: true },
              func: (selectors: typeof INDEED_SELECTORS) => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
              },
              args: [INDEED_SELECTORS],
            })
            .catch(() => []);

          if (confirmResults.some(r => r.result === true)) {
            logger.info('[IndeedAdapter] Application submission confirmed!');
            applicationSubmitted = true;
            break;
          }

          logger.info('[IndeedAdapter] Final submit button was clicked on review step.');
          applicationSubmitted = true;
          break;
        }

        // Otherwise click Continue / Next button across all frames
        let continueClicked = false;
        let clickedButtonText = '';

        for (let clickAttempt = 0; clickAttempt < 6; clickAttempt++) {
          const continueResults = await chrome.scripting
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
                  if ((el as any).disabled) return false;
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
                  return { clicked: false, loading: true, text: 'loading_spinner', diag: [] };
                }

                // 1. Selector check
                for (const sel of selectors.FORWARD_BUTTON_SELECTORS) {
                  const btn = document.querySelector(sel) as HTMLElement | null;
                  if (btn && isElementVisible(btn) && isElementEnabled(btn)) {
                    const txt = btn.textContent?.trim() || '';
                    triggerClick(btn);
                    return { clicked: true, loading: false, text: txt || 'Forward Selector', diag: [] };
                  }
                }

                // 2. Broad search across all buttons and clickable elements
                const buttons = Array.from(
                  document.querySelectorAll(
                    'button, [role="button"], a.is-primary, input[type="button"], input[type="submit"]',
                  ),
                ) as HTMLElement[];

                for (const b of buttons) {
                  if (!isElementVisible(b) || !isElementEnabled(b)) continue;
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
                    return { clicked: true, loading: false, text: t, diag: [] };
                  }
                }

                // 3. Fallback: Check for "Skip" button (e.g. optional Review work experience)
                for (const b of buttons) {
                  if (!isElementVisible(b) || !isElementEnabled(b)) continue;
                  const t = (b.textContent || '').trim().toLowerCase();
                  if (t === 'skip' || t.startsWith('skip')) {
                    triggerClick(b);
                    return { clicked: true, loading: false, text: 'Skip (optional step)', diag: [] };
                  }
                }

                const diag = buttons.filter(isElementVisible).map(b => ({
                  tag: b.tagName,
                  text: (b.textContent || '').trim().slice(0, 30),
                  disabled: !isElementEnabled(b),
                  testId: b.getAttribute('data-testid') || '',
                }));

                return { clicked: false, loading: false, text: '', diag };
              },
              args: [INDEED_SELECTORS],
            })
            .catch(() => []);

          const hit = continueResults.find(r => r.result?.clicked === true);
          if (hit && hit.result) {
            continueClicked = true;
            clickedButtonText = hit.result.text || '';
            break;
          }

          const isLoading = continueResults.some(r => r.result?.loading === true);
          if (isLoading) {
            logger.info(`[IndeedAdapter] Step ${step}: Button in loading state, waiting...`);
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }

          if (clickAttempt === 5) {
            for (const r of continueResults) {
              if (r.result?.diag?.length) {
                logger.info(
                  `[IndeedAdapter] Step ${step} Frame ${r.frameId} visible buttons: ${JSON.stringify(r.result.diag)}`,
                );
              }
            }
          }

          await new Promise(r => setTimeout(r, 1200));
        }

        if (!continueClicked) {
          // If continue button wasn't clicked, try auto-healing validation errors (like missing consent checkbox) first!
          const healed = await this.autoHealValidationErrors(activeTabId, careerBrain, context.scopedLLM);
          if (healed) {
            logger.info(`[IndeedAdapter] Healed validation errors before failure check. Re-trying step ${step}...`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          // Final check: did success indicator appear?
          const doneCheckResults = await chrome.scripting
            .executeScript({
              target: { tabId: activeTabId, allFrames: true },
              func: (selectors: typeof INDEED_SELECTORS) => {
                const bodyText = (document.body?.innerText || '').toLowerCase();
                return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
              },
              args: [INDEED_SELECTORS],
            })
            .catch(() => []);

          if (doneCheckResults.some(r => r.result === true)) {
            applicationSubmitted = true;
            break;
          }

          logger.warning(`[IndeedAdapter] No forward or submit button found at step ${step}.`);
          return {
            status: 'failed',
            reason: `Application incomplete: reached step ${step} without finding Next/Submit button`,
          };
        }

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
                  const t = (b.textContent || (b as any).value || '').trim().toLowerCase();
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
    } catch (err: any) {
      logger.error('[IndeedAdapter] Error applying to Indeed job:', err);
      return { status: 'failed', reason: err?.message || 'Application error' };
    } finally {
      await chrome.scripting
        .executeScript({
          target: { tabId: page.tabId, allFrames: true },
          func: () => {
            window.onbeforeunload = null;
          },
        })
        .catch(() => {});

      puppeteerPage.off('dialog', dialogHandler);

      if (activeTabId && activeTabId !== page.tabId) {
        try {
          await chrome.tabs.remove(activeTabId);
        } catch {}
      }
    }
  }

  private async fillIndeedStepFields(tabId: number, careerBrain: any, scopedLLM?: any): Promise<void> {
    try {
      const scanResults = await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            const url = window.location.href.toLowerCase();
            const isApplyContext =
              url.includes('smartapply') ||
              url.includes('indeedapply') ||
              !!document.querySelector('div.ia-BasePage') ||
              !!document.querySelector('#indeedapply-modal');
            if (!isApplyContext) return [];

            function isElementVisible(el: HTMLElement): boolean {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }

            const inputs = Array.from(
              document.querySelectorAll('input, select, textarea, [role="checkbox"], [role="radio"]'),
            ) as HTMLElement[];

            return inputs
              .filter((el: any) => isElementVisible(el) && !el.disabled)
              .map((el, idx) => {
                const labelEl =
                  el.closest('label') ||
                  el.parentElement?.querySelector('label') ||
                  (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
                const placeholder = el.getAttribute('placeholder') || '';
                const name = el.getAttribute('name') || '';
                const ariaLabel = el.getAttribute('aria-label') || '';
                const fieldset = el.closest('fieldset');
                const legend = fieldset ? fieldset.querySelector('legend')?.textContent : '';
                const containerText =
                  el.closest('.ia-BasePage-component, div[class*="field" i], div[class*="question" i]')?.textContent ||
                  '';

                const labelText = (
                  legend ||
                  labelEl?.textContent ||
                  ariaLabel ||
                  placeholder ||
                  name ||
                  containerText ||
                  ''
                ).trim();

                const tagName = el.tagName.toLowerCase();
                const role = el.getAttribute('role');
                let fieldType = 'text';
                if (tagName === 'select') fieldType = 'select';
                else if (el.getAttribute('type') === 'radio' || role === 'radio') fieldType = 'radio';
                else if (el.getAttribute('type') === 'checkbox' || role === 'checkbox') fieldType = 'checkbox';
                else if (el.getAttribute('type') === 'number') fieldType = 'number';

                const options: string[] = [];
                if (tagName === 'select') {
                  const optEls = Array.from(el.querySelectorAll('option'));
                  for (const o of optEls) {
                    const t = (o.textContent || '').trim();
                    if (t && !t.toLowerCase().includes('select')) options.push(t);
                  }
                } else if (fieldType === 'radio') {
                  const groupName = el.getAttribute('name');
                  const siblings = groupName
                    ? Array.from(document.querySelectorAll(`input[name="${groupName}"]`))
                    : fieldset
                      ? Array.from(fieldset.querySelectorAll('input[type="radio"], [role="radio"]'))
                      : [];
                  for (const sib of siblings) {
                    const sibText = (sib.closest('label')?.textContent || (sib as any).value || '').trim();
                    if (sibText) options.push(sibText);
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
          let answer = resolveIndeedQuestion(f.labelText, f.fieldType as any, f.options, careerBrain);

          // If rule-based confidence is low (< 0.8) and scopedLLM is available, consult LLM for 100% accuracy!
          if (answer.confidence < 0.8 && scopedLLM) {
            try {
              logger.info(`[IndeedAdapter] Asking LLM to resolve field: "${f.labelText}" (${f.fieldType})`);
              const llmRes = await solveQuestionAutonomousWithLLM(
                {
                  label: f.labelText,
                  fieldType: f.fieldType as any,
                  options: f.options,
                },
                careerBrain,
                scopedLLM,
              );
              if (llmRes.success && llmRes.answer) {
                answer = { value: llmRes.answer, confidence: 0.95, source: 'profile' };
                logger.info(`[IndeedAdapter] LLM resolved "${f.labelText}" -> "${answer.value}"`);
              }
            } catch (err) {
              logger.warning(`[IndeedAdapter] LLM field resolution fallback error:`, err);
            }
          }

          await chrome.scripting
            .executeScript({
              target: { tabId, frameIds: [frameId] },
              func: (idx: number, val: string, fType: string) => {
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

                const visibleInputs = (
                  Array.from(
                    document.querySelectorAll('input, select, textarea, [role="checkbox"], [role="radio"]'),
                  ) as HTMLElement[]
                ).filter((el: any) => isElementVisible(el) && !el.disabled);
                const el = visibleInputs[idx] as any;
                if (!el) return;

                if (fType === 'select') {
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
                    if (!el.checked && el.getAttribute('aria-checked') !== 'true') {
                      el.checked = true;
                      el.setAttribute('aria-checked', 'true');
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    el.closest('label')?.click();
                  }
                } else if (fType === 'checkbox') {
                  const isChecked = el.checked === true || el.getAttribute('aria-checked') === 'true';
                  const valLo = (val || '').toLowerCase();
                  const shouldCheck =
                    valLo.startsWith('y') ||
                    valLo === 'true' ||
                    valLo.includes('consent') ||
                    valLo.includes('agree') ||
                    valLo.includes('accept') ||
                    valLo.includes('acknowledge') ||
                    valLo.includes('policy') ||
                    valLo.includes('terms');

                  if (!isChecked && shouldCheck) {
                    el.focus();
                    el.click();
                    const stillUnchecked = !el.checked && el.getAttribute('aria-checked') !== 'true';
                    if (stillUnchecked) {
                      el.checked = true;
                      el.setAttribute('aria-checked', 'true');
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                      el.closest('label')?.click();
                    }
                  }
                } else {
                  // Only fill if empty or if invalid placeholder/default like "Yes"/"No"
                  const curVal = (el.value || '').trim().toLowerCase();
                  if (!curVal || curVal === 'yes' || curVal === 'no') {
                    setReactInputValue(el, val || '1');
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
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }

            const radios = (
              Array.from(document.querySelectorAll('input[type="radio"], [role="radio"]')) as HTMLElement[]
            ).filter(el => isElementVisible(el) && !(el as any).disabled);

            const radioGroups = new Map<string, HTMLElement[]>();
            radios.forEach((r, idx) => {
              const name = r.getAttribute('name') || r.closest('fieldset')?.id || `group_${Math.floor(idx / 4)}`;
              if (!radioGroups.has(name)) radioGroups.set(name, []);
              radioGroups.get(name)!.push(r);
            });

            for (const [_, groupRadios] of radioGroups) {
              const anyChecked = groupRadios.some(
                r => (r as HTMLInputElement).checked || r.getAttribute('aria-checked') === 'true',
              );
              if (!anyChecked && groupRadios.length > 0) {
                const preferred =
                  groupRadios.find(r => {
                    const txt = (r.closest('label')?.textContent || (r as any).value || '').toLowerCase();
                    return txt.startsWith('yes') || txt.includes('consent') || txt.includes('agree');
                  }) || groupRadios[0];

                try {
                  preferred.focus();
                  preferred.click();
                  (preferred as HTMLInputElement).checked = true;
                  preferred.setAttribute('aria-checked', 'true');
                  preferred.dispatchEvent(new Event('input', { bubbles: true }));
                  preferred.dispatchEvent(new Event('change', { bubbles: true }));
                  preferred.closest('label')?.click();
                } catch {}
              }
            }
          },
        })
        .catch(() => {});
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
  private async autoHealValidationErrors(tabId: number, careerBrain: any, scopedLLM?: any): Promise<boolean> {
    try {
      const errorScan = await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            function isElementVisible(el: HTMLElement): boolean {
              if (!el) return false;
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
            ).filter((el: any) => {
              if (!isElementVisible(el)) return false;
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

            if (!errorContainers.length) return { hasErrors: false, fieldsToFix: [] };

            const allInputs = (
              Array.from(
                document.querySelectorAll('input, select, textarea, [role="checkbox"], [role="radio"]'),
              ) as HTMLElement[]
            ).filter(el => isElementVisible(el) && !(el as any).disabled);

            const handledRadioGroups = new Set<string>();
            const fieldsToFix: Array<{
              index: number;
              type: string;
              label: string;
              options: string[];
              errorMsg: string;
            }> = [];

            allInputs.forEach((el, idx) => {
              const fType =
                el.getAttribute('type') === 'checkbox' || el.getAttribute('role') === 'checkbox'
                  ? 'checkbox'
                  : el.getAttribute('type') === 'radio' || el.getAttribute('role') === 'radio'
                    ? 'radio'
                    : el.tagName.toLowerCase() === 'select'
                      ? 'select'
                      : 'text';

              const isInvalid = el.getAttribute('aria-invalid') === 'true';
              const isUncheckedCheckbox =
                fType === 'checkbox' && !(el as HTMLInputElement).checked && el.getAttribute('aria-checked') !== 'true';

              const container =
                el.closest('fieldset, .ia-BasePage-component, div[class*="field" i], div[class*="question" i]') ||
                el.parentElement;
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
                  .map(s => (s.closest('label')?.textContent || (s as any).value || '').trim())
                  .filter(Boolean);
              }

              if (isInvalid || isUncheckedCheckbox || hasNearbyError || isUncheckedRadioGroup) {
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
                  options = Array.from((el as HTMLSelectElement).querySelectorAll('option'))
                    .map(o => (o.textContent || '').trim())
                    .filter(t => t && !t.toLowerCase().includes('select'));
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
        // If it's a checkbox (e.g. "I consent"), ALWAYS tick it!
        if (fix.type === 'checkbox') {
          logger.info(`[IndeedAdapter] Auto-healing checkbox: Ticking "${fix.label || 'Consent'}"`);
          await chrome.scripting
            .executeScript({
              target: { tabId, frameIds: [frameId] },
              func: (idx: number) => {
                const inputs = (
                  Array.from(
                    document.querySelectorAll('input, select, textarea, [role="checkbox"], [role="radio"]'),
                  ) as HTMLElement[]
                ).filter(el => !(el as any).disabled);
                const el = inputs[idx] as any;
                if (el) {
                  el.focus();
                  el.click();
                  if (!el.checked && el.getAttribute('aria-checked') !== 'true') {
                    el.checked = true;
                    el.setAttribute('aria-checked', 'true');
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.closest('label')?.click();
                  }
                }
              },
              args: [fix.index],
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
            const llmSol = await solveQuestionAutonomousWithLLM(
              {
                label: `${fix.label} (Validation error: ${fix.errorMsg})`,
                fieldType: fix.type as any,
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
            const rMatch = resolveIndeedQuestion(fix.label, fix.type as any, fix.options, careerBrain);
            resolvedAnswer = rMatch.value;
          }
        } else {
          const rMatch = resolveIndeedQuestion(fix.label, fix.type as any, fix.options, careerBrain);
          resolvedAnswer = rMatch.value;
        }

        // Fill resolved answer into DOM
        await chrome.scripting
          .executeScript({
            target: { tabId, frameIds: [frameId] },
            func: (idx: number, val: string, fType: string) => {
              const inputs = (
                Array.from(
                  document.querySelectorAll('input, select, textarea, [role="checkbox"], [role="radio"]'),
                ) as HTMLElement[]
              ).filter(el => !(el as any).disabled);
              const el = inputs[idx] as any;
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
                    const sTxt = (s.closest('label')?.textContent || (s as any).value || '').toLowerCase().trim();
                    return (
                      sTxt === valLo ||
                      (valLo.length > 0 && sTxt.includes(valLo)) ||
                      (sTxt.length > 0 && valLo.includes(sTxt))
                    );
                  }) || siblings[0];

                if (matched) {
                  (matched as any).focus();
                  (matched as any).click();
                  (matched as HTMLInputElement).checked = true;
                  matched.setAttribute('aria-checked', 'true');
                  matched.dispatchEvent(new Event('input', { bubbles: true }));
                  matched.dispatchEvent(new Event('change', { bubbles: true }));
                  (matched as any).closest('label')?.click();
                }
              } else if (fType === 'select') {
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
                const nativeSetter = Object.getOwnPropertyDescriptor(
                  el instanceof HTMLTextAreaElement
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype,
                  'value',
                )?.set;
                if (nativeSetter) nativeSetter.call(el, val);
                else el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
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

  private async checkCaptchaPresent(puppeteerPage: any): Promise<boolean> {
    try {
      return await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        const title = (document.title || '').toLowerCase();
        if (
          title.includes('just a moment') ||
          title.includes('attention required') ||
          title.includes('security check') ||
          title.includes('verify you are human') ||
          title.includes('cloudflare')
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

  private async attemptTurnstileClick(puppeteerPage: any, tabId: number): Promise<void> {
    try {
      // 1. Attempt clicking Turnstile checkbox within puppeteer frames
      const frames = puppeteerPage.frames();
      for (const frame of frames) {
        try {
          const checkbox = await frame.$(
            'input[type="checkbox"], .ctp-checkbox-label, #challenge-stage input, div[id*="turnstile"], span.mark',
          );
          if (checkbox) {
            await checkbox.click().catch(() => {});
          }
        } catch {}
      }

      // 2. Attempt clicking in main page context
      await puppeteerPage
        .evaluate(() => {
          const targets = Array.from(
            document.querySelectorAll(
              '#challenge-stage, .cf-turnstile-wrapper, div[class*="turnstile" i], iframe[src*="cloudflare" i], iframe[src*="turnstile" i]',
            ),
          ) as HTMLElement[];
          for (const t of targets) {
            try {
              t.scrollIntoView({ behavior: 'instant', block: 'center' });
              t.focus();
              t.click();
            } catch {}
          }
        })
        .catch(() => {});

      // 3. Scripting click across all chrome frames
      await chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            const cb = document.querySelector(
              'input[type="checkbox"], .ctp-checkbox-label, span.mark, div.spacer',
            ) as HTMLElement | null;
            if (cb) {
              try {
                cb.focus();
                cb.click();
              } catch {}
            }
          },
        })
        .catch(() => {});
    } catch {}
  }
}

export const indeedAdapter = new IndeedAdapter();
