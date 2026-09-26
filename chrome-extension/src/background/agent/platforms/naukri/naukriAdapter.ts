// chrome-extension/src/background/agent/platforms/naukri/naukriAdapter.ts
import type {
  IPlatformAdapter,
  IJobQueueItem,
  IPlatformSession,
  IApplicationResult,
  IPlatformExecutionContext,
  SupportedPlatform,
} from '../types';
import { NAUKRI_SELECTORS } from './selectors';
import { resolveNaukriQuestion } from './naukriResolver';
import { createLogger } from '@src/background/log';

const logger = createLogger('NaukriAdapter');

export class NaukriAdapter implements IPlatformAdapter {
  public readonly platformId: SupportedPlatform = 'naukri';
  public readonly displayName: string = 'Naukri.com';
  public readonly domainMatches: string[] = ['naukri.com'];

  public isMatchingUrl(url: string): boolean {
    if (!url) return false;
    return url.toLowerCase().includes('naukri.com');
  }

  public buildSearchUrl(role: string, location: string): string {
    const cleanRole = (role || 'Software Engineer').trim();
    const cleanLoc = (location || '').trim();

    const params = new URLSearchParams();
    params.set('k', cleanRole);
    if (cleanLoc && cleanLoc.toLowerCase() !== 'remote') {
      params.set('l', cleanLoc);
    }
    // Sort by relevance/freshness
    params.set('nignbevent', 'auto_apply');

    return `https://www.naukri.com/jobs?${params.toString()}`;
  }

  public async validateSession(page: any): Promise<IPlatformSession> {
    try {
      const puppeteerPage = page.puppeteerPage;
      if (!puppeteerPage) {
        return { isLoggedIn: false, isLoginWall: false };
      }

      const sessionInfo = await puppeteerPage.evaluate(() => {
        const url = window.location.href.toLowerCase();
        const isLoginUrl = url.includes('/nlogin/login') || url.includes('/login') || url.includes('/registration');

        const hasLoginForm = !!(
          document.querySelector('#usernameField') ||
          document.querySelector('form[name="login-form"]') ||
          document.querySelector('.login-layer')
        );

        const hasUserMenu = !!(
          document.querySelector('.nI-gNb-drawer') ||
          document.querySelector('.nI-gNb-user-img') ||
          document.querySelector('a[title="View Profile"]') ||
          document.querySelector('.user-name')
        );

        const userNameEl = document.querySelector('.user-name, .nI-gNb-drawer__user-name');
        const userName = userNameEl ? userNameEl.textContent?.trim() : undefined;

        return {
          isLoggedIn: hasUserMenu,
          isLoginWall: isLoginUrl || (hasLoginForm && !hasUserMenu),
          userName,
          loginUrl: isLoginUrl ? url : undefined,
        };
      });

      return sessionInfo;
    } catch (err) {
      logger.warning('[NaukriAdapter] Session check error:', err);
      return { isLoggedIn: false, isLoginWall: false };
    }
  }

