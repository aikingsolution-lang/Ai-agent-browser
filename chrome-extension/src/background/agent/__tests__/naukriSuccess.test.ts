// chrome-extension/src/background/agent/__tests__/naukriSuccess.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateNaukriSuccess,
  findNaukriRealQuestionnaire,
  isNaukriUpsellOrQuiz,
} from '../platforms/naukri/naukriDomHelpers';
import { NAUKRI_SELECTORS } from '../platforms/naukri/selectors';
import { naukriAdapter } from '../platforms/naukri/naukriAdapter';

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
  value: string = '';
  offsetParent: any = {};

  constructor(tagName: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this.className = attrs.class || '';
    this.id = attrs.id || '';
    this.textContent = text;
    this.innerText = text;
    this.value = attrs.value || '';
  }

  get classList() {
    const tokens = this.className ? this.className.split(/\s+/).filter(Boolean) : [];
    return {
      contains: (cls: string) => tokens.includes(cls),
      add: (cls: string) => {
        if (!tokens.includes(cls)) tokens.push(cls);
        this.className = tokens.join(' ');
      },
      remove: (cls: string) => {
        const next = tokens.filter(t => t !== cls);
        this.className = next.join(' ');
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
    if (name === 'value') this.value = value;
  }

  appendChild(child: MockDOMElement): MockDOMElement {
    child.parentElement = this;
    this.children.push(child);
    this.syncText();
    return child;
  }

  private syncText() {
    let t = this.textContent;
    for (const c of this.children) {
      t += ' ' + (c.innerText || c.textContent);
    }
    this.innerText = t.trim();
    this.textContent = t.trim();
    if (this.parentElement) {
      this.parentElement.syncText();
    }
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
      if (sel.startsWith('#') && id === sel.slice(1)) return true;
      if (sel.startsWith('.') && clsList.includes(sel.slice(1))) return true;

      // Handle input:not(...)
      if (sel.startsWith('input')) {
        if (tag === 'input') {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (sel.includes(':not([type="hidden"])') && type === 'hidden') return false;
          if (sel.includes(':not([type="file"])') && type === 'file') return false;
          if (sel.includes(':not([type="submit"])') && type === 'submit') return false;
          if (sel.includes(':not([type="button"])') && type === 'button') return false;
          if (sel.includes(':not([type="reset"])') && type === 'reset') return false;
          return true;
        }
        return false;
      }

      if (sel.includes('[') && sel.includes(']')) {
        const tagPart = sel.split('[')[0];
        if (tagPart && tagPart !== tag) return false;

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
        const sCls = parts[1];
        if (sTag && sTag !== tag) return false;
        if (sCls && !clsList.includes(sCls)) return false;
        return true;
      }

      return false;
    };

    const traverse = (node: MockDOMElement) => {
      for (const child of node.children) {
        for (const sel of selectors) {
          if (matches(child, sel)) {
            if (!results.includes(child)) results.push(child);
            break;
          }
        }
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }
}

function createMockPuppeteerPage(options: {
  applyBtnText?: string;
  isExternal?: boolean;
  postClickType?: 'success' | 'modal_open' | 'unknown';
  signals?: string[];
  stepData?: any;
  postSubmitFinished?: boolean;
  repeatQuestionCount?: number;
}) {
  let stepCount = 0;
  return {
    url: () => 'https://www.naukri.com/job-listings-12345',
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async (fn: any, ...args: any[]) => {
      const fnStr = fn.toString();

      // 1. Verification wall & already applied checks MUST return boolean false
      if (fnStr.includes('VERIFICATION_SELECTORS') || fnStr.includes('complete the security check')) {
        return false;
      }
      if (fnStr.includes('ALREADY_APPLIED_INDICATORS')) {
        return false;
      }

      // 2. Primary apply button detection
      if (fnStr.includes('company-site-button') || fnStr.includes('button#apply-button')) {
        if (options.isExternal) {
          return { found: true, isExternal: true, text: 'Apply on company website' };
        }
        return { found: true, isExternal: false, text: options.applyBtnText || 'Apply' };
      }

      // 3. Click Apply button
      if (fnStr.includes('robustClick')) {
        return undefined;
      }

      // 4. Post click check
      if (
        fnStr.includes('Direct 1-Click apply succeeded') ||
        fnStr.includes('postClickCheck') ||
        fnStr.includes('evaluateSuccess')
      ) {
        if (fnStr.includes('type:') || fnStr.includes('type :')) {
          return {
            type: options.postClickType || 'success',
            signals: options.signals || [
              'text: applied to Infosys',
              'banner: .apply-message-container',
              'button: applied',
            ],
          };
        }
      }

      // 5. Questionnaire step status check
      if (fnStr.includes('findRealQuestionnaire') && fnStr.includes('state:')) {
        stepCount++;
        return { state: 'modal_open' };
      }

      // 6. Questionnaire stepData extraction
      if (fnStr.includes('CHATBOT_QUESTION_BUBBLE') || fnStr.includes('stepData')) {
        return (
          options.stepData || {
            modalFound: true,
            fields: [],
            choiceOptions: [],
            activeQuestion: 'Are you available for an interview?',
            hasSkipBtn: false,
            modalHeading: 'Recruiter questions',
          }
        );
      }

      // 7. Submit action
      if (fnStr.includes('submitAction') || fnStr.includes('SUBMIT_BUTTON')) {
        return { clicked: true, action: 'save', text: 'Save' };
      }

      // 8. Post submit check
      if (fnStr.includes('postSubmitCheck') || fnStr.includes('finished:')) {
        return {
          finished: options.postSubmitFinished ?? true,
          success: true,
          signals: options.signals || ['text: applied to Infosys'],
        };
      }

      // 9. Secondary check
      if (fnStr.includes('secondaryCheck')) {
        return {
          type: options.postClickType || 'unknown',
          signals: options.signals || [],
        };
      }

      // 10. Final check
      if (fnStr.includes('finalCheck')) {
        return { success: false, reason: 'modal_still_open' };
      }

      return false;
    }),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
    },
    mouse: {
      click: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('Naukri Success Detection & Questionnaire Filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DOM Helpers Unit Tests with Realistic Fixtures', () => {
    it('(a) One-click apply: Recognises "Applied to Infosys" banner and ignores the quiz drawer', () => {
      const body = new MockDOMElement('body');

      const applyBtn = new MockDOMElement('button', { id: 'apply-button', class: 'apply-button applied' }, 'Applied');
      body.appendChild(applyBtn);

      const msgContainer = new MockDOMElement('div', { class: 'apply-message-container' });
      const tick = new MockDOMElement('span', { class: 'green-tick' });
      const msg = new MockDOMElement('div', { class: 'apply-message' }, 'Applied to Infosys');
      msgContainer.appendChild(tick);
      msgContainer.appendChild(msg);
      body.appendChild(msgContainer);

      // Quiz / upsell drawer
      const drawer = new MockDOMElement('div', { role: 'dialog', class: 'drawer-wrapper' });
      const header = new MockDOMElement('div', { class: 'drawer-header' }, 'Applied to Infosys');
      const potd = new MockDOMElement('div', { class: 'potd-container' });
      const h3 = new MockDOMElement('h3', {}, 'Problem of the day');
      const q = new MockDOMElement('p', {}, 'What is binary search?');
      const r1 = new MockDOMElement('input', { type: 'radio', name: 'potd', value: 'O(log n)' });
      const r2 = new MockDOMElement('input', { type: 'radio', name: 'potd', value: 'O(n)' });
      potd.appendChild(h3);
      potd.appendChild(q);
      potd.appendChild(r1);
      potd.appendChild(r2);

      const upsell = new MockDOMElement('div', { class: 'upsell-container' });
      const h4 = new MockDOMElement('h4', {}, 'Become a Pro');
      const p2 = new MockDOMElement('p', {}, 'Get 3x more recruiter views with FastForward Pro');
      upsell.appendChild(h4);
      upsell.appendChild(p2);

      drawer.appendChild(header);
      drawer.appendChild(potd);
      drawer.appendChild(upsell);
      body.appendChild(drawer);

      // 1. Success evaluation detects multiple independent signals
      const successResult = evaluateNaukriSuccess(body as any, NAUKRI_SELECTORS);
      expect(successResult.isSuccess).toBe(true);
      expect(successResult.signals.length).toBeGreaterThanOrEqual(2);
      expect(successResult.signals.some(s => s.toLowerCase().includes('applied to infosys'))).toBe(true);
      expect(successResult.signals).toContain('banner: .apply-message');
      expect(successResult.signals).toContain('button: applied');

      // 2. Real questionnaire detection must return null (quiz drawer is ignored)
      const questionnaire = findNaukriRealQuestionnaire(body as any, NAUKRI_SELECTORS);
      expect(questionnaire).toBeNull();
    });

    it('(b) Questionnaire with real questions followed by post-apply drawer transition', () => {
      // Phase 1: Real questionnaire open
      const bodyQ = new MockDOMElement('body');
      const btnQ = new MockDOMElement('button', { id: 'apply-button', class: 'apply-button' }, 'Apply');
      bodyQ.appendChild(btnQ);

      const drawerQ = new MockDOMElement('div', { role: 'dialog', class: 'apply-drawer' });
      const heading = new MockDOMElement('h3', {}, "Recruiter's questions");
      const desc = new MockDOMElement('p', {}, 'Kindly answer all questions to complete application');
      const noticeInput = new MockDOMElement('input', { type: 'text', name: 'noticePeriod' });
      const submitBtn = new MockDOMElement('button', { class: 'save-apply', type: 'submit' }, 'Save');
      drawerQ.appendChild(heading);
      drawerQ.appendChild(desc);
      drawerQ.appendChild(noticeInput);
      drawerQ.appendChild(submitBtn);
      bodyQ.appendChild(drawerQ);

      // Before submit: No success
      const succQ = evaluateNaukriSuccess(bodyQ as any, NAUKRI_SELECTORS);
      expect(succQ.isSuccess).toBe(false);

      // Real questionnaire detected
      const modalQ = findNaukriRealQuestionnaire(bodyQ as any, NAUKRI_SELECTORS);
      expect(modalQ).not.toBeNull();
      expect(modalQ?.textContent).toContain("Recruiter's questions");

      // Phase 2: After submit, transitioned to success with quiz drawer
      const bodyPost = new MockDOMElement('body');
      const btnApplied = new MockDOMElement('button', { id: 'apply-button', class: 'apply-button applied' }, 'Applied');
      const banner = new MockDOMElement('div', { class: 'apply-message-container' });
      banner.appendChild(new MockDOMElement('div', { class: 'apply-message' }, 'Applied to Java Full Stack Developer'));
      bodyPost.appendChild(btnApplied);
      bodyPost.appendChild(banner);

      const postDrawer = new MockDOMElement('div', { role: 'dialog', class: 'drawer-wrapper' });
      const potd = new MockDOMElement('div', { class: 'potd' });
      potd.appendChild(new MockDOMElement('h3', {}, 'Problem of the day'));
      potd.appendChild(new MockDOMElement('input', { type: 'radio', name: 'q' }));
      postDrawer.appendChild(potd);
      postDrawer.appendChild(new MockDOMElement('div', {}, 'Become a Pro with FastForward'));
      bodyPost.appendChild(postDrawer);

      const succPost = evaluateNaukriSuccess(bodyPost as any, NAUKRI_SELECTORS);
      expect(succPost.isSuccess).toBe(true);
      expect(succPost.signals.some(s => s.includes('applied to'))).toBe(true);

      const noModal = findNaukriRealQuestionnaire(bodyPost as any, NAUKRI_SELECTORS);
      expect(noModal).toBeNull();
    });

    it('(c) Real questionnaire that stays open with unfilled mandatory questions', () => {
      const body = new MockDOMElement('body');
      const drawer = new MockDOMElement('div', { role: 'dialog', class: 'apply-drawer' });
      drawer.appendChild(new MockDOMElement('h3', {}, "Recruiter's questions"));
      drawer.appendChild(new MockDOMElement('p', {}, 'How many years of experience do you have with React?'));
      drawer.appendChild(new MockDOMElement('input', { type: 'text', name: 'exp' }));
      drawer.appendChild(new MockDOMElement('div', { class: 'err-msg' }, 'This field is mandatory'));
      drawer.appendChild(new MockDOMElement('button', { class: 'save-apply', type: 'submit' }, 'Save'));
      body.appendChild(drawer);

      const succ = evaluateNaukriSuccess(body as any, NAUKRI_SELECTORS);
      expect(succ.isSuccess).toBe(false);

      const modal = findNaukriRealQuestionnaire(body as any, NAUKRI_SELECTORS);
      expect(modal).not.toBeNull();
    });

    it('(d) External apply button is recognized and never treated as success', () => {
      const body = new MockDOMElement('body');
      body.appendChild(
        new MockDOMElement(
          'button',
          { id: 'company-site-button', class: 'company-site-button' },
          'Apply on company website',
        ),
      );

      const succ = evaluateNaukriSuccess(body as any, NAUKRI_SELECTORS);
      expect(succ.isSuccess).toBe(false);
    });

    it('(e) Quiz drawer radios are identified as upsell and NEVER treated as recruiter questions', () => {
      const body = new MockDOMElement('body');
      const drawer = new MockDOMElement('div', { class: 'drawer-wrapper' });
      const potd = new MockDOMElement('div', { class: 'potd-card' });
      potd.appendChild(new MockDOMElement('h3', {}, 'Problem of the day'));
      const radioA = new MockDOMElement('input', { type: 'radio', name: 'potd', value: 'A' });
      const radioB = new MockDOMElement('input', { type: 'radio', name: 'potd', value: 'B' });
      potd.appendChild(radioA);
      potd.appendChild(radioB);

      const pro = new MockDOMElement('div', { class: 'pro-upsell' });
      pro.appendChild(new MockDOMElement('h4', {}, 'Become a Pro'));
      pro.appendChild(new MockDOMElement('p', {}, 'Naukri FastForward helps you stand out'));
      drawer.appendChild(potd);
      drawer.appendChild(pro);
      body.appendChild(drawer);

      expect(isNaukriUpsellOrQuiz(radioA as any, NAUKRI_SELECTORS)).toBe(true);
      expect(isNaukriUpsellOrQuiz(radioB as any, NAUKRI_SELECTORS)).toBe(true);

      const modal = findNaukriRealQuestionnaire(body as any, NAUKRI_SELECTORS);
      expect(modal).toBeNull();
    });

    it('(f) Weak text signal ("applied to", "applied today") in job description or similar-jobs section does NOT return applied on its own', () => {
      const body = new MockDOMElement('body');

      // Primary apply button is unclicked
      const btn = new MockDOMElement('button', { id: 'apply-button', class: 'apply-button' }, 'Apply');
      body.appendChild(btn);

      // Job description containing "applied to"
      const jd = new MockDOMElement('div', { class: 'job-desc' });
      jd.appendChild(
        new MockDOMElement(
          'p',
          {},
          'Candidates who have applied to similar enterprise roles or applied today with Java and React skills are preferred.',
        ),
      );
      body.appendChild(jd);

      // Similar jobs section containing "applied to"
      const similar = new MockDOMElement('div', { class: 'similar-jobs' });
      similar.appendChild(new MockDOMElement('span', {}, 'Jobs applied to by other jobseekers'));
      body.appendChild(similar);

      const result = evaluateNaukriSuccess(body as any, NAUKRI_SELECTORS);

      // Must NOT return applied
      expect(result.isSuccess).toBe(false);
      expect(result.confidence).toBe('none');
      // The weak signal is tracked as weak_text, not as a strong confirmation
      expect(result.signals.some(s => s.startsWith('weak_text:'))).toBe(true);
      expect(
        result.signals.some(s => s.startsWith('banner:') || s.startsWith('button:') || s.startsWith('container_text:')),
      ).toBe(false);
    });

    it('(g) Synthetic real-page layout fixture: before apply (with "applied to" in JD & similar jobs) vs after apply (with confirmation drawer, banner and button)', () => {
      // NOTE: This fixture is strictly synthetic, modeled accurately on the DOM layout of real Naukri job pages
      const page = new MockDOMElement('body');

      // Top header with company and apply button
      const header = new MockDOMElement('div', { class: 'job-header' });
      const applyBtn = new MockDOMElement(
        'button',
        { id: 'apply-button', class: 'apply-button waves-effect' },
        'Apply',
      );
      header.appendChild(new MockDOMElement('h1', { class: 'job-title' }, 'Java Full Stack Developer'));
      header.appendChild(new MockDOMElement('div', { class: 'company-name' }, 'Infosys'));
      header.appendChild(applyBtn);
      page.appendChild(header);

      // JD with phrases like "applied to"
      const jdSection = new MockDOMElement('section', { class: 'job-desc' });
      jdSection.appendChild(new MockDOMElement('h2', {}, 'Job description'));
      jdSection.appendChild(
        new MockDOMElement('p', {}, 'Principles applied to cloud architectures in this project...'),
      );
      jdSection.appendChild(new MockDOMElement('span', {}, '15 applicants applied today'));
      page.appendChild(jdSection);

      // Similar jobs sidebar
      const similarSection = new MockDOMElement('section', { class: 'similar-jobs' });
      similarSection.appendChild(new MockDOMElement('h3', {}, 'Similar jobs applied to recently'));
      page.appendChild(similarSection);

      // BEFORE APPLY:
      const beforeResult = evaluateNaukriSuccess(page as any, NAUKRI_SELECTORS);
      expect(beforeResult.isSuccess).toBe(false);
      expect(beforeResult.confidence).toBe('none');

      // AFTER APPLY:
      // Primary button updates to "Applied"
      applyBtn.className = 'apply-button applied already-applied';
      applyBtn.textContent = 'Applied';
      applyBtn.innerText = 'Applied';

      // Confirmation banner appears in an apply confirmation container
      const confirmContainer = new MockDOMElement('div', { class: 'apply-message-container' });
      const banner = new MockDOMElement(
        'div',
        { class: 'apply-message' },
        'Applied to Java Full Stack Developer (Infosys)',
      );
      const greenTick = new MockDOMElement('i', { class: 'green-tick icon-success' });
      confirmContainer.appendChild(greenTick);
      confirmContainer.appendChild(banner);
      page.appendChild(confirmContainer);

      // Post-apply drawer opens with quiz and upsell
      const drawer = new MockDOMElement('div', { class: 'drawer-wrapper', role: 'dialog' });
      const potd = new MockDOMElement('div', { class: 'potd' });
      potd.appendChild(new MockDOMElement('h3', {}, 'Problem of the day'));
      potd.appendChild(new MockDOMElement('input', { type: 'radio', name: 'potd_opt', value: '1' }));
      const upsell = new MockDOMElement('div', { class: 'pro-upsell' });
      upsell.appendChild(new MockDOMElement('h4', {}, 'Become a Pro with Naukri FastForward'));
      drawer.appendChild(potd);
      drawer.appendChild(upsell);
      page.appendChild(drawer);

      const afterResult = evaluateNaukriSuccess(page as any, NAUKRI_SELECTORS);
      expect(afterResult.isSuccess).toBe(true);
      expect(afterResult.confidence).toBe('high');
      expect(afterResult.signals.some(s => s.startsWith('banner:'))).toBe(true);
      expect(afterResult.signals).toContain('button: applied');
      expect(afterResult.signals.some(s => s.startsWith('container_text:'))).toBe(true);

      // Drawer is verified as NOT a questionnaire
      const realModal = findNaukriRealQuestionnaire(page as any, NAUKRI_SELECTORS);
      expect(realModal).toBeNull();
    });
  });

  describe('NaukriAdapter.applyToJob End-to-End Execution Flow', () => {
    const mockJob = {
      jobId: '12345',
      title: 'Java Full Stack Developer',
      company: 'Infosys',
      url: 'https://www.naukri.com/job-listings-12345',
      platform: 'naukri' as const,
    };

    it('(a) One-click apply returns status: "applied" with creditsUsed: 1 when "Applied to Infosys" is shown', async () => {
      const mockPage = createMockPuppeteerPage({
        postClickType: 'success',
        signals: ['text: applied to Infosys', 'banner: .apply-message-container', 'button: applied'],
      });

      const result = await naukriAdapter.applyToJob(
        mockJob as any,
        {
          page: { puppeteerPage: mockPage },
          careerBrain: {},
        } as any,
      );
      expect(result.status).toBe('applied');
      expect(result.creditsUsed).toBe(1);
    }, 20000);

    it('(b) Multi-step apply: Completes real question and confirms applied upon post-apply drawer transition', async () => {
      let submitted = false;
      const mockPage = createMockPuppeteerPage({
        postClickType: 'modal_open',
        signals: ['text: applied to Infosys', 'banner: .apply-message-container'],
      });

      mockPage.evaluate = vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS') || fnStr.includes('complete the security check')) return false;
        if (fnStr.includes('ALREADY_APPLIED_INDICATORS')) return false;
        if (fnStr.includes('company-site-button') || fnStr.includes('button#apply-button')) {
          return { found: true, isExternal: false, text: 'Apply' };
        }
        if (fnStr.includes('robustClick')) return undefined;
        if (
          fnStr.includes('Direct 1-Click apply succeeded') ||
          fnStr.includes('postClickCheck') ||
          fnStr.includes('type:')
        ) {
          return { type: 'modal_open' };
        }
        if (fnStr.includes('modalFound')) {
          return {
            modalFound: true,
            fields: [
              {
                index: 0,
                labelText: 'Notice Period',
                fieldType: 'text',
                options: [],
                currentValue: '',
                errorMessage: '',
              },
            ],
            choiceOptions: [],
            activeQuestion: 'What is your notice period?',
            hasSkipBtn: false,
            modalHeading: "Recruiter's questions",
          };
        }
        if (fnStr.includes('inspectAndHealFormErrors') || fnStr.includes('err-msg')) {
          return { correctedCount: 0 };
        }
        if (fnStr.includes('setNative') || fnStr.includes('InputEvent')) {
          return { filled: true, x: 100, y: 100 };
        }
        if (fnStr.includes('SUBMIT_BUTTON') || fnStr.includes('actionBtn')) {
          submitted = true;
          return { clicked: true, action: 'save', text: 'Save' };
        }
        if (fnStr.includes('more_questions_in_modal') || fnStr.includes('modal_transitioning_or_unconfirmed')) {
          if (submitted) {
            return {
              finished: true,
              success: true,
              signals: ['text: applied to Infosys', 'banner: .apply-message-container'],
            };
          }
          return { finished: false, success: false };
        }
        if (fnStr.includes('evaluateSuccess') || fnStr.includes('appliedToRegex') || fnStr.includes('isSuccess')) {
          if (submitted) {
            return {
              isSuccess: true,
              signals: ['text: applied to Infosys', 'banner: .apply-message-container'],
            };
          }
          return { isSuccess: false, signals: [] };
        }
        return { state: 'modal_open' };
      });

      const result = await naukriAdapter.applyToJob(
        mockJob as any,
        {
          page: { puppeteerPage: mockPage },
          careerBrain: { noticePeriod: '15 Days' },
        } as any,
      );
      expect(result.status).toBe('applied');
      expect(result.creditsUsed).toBe(1);
    }, 20000);

    it('(c) Real questionnaire that remains stuck terminates cleanly without burning 15 steps', async () => {
      let stepCount = 0;
      const mockPage = createMockPuppeteerPage({
        postClickType: 'modal_open',
      });

      mockPage.evaluate = vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS') || fnStr.includes('complete the security check')) return false;
        if (fnStr.includes('ALREADY_APPLIED_INDICATORS')) return false;
        if (fnStr.includes('company-site-button') || fnStr.includes('button#apply-button')) {
          return { found: true, isExternal: false, text: 'Apply' };
        }
        if (fnStr.includes('robustClick')) return undefined;
        if (
          fnStr.includes('Direct 1-Click apply succeeded') ||
          fnStr.includes('postClickCheck') ||
          fnStr.includes('type:')
        ) {
          return { type: 'modal_open' };
        }
        if (fnStr.includes('modalFound')) {
          stepCount++;
          return {
            modalFound: true,
            fields: [],
            choiceOptions: [],
            activeQuestion: 'Are you available for an interview?',
            hasSkipBtn: false,
            modalHeading: 'Recruiter questions',
          };
        }
        if (fnStr.includes('inspectAndHealFormErrors') || fnStr.includes('err-msg')) {
          return { correctedCount: 0 };
        }
        if (fnStr.includes('setNative') || fnStr.includes('InputEvent')) {
          return { filled: true };
        }
        if (fnStr.includes('SUBMIT_BUTTON') || fnStr.includes('actionBtn')) {
          return { clicked: true, action: 'save', text: 'Save' };
        }
        if (fnStr.includes('more_questions_in_modal') || fnStr.includes('modal_transitioning_or_unconfirmed')) {
          return { finished: false, success: false, reason: 'more_questions_in_modal' };
        }
        if (fnStr.includes('evaluateSuccess') || fnStr.includes('appliedToRegex') || fnStr.includes('isSuccess')) {
          return { isSuccess: false, signals: [] };
        }
        return { state: 'modal_open' };
      });

      const result = await naukriAdapter.applyToJob(
        mockJob as any,
        {
          page: { puppeteerPage: mockPage },
          careerBrain: {},
        } as any,
      );
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Questionnaire remained open');
      expect(stepCount).toBeLessThan(15);
    }, 20000);

    it('(d) Job with an external apply button skips cleanly without applying', async () => {
      const mockPage = createMockPuppeteerPage({
        isExternal: true,
      });

      const result = await naukriAdapter.applyToJob(
        mockJob as any,
        {
          page: { puppeteerPage: mockPage },
          careerBrain: {},
        } as any,
      );
      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('company website');
    }, 20000);

    it('(e) When no success signal is present and no questionnaire is found, reports failure without false applied', async () => {
      const mockPage = createMockPuppeteerPage({
        postClickType: 'unknown',
      });

      mockPage.evaluate = vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn.toString();
        if (fnStr.includes('VERIFICATION_SELECTORS') || fnStr.includes('complete the security check')) return false;
        if (fnStr.includes('ALREADY_APPLIED_INDICATORS')) return false;
        if (fnStr.includes('company-site-button') || fnStr.includes('button#apply-button')) {
          return { found: true, isExternal: false, text: 'Apply' };
        }
        if (fnStr.includes('robustClick')) return undefined;
        // Post click and secondary check return unknown
        return { type: 'unknown' };
      });

      const result = await naukriAdapter.applyToJob(
        mockJob as any,
        {
          page: { puppeteerPage: mockPage },
          careerBrain: {},
        } as any,
      );
      expect(result.status).toBe('failed');
      expect(result.reason).toBe('Application could not be confirmed after clicking apply button.');
    }, 20000);
  });
});
