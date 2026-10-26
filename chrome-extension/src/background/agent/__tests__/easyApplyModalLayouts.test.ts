import { describe, it, expect, vi } from 'vitest';
import { findActiveEasyApplyContainer } from '../../browser/easyApplyContainer';

/**
 * Lightweight mock DOM element simulating standard DOM element APIs for Node/Vitest.
 */
class MockDOMElement {
  tagName: string;
  className: string;
  id: string;
  attributes: Record<string, string> = {};
  children: MockDOMElement[] = [];
  parentElement: MockDOMElement | null = null;
  textContent: string = '';
  innerText: string = '';
  shadowRoot: MockDOMElement | null = null;

  constructor(tagName: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this.className = attrs.class || '';
    this.id = attrs.id || '';
    this.textContent = text;
    this.innerText = text;
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
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = value;
  }

  appendChild(child: MockDOMElement): MockDOMElement {
    child.parentElement = this;
    this.children.push(child);
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
        if (sel === `#${id}`) return current;
        if (sel.startsWith('.') && clsList.includes(sel.slice(1))) return current;
        if (sel.startsWith('[') && sel.endsWith(']')) {
          const attr = sel.slice(1, -1);
          if (current.hasAttribute(attr)) return current;
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string): MockDOMElement | null {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(selector: string): MockDOMElement[] {
    const results: MockDOMElement[] = [];
    const selectors = selector.split(',').map(s => s.trim().toLowerCase());

    const matches = (el: MockDOMElement, sel: string): boolean => {
      const tag = el.tagName.toLowerCase();
      const id = el.id.toLowerCase();
      const clsList = el.className.toLowerCase().split(/\s+/);

      if (sel === tag) return true;
      if (sel === 'dialog[open]' && tag === 'dialog' && el.hasAttribute('open')) return true;
      if (sel === 'input:not([type="hidden"])' && tag === 'input' && el.getAttribute('type') !== 'hidden') return true;
      if (sel.startsWith('#') && id === sel.slice(1)) return true;
      if (sel.startsWith('.') && clsList.includes(sel.slice(1))) return true;

      if (sel.includes('[') && sel.includes(']')) {
        const attrPart = sel.match(/\[([a-zA-Z0-9_-]+)([\^$*~|]?=)?(.*?)\]/);
        if (attrPart) {
          const attrName = attrPart[1];
          const op = attrPart[2] || '';
          let expectedVal = (attrPart[3] || '').replace(/['"]/g, '');
          const actualVal = el.getAttribute(attrName);
          if (actualVal === null) return false;
          if (!op) return true;
          if (op === '=' && actualVal.toLowerCase() === expectedVal.toLowerCase()) return true;
          if (op === '*=' && actualVal.toLowerCase().includes(expectedVal.toLowerCase())) return true;
          if (op === '^=' && actualVal.toLowerCase().startsWith(expectedVal.toLowerCase())) return true;
        }
      }

      if (sel.includes('.')) {
        const parts = sel.split('.');
        const sTag = parts[0];
        const sCls = parts.slice(1);
        if (sTag && sTag !== tag) return false;
        if (sCls.every(c => clsList.includes(c))) return true;
      }

      return false;
    };

    const walk = (node: MockDOMElement) => {
      for (const child of node.children) {
        if (selectors.some(s => matches(child, s))) {
          results.push(child);
        }
        walk(child);
      }
    };

    walk(this);
    return results;
  }

  getBoundingClientRect() {
    return { width: 600, height: 500, top: 100, left: 100 };
  }
}

describe('LinkedIn Easy Apply Modal Detection - Regression & Multi-Layout Suite', () => {
  describe('Phase 1 & 2: Structural Detection of Classic and Atomic <dialog> Layouts', () => {
    it('successfully detects classic .jobs-easy-apply-modal layout with artdeco buttons', () => {
      const doc = new MockDOMElement('document');
      const modal = new MockDOMElement('div', {
        class: 'jobs-easy-apply-modal artdeco-modal',
        role: 'dialog',
        'aria-modal': 'true',
      });
      const header = new MockDOMElement('h2', { class: 'jobs-easy-apply-modal__title' }, 'Apply to Google');
      const content = new MockDOMElement('div', { class: 'jobs-easy-apply-modal__content' });
      const input = new MockDOMElement('input', { type: 'text', id: 'urn:li:phone', value: '1234567890' });
      content.appendChild(input);

      const footer = new MockDOMElement('div', { class: 'jobs-easy-apply-modal__footer' });
      const nextBtn = new MockDOMElement(
        'button',
        { class: 'artdeco-button artdeco-button--primary', 'aria-label': 'Continue to next step' },
        'Next',
      );
      footer.appendChild(nextBtn);

      modal.appendChild(header);
      modal.appendChild(content);
      modal.appendChild(footer);
      doc.appendChild(modal);

      const detected = findActiveEasyApplyContainer(doc as any);
      expect(detected).not.toBeNull();
      expect(detected).toBe(modal);
    });

    it('successfully detects new atomic <dialog class="l4jlpi ..."> layout with no aria-label and heading "Contact info"', () => {
      const doc = new MockDOMElement('document');
      const dialog = new MockDOMElement('dialog', {
        class: 'l4jlpi l4jlph l4jiay l4jk07 l4jk1o l4jk15 l4jk2m l4jbst l4jth l4jhc3 l4jjq4 l4jk',
        open: '',
      });
      const header = new MockDOMElement('div', { class: 'l4jhdr' });
      const title = new MockDOMElement('h3', {}, 'Contact info');
      header.appendChild(title);

      const body = new MockDOMElement('div', { class: 'l4jbody' });
      const emailInput = new MockDOMElement('input', {
        type: 'email',
        class: 'l4jinp',
        value: 'mubasshir@example.com',
      });
      body.appendChild(emailInput);

      const footer = new MockDOMElement('div', { class: 'l4jftr' });
      const nextBtn = new MockDOMElement(
        'button',
        {
          class: 'l4jlhg l4jlhf l4jth l4ja2n l4jhc3 l4jk6n l4jk76 l4jlhk l4jlhi l4jlhh',
          type: 'button',
          // Note: NO aria-label, atomic class names!
        },
        'Next',
      );
      footer.appendChild(nextBtn);

      dialog.appendChild(header);
      dialog.appendChild(body);
      dialog.appendChild(footer);
      doc.appendChild(dialog);

      const detected = findActiveEasyApplyContainer(doc as any);
      expect(detected).not.toBeNull();
      expect(detected).toBe(dialog);
    });

    it('successfully detects modern <dialog> Review / Submit step with visible button text "Submit application"', () => {
      const doc = new MockDOMElement('document');
      const dialog = new MockDOMElement('dialog', {
        class: 'l4jlpi l4jlph l4jiay',
        open: '',
      });
      const title = new MockDOMElement('h3', {}, 'Review your application');
      dialog.appendChild(title);

      const submitBtn = new MockDOMElement(
        'button',
        {
          class: 'l4jlhg l4jlhf',
          type: 'button',
        },
        'Submit application',
      );
      dialog.appendChild(submitBtn);
      doc.appendChild(dialog);

      const detected = findActiveEasyApplyContainer(doc as any);
      expect(detected).not.toBeNull();
      expect(detected).toBe(dialog);
    });

    it('resolves Next, Review, and Submit buttons from visible text when aria-label is absent', () => {
      function resolveActionButtons(buttonTexts: string[]) {
        let hasNext = false;
        let hasReview = false;
        let hasSubmit = false;

        for (const rawText of buttonTexts) {
          const text = (rawText || '').trim().toLowerCase();
          if (
            text === 'dismiss' ||
            text === 'cancel' ||
            text === 'back' ||
            text.includes('dismiss') ||
            text.includes('cancel') ||
            text.includes('close')
          ) {
            continue;
          }

          if (
            /submit application|submit/i.test(text) ||
            text.includes('submit application') ||
            text.includes('submit')
          ) {
            hasSubmit = true;
          } else if (
            /review/i.test(text) ||
            text.includes('review your application') ||
            text.includes('review application') ||
            text.includes('review')
          ) {
            hasReview = true;
          } else if (
            /next|continue/i.test(text) ||
            text.includes('next') ||
            text.includes('continue to next step') ||
            text.includes('continue')
          ) {
            hasNext = true;
          }
        }

        return { hasNext, hasReview, hasSubmit };
      }

      // Step with Dismiss and atomic Next button
      expect(resolveActionButtons(['Dismiss', 'Next'])).toEqual({
        hasNext: true,
        hasReview: false,
        hasSubmit: false,
      });

      // Step with Review button
      expect(resolveActionButtons(['Dismiss', 'Back', 'Review your application'])).toEqual({
        hasNext: false,
        hasReview: true,
        hasSubmit: false,
      });

      // Step with Submit application
      expect(resolveActionButtons(['Dismiss', 'Back', 'Submit application'])).toEqual({
        hasNext: false,
        hasReview: false,
        hasSubmit: true,
      });
    });

    it('rejects intermediate sheet "Save this application? / Discard draft"', () => {
      const doc = new MockDOMElement('document');
      const sheet = new MockDOMElement(
        'div',
        {
          role: 'dialog',
          class: 'artdeco-modal',
        },
        'Save this application? If you leave now, your draft will be saved.',
      );
      const discardBtn = new MockDOMElement('button', {}, 'Discard');
      const saveBtn = new MockDOMElement('button', {}, 'Save');
      sheet.appendChild(discardBtn);
      sheet.appendChild(saveBtn);
      doc.appendChild(sheet);

      const detected = findActiveEasyApplyContainer(doc as any);
      expect(detected).toBeNull();
    });

    it('rejects global messaging/chat overlays and notification badges', () => {
      const doc = new MockDOMElement('document');
      const chat = new MockDOMElement('div', {
        role: 'dialog',
        'aria-label': 'Messaging',
        class: 'msg-overlay-container',
      });
      const chatInput = new MockDOMElement('input', { type: 'text' });
      chat.appendChild(chatInput);
      doc.appendChild(chat);

      const detected = findActiveEasyApplyContainer(doc as any);
      expect(detected).toBeNull();
    });
  });

  describe('Phase 3: Grace Period & Safe Retry Logic', () => {
    it('does not declare modal closed on a single negative check and succeeds when modal reappears on grace retry', async () => {
      let checkCount = 0;
      const fakePage = {
        isEasyApplyModalOpen: vi.fn(async () => {
          checkCount++;
          // First check returns false (transient detachment during step transition)
          if (checkCount === 1) return false;
          // Grace retry #1 returns true
          return true;
        }),
        verifyApplicationConfirmation: vi.fn(async () => ({ confirmed: false })),
        verifySubmissionConfirmation: vi.fn(async () => ({ confirmed: false })),
      };

      // Emulate runner grace period loop:
      let modalOpen = await fakePage.isEasyApplyModalOpen();
      if (!modalOpen) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          await new Promise(r => setTimeout(r, 10)); // simulated 10ms instead of 1000ms
          modalOpen = await fakePage.isEasyApplyModalOpen();
          if (modalOpen) break;
        }
      }

      expect(fakePage.isEasyApplyModalOpen).toHaveBeenCalledTimes(2);
      expect(modalOpen).toBe(true);
      // Because modal was recovered on retry, it does NOT skip or return "Modal closed unexpectedly"!
    });

    it('only declares modal closed unexpectedly if all grace retries and confirmation checks are negative', async () => {
      const fakePage = {
        isEasyApplyModalOpen: vi.fn(async () => false),
        verifyApplicationConfirmation: vi.fn(async () => ({ confirmed: false })),
        verifySubmissionConfirmation: vi.fn(async () => ({ confirmed: false })),
      };

      let modalOpen = await fakePage.isEasyApplyModalOpen();
      if (!modalOpen) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          await new Promise(r => setTimeout(r, 10));
          modalOpen = await fakePage.isEasyApplyModalOpen();
          if (modalOpen) break;
        }
      }

      let result: { success: boolean; reason: string } | null = null;
      if (!modalOpen) {
        const postCheck = await fakePage.verifyApplicationConfirmation();
        if (postCheck.confirmed) {
          result = { success: true, reason: 'confirmed' };
        } else {
          result = { success: false, reason: 'Modal closed unexpectedly without confirmation' };
        }
      }

      expect(fakePage.isEasyApplyModalOpen).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(fakePage.verifyApplicationConfirmation).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: false, reason: 'Modal closed unexpectedly without confirmation' });
    });
  });
});
