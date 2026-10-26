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
  textContent: string = '';
  innerText: string = '';
  open: boolean = false;

  constructor(tagName: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this.className = attrs.class || '';
    this.id = attrs.id || '';
    this.textContent = text;
    this.innerText = text;
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

        for (const sel of selTokens) {
          if (sel === tag) {
            matches = true;
            break;
          }
          if (sel.startsWith('#') && id === sel.slice(1)) {
            matches = true;
            break;
          }
          if (sel.startsWith('.') && clsList.includes(sel.slice(1))) {
            matches = true;
            break;
          }
          if (sel === 'dialog[open]' && tag === 'dialog' && child.open) {
            matches = true;
            break;
          }
          if (sel.includes('[role="dialog"]') && child.getAttribute('role') === 'dialog') {
            matches = true;
            break;
          }
          if (sel.includes('[aria-modal="true"]') && child.getAttribute('aria-modal') === 'true') {
            matches = true;
            break;
          }
          if (
            sel.includes('aria-label*="dismiss"') &&
            (child.getAttribute('aria-label') || '').toLowerCase().includes('dismiss')
          ) {
            matches = true;
            break;
          }
          if (
            sel.includes('aria-label*="close"') &&
            (child.getAttribute('aria-label') || '').toLowerCase().includes('close')
          ) {
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
