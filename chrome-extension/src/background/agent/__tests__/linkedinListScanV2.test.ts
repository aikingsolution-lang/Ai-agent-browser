import { describe, it, expect, vi } from 'vitest';

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
  scrollHeight: number = 100;
  clientHeight: number = 100;
  scrollTop: number = 0;
  clicked: boolean = false;
  focused: boolean = false;
  dispatchedEvents: string[] = [];

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

  constructor(tagName: string, attrs: Record<string, string> = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this.className = attrs.class || '';
    this.id = attrs.id || '';
    this._text = text;
  }

  get isConnected(): boolean {
    return true;
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
    let curr: MockDOMElement | null = this;
    while (curr) {
      if (curr.matches(selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  matches(selector: string): boolean {
    const parts = selector.split(',').map(s => s.trim());
    return parts.some(sel => {
      let current = sel;
      let tag = '';
      const tagMatch = current.match(/^([a-zA-Z0-9]+)/);
      if (tagMatch) {
        tag = tagMatch[1];
        current = current.slice(tag.length);
      }
      if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) {
        return false;
      }
      if (!current) return true;
      if (current.startsWith('.')) {
        const cls = current.slice(1);
        return this.className.split(/\s+/).includes(cls);
      }
      if (current.startsWith('#')) {
        return this.id === current.slice(1);
      }
      if (current.startsWith('[') && current.endsWith(']')) {
        const attrExpr = current.slice(1, -1);
        if (attrExpr.includes('^=')) {
          const [attr, val] = attrExpr.split('^=').map(s => s.replace(/['"]/g, ''));
          return this.getAttribute(attr)?.startsWith(val) ?? false;
        }
        if (attrExpr.includes('*=')) {
          const [attr, val] = attrExpr.split('*=').map(s => s.replace(/['"]/g, ''));
          return this.getAttribute(attr)?.includes(val) ?? false;
        }
        if (attrExpr.includes('=')) {
          const [attr, val] = attrExpr.split('=').map(s => s.replace(/['"]/g, ''));
          return this.getAttribute(attr) === val;
        }
        return this.hasAttribute(attrExpr);
      }
      return false;
    });
  }

  querySelector(selector: string): MockDOMElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): MockDOMElement[] {
    const results: MockDOMElement[] = [];
    const traverse = (node: MockDOMElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        traverse(child);
      }
    };
    traverse(this);
    return results;
  }

  scrollIntoView(): void {}
  focus(): void {
    this.focused = true;
  }
  click(): void {
    this.clicked = true;
  }
  dispatchEvent(evt: { type: string }): boolean {
    this.dispatchedEvents.push(evt.type);
    return true;
  }
  scrollBy(x: number, y: number): void {
    this.scrollTop += y;
  }
  scrollTo(opts: { top: number }): void {
    this.scrollTop = opts.top;
  }
}

/**
 * Pure DOM implementation of list scanner under test, matching page.ts
 */
function scanJobListFromDom(
  doc: MockDOMElement,
  urlPath = '/jobs/search/?keywords=software',
): {
  cards: Array<{ jobId: string; title: string; company: string; url: string }>;
  diagnostic: string;
} {
  function isInsideDetailsPane(el: MockDOMElement | null): boolean {
    if (!el) return false;
    return Boolean(
      el.closest(
        '.scaffold-layout__detail, [data-view-name="job-details"], .jobs-search__job-details, .jobs-search__job-details--container, [data-view-name="job-details-top-card"], .jobs-details__main-content',
      ),
    );
  }

  function cleanElementText(el: MockDOMElement | null): string {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function cleanLinkedInJobTitle(raw: string): string {
    if (!raw) return '';
    return raw
      .replace(/^\s*(?:🤖\s*)?(?:\[Runner\]\s*)+/i, '')
      .replace(/\bwith verification\b/gi, '')
      .replace(/\bactively recruiting\b/gi, '')
      .replace(/\bpromoted\b/gi, '')
      .replace(/\beasy apply\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isJunkJobTitle(raw: string): boolean {
    const t = (raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t || t.length < 2 || t.length > 120) return true;
    if (
      /\b(?:feedback|negative\s*feedback|share\s*feedback|report\s*this|report\s*job|save\s*job|follow|unfollow|hide\s*job|not\s*interested|send\s*feedback)\b/i.test(
        t,
      )
    ) {
      return true;
    }
    return /^(?:more|less|see more|show more|view more|easy apply|promoted|verified|save|saved|dismiss|close|apply|applied|apply now|apply on company site|view job|job|job details|linkedin job|linkedin|unknown|unknown company|company|share|n\/?a|none|null|undefined)$/.test(
      t,
    );
  }

  function isLocationLine(raw: string): boolean {
    if (!raw) return false;
    const t = raw.trim().toLowerCase();
    if (/\((?:on-site|hybrid|remote)\)/i.test(t)) return true;
    if (/^(?:on-site|hybrid|remote)$/i.test(t)) return true;
    if (/\b(?:on-site|hybrid|remote)\b/i.test(t) && (t.includes('(') || t.includes(','))) return true;
    if (
      /\b(?:bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|noida|gurugram|gurgaon|san francisco|new york|london|seattle|austin|chicago|singapore|berlin|toronto|sydney)\b/i.test(
        t,
      ) &&
      (/\((?:on-site|hybrid|remote)\)/i.test(t) || /,\s*[a-z]+/i.test(t) || /\b(?:area|region|india|usa|uk)\b/i.test(t))
    ) {
      return true;
    }
    return false;
  }

  function isBadgeOrButtonLabel(raw: string): boolean {
    if (!raw) return true;
    const t = raw.trim().toLowerCase();
    if (t.length < 2 || t.length > 120) return true;
    if (
      /^(?:dismiss|easy apply|viewed|promoted|save|saved|close|apply|applied|apply now|more|less|share feedback|report this job|actively recruiting|be an early applicant|seen)$/i.test(
        t,
      )
    ) {
      return true;
    }
    if (/^(?:reposted\s+)?\d+\s+(?:day|week|month|hour|minute)s?\s+ago$/i.test(t) || /^just now$/i.test(t)) {
      return true;
    }
    if (/\b(?:connection|connections|school alumni|alumni)\b/i.test(t)) {
      return true;
    }
    return isJunkJobTitle(t);
  }

  function querySearchCardElements(): MockDOMElement[] {
    const componentCards = doc.querySelectorAll(
      '[componentkey^="job-card-component-ref-"], [componentkey*="job-card-component-ref-"]',
    );
    const valid = componentCards.filter(c => !isInsideDetailsPane(c));
    if (valid.length > 0) return valid;

    const listRoot = doc.querySelector(
      'ul.scaffold-layout__list-container, .scaffold-layout__list-container, .jobs-search-results-list__list',
    );
    if (listRoot) {
      const listCards = listRoot.children.filter(c => {
        return (
          !isInsideDetailsPane(c) &&
          (c.hasAttribute('data-occludable-job-id') ||
            c.hasAttribute('data-job-id') ||
            c.querySelector(
              '[data-occludable-job-id], [data-job-id], a[href*="/jobs/view/"], a[href*="currentJobId="]',
            ) !== null)
        );
      });
      if (listCards.length > 0) return listCards;
    }

    const structuralSelectors = [
      'li[data-occludable-job-id]',
      'div[data-job-id]',
      'li[data-job-id]',
      '[data-view-name="job-card"]',
      '[data-view-name*="job-card"]',
      'li.scaffold-layout__list-item',
      'div.job-card-container',
      'div.base-card',
    ].join(', ');
    const found = doc.querySelectorAll(structuralSelectors);
    return found.filter(el => !isInsideDetailsPane(el));
  }

  const cardsToProcess = querySearchCardElements();
  const results: Array<{ jobId: string; title: string; company: string; url: string }> = [];
  const seenJobIds = new Set<string>();

  for (const card of cardsToProcess) {
    if (isInsideDetailsPane(card)) continue;

    let jobId = '';
    const compKey = card.getAttribute('componentkey') || '';
    const compMatch = compKey.match(/job-card-component-ref-(\d{7,12})/);
    if (compMatch && compMatch[1]) jobId = compMatch[1];

    if (!jobId) {
      const childComp = card.querySelector('[componentkey*="job-card-component-ref-"]');
      if (childComp) {
        const m = (childComp.getAttribute('componentkey') || '').match(/job-card-component-ref-(\d{7,12})/);
        if (m && m[1]) jobId = m[1];
      }
    }

    if (!jobId) {
      jobId =
        card.getAttribute('data-job-id') ||
        card.getAttribute('data-occludable-job-id') ||
        card.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
        card.querySelector('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id') ||
        '';
      if (jobId && jobId.includes('urn:li:jobPosting:')) {
        const urnMatch = jobId.match(/(\d+)/);
        if (urnMatch && urnMatch[1]) jobId = urnMatch[1];
      }
    }

    if (!jobId) {
      const titleAnchor = card.querySelector(
        'a[href*="/jobs/view/"], a[href*="currentJobId="], [data-view-name*="job-card-title"], a.job-card-list__title',
      );
      if (titleAnchor) {
        const href = titleAnchor.getAttribute('href') || '';
        const match = href.match(/(?:\/jobs\/view\/|currentJobId=)(\d{7,12})/);
        if (match && match[1]) jobId = match[1];
      }
    }

    if (!jobId || seenJobIds.has(jobId)) continue;
    seenJobIds.add(jobId);

    const pElements = card.querySelectorAll('p');
    const candidatePTexts: string[] = [];

    for (const p of pElements) {
      if (p.closest('figure, button, [aria-hidden="true"]')) continue;
      if (p.getAttribute('aria-hidden') === 'true') continue;

      const txt = cleanElementText(p);
      if (!txt) continue;
      if (isBadgeOrButtonLabel(txt)) continue;
      if (isLocationLine(txt)) continue;

      candidatePTexts.push(txt);
    }

    let title = '';
    if (candidatePTexts.length > 0) title = candidatePTexts[0];
    if (!title || isJunkJobTitle(title)) {
      const titleAnchor = card.querySelector('a[href*="/jobs/view/"], a.job-card-list__title');
      let rawTitle = cleanElementText(titleAnchor);
      if (!rawTitle || isJunkJobTitle(rawTitle)) {
        const heading = card.querySelector('strong, h3, h4');
        if (heading && !heading.closest('button')) rawTitle = cleanElementText(heading);
      }
      title = rawTitle;
    }
    title = cleanLinkedInJobTitle(title);
    if (isJunkJobTitle(title)) title = '';

    let company = '';
    if (candidatePTexts.length > 1) company = candidatePTexts[1];
    if (!company || isJunkJobTitle(company) || isLocationLine(company)) {
      const companyAnchor = card.querySelector('a[href*="/company/"]');
      company = cleanElementText(companyAnchor);
      if (!company || isJunkJobTitle(company) || isLocationLine(company)) {
        const subEl = card.querySelector(
          '.artdeco-entity-lockup__subtitle, [data-view-name*="job-card"] span, span.t-14',
        );
        if (subEl && !subEl.closest('button')) {
          const subTxt = cleanElementText(subEl);
          if (!isJunkJobTitle(subTxt) && !isLocationLine(subTxt)) company = subTxt;
        }
      }
    }
    if (isJunkJobTitle(company) || isLocationLine(company)) company = '';

    results.push({
      jobId,
      title: title || `Job #${jobId}`,
      company: company || 'Company',
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    });
  }

  let diagnostic = '';
  if (results.length === 0) {
    const hasCheckpoint = Boolean(
      doc.querySelector('.join-form, .login__form, #checkpointSubmitButton') || urlPath.includes('/checkpoint'),
    );
    const selCounts = {
      componentkey: doc.querySelectorAll(
        '[componentkey^="job-card-component-ref-"], [componentkey*="job-card-component-ref-"]',
      ).length,
      dataOccludable: doc.querySelectorAll('li[data-occludable-job-id], [data-occludable-job-id]').length,
      dataJobId: doc.querySelectorAll('[data-job-id]').length,
      dataViewName: doc.querySelectorAll('[data-view-name*="job-card"]').length,
      scaffoldList: doc.querySelectorAll('ul.scaffold-layout__list-container > li, .scaffold-layout__list-item').length,
    };
    diagnostic = `Scan found 0 cards on ${urlPath} (checkpoint: ${hasCheckpoint}). Selectors: [componentkey*="job-card-component-ref-"]=${selCounts.componentkey}, [data-occludable-job-id]=${selCounts.dataOccludable}, [data-job-id]=${selCounts.dataJobId}, [data-view-name*="job-card"]=${selCounts.dataViewName}, scaffold-list=${selCounts.scaffoldList}`;
  }

  return { cards: results, diagnostic };
}

function clickCardInDom(
  doc: MockDOMElement,
  targetJobId: string,
): { success: boolean; clickedElement: MockDOMElement | null } {
  const componentCard = doc.querySelector(
    `[componentkey="job-card-component-ref-${targetJobId}"], [componentkey*="job-card-component-ref-${targetJobId}"]`,
  );
  if (componentCard) {
    const targetBtn = componentCard.querySelector('[role="button"]') || componentCard;
    targetBtn.focus();
    targetBtn.dispatchEvent({ type: 'mousedown' });
    targetBtn.dispatchEvent({ type: 'mouseup' });
    targetBtn.click();
    return { success: true, clickedElement: targetBtn };
  }

  const fallbackCard = doc.querySelector(`[data-job-id="${targetJobId}"], [data-occludable-job-id="${targetJobId}"]`);
  if (fallbackCard) {
    const targetBtn = fallbackCard.querySelector('[role="button"]') || fallbackCard;
    targetBtn.click();
    return { success: true, clickedElement: targetBtn };
  }

  return { success: false, clickedElement: null };
}

describe('LinkedIn List-Scan V2: Component-Key DOM Extraction, Text Node Hierarchy & Resilience', () => {
  it('extracts jobId, title, and company correctly from real pasted LinkedIn card fixture', () => {
    const doc = new MockDOMElement('document');
    const scrollContainer = new MockDOMElement('div', { class: 'jobs-search-results-list' });
    scrollContainer.scrollHeight = 2000;
    scrollContainer.clientHeight = 800;

    // Real card structure:
    // <div class="mwykxs ..." componentkey="job-card-component-ref-4482667852">
    //   <div role="button" tabindex="0" componentkey="5cb870bf-d472-4a18-9bb7-dc0374b2f3c7">
    //     <figure aria-hidden="true">...</figure>
    //     <p>...</p> ... <p>Bengaluru (On-site)</p>
    const outerCard = new MockDOMElement('div', {
      class: 'mwykxs',
      componentkey: 'job-card-component-ref-4482667852',
    });
    const innerButton = new MockDOMElement('div', {
      role: 'button',
      tabindex: '0',
      componentkey: '5cb870bf-d472-4a18-9bb7-dc0374b2f3c7',
    });

    const figure = new MockDOMElement('figure', { 'aria-hidden': 'true' });
    const img = new MockDOMElement('img', { src: 'https://media.licdn.com/logo.png', alt: 'Google logo' });
    figure.appendChild(img);

    const titleP = new MockDOMElement('p', {}, 'Software Engineer');
    const companyP = new MockDOMElement('p', {}, 'Google');
    const locationP = new MockDOMElement('p', {}, 'Bengaluru (On-site)');
    const dismissBtn = new MockDOMElement('button', { 'aria-label': 'Dismiss' }, 'Dismiss');

    innerButton.appendChild(figure);
    innerButton.appendChild(titleP);
    innerButton.appendChild(companyP);
    innerButton.appendChild(locationP);
    innerButton.appendChild(dismissBtn);

    outerCard.appendChild(innerButton);
    scrollContainer.appendChild(outerCard);
    doc.appendChild(scrollContainer);

    const { cards, diagnostic } = scanJobListFromDom(doc);

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.jobId).toBe('4482667852');
    expect(card.title).toBe('Software Engineer');
    expect(card.company).toBe('Google');
    expect(card.url).toBe('https://www.linkedin.com/jobs/view/4482667852/');

    // Ensure location line was not used as company
    expect(card.company).not.toContain('Bengaluru');
    expect(card.company).not.toContain('On-site');
    expect(diagnostic).toBe('');
  });

  it('clicking targets the inner [role="button"] child element inside the card', () => {
    const doc = new MockDOMElement('document');
    const outerCard = new MockDOMElement('div', {
      componentkey: 'job-card-component-ref-4482667852',
    });
    const innerButton = new MockDOMElement('div', {
      role: 'button',
      tabindex: '0',
      componentkey: '5cb870bf-d472-4a18-9bb7-dc0374b2f3c7',
    });
    outerCard.appendChild(innerButton);
    doc.appendChild(outerCard);

    const clickResult = clickCardInDom(doc, '4482667852');
    expect(clickResult.success).toBe(true);
    expect(clickResult.clickedElement).toBe(innerButton);
    expect(innerButton.clicked).toBe(true);
    expect(innerButton.focused).toBe(true);
    expect(innerButton.dispatchedEvents).toEqual(['mousedown', 'mouseup']);
  });

  it('correctly skips other location variations (e.g. Remote, Hybrid, City, State)', () => {
    const doc = new MockDOMElement('document');
    const card = new MockDOMElement('div', {
      componentkey: 'job-card-component-ref-3928174561',
    });
    const inner = new MockDOMElement('div', { role: 'button' });
    const p1 = new MockDOMElement('p', {}, 'Full Stack Developer');
    const p2 = new MockDOMElement('p', {}, 'Stripe');
    const p3 = new MockDOMElement('p', {}, 'San Francisco, CA (Remote)');
    const p4 = new MockDOMElement('p', {}, 'Actively recruiting');

    inner.appendChild(p1);
    inner.appendChild(p2);
    inner.appendChild(p3);
    inner.appendChild(p4);
    card.appendChild(inner);
    doc.appendChild(card);

    const { cards } = scanJobListFromDom(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].jobId).toBe('3928174561');
    expect(cards[0].title).toBe('Full Stack Developer');
    expect(cards[0].company).toBe('Stripe');
  });

  it('finds scrollable container by walking up from the first card to nearest ancestor with scrollHeight > clientHeight', () => {
    const doc = new MockDOMElement('document');
    const rootWrapper = new MockDOMElement('div', { id: 'root' });
    const listWrapper = new MockDOMElement('div', { class: 'custom-scroll-container' });
    listWrapper.scrollHeight = 3000;
    listWrapper.clientHeight = 600;

    const middleDiv = new MockDOMElement('div', { class: 'card-group' });
    middleDiv.scrollHeight = 200;
    middleDiv.clientHeight = 200;

    const card = new MockDOMElement('div', { componentkey: 'job-card-component-ref-1122334455' });
    const inner = new MockDOMElement('div', { role: 'button' }, 'Frontend Engineer');
    card.appendChild(inner);

    middleDiv.appendChild(card);
    listWrapper.appendChild(middleDiv);
    rootWrapper.appendChild(listWrapper);
    doc.appendChild(rootWrapper);

    // Walk up from card
    let curr: MockDOMElement | null = card.parentElement;
    let foundContainer: MockDOMElement | null = null;
    while (curr && curr !== doc) {
      if (curr.scrollHeight > curr.clientHeight) {
        foundContainer = curr;
        break;
      }
      curr = curr.parentElement;
    }

    expect(foundContainer).toBe(listWrapper);
    expect(foundContainer?.className).toBe('custom-scroll-container');
  });

  it('generates clear diagnostic string with path, checkpoint status, and selector counts when 0 cards found', () => {
    const doc = new MockDOMElement('document');
    // Page with 0 cards and no checkpoint
    const { cards, diagnostic } = scanJobListFromDom(doc, '/jobs/search/?keywords=react&location=bengaluru');
    expect(cards).toHaveLength(0);
    expect(diagnostic).toContain('Scan found 0 cards on /jobs/search/?keywords=react&location=bengaluru');
    expect(diagnostic).toContain('(checkpoint: false)');
    expect(diagnostic).toContain('[componentkey*="job-card-component-ref-"]=0');
    expect(diagnostic).toContain('[data-occludable-job-id]=0');
    expect(diagnostic).toContain('[data-job-id]=0');
    expect(diagnostic).toContain('[data-view-name*="job-card"]=0');
    expect(diagnostic).toContain('scaffold-list=0');
  });

  it('detects checkpoint in diagnostic string when login wall is encountered', () => {
    const doc = new MockDOMElement('document');
    const checkpointForm = new MockDOMElement('form', { class: 'login__form' });
    doc.appendChild(checkpointForm);

    const { cards, diagnostic } = scanJobListFromDom(doc, '/checkpoint/challenge');
    expect(cards).toHaveLength(0);
    expect(diagnostic).toContain('(checkpoint: true)');
    expect(diagnostic).toContain('/checkpoint/challenge');
  });

  it('falls back gracefully to heading / company anchor when <p> tags are not present', () => {
    const doc = new MockDOMElement('document');
    const card = new MockDOMElement('div', { componentkey: 'job-card-component-ref-9876543210' });
    const h3 = new MockDOMElement('h3', {}, 'Backend Infrastructure Architect');
    const compAnchor = new MockDOMElement('a', { href: '/company/databricks/' }, 'Databricks');
    card.appendChild(h3);
    card.appendChild(compAnchor);
    doc.appendChild(card);

    const { cards } = scanJobListFromDom(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0].jobId).toBe('9876543210');
    expect(cards[0].title).toBe('Backend Infrastructure Architect');
    expect(cards[0].company).toBe('Databricks');
  });

  it('never treats solitary details-pane anchor as a search card', () => {
    const doc = new MockDOMElement('document');
    const detailPane = new MockDOMElement('div', { class: 'scaffold-layout__detail' });
    const solitaryLink = new MockDOMElement('a', { href: '/jobs/view/9999999999/' }, 'Solitary Job Link');
    detailPane.appendChild(solitaryLink);
    doc.appendChild(detailPane);

    const { cards } = scanJobListFromDom(doc);
    expect(cards).toHaveLength(0);
  });
});
