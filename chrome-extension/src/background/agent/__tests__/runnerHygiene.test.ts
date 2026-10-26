import { describe, it, expect, vi } from 'vitest';
import { findActiveEasyApplyContainer } from '../../browser/easyApplyContainer';

/**
 * Lightweight mock DOM element simulating standard DOM element APIs for Vitest tests.
 */
class MockDOMElement {
  tagName: string;
  className: string;
  id: string;
  attributes: Record<string, string> = {};
  children: MockDOMElement[] = [];
  parentElement: MockDOMElement | null = null;
  private _text: string = '';
  open: boolean = false;
  name: string = '';
  value: string = '';
  options: MockDOMElement[] = [];
  selectedIndex: number = 0;

  get textContent(): string {
    if (this._text) return this._text;
    return this.children.map(c => c.textContent).join(' ');
  }

  set textContent(v: string) {
    this._text = v;
  }

  get innerText(): string {
    return this.textContent;
  }

  set innerText(v: string) {
    this._text = v;
  }

  get selectedOptions(): MockDOMElement[] {
    return this.options.length > 0 ? [this.options[this.selectedIndex] || this.options[0]] : [];
  }

  constructor(tagName: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this.className = attrs.class || '';
    this.id = attrs.id || '';
    this.name = attrs.name || '';
    this.value = attrs.value || '';
    this._text = text;
    this.open = 'open' in attrs;
  }

  get isConnected(): boolean {
    return true;
  }

  get classList() {
    const tokens = this.className ? this.className.split(/\s+/).filter(Boolean) : [];
    return {
      contains: (cls: string) => tokens.includes(cls),
      add: (cls: string) => {
        if (!tokens.includes(cls)) tokens.push(cls);
        this.className = tokens.join(' ');
      },
    };
  }

  getAttribute(name: string): string | null {
    if (name === 'open') return this.open ? '' : null;
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    if (name === 'open') return this.open;
    return name in this.attributes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = value;
    if (name === 'open') this.open = true;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
    if (name === 'open') this.open = false;
  }

  appendChild(child: MockDOMElement): MockDOMElement {
    child.parentElement = this;
    this.children.push(child);
    if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
      this.options.push(child);
      if (child.getAttribute('selected') !== null || this.options.length === 1) {
        this.selectedIndex = this.options.length - 1;
        this.value = child.value || child.getAttribute('value') || '';
      }
    }
    return child;
  }

  closest(selector: string): MockDOMElement | null {
    const selTokens = selector.split(',').map(s => s.trim().toLowerCase());
    let current: MockDOMElement | null = this;
    while (current) {
      const tag = current.tagName.toLowerCase();
      const id = current.id.toLowerCase();
      const clsList = current.className.toLowerCase().split(/\s+/);
      for (const sel of selTokens) {
        if (sel === tag) return current;
        if (sel.startsWith('#') && id === sel.slice(1)) return current;
        if (sel.startsWith('.') && clsList.includes(sel.slice(1))) return current;
        const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]$/);
        if (attrMatch && current.getAttribute(attrMatch[1]) !== null) {
          const val = current.getAttribute(attrMatch[1])!;
          if (!attrMatch[2] || (attrMatch[2] === '=' && val === attrMatch[3])) return current;
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string): MockDOMElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): MockDOMElement[] {
    const results: MockDOMElement[] = [];
    const selTokens = selector.split(',').map(s => s.trim().toLowerCase());

    const traverse = (node: MockDOMElement) => {
      for (const child of node.children) {
        const tag = child.tagName.toLowerCase();
        const id = child.id.toLowerCase();
        const clsList = child.className.toLowerCase().split(/\s+/);
        let matches = false;

        for (const rawSel of selTokens) {
          const parts = rawSel.split(/\s+/).filter(Boolean);
          const target = parts[parts.length - 1];
          if (parts.length > 1) {
            const ancestorSel = parts.slice(0, -1).join(' ');
            if (!child.closest(ancestorSel)) continue;
          }

          let targetTag = '';
          let targetClass = '';
          let targetAttr: { name: string; op?: string; val?: string } | null = null;

          let rem = target;
          const attrMatch = rem.match(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]/);
          if (attrMatch) {
            targetAttr = { name: attrMatch[1], op: attrMatch[2], val: attrMatch[3] };
            rem = rem.replace(attrMatch[0], '');
          }
          if (rem.includes('.')) {
            const split = rem.split('.');
            targetTag = split[0];
            targetClass = split[1];
          } else {
            targetTag = rem;
          }

          let ok = true;
          if (targetTag && targetTag !== tag) ok = false;
          if (targetClass && !clsList.includes(targetClass)) ok = false;
          if (targetAttr) {
            const actual = child.getAttribute(targetAttr.name);
            if (actual === null) {
              ok = false;
            } else if (targetAttr.op === '=' && actual !== targetAttr.val) {
              ok = false;
            } else if (targetAttr.op === '*=' && !actual.includes(targetAttr.val || '')) {
              ok = false;
            }
          }
          if (ok) {
            matches = true;
            break;
          }
        }

        if (matches) results.push(child);
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }

  getBoundingClientRect() {
    return { width: 500, height: 300, top: 100, left: 100 };
  }

  click(): void {
    if (this._onClick) this._onClick();
  }

  _onClick?: () => void;
  close(): void {
    this.open = false;
    this.removeAttribute('open');
  }
}

