// chrome-extension/src/background/agent/platforms/naukri/naukriDomHelpers.ts
import { NAUKRI_SELECTORS } from './selectors';

export interface NaukriSuccessResult {
  isSuccess: boolean;
  signals: string[];
  confidence: 'high' | 'medium' | 'none';
}

/**
 * Check if an element is visible in the DOM.
 */
export function isElementVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
  if (typeof window !== 'undefined' && window.getComputedStyle) {
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
      rect.left >= (window.innerWidth || 1920) ||
      rect.top >= (window.innerHeight || 1080)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Determines whether an element or any of its ancestors is an upsell,
 * "Problem of the day", "Become a Pro", FastForward, or quiz widget.
 */
export function isNaukriUpsellOrQuiz(
  el: HTMLElement | null,
  selectors: typeof NAUKRI_SELECTORS = NAUKRI_SELECTORS,
): boolean {
  if (!el) return false;
  let cur: HTMLElement | null = el;
  const body = el.ownerDocument?.body || (typeof document !== 'undefined' ? document.body : null);
  while (cur && cur !== body && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    const text = (cur.innerText || cur.textContent || cur.getAttribute('aria-label') || '').toLowerCase();
    for (const term of selectors.UPSELL_EXCLUSIONS || []) {
      if (text.includes(term.toLowerCase())) {
        return true;
      }
    }
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Recognise success by several independent signals:
 * 1. Banner: Green check banner, .apply-message, success icons (Strong)
 * 2. Primary Button: Button text changed to "Applied", "Already applied", etc. (Strong)
 * 3. Container Text: Explicit "Applied to <Job/Company>" inside an apply-confirmation container (Strong)
 * 4. DOM/URL markers: .applied-badge, applied url parameters (Strong)
 * 5. General body text: Text outside confirmation container (Weak - NEVER enough on its own)
 */
export function evaluateNaukriSuccess(
  root: Document | HTMLElement,
  selectors: typeof NAUKRI_SELECTORS = NAUKRI_SELECTORS,
): NaukriSuccessResult {
  const signals: string[] = [];
  const doc = (root as Document).body ? (root as Document) : (root as HTMLElement).ownerDocument || (root as any);
  const container = (root as Document).body || (root as HTMLElement);
  const bodyText = (container.innerText || container.textContent || '').toLowerCase();

  // 1. Strong Signal: Confirmation Banner / Tick / Icon
  for (const sel of selectors.SUCCESS_BANNERS || []) {
    try {
      const bannerEls = Array.from(doc.querySelectorAll(sel)) as HTMLElement[];
      for (const b of bannerEls) {
        if (!isNaukriUpsellOrQuiz(b, selectors) && (b.offsetParent !== null || isElementVisible(b))) {
          signals.push(`banner: ${sel}`);
          break;
        }
      }
    } catch {}
    if (signals.some(s => s.startsWith('banner:'))) break;
  }

  if (!signals.some(s => s.startsWith('banner:'))) {
    const successIcons = Array.from(doc.querySelectorAll('svg, i, span, div')) as HTMLElement[];
    for (const icon of successIcons) {
      if (!isNaukriUpsellOrQuiz(icon, selectors) && (icon.offsetParent !== null || isElementVisible(icon))) {
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

  // 2. Strong Signal: Primary apply button state (changes to "Applied", "Already applied", etc.)
  for (const sel of selectors.PRIMARY_APPLY_BUTTON) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (el && (el.offsetParent !== null || isElementVisible(el))) {
      const bt = (el.textContent || (el as HTMLInputElement).value || '').trim().toLowerCase();
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

  // 3. Strong Signal: Explicit confirmation text inside an apply-confirmation container
  const appliedToRegex = /(?:applied\s+to|application\s+sent\s+to)\s+([a-z0-9][^\n\r,\.;<]{1,40})/i;
  const confirmationContainers: HTMLElement[] = [];
  for (const cSel of selectors.APPLY_CONFIRMATION_CONTAINERS || []) {
    try {
      const matching = Array.from(doc.querySelectorAll(cSel)) as HTMLElement[];
      for (const m of matching) {
        if (!isNaukriUpsellOrQuiz(m, selectors) && (m.offsetParent !== null || isElementVisible(m))) {
          confirmationContainers.push(m);
        }
      }
    } catch {}
  }

  let foundContainerText = false;
  for (const c of confirmationContainers) {
    const cText = (c.innerText || c.textContent || '').trim();
    const cMatch = cText.match(appliedToRegex);
    if (cMatch) {
      signals.push(`container_text: applied to ${cMatch[1].trim()}`);
      foundContainerText = true;
      break;
    }
    const cLower = cText.toLowerCase();
    for (const ind of selectors.SUCCESS_INDICATORS) {
      if (ind.startsWith('.')) continue;
      if (cLower.includes(ind.toLowerCase())) {
        signals.push(`container_text: ${ind}`);
        foundContainerText = true;
        break;
      }
    }
    if (foundContainerText) break;
  }

  // 4. Strong Signal: URL or DOM markers
  if (typeof window !== 'undefined' && window.location?.href) {
    const href = window.location.href.toLowerCase();
    if (href.includes('applied=true') || href.includes('/applied')) {
      signals.push('url: applied');
    }
  }

  const alreadyAppliedBadge = doc.querySelector(
    '.applied-badge, .already-applied, [data-qa*="applied" i]',
  ) as HTMLElement | null;
  if (alreadyAppliedBadge && (alreadyAppliedBadge.offsetParent !== null || isElementVisible(alreadyAppliedBadge))) {
    signals.push('marker: applied-badge');
  }

  // 5. Weak Signal: General body text outside confirmation containers (e.g. JD description, similar jobs)
  if (!foundContainerText) {
    const appliedToMatch = bodyText.match(appliedToRegex);
    if (appliedToMatch) {
      signals.push(`weak_text: applied to ${appliedToMatch[1].trim()}`);
    } else {
      for (const ind of selectors.SUCCESS_INDICATORS) {
        if (ind.startsWith('.')) continue;
        if (bodyText.includes(ind.toLowerCase())) {
          signals.push(`weak_text: ${ind}`);
          break;
        }
      }
    }
  }

  // Strong signals require confirmation banner/tick, button state, container text, or marker/url.
  // Weak text appearing merely in general body (such as JD description or similar jobs)
  // MUST NOT return applied on its own.
  const strongSignals = signals.filter(
    s =>
      s.startsWith('banner:') ||
      s.startsWith('button:') ||
      s.startsWith('container_text:') ||
      s.startsWith('marker:') ||
      s.startsWith('url:'),
  );

  const hasStrongSignal = strongSignals.length > 0;
  const isSuccess = hasStrongSignal;
  const confidence: 'high' | 'medium' | 'none' =
    strongSignals.length >= 2 ? 'high' : hasStrongSignal ? 'medium' : 'none';

  return { isSuccess, signals, confidence };
}

/**
 * Questionnaire detection must only count real recruiter questions:
 * elements inside the questionnaire/chatbot container that contain a question text plus options or inputs.
 * The post-apply drawer (quiz, upsell, "Applied to ..." banner) must NEVER be treated as a questionnaire.
 */
export function findNaukriRealQuestionnaire(
  root: Document | HTMLElement,
  selectors: typeof NAUKRI_SELECTORS = NAUKRI_SELECTORS,
): HTMLElement | null {
  const doc = (root as Document).body ? (root as Document) : (root as HTMLElement).ownerDocument || (root as any);

  // Gather candidate modals
  const candidates: HTMLElement[] = [];
  for (const sel of selectors.MODAL_CONTAINER) {
    try {
      const els = Array.from(doc.querySelectorAll(sel)) as HTMLElement[];
      for (const el of els) {
        if ((el.offsetParent !== null || isElementVisible(el)) && !candidates.includes(el)) {
          candidates.push(el);
        }
      }
    } catch {}
  }

  const allFixed = Array.from(doc.querySelectorAll('div, section, aside, form')) as HTMLElement[];
  for (const el of allFixed) {
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (
        (style.position === 'fixed' || style.position === 'absolute') &&
        (el.offsetParent !== null || isElementVisible(el)) &&
        !candidates.includes(el)
      ) {
        candidates.push(el);
      }
    }
  }

  for (const modal of candidates) {
    const text = (modal.innerText || modal.textContent || '').toLowerCase();

    // 1. Explicit exclusion: Upsell / Quiz content ("Problem of the day", "Become a Pro", "FastForward", etc.)
    const isUpsell = (selectors.UPSELL_EXCLUSIONS || []).some((term: string) => text.includes(term.toLowerCase()));
    if (isUpsell) {
      // NEVER treat upsell / quiz drawer as questionnaire!
      continue;
    }

    // 2. Explicit exclusion: Post-apply success drawer
    const isPostApplySuccess =
      text.includes('applied to') ||
      text.includes('successfully applied') ||
      text.includes('application sent') ||
      text.includes('applied successfully') ||
      text.includes('your application has been sent');

    // 3. Count only real recruiter inputs and options (ignoring any inside upsell widgets)
    const inputs = Array.from(
      modal.querySelectorAll(
        'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [contenteditable="true"]',
      ),
    ).filter(inp => !isNaukriUpsellOrQuiz(inp as HTMLElement, selectors));

    const options = Array.from(
      modal.querySelectorAll(selectors.CHATBOT_OPTIONS.join(', ') + ', [role="radio"], [role="checkbox"]'),
    ).filter(opt => !isNaukriUpsellOrQuiz(opt as HTMLElement, selectors));

    if (inputs.length === 0 && options.length === 0) {
      continue;
    }

    // If it contains post-apply success banner and has no recruiter screening keywords, skip it
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
      text.includes('kindly answer') ||
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

    const hasSubmitBtn = Array.from(modal.querySelectorAll(selectors.SUBMIT_BUTTON.join(', '))).some(
      btn => (btn as HTMLElement).offsetParent !== null || isElementVisible(btn as HTMLElement),
    );

    if ((hasRecruiterKeywords || hasSubmitBtn) && (inputs.length > 0 || options.length > 0)) {
      return modal;
    }
  }

  return null;
}
