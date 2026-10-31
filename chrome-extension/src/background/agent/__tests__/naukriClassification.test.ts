// chrome-extension/src/background/agent/__tests__/naukriClassification.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspectNaukriJobPage } from '../platforms/naukri/classification';
import { naukriAdapter } from '../platforms/naukri/naukriAdapter';

// Synthetic DOM node mock for headless unit testing
class MockElement {
  tagName: string;
  attributes: Record<string, string> = {};
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  textContent: string = '';
  innerText: string = '';
  offsetParent: any = {};

  constructor(tagName: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this.textContent = text;
    this.innerText = text;
  }

  get id(): string {
    return this.attributes.id || '';
  }

  get className(): string {
    return this.attributes.class || '';
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  querySelector(selector: string): MockElement | null {
    const list = this.querySelectorAll(selector);
    return list.length > 0 ? list[0] : null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const selectors = selector.split(',').map(s => s.trim().toLowerCase());

    const matches = (el: MockElement, sel: string): boolean => {
      const tag = el.tagName.toLowerCase();
      const id = el.id.toLowerCase();
      const clsList = el.className.toLowerCase().split(/\s+/).filter(Boolean);

      if (sel === tag) return true;
      if (sel.startsWith('#') && id === sel.slice(1)) return true;
      if (sel.startsWith('.') && clsList.includes(sel.slice(1))) return true;

      if (sel.includes('[') && sel.includes(']')) {
        const tagPart = sel.split('[')[0];
        if (tagPart && tagPart !== tag) return false;

        const attrMatch = sel.match(/\[([a-zA-Z0-9_-]+)([\^$*~|]?=)?(.*?)\]/);
        if (attrMatch) {
          const attr = attrMatch[1];
          const op = attrMatch[2] || '';
          const expected = (attrMatch[3] || '').replace(/['"]/g, '').toLowerCase();
          const actual = (el.getAttribute(attr) || '').toLowerCase();
          if (!op) return el.getAttribute(attr) !== null;
          if (op === '=' && actual === expected) return true;
          if (op === '*=' && actual.includes(expected)) return true;
          if (op === '^=' && actual.startsWith(expected)) return true;
        }
      }

      if (sel.includes('.')) {
        const parts = sel.split('.');
        const sTag = parts[0];
        const sCls = parts[1];
        if (sTag && sTag !== tag) return false;
        if (sCls && !clsList.includes(sCls)) return false;
        return true;
      }

      return false;
    };

    const walk = (node: MockElement) => {
      for (const child of node.children) {
        for (const sel of selectors) {
          if (matches(child, sel)) {
            if (!results.includes(child)) results.push(child);
            break;
          }
        }
        walk(child);
      }
    };

    walk(this);
    return results;
  }
}

class MockDocument extends MockElement {
  readyState: string = 'complete';

  constructor() {
    super('document');
  }
}

describe('Naukri Job Page Classification (inspectNaukriJobPage)', () => {
  it('Case 1: Direct Apply button is classified as "direct_apply"', () => {
    const doc = new MockDocument();
    const container = new MockElement('div', { class: 'styles_apply-button-container' });
    const btn = new MockElement('button', { id: 'apply-button', class: 'apply-button waves-effect' }, 'Apply');
    container.appendChild(btn);
    doc.appendChild(container);

    const result = inspectNaukriJobPage(doc as any);
    expect(result.type).toBe('direct_apply');
    expect(result.buttonText).toBe('Apply');
    expect(result.applyAreaExists).toBe(true);
  });

  it('Case 2: Explicit company site button is classified as "external"', () => {
    const doc = new MockDocument();
    const container = new MockElement('div', { class: 'top-jd-container' });
    const btn = new MockElement(
      'button',
      { id: 'company-site-button', class: 'company-site-button' },
      'Apply on company site',
    );
    container.appendChild(btn);
    doc.appendChild(container);

    const result = inspectNaukriJobPage(doc as any);
    expect(result.type).toBe('external');
    expect(result.buttonText).toBe('Apply on company site');
    expect(result.applyAreaExists).toBe(true);
  });

  it('Case 3A: Already applied button is classified as "already_applied"', () => {
    const doc = new MockDocument();
    const container = new MockElement('div', { class: 'apply-button-container' });
    const btn = new MockElement('button', { id: 'apply-button', class: 'apply-button applied' }, 'Already applied');
    container.appendChild(btn);
    doc.appendChild(container);

    const result = inspectNaukriJobPage(doc as any);
    expect(result.type).toBe('already_applied');
    expect(result.buttonText).toBe('Already applied');
  });

  it('Case 3B: Already applied banner/badge is classified as "already_applied"', () => {
    const doc = new MockDocument();
    const banner = new MockElement('div', { class: 'apply-message-container' }, 'Applied today to Infosys');
    doc.appendChild(banner);

    const result = inspectNaukriJobPage(doc as any);
    expect(result.type).toBe('already_applied');
    expect(result.buttonText.toLowerCase()).toContain('applied today');
  });

  it('Case 4: Empty page with no apply buttons is classified as "waiting" / no button', () => {
    const doc = new MockDocument();
    const content = new MockElement('div', { class: 'content' });
    content.appendChild(new MockElement('p', {}, 'Some unrelated page contents'));
    doc.appendChild(content);

    const result = inspectNaukriJobPage(doc as any);
    expect(result.type).toBe('waiting');
    expect(result.applyAreaExists).toBe(false);
    expect(result.buttonText).toBe('');
  });

  it('Safety: Mention of "applied to" or "company website" in job description or footer does NOT trigger false classification', () => {
    const doc = new MockDocument();
    const container = new MockElement('div', { class: 'apply-button-container' });
    const btn = new MockElement('button', { id: 'apply-button', class: 'apply-button' }, 'Apply');
    container.appendChild(btn);
    doc.appendChild(container);

    // Unrelated text in JD
    const jd = new MockElement('div', { class: 'jd' });
    jd.appendChild(new MockElement('p', {}, 'Candidates who applied to similar jobs or visited the company website'));
    doc.appendChild(jd);

    const result = inspectNaukriJobPage(doc as any);
    // Must remain direct_apply, not external and not already_applied
    expect(result.type).toBe('direct_apply');
    expect(result.buttonText).toBe('Apply');
  });
});

describe('NaukriAdapter.applyToJob Classification & Retry Behavior', () => {
  const mockJob = {
    jobId: '12345',
    title: 'Senior Frontend Engineer',
    company: 'Acme Corp',
    url: 'https://www.naukri.com/job-listings-12345',
    platform: 'naukri' as const,
  };

  const mockContext: any = {
    careerBrain: {},
    page: {},
  };

  it('(a) Direct apply job completes with status "applied"', async () => {
    const mockPage = {
      url: () => mockJob.url,
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS')) return false;
        if (fnStr.includes('inspectNaukriJobPage')) {
          return {
            type: 'direct_apply',
            buttonText: 'Apply',
            applyAreaExists: true,
            documentReadyState: 'complete',
            applyRelatedButtons: ['<button> "Apply" (visible=true)'],
          };
        }
        if (fnStr.includes('robustClick')) return undefined;
        if (
          fnStr.includes('evaluateNaukriSuccess') ||
          fnStr.includes('postClickCheck') ||
          fnStr.includes('type:') ||
          fnStr.includes('type :')
        ) {
          return {
            type: 'success',
            signals: ['text: applied to Acme Corp', 'banner: .apply-message-container', 'button: applied'],
          };
        }
        return false;
      }),
    };

    const res = await naukriAdapter.applyToJob(mockJob, {
      ...mockContext,
      page: { puppeteerPage: mockPage },
    });

    expect(res.status).toBe('applied');
    expect(res.creditsUsed).toBe(1);
  }, 15000);

  it('(b) Explicit external apply skips with "Requires applying directly on company website"', async () => {
    const mockPage = {
      url: () => mockJob.url,
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS')) return false;
        if (fnStr.includes('inspectNaukriJobPage')) {
          return {
            type: 'external',
            buttonText: 'Apply on company site',
            applyAreaExists: true,
            documentReadyState: 'complete',
            applyRelatedButtons: ['<button> "Apply on company site" (visible=true)'],
          };
        }
        return false;
      }),
    };

    const res = await naukriAdapter.applyToJob(mockJob, {
      ...mockContext,
      page: { puppeteerPage: mockPage },
    });

    expect(res.status).toBe('skipped');
    expect(res.reason).toContain('Requires applying directly on company website');
  }, 15000);