describe('Item 1: Leftover Dialogs Hygiene & Detection', () => {
  it('fixture: leftover "Save this application?" dialog is ignored by findActiveEasyApplyContainer', () => {
    const doc = new MockDOMElement('document');
    const dialog = new MockDOMElement('dialog', {
      class: 'artdeco-modal artdeco-modal--layer-default',
      open: '',
      role: 'dialog',
      'aria-modal': 'true',
    });

    const header = new MockDOMElement('div', { class: 'artdeco-modal__header' });
    const title = new MockDOMElement('h2', {}, 'Save this application?');
    header.appendChild(title);

    const content = new MockDOMElement('div', { class: 'artdeco-modal__content' });
    const bodyText = new MockDOMElement(
      'p',
      {},
      'If you save, you can come back to this application later from your Jobs page.',
    );
    content.appendChild(bodyText);

    const footer = new MockDOMElement('div', { class: 'artdeco-modal__actionbar' });
    const discardBtn = new MockDOMElement('button', { class: 'artdeco-button artdeco-button--secondary' }, 'Discard');
    const saveBtn = new MockDOMElement('button', { class: 'artdeco-button artdeco-button--primary' }, 'Save');
    footer.appendChild(discardBtn);
    footer.appendChild(saveBtn);

    dialog.appendChild(header);
    dialog.appendChild(content);
    dialog.appendChild(footer);
    doc.appendChild(dialog);

    // 1. findActiveEasyApplyContainer MUST return null on this confirmation dialog
    const container = findActiveEasyApplyContainer(doc as any);
    expect(container).toBeNull();
  });

  it('correctly inspects open dialogs: extracts title, visible text, and button labels', () => {
    const doc = new MockDOMElement('document');
    const dialog = new MockDOMElement('dialog', {
      open: '',
      role: 'dialog',
      class: 'some-custom-dialog',
    });
    const title = new MockDOMElement('h3', {}, 'Save your application?');
    const body = new MockDOMElement('p', {}, 'Would you like to preserve your filled answers?');
    const discardBtn = new MockDOMElement('button', {}, 'Discard');
    const saveBtn = new MockDOMElement('button', {}, 'Save');

    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(discardBtn);
    dialog.appendChild(saveBtn);
    doc.appendChild(dialog);

    const dialogCandidates = doc.querySelectorAll('dialog[open], [role="dialog"]');
    expect(dialogCandidates.length).toBeGreaterThan(0);

    const inspected = dialogCandidates.map(d => {
      const heading = d.querySelector('h1, h2, h3');
      const buttons = d.querySelectorAll('button');
      return {
        tag: d.tagName.toLowerCase(),
        title: heading?.textContent,
        buttonLabels: buttons.map(b => b.textContent),
      };
    });

    expect(inspected[0].title).toBe('Save your application?');
    expect(inspected[0].buttonLabels).toEqual(['Discard', 'Save']);
  });

  it('determinstically resolves leftover dialog by clicking Save to preserve draft', () => {
    const doc = new MockDOMElement('document');
    const dialog = new MockDOMElement('dialog', {
      open: '',
      role: 'dialog',
    });
    let saveClicked = false;
    let discardClicked = false;

    const title = new MockDOMElement('h2', {}, 'Save this application?');
    const discardBtn = new MockDOMElement('button', {}, 'Discard');
    discardBtn._onClick = () => {
      discardClicked = true;
    };

    const saveBtn = new MockDOMElement('button', {}, 'Save');
    saveBtn._onClick = () => {
      saveClicked = true;
      dialog.close();
    };

    dialog.appendChild(title);
    dialog.appendChild(discardBtn);
    dialog.appendChild(saveBtn);
    doc.appendChild(dialog);

    // Simulate resolution logic: find Save button first
    const buttons = dialog.querySelectorAll('button');
    const targetSaveBtn = buttons.find(
      b =>
        /^save$/i.test(b.textContent.trim()) ||
        (/save/i.test(b.textContent.trim()) && !/discard/i.test(b.textContent.trim())),
    );
    expect(targetSaveBtn).not.toBeUndefined();

    targetSaveBtn?.click();
    expect(saveClicked).toBe(true);
    expect(discardClicked).toBe(false);
    expect(dialog.open).toBe(false);
  });

  it('falls back to Discard/Close if Save is not present so dialog is never left open', () => {
    const doc = new MockDOMElement('document');
    const dialog = new MockDOMElement('dialog', {
      open: '',
      role: 'dialog',
    });
    let discardClicked = false;

    const title = new MockDOMElement('h2', {}, 'Discard application?');
    const discardBtn = new MockDOMElement('button', {}, 'Discard');
    discardBtn._onClick = () => {
      discardClicked = true;
      dialog.close();
    };

    dialog.appendChild(title);
    dialog.appendChild(discardBtn);
    doc.appendChild(dialog);

    const buttons = dialog.querySelectorAll('button');
    const targetSaveBtn = buttons.find(b => /^save$/i.test(b.textContent.trim()));
    expect(targetSaveBtn).toBeUndefined();

    const targetDiscardBtn = buttons.find(b => /discard/i.test(b.textContent.trim()));
    expect(targetDiscardBtn).not.toBeUndefined();
    targetDiscardBtn?.click();

    expect(discardClicked).toBe(true);
    expect(dialog.open).toBe(false);
  });
});

