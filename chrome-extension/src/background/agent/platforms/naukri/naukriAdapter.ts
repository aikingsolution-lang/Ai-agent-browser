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
import { inspectAndHealFormErrors } from '../../intelligence';
import { sanitizeRoleSearchQuery } from '@extension/storage';
import { createLogger } from '@src/background/log';
import { solveQuestionAutonomousWithLLM } from '../../linkedin/formQuestionResolver';
import { getActiveChatModel } from '../../activeModelHelper';

const logger = createLogger('NaukriAdapter');

export class NaukriAdapter implements IPlatformAdapter {
  public readonly platformId: SupportedPlatform = 'naukri';
  public readonly displayName: string = 'Naukri.com';
  public readonly domainMatches: string[] = ['naukri.com'];

  public isMatchingUrl(url: string): boolean {
    if (!url) return false;
    return url.toLowerCase().includes('naukri.com');
  }

  public buildSearchUrl(
    role: string,
    location: string,
    candidateName?: string | (string | undefined | null)[],
  ): string {
    const cleanRole = sanitizeRoleSearchQuery(role, candidateName, 'Software Engineer');
    // Normalize city for Naukri (e.g. "Bengaluru, India" -> "Bengaluru")
    const cleanLoc = (location || '')
      .replace(/,\s*India\b/gi, '')
      .replace(/,\s*IN\b/gi, '')
      .trim();

    const roleSlug =
      cleanRole
        .toLowerCase()
        .replace(/[/\\|]+/g, '-')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'software-engineer';

    const hasSpecificCity =
      cleanLoc &&
      cleanLoc.toLowerCase() !== 'remote' &&
      cleanLoc.toLowerCase() !== 'all india' &&
      cleanLoc.toLowerCase() !== 'india';

    const locSlug = hasSpecificCity
      ? `-in-${cleanLoc
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')}`
      : '';

    const params = new URLSearchParams();
    params.set('k', cleanRole);
    if (hasSpecificCity) {
      params.set('l', cleanLoc);
    }
    // Sort by relevance/freshness
    params.set('nignbevent', 'auto_apply');

    return `https://www.naukri.com/${roleSlug}-jobs${locSlug}?${params.toString()}`;
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
          descriptionSnippet?: string;
        }> = [];

        // Query job containers
        const tupleElements = Array.from(document.querySelectorAll(selectors.JOB_TUPLES.join(', ')));
        const seenJobIds = new Set<string>();

        for (const el of tupleElements) {
          try {
            // Title & URL
            const titleEl = el.querySelector(selectors.JOB_TITLE.join(', ')) as HTMLAnchorElement | null;
            if (!titleEl) continue;

            const title = (titleEl.textContent || '').trim();
            const href = titleEl.getAttribute('href') || titleEl.href || '';
            if (!title || !href || href.startsWith('javascript:')) continue;

            const fullUrl = href.startsWith('http') ? href : `https://www.naukri.com${href}`;

            // Unique Job ID from URL or attribute
            let jobId = el.getAttribute('data-job-id') || '';
            if (!jobId) {
              const match = fullUrl.match(/-([0-9a-zA-Z]{6,30})(?:\?|$)/);
              jobId = match ? match[1] : String(Math.abs(hashString(fullUrl)));
            }

            // Deduplicate
            if (seenJobIds.has(jobId) || seenJobIds.has(fullUrl)) {
              continue;
            }
            seenJobIds.add(jobId);
            seenJobIds.add(fullUrl);

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

            // Extract tags / skills snippet
            const tagsEl = el.querySelectorAll(
              '.tags-gt .tag-li, .row5 ul li, .job-desc, [class*="tag" i], .job-description, .tagsAndDescription',
            );
            const snippet = Array.from(tagsEl)
              .map(t => (t.textContent || '').trim())
              .filter(Boolean)
              .join(' | ');

            results.push({
              jobId,
              title,
              company,
              url: fullUrl,
              location,
              experience,
              salary,
              isQuickApply: !isExternal,
              descriptionSnippet: snippet,
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
      if (
        currentUrl.includes('/jobs?') ||
        currentUrl.includes('-jobs') ||
        !job.jobId ||
        !currentUrl.includes(job.jobId.toLowerCase())
      ) {
        logger.info(`[NaukriAdapter] Navigating to job page: ${job.url}`);
        await puppeteerPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
          await page.navigateTo(job.url);
        });
        await new Promise(r => setTimeout(r, 4000));
      }

      // 2. Check if already applied
      const alreadyApplied = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        const text = (document.body.innerText || '').toLowerCase();
        return selectors.ALREADY_APPLIED_INDICATORS.some(ind => text.includes(ind));
      }, NAUKRI_SELECTORS);

