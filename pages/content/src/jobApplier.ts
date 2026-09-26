// pages/content/src/jobApplier.ts

export interface CandidateProfile {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  currentTitle?: string;
  preferredLocation?: string;
  currentLocation?: string;
  yearsOfExperience?: number;
  workAuthorization?: string;
  skills?: string[];
  education?: string;
  college?: string;
  cgpa?: string;
  currentCTC?: string;
  expectedCTC?: string;
  noticePeriod?: string;
  resumeText?: string;
  goldenAnswers?: Array<{ question: string; answer: string }>;
  customAnswers?: Record<string, string>;
}

export interface ApplyResult {
  success: boolean;
  message: string;
  title: string;
}

interface FormQuestion {
  questionId: string;
  questionText: string;
  questionType: 'text' | 'numeric' | 'boolean' | 'single_select' | 'multi_select';
  options: string[];
  element: HTMLElement;
  type: 'input' | 'select' | 'radio' | 'textarea';
}

/**
 * Universal element visibility checker that handles display:contents, position:fixed/sticky,
 * and flex/grid containers where HTMLElement.offsetParent is null.
 */
export function isElementVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.offsetParent !== null) return true;
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) || (el.getClientRects && el.getClientRects().length > 0);
  } catch {
    return false;
  }
}

/**
 * Send real-time step progress notifications back to Background & Side Panel
 */
function notify(message: string, isError: boolean = false) {
  console.log(`[NanoBrowser Applier] ${message}`);
  try {
    chrome.runtime.sendMessage({
      type: 'APPLY_STEP_UPDATE',
      details: message,
      isError,
    });
  } catch {}
}

/**
 * Accurately finds the Easy Apply modal dialog, ignoring messaging popups and alerts
 */
export function findEasyApplyModal(): HTMLElement | null {
  const modalSelectors = [
    'div.jobs-easy-apply-modal',
    'div[data-test-modal].jobs-easy-apply-modal',
    'div[data-test-modal]',
    'div[role="dialog"][aria-modal="true"]',
    'div.artdeco-modal[role="dialog"]',
    'div[role="dialog"]',
  ];

  for (const sel of modalSelectors) {
    const modals = Array.from(document.querySelectorAll<HTMLElement>(sel));
    for (const m of modals) {
      if (!isElementVisible(m)) continue;

      // Skip the bottom messaging widget or notifications
      if (
        m.closest(
          '#messaging-overlay, .msg-overlay-container, .msg-overlay-bubble-header, [data-view-name="message-overlay"]',
        )
      ) {
        continue;
      }
      if (m.id?.includes('msg') || m.className?.includes('msg-overlay')) {
        continue;
      }

      // Check if it's the Easy Apply modal
      const text = (m.textContent || '').toLowerCase();
      if (
        m.classList.contains('jobs-easy-apply-modal') ||
        text.includes('easy apply') ||
        text.includes('apply to') ||
        text.includes('contact info') ||
        text.includes('resume') ||
        text.includes('submit application') ||
        text.includes('next') ||
        text.includes('review')
      ) {
        return m;
      }
    }
  }
  return null;
}

/**
 * Extract active job details from current LinkedIn tab
 */
export function getActiveJobDetails(): { title: string; company: string } {
  let title = '';
  let company = '';

  // 1. Search inside Job Details pane first (right pane)
  const detailPane = document.querySelector<HTMLElement>(
    '.scaffold-layout__detail, .jobs-search__job-details, .jobs-details__main-content, div[data-view-name="job-details"], .job-details-jobs-unified-top-card, .jobs-search__job-details--container',
  );

  if (detailPane) {
    const headingSelectors = [
      'h1',
      'h2.t-24',
      'h2.job-details-jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title',
      'h2.t-bold',
      'h2',
      'a[href*="/jobs/view/"]',
    ];
    for (const sel of headingSelectors) {
      const el = detailPane.querySelector<HTMLElement>(sel);
      if (el && isElementVisible(el)) {
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (
          text &&
          !text.toLowerCase().includes('filter') &&
          !text.toLowerCase().includes('alert') &&
          text.length > 2
        ) {
          title = text;
          break;
        }
      }
    }

    const companySelectors = [
      '.job-details-jobs-unified-top-card__company-name',
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__primary-description a',
      '.jobs-unified-top-card__company-name',
      'a[href*="/company/"]',
    ];
    for (const sel of companySelectors) {
      const el = detailPane.querySelector<HTMLElement>(sel);
      if (el && isElementVisible(el)) {
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (text && !text.toLowerCase().includes('filter') && text.length > 1) {
          company = text;
          break;
        }
      }
    }
  }

  // 2. High-precision fallback: parse document.title (e.g. "Software Engineer | Jobtogether | LinkedIn")
  if (!title || title === 'LinkedIn Job') {
    const docTitle = document.title || '';
    const parts = docTitle.split('|').map(s => s.trim());
    if (parts.length >= 2) {
      title = parts[0];
      if (!company && parts[1] && !parts[1].toLowerCase().includes('linkedin')) {
        company = parts[1];
      }
    }
  }

  return {
    title: title || 'LinkedIn Job',
    company: company || 'Company',
  };
}

