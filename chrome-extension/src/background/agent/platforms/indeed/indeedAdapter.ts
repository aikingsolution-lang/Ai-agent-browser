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

      return rawJobs.map((j: any) => ({
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

    try {
      const puppeteerPage = page.puppeteerPage;
      if (!puppeteerPage) {
        return { status: 'failed', reason: 'Browser page instance unavailable' };
      }

      logger.info(`[IndeedAdapter] Navigating to Indeed job: ${job.title} (${job.url})`);

      // 1. Navigate to job URL if not already there
      const currentUrl = puppeteerPage.url().toLowerCase();
      if (!currentUrl.includes(job.jobId)) {
        await page.navigateTo(job.url).catch(async () => {
          await puppeteerPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        });
        await new Promise(r => setTimeout(r, 3000));
      }

      // 2. Check for Cloudflare / Captcha Challenge
      const hasCaptcha = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
        return selectors.CAPTCHA_CONTAINERS.some(sel => !!document.querySelector(sel));
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

      await new Promise(r => setTimeout(r, 3000));

      // 6. Multi-Step Modal Flow (up to 8 steps)
      const maxSteps = 8;
      for (let step = 1; step <= maxSteps; step++) {
        logger.info(`[IndeedAdapter] Handling application step ${step}...`);

        // Check if application is already submitted
        const isDone = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
        }, INDEED_SELECTORS);

        if (isDone) {
          logger.info('[IndeedAdapter] Successfully submitted Indeed application!');
          return { status: 'applied', creditsUsed: 1 };
        }

        // Fill any visible questions/inputs on this step
        await this.fillIndeedStepFields(puppeteerPage, careerBrain);

        // Check for Submit button
        const submitClicked = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
          for (const sel of selectors.SUBMIT_BUTTON) {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn && btn.offsetParent !== null) {
              btn.click();
              return true;
            }
          }
          return false;
        }, INDEED_SELECTORS);

        if (submitClicked) {
          logger.info('[IndeedAdapter] Clicked Submit button. Waiting for confirmation...');
          await new Promise(r => setTimeout(r, 4000));
          return { status: 'applied', creditsUsed: 1 };
        }

        // Otherwise click Continue / Next
        const continueClicked = await puppeteerPage.evaluate((selectors: typeof INDEED_SELECTORS) => {
          for (const sel of selectors.FORWARD_BUTTONS) {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn && btn.offsetParent !== null) {
              btn.click();
              return true;
            }
          }
          return false;
        }, INDEED_SELECTORS);

        if (!continueClicked) {
          logger.info('[IndeedAdapter] No further navigation button found. Step loop finished.');
          break;
        }

        await new Promise(r => setTimeout(r, 2500));
      }

      return { status: 'applied', creditsUsed: 1 };
    } catch (err: any) {
      logger.error('[IndeedAdapter] Error applying to Indeed job:', err);
      return { status: 'failed', reason: err?.message || 'Application error' };
    }
  }

  private async fillIndeedStepFields(puppeteerPage: any, careerBrain: any): Promise<void> {
    try {
      const fields = await puppeteerPage.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
        return inputs
          .filter((el: any) => el.offsetParent !== null)
          .map((el, idx) => {
            const labelEl = el.closest('label') || el.parentElement?.querySelector('label');
            const placeholder = el.getAttribute('placeholder') || '';
            const name = el.getAttribute('name') || '';
            const labelText = (labelEl?.textContent || placeholder || name || '').trim();

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

        await puppeteerPage.evaluate(
          (idx: number, val: string, fType: string) => {
            const visibleInputs = Array.from(document.querySelectorAll('input, select, textarea')).filter(
              (el: any) => el.offsetParent !== null,
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
            } else if (fType === 'radio' || fType === 'checkbox') {
              el.checked = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
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

        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      logger.warning('[IndeedAdapter] Error filling step fields:', err);
    }
  }
}

export const indeedAdapter = new IndeedAdapter();
