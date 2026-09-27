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

      // 1. Navigate to job URL if not already there
      const currentUrl = puppeteerPage.url().toLowerCase();
      if (!currentUrl.includes(job.jobId)) {
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

      // 4. Find Apply Button
      const applyBtn = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
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
            if (bText === 'apply now' || bText === 'easily apply') {
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
            el.click();
            return;
          }
        }
        const buttons = Array.from(document.querySelectorAll('button, a'));
        for (const b of buttons) {
          const bText = (b.textContent || '').trim().toLowerCase();
          if (bText === 'apply now' || bText === 'easily apply') {
            (b as HTMLElement).click();
            return;
          }
        }
      }, INDEED_SELECTORS);

      await new Promise(r => setTimeout(r, 4000));

      // Check if a popup page was opened for smartapply
      try {
        const browser = puppeteerPage.browser();
        const pages = await browser.pages();
        for (const p of pages) {
          if (p !== puppeteerPage && p.url().toLowerCase().includes('smartapply')) {
            popupPage = p;
            popupPage.on('dialog', dialogHandler);
            await popupPage
              .evaluate(() => {
                window.onbeforeunload = null;
              })
              .catch(() => {});
            break;
          }
        }
      } catch {}

      // Helper to find the active frame or page where the application form lives
      const getActiveTarget = async (): Promise<any> => {
        const candidates: any[] = [];
        if (popupPage && !popupPage.isClosed?.()) {
          candidates.push(popupPage);
        }
        if (puppeteerPage.frames) {
          for (const f of puppeteerPage.frames()) {
            candidates.push(f);
          }
        }
        candidates.push(puppeteerPage);

        for (const c of candidates) {
          try {
            const hasApplyForm = await c.evaluate((selectors: typeof INDEED_SELECTORS) => {
              const u = window.location.href.toLowerCase();
              if (u.includes('smartapply') || u.includes('indeedapply')) return true;

              const hasForwardSelector = selectors.FORWARD_BUTTON_SELECTORS.some(sel => {
                const el = document.querySelector(sel);
                return el && (el as HTMLElement).offsetParent !== null;
              });
              if (hasForwardSelector) return true;

              const btns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
              return btns.some(b => {
                if (b.offsetParent === null) return false;
                const t = (b.textContent || '').trim().toLowerCase();
                return selectors.FORWARD_BUTTON_TEXTS.some(txt => t === txt || t.includes(txt));
              });
            }, INDEED_SELECTORS);

            if (hasApplyForm) {
              return c;
            }
          } catch {}
        }

        return popupPage || puppeteerPage;
      };

      let activeTarget = await getActiveTarget();

      // 6. Multi-Step Modal / SmartApply Flow (up to 12 steps)
      const maxSteps = 12;
      let applicationSubmitted = false;

      for (let step = 1; step <= maxSteps; step++) {
        logger.info(`[IndeedAdapter] Handling application step ${step}...`);

        // Refresh activeTarget in case step navigation changed frames
        activeTarget = await getActiveTarget();

        // Check if application is already submitted
        const isDone = await activeTarget.evaluate((selectors: typeof INDEED_SELECTORS) => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
        }, INDEED_SELECTORS);

        if (isDone) {
          logger.info('[IndeedAdapter] Successfully submitted Indeed application (confirmed via success indicator)!');
          applicationSubmitted = true;
          break;
        }

        // Fill any visible questions/inputs on this step
        await this.fillIndeedStepFields(activeTarget, careerBrain);

        // Check for Submit button (Only genuine final submit buttons, never "apply now")
        const submitClicked = await activeTarget.evaluate((selectors: typeof INDEED_SELECTORS) => {
          // 1. Check known submit selectors
          for (const sel of selectors.SUBMIT_BUTTON_SELECTORS) {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn && btn.offsetParent !== null) {
              btn.scrollIntoView({ block: 'center' });
              btn.click();
              return true;
            }
          }
          // 2. Check all visible buttons by text (strict matching against SUBMIT_BUTTON_TEXTS)
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
          for (const b of buttons) {
            if (b.offsetParent === null) continue;
            const t = (b.textContent || '').trim().toLowerCase();
            if (
              t === 'submit your application' ||
              t === 'submit application' ||
              t === 'submit' ||
              selectors.SUBMIT_BUTTON_TEXTS.some(txt => t === txt)
            ) {
              b.scrollIntoView({ block: 'center' });
              b.click();
              return true;
            }
          }
          return false;
        }, INDEED_SELECTORS);

        if (submitClicked) {
          logger.info('[IndeedAdapter] Clicked Submit button. Waiting for submission confirmation...');
          await new Promise(r => setTimeout(r, 4500));

          // Verify submission success indicator
          const confirmed = await activeTarget.evaluate((selectors: typeof INDEED_SELECTORS) => {
            const bodyText = (document.body.innerText || '').toLowerCase();
            return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
          }, INDEED_SELECTORS);

          if (confirmed) {
            logger.info('[IndeedAdapter] Application submission confirmed!');
            applicationSubmitted = true;
            break;
          }

          // Also check parent page in case modal closed upon submission
          const parentConfirmed = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
            const bodyText = (document.body.innerText || '').toLowerCase();
            return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
          }, INDEED_SELECTORS);

          if (parentConfirmed) {
            logger.info('[IndeedAdapter] Application submission confirmed on parent page!');
            applicationSubmitted = true;
            break;
          }

          // If submit was clicked on the final review step, treat as submitted
          logger.info('[IndeedAdapter] Final submit button was clicked successfully.');
          applicationSubmitted = true;
          break;
        }

        // Otherwise click Continue / Next
        const continueClicked = await activeTarget.evaluate((selectors: typeof INDEED_SELECTORS) => {
          // 1. Check known forward selectors
          for (const sel of selectors.FORWARD_BUTTON_SELECTORS) {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn && btn.offsetParent !== null) {
              btn.scrollIntoView({ block: 'center' });
              btn.focus();
              btn.click();
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return true;
            }
          }
          // 2. Check all visible buttons by text
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
          for (const b of buttons) {
            if (b.offsetParent === null) continue;
            const t = (b.textContent || '').trim().toLowerCase();
            if (selectors.FORWARD_BUTTON_TEXTS.some(txt => t === txt || t.includes(txt))) {
              b.scrollIntoView({ block: 'center' });
              b.focus();
              b.click();
              btnDispatch(b);
              return true;
            }
          }

          function btnDispatch(el: HTMLElement) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }

          return false;
        }, INDEED_SELECTORS);

        if (!continueClicked) {
          // Check once more if success indicator appeared after submitting
          const doneCheck = await activeTarget.evaluate((selectors: typeof INDEED_SELECTORS) => {
            const bodyText = (document.body.innerText || '').toLowerCase();
            return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
          }, INDEED_SELECTORS);

          if (doneCheck) {
            applicationSubmitted = true;
            break;
          }

          logger.warning(
            `[IndeedAdapter] No forward or submit button found at step ${step}. Application cannot proceed.`,
          );
          return {
            status: 'failed',
            reason: `Application incomplete: reached step ${step} without finding Next/Submit button`,
          };
        }

        logger.info(`[IndeedAdapter] Clicked Continue for step ${step}. Waiting for next step...`);
        await new Promise(r => setTimeout(r, 3000));
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
      // Neutralize beforeunload and clean up listeners
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

  private async fillIndeedStepFields(pageOrFrame: any, careerBrain: any): Promise<void> {
    try {
      const fields = await pageOrFrame.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
        return inputs
          .filter((el: any) => el.offsetParent !== null && !el.disabled)
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
      });

      for (const f of fields) {
        if (!f.labelText) continue;
        const answer = resolveIndeedQuestion(f.labelText, f.fieldType as any, f.options, careerBrain);

        await pageOrFrame.evaluate(
          (idx: number, val: string, fType: string) => {
            const visibleInputs = Array.from(document.querySelectorAll('input, select, textarea')).filter(
              (el: any) => el.offsetParent !== null && !el.disabled,
            );
            const el = visibleInputs[idx] as any;
            if (!el) return;

            if (fType === 'select') {
              for (let i = 0; i < el.options.length; i++) {
                if (el.options[i].text.toLowerCase().includes(val.toLowerCase())) {
                  el.selectedIndex = i;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  break;
                }
              }
            } else if (fType === 'radio') {
              // Only check radio button if value matches or if not already checked
              const rText = (
                el.closest('label')?.textContent ||
                el.parentElement?.textContent ||
                el.value ||
                ''
              ).toLowerCase();
              const valLo = val.toLowerCase();
              if (valLo.startsWith('y') && (rText.includes('yes') || el.value.toLowerCase() === 'yes')) {
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.click();
              } else if (valLo.startsWith('n') && (rText.includes('no') || el.value.toLowerCase() === 'no')) {
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
              // Text or number - don't overwrite if user already has a valid value
              if (!el.value) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          },
          f.index,
          answer.value,
          f.fieldType,
        );

        await new Promise(r => setTimeout(r, 150));
      }
    } catch (err) {
      logger.warning('[IndeedAdapter] Error filling step fields:', err);
    }
  }
}

export const indeedAdapter = new IndeedAdapter();