/**
 * Thorough click simulator dispatching Pointer, Mouse, and native click events on element & children
 */
function humanClick(element: HTMLElement) {
  element.scrollIntoView({ behavior: 'instant', block: 'center' });
  element.focus();
  const mouseOpts = { bubbles: true, cancelable: true, view: window };
  element.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
  element.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
  element.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
  element.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
  element.click();

  // Also dispatch on first clickable child if available (e.g. span.artdeco-button__text)
  const innerSpan = element.querySelector<HTMLElement>('span.artdeco-button__text, span, svg');
  if (innerSpan && innerSpan !== element) {
    innerSpan.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
    innerSpan.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    innerSpan.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
    innerSpan.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    innerSpan.click();
  }
}

/**
 * React-compatible value setter using prototype descriptor
 */
function setReactInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  if (!value && value !== '0') return;
  input.focus();
  input.dispatchEvent(new Event('focus', { bubbles: true }));

  const proto =
    input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

/**
 * React-compatible select dropdown setter
 */
function setReactSelectValue(select: HTMLSelectElement, matchText: string) {
  if (!matchText) return;
  const lower = matchText.toLowerCase().trim();
  for (let i = 0; i < select.options.length; i++) {
    const opt = select.options[i];
    const optText = (opt.text || opt.value || '').toLowerCase().trim();
    if (optText === lower || optText.includes(lower) || lower.includes(optText)) {
      select.selectedIndex = i;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
}

/**
 * React-compatible radio button clicker
 */
function selectRadio(radio: HTMLInputElement) {
  radio.scrollIntoView({ behavior: 'instant', block: 'center' });
  const mouseOpts = { bubbles: true, cancelable: true, view: window };
  radio.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
  radio.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
  radio.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
  radio.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
  radio.click();
  radio.checked = true;
  radio.dispatchEvent(new Event('input', { bubbles: true }));
  radio.dispatchEvent(new Event('change', { bubbles: true }));

  const label = document.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
  if (label && label !== (radio as unknown as Element)) {
    label.dispatchEvent(new MouseEvent('click', mouseOpts));
  }
}

/**
 * Finds the actual Easy Apply button with geometric coordinates and semantic hierarchy scoring
 */
function findLinkedInEasyApplyButton(): HTMLElement | null {
  const allButtons = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, [role="button"], a.jobs-apply-button, .jobs-apply-button--top-card button, .jobs-s-apply button',
    ),
  );

  const candidates: Array<{ el: HTMLElement; score: number }> = [];

  for (const el of allButtons) {
    if (!isElementVisible(el)) continue;
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;

    // 1. MUST NOT be inside top header or search filter bar
    if (
      el.closest(
        'header, nav, .global-nav, .jobs-search-box, .search-reusables__filter-list, .artdeco-pill, [class*="search-filters"], #global-nav',
      )
    ) {
      continue;
    }

    // 2. MUST NOT be inside the left-hand search results list
    if (
      el.closest(
        '.scaffold-layout__list, .jobs-search-results-list, ul.jobs-search-results__list, li[data-occludable-job-id], .jobs-search-two-pane__job-list',
      )
    ) {
      continue;
    }

    // 3. Coordinate check: Must be in main content area (not in top header bar y < 100)
    const rect = el.getBoundingClientRect();
    if (rect.top < 100) {
      continue;
    }

    const text = (el.innerText || el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const aria = (el.getAttribute('aria-label') || '').toLowerCase().replace(/\s+/g, ' ');

    // 4. Must NOT be Save, Follow, Share, Report, Alert, Filter
    if (
      text.includes('save') ||
      aria.includes('save') ||
      text.includes('follow') ||
      text.includes('share') ||
      text.includes('report') ||
      text.includes('filter') ||
      aria.includes('filter') ||
      text.includes('alert')
    ) {
      continue;
    }

    // 5. Must match Easy Apply
    let score = 0;
    if (text.includes('easy apply') || aria.includes('easy apply')) {
      score += 100;
    } else if (text.includes('apply') && !text.includes('applied')) {
      score += 50;
    } else {
      continue;
    }

    // Boost score if inside job details / top card
    if (
      el.closest(
        '.scaffold-layout__detail, .jobs-search__job-details, .job-details-jobs-unified-top-card, .jobs-apply-button--top-card, .jobs-s-apply',
      )
    ) {
      score += 50;
    }

    // Boost score if primary artdeco button
    if (el.classList.contains('artdeco-button--primary') || el.closest('.artdeco-button--primary')) {
      score += 30;
    }

    // Boost score if has jobs-apply-button class
    if (el.classList.contains('jobs-apply-button')) {
      score += 30;
    }

    candidates.push({ el, score });
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length > 0 ? candidates[0].el : null;
}

/**
 * Locate and click the Easy Apply button strictly in the Job Details pane
 */
async function locateAndClickEasyApply(): Promise<boolean> {
  // 1. Check if Easy Apply modal is ALREADY open
  const existingModal = findEasyApplyModal();
  if (existingModal) {
    notify('Easy Apply modal is already open.');
    return true;
  }

  // 2. Poll for Easy Apply button (up to 8 seconds)
  const maxAttempts = 16;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check if modal opened in the meantime
    const openModal = findEasyApplyModal();
    if (openModal) {
      notify('Easy Apply modal is already open.');
      return true;
    }

    const targetBtn = findLinkedInEasyApplyButton();

    if (targetBtn) {
      const btnLabel = (
        targetBtn.innerText ||
        targetBtn.textContent ||
        targetBtn.getAttribute('aria-label') ||
        'Easy Apply'
      ).trim();
      notify(`🎯 Found Easy Apply button ("${btnLabel}"). Clicking...`);
      humanClick(targetBtn);

      // Wait up to 2 seconds to see if modal opens
      for (let w = 0; w < 8; w++) {
        await new Promise(r => setTimeout(r, 250));
        const opened = findEasyApplyModal();
        if (opened) {
          notify('📝 Easy Apply modal opened successfully!');
          return true;
        }
      }

      // If modal didn't open, re-trigger click with native click & inner span
      notify('🔄 Re-triggering click on Easy Apply button...');
      targetBtn.click();
      const inner = targetBtn.querySelector<HTMLElement>('span, svg');
      if (inner) inner.click();

      // Check once more
      await new Promise(r => setTimeout(r, 500));
      if (findEasyApplyModal()) {
        notify('📝 Easy Apply modal opened successfully!');
        return true;
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return false;
}

/**
 * Extract human readable label for any form input
 */
function getFieldLabel(el: HTMLElement, modal: HTMLElement): string {
  if (el.id) {
    const lbl = modal.querySelector<HTMLElement>(`label[for="${el.id}"]`);
    if (lbl && (lbl.innerText || lbl.textContent)?.trim()) {
      return (lbl.innerText || lbl.textContent)!.trim().replace(/\s+/g, ' ');
    }
  }

  const parentLabel = el.closest('label');
  if (parentLabel && (parentLabel.innerText || parentLabel.textContent)?.trim()) {
    return (parentLabel.innerText || parentLabel.textContent)!.trim().replace(/\s+/g, ' ');
  }

  const container = el.closest(
    '.jobs-easy-apply-form-section__grouping, .fb-dash-form-element, .artdeco-text-input--container, .jobs-easy-apply-form-element, div.mb4, div.mt4',
  );
  if (container) {
    const heading = container.querySelector<HTMLElement>(
      'label, [role="heading"], legend, span.t-14, .artdeco-text-input--label',
    );
    if (heading && (heading.innerText || heading.textContent)?.trim()) {
      return (heading.innerText || heading.textContent)!.trim().replace(/\s+/g, ' ');
    }
  }

  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();

  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return placeholder.trim();

  return (el.getAttribute('name') || el.id || 'Question').trim();
}

/**
 * Pre-fills known standard candidate fields (Phone, Email, Name, City, Standard Dropdowns/Radios)
 */
function fillStandardFields(modal: HTMLElement, profile: CandidateProfile) {
  const firstName = profile.firstName || profile.fullName?.split(' ')[0] || 'Candidate';
  const lastName = profile.lastName || profile.fullName?.split(' ').slice(1).join(' ') || '';
  const phone = profile.phoneNumber || '';
  const email = profile.email || '';
  const location = profile.preferredLocation || profile.currentLocation || '';
  const experienceYears =
    profile.yearsOfExperience !== undefined && profile.yearsOfExperience !== null ? profile.yearsOfExperience : 0;

  // 1. Phone Input (fill ONLY if empty)
  const phoneInputs = Array.from(
    modal.querySelectorAll<HTMLInputElement>(
      'input[type="tel"], input[id*="phone" i], input[name*="phone" i], input[autocomplete="tel"]',
    ),
  );
  for (const input of phoneInputs) {
    if (isElementVisible(input) && (!input.value || input.value.trim() === '')) {
      setReactInputValue(input, phone);
    }
  }

  // 2. Email Input (fill ONLY if empty)
  const emailInputs = Array.from(
    modal.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[id*="email" i], input[name*="email" i], input[autocomplete="email"]',
    ),
  );
  for (const input of emailInputs) {
    if (isElementVisible(input) && (!input.value || input.value.trim() === '')) {
      setReactInputValue(input, email);
    }
  }

  // 3. First Name & Last Name (fill ONLY if empty)
  const firstInputs = Array.from(
    modal.querySelectorAll<HTMLInputElement>(
      'input[id*="firstName" i], input[name*="firstName" i], input[autocomplete="given-name"]',
    ),
  );
  for (const input of firstInputs) {
    if (isElementVisible(input) && (!input.value || input.value.trim() === '')) {
      setReactInputValue(input, firstName);
    }
  }

  const lastInputs = Array.from(
    modal.querySelectorAll<HTMLInputElement>(
      'input[id*="lastName" i], input[name*="lastName" i], input[autocomplete="family-name"]',
    ),
  );
  for (const input of lastInputs) {
    if (isElementVisible(input) && (!input.value || input.value.trim() === '')) {
      setReactInputValue(input, lastName);
    }
  }

  // 4. City / Location Input (fill ONLY if empty)
  const locInputs = Array.from(
    modal.querySelectorAll<HTMLInputElement>(
      'input[id*="city" i], input[id*="location" i], input[name*="city" i], input[name*="location" i]',
    ),
  );
  for (const input of locInputs) {
    if (isElementVisible(input) && (!input.value || input.value.trim() === '')) {
      setReactInputValue(input, location);
    }
  }

  // 5. Numeric Experience Inputs (fill ONLY if empty)
  const numberInputs = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="number"]')).filter(
    isElementVisible,
  );
  for (const input of numberInputs) {
    if (!input.value || input.value.trim() === '') {
      setReactInputValue(input, String(experienceYears));
    }
  }

  // 6. Standard Radio Groups (Authorization, Sponsorship, Golden Answers)
  const fieldsets = Array.from(
    modal.querySelectorAll<HTMLElement>('fieldset, div[role="radiogroup"], .jobs-easy-apply-form-section__grouping'),
  );
  for (const fs of fieldsets) {
    const radios = Array.from(fs.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    if (radios.length === 0 || !isElementVisible(fs)) continue;
    if (radios.some(r => r.checked)) continue; // Already selected!

    const legend = fs.querySelector('legend, [role="heading"], label, span.t-14');
    const question = (legend?.textContent || '').trim().toLowerCase();

    let selectChoice = '';

    // Check custom golden answers
    if (profile.goldenAnswers && profile.goldenAnswers.length > 0) {
      for (const ga of profile.goldenAnswers) {
        if (question.includes(ga.question.toLowerCase())) {
          selectChoice = ga.answer.toLowerCase();
          break;
        }
      }
    }

    if (!selectChoice) {
      if (
        question.includes('authorized') ||
        question.includes('legally') ||
        question.includes('eligibility') ||
        question.includes('right to work')
      ) {
        selectChoice = 'yes';
      } else if (
        question.includes('sponsorship') ||
        question.includes('require sponsor') ||
        question.includes('visa support')
      ) {
        selectChoice = 'no';
      } else if (
        question.includes('background') ||
        question.includes('drug') ||
        question.includes('commute') ||
        question.includes('relocate') ||
        question.includes('willing')
      ) {
        selectChoice = 'yes';
      }
    }

    if (selectChoice) {
      for (const r of radios) {
        const lbl = fs.querySelector(`label[for="${r.id}"]`) || r.closest('label');
        const text = (lbl?.textContent || r.value || '').trim().toLowerCase();
        if (text === selectChoice || text.startsWith(selectChoice) || text.includes(selectChoice)) {
          selectRadio(r);
          break;
        }
      }
    }
  }

  // 7. Standard Native Selects (Work Auth, Sponsorship, Notice Period)
  const selectElements = Array.from(modal.querySelectorAll<HTMLSelectElement>('select:not([disabled])')).filter(
    isElementVisible,
  );
  for (const sel of selectElements) {
    const isSelected =
      sel.selectedIndex > 0 &&
      sel.value !== '' &&
      !sel.options[sel.selectedIndex]?.text.toLowerCase().includes('select');
    if (isSelected) continue; // Already chosen!

    const label = modal.querySelector(`label[for="${sel.id}"]`) || sel.closest('label');
    const selText = (label?.textContent || sel.name || '').toLowerCase();

    if (
      selText.includes('authorized') ||
      selText.includes('legally') ||
      selText.includes('eligible') ||
      selText.includes('clearance')
    ) {
      setReactSelectValue(sel, 'Yes');
    } else if (selText.includes('sponsorship') || selText.includes('visa')) {
      setReactSelectValue(sel, 'No');
    } else if (selText.includes('notice')) {
      setReactSelectValue(sel, 'Immediate');
    }
  }

  // 8. Resume Selection
  const resumeRadios = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  let resumeSelected = false;
  for (const radio of resumeRadios) {
    const container = radio.closest('div, label, li');
    const text = (container?.textContent || '').toLowerCase();
    if (
      text.includes('.pdf') ||
      text.includes('.doc') ||
      text.includes('resume') ||
      radio.name.toLowerCase().includes('resume')
    ) {
      selectRadio(radio);
      resumeSelected = true;
      break;
    }
  }

  if (!resumeSelected && resumeRadios.length > 0 && !resumeRadios.some(r => r.checked)) {
    const isResumeStep = (modal.textContent || '').toLowerCase().includes('resume');
    if (isResumeStep) {
      selectRadio(resumeRadios[0]);
    }
  }
}

/**
 * Detect all unanswered/empty questions on current modal step
 */
function getUnansweredQuestions(modal: HTMLElement): FormQuestion[] {
  const unanswered: FormQuestion[] = [];

  // 1. Text, number, tel, email inputs and textareas
  const textInputs = Array.from(
    modal.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type]), textarea',
    ),
  ).filter(el => isElementVisible(el) && !el.disabled && el.getAttribute('type') !== 'hidden');

  for (const input of textInputs) {
    if (input.value && input.value.trim().length > 0) continue; // Already filled!

    const label = getFieldLabel(input, modal);
    const qType = input.type === 'number' ? 'numeric' : 'text';
    const qId = input.id || input.name || `input_${unanswered.length}`;

    unanswered.push({
      questionId: qId,
      questionText: label,
      questionType: qType,
      options: [],
      element: input,
      type: input instanceof HTMLTextAreaElement ? 'textarea' : 'input',
    });
  }

  // 2. Select dropdowns
  const selectElements = Array.from(modal.querySelectorAll<HTMLSelectElement>('select:not([disabled])')).filter(
    isElementVisible,
  );

  for (const sel of selectElements) {
    const isSelected =
      sel.selectedIndex > 0 &&
      sel.value !== '' &&
      !sel.options[sel.selectedIndex]?.text.toLowerCase().includes('select');
    if (isSelected) continue; // Already chosen!

    const label = getFieldLabel(sel, modal);
    const options = Array.from(sel.options)
      .map(o => (o.text || o.value || '').trim())
      .filter(t => t && !t.toLowerCase().includes('select'));
    const qId = sel.id || sel.name || `select_${unanswered.length}`;

    unanswered.push({
      questionId: qId,
      questionText: label,
      questionType: 'single_select',
      options,
      element: sel,
      type: 'select',
    });
  }

  // 3. Radio groups
  const fieldsets = Array.from(
    modal.querySelectorAll<HTMLElement>('fieldset, div[role="radiogroup"], .jobs-easy-apply-form-section__grouping'),
  ).filter(fs => {
    const radios = fs.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    return radios.length > 0 && isElementVisible(fs);
  });

  for (const fs of fieldsets) {
    const radios = Array.from(fs.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    if (radios.length === 0) continue;
    const isChecked = radios.some(r => r.checked);
    if (isChecked) continue; // Already checked!

    const heading = fs.querySelector<HTMLElement>('legend, [role="heading"], label, span.t-14');
    const label = (heading?.innerText || heading?.textContent || 'Question').trim();
    const options = radios
      .map(r => {
        const lbl = fs.querySelector(`label[for="${r.id}"]`) || r.closest('label');
        return (lbl?.textContent || r.value || '').trim();
      })
      .filter(Boolean);
    const qId = fs.id || radios[0]?.name || `radio_${unanswered.length}`;

    unanswered.push({
      questionId: qId,
      questionText: label,
      questionType: 'single_select',
      options,
      element: fs,
      type: 'radio',
    });
  }

  return unanswered;
}

