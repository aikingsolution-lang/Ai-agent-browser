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
import { inspectAndHealFormErrors, validateAnswerForField } from '../../intelligence';
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

  /**
   * Helper: Monitors for manual OTP or CAPTCHA resolution on Naukri.
   * Auto-resumes as soon as the verification wall or OTP modal clears.
   */
  public async waitForManualVerification(
    puppeteerPage: any,
    context: IPlatformExecutionContext,
    job: IJobQueueItem,
    timeoutMs: number = 90000,
  ): Promise<boolean> {
    const startTime = Date.now();
    logger.info(`[NaukriAdapter] 🛡️ Waiting up to ${timeoutMs / 1000}s for manual OTP / verification check...`);

    if (context.onLiveActivity) {
      context.onLiveActivity({
        jobId: job.jobId,
        url: job.url,
        title: job.title,
        company: job.company,
        status: 'needs_verification',
        reason:
          'Naukri requested OTP or CAPTCHA verification. Please complete it in the runner tab — JobPilot AI will auto-resume!',
      });
    }

    while (Date.now() - startTime < timeoutMs) {
      if (context.signal?.aborted) {
        logger.info('[NaukriAdapter] Abort signal received while waiting for verification.');
        return false;
      }

      await new Promise(r => setTimeout(r, 2500));

      const isStillPresent = await puppeteerPage
        .evaluate((selectors: typeof NAUKRI_SELECTORS) => {
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
        }, NAUKRI_SELECTORS)
        .catch(() => false);

      if (!isStillPresent) {
        logger.info(`[NaukriAdapter] ✅ Verification wall cleared! Resuming application for "${job.title}".`);
        if (context.onLiveActivity) {
          context.onLiveActivity({
            jobId: job.jobId,
            url: job.url,
            title: job.title,
            company: job.company,
            status: 'running',
            reason: 'Verification completed. Resuming application...',
          });
        }
        await new Promise(r => setTimeout(r, 2000));
        return true;
      }
    }

    logger.warning(`[NaukriAdapter] Verification wait timed out after ${timeoutMs / 1000}s.`);
    return false;
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
        logger.warning(
          `[NaukriAdapter] 🛑 Verification wall / OTP detected for "${job.title}". Pausing for manual completion...`,
        );
        const solved = await this.waitForManualVerification(puppeteerPage, context, job, 90000);
        if (!solved) {
          return {
            status: 'skipped',
            reason: 'Naukri requested OTP or CAPTCHA verification. Timed out waiting for manual completion.',
          };
        }
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
          if (rect.width < 10 || rect.height < 10) return false;
          if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
            return false;
          }
          return true;
        }

        function isUpsellElement(el: HTMLElement | null): boolean {
          if (!el) return false;
          let cur: HTMLElement | null = el;
          while (cur && cur !== document.body) {
            const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
            for (const term of selectors.UPSELL_EXCLUSIONS || []) {
              if (text.includes(term.toLowerCase())) return true;
            }
            cur = cur.parentElement;
          }
          return false;
        }

        function evaluateSuccess(): { isSuccess: boolean; signals: string[]; confidence: 'high' | 'medium' | 'none' } {
          const signals: string[] = [];
          const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();

          // Signal 1: Text "Applied to <Job/Company>" or standard success phrases
          const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
          const appliedToMatch = bodyText.match(appliedToRegex);
          if (appliedToMatch) {
            signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
          }

          for (const ind of selectors.SUCCESS_INDICATORS) {
            if (ind.startsWith('.')) continue;
            if (bodyText.includes(ind.toLowerCase())) {
              if (!signals.some(s => s.startsWith('text:'))) {
                signals.push(`text: ${ind}`);
              }
              break;
            }
          }

          // Signal 2: Green check banner, .apply-message, success icons
          for (const sel of selectors.SUCCESS_BANNERS || []) {
            try {
              const bannerEls = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
              for (const b of bannerEls) {
                if (isVisible(b)) {
                  signals.push(`banner: ${sel}`);
                  break;
                }
              }
            } catch {}
            if (signals.some(s => s.startsWith('banner:'))) break;
          }

          if (!signals.some(s => s.startsWith('banner:'))) {
            const successIcons = Array.from(document.querySelectorAll('svg, i, span, div')) as HTMLElement[];
            for (const icon of successIcons) {
              if (isVisible(icon)) {
                const cls = (icon.className && typeof icon.className === 'string' ? icon.className : '').toLowerCase();
                if (
                  cls.includes('success') ||
                  cls.includes('greentick') ||
                  cls.includes('green-tick') ||
                  cls.includes('check-icon')
                ) {
                  signals.push('banner: success-icon');
                  break;
                }
              }
            }
          }

          // Signal 3: Primary apply button state
          for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el)) {
              const bt = (el.textContent || '').trim().toLowerCase();
              if (
                bt === 'applied' ||
                bt === 'already applied' ||
                bt.startsWith('applied on') ||
                bt.startsWith('applied to') ||
                el.classList.contains('applied') ||
                el.classList.contains('already-applied')
              ) {
                signals.push(`button: ${bt || 'applied'}`);
                break;
              }
            }
          }

          // Signal 4: URL or DOM markers
          try {
            const href = window.location.href.toLowerCase();
            if (href.includes('applied=true') || href.includes('/applied')) {
              signals.push('url: applied');
            }
          } catch {}

          const alreadyAppliedBadge = document.querySelector(
            '.applied-badge, .already-applied, [data-qa*="applied" i]',
          ) as HTMLElement | null;
          if (alreadyAppliedBadge && isVisible(alreadyAppliedBadge)) {
            signals.push('marker: applied-badge');
          }

          const isSuccess = signals.length > 0;
          const confidence = signals.length >= 2 ? 'high' : signals.length === 1 ? 'medium' : 'none';
          return { isSuccess, signals, confidence };
        }

        function findRealQuestionnaire(): HTMLElement | null {
          const candidates: HTMLElement[] = [];
          for (const sel of selectors.MODAL_CONTAINER) {
            const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            for (const el of els) {
              if (isVisible(el) && !candidates.includes(el)) {
                candidates.push(el);
              }
            }
          }

          const fixedCandidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
          for (const el of fixedCandidates) {
            const style = window.getComputedStyle(el);
            if (
              (style.position === 'fixed' || style.position === 'absolute') &&
              isVisible(el) &&
              !candidates.includes(el)
            ) {
              candidates.push(el);
            }
          }

          for (const modal of candidates) {
            const text = (modal.innerText || '').toLowerCase();

            // EXPLICIT EXCLUSION: Post-apply drawer (quiz, upsell, "Problem of the day", etc.)
            const isUpsell = (selectors.UPSELL_EXCLUSIONS || []).some((term: string) =>
              text.includes(term.toLowerCase()),
            );
            if (isUpsell) {
              continue;
            }

            const isPostApplySuccess =
              text.includes('applied to') ||
              text.includes('successfully applied') ||
              text.includes('application sent') ||
              text.includes('applied successfully') ||
              text.includes('your application has been sent');

            const inputs = Array.from(
              modal.querySelectorAll(
                'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [contenteditable="true"]',
              ),
            ).filter(i => !isUpsellElement(i as HTMLElement));

            const options = Array.from(
              modal.querySelectorAll(selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]'),
            ).filter(o => !isUpsellElement(o as HTMLElement));

            if (inputs.length === 0 && options.length === 0) {
              continue;
            }

            if (isPostApplySuccess) {
              const hasRecruiterKeywords =
                text.includes("recruiter's questions") ||
                text.includes('kindly answer') ||
                text.includes('screening questions');
              if (!hasRecruiterKeywords) {
                continue;
              }
            }

            const hasRecruiterKeywords =
              text.includes("recruiter's questions") ||
              text.includes('kindly answer all') ||
              text.includes('answer recruiter') ||
              text.includes('type message here') ||
              text.includes('how many years of experience') ||
              text.includes('skip this question') ||
              text.includes('current ctc') ||
              text.includes('expected ctc') ||
              text.includes('notice period') ||
              text.includes('in lacs') ||
              text.includes('screening questions') ||
              text.includes('relevant experience') ||
              text.includes('relocate') ||
              (text.includes('save') && (inputs.length > 0 || options.length > 0));

            const hasSubmitBtn = Array.from(modal.querySelectorAll(selectors.SUBMIT_BUTTON.join(', '))).some(b =>
              isVisible(b as HTMLElement),
            );

            if ((hasRecruiterKeywords || hasSubmitBtn) && (inputs.length > 0 || options.length > 0)) {
              return modal;
            }
          }
          return null;
        }

        // REQUIRED: Check success BEFORE modal/questionnaire check!
        const successEvaluation = evaluateSuccess();
        if (successEvaluation.isSuccess) {
          return { type: 'success', signals: successEvaluation.signals };
        }

        const modal = findRealQuestionnaire();
        if (modal) {
          return { type: 'modal_open' };
        }

        return { type: 'unknown' };
      }, NAUKRI_SELECTORS);

      if (postClickCheck.type === 'success') {
        logger.info(
          `[NaukriAdapter] Direct 1-Click apply succeeded! Signals: ${postClickCheck.signals?.join(', ') || 'verified'}`,
        );
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
          if (rect.width < 10 || rect.height < 10) return false;
          if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
            return false;
          }
          return true;
        }

        function isUpsellElement(el: HTMLElement | null): boolean {
          if (!el) return false;
          let cur: HTMLElement | null = el;
          while (cur && cur !== document.body) {
            const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
            for (const term of selectors.UPSELL_EXCLUSIONS || []) {
              if (text.includes(term.toLowerCase())) return true;
            }
            cur = cur.parentElement;
          }
          return false;
        }

        function evaluateSuccess(): { isSuccess: boolean; signals: string[]; confidence: 'high' | 'medium' | 'none' } {
          const signals: string[] = [];
          const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();

          // Signal 1: Text "Applied to <Job/Company>" or standard success phrases
          const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
          const appliedToMatch = bodyText.match(appliedToRegex);
          if (appliedToMatch) {
            signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
          }

          for (const ind of selectors.SUCCESS_INDICATORS) {
            if (ind.startsWith('.')) continue;
            if (bodyText.includes(ind.toLowerCase())) {
              if (!signals.some(s => s.startsWith('text:'))) {
                signals.push(`text: ${ind}`);
              }
              break;
            }
          }

          // Signal 2: Green check banner, .apply-message, success icons
          for (const sel of selectors.SUCCESS_BANNERS || []) {
            try {
              const bannerEls = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
              for (const b of bannerEls) {
                if (isVisible(b)) {
                  signals.push(`banner: ${sel}`);
                  break;
                }
              }
            } catch {}
            if (signals.some(s => s.startsWith('banner:'))) break;
          }

          if (!signals.some(s => s.startsWith('banner:'))) {
            const successIcons = Array.from(document.querySelectorAll('svg, i, span, div')) as HTMLElement[];
            for (const icon of successIcons) {
              if (isVisible(icon)) {
                const cls = (icon.className && typeof icon.className === 'string' ? icon.className : '').toLowerCase();
                if (
                  cls.includes('success') ||
                  cls.includes('greentick') ||
                  cls.includes('green-tick') ||
                  cls.includes('check-icon')
                ) {
                  signals.push('banner: success-icon');
                  break;
                }
              }
            }
          }

          // Signal 3: Primary apply button state
          for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el)) {
              const bt = (el.textContent || '').trim().toLowerCase();
              if (
                bt === 'applied' ||
                bt === 'already applied' ||
                bt.startsWith('applied on') ||
                bt.startsWith('applied to') ||
                el.classList.contains('applied') ||
                el.classList.contains('already-applied')
              ) {
                signals.push(`button: ${bt || 'applied'}`);
                break;
              }
            }
          }

          // Signal 4: URL or DOM markers
          try {
            const href = window.location.href.toLowerCase();
            if (href.includes('applied=true') || href.includes('/applied')) {
              signals.push('url: applied');
            }
          } catch {}

          const alreadyAppliedBadge = document.querySelector(
            '.applied-badge, .already-applied, [data-qa*="applied" i]',
          ) as HTMLElement | null;
          if (alreadyAppliedBadge && isVisible(alreadyAppliedBadge)) {
            signals.push('marker: applied-badge');
          }

          const isSuccess = signals.length > 0;
          const confidence = signals.length >= 2 ? 'high' : signals.length === 1 ? 'medium' : 'none';
          return { isSuccess, signals, confidence };
        }

        function findRealQuestionnaire(): HTMLElement | null {
          const candidates: HTMLElement[] = [];
          for (const sel of selectors.MODAL_CONTAINER) {
            const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            for (const el of els) {
              if (isVisible(el) && !candidates.includes(el)) {
                candidates.push(el);
              }
            }
          }

          const fixedCandidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
          for (const el of fixedCandidates) {
            const style = window.getComputedStyle(el);
            if (
              (style.position === 'fixed' || style.position === 'absolute') &&
              isVisible(el) &&
              !candidates.includes(el)
            ) {
              candidates.push(el);
            }
          }

          for (const modal of candidates) {
            const text = (modal.innerText || '').toLowerCase();

            // EXPLICIT EXCLUSION: Post-apply drawer (quiz, upsell, "Problem of the day", etc.)
            const isUpsell = (selectors.UPSELL_EXCLUSIONS || []).some((term: string) =>
              text.includes(term.toLowerCase()),
            );
            if (isUpsell) {
              continue;
            }

            const isPostApplySuccess =
              text.includes('applied to') ||
              text.includes('successfully applied') ||
              text.includes('application sent') ||
              text.includes('applied successfully') ||
              text.includes('your application has been sent');

            const inputs = Array.from(
              modal.querySelectorAll(
                'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [contenteditable="true"]',
              ),
            ).filter(i => !isUpsellElement(i as HTMLElement));

            const options = Array.from(
              modal.querySelectorAll(selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]'),
            ).filter(o => !isUpsellElement(o as HTMLElement));

            if (inputs.length === 0 && options.length === 0) {
              continue;
            }

            if (isPostApplySuccess) {
              const hasRecruiterKeywords =
                text.includes("recruiter's questions") ||
                text.includes('kindly answer') ||
                text.includes('screening questions');
              if (!hasRecruiterKeywords) {
                continue;
              }
            }

            const hasRecruiterKeywords =
              text.includes("recruiter's questions") ||
              text.includes('kindly answer all') ||
              text.includes('answer recruiter') ||
              text.includes('type message here') ||
              text.includes('how many years of experience') ||
              text.includes('skip this question') ||
              text.includes('current ctc') ||
              text.includes('expected ctc') ||
              text.includes('notice period') ||
              text.includes('in lacs') ||
              text.includes('screening questions') ||
              text.includes('relevant experience') ||
              text.includes('relocate') ||
              (text.includes('save') && (inputs.length > 0 || options.length > 0));

            const hasSubmitBtn = Array.from(modal.querySelectorAll(selectors.SUBMIT_BUTTON.join(', '))).some(b =>
              isVisible(b as HTMLElement),
            );

            if ((hasRecruiterKeywords || hasSubmitBtn) && (inputs.length > 0 || options.length > 0)) {
              return modal;
            }
          }
          return null;
        }

        // REQUIRED: Check success BEFORE modal/questionnaire check!
        const successEvaluation = evaluateSuccess();
        if (successEvaluation.isSuccess) {
          return { type: 'success', signals: successEvaluation.signals };
        }

        const modal = findRealQuestionnaire();
        if (modal) {
          return { type: 'modal_open' };
        }

        // Last verification step: inspect primary apply button on page
        for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            const bt = (el.textContent || '').trim().toLowerCase();
            if (
              bt === 'applied' ||
              bt === 'already applied' ||
              bt.startsWith('applied on') ||
              bt.startsWith('applied to') ||
              el.classList.contains('applied') ||
              el.classList.contains('already-applied')
            ) {
              return { type: 'success', signals: [`button: ${bt || 'applied'}`] };
            }
          }
        }

        return { type: 'unknown' };
      }, NAUKRI_SELECTORS);

      if (secondaryCheck.type === 'success') {
        logger.info(
          `[NaukriAdapter] Direct apply succeeded on secondary check! Signals: ${secondaryCheck.signals?.join(', ') || 'verified'}`,
        );
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

        // 1. Check if success is ALREADY achieved or application is complete BEFORE looking for modal
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
            if (rect.width < 10 || rect.height < 10) return false;
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

          function isUpsellElement(el: HTMLElement | null): boolean {
            if (!el) return false;
            let cur: HTMLElement | null = el;
            while (cur && cur !== document.body) {
              const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
              for (const term of selectors.UPSELL_EXCLUSIONS || []) {
                if (text.includes(term.toLowerCase())) return true;
              }
              cur = cur.parentElement;
            }
            return false;
          }

          function evaluateSuccess(): {
            isSuccess: boolean;
            signals: string[];
            confidence: 'high' | 'medium' | 'none';
          } {
            const signals: string[] = [];
            const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();

            // 1. Text signal: "Applied to <Job/Company>" or standard success phrases
            const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
            const appliedToMatch = bodyText.match(appliedToRegex);
            if (appliedToMatch) {
              signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
            }

            for (const ind of selectors.SUCCESS_INDICATORS) {
              if (ind.startsWith('.')) continue;
              if (bodyText.includes(ind.toLowerCase())) {
                if (!signals.some(s => s.startsWith('text:'))) {
                  signals.push(`text: ${ind}`);
                }
                break;
              }
            }

            // 2. Banner / Green tick / Icon signal
            for (const sel of selectors.SUCCESS_BANNERS || []) {
              try {
                const bannerEls = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
                for (const b of bannerEls) {
                  if (isVisible(b)) {
                    signals.push(`banner: ${sel}`);
                    break;
                  }
                }
              } catch {}
              if (signals.some(s => s.startsWith('banner:'))) break;
            }

            if (!signals.some(s => s.startsWith('banner:'))) {
              const successIcons = Array.from(document.querySelectorAll('svg, i, span, div')) as HTMLElement[];
              for (const icon of successIcons) {
                if (isVisible(icon)) {
                  const cls = (
                    icon.className && typeof icon.className === 'string' ? icon.className : ''
                  ).toLowerCase();
                  if (
                    cls.includes('success') ||
                    cls.includes('greentick') ||
                    cls.includes('green-tick') ||
                    cls.includes('check-icon')
                  ) {
                    signals.push('banner: success-icon');
                    break;
                  }
                }
              }
            }

            // 3. Primary apply button state
            for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (el && isVisible(el)) {
                const bt = (el.textContent || '').trim().toLowerCase();
                if (
                  bt === 'applied' ||
                  bt === 'already applied' ||
                  bt.startsWith('applied on') ||
                  bt.startsWith('applied to') ||
                  el.classList.contains('applied') ||
                  el.classList.contains('already-applied')
                ) {
                  signals.push(`button: ${bt || 'applied'}`);
                  break;
                }
              }
            }

            // 4. URL or DOM markers
            try {
              const href = window.location.href.toLowerCase();
              if (href.includes('applied=true') || href.includes('/applied')) {
                signals.push('url: applied');
              }
            } catch {}

            const alreadyAppliedBadge = document.querySelector(
              '.applied-badge, .already-applied, [data-qa*="applied" i]',
            ) as HTMLElement | null;
            if (alreadyAppliedBadge && isVisible(alreadyAppliedBadge)) {
              signals.push('marker: applied-badge');
            }

            const isSuccess = signals.length > 0;
            const confidence = signals.length >= 2 ? 'high' : signals.length === 1 ? 'medium' : 'none';
            return { isSuccess, signals, confidence };
          }

          function findRealQuestionnaire(): HTMLElement | null {
            const candidates: HTMLElement[] = [];
            for (const sel of selectors.MODAL_CONTAINER) {
              const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
              for (const el of els) {
                if (isVisible(el) && !candidates.includes(el)) {
                  candidates.push(el);
                }
              }
            }

            const fixedCandidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
            for (const el of fixedCandidates) {
              const style = window.getComputedStyle(el);
              if (
                (style.position === 'fixed' || style.position === 'absolute') &&
                isVisible(el) &&
                !candidates.includes(el)
              ) {
                candidates.push(el);
              }
            }

            for (const modal of candidates) {
              const text = (modal.innerText || '').toLowerCase();

              // EXPLICIT EXCLUSION: Post-apply drawer (quiz, upsell, "Problem of the day", etc.)
              const isUpsell = (selectors.UPSELL_EXCLUSIONS || []).some((term: string) =>
                text.includes(term.toLowerCase()),
              );
              if (isUpsell) {
                continue;
              }

              const isPostApplySuccess =
                text.includes('applied to') ||
                text.includes('successfully applied') ||
                text.includes('application sent') ||
                text.includes('applied successfully') ||
                text.includes('your application has been sent');

              const inputs = Array.from(
                modal.querySelectorAll(
                  'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [contenteditable="true"]',
                ),
              ).filter(i => !isUpsellElement(i as HTMLElement));

              const options = Array.from(
                modal.querySelectorAll(selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]'),
              ).filter(o => !isUpsellElement(o as HTMLElement));

              if (inputs.length === 0 && options.length === 0) {
                continue;
              }

              if (isPostApplySuccess) {
                const hasRecruiterKeywords =
                  text.includes("recruiter's questions") ||
                  text.includes('kindly answer') ||
                  text.includes('screening questions');
                if (!hasRecruiterKeywords) {
                  continue;
                }
              }

              const hasRecruiterKeywords =
                text.includes("recruiter's questions") ||
                text.includes('kindly answer all') ||
                text.includes('answer recruiter') ||
                text.includes('type message here') ||
                text.includes('how many years of experience') ||
                text.includes('skip this question') ||
                text.includes('current ctc') ||
                text.includes('expected ctc') ||
                text.includes('notice period') ||
                text.includes('in lacs') ||
                text.includes('screening questions') ||
                text.includes('relevant experience') ||
                text.includes('relocate') ||
                (text.includes('save') && (inputs.length > 0 || options.length > 0));

              const hasSubmitBtn = Array.from(modal.querySelectorAll(selectors.SUBMIT_BUTTON.join(', '))).some(b =>
                isVisible(b as HTMLElement),
              );

              if ((hasRecruiterKeywords || hasSubmitBtn) && (inputs.length > 0 || options.length > 0)) {
                return modal;
              }
            }
            return null;
          }

          // Check success FIRST
          const successEvaluation = evaluateSuccess();
          if (successEvaluation.isSuccess) {
            return { state: 'success', signals: successEvaluation.signals };
          }

          const modal = findRealQuestionnaire();
          if (!modal) {
            return { state: 'closed' };
          }

          return { state: 'modal_open' };
        }, NAUKRI_SELECTORS);

        if (status.state === 'success') {
          logger.info(
            `[NaukriAdapter] Questionnaire completed successfully (signals: ${status.signals?.join(', ') || 'verified'}).`,
          );
          return { success: true };
        }

        if (status.state === 'closed') {
          // Immediately check for success
          await new Promise(r => setTimeout(r, 600));
          const confirmSuccess = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
            const signals: string[] = [];
            const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();
            const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
            const appliedToMatch = bodyText.match(appliedToRegex);
            if (appliedToMatch) signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
            for (const ind of selectors.SUCCESS_INDICATORS) {
              if (ind.startsWith('.')) continue;
              if (bodyText.includes(ind.toLowerCase())) {
                if (!signals.some(s => s.startsWith('text:'))) signals.push(`text: ${ind}`);
                break;
              }
            }
            for (const sel of selectors.SUCCESS_BANNERS || []) {
              try {
                const el = document.querySelector(sel);
                if (el) {
                  signals.push(`banner: ${sel}`);
                  break;
                }
              } catch {}
            }
            for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (el) {
                const bt = (el.textContent || '').trim().toLowerCase();
                if (
                  bt === 'applied' ||
                  bt === 'already applied' ||
                  bt.startsWith('applied on') ||
                  bt.startsWith('applied to') ||
                  el.classList.contains('applied') ||
                  el.classList.contains('already-applied')
                ) {
                  signals.push(`button: ${bt || 'applied'}`);
                  break;
                }
              }
            }
            return { isSuccess: signals.length > 0, signals };
          }, NAUKRI_SELECTORS);

          if (confirmSuccess.isSuccess) {
            logger.info(
              `[NaukriAdapter] Questionnaire completed successfully (success confirmed after modal closed: ${confirmSuccess.signals.join(', ')}).`,
            );
            return { success: true };
          }

          if (step > 1) {
            // Re-verify after a short wait in case the modal is mid-transition/re-rendering between questions
            await new Promise(r => setTimeout(r, 1000));
            const recheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
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
                return rect.width >= 10 && rect.height >= 10;
              }

              function isUpsellElement(el: HTMLElement | null): boolean {
                if (!el) return false;
                let cur: HTMLElement | null = el;
                while (cur && cur !== document.body) {
                  const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
                  for (const term of selectors.UPSELL_EXCLUSIONS || []) {
                    if (text.includes(term.toLowerCase())) return true;
                  }
                  cur = cur.parentElement;
                }
                return false;
              }

              // Check success FIRST
              const signals: string[] = [];
              const bodyText = (document.body.innerText || '').toLowerCase();
              const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
              const appliedToMatch = bodyText.match(appliedToRegex);
              if (appliedToMatch) signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
              for (const ind of selectors.SUCCESS_INDICATORS) {
                if (ind.startsWith('.')) continue;
                if (bodyText.includes(ind.toLowerCase())) {
                  signals.push(`text: ${ind}`);
                  break;
                }
              }
              for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (el) {
                  const bt = (el.textContent || '').trim().toLowerCase();
                  if (
                    bt.includes('applied') ||
                    el.classList.contains('applied') ||
                    el.classList.contains('already-applied')
                  ) {
                    signals.push(`button: ${bt || 'applied'}`);
                    break;
                  }
                }
              }
              if (signals.length > 0) {
                return { state: 'success', signals };
              }

              // Check real questionnaire (MUST NOT match upsell/quiz/post-apply drawer)
              for (const sel of selectors.MODAL_CONTAINER) {
                const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
                for (const el of els) {
                  if (isVisible(el) && !isUpsellElement(el)) {
                    const text = (el.innerText || '').toLowerCase();
                    const isUpsell = (selectors.UPSELL_EXCLUSIONS || []).some(t => text.includes(t.toLowerCase()));
                    if (!isUpsell) {
                      const inputs = el.querySelectorAll(
                        'input:not([type="hidden"]):not([type="file"]), select, textarea',
                      );
                      const choices = el.querySelectorAll(
                        selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]',
                      );
                      if (inputs.length > 0 || choices.length > 0) {
                        return { state: 'modal_open', signals: [] };
                      }
                    }
                  }
                }
              }

              return { state: 'closed', signals: [] };
            }, NAUKRI_SELECTORS);

            if (recheck.state === 'success') {
              logger.info(
                `[NaukriAdapter] Questionnaire completed successfully on recheck (signals: ${recheck.signals?.join(', ') || 'verified'}).`,
              );
              return { success: true };
            }

            if (recheck.state === 'modal_open') {
              logger.info(
                `[NaukriAdapter] Real questionnaire re-appeared after transition. Continuing step ${step}...`,
              );
              continue;
            }

            consecutiveRepeats++;
            if (consecutiveRepeats >= 2) {
              logger.warning(
                `[NaukriAdapter] Questionnaire closed without success confirmation. Stopping after step ${step}.`,
              );
              return { success: false, reason: 'Questionnaire closed without success confirmation.' };
            }
            continue;
          }

          logger.info(`[NaukriAdapter] Modal was closed on step 1 with no real questions.`);
          return { success: false, reason: 'No recruiter questions found in questionnaire modal.' };
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
            if (rect.width < 10 || rect.height < 10) return false;
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

          function isUpsellElement(el: HTMLElement | null): boolean {
            if (!el) return false;
            let cur: HTMLElement | null = el;
            while (cur && cur !== document.body) {
              const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
              for (const term of selectors.UPSELL_EXCLUSIONS || []) {
                if (text.includes(term.toLowerCase())) return true;
              }
              cur = cur.parentElement;
            }
            return false;
          }

          function findRealQuestionnaire(): HTMLElement | null {
            const candidates: HTMLElement[] = [];
            for (const sel of selectors.MODAL_CONTAINER) {
              const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
              for (const el of els) {
                if (isVisible(el) && !candidates.includes(el)) {
                  candidates.push(el);
                }
              }
            }
            const fixedCandidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
            for (const el of fixedCandidates) {
              const style = window.getComputedStyle(el);
              if (
                (style.position === 'fixed' || style.position === 'absolute') &&
                isVisible(el) &&
                !candidates.includes(el)
              ) {
                candidates.push(el);
              }
            }

            for (const modal of candidates) {
              const text = (modal.innerText || '').toLowerCase();
              const isUpsell = (selectors.UPSELL_EXCLUSIONS || []).some(t => text.includes(t.toLowerCase()));
              if (isUpsell) continue;

              const isPostApplySuccess =
                text.includes('applied to') ||
                text.includes('successfully applied') ||
                text.includes('application sent') ||
                text.includes('applied successfully') ||
                text.includes('your application has been sent');

              const inputs = Array.from(
                modal.querySelectorAll(
                  'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [contenteditable="true"]',
                ),
              ).filter(i => !isUpsellElement(i as HTMLElement));

              const options = Array.from(
                modal.querySelectorAll(selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]'),
              ).filter(o => !isUpsellElement(o as HTMLElement));

              if (inputs.length === 0 && options.length === 0) continue;

              if (isPostApplySuccess) {
                const hasRecruiterKeywords =
                  text.includes("recruiter's questions") ||
                  text.includes('kindly answer') ||
                  text.includes('screening questions');
                if (!hasRecruiterKeywords) continue;
              }

              const hasRecruiterKeywords =
                text.includes("recruiter's questions") ||
                text.includes('kindly answer all') ||
                text.includes('answer recruiter') ||
                text.includes('type message here') ||
                text.includes('how many years of experience') ||
                text.includes('skip this question') ||
                text.includes('current ctc') ||
                text.includes('expected ctc') ||
                text.includes('notice period') ||
                text.includes('in lacs') ||
                text.includes('screening questions') ||
                text.includes('relevant experience') ||
                text.includes('relocate') ||
                (text.includes('save') && (inputs.length > 0 || options.length > 0));

              const hasSubmitBtn = Array.from(modal.querySelectorAll(selectors.SUBMIT_BUTTON.join(', '))).some(b =>
                isVisible(b as HTMLElement),
              );

              if ((hasRecruiterKeywords || hasSubmitBtn) && (inputs.length > 0 || options.length > 0)) {
                return modal;
              }
            }
            return null;
          }

          const modal = findRealQuestionnaire();
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

          // A. Extract question from Chatbot message bubbles (excluding upsell)
          let activeQuestion = '';
          const bubbleCandidates = Array.from(
            modal.querySelectorAll(selectors.CHATBOT_QUESTION_BUBBLE.join(', ') + ', div, p, span'),
          ).filter(b => !isUpsellElement(b as HTMLElement)) as HTMLElement[];

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
          const allClickables = Array.from(modal.querySelectorAll('button, a, span, div')).filter(
            c => !isUpsellElement(c as HTMLElement),
          ) as HTMLElement[];
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
          ).filter(c => !isUpsellElement(c as HTMLElement)) as HTMLElement[];

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
          function isEnabledInput(el: HTMLElement): boolean {
            return (
              !(el as HTMLInputElement).disabled &&
              !el.hasAttribute('disabled') &&
              el.getAttribute('aria-disabled') !== 'true'
            );
          }

          let rawInputs = Array.from(
            modal.querySelectorAll(
              'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
            ),
          ).filter(el => !isUpsellElement(el as HTMLElement)) as HTMLElement[];

          // Prefer visible and enabled inputs first
          let inputs = rawInputs.filter(el => isVisible(el));
          const enabledInputs = inputs.filter(el => isEnabledInput(el));
          if (enabledInputs.length > 0) {
            inputs = enabledInputs;
          }

          // If no inputs found inside modal, fallback to checking chatbot inputs in document (excluding upsell)
          if (inputs.length === 0) {
            const docInputs = Array.from(
              document.querySelectorAll(
                'input[placeholder*="Type message" i]:not([disabled]), textarea[placeholder*="Type message" i]:not([disabled]), input[placeholder*="message" i]:not([disabled]), textarea[placeholder*="message" i]:not([disabled]), [contenteditable="true"]:not([aria-disabled="true"]), input[placeholder*="Type message" i], textarea[placeholder*="Type message" i], input[placeholder*="message" i], textarea[placeholder*="message" i], input[type="text"]:not([type="hidden"]):not([disabled]), textarea:not([disabled])',
              ),
            ).filter(el => !isUpsellElement(el as HTMLElement)) as HTMLElement[];
            const visibleDoc = docInputs.filter(el => isVisible(el));
            const enabledDoc = visibleDoc.filter(el => isEnabledInput(el));
            inputs = enabledDoc.length > 0 ? enabledDoc : visibleDoc;
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
              // Extract all options in this radio/checkbox group (excluding upsell)
              const inputName = (el as HTMLInputElement).name;
              const inputType = fieldType === 'radio' ? 'radio' : 'checkbox';
              const inputGroup = inputName
                ? (Array.from(modal.querySelectorAll(`input[type="${inputType}"][name="${inputName}"]`)).filter(
                    r => !isUpsellElement(r as HTMLElement),
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

        if (!stepData.modalFound) {
          // If no real questionnaire was found on this step, check success immediately
          const succCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
            const signals: string[] = [];
            const bodyText = (document.body.innerText || '').toLowerCase();
            const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
            const appliedToMatch = bodyText.match(appliedToRegex);
            if (appliedToMatch) signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
            for (const ind of selectors.SUCCESS_INDICATORS) {
              if (ind.startsWith('.')) continue;
              if (bodyText.includes(ind.toLowerCase())) {
                signals.push(`text: ${ind}`);
                break;
              }
            }
            for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (el) {
                const bt = (el.textContent || '').trim().toLowerCase();
                if (
                  bt.includes('applied') ||
                  el.classList.contains('applied') ||
                  el.classList.contains('already-applied')
                ) {
                  signals.push(`button: ${bt}`);
                  break;
                }
              }
            }
            return { isSuccess: signals.length > 0, signals };
          }, NAUKRI_SELECTORS);

          if (succCheck.isSuccess) {
            logger.info(
              `[NaukriAdapter] Application succeeded (no modal found, success detected: ${succCheck.signals.join(', ')}).`,
            );
            return { success: true };
          }
          return {
            success: false,
            reason: 'Questionnaire or modal disappeared without application confirmation.',
          };
        }

        const currentQuestion = stepData?.activeQuestion || stepData?.modalHeading || 'Unknown Question';
        if (currentQuestion === lastQuestionHandled && step > 1) {
          consecutiveRepeats++;
          logger.warning(
            `[NaukriAdapter] ⚠️ Stuck on question: "${currentQuestion}" (repeat count: ${consecutiveRepeats})`,
          );
        } else {
          consecutiveRepeats = 0;
          lastQuestionHandled = currentQuestion;
        }

        const choiceOptions = stepData?.choiceOptions || [];
        const fields = stepData?.fields || [];

        // If stuck on the same state twice without progress:
        // Try skip button if available, or stop cleanly instead of burning all 15 steps
        if (consecutiveRepeats >= 2) {
          if (stepData?.hasSkipBtn) {
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

          // If no skip button and same state repeats twice with no new real question, stop with a clear reason
          logger.warning(
            `[NaukriAdapter] Same question state repeated twice without progress ("${lastQuestionHandled}"). Stopping loop.`,
          );
          const succCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
            const signals: string[] = [];
            const bodyText = (document.body.innerText || '').toLowerCase();
            const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
            const appliedToMatch = bodyText.match(appliedToRegex);
            if (appliedToMatch) signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
            for (const ind of selectors.SUCCESS_INDICATORS) {
              if (ind.startsWith('.')) continue;
              if (bodyText.includes(ind.toLowerCase())) {
                signals.push(`text: ${ind}`);
                break;
              }
            }
            return { isSuccess: signals.length > 0, signals };
          }, NAUKRI_SELECTORS);

          if (succCheck.isSuccess) {
            return { success: true };
          }
          return {
            success: false,
            reason: `Questionnaire remained open without progress. Last question: "${lastQuestionHandled}"`,
          };
        }

        logger.info(
          `[NaukriAdapter] Step ${step}: Question: "${lastQuestionHandled}" | Options: ${choiceOptions.length} | Fields: ${fields.length} | Skip: ${stepData?.hasSkipBtn || false}`,
        );

        let didAnswer = false;

        // 3A. Process Choice Options (Chatbot choice chips/radios)
        if (choiceOptions.length > 0) {
          const optTexts = (choiceOptions as Array<{ text: string; index: number }>).map(
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

              function isUpsellElement(el: HTMLElement | null): boolean {
                if (!el) return false;
                let cur: HTMLElement | null = el;
                while (cur && cur !== document.body) {
                  const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
                  for (const term of selectors.UPSELL_EXCLUSIONS || []) {
                    if (text.includes(term.toLowerCase())) return true;
                  }
                  cur = cur.parentElement;
                }
                return false;
              }

              for (const sel of selectors.MODAL_CONTAINER) {
                const modal = document.querySelector(sel) as HTMLElement | null;
                if (modal && isVisible(modal) && !isUpsellElement(modal)) {
                  const choiceEls = Array.from(
                    modal.querySelectorAll(
                      selectors.CHATBOT_OPTIONS.join(', ') +
                        ', label, li, [role="button"], [role="radio"], [role="checkbox"]',
                    ),
                  ).filter(c => !isUpsellElement(c as HTMLElement)) as HTMLElement[];

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

                  if (bestEl && !isUpsellElement(bestEl)) {
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
        if (fields.length > 0) {
          for (const f of fields) {
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
                answer.value = '';
              }
            }

            // Answer Guard: Validate answer format before injecting into DOM
            const guardResult = validateAnswerForField(answer.value, {
              label: qText,
              fieldType: f.fieldType as any,
              options: f.options,
              placeholder: f.placeholder,
            });

            if (!guardResult.valid || !guardResult.value) {
              logger.warning(
                `[NaukriAdapter] Answer guard rejected "${answer.value}" for field "${qText}": ${guardResult.reason}. Leaving unfilled.`,
              );
              continue;
            }

            answer.value = guardResult.value;

            logger.info(`[NaukriAdapter] Field "${qText}" -> Answering: "${answer.value}"`);

            const fillResult = await puppeteerPage.evaluate(
              (idx: number, val: string, fType: string, selectors: typeof NAUKRI_SELECTORS) => {
                function isVisible(el: HTMLElement): boolean {
                  if (!el || el.offsetParent === null) return false;
                  const style = window.getComputedStyle(el);
                  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                }

                function isUpsellElement(el: HTMLElement | null): boolean {
                  if (!el) return false;
                  let cur: HTMLElement | null = el;
                  while (cur && cur !== document.body) {
                    const text = (
                      cur.innerText ||
                      cur.textContent ||
                      cur.getAttribute('aria-label') ||
                      ''
                    ).toLowerCase();
                    for (const term of selectors.UPSELL_EXCLUSIONS || []) {
                      if (text.includes(term.toLowerCase())) return true;
                    }
                    cur = cur.parentElement;
                  }
                  return false;
                }

                let modal: HTMLElement | null = null;
                for (const sel of selectors.MODAL_CONTAINER) {
                  const el = document.querySelector(sel) as HTMLElement | null;
                  if (el && isVisible(el) && !isUpsellElement(el)) {
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
                    if (
                      (style.position === 'fixed' || style.position === 'absolute') &&
                      isVisible(el) &&
                      !isUpsellElement(el)
                    ) {
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
                ).filter(inp => !isUpsellElement(inp as HTMLElement)) as HTMLElement[];
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
                if (!el)
                  return { filled: false, error: 'element_not_found', x: 0, y: 0, isChatInput: false, sendBtn: null };

                if (el.tagName.toLowerCase() === 'input' && el.type === 'file')
                  return { filled: false, error: 'file_input', x: 0, y: 0, isChatInput: false, sendBtn: null };

                // Ensure element is enabled: if loaded disabled, un-disable it
                try {
                  if (el.disabled) el.disabled = false;
                  el.removeAttribute('disabled');
                  el.removeAttribute('aria-disabled');
                } catch {}

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
                  if (isUpsellElement(targetRadio)) {
                    return { x: 0, y: 0 };
                  }
                  const radioName = el.name;
                  if (radioName) {
                    const allRadios = Array.from(
                      modal.querySelectorAll(`input[type="radio"][name="${radioName}"]`),
                    ).filter(r => !isUpsellElement(r as HTMLElement)) as HTMLInputElement[];
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
                  if (isUpsellElement(targetRadio)) {
                    return { x: 0, y: 0 };
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

                // Find Send icon/button next to the chat input (paper airplane, arrow, send button)
                let sendBtnInfo: { x: number; y: number } | null = null;
                if (isChatInput) {
                  const inputContainer =
                    el.closest(
                      '.chatbot-input-wrapper, [class*="input" i], [class*="chat" i], [class*="footer" i], form',
                    ) || el.parentElement;
                  let sendBtn: HTMLElement | null = null;
                  if (inputContainer) {
                    const sendCandidates = Array.from(
                      inputContainer.querySelectorAll(
                        'button[class*="send" i], button.send-btn, [aria-label*="send" i], [data-qa*="send" i], button:has(svg), svg[class*="send" i], [role="button"][class*="send" i], span[class*="send" i]',
                      ),
                    ) as HTMLElement[];
                    sendBtn = sendCandidates.find(b => isVisible(b)) || null;
                  }
                  if (!sendBtn) {
                    const docSends = Array.from(
                      document.querySelectorAll(
                        'button.send-btn, button[class*="send" i], [aria-label*="send" i], [data-qa*="send" i]',
                      ),
                    ) as HTMLElement[];
                    sendBtn = docSends.find(b => isVisible(b)) || null;
                  }
                  if (sendBtn) {
                    try {
                      (sendBtn as HTMLButtonElement).disabled = false;
                      sendBtn.classList.remove('disabled');
                    } catch {}
                    const sRect = sendBtn.getBoundingClientRect();
                    sendBtnInfo = {
                      x: sRect.left + sRect.width / 2,
                      y: sRect.top + sRect.height / 2,
                    };
                  }
                }

                return {
                  filled: true,
                  postFillError,
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  isChatInput,
                  sendBtn: sendBtnInfo,
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

                await puppeteerPage.keyboard.type(answer.value, { delay: 20 });
                await new Promise(r => setTimeout(r, 150));

                if (fillResult.isChatInput) {
                  logger.info(`[NaukriAdapter] 💬 Pressing Enter key for chat input...`);
                  await puppeteerPage.keyboard.press('Enter');
                  await new Promise(r => setTimeout(r, 200));

                  // In addition to Enter, click the Send icon/button next to the input
                  if (fillResult.sendBtn?.x && fillResult.sendBtn?.y && puppeteerPage?.mouse) {
                    logger.info(
                      `[NaukriAdapter] ✈️ Clicking Send icon/button at (${Math.round(fillResult.sendBtn.x)}, ${Math.round(fillResult.sendBtn.y)})...`,
                    );
                    await puppeteerPage.mouse.click(fillResult.sendBtn.x, fillResult.sendBtn.y);
                    await new Promise(r => setTimeout(r, 300));
                  }
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
            function isEnabled(el: HTMLElement): boolean {
              return (
                !(el as HTMLInputElement).disabled &&
                !el.hasAttribute('disabled') &&
                el.getAttribute('aria-disabled') !== 'true'
              );
            }

            // Prioritize visible and enabled inputs (:not([disabled]))
            const chatInputs = Array.from(
              document.querySelectorAll(
                'input[placeholder*="Type message" i]:not([disabled]), textarea[placeholder*="Type message" i]:not([disabled]), input[placeholder*="message" i]:not([disabled]), textarea[placeholder*="message" i]:not([disabled]), [contenteditable="true"]:not([aria-disabled="true"]), input[placeholder*="Type message" i], textarea[placeholder*="Type message" i], input[placeholder*="message" i], textarea[placeholder*="message" i], [contenteditable="true"]',
              ),
            ) as HTMLElement[];
            let activeInput =
              chatInputs.find(el => isVisible(el) && isEnabled(el)) || chatInputs.find(el => isVisible(el));
            if (!activeInput) return null;

            // If loaded disabled, un-disable it before interaction
            try {
              (activeInput as HTMLInputElement).disabled = false;
              activeInput.removeAttribute('disabled');
              activeInput.removeAttribute('aria-disabled');
            } catch {}

            const rect = activeInput.getBoundingClientRect();

            // Find Send icon/button next to activeInput (paper airplane, arrow, send button)
            let sendBtnInfo: { x: number; y: number } | null = null;
            const container =
              activeInput.closest(
                '.chatbot-input-wrapper, [class*="input" i], [class*="chat" i], [class*="footer" i], form',
              ) || activeInput.parentElement;
            let sendBtn: HTMLElement | null = null;
            if (container) {
              const sends = Array.from(
                container.querySelectorAll(
                  'button[class*="send" i], button.send-btn, [aria-label*="send" i], [data-qa*="send" i], button:has(svg), svg[class*="send" i], [role="button"][class*="send" i], span[class*="send" i]',
                ),
              ) as HTMLElement[];
              sendBtn = sends.find(b => isVisible(b)) || null;
            }
            if (!sendBtn) {
              const docSends = Array.from(
                document.querySelectorAll(
                  'button.send-btn, button[class*="send" i], [aria-label*="send" i], [data-qa*="send" i]',
                ),
              ) as HTMLElement[];
              sendBtn = docSends.find(b => isVisible(b)) || null;
            }
            if (sendBtn) {
              try {
                (sendBtn as HTMLButtonElement).disabled = false;
                sendBtn.classList.remove('disabled');
              } catch {}
              const sRect = sendBtn.getBoundingClientRect();
              sendBtnInfo = {
                x: sRect.left + sRect.width / 2,
                y: sRect.top + sRect.height / 2,
              };
            }

            return {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              placeholder: activeInput.getAttribute('placeholder') || '',
              sendBtn: sendBtnInfo,
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
              await puppeteerPage.keyboard.type(answer.value, { delay: 20 });
              await new Promise(r => setTimeout(r, 150));
              await puppeteerPage.keyboard.press('Enter');
              await new Promise(r => setTimeout(r, 200));

              // Click Send icon button if present
              if (directChatInfo.sendBtn?.x && directChatInfo.sendBtn?.y && puppeteerPage?.mouse) {
                logger.info(
                  `[NaukriAdapter] ✈️ Clicking Send icon/button at (${Math.round(directChatInfo.sendBtn.x)}, ${Math.round(directChatInfo.sendBtn.y)})...`,
                );
                await puppeteerPage.mouse.click(directChatInfo.sendBtn.x, directChatInfo.sendBtn.y);
                await new Promise(r => setTimeout(r, 300));
              }

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

        // Artificial delay (700ms) for React state to re-render footer [ Save ] button from disabled to active
        await new Promise(r => setTimeout(r, 700));

        // 5. Click Save / Submit / Next button (or fallback to Skip if disabled or blocked)
        const submitAction = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
          function isVisible(el: HTMLElement | null): boolean {
            if (!el || el.offsetParent === null) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }

          function isUpsellElement(el: HTMLElement | null): boolean {
            if (!el) return false;
            let cur: HTMLElement | null = el;
            while (cur && cur !== document.body) {
              const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
              for (const term of selectors.UPSELL_EXCLUSIONS || []) {
                if (text.includes(term.toLowerCase())) return true;
              }
              cur = cur.parentElement;
            }
            return false;
          }

          let modal: HTMLElement | null = null;
          for (const sel of selectors.MODAL_CONTAINER) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el) && !isUpsellElement(el)) {
              modal = el;
              break;
            }
          }
          if (!modal) modal = document.body;

          let actionBtn: HTMLElement | null = null;

          // Strategy 1: Look inside modal using SUBMIT_BUTTON selectors
          for (const sel of selectors.SUBMIT_BUTTON) {
            const btn = modal.querySelector(sel) as HTMLElement | null;
            if (btn && isVisible(btn) && !isUpsellElement(btn)) {
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

        // 6. Check if application has explicitly completed or modal closed
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

          function isUpsellElement(el: HTMLElement | null): boolean {
            if (!el) return false;
            let cur: HTMLElement | null = el;
            while (cur && cur !== document.body) {
              const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
              for (const term of selectors.UPSELL_EXCLUSIONS || []) {
                if (text.includes(term.toLowerCase())) return true;
              }
              cur = cur.parentElement;
            }
            return false;
          }

          function evaluateSuccess(): {
            isSuccess: boolean;
            signals: string[];
            confidence: 'high' | 'medium' | 'none';
          } {
            const signals: string[] = [];
            const bodyText = (document.body.innerText || document.body.textContent || '').toLowerCase();

            // 1. Text signal: "Applied to <Job/Company>" or standard success phrases
            const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
            const appliedToMatch = bodyText.match(appliedToRegex);
            if (appliedToMatch) {
              signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
            }

            for (const ind of selectors.SUCCESS_INDICATORS) {
              if (ind.startsWith('.')) continue;
              if (bodyText.includes(ind.toLowerCase())) {
                if (!signals.some(s => s.startsWith('text:'))) {
                  signals.push(`text: ${ind}`);
                }
                break;
              }
            }

            // 2. Banner / Green tick / Icon signal
            for (const sel of selectors.SUCCESS_BANNERS || []) {
              try {
                const bannerEls = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
                for (const b of bannerEls) {
                  if (isVisible(b)) {
                    signals.push(`banner: ${sel}`);
                    break;
                  }
                }
              } catch {}
              if (signals.some(s => s.startsWith('banner:'))) break;
            }

            if (!signals.some(s => s.startsWith('banner:'))) {
              const successIcons = Array.from(document.querySelectorAll('svg, i, span, div')) as HTMLElement[];
              for (const icon of successIcons) {
                if (isVisible(icon)) {
                  const cls = (
                    icon.className && typeof icon.className === 'string' ? icon.className : ''
                  ).toLowerCase();
                  if (
                    cls.includes('success') ||
                    cls.includes('greentick') ||
                    cls.includes('green-tick') ||
                    cls.includes('check-icon')
                  ) {
                    signals.push('banner: success-icon');
                    break;
                  }
                }
              }
            }

            // 3. Primary apply button state
            for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (el && isVisible(el)) {
                const bt = (el.textContent || '').trim().toLowerCase();
                if (
                  bt === 'applied' ||
                  bt === 'already applied' ||
                  bt.startsWith('applied on') ||
                  bt.startsWith('applied to') ||
                  el.classList.contains('applied') ||
                  el.classList.contains('already-applied')
                ) {
                  signals.push(`button: ${bt || 'applied'}`);
                  break;
                }
              }
            }

            // 4. URL or DOM markers
            try {
              const href = window.location.href.toLowerCase();
              if (href.includes('applied=true') || href.includes('/applied')) {
                signals.push('url: applied');
              }
            } catch {}

            const alreadyAppliedBadge = document.querySelector(
              '.applied-badge, .already-applied, [data-qa*="applied" i]',
            ) as HTMLElement | null;
            if (alreadyAppliedBadge && isVisible(alreadyAppliedBadge)) {
              signals.push('marker: applied-badge');
            }

            const isSuccess = signals.length > 0;
            const confidence = signals.length >= 2 ? 'high' : signals.length === 1 ? 'medium' : 'none';
            return { isSuccess, signals, confidence };
          }

          function findRealQuestionnaire(): HTMLElement | null {
            const candidates: HTMLElement[] = [];
            for (const sel of selectors.MODAL_CONTAINER) {
              const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
              for (const el of els) {
                if (isVisible(el) && !candidates.includes(el)) {
                  candidates.push(el);
                }
              }
            }
            const fixedCandidates = Array.from(document.querySelectorAll('div, section, aside, form')) as HTMLElement[];
            for (const el of fixedCandidates) {
              const style = window.getComputedStyle(el);
              if (
                (style.position === 'fixed' || style.position === 'absolute') &&
                isVisible(el) &&
                !candidates.includes(el)
              ) {
                candidates.push(el);
              }
            }

            for (const modal of candidates) {
              const text = (modal.innerText || '').toLowerCase();
              const isUpsell = (selectors.UPSELL_EXCLUSIONS || []).some(t => text.includes(t.toLowerCase()));
              if (isUpsell) continue;

              const isPostApplySuccess =
                text.includes('applied to') ||
                text.includes('successfully applied') ||
                text.includes('application sent') ||
                text.includes('applied successfully') ||
                text.includes('your application has been sent');

              const inputs = Array.from(
                modal.querySelectorAll(
                  'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [contenteditable="true"]',
                ),
              ).filter(i => !isUpsellElement(i as HTMLElement));

              const options = Array.from(
                modal.querySelectorAll(selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]'),
              ).filter(o => !isUpsellElement(o as HTMLElement));

              if (inputs.length === 0 && options.length === 0) continue;

              if (isPostApplySuccess) {
                const hasRecruiterKeywords =
                  text.includes("recruiter's questions") ||
                  text.includes('kindly answer') ||
                  text.includes('screening questions');
                if (!hasRecruiterKeywords) continue;
              }

              const hasRecruiterKeywords =
                text.includes("recruiter's questions") ||
                text.includes('kindly answer all') ||
                text.includes('answer recruiter') ||
                text.includes('type message here') ||
                text.includes('how many years of experience') ||
                text.includes('skip this question') ||
                text.includes('current ctc') ||
                text.includes('expected ctc') ||
                text.includes('notice period') ||
                text.includes('in lacs') ||
                text.includes('screening questions') ||
                text.includes('relevant experience') ||
                text.includes('relocate') ||
                (text.includes('save') && (inputs.length > 0 || options.length > 0));

              const hasSubmitBtn = Array.from(modal.querySelectorAll(selectors.SUBMIT_BUTTON.join(', '))).some(b =>
                isVisible(b as HTMLElement),
              );

              if ((hasRecruiterKeywords || hasSubmitBtn) && (inputs.length > 0 || options.length > 0)) {
                return modal;
              }
            }
            return null;
          }

          // 1. Explicit success check FIRST
          const succ = evaluateSuccess();
          if (succ.isSuccess) {
            return { finished: true, success: true, signals: succ.signals };
          }

          // 2. Check primary apply button state
          for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el && isVisible(el)) {
              const bt = (el.textContent || '').trim().toLowerCase();
              if (
                bt === 'applied' ||
                bt === 'already applied' ||
                bt.startsWith('applied on') ||
                bt.startsWith('applied to') ||
                el.classList.contains('applied') ||
                el.classList.contains('already-applied')
              ) {
                return { finished: true, success: true, signals: [`button: ${bt || 'applied'}`] };
              }
            }
          }

          // 3. Check if real questionnaire STILL has active inputs or choice options
          const modal = findRealQuestionnaire();
          if (modal) {
            const modalSucc = evaluateSuccess();
            if (modalSucc.isSuccess) {
              return { finished: true, success: true, signals: modalSucc.signals };
            }

            const inputs = Array.from(
              modal.querySelectorAll('input:not([type="hidden"]):not([type="file"]), select, textarea'),
            ).filter(i => !isUpsellElement(i as HTMLElement));
            const choices = Array.from(
              modal.querySelectorAll(selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]'),
            ).filter(c => !isUpsellElement(c as HTMLElement));

            if (inputs.length > 0 || choices.length > 0) {
              return { finished: false, success: false, reason: 'more_questions_in_modal' };
            }
          }

          // If no real questionnaire found right now, wait for next check
          return { finished: false, success: false, reason: 'modal_transitioning_or_unconfirmed' };
        }, NAUKRI_SELECTORS);

        if (postSubmitCheck.finished && postSubmitCheck.success) {
          logger.info(
            `[NaukriAdapter] Application finished after step ${step} (${postSubmitCheck.signals?.join(', ') || 'verified'}).`,
          );
          return { success: true };
        }
      }

      // Check final state after loop: Only succeed if success signal is present
      const finalCheck = await puppeteerPage.evaluate((selectors: typeof NAUKRI_SELECTORS) => {
        function isVisible(el: HTMLElement): boolean {
          if (!el || el.offsetParent === null) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }

        function isUpsellElement(el: HTMLElement | null): boolean {
          if (!el) return false;
          let cur: HTMLElement | null = el;
          while (cur && cur !== document.body) {
            const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
            for (const term of selectors.UPSELL_EXCLUSIONS || []) {
              if (text.includes(term.toLowerCase())) return true;
            }
            cur = cur.parentElement;
          }
          return false;
        }

        // 1. Success check FIRST
        const signals: string[] = [];
        const bodyText = (document.body.innerText || '').toLowerCase();
        const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][\w\s\(\)\.-]{1,60})/i;
        const appliedToMatch = bodyText.match(appliedToRegex);
        if (appliedToMatch) signals.push(`text: applied to ${appliedToMatch[1].trim()}`);
        for (const ind of selectors.SUCCESS_INDICATORS) {
          if (ind.startsWith('.')) continue;
          if (bodyText.includes(ind.toLowerCase())) {
            signals.push(`text: ${ind}`);
            break;
          }
        }
        for (const sel of selectors.SUCCESS_BANNERS || []) {
          try {
            const el = document.querySelector(sel);
            if (el && isVisible(el as HTMLElement)) {
              signals.push(`banner: ${sel}`);
              break;
            }
          } catch {}
        }
        for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            const bt = (el.textContent || '').trim().toLowerCase();
            if (
              bt.includes('applied') ||
              el.classList.contains('applied') ||
              el.classList.contains('already-applied')
            ) {
              signals.push(`button: ${bt}`);
              break;
            }
          }
        }

        if (signals.length > 0) {
          return { success: true, signals };
        }

        // Check if real questionnaire is still open
        for (const sel of selectors.MODAL_CONTAINER) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && isVisible(el) && !isUpsellElement(el)) {
            const inputs = el.querySelectorAll('input:not([type="hidden"]):not([type="file"]), select, textarea');
            const choices = el.querySelectorAll(
              selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]',
            );
            if (inputs.length > 0 || choices.length > 0) {
              return { success: false, reason: 'real_modal_still_open' };
            }
          }
        }

        return { success: false, reason: 'no_success_signal' };
      }, NAUKRI_SELECTORS);

      if (finalCheck.success) {
        logger.info(
          `[NaukriAdapter] Application confirmed successful on final check (${finalCheck.signals?.join(', ') || 'verified'}).`,
        );
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
