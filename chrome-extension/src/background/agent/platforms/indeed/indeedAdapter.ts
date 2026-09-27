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

    let popupPage: any = null;

    try {
      logger.info(`[IndeedAdapter] Navigating to Indeed job: ${job.title} (${job.url})`);

      // Disable beforeunload on current page to prevent navigation hangs
      await puppeteerPage
        .evaluate(() => {
          window.onbeforeunload = null;
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
      await puppeteerPage
        .evaluate(() => {
          window.onbeforeunload = null;
        })
        .catch(() => {});

      // 2. Check for Cloudflare / Captcha Challenge (only visible challenges)
      const hasCaptcha = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        const title = (document.title || '').toLowerCase();
        if (
          title.includes('just a moment') ||
          title.includes('attention required') ||
          title.includes('security check')
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

      if (hasCaptcha) {
        return {
          status: 'failed',
          reason: 'Indeed Captcha/Bot Challenge detected. Please solve captcha in the runner window.',
        };
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
        for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && el.offsetParent !== null) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return;
          }
        }
        const buttons = Array.from(document.querySelectorAll('button, a'));
        for (const b of buttons) {
          const bText = (b.textContent || '').trim().toLowerCase();
          if (bText === 'apply now' || bText === 'easily apply' || bText.includes('apply now')) {
            (b as HTMLElement).scrollIntoView({ block: 'center' });
            (b as HTMLElement).click();
            return;
          }
        }
      }, INDEED_SELECTORS);

      await new Promise(r => setTimeout(r, 4500));

      // Determine active tab ID (handles if Indeed opened in an iframe or in a popup tab)
      let activeTabId: number = page.tabId;
      try {
        const currentTab = await chrome.tabs.get(page.tabId);
        const winTabs = await chrome.tabs.query({ windowId: currentTab.windowId });
        const popup = winTabs.find(t => t.id !== page.tabId && (t.url || '').toLowerCase().includes('smartapply'));
        if (popup?.id) {
          activeTabId = popup.id;
          logger.info(`[IndeedAdapter] Found smartapply in popup tab ${activeTabId}`);
        }
      } catch {}

      // 6. Multi-Step Flow (up to 12 steps) using chrome.scripting across all frames
      const maxSteps = 12;
      let applicationSubmitted = false;

      for (let step = 1; step <= maxSteps; step++) {
        logger.info(`[IndeedAdapter] Handling application step ${step}...`);

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
        await this.fillIndeedStepFields(activeTabId, careerBrain);

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

              function triggerClick(el: HTMLElement) {
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                el.focus();
                el.click();
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
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
                if (btn && isElementVisible(btn)) {
                  triggerClick(btn);
                  return true;
                }
              }

              const buttons = Array.from(
                document.querySelectorAll('button, [role="button"], input[type="submit"]'),
              ) as HTMLElement[];
              for (const b of buttons) {
                if (!isElementVisible(b)) continue;
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

        for (let clickAttempt = 0; clickAttempt < 4; clickAttempt++) {
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

                function triggerClick(el: HTMLElement) {
                  el.scrollIntoView({ behavior: 'instant', block: 'center' });
                  el.focus();
                  el.click();
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                }

                // 1. Selector check
                for (const sel of selectors.FORWARD_BUTTON_SELECTORS) {
                  const btn = document.querySelector(sel) as HTMLElement | null;
                  if (btn && isElementVisible(btn)) {
                    const txt = btn.textContent?.trim() || '';
                    triggerClick(btn);
                    return { clicked: true, text: txt };
                  }
                }

                // 2. Broad search across all buttons and clickable elements
                const buttons = Array.from(
                  document.querySelectorAll(
                    'button, [role="button"], a.is-primary, input[type="button"], input[type="submit"]',
                  ),
                ) as HTMLElement[];

                for (const b of buttons) {
                  if (!isElementVisible(b)) continue;
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
                    b.getAttribute('data-testid') === 'continue-button' ||
                    b.getAttribute('aria-label')?.toLowerCase().includes('continue');

                  if (isMatch) {
                    triggerClick(b);
                    return { clicked: true, text: t };
                  }
                }

                return { clicked: false, text: '' };
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
          await new Promise(r => setTimeout(r, 1200));
        }

        if (!continueClicked) {
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
        await new Promise(r => setTimeout(r, 3500));
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
      await puppeteerPage
        .evaluate(() => {
          window.onbeforeunload = null;
        })
        .catch(() => {});
      puppeteerPage.off('dialog', dialogHandler);

      if (popupPage) {
        try {
          await popupPage
            .evaluate(() => {
              window.onbeforeunload = null;
            })
            .catch(() => {});
          popupPage.off('dialog', dialogHandler);
          await popupPage.close();
        } catch {}
      }
    }
  }

  private async fillIndeedStepFields(tabId: number, careerBrain: any): Promise<void> {
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

            const inputs = Array.from(document.querySelectorAll('input, select, textarea')) as HTMLElement[];
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

                const labelText = (legend || labelEl?.textContent || ariaLabel || placeholder || name || '').trim();

                const tagName = el.tagName.toLowerCase();
                let fieldType = 'text';
                if (tagName === 'select') fieldType = 'select';
                else if (el.getAttribute('type') === 'radio') fieldType = 'radio';
                else if (el.getAttribute('type') === 'checkbox') fieldType = 'checkbox';
                else if (el.getAttribute('type') === 'number') fieldType = 'number';

                const options: string[] = [];
                if (tagName === 'select') {
                  const optEls = Array.from(el.querySelectorAll('option'));
                  for (const o of optEls) {
                    const t = (o.textContent || '').trim();
                    if (t && !t.toLowerCase().includes('select')) options.push(t);
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
          const answer = resolveIndeedQuestion(f.labelText, f.fieldType as any, f.options, careerBrain);

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

                const visibleInputs = (
                  Array.from(document.querySelectorAll('input, select, textarea')) as HTMLElement[]
                ).filter((el: any) => isElementVisible(el) && !el.disabled);
                const el = visibleInputs[idx] as any;
                if (!el) return;

                if (fType === 'select') {
                  let matched = false;
                  for (let i = 0; i < el.options.length; i++) {
                    if (el.options[i].text.toLowerCase().includes(val.toLowerCase())) {
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
                } else if (fType === 'radio') {
                  const rText = (
                    el.closest('label')?.textContent ||
                    el.parentElement?.textContent ||
                    el.value ||
                    ''
                  ).toLowerCase();
                  const valLo = val.toLowerCase();
                  const matchesYes =
                    valLo.startsWith('y') && (rText.includes('yes') || el.value.toLowerCase() === 'yes');
                  const matchesNo = valLo.startsWith('n') && (rText.includes('no') || el.value.toLowerCase() === 'no');
                  const matchesVal = valLo && (rText.includes(valLo) || el.value.toLowerCase().includes(valLo));

                  if (matchesYes || matchesNo || matchesVal) {
                    el.checked = true;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.click();
                  }
                } else if (fType === 'checkbox') {
                  if (!el.checked && (val.toLowerCase().startsWith('y') || val.toLowerCase() === 'true')) {
                    el.checked = true;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.click();
                  }
                } else {
                  if (!el.value) {
                    el.value = val || '1';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }
              },
              args: [f.index, answer.value, f.fieldType],
            })
            .catch(() => {});

          await new Promise(r => setTimeout(r, 100));
        }
      }
    } catch (err) {
      logger.warning('[IndeedAdapter] Error filling step fields:', err);
    }
  }
}

export const indeedAdapter = new IndeedAdapter();
