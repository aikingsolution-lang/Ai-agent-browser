// chrome-extension/src/background/agent/platforms/naukri/classification.ts

export interface NaukriClassificationResult {
  type: 'direct_apply' | 'external' | 'already_applied' | 'no_button' | 'waiting';
  buttonText: string;
  applyAreaExists: boolean;
  documentReadyState: string;
  applyRelatedButtons: string[];
}

/**
 * Inspects the Naukri job details DOM to classify the apply state.
 * Never throws even when doc or elements are null or missing.
 *
 * Rules:
 * - 'already_applied': Button or badge indicates already applied ('applied', 'already applied', 'application sent').
 * - 'direct_apply': Active, visible apply button ('Apply', 'Quick apply', 'apply-button').
 * - 'external': EXPLICIT external-apply control ('Apply on company site', 'Apply on employer website', '#company-site-button').
 *   Never triggered by generic links like "Company website" in company about sections.
 * - 'waiting': Document is loading or apply container has not rendered yet.
 * - 'no_button': Page has loaded but contains no apply controls.
 */
export function inspectNaukriJobPage(doc?: Document | null): NaukriClassificationResult {
  const currentDoc = doc !== undefined ? doc : typeof document !== 'undefined' ? document : null;
  if (!currentDoc) {
    return {
      type: 'waiting',
      buttonText: '',
      applyAreaExists: false,
      documentReadyState: 'uninitialized',
      applyRelatedButtons: [],
    };
  }

  const documentReadyState = currentDoc.readyState || 'unknown';

  // 1. Check if apply container / header area exists
  const applyContainerSelectors = [
    '.apply-button-container',
    '.top-jd-container',
    '.jd-top-head',
    '.apply-pwa-container',
    '.styles_apply-button-container',
    '[class*="apply-button-container"]',
    '[class*="top-jd-container"]',
    '[class*="jd-header"]',
    '.styles_jhc__top-bar__',
    '[class*="top-bar"]',
  ];
  let applyAreaExists = false;
  try {
    for (const sel of applyContainerSelectors) {
      if (currentDoc.querySelector(sel)) {
        applyAreaExists = true;
        break;
      }
    }
    if (!applyAreaExists) {
      if (
        currentDoc.querySelector(
          'button#apply-button, button.apply-button, button#company-site-button, button.company-site-button, button.waves-effect',
        )
      ) {
        applyAreaExists = true;
      }
    }
  } catch {}

  // 2. Discover visible text of all apply-related buttons and links
  const applyRelatedButtons: string[] = [];
  try {
    const candidateElements = Array.from(currentDoc.querySelectorAll('button, a, [role="button"]')) as HTMLElement[];
    for (const el of candidateElements) {
      const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
      const id = el.id || '';
      const cls = el.className || '';
      const isRelated =
        /\b(?:apply|applied|company site|employer website|external|quick apply)\b/i.test(text) ||
        /\b(?:apply|company-site)\b/i.test(id) ||
        /\b(?:apply-button|company-site-button)\b/i.test(cls);
      if (isRelated && text.length > 0 && text.length < 80) {
        const isVisible = el.offsetParent !== null;
        const tag = el.tagName ? el.tagName.toLowerCase() : 'el';
        applyRelatedButtons.push(`<${tag}> "${text.replace(/\s+/g, ' ')}" (visible=${isVisible})`);
      }
    }
  } catch {}

  // 3. Step A: Check for Already Applied
  try {
    const appliedBadges = currentDoc.querySelectorAll(
      '.applied-badge, .already-applied, [data-qa*="applied"], .apply-message-container, .apply-message, div[class*="apply-message" i], div[class*="applied-banner" i], div[class*="success-msg" i]',
    );
    for (const badge of Array.from(appliedBadges) as HTMLElement[]) {
      const bText = (badge.textContent || '').trim().toLowerCase();
      if (
        bText.includes('already applied') ||
        bText.includes('you applied') ||
        bText.includes('applied on') ||
        bText.includes('applied to') ||
        bText.includes('applied today') ||
        bText.includes('application sent')
      ) {
        return {
          type: 'already_applied',
          buttonText: (badge.textContent || '').trim().slice(0, 50),
          applyAreaExists,
          documentReadyState,
          applyRelatedButtons,
        };
      }
    }

    const applyButtons = Array.from(
      currentDoc.querySelectorAll(
        'button#apply-button, button.apply-button, button.waves-effect, .apply-pwa-btn, button',
      ),
    ) as HTMLElement[];
    for (const btn of applyButtons) {
      if (btn.offsetParent !== null) {
        const btnText = (btn.textContent || '').trim().toLowerCase();
        if (/^(?:already applied|applied|you applied|applied today)$/i.test(btnText)) {
          return {
            type: 'already_applied',
            buttonText: (btn.textContent || '').trim(),
            applyAreaExists,
            documentReadyState,
            applyRelatedButtons,
          };
        }
      }
    }
  } catch {}

  // 4. Step B: Check for Direct Apply Button
  try {
    const directBtnSelectors = [
      'button#apply-button',
      'button.apply-button',
      '.apply-pwa-btn',
      'button.waves-effect',
      'button[id*="apply" i]',
    ];
    for (const sel of directBtnSelectors) {
      const btn = currentDoc.querySelector(sel) as HTMLElement | null;
      if (btn && btn.offsetParent !== null) {
        const text = (btn.textContent || '').trim();
        const textLower = text.toLowerCase();
        if (
          !textLower.includes('apply on company site') &&
          !textLower.includes('apply on employer website') &&
          !textLower.includes('redirecting to employer') &&
          !textLower.includes('company site')
        ) {
          if (!/^(?:already applied|applied|you applied)$/i.test(textLower)) {
            return {
              type: 'direct_apply',
              buttonText: text,
              applyAreaExists,
              documentReadyState,
              applyRelatedButtons,
            };
          }
        }
      }
    }

    const allButtons = Array.from(currentDoc.querySelectorAll('button, a')) as HTMLElement[];
    for (const b of allButtons) {
      if (b.offsetParent !== null) {
        const bText = (b.textContent || '').trim().toLowerCase();
        if (bText === 'apply' || bText === 'quick apply' || bText === 'apply now') {
          return {
            type: 'direct_apply',
            buttonText: (b.textContent || '').trim(),
            applyAreaExists,
            documentReadyState,
            applyRelatedButtons,
          };
        }
      }
    }
  } catch {}

  // 5. Step C: Check for EXPLICIT External Apply Control
  try {
    const externalBtn = currentDoc.querySelector(
      'button#company-site-button, button.company-site-button, .company-site-button',
    ) as HTMLElement | null;
    if (externalBtn && externalBtn.offsetParent !== null) {
      return {
        type: 'external',
        buttonText: (externalBtn.textContent || '').trim(),
        applyAreaExists,
        documentReadyState,
        applyRelatedButtons,
      };
    }

    const allButtons = Array.from(currentDoc.querySelectorAll('button, a')) as HTMLElement[];
    for (const b of allButtons) {
      if (b.offsetParent !== null) {
        const bText = (b.textContent || '').trim().toLowerCase();
        if (
          bText === 'apply on company site' ||
          bText === 'apply on employer website' ||
          bText === 'apply on website' ||
          bText.includes('apply on company site') ||
          bText.includes('apply on employer website') ||
          bText.includes('redirecting to employer')
        ) {
          return {
            type: 'external',
            buttonText: (b.textContent || '').trim(),
            applyAreaExists,
            documentReadyState,
            applyRelatedButtons,
          };
        }
      }
    }
  } catch {}

  // 6. Step D: Still rendering / waiting
  return {
    type: 'waiting',
    buttonText: '',
    applyAreaExists,
    documentReadyState,
    applyRelatedButtons,
  };
}