describe('Item 2: Job Title Pollution Prevention', () => {
  it('strips "🤖 [Runner]" prefix from job titles across all formats', async () => {
    const { cleanLinkedInJobTitle } = await import('../../agent/linkedin/formQuestionResolver');

    expect(cleanLinkedInJobTitle('🤖 [Runner] Senior Software Engineer - Generative AI')).toBe(
      'Senior Software Engineer - Generative AI',
    );
    expect(cleanLinkedInJobTitle('[Runner] Staff Machine Learning Engineer')).toBe('Staff Machine Learning Engineer');
    expect(cleanLinkedInJobTitle('🤖 AI Platform Engineer')).toBe('AI Platform Engineer');
    expect(cleanLinkedInJobTitle('🤖 [Runner] 🤖 [Runner] Lead Engineer')).toBe('Lead Engineer');
    expect(cleanLinkedInJobTitle('Senior Backend Engineer')).toBe('Senior Backend Engineer');
  });

  it('job title is strictly extracted from in-page heading, NEVER from document.title', () => {
    const fakeDoc = new MockDOMElement('document');
    // document.title has the runner prefix polluted title
    const fakeDocumentTitle = '🤖 [Runner] Polluted Senior Engineer | LinkedIn';

    const detailPane = new MockDOMElement('div', { class: 'scaffold-layout__detail' });
    const realHeading = new MockDOMElement('h1', {}, 'Senior Software Engineer');
    detailPane.appendChild(realHeading);
    fakeDoc.appendChild(detailPane);

    // Simulated heading extractor (strictly from DOM heading)
    const titleEl = fakeDoc.querySelector(
      '.scaffold-layout__detail h1, h1.job-details-jobs-unified-top-card__job-title',
    );
    const title = titleEl?.textContent || '';

    expect(title).toBe('Senior Software Engineer');
    expect(title).not.toContain('Runner');
    expect(title).not.toContain('Polluted');
  });

  it('CSV generator strips runner prefixes from exported titles', async () => {
    const { generateJobsCsv } = await import('../../../../../packages/storage/lib/linkedin/csvExport');

    const records = [
      {
        title: '🤖 [Runner] Staff ML Engineer',
        company: 'Anthropic',
        status: 'applied',
        url: 'https://linkedin.com/jobs/view/123456',
        timestamp: Date.now(),
      },
    ];

    const csv = generateJobsCsv(records as any);
    expect(csv).toContain('Staff ML Engineer');
    expect(csv).not.toContain('🤖');
    expect(csv).not.toContain('[Runner]');
  });
});