      if (alreadyApplied) {
        return { status: 'skipped', reason: 'You already applied to this job earlier on Naukri.' };
      }

      // 3. Find Apply Button with strict priority: Direct Apply > External Site
      const applyBtnState = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        // Direct apply button has highest priority
        const directBtn = document.querySelector(
          'button#apply-button, button.apply-button, button.waves-effect',
        ) as HTMLElement | null;
        if (directBtn && directBtn.offsetParent !== null) {
          const directText = (directBtn.textContent || '').trim().toLowerCase();
          const isExt = selectors.EXTERNAL_APPLY_INDICATORS.some(ind => directText.includes(ind));
          return { found: true, isExternal: isExt, text: (directBtn.textContent || '').trim() };
        }

        // Dedicated external company site button
        const externalBtn = document.querySelector(
          'button#company-site-button, button.company-site-button, .company-site-button',
        ) as HTMLElement | null;
        if (externalBtn && externalBtn.offsetParent !== null) {
          return { found: true, isExternal: true, text: (externalBtn.textContent || '').trim() };
        }

        // Fallback: search visible action buttons
        const buttons = Array.from(document.querySelectorAll('button, a'));
        for (const b of buttons) {
          const bText = (b.textContent || '').trim().toLowerCase();
          if (bText === 'apply' || bText === 'quick apply') {
            return { found: true, isExternal: false, text: (b.textContent || '').trim() };
          }
          if (selectors.EXTERNAL_APPLY_INDICATORS.some(ind => bText.includes(ind))) {
            return { found: true, isExternal: true, text: (b.textContent || '').trim() };
          }
        }

        return { found: false, isExternal: false, text: '' };
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
        for (const sel of selectors.MODAL_CONTAINER) {
          const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          for (const el of els) {
            if (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none') {
              return { type: 'modal_open' };
            }
          }
        }

        // Fallback: check fixed/absolute containers with questionnaire content
        const allCandidates = Array.from(document.querySelectorAll('div, form, section, aside')) as HTMLElement[];
        for (const el of allCandidates) {
          const style = window.getComputedStyle(el);
          if ((style.position === 'fixed' || style.position === 'absolute') && style.display !== 'none') {
            const text = (el.innerText || '').toLowerCase();
            if (
              (text.includes('current ctc') ||
                text.includes('skip this question') ||
                text.includes('in lacs') ||
                text.includes('notice period')) &&
              el.querySelector('input, select, textarea, button')
            ) {
              return { type: 'modal_open' };
            }
          }
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
        const fillResult = await this.handleNaukriQuestionnaire(puppeteerPage, careerBrain, context);
        if (fillResult.success) {
          return { status: 'applied', creditsUsed: 1, modalOpened: true };
        }
        return { status: 'failed', reason: fillResult.reason || 'Could not complete questionnaire.' };
      }

      // If nothing changed immediately, wait an extra 2s and re-verify
      await new Promise(r => setTimeout(r, 2000));
      const secondaryCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        const bodyText = (document.body.innerText || '').toLowerCase();
        const success = selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
        if (success) {
          return { type: 'success' };
        }

        // Check if modal opened late
        for (const sel of selectors.MODAL_CONTAINER) {
          const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          for (const el of els) {
            if (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none') {
              return { type: 'modal_open' };
            }
          }
        }

        // Check if apply button text now says "applied"
        const applyBtns = Array.from(document.querySelectorAll('button, a'));
        for (const b of applyBtns) {
          const bt = (b.textContent || '').trim().toLowerCase();
          if (selectors.ALREADY_APPLIED_INDICATORS.some(ind => bt.includes(ind))) {
            return { type: 'success' };
          }
        }