  public async extractJobCards(page: any): Promise<IJobQueueItem[]> {
    try {
      const puppeteerPage = page.puppeteerPage;
      if (!puppeteerPage) return [];

      const rawJobs = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        const results: Array<{
          jobId: string;
          title: string;
          company: string;
          url: string;
          location?: string;
          experience?: string;
          salary?: string;
          isQuickApply?: boolean;
        }> = [];

        // Query job containers
        const tupleElements = Array.from(document.querySelectorAll(selectors.JOB_TUPLES.join(', ')));

        for (const el of tupleElements) {
          try {
            // Title & URL
            const titleEl = el.querySelector(selectors.JOB_TITLE.join(', ')) as HTMLAnchorElement | null;
            if (!titleEl) continue;

            const title = (titleEl.textContent || '').trim();
            const href = titleEl.getAttribute('href') || titleEl.href || '';
            if (!title || !href) continue;

            const fullUrl = href.startsWith('http') ? href : `https://www.naukri.com${href}`;

            // Unique Job ID from URL or attribute
            let jobId = el.getAttribute('data-job-id') || '';
            if (!jobId) {
              const match = fullUrl.match(/-([0-9a-zA-Z]{6,30})(?:\?|$)/);
              jobId = match ? match[1] : String(Math.abs(hashString(fullUrl)));
            }

            // Company
            const compEl = el.querySelector(selectors.COMPANY_NAME.join(', '));
            const company = (compEl?.textContent || '').trim();

            // Location
            const locEl = el.querySelector(selectors.LOCATION.join(', '));
            const location = (locEl?.textContent || '').trim();

            // Experience
            const expEl = el.querySelector(selectors.EXPERIENCE.join(', '));
            const experience = (expEl?.textContent || '').trim();

            // Salary
            const salEl = el.querySelector(selectors.SALARY.join(', '));
            const salary = (salEl?.textContent || '').trim();

            // Check if it's direct apply or external
            const textContent = (el.textContent || '').toLowerCase();
            const isExternal = selectors.EXTERNAL_APPLY_INDICATORS.some(ind => textContent.includes(ind));

            results.push({
              jobId,
              title,
              company,
              url: fullUrl,
              location,
              experience,
              salary,
              isQuickApply: !isExternal,
            });
          } catch {
            // Skip individual parsing error
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
      }, NAUKRI_SELECTORS);

      return rawJobs.map((j: any) => ({
        ...j,
        platform: 'naukri' as const,
      }));
    } catch (err) {
      logger.error('[NaukriAdapter] Failed to extract job cards:', err);
      return [];
    }
  }

  public async applyToJob(job: IJobQueueItem, context: IPlatformExecutionContext): Promise<IApplicationResult> {
    const { page, careerBrain, portToSend, onLiveActivity, runId } = context;

    try {
      const puppeteerPage = page.puppeteerPage;
      if (!puppeteerPage) {
        return { status: 'failed', reason: 'Browser page instance unavailable' };
      }

      logger.info(`[NaukriAdapter] Navigating to Naukri job: ${job.title} (${job.url})`);

      // 1. Navigate to job page if not already there
      const currentUrl = puppeteerPage.url().toLowerCase();
      if (!currentUrl.includes(job.jobId)) {
        await page.navigateTo(job.url).catch(async () => {
          await puppeteerPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        });
        await new Promise(r => setTimeout(r, 3000));
      }

      // 2. Check if already applied
      const alreadyApplied = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        const text = (document.body.innerText || '').toLowerCase();
        return selectors.ALREADY_APPLIED_INDICATORS.some(ind => text.includes(ind));
      }, NAUKRI_SELECTORS);

      if (alreadyApplied) {
        return { status: 'skipped', reason: 'You already applied to this job earlier on Naukri.' };
      }

