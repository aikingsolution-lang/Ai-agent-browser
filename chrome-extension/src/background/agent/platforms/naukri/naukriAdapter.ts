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
import { resolveNaukriQuestion, resolveNaukriWithLLM } from './naukriResolver';
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

      // 2. Check if a CAPTCHA or verification screen appeared
      const hasVerificationWall = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        for (const sel of selectors.VERIFICATION_SELECTORS) {
          const el = document.querySelector(sel);
          if (el && (el as HTMLElement).offsetParent !== null) return true;
        }
        const text = (document.body.innerText || '').toLowerCase();
        return (
          text.includes('enter the otp') ||
          text.includes('verify your mobile') ||
          text.includes('verify your email') ||
          text.includes('complete the security check') ||
          text.includes('suspicious activity')
        );
      }, NAUKRI_SELECTORS);

      if (hasVerificationWall) {
        logger.warning(`[NaukriAdapter] 🛑 Verification wall / OTP detected for "${job.title}". Pausing.`);
        if (onLiveActivity) {
          onLiveActivity({
            jobId: job.jobId,
            url: job.url,
            title: job.title,
            company: job.company,
            status: 'needs_verification',
            reason: 'Naukri requested OTP or CAPTCHA verification. Please complete it in the runner tab.',
          });
        }
        return {
          status: 'skipped',
          reason: 'Naukri requested OTP or CAPTCHA verification. Complete it manually.',
        };
      }

      // 3. Check if already applied
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
        function robustClick(target: HTMLElement) {
          target.scrollIntoView({ behavior: 'instant', block: 'center' });
          target.focus();
          const opts = { bubbles: true, cancelable: true, view: window };
          target.dispatchEvent(new PointerEvent('pointerdown', opts));
          target.dispatchEvent(new MouseEvent('mousedown', opts));
          target.dispatchEvent(new PointerEvent('pointerup', opts));
          target.dispatchEvent(new MouseEvent('mouseup', opts));
          target.click();
        }

        for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && el.offsetParent !== null) {
            robustClick(el);
            return;
          }
        }
        const buttons = Array.from(document.querySelectorAll('button, a'));
        for (const b of buttons) {
          const bText = (b.textContent || '').trim().toLowerCase();
          if (bText === 'apply' || bText === 'apply on website') {
            robustClick(b as HTMLElement);
            return;
          }
        }
      }, NAUKRI_SELECTORS);

      // Wait 3s to inspect response
      await new Promise(r => setTimeout(r, 3000));

      // 5. Check if 1-Click apply succeeded or modal/questionnaire opened
      const postClickCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        function isVisible(el: HTMLElement): boolean {
          if (!el || el.offsetParent === null) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0' ||
            style.pointerEvents === 'none'
          ) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 50) return false;
          if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
            return false;
          }
          return true;
        }

        function findModal(): HTMLElement | null {
          // 1. Selector match
          for (const sel of selectors.MODAL_CONTAINER) {
            const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            for (const el of els) {
              if (isVisible(el)) {
                return el;
              }
            }
          }

          // 2. Chatbot or fixed modal overlay match
          const candidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
          for (const el of candidates) {
            const style = window.getComputedStyle(el);
            if ((style.position === 'fixed' || style.position === 'absolute') && isVisible(el)) {
              const text = (el.innerText || '').toLowerCase();
              if (
                text.includes("recruiter's questions") ||
                text.includes('kindly answer all') ||
                text.includes('type message here') ||
                text.includes('how many years of experience') ||
                text.includes('skip this question') ||
                text.includes('current ctc') ||
                text.includes('expected ctc') ||
                text.includes('notice period') ||
                text.includes('in lacs') ||
                (text.includes('save') && el.querySelector('input, textarea, [class*="chip" i], [class*="option" i]'))
              ) {
                return el;
              }
            }
          }
          return null;
        }

        function checkSuccess(): boolean {
          const bodyText = (document.body.innerText || '').toLowerCase();
          if (selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind))) {
            return true;
          }
          // Only inspect primary apply button for this job, NOT all buttons on document
          for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el)) {
              const bt = (el.textContent || '').trim().toLowerCase();
              if (
                bt === 'applied' ||
                bt === 'already applied' ||
                bt.startsWith('applied on') ||
                el.classList.contains('applied') ||
                el.classList.contains('already-applied')
              ) {
                return true;
              }
            }
          }
          return false;
        }

        // CRITICAL: Modal check MUST precede success check!
        const modal = findModal();
        if (modal) {
          return { type: 'modal_open' };
        }

        if (checkSuccess()) {
          return { type: 'success' };
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
        function isVisible(el: HTMLElement): boolean {
          if (!el || el.offsetParent === null) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0' ||
            style.pointerEvents === 'none'
          ) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 50) return false;
          if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
            return false;
          }
          return true;
        }

        function findModal(): HTMLElement | null {
          for (const sel of selectors.MODAL_CONTAINER) {
            const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            for (const el of els) {
              if (isVisible(el)) {
                return el;
              }
            }
          }

          const candidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
          for (const el of candidates) {
            const style = window.getComputedStyle(el);
            if ((style.position === 'fixed' || style.position === 'absolute') && isVisible(el)) {
              const text = (el.innerText || '').toLowerCase();
              if (
                text.includes("recruiter's questions") ||
                text.includes('kindly answer all') ||
                text.includes('type message here') ||
                text.includes('how many years of experience') ||
                text.includes('skip this question') ||
                text.includes('current ctc') ||
                text.includes('expected ctc') ||
                text.includes('notice period') ||
                text.includes('in lacs') ||
                (text.includes('save') && el.querySelector('input, textarea, [class*="chip" i], [class*="option" i]'))
              ) {
                return el;
              }
            }
          }
          return null;
        }

        function checkSuccess(): boolean {
          const bodyText = (document.body.innerText || '').toLowerCase();
          if (selectors.SUCCESS_INDICATORS.some(ind => bodyText.includes(ind))) {
            return true;
          }
          for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el)) {
              const bt = (el.textContent || '').trim().toLowerCase();
              if (
                bt === 'applied' ||
                bt === 'already applied' ||
                bt.startsWith('applied on') ||
                el.classList.contains('applied') ||
                el.classList.contains('already-applied')
              ) {
                return true;
              }
            }
          }
          return false;
        }

        // CRITICAL: Modal check MUST precede success check!
        const modal = findModal();
        if (modal) {
          return { type: 'modal_open' };
        }

        if (checkSuccess()) {
          return { type: 'success' };
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
      const MAX_STEPS = 15;
      let lastQuestionHandled = '';
      let consecutiveRepeats = 0;

      for (let step = 1; step <= MAX_STEPS; step++) {
        logger.info(`[NaukriAdapter] Handling questionnaire step ${step}/${MAX_STEPS}...`);

        // 1. Check if modal is still open or application is complete
        const status = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          function isVisible(el: HTMLElement): boolean {
            if (!el || el.offsetParent === null) return false;
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0' ||
              style.pointerEvents === 'none'
            ) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 50) return false;
            if (
              rect.right <= 0 ||
              rect.bottom <= 0 ||
              rect.left >= window.innerWidth ||
              rect.top >= window.innerHeight
            ) {
              return false;
            }
            return true;
          }

          function findModal(): HTMLElement | null {
            for (const sel of selectors.MODAL_CONTAINER) {
              const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
              for (const el of els) {
                if (isVisible(el)) return el;
              }
            }

            const candidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
            for (const el of candidates) {
              const style = window.getComputedStyle(el);
              if ((style.position === 'fixed' || style.position === 'absolute') && isVisible(el)) {
                const text = (el.innerText || '').toLowerCase();
                if (
                  text.includes("recruiter's questions") ||
                  text.includes('kindly answer all') ||
                  text.includes('type message here') ||
                  text.includes('how many years of experience') ||
                  text.includes('skip this question') ||
                  text.includes('current ctc') ||
                  text.includes('expected ctc') ||
                  text.includes('notice period') ||
                  text.includes('in lacs') ||
                  (text.includes('save') && el.querySelector('input, textarea, [class*="chip" i], [class*="option" i]'))
                ) {
                  return el;
                }
              }
            }
            return null;
          }

          const modal = findModal();
          if (!modal) {
            return { state: 'closed' };
          }

          const modalText = (modal.innerText || '').toLowerCase();
          if (
            modalText.includes('successfully applied') ||
            modalText.includes('application sent') ||
            modalText.includes('applied successfully') ||
            modalText.includes('your application has been sent')
          ) {
            return { state: 'success' };
          }

          return { state: 'modal_open' };
        }, NAUKRI_SELECTORS);

        if (status.state === 'success') {
          logger.info(`[NaukriAdapter] Questionnaire completed successfully (success indicator found in modal).`);
          return { success: true };
        }

        if (status.state === 'closed') {
          if (step > 1) {
            logger.info(`[NaukriAdapter] Modal closed after step ${step - 1}. Application presumed complete.`);
            return { success: true };
          }
          logger.info(`[NaukriAdapter] Modal was closed on step 1.`);
          return { success: true };
        }

        // 2. Extract active question, choice options, form fields, and skip button
        const stepData = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          function isVisible(el: HTMLElement): boolean {
            if (!el || el.offsetParent === null) return false;
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0' ||
              style.pointerEvents === 'none'
            ) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 50) return false;
            if (
              rect.right <= 0 ||
              rect.bottom <= 0 ||
              rect.left >= window.innerWidth ||
              rect.top >= window.innerHeight
            ) {
              return false;
            }
            return true;
          }

          function findModal(): HTMLElement | null {
            for (const sel of selectors.MODAL_CONTAINER) {
              const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
              for (const el of els) {
                if (isVisible(el)) return el;
              }
            }
            const candidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
            for (const el of candidates) {
              const style = window.getComputedStyle(el);
              if ((style.position === 'fixed' || style.position === 'absolute') && isVisible(el)) {
                const text = (el.innerText || '').toLowerCase();
                if (
                  text.includes("recruiter's questions") ||
                  text.includes('kindly answer all') ||
                  text.includes('type message here') ||
                  text.includes('how many years of experience') ||
                  text.includes('skip this question') ||
                  text.includes('current ctc') ||
                  text.includes('expected ctc') ||
                  text.includes('notice period') ||
                  text.includes('in lacs') ||
                  (text.includes('save') && el.querySelector('input, textarea, [class*="chip" i], [class*="option" i]'))
                ) {
                  return el;
                }
              }
            }
            return null;
          }

          const modal = findModal();
          if (!modal) {
            return {
              modalFound: false,
              fields: [],
              choiceOptions: [],
              activeQuestion: '',
              hasSkipBtn: false,
              modalHeading: '',
            };
          }

          // A. Extract question from Chatbot message bubbles
          let activeQuestion = '';
          const bubbleCandidates = Array.from(
            modal.querySelectorAll(selectors.CHATBOT_QUESTION_BUBBLE.join(', ') + ', div, p, span'),
          ) as HTMLElement[];

          const questionBubbles: string[] = [];
          for (const b of bubbleCandidates) {
            if (b.children.length > 2) continue;
            const txt = (b.textContent || '').trim();
            if (!txt || txt.length < 5 || txt.length > 300) continue;
            const lower = txt.toLowerCase();

            if (
              lower.includes('thank you for showing interest') ||
              lower.includes("recruiter's questions") ||
              lower.includes('kindly answer all') ||
              lower.startsWith('hi ') ||
              lower.startsWith('hello ')
            ) {
              continue;
            }

            if (
              txt.includes('?') ||
              lower.includes('how many') ||
              lower.includes('years') ||
              lower.includes('experience') ||
              lower.includes('notice') ||
              lower.includes('ctc') ||
              lower.includes('salary') ||
              lower.includes('current') ||
              lower.includes('expected') ||
              lower.includes('location') ||
              lower.includes('relocate')
            ) {
              questionBubbles.push(txt);
            }
          }

          if (questionBubbles.length > 0) {
            activeQuestion = questionBubbles[questionBubbles.length - 1];
          }

          const headEl = modal.querySelector(
            'h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="header" i], [class*="question" i]',
          );
          const modalHeading = (headEl?.textContent || '').trim();
          if (!activeQuestion) {
            activeQuestion = modalHeading;
          }

          // B. Check for "Skip this question" button
          let hasSkipBtn = false;
          const allClickables = Array.from(modal.querySelectorAll('button, a, span, div')) as HTMLElement[];
          for (const c of allClickables) {
            const ct = (c.textContent || '').trim().toLowerCase();
            if (ct.includes('skip this question') || ct === 'skip question' || ct === 'skip') {
              hasSkipBtn = true;
              break;
            }
          }

          // C. Extract Choice Options (e.g. "6+", "Less than 6", custom chips/radios)
          const choiceOptions: { text: string; index: number }[] = [];
          const choiceEls = Array.from(
            modal.querySelectorAll(
              selectors.CHATBOT_OPTIONS.join(', ') + ', label, li, [role="button"], [role="radio"], [role="checkbox"]',
            ),
          ) as HTMLElement[];

          const seenTexts = new Set<string>();
          let cIdx = 0;
          for (const c of choiceEls) {
            const cText = (c.textContent || '').trim();
            const cLower = cText.toLowerCase();
            if (
              !cText ||
              cText.length > 80 ||
              cLower === 'save' ||
              cLower.startsWith('save ') ||
              cLower === 'submit' ||
              cLower.includes('skip') ||
              cLower === 'cancel' ||
              cLower === 'close' ||
              cLower === 'x' ||
              cText === activeQuestion ||
              seenTexts.has(cLower)
            ) {
              continue;
            }
            if (
              cLower.includes('6+') ||
              cLower.includes('less than') ||
              cLower.includes('more than') ||
              cLower.includes('+') ||
              cLower.includes('-') ||
              cLower === 'yes' ||
              cLower === 'no' ||
              cLower.includes('immediate') ||
              cLower.includes('day') ||
              cLower.includes('month') ||
              cLower.includes('year') ||
              c.getAttribute('role') === 'radio' ||
              c.getAttribute('role') === 'checkbox' ||
              c.querySelector('input[type="radio"], input[type="checkbox"]') ||
              c.classList.contains('chip') ||
              c.classList.contains('option')
            ) {
              seenTexts.add(cLower);
              choiceOptions.push({ text: cText, index: cIdx++ });
            }
          }

          // D. Extract standard inputs
          let rawInputs = Array.from(
            modal.querySelectorAll(
              'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
            ),
          ) as HTMLElement[];

          let inputs = rawInputs.filter(el => isVisible(el));

          // If no inputs found inside modal, fallback to checking chatbot inputs in document
          if (inputs.length === 0) {
            const docInputs = Array.from(
              document.querySelectorAll(
                'input[placeholder*="Type message" i], textarea[placeholder*="Type message" i], input[placeholder*="message" i], textarea[placeholder*="message" i], input[type="text"]:not([type="hidden"]), textarea',
              ),
            ) as HTMLElement[];
            inputs = docInputs.filter(el => isVisible(el));
          }

          const fields = inputs.map((el, idx) => {
            const placeholder = el.getAttribute('placeholder') || '';
            const name = el.getAttribute('name') || '';

            let labelText = '';
            if (el.getAttribute('aria-label')) {
              labelText = el.getAttribute('aria-label')!.trim();
            } else if (el.id) {
              const lbl = modal.querySelector(`label[for="${el.id}"]`);
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
            if (!labelText || labelText.toLowerCase().includes('type message')) {
              labelText = activeQuestion || modalHeading || placeholder || name || '';
            }

            const tagName = el.tagName.toLowerCase();
            let fieldType = 'text';
            if (tagName === 'select') fieldType = 'select';
            else if (tagName === 'textarea') fieldType = 'text_long';
            else if (el.getAttribute('type') === 'radio') fieldType = 'radio';
            else if (el.getAttribute('type') === 'checkbox') fieldType = 'checkbox';
            else if (el.getAttribute('type') === 'number') fieldType = 'number';

            // If this is a chat message input and the question is descriptive, treat as text_long
            const isChatMsgInput =
              (placeholder || '').toLowerCase().includes('type message') ||
              (el.className || '').toLowerCase().includes('chat');
            const qLo = (labelText || '').toLowerCase();
            const isDescQ =
              qLo.startsWith('what is your experience') ||
              qLo.startsWith('how is your experience') ||
              qLo.includes('experience with') ||
              qLo.includes('describe your experience') ||
              qLo.includes('reason for') ||
              qLo.includes('why are you');
            if (isChatMsgInput && isDescQ) {
              fieldType = 'text_long';
            }

            const options: string[] = [];
            if (tagName === 'select') {
              const optEls = Array.from(el.querySelectorAll('option'));
              for (const o of optEls) {
                const t = (o.textContent || '').trim();
                if (t && !t.toLowerCase().includes('select')) options.push(t);
              }
            } else if (fieldType === 'radio' || fieldType === 'checkbox') {
              // Extract all options in this radio/checkbox group
              const inputName = (el as HTMLInputElement).name;
              const inputType = fieldType === 'radio' ? 'radio' : 'checkbox';
              const inputGroup = inputName
                ? (Array.from(
                    modal.querySelectorAll(`input[type="${inputType}"][name="${inputName}"]`),
                  ) as HTMLInputElement[])
                : [el as HTMLInputElement];
              for (const r of inputGroup) {
                const rLabel =
                  r.closest('label')?.textContent?.trim() ||
                  modal.querySelector(`label[for="${r.id}"]`)?.textContent?.trim() ||
                  r.parentElement?.textContent?.trim() ||
                  r.value;
                if (rLabel && !options.includes(rLabel)) options.push(rLabel);
              }
            }

            // Extract inline red error text if currently visible near this field
            let errorMessage = '';
            const container =
              el.closest(
                '.form-group, .input-container, .drawer-field, div[class*="field" i], div[class*="group" i], div[class*="wrap" i]',
              ) || el.parentElement;
            if (container) {
              const errEls = Array.from(
                container.querySelectorAll(
                  '.err-msg, .err, span.err, p.err, div.err, [class*="err-msg" i], [class*="field-error" i], [class*="error-msg" i], [class*="validation-err" i], [class*="validation-error" i], [class*="invalid" i], [class*="errorText" i]',
                ),
              ) as HTMLElement[];
              for (const er of errEls) {
                if (er !== el && !er.contains(el) && isVisible(er)) {
                  const et = (er.textContent || '').trim();
                  if (et && et.length >= 3 && !et.toLowerCase().includes('select')) {
                    errorMessage = et;
                    break;
                  }
                }
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
              errorMessage,
            };
          });

          return {
            modalFound: true,
            fields,
            choiceOptions,
            activeQuestion,
            hasSkipBtn,
            modalHeading,
          };
        }, NAUKRI_SELECTORS);

        const currentQuestion = stepData.activeQuestion || stepData.modalHeading || 'Unknown Question';
        if (currentQuestion === lastQuestionHandled && step > 1) {
          consecutiveRepeats++;
          logger.warning(
            `[NaukriAdapter] ⚠️ Stuck on question: "${currentQuestion}" (repeat count: ${consecutiveRepeats})`,
          );
        } else {
          consecutiveRepeats = 0;
          lastQuestionHandled = currentQuestion;
        }

        // Circuit breaker: If stuck on the exact same question for 2 consecutive cycles and Skip is available, click Skip to advance
        if (consecutiveRepeats >= 2 && stepData.hasSkipBtn) {
          logger.info(
            `[NaukriAdapter] ⏭️ Repeated step on "${lastQuestionHandled}" (${consecutiveRepeats} times). Clicking "Skip this question" to advance...`,
          );
          await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
            const skipEls = Array.from(document.querySelectorAll('button, a, span, div')) as HTMLElement[];
            for (const s of skipEls) {
              const st = (s.textContent || '').trim().toLowerCase();
              if (st.includes('skip this question') || st === 'skip question' || st === 'skip') {
                s.click();
                return;
              }
            }
          }, NAUKRI_SELECTORS);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        logger.info(
          `[NaukriAdapter] Step ${step}: Question: "${lastQuestionHandled}" | Options: ${stepData.choiceOptions.length} | Fields: ${stepData.fields.length} | Skip: ${stepData.hasSkipBtn}`,
        );

        let didAnswer = false;

        // 3A. Process Choice Options (Chatbot choice chips/radios)
        if (stepData.choiceOptions && stepData.choiceOptions.length > 0) {
          const optTexts = (stepData.choiceOptions as Array<{ text: string; index: number }>).map(
            (o: { text: string; index: number }) => o.text,
          );
          let resolvedChoice = resolveNaukriQuestion(lastQuestionHandled, 'radio', optTexts, careerBrain);

          // User request: Always consult LLM for radio/choice options if LLM is active
          try {
            const llm = context?.scopedLLM || (await getActiveChatModel(context?.runId)) || undefined;
            if (llm) {
              logger.info(`[NaukriAdapter] 🧠 Asking LLM to pick choice option for: "${lastQuestionHandled}"`);
              const llmRes = await resolveNaukriWithLLM(lastQuestionHandled, 'radio', optTexts, careerBrain, llm);
              if (llmRes.success && llmRes.answer) {
                resolvedChoice = { value: llmRes.answer, confidence: 0.99, source: 'profile' };
                logger.info(`[NaukriAdapter] ✅ LLM chose option: "${resolvedChoice.value}"`);
              }
            }
          } catch (err) {
            logger.warning('[NaukriAdapter] LLM choice option resolution error:', err);
          }

          logger.info(
            `[NaukriAdapter] Choice question "${lastQuestionHandled}" -> Resolved: "${resolvedChoice.value}"`,
          );

          const clickedChoice = await puppeteerPage.evaluate(
            (targetChoice: string, selectors: typeof NAUKRI_SELECTORS) => {
              function isVisible(el: HTMLElement): boolean {
                if (!el || el.offsetParent === null) return false;
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              }

              for (const sel of selectors.MODAL_CONTAINER) {
                const modal = document.querySelector(sel) as HTMLElement | null;
                if (modal && isVisible(modal)) {
                  const choiceEls = Array.from(
                    modal.querySelectorAll(
                      selectors.CHATBOT_OPTIONS.join(', ') +
                        ', label, li, [role="button"], [role="radio"], [role="checkbox"]',
                    ),
                  ) as HTMLElement[];

                  const tLower = targetChoice.toLowerCase().trim();
                  let bestEl: HTMLElement | null = null;
                  for (const el of choiceEls) {
                    const txt = (el.textContent || '').toLowerCase().trim();
                    if (txt === tLower) {
                      bestEl = el;
                      break;
                    }
                    if (!bestEl && (txt.includes(tLower) || tLower.includes(txt))) {
                      bestEl = el;
                    }
                  }

                  if (bestEl) {
                    // Check native radio/checkbox input if inside or linked to bestEl
                    const innerInput = (
                      bestEl.tagName.toLowerCase() === 'input'
                        ? bestEl
                        : bestEl.querySelector('input[type="radio"], input[type="checkbox"]')
                    ) as HTMLInputElement | null;
                    if (innerInput) {
                      try {
                        const proto = window.HTMLInputElement.prototype;
                        const desc = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
                        if (desc) desc.call(innerInput, true);
                        else innerInput.checked = true;
                        const tracker = (innerInput as any)._valueTracker;
                        if (tracker) tracker.setValue('');
                      } catch {}
                      innerInput.dispatchEvent(new Event('input', { bubbles: true }));
                      innerInput.dispatchEvent(new Event('change', { bubbles: true }));
                      innerInput.click?.();
                    }

                    // Dispatch full pointer and mouse events on the label or clickable element
                    const targetLabel = (
                      bestEl.tagName.toLowerCase() === 'label' ? bestEl : bestEl.closest('label')
                    ) as HTMLElement | null;
                    const elToClick = targetLabel || bestEl;
                    elToClick.scrollIntoView({ behavior: 'instant', block: 'center' });
                    elToClick.focus?.();
                    const mOpts = { bubbles: true, cancelable: true, view: window };
                    elToClick.dispatchEvent(new PointerEvent('pointerdown', mOpts));
                    elToClick.dispatchEvent(new MouseEvent('mousedown', mOpts));
                    elToClick.dispatchEvent(new PointerEvent('pointerup', mOpts));
                    elToClick.dispatchEvent(new MouseEvent('mouseup', mOpts));
                    elToClick.click();
                    elToClick.dispatchEvent(new MouseEvent('click', mOpts));
                    elToClick.dispatchEvent(new Event('change', mOpts));

                    const rect = elToClick.getBoundingClientRect();
                    return {
                      success: true,
                      x: rect.left + rect.width / 2,
                      y: rect.top + rect.height / 2,
                    };
                  }
                }
              }
              return { success: false, x: 0, y: 0 };
            },
            resolvedChoice.value,
            NAUKRI_SELECTORS,
          );

          if (clickedChoice?.success) {
            didAnswer = true;
            if (clickedChoice.x && clickedChoice.y && puppeteerPage?.mouse) {
              try {
                await puppeteerPage.mouse.click(clickedChoice.x, clickedChoice.y);
              } catch {}
            }
            await new Promise(r => setTimeout(r, 800));
          }
        }

        // 3B. Process Form Fields (Text, Number, Select, etc.)
        if (stepData.fields.length > 0) {
          for (const f of stepData.fields) {
            const qText = f.labelText || lastQuestionHandled;
            let answer = resolveNaukriQuestion(qText, f.fieldType as any, f.options, careerBrain, f.placeholder);
            const isLakhsQ = qText.toLowerCase().includes('lac') || qText.toLowerCase().includes('lakh');

            const isDescriptiveQ =
              qText.toLowerCase().startsWith('what is your experience') ||
              qText.toLowerCase().startsWith('how is your experience') ||
              qText.toLowerCase().includes('experience with') ||
              qText.toLowerCase().includes('describe your experience') ||
              qText.toLowerCase().includes('reason for') ||
              qText.toLowerCase().includes('why are you') ||
              f.fieldType === 'text_long';

            // Consult LLM if field has error, is low confidence, is CTC/Lakhs, radio group, or descriptive question
            try {
              const llm = context?.scopedLLM || (await getActiveChatModel(context?.runId)) || undefined;
              if (
                llm &&
                (!answer.value ||
                  answer.confidence < 0.95 ||
                  isLakhsQ ||
                  isDescriptiveQ ||
                  f.errorMessage ||
                  f.fieldType === 'radio')
              ) {
                logger.info(
                  `[NaukriAdapter] 🧠 Asking LLM for concise answer: "${qText}" ${f.errorMessage ? `(Error Hint: "${f.errorMessage}")` : ''}`,
                );
                const llmRes = await resolveNaukriWithLLM(
                  qText,
                  f.fieldType as any,
                  f.options,
                  careerBrain,
                  llm,
                  f.placeholder,
                  f.errorMessage,
                  f.currentValue,
                );
                if (llmRes.success && llmRes.answer) {
                  answer = { value: llmRes.answer, confidence: 0.99, source: 'profile' };
                  logger.info(`[NaukriAdapter] ✅ LLM resolved "${qText}" -> "${answer.value}"`);
                }
              }
            } catch (err) {
              logger.warning(`[NaukriAdapter] LLM field resolution error:`, err);
            }

            // Sanitize CTC in Lakhs prompt to pure Lakhs numeric (e.g. "7" or "7.5")
            if (isLakhsQ && answer.value) {
              const numMatch = answer.value.match(/(\d+(?:\.\d+)?)/);
              if (numMatch) {
                let num = parseFloat(numMatch[1]);
                if (num >= 1000) num = Number((num / 100000).toFixed(2));
                answer.value = String(num).replace(/\.00$/, '');
              } else {
                answer.value = '7';
              }
            }

            // Ensure fallback value if not resolved
            if (!answer.value) {
              if (isLakhsQ) {
                const yoe = careerBrain.yearsOfExperience ?? 3;
                answer = { value: String(Math.max(3, Math.round(yoe * 2.5))), confidence: 0.8, source: 'default' };
              } else if (f.fieldType === 'number') {
                const yoe = careerBrain.yearsOfExperience ?? 3;
                answer = { value: String(Math.max(1, yoe)), confidence: 0.7, source: 'default' };
              } else if (f.fieldType === 'select' && f.options.length > 0) {
                answer = { value: f.options[0], confidence: 0.6, source: 'default' };
              } else {
                answer = { value: 'Yes', confidence: 0.5, source: 'default' };
              }
            }

            logger.info(`[NaukriAdapter] Field "${qText}" -> Answering: "${answer.value}"`);

            const fillResult = await puppeteerPage.evaluate(
              (idx: number, val: string, fType: string, selectors: typeof NAUKRI_SELECTORS) => {
                function isVisible(el: HTMLElement): boolean {
                  if (!el || el.offsetParent === null) return false;
                  const style = window.getComputedStyle(el);
                  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                }

                let modal: HTMLElement | null = null;
                for (const sel of selectors.MODAL_CONTAINER) {
                  const el = document.querySelector(sel) as HTMLElement | null;
                  if (el && isVisible(el)) {
                    modal = el;
                    break;
                  }
                }
                if (!modal) {
                  const candidates = Array.from(
                    document.querySelectorAll('div, section, aside, form'),
                  ) as HTMLElement[];
                  for (const el of candidates) {
                    const style = window.getComputedStyle(el);
                    if ((style.position === 'fixed' || style.position === 'absolute') && isVisible(el)) {
                      const text = (el.innerText || '').toLowerCase();
                      if (
                        text.includes("recruiter's questions") ||
                        text.includes('kindly answer all') ||
                        text.includes('type message here') ||
                        text.includes('how many years of experience') ||
                        text.includes('skip this question') ||
                        text.includes('current ctc') ||
                        text.includes('expected ctc') ||
                        text.includes('notice period') ||
                        text.includes('in lacs') ||
                        (text.includes('save') &&
                          el.querySelector('input, textarea, [class*="chip" i], [class*="option" i]'))
                      ) {
                        modal = el;
                        break;
                      }
                    }
                  }
                }
                if (!modal) modal = document.body;

                let rawInputs = Array.from(
                  modal.querySelectorAll(
                    'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
                  ),
                ) as HTMLElement[];
                let inputs = rawInputs.filter(el => isVisible(el));
                if (inputs.length === 0) {
                  const docInputs = Array.from(
                    document.querySelectorAll(
                      'input[placeholder*="Type message" i], textarea[placeholder*="Type message" i], input[placeholder*="message" i], textarea[placeholder*="message" i], input[type="text"]:not([type="hidden"]), textarea',
                    ),
                  ) as HTMLElement[];
                  inputs = docInputs.filter(el => isVisible(el));
                }

                const el = inputs[idx] as any;
                if (!el) return { filled: false, error: 'element_not_found', x: 0, y: 0, isChatInput: false };

                if (el.tagName.toLowerCase() === 'input' && el.type === 'file')
                  return { filled: false, error: 'file_input', x: 0, y: 0, isChatInput: false };

                el.focus?.();

                function setNative(element: any, value: string) {
                  try {
                    const proto =
                      element instanceof HTMLTextAreaElement
                        ? window.HTMLTextAreaElement.prototype
                        : window.HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (desc) desc.call(element, value);
                    else element.value = value;
                    const tracker = element._valueTracker;
                    if (tracker) tracker.setValue(value);
                  } catch {
                    try {
                      element.value = value;
                    } catch {}
                  }
                }

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
                } else if (fType === 'radio') {
                  let targetRadio = el;
                  const radioName = el.name;
                  if (radioName) {
                    const allRadios = Array.from(
                      modal.querySelectorAll(`input[type="radio"][name="${radioName}"]`),
                    ) as HTMLInputElement[];
                    const vLower = val.toLowerCase().trim();
                    for (const r of allRadios) {
                      const rLabel = (
                        r.closest('label')?.textContent ||
                        modal.querySelector(`label[for="${r.id}"]`)?.textContent ||
                        r.parentElement?.textContent ||
                        r.value ||
                        ''
                      )
                        .toLowerCase()
                        .trim();
                      if (rLabel === vLower || rLabel.includes(vLower) || vLower.includes(rLabel)) {
                        targetRadio = r;
                        break;
                      }
                    }
                  }
                  try {
                    const proto = window.HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
                    if (desc) desc.call(targetRadio, true);
                    else targetRadio.checked = true;
                    const tracker = (targetRadio as any)._valueTracker;
                    if (tracker) tracker.setValue('');
                  } catch {}
                  targetRadio.dispatchEvent(new Event('input', { bubbles: true }));
                  targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
                  targetRadio.click?.();

                  const radioLabel = (targetRadio.closest('label') || targetRadio.parentElement) as HTMLElement | null;
                  if (radioLabel) {
                    radioLabel.focus?.();
                    const mOpts = { bubbles: true, cancelable: true, view: window };
                    radioLabel.dispatchEvent(new PointerEvent('pointerdown', mOpts));
                    radioLabel.dispatchEvent(new MouseEvent('mousedown', mOpts));
                    radioLabel.dispatchEvent(new PointerEvent('pointerup', mOpts));
                    radioLabel.dispatchEvent(new MouseEvent('mouseup', mOpts));
                    radioLabel.click?.();
                    radioLabel.dispatchEvent(new MouseEvent('click', mOpts));
                  }
                } else if (fType === 'checkbox') {
                  // Multiple choice checkboxes: check ALL matching options
                  const inputName = el.name;
                  const container =
                    el.closest(
                      '.form-group, .input-container, div[class*="field" i], div[class*="group" i], div[class*="checkbox" i]',
                    ) || modal;
                  const allCheckboxes = inputName
                    ? (Array.from(
                        modal.querySelectorAll(`input[type="checkbox"][name="${inputName}"]`),
                      ) as HTMLInputElement[])
                    : (Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]);

                  const targetValues = val
                    .split(/[,;\n]/)
                    .map(s => s.trim().toLowerCase())
                    .filter(Boolean);

                  const cbsToProcess = allCheckboxes.length > 0 ? allCheckboxes : [el];
                  for (const cb of cbsToProcess) {
                    const cbLabel = (
                      cb.closest('label')?.textContent ||
                      modal.querySelector(`label[for="${cb.id}"]`)?.textContent ||
                      cb.parentElement?.textContent ||
                      cb.value ||
                      ''
                    )
                      .toLowerCase()
                      .trim();

                    const shouldCheck =
                      targetValues.length === 0 ||
                      targetValues.some(tv => cbLabel === tv || cbLabel.includes(tv) || tv.includes(cbLabel));

                    if (shouldCheck) {
                      try {
                        const proto = window.HTMLInputElement.prototype;
                        const desc = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
                        if (desc) desc.call(cb, true);
                        else cb.checked = true;
                        const tracker = (cb as any)._valueTracker;
                        if (tracker) tracker.setValue('');
                      } catch {}
                      cb.dispatchEvent(new Event('input', { bubbles: true }));
                      cb.dispatchEvent(new Event('change', { bubbles: true }));
                      cb.click?.();

                      const cbLabelEl = (cb.closest('label') || cb.parentElement) as HTMLElement | null;
                      if (cbLabelEl) {
                        cbLabelEl.focus?.();
                        const mOpts = { bubbles: true, cancelable: true, view: window };
                        cbLabelEl.dispatchEvent(new PointerEvent('pointerdown', mOpts));
                        cbLabelEl.dispatchEvent(new MouseEvent('mousedown', mOpts));
                        cbLabelEl.dispatchEvent(new PointerEvent('pointerup', mOpts));
                        cbLabelEl.dispatchEvent(new MouseEvent('mouseup', mOpts));
                        cbLabelEl.click?.();
                        cbLabelEl.dispatchEvent(new MouseEvent('click', mOpts));
                      }
                    }
                  }
                } else {
                  // Text / Number / Textarea
                  setNative(el, '');
                  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                  setNative(el, val);
                  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: val }));
                  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: val.slice(-1) || '0' }));
                  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: val.slice(-1) || '0' }));
                  el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));

                  // If this is a chatbot input, also dispatch Enter
                  const isChatInput =
                    (el.placeholder || '').toLowerCase().includes('type message') ||
                    (el.className || '').toLowerCase().includes('chat');
                  if (isChatInput) {
                    el.dispatchEvent(
                      new KeyboardEvent('keydown', {
                        key: 'Enter',
                        code: 'Enter',
                        keyCode: 13,
                        which: 13,
                        bubbles: true,
                      }),
                    );
                    el.dispatchEvent(
                      new KeyboardEvent('keyup', {
                        key: 'Enter',
                        code: 'Enter',
                        keyCode: 13,
                        which: 13,
                        bubbles: true,
                      }),
                    );
                  }
                }

                // Check if inline red error alert is triggered
                let postFillError = '';
                const container =
                  el.closest(
                    '.form-group, .input-container, .drawer-field, div[class*="field" i], div[class*="group" i], div[class*="wrap" i]',
                  ) || el.parentElement;
                if (container) {
                  const errEls = Array.from(
                    container.querySelectorAll(
                      '.err-msg, .err, span.err, p.err, div.err, [class*="err-msg" i], [class*="field-error" i], [class*="error-msg" i], [class*="validation-err" i], [class*="validation-error" i], [class*="invalid" i], [class*="errorText" i]',
                    ),
                  ) as HTMLElement[];
                  for (const er of errEls) {
                    if (er !== el && !er.contains(el) && isVisible(er)) {
                      const et = (er.textContent || '').trim();
                      if (et && et.length >= 3 && !et.toLowerCase().includes('select')) {
                        postFillError = et;
                        break;
                      }
                    }
                  }
                }

                const rect = el.getBoundingClientRect();
                const isChatInput =
                  (el.placeholder || '').toLowerCase().includes('type message') ||
                  (el.className || '').toLowerCase().includes('chat') ||
                  el.closest('[class*="chat" i], [class*="bot" i]') !== null;

                return {
                  filled: true,
                  postFillError,
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  isChatInput,
                };
              },
              f.index,
              answer.value,
              f.fieldType,
              NAUKRI_SELECTORS,
            );

            // Execute trusted Puppeteer mouse click & keyboard typing so React controlled component state updates
            if (fillResult?.x && fillResult?.y && puppeteerPage?.mouse && puppeteerPage?.keyboard) {
              try {
                logger.info(
                  `[NaukriAdapter] ⌨️ Typing answer into field at (${Math.round(fillResult.x)}, ${Math.round(fillResult.y)}) using trusted keyboard...`,
                );
                await puppeteerPage.mouse.click(fillResult.x, fillResult.y);
                await new Promise(r => setTimeout(r, 80));

                await puppeteerPage.keyboard.down('Control');
                await puppeteerPage.keyboard.press('KeyA');
                await puppeteerPage.keyboard.up('Control');
                await puppeteerPage.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 50));

                await puppeteerPage.keyboard.type(answer.value, { delay: 10 });
                await new Promise(r => setTimeout(r, 100));

                if (fillResult.isChatInput) {
                  logger.info(`[NaukriAdapter] 💬 Pressing Enter key for chat input...`);
                  await puppeteerPage.keyboard.press('Enter');
                  await new Promise(r => setTimeout(r, 400));
                }
              } catch (keyErr) {
                logger.debug('[NaukriAdapter] Puppeteer keyboard typing failed:', keyErr);
              }
            }

            // Self-heal via LLM if an inline red error alert appeared
            if (fillResult?.postFillError) {
              logger.warning(
                `[NaukriAdapter] ⚠️ Inline red error alert detected: "${fillResult.postFillError}" for field "${qText}"`,
              );
              try {
                const llm = context?.scopedLLM || (await getActiveChatModel(context?.runId)) || undefined;
                if (llm) {
                  const healedRes = await resolveNaukriWithLLM(
                    qText,
                    f.fieldType as any,
                    f.options,
                    careerBrain,
                    llm,
                    f.placeholder,
                    fillResult.postFillError,
                    answer.value,
                  );
                  if (healedRes.success && healedRes.answer && healedRes.answer !== answer.value) {
                    logger.info(
                      `[NaukriAdapter] 🩺 LLM healed answer from "${answer.value}" -> "${healedRes.answer}" based on red alert hint.`,
                    );
                    answer.value = healedRes.answer;
                    await puppeteerPage.evaluate(
                      (idx: number, val: string) => {
                        const rawInputs = Array.from(
                          document.querySelectorAll(
                            'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
                          ),
                        ) as HTMLElement[];
                        const el = rawInputs.filter(e => e.offsetParent !== null)[idx] as any;
                        if (!el) return;
                        el.focus?.();
                        try {
                          const proto =
                            el instanceof HTMLTextAreaElement
                              ? window.HTMLTextAreaElement.prototype
                              : window.HTMLInputElement.prototype;
                          const desc = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                          if (desc) desc.call(el, val);
                          else el.value = val;
                          el._valueTracker?.setValue(val);
                        } catch {}
                        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: val }));
                        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
                      },
                      f.index,
                      answer.value,
                    );
                    if (fillResult.x && fillResult.y && puppeteerPage?.mouse && puppeteerPage?.keyboard) {
                      await puppeteerPage.mouse.click(fillResult.x, fillResult.y);
                      await new Promise(r => setTimeout(r, 60));
                      await puppeteerPage.keyboard.down('Control');
                      await puppeteerPage.keyboard.press('KeyA');
                      await puppeteerPage.keyboard.up('Control');
                      await puppeteerPage.keyboard.press('Backspace');
                      await puppeteerPage.keyboard.type(answer.value, { delay: 10 });
                      if (fillResult.isChatInput) {
                        await puppeteerPage.keyboard.press('Enter');
                      }
                    }
                  }
                }
              } catch (healErr) {
                logger.warning('[NaukriAdapter] Error during inline error self-healing:', healErr);
              }
            }

            didAnswer = true;
            await new Promise(r => setTimeout(r, 400));
          }
        }

        // 3C. Direct Chatbot Input Fallback (if no fields were extracted, but a chat/message input is present on screen)
        if (!didAnswer) {
          const directChatInfo = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
            function isVisible(el: HTMLElement | null): boolean {
              if (!el || el.offsetParent === null) return false;
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }
            const chatInputs = Array.from(
              document.querySelectorAll(
                'input[placeholder*="Type message" i], textarea[placeholder*="Type message" i], input[placeholder*="message" i], textarea[placeholder*="message" i], [contenteditable="true"]',
              ),
            ) as HTMLElement[];
            const activeInput = chatInputs.find(el => isVisible(el));
            if (!activeInput) return null;

            const rect = activeInput.getBoundingClientRect();
            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              placeholder: activeInput.getAttribute('placeholder') || '',
            };
          }, NAUKRI_SELECTORS);

          if (directChatInfo && directChatInfo.x && directChatInfo.y) {
            logger.info(
              `[NaukriAdapter] 💬 Detected direct chatbot input on screen. Resolving question: "${lastQuestionHandled}"...`,
            );
            let answer = resolveNaukriQuestion(
              lastQuestionHandled,
              'text',
              [],
              careerBrain,
              directChatInfo.placeholder,
            );
            try {
              const llm = context?.scopedLLM || (await getActiveChatModel(context?.runId)) || undefined;
              if (llm) {
                const llmRes = await resolveNaukriWithLLM(
                  lastQuestionHandled,
                  'text',
                  [],
                  careerBrain,
                  llm,
                  directChatInfo.placeholder,
                );
                if (llmRes.success && llmRes.answer) {
                  answer = { value: llmRes.answer, confidence: 0.99, source: 'profile' };
                }
              }
            } catch (llmErr) {
              logger.warning('[NaukriAdapter] Direct chat LLM resolution error:', llmErr);
            }

            if (answer.value && puppeteerPage?.mouse && puppeteerPage?.keyboard) {
              await puppeteerPage.mouse.click(directChatInfo.x, directChatInfo.y);
              await new Promise(r => setTimeout(r, 100));
              await puppeteerPage.keyboard.down('Control');
              await puppeteerPage.keyboard.press('KeyA');
              await puppeteerPage.keyboard.up('Control');
              await puppeteerPage.keyboard.press('Backspace');
              await new Promise(r => setTimeout(r, 50));
              await puppeteerPage.keyboard.type(answer.value, { delay: 10 });
              await new Promise(r => setTimeout(r, 150));
              await puppeteerPage.keyboard.press('Enter');
              didAnswer = true;
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }

        // 4. Heal any remaining validation errors across the modal
        const preHealing = await inspectAndHealFormErrors({ puppeteerPage });
        if (preHealing.correctedCount > 0) {
          logger.info(`[NaukriAdapter] Self-healed ${preHealing.correctedCount} validation errors before submit.`);
        }

        // 5. Click Save / Submit / Next button (or fallback to Skip if disabled or blocked)
        const submitAction = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          function isVisible(el: HTMLElement | null): boolean {
            if (!el || el.offsetParent === null) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }

          let modal: HTMLElement | null = null;
          for (const sel of selectors.MODAL_CONTAINER) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el)) {
              modal = el;
              break;
            }
          }
          if (!modal) modal = document.body;

          let actionBtn: HTMLElement | null = null;

          // Strategy 1: Look inside modal using SUBMIT_BUTTON selectors
          for (const sel of selectors.SUBMIT_BUTTON) {
            const btn = modal.querySelector(sel) as HTMLElement | null;
            if (btn && isVisible(btn)) {
              actionBtn = btn;
              break;
            }
          }

          // Strategy 2: Look inside modal by text
          if (!actionBtn) {
            const allBtns = Array.from(
              modal.querySelectorAll(
                'button, a, [role="button"], input[type="submit"], input[type="button"], div[class*="btn" i], span[class*="btn" i]',
              ),
            ) as HTMLElement[];
            for (const b of allBtns) {
              const t = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
              if (
                t === 'save' ||
                t === 'save & next' ||
                t === 'save and next' ||
                t === 'save and apply' ||
                t === 'save & continue' ||
                t === 'save details' ||
                t === 'next' ||
                t === 'submit' ||
                t === 'apply' ||
                t === 'continue' ||
                t === 'send' ||
                t === 'done' ||
                t.startsWith('save ') ||
                t.endsWith(' save')
              ) {
                if (isVisible(b)) {
                  actionBtn = b;
                  break;
                }
              }
            }
          }

          // Strategy 3: Look in modal's ancestors or document-wide using SUBMIT_BUTTON selectors
          if (!actionBtn) {
            for (const sel of selectors.SUBMIT_BUTTON) {
              const btn = document.querySelector(sel) as HTMLElement | null;
              if (btn && isVisible(btn)) {
                actionBtn = btn;
                break;
              }
            }
          }

          // Strategy 4: Document-wide exact/common button text search
          if (!actionBtn) {
            const allDocBtns = Array.from(
              document.querySelectorAll(
                'button, [role="button"], a.btn, a[class*="button" i], input[type="submit"], input[type="button"], div[class*="btn" i], span[class*="btn" i]',
              ),
            ) as HTMLElement[];
            for (const b of allDocBtns) {
              const t = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
              if (
                t === 'save' ||
                t === 'save & next' ||
                t === 'save and next' ||
                t === 'save and apply' ||
                t === 'save & continue' ||
                t === 'save details' ||
                t === 'next' ||
                t === 'submit' ||
                t === 'apply' ||
                t === 'continue' ||
                t === 'send' ||
                t === 'done' ||
                t.startsWith('save ') ||
                t.endsWith(' save')
              ) {
                if (isVisible(b)) {
                  actionBtn = b;
                  break;
                }
              }
            }
          }

          // Strategy 5: Partial text match for Save (excluding page-level buttons like "save job")
          if (!actionBtn) {
            const allDocBtns = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
            for (const b of allDocBtns) {
              const t = (b.textContent || '').trim().toLowerCase();
              if (
                (t.includes('save') || t.includes('submit')) &&
                !t.includes('save job') &&
                !t.includes('saved') &&
                isVisible(b)
              ) {
                actionBtn = b;
                break;
              }
            }
          }

          if (actionBtn) {
            // Un-disable button if artificially blocked by frontend state
            try {
              (actionBtn as HTMLButtonElement).disabled = false;
              actionBtn.classList.remove('disabled');
              actionBtn.removeAttribute('aria-disabled');
            } catch {}

            actionBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
            actionBtn.focus?.();
            const mOpts = { bubbles: true, cancelable: true, view: window };
            actionBtn.dispatchEvent(new PointerEvent('pointerover', mOpts));
            actionBtn.dispatchEvent(new PointerEvent('pointerenter', mOpts));
            actionBtn.dispatchEvent(new PointerEvent('pointerdown', mOpts));
            actionBtn.dispatchEvent(new MouseEvent('mousedown', mOpts));
            actionBtn.dispatchEvent(new PointerEvent('pointerup', mOpts));
            actionBtn.dispatchEvent(new MouseEvent('mouseup', mOpts));
            actionBtn.click();
            actionBtn.dispatchEvent(new MouseEvent('click', mOpts));

            // Also click child text/span element if present
            const childEl = actionBtn.querySelector('span, div, p') as HTMLElement | null;
            if (childEl) {
              childEl.click?.();
              childEl.dispatchEvent(new MouseEvent('click', mOpts));
            }

            // Form submit trigger fallback
            const form = (actionBtn as HTMLButtonElement).form || actionBtn.closest('form');
            if (form && typeof form.requestSubmit === 'function') {
              try {
                form.requestSubmit(actionBtn as HTMLButtonElement);
              } catch {}
            }

            const rect = actionBtn.getBoundingClientRect();
            return {
              clicked: true,
              action: 'save',
              text: (actionBtn.textContent || '').trim(),
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          }

          // If no submit button is found at all, check if a skip button exists to advance
          const skipEls = Array.from(document.querySelectorAll('button, a, span, div')) as HTMLElement[];
          for (const s of skipEls) {
            const st = (s.textContent || '').trim().toLowerCase();
            if (st.includes('skip this question') || st === 'skip question' || st === 'skip') {
              if (isVisible(s)) {
                s.click();
                return { clicked: true, action: 'skip_due_to_no_submit_button' };
              }
            }
          }

          return { clicked: false, reason: 'no_action_button' };
        }, NAUKRI_SELECTORS);

        logger.info(`[NaukriAdapter] Step ${step} submit result: ${JSON.stringify(submitAction)}`);

        // Perform trusted Puppeteer mouse click on the Save button coordinates if available
        if (submitAction?.clicked && submitAction?.x && submitAction?.y && puppeteerPage?.mouse) {
          try {
            logger.info(
              `[NaukriAdapter] 🖱️ Executing trusted mouse click on "${submitAction.text || 'Save'}" button at (${Math.round(submitAction.x)}, ${Math.round(submitAction.y)})`,
            );
            await puppeteerPage.mouse.click(submitAction.x, submitAction.y);
          } catch (mErr) {
            logger.debug('[NaukriAdapter] Puppeteer mouse.click fallback failed:', mErr);
          }
        }

        // Wait for modal transition or next question
        await new Promise(r => setTimeout(r, 2500));

        // 6. Check if modal has closed or application succeeded
        const postSubmitCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          function isVisible(el: HTMLElement): boolean {
            if (!el || el.offsetParent === null) return false;
            const style = window.getComputedStyle(el);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0' ||
              style.pointerEvents === 'none'
            ) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 50) return false;
            if (
              rect.right <= 0 ||
              rect.bottom <= 0 ||
              rect.left >= window.innerWidth ||
              rect.top >= window.innerHeight
            ) {
              return false;
            }
            return true;
          }

          let modalOpen = false;
          for (const sel of selectors.MODAL_CONTAINER) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el)) {
              modalOpen = true;
              const modalText = (el.innerText || '').toLowerCase();
              if (
                modalText.includes('successfully applied') ||
                modalText.includes('application sent') ||
                modalText.includes('applied successfully') ||
                modalText.includes('your application has been sent')
              ) {
                return { finished: true };
              }
              break;
            }
          }

          if (!modalOpen) {
            return { finished: true };
          }

          return { finished: false };
        }, NAUKRI_SELECTORS);

        if (postSubmitCheck.finished) {
          logger.info(`[NaukriAdapter] Application finished after step ${step}. Modal closed.`);
          return { success: true };
        }
      }

      // Check final state after loop: Only succeed if modal is ACTUALLY closed or shows success message
      const finalCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        function isVisible(el: HTMLElement): boolean {
          if (!el || el.offsetParent === null) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }

        for (const sel of selectors.MODAL_CONTAINER) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && isVisible(el)) {
            const modalText = (el.innerText || '').toLowerCase();
            if (
              modalText.includes('successfully applied') ||
              modalText.includes('application sent') ||
              modalText.includes('applied successfully') ||
              modalText.includes('your application has been sent')
            ) {
              return true; // Application completed successfully!
            }
            return false; // Modal is still open!
          }
        }
        return true;
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