        return { type: 'unknown' };
      }, NAUKRI_SELECTORS);

      if (secondaryCheck.type === 'success') {
        return { status: 'applied', creditsUsed: 1 };
      }

      if (secondaryCheck.type === 'modal_open') {
        logger.info('[NaukriAdapter] Questionnaire or Chatbot opened on secondary check. Solving questions...');
        const fillResult = await this.handleNaukriQuestionnaire(puppeteerPage, careerBrain, context);
        if (fillResult.success) {
          return { status: 'applied', creditsUsed: 1, modalOpened: true };
        }
        return { status: 'failed', reason: fillResult.reason || 'Could not complete questionnaire.' };
      }

      return { status: 'failed', reason: 'Application could not be confirmed after clicking apply button.' };
    } catch (err: any) {
      logger.error('[NaukriAdapter] Error applying to job:', err);
      return { status: 'failed', reason: err?.message || 'Unexpected application error' };
    }
  }

  private async handleNaukriQuestionnaire(
    puppeteerPage: any,
    careerBrain: any,
    context?: IPlatformExecutionContext,
  ): Promise<{ success: boolean; reason?: string }> {
    try {
      const MAX_STEPS = 6;
      let lastQuestionHandled = '';

      for (let step = 1; step <= MAX_STEPS; step++) {
        logger.info(`[NaukriAdapter] Handling questionnaire step ${step}/${MAX_STEPS}...`);

        // 1. Check if application is already completed or modal is closed
        const status = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          if (selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind))) {
            return { state: 'success' };
          }

          // Check if active modal/drawer is visible
          let modal: HTMLElement | null = null;
          for (const sel of selectors.MODAL_CONTAINER) {
            const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            for (const el of els) {
              if (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none') {
                modal = el;
                break;
              }
            }
            if (modal) break;
          }

          if (!modal) {
            // Check fallback fixed/absolute candidate
            const allCandidates = Array.from(document.querySelectorAll('div, form, section, aside')) as HTMLElement[];
            for (const el of allCandidates) {
              const style = window.getComputedStyle(el);
              if ((style.position === 'fixed' || style.position === 'absolute') && style.display !== 'none') {
                const text = (el.innerText || '').toLowerCase();
                if (
                  (text.includes('current ctc') ||
                    text.includes('skip this question') ||
                    text.includes('in lacs') ||
                    text.includes('notice period')) &&
                  el.querySelector('input, select, textarea, button')
                ) {
                  modal = el;
                  break;
                }
              }
            }
          }

          if (!modal) {
            return { state: 'closed' };
          }

          return { state: 'modal_open' };
        }, NAUKRI_SELECTORS);

        if (status.state === 'success') {
          logger.info(`[NaukriAdapter] Questionnaire completed successfully (success indicator found).`);
          return { success: true };
        }

        if (status.state === 'closed') {
          if (step > 1) {
            logger.info(`[NaukriAdapter] Modal closed after step ${step - 1}. Application presumed complete.`);
            return { success: true };
          }
          return { success: true };
        }

        // 2. Extract fields and skip button availability
        const stepData = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          let modal: HTMLElement | null = null;
          for (const sel of selectors.MODAL_CONTAINER) {
            const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            for (const el of els) {
              if (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none') {
                modal = el;
                break;
              }
            }
            if (modal) break;
          }

          if (!modal) {
            const allCandidates = Array.from(document.querySelectorAll('div, form, section, aside')) as HTMLElement[];
            for (const el of allCandidates) {
              const style = window.getComputedStyle(el);
              if ((style.position === 'fixed' || style.position === 'absolute') && style.display !== 'none') {
                const text = (el.innerText || '').toLowerCase();
                if (
                  (text.includes('current ctc') ||
                    text.includes('skip this question') ||
                    text.includes('in lacs') ||
                    text.includes('notice period')) &&
                  el.querySelector('input, select, textarea, button')
                ) {
                  modal = el;
                  break;
                }
              }
            }
          }

          if (!modal) return { fields: [], hasSkipBtn: false, modalHeading: '' };

          // Check for "Skip this question" button
          let hasSkipBtn = false;
          const allClickables = Array.from(modal.querySelectorAll('button, a, span, div')) as HTMLElement[];
          for (const c of allClickables) {
            const ct = (c.textContent || '').trim().toLowerCase();
            if (ct.includes('skip this question') || ct === 'skip question' || ct === 'skip') {
              hasSkipBtn = true;
              break;
            }
          }

          // Extract modal main heading
          const headEl = modal.querySelector(
            'h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="header" i], [class*="question" i]',
          );
          const modalHeading = (headEl?.textContent || '').trim();

          const inputs = Array.from(
            modal.querySelectorAll('input:not([type="hidden"]), select, textarea'),
          ) as HTMLElement[];
          const fields = inputs.map((el, idx) => {
            const placeholder = el.getAttribute('placeholder') || '';
            const name = el.getAttribute('name') || '';

            // Robust question text retrieval
            let labelText = '';
            if (el.getAttribute('aria-label')) {
              labelText = el.getAttribute('aria-label')!.trim();
            } else if (el.id) {
              const lbl = modal!.querySelector(`label[for="${el.id}"]`);
              if (lbl?.textContent?.trim()) labelText = lbl.textContent.trim();
            }
            if (!labelText) {
              const parentLabel = el.closest('label');
              if (parentLabel?.textContent?.trim()) labelText = parentLabel.textContent.trim();
            }
            if (!labelText) {
              let parent = el.parentElement;
              while (parent && parent !== modal && !labelText) {
                const qEl = parent.querySelector(
                  'h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="label" i], [class*="question" i], [class*="head" i]',
                );
                if (qEl && qEl !== el && qEl.textContent?.trim()) {
                  labelText = qEl.textContent.trim();
                  break;
                }
                parent = parent.parentElement;
              }
            }
            if (!labelText) {
              labelText = modalHeading || placeholder || name || '';
            }

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

            const currentValue = (el as HTMLInputElement).value || '';

            return {
              index: idx,
              labelText,
              placeholder,
              fieldType,
              options,
              currentValue,
            };
          });

          return { fields, hasSkipBtn, modalHeading };
        }, NAUKRI_SELECTORS);

        logger.info(
          `[NaukriAdapter] Step ${step}: Found ${stepData.fields.length} fields. Skip button present: ${stepData.hasSkipBtn}`,
        );

        let skippedField = false;

        // 3. Process fields
        for (const f of stepData.fields) {
          lastQuestionHandled = f.labelText;
          let answer = resolveNaukriQuestion(f.labelText, f.fieldType as any, f.options, careerBrain, f.placeholder);

          if (answer.confidence < 0.9 && (!answer.value || answer.confidence <= 0.4)) {
            try {
              const llm = context?.scopedLLM || (await getActiveChatModel(context?.runId)) || undefined;
              if (llm) {
                logger.info(`[NaukriAdapter] 🧠 Asking LLM to resolve field: "${f.labelText}"`);
                const llmFieldType =
                  f.fieldType === 'select'
                    ? 'dropdown'
                    : ['text', 'number', 'radio', 'checkbox'].includes(f.fieldType)
                      ? (f.fieldType as 'text' | 'number' | 'radio' | 'checkbox')
                      : 'text';
                const llmRes = await solveQuestionAutonomousWithLLM(
                  { label: f.labelText, fieldType: llmFieldType, options: f.options },
                  careerBrain,
                  llm,
                );
                if (llmRes.success && llmRes.answer) {
                  answer = { value: llmRes.answer, confidence: 0.99, source: 'profile' };
                  logger.info(`[NaukriAdapter] ✅ LLM resolved "${f.labelText}" -> "${answer.value}"`);
                }
              }
            } catch (err) {
              logger.warning(`[NaukriAdapter] LLM field resolution fallback error:`, err);
            }
          }

          // If answer is still empty, and modal has "Skip this question", click Skip!
          if (!answer.value && stepData.hasSkipBtn) {
            logger.info(
              `[NaukriAdapter] Field "${f.labelText}" has no resolved value. Clicking "Skip this question"...`,
            );
            await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
              let modal: HTMLElement | null = null;
              for (const sel of selectors.MODAL_CONTAINER) {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (el && (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none')) {
                  modal = el;
                  break;
                }
              }
              const container = modal || document.body;
              const skipEls = Array.from(container.querySelectorAll('button, a, span, div')) as HTMLElement[];
              for (const s of skipEls) {
                const st = (s.textContent || '').trim().toLowerCase();
                if (st.includes('skip this question') || st === 'skip question' || st === 'skip') {
                  s.click();
                  return;
                }
              }
            }, NAUKRI_SELECTORS);

            skippedField = true;
            await new Promise(r => setTimeout(r, 2000));
            break; // Skip advances to next question/step
          }

          logger.info(
            `[NaukriAdapter] Field "${f.labelText}" -> Answering: "${answer.value}" (source: ${answer.source})`,
          );

          // Fill into DOM
          await puppeteerPage.evaluate(
            (idx: number, val: string, fType: string, selectors: typeof NAUKRI_SELECTORS) => {
              let modal: HTMLElement | null = null;
              for (const sel of selectors.MODAL_CONTAINER) {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (el && (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none')) {
                  modal = el;
                  break;
                }
              }
              if (!modal) modal = document.body;

              const inputs = Array.from(
                modal.querySelectorAll('input:not([type="hidden"]), select, textarea'),
              ) as HTMLElement[];
              const el = inputs[idx] as any;
              if (!el) return;

              el.focus?.();

              if (fType === 'select') {
                let matchedIdx = -1;
                const vLower = val.toLowerCase().trim();
                for (let i = 0; i < el.options.length; i++) {
                  const optText = el.options[i].text.toLowerCase().trim();
                  const optVal = (el.options[i].value || '').toLowerCase().trim();
                  if (optText === vLower || optVal === vLower) {
                    matchedIdx = i;
                    break;
                  }
                  if (matchedIdx === -1 && (optText.includes(vLower) || vLower.includes(optText))) {
                    matchedIdx = i;
                  }
                }
                if (matchedIdx !== -1) {
                  el.selectedIndex = matchedIdx;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              } else if (fType === 'radio' || fType === 'checkbox') {
                el.checked = true;
                el.dispatchEvent(new Event('click', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                // Use native setter for React / modern web frameworks
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeSetter) {
                  nativeSetter.call(el, val);
                } else {
                  el.value = val;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
              }
            },
            f.index,
            answer.value,
            f.fieldType,
            NAUKRI_SELECTORS,
          );

          await new Promise(r => setTimeout(r, 400));
        }

        if (skippedField) {
          // Skip already dispatched action, continue to next step
          continue;
        }

        // 4. Heal any validation errors before submitting
        const preHealing = await inspectAndHealFormErrors({ puppeteerPage });
        if (preHealing.correctedCount > 0) {
          logger.info(`[NaukriAdapter] Self-healed ${preHealing.correctedCount} validation errors before submit.`);
        }

        // 5. Click Save / Submit / Next button (or fallback to Skip if disabled)
        const submitAction = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          let modal: HTMLElement | null = null;
          for (const sel of selectors.MODAL_CONTAINER) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none')) {
              modal = el;
              break;
            }
          }
          if (!modal) modal = document.body;

          // Find action button
          let actionBtn: HTMLElement | null = null;
          for (const sel of selectors.SUBMIT_BUTTON) {
            const btn = modal.querySelector(sel) as HTMLElement | null;
            if (btn && btn.offsetParent !== null) {
              actionBtn = btn;
              break;
            }
          }

          if (!actionBtn) {
            const allBtns = Array.from(modal.querySelectorAll('button, a')) as HTMLElement[];
            for (const b of allBtns) {
              const t = (b.textContent || '').trim().toLowerCase();
              if (
                t === 'save' ||
                t === 'save & next' ||
                t === 'save and next' ||
                t === 'next' ||
                t === 'submit' ||
                t === 'apply' ||
                t === 'continue'
              ) {
                actionBtn = b;
                break;
              }
            }
          }

          const isBtnDisabled =
            actionBtn &&
            ((actionBtn as HTMLButtonElement).disabled ||
              actionBtn.classList.contains('disabled') ||
              actionBtn.getAttribute('aria-disabled') === 'true');

          // If action button is disabled or missing, check if "Skip this question" is available
          if (!actionBtn || isBtnDisabled) {
            const skipEls = Array.from(modal.querySelectorAll('button, a, span, div')) as HTMLElement[];
            for (const s of skipEls) {
              const st = (s.textContent || '').trim().toLowerCase();
              if (st.includes('skip this question') || st === 'skip question' || st === 'skip') {
                s.click();
                return { clicked: true, action: 'skip_fallback' };
              }
            }
          }

          if (actionBtn && !isBtnDisabled) {
            actionBtn.click();
            return { clicked: true, action: 'save' };
          }

          return { clicked: false, reason: 'button_disabled_no_skip' };
        }, NAUKRI_SELECTORS);

        logger.info(`[NaukriAdapter] Step ${step} submit result: ${JSON.stringify(submitAction)}`);

        await new Promise(r => setTimeout(r, 2000));

        // Check if modal has closed or success appeared
        const postSubmitCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          const hasSuccess = selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
          if (hasSuccess) return { finished: true };

          let modalOpen = false;
          for (const sel of selectors.MODAL_CONTAINER) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && (el.offsetParent !== null || window.getComputedStyle(el).display !== 'none')) {
              modalOpen = true;
              break;
            }
          }
          return { finished: !modalOpen };
        }, NAUKRI_SELECTORS);

        if (postSubmitCheck.finished) {
          logger.info(`[NaukriAdapter] Application finished after step ${step}.`);
          return { success: true };
        }
      }

      // Check final state after loop
      const finalCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        const bodyText = (document.body.innerText || '').toLowerCase();
        return selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind));
      }, NAUKRI_SELECTORS);

      if (finalCheck) {
        return { success: true };
      }

      return {
        success: false,
        reason: `Questionnaire remained open after maximum steps. Last question: "${lastQuestionHandled}"`,
      };
    } catch (err: any) {
      logger.warning('[NaukriAdapter] Failed filling questionnaire:', err);
      return { success: false, reason: err.message };
    }
  }
}

export const naukriAdapter = new NaukriAdapter();