/**
 * Solve custom screening questions by querying background LLM with Resume and CareerBrain
 */
async function solveQuestionsWithAI(unanswered: FormQuestion[]): Promise<void> {
  if (unanswered.length === 0) return;

  const payload = unanswered.map(q => ({
    questionId: q.questionId,
    questionText: q.questionText,
    questionType: q.questionType,
    required: true,
    options: q.options,
    userAnswer: null,
  }));

  const AI_TIMEOUT_MS = 15000; // 15 seconds max for LLM response

  try {
    const messagePromise = new Promise<{
      success: boolean;
      solutions?: Array<{
        questionId: string;
        answer: string;
        confidence: number;
        isConfident: boolean;
        reasoning: string;
      }>;
    }>(resolve => {
      chrome.runtime.sendMessage(
        {
          type: 'SOLVE_SCREENING_QUESTIONS',
          questions: payload,
        },
        response => {
          if (chrome.runtime.lastError) {
            resolve({ success: false });
          } else {
            resolve(response || { success: false });
          }
        },
      );
    });

    const timeoutPromise = new Promise<{ success: false }>(resolve => {
      setTimeout(() => resolve({ success: false }), AI_TIMEOUT_MS);
    });

    const res = await Promise.race([messagePromise, timeoutPromise]);

    if (res.success && Array.isArray(res.solutions)) {
      const solutionMap = new Map(res.solutions.map(s => [s.questionId, s]));

      for (const q of unanswered) {
        const sol = solutionMap.get(q.questionId);
        let ans = sol?.answer || '';

        // Fallback: match by question text substring if fieldId didn't match
        if (!ans) {
          for (const s of res.solutions) {
            if (!s.answer || !s.isConfident) continue;
            const qLower = q.questionText.toLowerCase();
            if (
              qLower.includes(s.questionId.toLowerCase()) ||
              s.questionId.toLowerCase().includes(qLower.slice(0, 20))
            ) {
              ans = s.answer;
              break;
            }
          }
        }

        if (!ans) continue;

        notify(`💡 AI Answered: "${q.questionText.slice(0, 40)}..." → "${ans}"`);
        if (q.type === 'input' || q.type === 'textarea') {
          setReactInputValue(q.element as HTMLInputElement, ans);
        } else if (q.type === 'select') {
          setReactSelectValue(q.element as HTMLSelectElement, ans);
        } else if (q.type === 'radio') {
          const fs = q.element;
          const radios = Array.from(fs.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
          const lowerAns = ans.toLowerCase();
          let chosenRadio: HTMLInputElement | null = null;
          for (const r of radios) {
            const lbl = fs.querySelector(`label[for="${r.id}"]`) || r.closest('label');
            const optText = (lbl?.textContent || r.value || '').trim().toLowerCase();
            if (optText === lowerAns || optText.includes(lowerAns) || lowerAns.includes(optText)) {
              chosenRadio = r;
              break;
            }
          }
          if (chosenRadio) {
            selectRadio(chosenRadio);
          } else if (radios.length > 0) {
            selectRadio(radios[0]);
          }
        }
      }
    } else {
      notify('⚠️ AI question solver returned no results or timed out. Proceeding with best-effort.', true);
    }
  } catch (err) {
    console.error('[NanoBrowser Applier] Failed to solve questions with AI:', err);
    notify('⚠️ AI question solver error. Proceeding with best-effort.', true);
  }
}

/**
 * Locate Submit button in modal
 */
function findSubmitButton(modal: HTMLElement): HTMLElement | null {
  const allButtons = Array.from(
    modal.querySelectorAll<HTMLElement>('button, div[role="button"], input[type="submit"]'),
  );

  for (const btn of allButtons) {
    if (!isElementVisible(btn)) continue;
    if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') continue;

    const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const controlName = (btn.getAttribute('data-control-name') || '').toLowerCase();

    if (
      text.includes('submit application') ||
      aria.includes('submit application') ||
      controlName.includes('submit') ||
      (text === 'submit' && !text.includes('filter')) ||
      (aria === 'submit' && !aria.includes('filter'))
    ) {
      return btn;
    }
  }
  return null;
}

/**
 * Locate Next or Review button in modal
 */
function findNextButton(modal: HTMLElement): HTMLElement | null {
  const allButtons = Array.from(modal.querySelectorAll<HTMLElement>('button, div[role="button"]'));

  for (const btn of allButtons) {
    if (!isElementVisible(btn)) continue;
    if (btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') continue;

    const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const classes = (btn.className || '').toLowerCase();

    // Skip back, dismiss, cancel, and submit buttons
    if (
      text.includes('dismiss') ||
      text.includes('cancel') ||
      text.includes('back') ||
      text.includes('submit') ||
      aria.includes('dismiss') ||
      aria.includes('cancel') ||
      aria.includes('back') ||
      aria.includes('submit')
    ) {
      continue;
    }

    if (
      text.includes('next') ||
      text.includes('review') ||
      text.includes('continue') ||
      aria.includes('next') ||
      aria.includes('review') ||
      aria.includes('continue to next step') ||
      aria.includes('review your application')
    ) {
      return btn;
    }

    // Also check primary button in modal footer (only if not submit)
    if (
      classes.includes('artdeco-button--primary') &&
      btn.closest('footer, .jobs-easy-apply-modal__footer, .artdeco-modal__actionbar')
    ) {
      return btn;
    }
  }
  return null;
}

/**
 * Click Next, Review, or Submit button in modal footer with retries
 */
async function advanceOrSubmitModal(modal: HTMLElement): Promise<'SUBMITTED' | 'ADVANCED' | 'BLOCKED'> {
  // Retry up to 6 times (1.5 seconds) to allow React state updates to enable the button
  for (let attempt = 0; attempt < 6; attempt++) {
    // 1. Submit Button
    const submitBtn = findSubmitButton(modal);
    if (submitBtn) {
      notify('🚀 Clicking "Submit Application"...');
      humanClick(submitBtn);
      return 'SUBMITTED';
    }

    // 2. Next / Review Button
    const nextBtn = findNextButton(modal);
    if (nextBtn) {
      const text = (nextBtn.innerText || nextBtn.textContent || nextBtn.getAttribute('aria-label') || 'Next').trim();
      notify(`➡️ Advancing to next step ("${text}")...`);
      humanClick(nextBtn);
      return 'ADVANCED';
    }

    await new Promise(r => setTimeout(r, 250));
  }

  // Check for any validation error text shown on the form
  const errorElements = Array.from(
    modal.querySelectorAll<HTMLElement>(
      '.artdeco-inline-feedback--error, [data-test-form-element-error-message], .fb-form-element--error',
    ),
  ).filter(isElementVisible);
  if (errorElements.length > 0) {
    const errorMsgs = errorElements
      .map(e => (e.innerText || e.textContent || '').trim())
      .filter(Boolean)
      .join('; ');
    notify(`⚠️ Form error detected: ${errorMsgs}`, true);
  }

  return 'BLOCKED';
}

/**
 * Check if the application was successfully submitted and dismiss modal
 */
async function checkSubmissionAndDismiss(): Promise<boolean> {
  const maxWait = 6;
  for (let i = 0; i < maxWait; i++) {
    await new Promise(r => setTimeout(r, 600));

    const modal = findEasyApplyModal();
    if (!modal) {
      // Modal closed cleanly
      return true;
    }

    const text = (modal.textContent || '').toLowerCase();
    const isSuccess =
      text.includes('your application was sent') ||
      text.includes('application submitted') ||
      text.includes('application sent') ||
      text.includes('your application has been sent');

    if (isSuccess) {
      notify('🎉 Application submitted! Closing confirmation dialog...');
      const dismissBtn = modal.querySelector<HTMLElement>(
        'button[aria-label*="dismiss" i], button.artdeco-modal__dismiss, button[data-test-modal-close-btn], button[data-control-name="overlay.close_padding"]',
      );
      if (dismissBtn) humanClick(dismissBtn);
      return true;
    }
  }

  return false;
}

/**
 * Main Direct LinkedIn Easy Apply Runner
 * Fast, simple, robust, zero CDP index errors.
 */
export async function applyCurrentJobDirectly(profile: CandidateProfile): Promise<ApplyResult> {
  const jobDetails = getActiveJobDetails();
  notify(`🎯 Targeting Job: "${jobDetails.title}" at "${jobDetails.company}"...`);

  // 1. Locate and click Easy Apply button in the Job Details pane
  const clicked = await locateAndClickEasyApply();
  if (!clicked) {
    notify(`⚠️ No Easy Apply button found for "${jobDetails.title}". (May be external or already applied)`, true);
    return {
      success: false,
      message: 'SKIPPED_EXTERNAL_SITE',
      title: jobDetails.title,
    };
  }

  // 2. Wait for modal to open
  let modal: HTMLElement | null = findEasyApplyModal();
  for (let i = 0; i < 8; i++) {
    if (modal) break;
    await new Promise(r => setTimeout(r, 300));
    modal = findEasyApplyModal();
  }

  if (!modal) {
    notify('⚠️ Easy Apply modal failed to open after click.', true);
    return {
      success: false,
      message: 'MODAL_FAILED_TO_OPEN',
      title: jobDetails.title,
    };
  }

  notify('📝 Application modal open. Beginning automated step completion...');

  // 3. Multi-Step Form Execution Loop (up to 12 steps)
  const maxSteps = 12;
  let currentStep = 1;

  while (currentStep <= maxSteps) {
    modal = findEasyApplyModal();
    if (!modal) {
      // Modal closed, application completed
      return {
        success: true,
        message: 'Successfully applied to job!',
        title: jobDetails.title,
      };
    }

    // Step A: Pre-fill standard fields (Phone, Email, Name, City, standard work auth)
    fillStandardFields(modal, profile);

    // Step B: Check if there are unanswered custom questions
    const unanswered = getUnansweredQuestions(modal);

    if (unanswered.length === 0) {
      notify(`✅ Step ${currentStep} fields are ready/filled. Advancing immediately...`);
    } else {
      notify(`🧠 Step ${currentStep} has ${unanswered.length} question(s). Asking AI (Resume & CareerBrain)...`);
      await solveQuestionsWithAI(unanswered);
      await new Promise(r => setTimeout(r, 400));
    }

    // Step C: Advance or Submit
    const action = await advanceOrSubmitModal(modal);

    if (action === 'SUBMITTED') {
      const confirmed = await checkSubmissionAndDismiss();
      if (confirmed) {
        notify(`🎉 Application successfully submitted for "${jobDetails.title}"!`);
        return {
          success: true,
          message: 'APPLIED',
          title: jobDetails.title,
        };
      } else {
        return {
          success: true,
          message: 'APPLIED_PENDING_CONFIRMATION',
          title: jobDetails.title,
        };
      }
    } else if (action === 'ADVANCED') {
      currentStep++;
      await new Promise(r => setTimeout(r, 600));
    } else {
      // If blocked, log and report
      notify(`⚠️ Step ${currentStep} has required fields that need manual review.`, true);
      return {
        success: false,
        message: 'BLOCKED_MANUAL_REVIEW_REQUIRED',
        title: jobDetails.title,
      };
    }
  }

  return {
    success: false,
    message: 'MAX_STEPS_EXCEEDED',
    title: jobDetails.title,
  };
}