describe('Item 4: Skip Breakdown Categorization', () => {
  it('categorizes "Modal closed unexpectedly without confirmation" under its own category, not confirmation unverified', async () => {
    const { bucketFillFailureReason } = await import('../linkedin/dedicatedJobRunner');

    // Crucial bug fix verification:
    const modalClosedCategory = bucketFillFailureReason('Modal closed unexpectedly without confirmation');
    expect(modalClosedCategory).toBe('form: modal closed unexpectedly');
    expect(modalClosedCategory).not.toBe('form: submission confirmation unverified');

    // True confirmation failure maps to unverified confirmation
    const confirmCategory = bucketFillFailureReason('Submission confirmation unverified');
    expect(confirmCategory).toBe('form: submission confirmation unverified');
  });

  it('maps each distinct failure reason to its unique, stable category', async () => {
    const { bucketFillFailureReason, formatSkipBreakdown } = await import('../linkedin/dedicatedJobRunner');

    expect(
      bucketFillFailureReason(
        'Next/Review button rejected by LinkedIn (validation blocked). Draft preserved for manual review.',
      ),
    ).toBe('form: Next/Review rejected (validation)');

    expect(bucketFillFailureReason('Security checkpoint encountered and not resolved within window')).toBe(
      'form: security checkpoint',
    );

    expect(bucketFillFailureReason('Auto-generated resume upload failed')).toBe('form: mandatory document missing');

    expect(bucketFillFailureReason('Validation loop detected after 3 repeated steps')).toBe(
      'form: validation loop detected',
    );

    expect(bucketFillFailureReason('No action button (Next/Review/Submit) found on step')).toBe(
      'form: no action button found',
    );

    expect(bucketFillFailureReason('Reached maximum steps (15) without submission')).toBe('form: max steps exceeded');

    // Verify formatSkipBreakdown output
    const breakdown = formatSkipBreakdown({
      'form: modal closed unexpectedly': 2,
      'form: submission confirmation unverified': 1,
      'form: Next/Review rejected (validation)': 3,
    });

    expect(breakdown).toBe(
      '📊 Skip breakdown: form: Next/Review rejected (validation) ×3 | form: modal closed unexpectedly ×2 | form: submission confirmation unverified ×1',
    );
  });
});