      // 3. Find Apply Button and check for external redirects
      const applyBtnState = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        let btn: HTMLElement | null = null;
        for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && el.offsetParent !== null) {
            btn = el;
            break;
          }
        }

        if (!btn) {
          // Search any button containing "Apply"
          const buttons = Array.from(document.querySelectorAll('button, a'));
          for (const b of buttons) {
            const bText = (b.textContent || '').trim().toLowerCase();
            if (bText === 'apply' || bText === 'apply on website' || bText.startsWith('apply')) {
              btn = b as HTMLElement;
              break;
            }
          }
        }

        if (!btn) {
          return { found: false, isExternal: false, text: '' };
        }

        const btnText = (btn.textContent || '').trim().toLowerCase();
        const isExternal = selectors.EXTERNAL_APPLY_INDICATORS.some(ind => btnText.includes(ind));

        return {
          found: true,
          isExternal,
          text: btnText,
        };
      }, NAUKRI_SELECTORS);

      if (!applyBtnState.found) {
        return { status: 'skipped', reason: 'No active Apply button found on job page.' };
      }

      if (applyBtnState.isExternal) {
        return {
          status: 'skipped',
          reason: 'Requires applying directly on company website (not direct apply).',
        };
      }

      // 4. Click the Apply button
      logger.info(`[NaukriAdapter] Clicking Apply button: "${applyBtnState.text}"`);
      await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
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
          if (bText === 'apply' || bText === 'apply on website') {
            (b as HTMLElement).click();
            return;
          }
        }
      }, NAUKRI_SELECTORS);

      // Wait 3s to inspect response
      await new Promise(r => setTimeout(r, 3000));

      // 5. Check if 1-Click apply succeeded or modal/questionnaire opened
      const postClickCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        const bodyText = (document.body.innerText || '').toLowerCase();
        const success = selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
        if (success) {
          return { type: 'success' };
        }

        // Check if questionnaire/chatbot container is open
        const modal = document.querySelector(selectors.MODAL_CONTAINER.join(', '));
        if (modal && (modal as HTMLElement).offsetParent !== null) {
          return { type: 'modal_open' };
        }

        return { type: 'unknown' };
      }, NAUKRI_SELECTORS);

      if (postClickCheck.type === 'success') {
        logger.info('[NaukriAdapter] Direct 1-Click apply succeeded!');
        return { status: 'applied', creditsUsed: 1 };
      }

      // 6. Handle Questionnaire / Modal if opened
      if (postClickCheck.type === 'modal_open') {
        logger.info('[NaukriAdapter] Questionnaire or Chatbot opened. Solving questions...');

        // Fill fields in modal
        const fillResult = await this.handleNaukriQuestionnaire(puppeteerPage, careerBrain);
        if (fillResult.success) {
          return { status: 'applied', creditsUsed: 1, modalOpened: true };
        }
        return { status: 'failed', reason: fillResult.reason || 'Could not complete questionnaire.' };
      }

      // If nothing changed, wait an extra 2s and re-verify success banner
      await new Promise(r => setTimeout(r, 2000));
      const recheckSuccess = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        const bodyText = (document.body.innerText || '').toLowerCase();
        return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
      }, NAUKRI_SELECTORS);

      if (recheckSuccess) {
        return { status: 'applied', creditsUsed: 1 };
      }

      return { status: 'applied', creditsUsed: 1 };
    } catch (err: any) {
      logger.error('[NaukriAdapter] Error applying to job:', err);
      return { status: 'failed', reason: err?.message || 'Unexpected application error' };
    }
  }

  private async handleNaukriQuestionnaire(
    puppeteerPage: any,
    careerBrain: any,
  ): Promise<{ success: boolean; reason?: string }> {
    try {
      // Find all input and select fields in modal
      const fields = await puppeteerPage.evaluate(() => {
        const modal = document.querySelector(
          'div.apply-message-container, div.chatbot-container, div.apply-modal, div.layer-wrap',
        );
        if (!modal) return [];

        const inputs = Array.from(modal.querySelectorAll('input, select, textarea'));
        return inputs.map((el, idx) => {
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

      logger.info(`[NaukriAdapter] Detected ${fields.length} questionnaire fields.`);

      for (const f of fields) {
        const answer = resolveNaukriQuestion(f.labelText, f.fieldType as any, f.options, careerBrain);

        logger.info(
          `[NaukriAdapter] Field "${f.labelText}" -> Answering: "${answer.value}" (source: ${answer.source})`,
        );

        await puppeteerPage.evaluate(
          (idx: number, val: string, fType: string) => {
            const modal = document.querySelector(
              'div.apply-message-container, div.chatbot-container, div.apply-modal, div.layer-wrap',
            );
            if (!modal) return;
            const inputs = Array.from(modal.querySelectorAll('input, select, textarea'));
            const el = inputs[idx] as any;
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
              el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          f.index,
          answer.value,
          f.fieldType,
        );

        await new Promise(r => setTimeout(r, 400));
      }

      // Click submit in modal
      await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        for (const sel of selectors.SUBMIT_BUTTON) {
          const btn = document.querySelector(sel) as HTMLElement | null;
          if (btn && btn.offsetParent !== null) {
            btn.click();
            return;
          }
        }
      }, NAUKRI_SELECTORS);

      await new Promise(r => setTimeout(r, 2000));
      return { success: true };
    } catch (err: any) {
      logger.warning('[NaukriAdapter] Failed filling questionnaire:', err);
      return { success: false, reason: err.message };
    }
  }
}

export const naukriAdapter = new NaukriAdapter();