  it('(c) Already applied job skips with "You already applied to this job earlier on Naukri"', async () => {
    const mockPage = {
      url: () => mockJob.url,
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS')) return false;
        if (fnStr.includes('inspectNaukriJobPage')) {
          return {
            type: 'already_applied',
            buttonText: 'Already applied',
            applyAreaExists: true,
            documentReadyState: 'complete',
            applyRelatedButtons: ['<button> "Already applied" (visible=true)'],
          };
        }
        return false;
      }),
    };

    const res = await naukriAdapter.applyToJob(mockJob, {
      ...mockContext,
      page: { puppeteerPage: mockPage },
    });

    expect(res.status).toBe('skipped');
    expect(res.reason).toContain('You already applied to this job earlier on Naukri');
  }, 15000);

  it('(d) Job with no apply button after waiting skips with "No active Apply button found on job page"', async () => {
    const mockPage = {
      url: () => mockJob.url,
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS')) return false;
        if (fnStr.includes('inspectNaukriJobPage')) {
          return {
            type: 'waiting',
            buttonText: '',
            applyAreaExists: false,
            documentReadyState: 'complete',
            applyRelatedButtons: [],
          };
        }
        return false;
      }),
    };

    const res = await naukriAdapter.applyToJob(mockJob, {
      ...mockContext,
      page: { puppeteerPage: mockPage },
    });

    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('No active Apply button found on job page.');
  }, 20000);

  it('(e) Late-rendering apply button: Waits for React hydration and succeeds', async () => {
    let callCount = 0;
    const mockPage = {
      url: () => mockJob.url,
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS')) return false;
        if (fnStr.includes('inspectNaukriJobPage')) {
          callCount++;
          // First 2 calls return waiting (DOM not hydrated yet)
          if (callCount <= 2) {
            return {
              type: 'waiting',
              buttonText: '',
              applyAreaExists: false,
              documentReadyState: 'loading',
              applyRelatedButtons: [],
            };
          }
          // Third call onwards: React mounted the apply container
          return {
            type: 'direct_apply',
            buttonText: 'Apply',
            applyAreaExists: true,
            documentReadyState: 'complete',
            applyRelatedButtons: ['<button> "Apply" (visible=true)'],
          };
        }
        if (fnStr.includes('robustClick')) return undefined;
        if (
          fnStr.includes('evaluateNaukriSuccess') ||
          fnStr.includes('postClickCheck') ||
          fnStr.includes('type:') ||
          fnStr.includes('type :')
        ) {
          return {
            type: 'success',
            signals: ['text: applied to Acme Corp', 'banner: .apply-message-container', 'button: applied'],
          };
        }
        return false;
      }),
    };

    const res = await naukriAdapter.applyToJob(mockJob, {
      ...mockContext,
      page: { puppeteerPage: mockPage },
    });

    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(res.status).toBe('applied');
  }, 20000);
});