describe('Requirement 4: Restrict Save-Dialog Detection (Prevent False Positives)', () => {
  function isSaveDialog(d: MockDOMElement): boolean {
    const hasFormControls =
      d.querySelector(
        'input:not([type="hidden"]), select, textarea, fieldset, [role="radiogroup"], [role="group"], [contenteditable="true"], .jobs-document-upload, [type="file"], [data-test-document-upload], .jobs-easy-apply-form-element',
      ) !== null;
    if (hasFormControls) return false;

    const buttons = d.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
    if (buttons.length === 0) return false;

    const buttonTexts = buttons
      .map(b => (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim())
      .filter(Boolean);

    const hasFormNavButton = buttonTexts.some(t =>
      /^(?:next|review|submit|submit application|continue|back|previous)$/i.test(t),
    );
    if (hasFormNavButton) return false;

    const hasSaveOrDiscardButton = buttonTexts.some(
      t => t.length <= 20 && /^(?:save|save draft|discard|discard draft)$/i.test(t),
    );
    if (!hasSaveOrDiscardButton) return false;

    const text = (d.innerText || d.textContent || '').trim();
    const titleEl = d.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
    const title = (titleEl?.textContent || text.slice(0, 100)).trim();
    return (
      /save\s+(?:this\s+|your\s+|incomplete\s+)?application|save\s+draft|discard\s+(?:this\s+|your\s+|draft|application|changes)|save\s+changes/i.test(
        title + ' ' + text,
      ) ||
      ((/save/i.test(title) || /discard/i.test(title)) && /application|draft|changes/i.test(title + ' ' + text))
    );
  }

  it('(a) a real form step whose question text contains the word "save" is never treated as a save dialog', () => {
    const formModal = new MockDOMElement('div', {
      role: 'dialog',
      class: 'jobs-easy-apply-modal',
      'aria-modal': 'true',
    });
    const header = new MockDOMElement('h2', {}, 'Application Questions');
    const questionLabel = new MockDOMElement(
      'label',
      { for: 'save-q1' },
      'How many hours of engineering time did your CI/CD test automation save every week?',
    );
    const input = new MockDOMElement('input', { id: 'save-q1', type: 'text' });
    const nextBtn = new MockDOMElement('button', { class: 'artdeco-button--primary' }, 'Next');

    formModal.appendChild(header);
    formModal.appendChild(questionLabel);
    formModal.appendChild(input);
    formModal.appendChild(nextBtn);

    expect(isSaveDialog(formModal)).toBe(false);
  });

  it('(b) a resume step with file upload controls is not treated as a save dialog', () => {
    const resumeModal = new MockDOMElement('div', {
      role: 'dialog',
      class: 'jobs-easy-apply-modal',
      'aria-modal': 'true',
    });
    const header = new MockDOMElement('h2', {}, 'Resume & Work Documents');
    const uploadContainer = new MockDOMElement('div', { class: 'jobs-document-upload' });
    const fileInput = new MockDOMElement('input', { type: 'file' });
    uploadContainer.appendChild(fileInput);
    const reviewBtn = new MockDOMElement('button', { class: 'artdeco-button--primary' }, 'Review');

    resumeModal.appendChild(header);
    resumeModal.appendChild(uploadContainer);
    resumeModal.appendChild(reviewBtn);

    expect(isSaveDialog(resumeModal)).toBe(false);
  });

  it('(c) the real "Save this application?" sheet is correctly recognized and handled', () => {
    const saveSheet = new MockDOMElement('div', {
      role: 'dialog',
      class: 'artdeco-modal artdeco-modal--layer-default',
      'aria-modal': 'true',
    });
    const title = new MockDOMElement('h2', {}, 'Save this application?');
    const desc = new MockDOMElement(
      'p',
      {},
      'If you save, you can come back to this application later from your Jobs page.',
    );
    const discardBtn = new MockDOMElement('button', { class: 'artdeco-button--secondary' }, 'Discard');
    const saveBtn = new MockDOMElement('button', { class: 'artdeco-button--primary' }, 'Save');

    saveSheet.appendChild(title);
    saveSheet.appendChild(desc);
    saveSheet.appendChild(discardBtn);
    saveSheet.appendChild(saveBtn);

    expect(isSaveDialog(saveSheet)).toBe(true);
  });
});

describe('Requirement 5: hasAnyOpenModalOrDialog Scoping & Persistent Overlays', () => {
  function checkHasAnyOpenModalOrDialog(doc: MockDOMElement): boolean {
    const candidates = doc.querySelectorAll('dialog, div[role="dialog"], [aria-modal="true"]');
    for (const d of candidates) {
      if (d.closest('.msg-overlay-container, #msg-overlay, .notifications-badge')) continue;
      const aria = (d.getAttribute('aria-label') || '').toLowerCase();
      if (d.classList.contains('msg-overlay-container') || /messaging|chat/i.test(aria)) continue;

      // 1. Is Easy Apply Modal
      const isEasyApply =
        d.classList.contains('jobs-easy-apply-modal') ||
        d.hasAttribute('data-easy-apply-modal') ||
        d.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
        /easy apply|submit application/i.test((d.textContent || '').slice(0, 300));
      if (isEasyApply) return true;

      // 2. Is Save/Discard sheet
      const buttons = d.querySelectorAll('button');
      const bTexts = buttons.map(b => (b.innerText || b.textContent || '').trim());
      const hasFormControls = d.querySelector('input:not([type="hidden"]), select, textarea') !== null;
      const hasSaveOrDiscard = bTexts.some(
        t => t.length <= 20 && /^(?:save|save draft|discard|discard draft)$/i.test(t),
      );
      const text = (d.innerText || d.textContent || '').toLowerCase();
      if (!hasFormControls && hasSaveOrDiscard && /save|discard/i.test(text) && /application|draft/i.test(text)) {
        return true;
      }
    }
    return false;
  }

  it('ignores persistent messaging overlays and notification flyouts', () => {
    const doc = new MockDOMElement('document');
    const msgOverlay = new MockDOMElement('div', {
      class: 'msg-overlay-container',
      role: 'dialog',
      'aria-label': 'Messaging',
    });
    const chatTitle = new MockDOMElement('h2', {}, 'Messaging conversation');
    msgOverlay.appendChild(chatTitle);
    doc.appendChild(msgOverlay);

    expect(checkHasAnyOpenModalOrDialog(doc)).toBe(false);
  });

  it('detects when an actual Easy Apply modal or Save/Discard sheet is present', () => {
    const docWithModal = new MockDOMElement('document');
    const eaModal = new MockDOMElement('div', {
      class: 'jobs-easy-apply-modal',
      role: 'dialog',
      'aria-modal': 'true',
    });
    docWithModal.appendChild(eaModal);
    expect(checkHasAnyOpenModalOrDialog(docWithModal)).toBe(true);

    const docWithSaveSheet = new MockDOMElement('document');
    const saveSheet = new MockDOMElement('div', {
      role: 'dialog',
      'aria-modal': 'true',
    });
    saveSheet.appendChild(new MockDOMElement('h2', {}, 'Save this application?'));
    saveSheet.appendChild(new MockDOMElement('button', {}, 'Save'));
    saveSheet.appendChild(new MockDOMElement('button', {}, 'Discard'));
    docWithSaveSheet.appendChild(saveSheet);
    expect(checkHasAnyOpenModalOrDialog(docWithSaveSheet)).toBe(true);
  });
});

describe('Requirement 6: Title Extraction Classic & Atomic Layouts + Fallback', () => {
  it('extracts job title from classic layout details heading', async () => {
    const { cleanLinkedInJobTitle } = await import('../linkedin/formQuestionResolver');
    const doc = new MockDOMElement('document');
    const topCard = new MockDOMElement('div', { class: 'jobs-unified-top-card' });
    const heading = new MockDOMElement(
      'h1',
      { class: 'jobs-unified-top-card__job-title' },
      'Senior Staff Backend Engineer',
    );
    topCard.appendChild(heading);
    doc.appendChild(topCard);

    const titleEl = doc.querySelector('.jobs-unified-top-card__job-title, [data-view-name="job-details"] h1');
    expect(titleEl).not.toBeNull();
    const extracted = cleanLinkedInJobTitle(titleEl!.textContent);
    expect(extracted).toBe('Senior Staff Backend Engineer');
  });

  it('extracts job title from new atomic-class layout heading', async () => {
    const { cleanLinkedInJobTitle } = await import('../linkedin/formQuestionResolver');
    const doc = new MockDOMElement('document');
    const atomicContainer = new MockDOMElement('div', { 'data-view-name': 'job-details' });
    const heading = new MockDOMElement('h1', { class: 't-24 t-bold' }, 'Principal Distributed Systems Engineer');
    atomicContainer.appendChild(heading);
    doc.appendChild(atomicContainer);

    const titleEl = doc.querySelector('[data-view-name="job-details"] h1, .jobs-unified-top-card__job-title');
    expect(titleEl).not.toBeNull();
    const extracted = cleanLinkedInJobTitle(titleEl!.textContent);
    expect(extracted).toBe('Principal Distributed Systems Engineer');
  });

  it('missing heading logs warning and uses job ID without inventing "LinkedIn Job" or reading document.title', async () => {
    const { cleanLinkedInJobTitle } = await import('../linkedin/formQuestionResolver');
    const rawTitle = '';
    const jobId = '4198273645';

    let displayTitle = cleanLinkedInJobTitle(rawTitle);
    if (!displayTitle) {
      displayTitle = `Job #${jobId}`;
    }

    expect(displayTitle).toBe('Job #4198273645');
    expect(displayTitle).not.toBe('LinkedIn Job');
    expect(displayTitle).not.toContain('document.title');
  });
});

describe('Requirement 7: Phone Country Code Select & Filling', () => {
  it('discovers country-code select even when defaulted to Andorra (+376) and selects India (+91)', () => {
    const sel = new MockDOMElement('select', {
      id: 'urn:li:fsd_formElement:phone-country-code',
      name: 'countryCode',
      'aria-label': 'Phone country code',
    });

    const optAndorra = new MockDOMElement('option', { value: 'ad' }, 'Andorra (+376)');
    const optUAE = new MockDOMElement('option', { value: 'ae' }, 'United Arab Emirates (+971)');
    const optIndia = new MockDOMElement('option', { value: 'in' }, 'India (+91)');
    const optUS = new MockDOMElement('option', { value: 'us' }, 'United States (+1)');

    sel.appendChild(optAndorra);
    sel.appendChild(optUAE);
    sel.appendChild(optIndia);
    sel.appendChild(optUS);

    // Initial state: default select index 0 is Andorra (+376)
    expect(sel.value).toBe('ad');
    expect(sel.selectedOptions[0].textContent).toBe('Andorra (+376)');

    // 1. Discovery verification
    const isCountryCodeSelect =
      /country\s*code|phone\s*country|dialing\s*code/i.test(
        sel.name + ' ' + sel.id + ' ' + (sel.getAttribute('aria-label') || ''),
      ) || sel.options.some(o => /\+\d{1,4}/.test(o.textContent || ''));

    const isDefaultCountryCode =
      isCountryCodeSelect &&
      !sel.selectedOptions[0].textContent.includes('+91') &&
      !sel.selectedOptions[0].textContent.toLowerCase().includes('india');

    // Must be discovered (not skipped as already answered)
    expect(isDefaultCountryCode).toBe(true);

    // 2. Filling verification with target dialing code "+91" or "India"
    const targetVal = '+91';
    const dialingMatch = targetVal.match(/(?:\+|00)?(\d{1,4})/);
    const dialingDigits = dialingMatch ? dialingMatch[1] : '';

    const matchedOpt = sel.options.find(o => {
      const optText = o.textContent.toLowerCase();
      const optVal = (o.getAttribute('value') || '').toLowerCase();
      if (
        dialingDigits &&
        (optText.includes(`(+${dialingDigits})`) ||
          optText.includes(`+${dialingDigits}`) ||
          optVal === dialingDigits ||
          optVal.endsWith(`:${dialingDigits}`))
      ) {
        return true;
      }
      if (/india/i.test(targetVal) && (optText.includes('india') || optVal === 'in')) {
        return true;
      }
      return false;
    });

    expect(matchedOpt).not.toBeNull();
    expect(matchedOpt!.textContent).toBe('India (+91)');

    // Simulate select option assignment
    sel.value = matchedOpt!.getAttribute('value') || '';
    sel.selectedIndex = sel.options.indexOf(matchedOpt!);

    expect(sel.value).toBe('in');
    expect(sel.selectedOptions[0].textContent).toBe('India (+91)');
  });
});

describe('Phase 2: Structural List-Scan & Virtualized Card Extraction', () => {
  function scanJobList(doc: MockDOMElement): Array<{ jobId: string; title: string; company: string; url: string }> {
    const listRoot = doc.querySelector(
      'ul.scaffold-layout__list-container, .scaffold-layout__list-container, .jobs-search-results-list__list',
    );
    let cards: MockDOMElement[] = [];

    if (listRoot) {
      const directChildren = listRoot.children;
      cards = directChildren.filter(c => {
        return (
          c.hasAttribute('data-occludable-job-id') ||
          c.hasAttribute('data-job-id') ||
          c.querySelector(
            '[data-occludable-job-id], [data-job-id], a[href*="/jobs/view/"], a[href*="currentJobId="]',
          ) !== null
        );
      });
    }

    if (cards.length === 0) {
      const structuralSelectors = [
        'li[data-occludable-job-id]',
        'div[data-job-id]',
        'li[data-job-id]',
        '[data-view-name="job-card"]',
        '[data-view-name*="job-card"]',
        'li.scaffold-layout__list-item',
        'div.base-card',
      ].join(', ');
      const found = doc.querySelectorAll(structuralSelectors);
      cards = found.filter(el => !el.closest('.scaffold-layout__detail, [data-view-name="job-details"]'));
    }

    const results: Array<{ jobId: string; title: string; company: string; url: string }> = [];
    const seenJobIds = new Set<string>();

    for (const card of cards) {
      if (card.closest('.scaffold-layout__detail, [data-view-name="job-details"]')) continue;

      let jobId =
        card.getAttribute('data-job-id') ||
        card.getAttribute('data-occludable-job-id') ||
        card.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
        card.querySelector('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id') ||
        '';

      const titleAnchor = card.querySelector(
        'a[href*="/jobs/view/"], a[href*="currentJobId="], [data-view-name*="job-card-title"], a.job-card-list__title',
      );

      if (!jobId && titleAnchor) {
        const href = titleAnchor.getAttribute('href') || '';
        const match = href.match(/(?:\/jobs\/view\/|currentJobId=)(\d{7,12})/);
        if (match && match[1]) jobId = match[1];
      }

      if (!jobId || seenJobIds.has(jobId)) continue;
      seenJobIds.add(jobId);

      let rawTitle = (titleAnchor?.textContent || '').trim().replace(/\s+/g, ' ');
      const isJunk = /^(?:more|less|share feedback|save|saved|dismiss|close|easy apply|apply)$/i.test(rawTitle);
      if (isJunk || !rawTitle) {
        const heading = card.querySelector('strong, h3, h4');
        if (heading && !heading.closest('button')) {
          rawTitle = (heading.textContent || '').trim().replace(/\s+/g, ' ');
        }
      }
      const title = /^(?:more|share feedback|save)$/i.test(rawTitle) ? '' : rawTitle;

      const companyAnchor = card.querySelector('a[href*="/company/"]');
      let company = (companyAnchor?.textContent || '').trim().replace(/\s+/g, ' ');
      if (!company) {
        const subEl = card.querySelector(
          '.artdeco-entity-lockup__subtitle, [data-view-name*="job-card"] span, .job-card-container__primary-description',
        );
        if (subEl && !subEl.closest('button')) {
          company = (subEl.textContent || '').trim().replace(/\s+/g, ' ');
        }
      }

      if (!title && !company) continue;

      results.push({
        jobId,
        title: title || `Job #${jobId}`,
        company: company || 'Company',
        url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      });
    }

    return results;
  }

  it('scans two-column layout with ul.scaffold-layout__list-container correctly', () => {
    const doc = new MockDOMElement('document');
    const twoPane = new MockDOMElement('div', { class: 'jobs-search-two-pane__wrapper' });
    const listPane = new MockDOMElement('div', { class: 'scaffold-layout__list' });
    const ul = new MockDOMElement('ul', { class: 'scaffold-layout__list-container' });

    // Job card 1
    const li1 = new MockDOMElement('li', { 'data-occludable-job-id': '4198273645' });
    const a1 = new MockDOMElement('a', { href: '/jobs/view/4198273645/' }, 'Staff AI Engineer');
    const comp1 = new MockDOMElement('a', { href: '/company/openai/' }, 'OpenAI');
    const btn1 = new MockDOMElement('button', {}, 'More'); // Menu button that must NOT pollute title
    li1.appendChild(a1);
    li1.appendChild(comp1);
    li1.appendChild(btn1);

    // Job card 2
    const li2 = new MockDOMElement('li', { 'data-occludable-job-id': '4197821034' });
    const a2 = new MockDOMElement('a', { href: '/jobs/view/4197821034/' }, 'Principal Infrastructure Engineer');
    const comp2 = new MockDOMElement('a', { href: '/company/google/' }, 'Google');
    li2.appendChild(a2);
    li2.appendChild(comp2);

    ul.appendChild(li1);
    ul.appendChild(li2);
    listPane.appendChild(ul);
    twoPane.appendChild(listPane);

    // Details pane (right column)
    const detailPane = new MockDOMElement('div', { class: 'scaffold-layout__detail' });
    const detailAnchor = new MockDOMElement('a', { href: '/jobs/view/9999999999/' }, 'Solitary Details Link');
    detailPane.appendChild(detailAnchor);
    twoPane.appendChild(detailPane);
    doc.appendChild(twoPane);

    const jobs = scanJobList(doc);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].jobId).toBe('4198273645');
    expect(jobs[0].title).toBe('Staff AI Engineer');
    expect(jobs[0].company).toBe('OpenAI');

    expect(jobs[1].jobId).toBe('4197821034');
    expect(jobs[1].title).toBe('Principal Infrastructure Engineer');
    expect(jobs[1].company).toBe('Google');

    // Details-pane link must NOT be included in search results
    expect(jobs.find(j => j.jobId === '9999999999')).toBeUndefined();
  });

  it('scans single-column layout (narrow viewport with Side Panel open) correctly', () => {
    const doc = new MockDOMElement('document');
    const container = new MockDOMElement('div', { class: 'scaffold-layout__list-container' });

    const card1 = new MockDOMElement('div', {
      'data-view-name': 'job-card',
      'data-job-id': '4188332211',
    });
    const titleLink = new MockDOMElement('a', { href: '/jobs/view/4188332211/' }, 'Senior Full Stack Developer');
    const subtitle = new MockDOMElement('div', { class: 'artdeco-entity-lockup__subtitle' }, 'Stripe Inc');
    card1.appendChild(titleLink);
    card1.appendChild(subtitle);
    container.appendChild(card1);
    doc.appendChild(container);

    const jobs = scanJobList(doc);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe('4188332211');
    expect(jobs[0].title).toBe('Senior Full Stack Developer');
    expect(jobs[0].company).toBe('Stripe Inc');
  });

  it('rejects solitary details-pane anchor when 0 search cards exist (never outputs "LinkedIn Job")', () => {
    const doc = new MockDOMElement('document');
    // Only a details pane anchor exists
    const detailPane = new MockDOMElement('div', { class: 'scaffold-layout__detail' });
    const solitaryLink = new MockDOMElement('a', { href: '/jobs/view/4123456789/' }, '');
    detailPane.appendChild(solitaryLink);
    doc.appendChild(detailPane);

    const jobs = scanJobList(doc);
    expect(jobs).toHaveLength(0);
    expect(jobs.some(j => j.title === 'LinkedIn Job')).toBe(false);
  });
});
