import 'webextension-polyfill';
import {
  connect,
  ExtensionTransport,
  type HTTPRequest,
  type HTTPResponse,
  type ProtocolType,
  type KeyInput,
} from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { Browser } from 'puppeteer-core/lib/esm/puppeteer/api/Browser.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Frame } from 'puppeteer-core/lib/esm/puppeteer/api/Frame.js';
import {
  getClickableElements as _getClickableElements,
  removeHighlights as _removeHighlights,
  getScrollInfo as _getScrollInfo,
} from './dom/service';
import { DOMElementNode, type DOMState } from './dom/views';
import { type BrowserContextConfig, DEFAULT_BROWSER_CONTEXT_CONFIG, type PageState, URLNotAllowedError } from './views';
import { createLogger } from '@src/background/log';
import { ClickableElementProcessor } from './dom/clickable/service';
import { isUrlAllowed } from './util';

const logger = createLogger('Page');

export function formatElementNode(node: DOMElementNode | null | undefined): string {
  if (!node) return '[unknown element]';
  const idx = node.highlightIndex !== undefined && node.highlightIndex !== null ? `[#${node.highlightIndex}]` : '';
  const tag = node.tagName ? `<${node.tagName}>` : '<element>';
  const idAttr = node.attributes?.id ? ` id="${node.attributes.id}"` : '';
  const nameAttr = node.attributes?.name ? ` name="${node.attributes.name}"` : '';
  const roleAttr = node.attributes?.role ? ` role="${node.attributes.role}"` : '';
  const ariaLabel = node.attributes?.['aria-label'] ? ` aria-label="${node.attributes['aria-label']}"` : '';
  const classAttr = node.attributes?.class ? ` class="${node.attributes.class.split(' ').slice(0, 2).join(' ')}"` : '';
  return `${idx} ${tag}${idAttr}${nameAttr}${roleAttr}${ariaLabel}${classAttr}`.trim();
}

export function build_initial_state(tabId?: number, url?: string, title?: string): PageState {
  return {
    elementTree: new DOMElementNode({
      tagName: 'root',
      isVisible: true,
      parent: null,
      xpath: '',
      attributes: {},
      children: [],
    }),
    selectorMap: new Map(),
    tabId: tabId || 0,
    url: url || '',
    title: title || '',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 0,
    visualViewportHeight: 0,
  };
}

/**
 * Cached clickable elements hashes for the last state
 */
export class CachedStateClickableElementsHashes {
  url: string;
  hashes: Set<string>;

  constructor(url: string, hashes: Set<string>) {
    this.url = url;
    this.hashes = hashes;
  }
}

export default class Page {
  private _tabId: number;
  private _browser: Browser | null = null;
  private _puppeteerPage: PuppeteerPage | null = null;
  private _config: BrowserContextConfig;
  private _state: PageState;
  private _cachedState: PageState | null = null;
  private _cachedStateClickableElementsHashes: CachedStateClickableElementsHashes | null = null;

  constructor(tabId: number, url: string, title: string, config: Partial<BrowserContextConfig> = {}) {
    this._tabId = tabId;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._state = build_initial_state(tabId, url, title);
  }

  get tabId(): number {
    return this._tabId;
  }

  get validWebPage(): boolean {
    const currentUrl = (this._puppeteerPage?.url() || this._state.url || '').trim().toLowerCase();
    return (
      Boolean(this._tabId) &&
      currentUrl.startsWith('http') &&
      !currentUrl.startsWith('https://chromewebstore.google.com')
    );
  }

  get attached(): boolean {
    return this.validWebPage && this._puppeteerPage !== null;
  }

  get puppeteerPage(): PuppeteerPage | null {
    return this._puppeteerPage;
  }

  async attachPuppeteer(): Promise<boolean> {
    try {
      const tab = await chrome.tabs.get(this._tabId);
      const targetUrl = tab?.url || (tab as any)?.pendingUrl;
      if (targetUrl) {
        this._state.url = targetUrl;
        this._state.title = tab?.title || '';
      }
    } catch {
      // Tab may not be available yet
    }

    if (!this.validWebPage) {
      return false;
    }

    if (this._puppeteerPage) {
      return true;
    }

    try {
      logger.info('attaching puppeteer', this._tabId);
      const browser = await connect({
        transport: await ExtensionTransport.connectTab(this._tabId),
        defaultViewport: null,
        protocol: 'cdp' as ProtocolType,
      });
      this._browser = browser;

      const allPages = await browser.pages();
      let targetPage = allPages[0];
      for (const p of allPages) {
        const pUrl = p.url();
        if (!pUrl || pUrl.startsWith('chrome-extension://')) continue;
        if (
          this._state.url &&
          (pUrl === this._state.url || this._state.url.includes(pUrl) || pUrl.includes(this._state.url))
        ) {
          targetPage = p;
          break;
        }
        targetPage = p;
      }
      this._puppeteerPage = targetPage;

      // Add anti-detection scripts
      await this._addAntiDetectionScripts();

      return true;
    } catch (err) {
      logger.warning(`Failed to attach puppeteer to tab ${this._tabId} (DevTools or CDP conflict?):`, err);
      return false;
    }
  }

  private async _addAntiDetectionScripts(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    await this._puppeteerPage.evaluateOnNewDocument(`
      // Webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Languages
      // Object.defineProperty(navigator, 'languages', {
      //   get: () => ['en-US']
      // });

      // Plugins
      // Object.defineProperty(navigator, 'plugins', {
      //   get: () => [1, 2, 3, 4, 5]
      // });

      // Chrome runtime
      window.chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Shadow DOM
      (function () {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachShadow(options) {
          return originalAttachShadow.call(this, { ...options, mode: "open" });
        };
      })();
    `);
  }

  async detachPuppeteer(): Promise<void> {
    if (this._browser) {
      await this._browser.disconnect();
      this._browser = null;
      this._puppeteerPage = null;
      // reset the state
      this._state = build_initial_state(this._tabId, this._state.url, this._state.title);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async evaluate<R = any>(pageFunction: any, ...args: any[]): Promise<R> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page not attached');
    }
    return this._puppeteerPage.evaluate(pageFunction, ...args);
  }

  async removeHighlight(): Promise<void> {
    if (this._config.displayHighlights && this.validWebPage) {
      await _removeHighlights(this._tabId);
    }
  }

  async getClickableElements(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    if (!this.validWebPage) {
      return null;
    }
    return _getClickableElements(
      this._tabId,
      this.url(),
      showHighlightElements,
      focusElement,
      this._config.viewportExpansion,
    );
  }

  // Get scroll position information for the current page.
  async getScrollInfo(): Promise<[number, number, number]> {
    if (!this.validWebPage) {
      return [0, 0, 0];
    }
    return _getScrollInfo(this._tabId);
  }

  // Get scroll position information for a specific element.
  async getElementScrollInfo(elementNode: DOMElementNode): Promise<[number, number, number]> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const element = await this.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${formatElementNode(elementNode)} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await this._findNearestScrollableElement(element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${formatElementNode(elementNode)}`);
    }

    const scrollInfo = await scrollableElement.evaluate(el => {
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      };
    });

    return [scrollInfo.scrollTop, scrollInfo.clientHeight, scrollInfo.scrollHeight];
  }

  /**
   * Find the nearest scrollable ancestor of the given element
   * @param element The element to start searching from
   * @returns The nearest scrollable ancestor or null if none found
   */
  private async _findNearestScrollableElement(element: ElementHandle): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      return null;
    }

    // Check if the current element is scrollable
    const isScrollable = await element.evaluate((el: Element) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
      const canScrollVertically =
        style.overflowY === 'scroll' ||
        style.overflowY === 'auto' ||
        style.overflow === 'scroll' ||
        style.overflow === 'auto';

      return hasVerticalScrollbar && canScrollVertically;
    });

    if (isScrollable) {
      return element;
    }

    // Check parent elements
    let currentElement: ElementHandle<Element> | null = element;

    try {
      while (currentElement) {
        // Get the parent element (as an ElementHandle) of the current element
        const parentHandle = (await currentElement.evaluateHandle(
          (el: Element) => el.parentElement,
        )) as ElementHandle<Element> | null;

        const parentElement = parentHandle ? await parentHandle.asElement() : null;

        if (!parentElement) {
          // Reached the root without finding a scrollable ancestor
          currentElement = null;
          break;
        }

        const parentIsScrollable = await parentElement.evaluate((el: Element) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
          const canScrollVertically =
            ['scroll', 'auto'].includes(style.overflowY) || ['scroll', 'auto'].includes(style.overflow);

          return hasVerticalScrollbar && canScrollVertically;
        });

        if (parentIsScrollable) {
          // Found a scrollable ancestor – return it (the caller should dispose when finished)
          return parentElement;
        }

        // Move up the DOM tree – dispose the previous element handle before continuing
        if (currentElement !== element) {
          try {
            await currentElement.dispose();
          } catch (disposeErr) {
            logger.debug('Failed to dispose element handle:', disposeErr);
          }
        }

        currentElement = parentElement;
      }
    } catch (error) {
      // Error accessing parent, break out of loop
      logger.error('Error finding scrollable parent:', error);
    }

    // If no scrollable ancestor found, return the document body or documentElement
    try {
      const bodyElement = await this._puppeteerPage.$('body');
      if (bodyElement) {
        const bodyIsScrollable = await bodyElement.evaluate(el => {
          if (!(el instanceof HTMLElement)) return false;
          return el.scrollHeight > el.clientHeight;
        });
        if (bodyIsScrollable) {
          return bodyElement;
        }
      }

      // Last resort: return document element for page-level scrolling
      const documentElement = await this._puppeteerPage.evaluateHandle(() => document.documentElement);
      const docElement = (await documentElement.asElement()) as ElementHandle<Element> | null;
      return docElement;
    } catch (error) {
      logger.error('Failed to find scrollable element:', error);
      return null;
    }
  }

  async getContent(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return await this._puppeteerPage.content();
  }

  getCachedState(): PageState | null {
    return this._cachedState;
  }

  async getState(useVision = false, cacheClickableElementsHashes = false): Promise<PageState> {
    if (!this.validWebPage) {
      // return the initial state
      return build_initial_state(this._tabId);
    }
    await this.waitForPageAndFramesLoad();
    const updatedState = await this._updateState(useVision);

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // If we are on the same url as the last state, we can use the cached hashes
      if (
        this._cachedStateClickableElementsHashes &&
        this._cachedStateClickableElementsHashes.url === updatedState.url
      ) {
        // Get clickable elements from the updated state
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree);

        // Mark elements as new if they weren't in the previous state
        for (const domElement of updatedStateClickableElements) {
          const hash = await ClickableElementProcessor.hashDomElement(domElement);
          domElement.isNew = !this._cachedStateClickableElementsHashes.hashes.has(hash);
        }
      }

      // In any case, we need to cache the new hashes
      const newHashes = await ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree);
      this._cachedStateClickableElementsHashes = new CachedStateClickableElementsHashes(updatedState.url, newHashes);
    }

    // Save the updated state as the cached state
    this._cachedState = updatedState;

    return updatedState;
  }

  async _updateState(useVision = false, focusElement = -1): Promise<PageState> {
    try {
      // Test if page is still accessible
      // @ts-expect-error - puppeteerPage is not null, already checked before calling this function
      await this._puppeteerPage.evaluate('1');
    } catch (error) {
      logger.warning('Current page is no longer accessible:', error);
      if (this._browser) {
        const pages = await this._browser.pages();
        if (pages.length > 0) {
          this._puppeteerPage = pages[0];
        } else {
          throw new Error('Browser closed: no valid pages available');
        }
      }
    }

    try {
      await this.removeHighlight();

      // Get DOM content (equivalent to dom_service.get_clickable_elements)
      // This part would need to be implemented based on your DomService logic
      // showHighlightElements is true if either useVision or displayHighlights is true
      const displayHighlights = this._config.displayHighlights || useVision;
      const content = await this.getClickableElements(displayHighlights, focusElement);
      if (!content) {
        logger.warning('Failed to get clickable elements');
        // Return last known good state if available
        return this._state;
      }
      // log the attributes of content object
      if ('selectorMap' in content) {
        logger.debug('content.selectorMap:', content.selectorMap.size);
      } else {
        logger.debug('content.selectorMap: not found');
      }
      if ('elementTree' in content) {
        logger.debug('content.elementTree:', content.elementTree?.tagName);
      } else {
        logger.debug('content.elementTree: not found');
      }

      // Take screenshot if needed
      const screenshot = useVision ? await this.takeScreenshot() : null;
      const [scrollY, visualViewportHeight, scrollHeight] = await this.getScrollInfo();

      // update the state
      this._state.elementTree = content.elementTree;
      this._state.selectorMap = content.selectorMap;
      this._state.url = this._puppeteerPage?.url() || '';
      this._state.title = (await this._puppeteerPage?.title()) || '';
      this._state.screenshot = screenshot;
      this._state.scrollY = scrollY;
      this._state.visualViewportHeight = visualViewportHeight;
      this._state.scrollHeight = scrollHeight;
      return this._state;
    } catch (error) {
      logger.error('Failed to update state:', error);
      // Return last known good state if available
      return this._state;
    }
  }

  async takeScreenshot(fullPage = false): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    try {
      // First disable animations/transitions
      await this._puppeteerPage.evaluate(() => {
        const styleId = 'puppeteer-disable-animations';
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = `
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.appendChild(style);
        }
      });

      // Take the screenshot using JPEG format with 80% quality
      const screenshot = await this._puppeteerPage.screenshot({
        fullPage: fullPage,
        encoding: 'base64',
        type: 'jpeg',
        quality: 80, // Good balance between quality and file size
      });

      // Clean up the style element
      await this._puppeteerPage.evaluate(() => {
        const style = document.getElementById('puppeteer-disable-animations');
        if (style) {
          style.remove();
        }
      });

      return screenshot as string;
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      throw error;
    }
  }

  url(): string {
    if (this._puppeteerPage) {
      return this._puppeteerPage.url();
    }
    return this._state.url;
  }

  async title(): Promise<string> {
    if (this._puppeteerPage) {
      return await this._puppeteerPage.title();
    }
    return this._state.title;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    logger.info('navigateTo', url);

    // Check if URL is allowed
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goto(url)]);
      logger.info('navigateTo complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Navigation failed:', error);
      throw error;
    }
  }

  async refreshPage(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.reload()]);
      logger.info('Page refresh complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Refresh timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Page refresh failed:', error);
      throw error;
    }
  }

  async goBack(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goBack()]);
      logger.info('Navigation back completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Back navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate back:', error);
      throw error;
    }
  }

  async goForward(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goForward()]);
      logger.info('Navigation forward completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Forward navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate forward:', error);
      throw error;
    }
  }

  /**
   * Discovers scrollable modal container if a modal is currently open.
   */
  private async _getModalScrollContainer(): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) return null;
    try {
      const handle = await this._puppeteerPage.evaluateHandle(() => {
        function findModalContainer(root: Document | ShadowRoot | Element): HTMLElement | null {
          const selectors = [
            '.jobs-easy-apply-modal',
            '.artdeco-modal__content',
            'div[role="dialog"] .artdeco-modal__content',
            'div[role="dialog"]',
            'dialog[open]',
            '.modal-body',
            '[aria-modal="true"]',
          ];
          for (const sel of selectors) {
            const el = (root as Element).querySelector
              ? ((root as Element).querySelector(sel) as HTMLElement | null)
              : null;
            if (el) {
              const content = (el.querySelector('.artdeco-modal__content') ||
                el.querySelector('.artdeco-modal__content--has-footer') ||
                el) as HTMLElement;
              if (content && content.scrollHeight > content.clientHeight) return content;
              if (el.scrollHeight > el.clientHeight) return el;
            }
          }
          const all = (root as Element).querySelectorAll ? (root as Element).querySelectorAll('*') : [];
          for (let i = 0; i < all.length; i++) {
            const child = all[i];
            if (child.shadowRoot) {
              const found = findModalContainer(child.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }
        return findModalContainer(document);
      });
      const el = handle.asElement();
      return (el as ElementHandle) || null;
    } catch {
      return null;
    }
  }

  // scroll to a percentage of the page or element
  // if yPercent is 0, scroll to the top of the page, if 100, scroll to the bottom of the page
  // if elementNode is provided, scroll to a percentage of the element
  // if elementNode is not provided, scroll to a percentage of the page or active modal
  async scrollToPercent(yPercent: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      const modalContainer = await this._getModalScrollContainer();
      if (modalContainer) {
        await modalContainer.evaluate((el, yPercent) => {
          const scrollHeight = el.scrollHeight;
          const viewportHeight = el.clientHeight;
          const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
          el.scrollTo({ top: scrollTop, left: el.scrollLeft, behavior: 'smooth' });
        }, yPercent);
        return;
      }
      await this._puppeteerPage.evaluate(yPercent => {
        const scrollHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        window.scrollTo({
          top: scrollTop,
          left: window.scrollX,
          behavior: 'smooth',
        });
      }, yPercent);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${formatElementNode(elementNode)} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${formatElementNode(elementNode)}`);
      }

      await scrollableElement.evaluate((el, yPercent) => {
        const scrollHeight = el.scrollHeight;
        const viewportHeight = el.clientHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        el.scrollTo({
          top: scrollTop,
          left: el.scrollLeft,
          behavior: 'smooth',
        });
      }, yPercent);
    }
  }

  async scrollBy(y: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      const modalContainer = await this._getModalScrollContainer();
      if (modalContainer) {
        await modalContainer.evaluate((el, y) => {
          el.scrollBy({ top: y, left: 0, behavior: 'smooth' });
        }, y);
        return;
      }
      await this._puppeteerPage.evaluate(y => {
        window.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      }, y);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${formatElementNode(elementNode)} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${formatElementNode(elementNode)}`);
      }
      await scrollableElement.evaluate(el => {
        el.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      });
    }
  }

  async scrollToPreviousPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      const modalContainer = await this._getModalScrollContainer();
      if (modalContainer) {
        await modalContainer.evaluate(el => {
          el.scrollBy({ top: -el.clientHeight, left: 0, behavior: 'smooth' });
        });
        return;
      }
      // Scroll the whole page up by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, -(window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element up by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${formatElementNode(elementNode)} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${formatElementNode(elementNode)}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, -el.clientHeight);
      });
    }
  }

  async scrollToNextPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      const modalContainer = await this._getModalScrollContainer();
      if (modalContainer) {
        await modalContainer.evaluate(el => {
          el.scrollBy({ top: el.clientHeight, left: 0, behavior: 'smooth' });
        });
        return;
      }
      // Scroll the whole page down by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, (window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element down by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${formatElementNode(elementNode)} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${formatElementNode(elementNode)}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, el.clientHeight);
      });
    }
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // Split combination keys (e.g., "Control+A" or "Shift+ArrowLeft")
    const keyParts = keys.split('+');
    const modifiers = keyParts.slice(0, -1);
    const mainKey = keyParts[keyParts.length - 1];

    // Press modifiers and main key, ensure modifiers are released even if an error occurs.
    try {
      // Press all modifier keys (e.g., Control, Shift, etc.)
      for (const modifier of modifiers) {
        await this._puppeteerPage.keyboard.down(this._convertKey(modifier));
      }
      // Press the main key
      // also wait for stable state
      await Promise.all([
        this._puppeteerPage.keyboard.press(this._convertKey(mainKey)),
        this.waitForPageAndFramesLoad(),
      ]);
      logger.info('sendKeys complete', keys);
    } catch (error) {
      logger.error('Failed to send keys:', error);
      throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Release all modifier keys in reverse order regardless of any errors in key press.
      for (const modifier of [...modifiers].reverse()) {
        try {
          await this._puppeteerPage.keyboard.up(this._convertKey(modifier));
        } catch (releaseError) {
          logger.error('Failed to release modifier:', modifier, releaseError);
        }
      }
    }
  }

  private _convertKey(key: string): KeyInput {
    const lowerKey = key.trim().toLowerCase();
    const isMac = navigator.userAgent.toLowerCase().includes('mac os x');

    if (isMac) {
      if (lowerKey === 'control' || lowerKey === 'ctrl') {
        return 'Meta' as KeyInput; // Use Command key on Mac
      }
      if (lowerKey === 'command' || lowerKey === 'cmd') {
        return 'Meta' as KeyInput; // Map Command/Cmd to Meta on Mac
      }
      if (lowerKey === 'option' || lowerKey === 'opt') {
        return 'Alt' as KeyInput; // Map Option/Opt to Alt on Mac
      }
    }

    const keyMap: { [key: string]: string } = {
      // Letters
      a: 'KeyA',
      b: 'KeyB',
      c: 'KeyC',
      d: 'KeyD',
      e: 'KeyE',
      f: 'KeyF',
      g: 'KeyG',
      h: 'KeyH',
      i: 'KeyI',
      j: 'KeyJ',
      k: 'KeyK',
      l: 'KeyL',
      m: 'KeyM',
      n: 'KeyN',
      o: 'KeyO',
      p: 'KeyP',
      q: 'KeyQ',
      r: 'KeyR',
      s: 'KeyS',
      t: 'KeyT',
      u: 'KeyU',
      v: 'KeyV',
      w: 'KeyW',
      x: 'KeyX',
      y: 'KeyY',
      z: 'KeyZ',

      // Numbers
      '0': 'Digit0',
      '1': 'Digit1',
      '2': 'Digit2',
      '3': 'Digit3',
      '4': 'Digit4',
      '5': 'Digit5',
      '6': 'Digit6',
      '7': 'Digit7',
      '8': 'Digit8',
      '9': 'Digit9',

      // Special keys
      control: 'Control',
      shift: 'Shift',
      alt: 'Alt',
      meta: 'Meta',
      enter: 'Enter',
      backspace: 'Backspace',
      delete: 'Delete',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      escape: 'Escape',
      tab: 'Tab',
      space: 'Space',
    };

    const convertedKey = keyMap[lowerKey] || key;
    logger.info('convertedKey', convertedKey);
    return convertedKey as KeyInput;
  }

  async scrollToText(text: string, nth: number = 1): Promise<boolean> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Convert text to lowercase for consistent searching
      const lowerCaseText = text.toLowerCase();

      // Try different locator strategies to find all elements containing the text
      const selectors = [
        // Using text selector (equivalent to get_by_text) - for exact text match
        `::-p-text(${text})`,
        // Using XPath selector (contains text) - case insensitive
        `::-p-xpath(//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerCaseText}')])`,
      ];

      for (const selector of selectors) {
        try {
          // Use $$ to get all matching elements
          const elements = await this._puppeteerPage.$$(selector);

          if (elements.length > 0) {
            // Find visible elements and select the nth occurrence
            const visibleElements = [];

            for (const element of elements) {
              const isVisible = await element.evaluate(el => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0' &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              });

              if (isVisible) {
                visibleElements.push(element);
              }
            }

            // Check if we have enough visible elements for the requested nth occurrence
            if (visibleElements.length >= nth) {
              const targetElement = visibleElements[nth - 1]; // Convert to 0-indexed
              await this._scrollIntoViewIfNeeded(targetElement);
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete

              // Dispose of all element handles to prevent memory leaks
              for (const element of elements) {
                await element.dispose();
              }

              return true;
            }
          }

          // Dispose of all element handles to prevent memory leaks
          for (const element of elements) {
            await element.dispose();
          }
        } catch (e) {
          logger.debug(`Locator attempt failed: ${e}`);
        }
      }
      return false;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async getDropdownOptions(index: number): Promise<Array<{ index: number; text: string; value: string }>> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error('Dropdown element not found');
      }

      // Evaluate the select element to get all options
      const options = await elementHandle.evaluate(select => {
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Element is not a select element');
        }

        return Array.from(select.options).map(option => ({
          index: option.index,
          text: option.text, // Not trimming to maintain exact match for selection
          value: option.value,
        }));
      });

      if (!options.length) {
        throw new Error('No options found in dropdown');
      }

      return options;
    } catch (error) {
      throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async selectDropdownOption(index: number, text: string): Promise<string> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    logger.debug(`Attempting to select '${text}' from dropdown`);
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    // Validate that we're working with a select element
    if (element.tagName?.toLowerCase() !== 'select') {
      const msg = `Cannot select option: Element with index ${index} is a ${element.tagName}, not a SELECT`;
      logger.error(msg);
      throw new Error(msg);
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }

      // Verify dropdown and select option in one call
      const result = await elementHandle.evaluate(
        (select, optionText, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            return {
              found: false,
              message: `Element with index ${elementIndex} is not a SELECT`,
            };
          }

          const options = Array.from(select.options);
          const option = options.find(opt => opt.text.trim() === optionText);

          if (!option) {
            const availableOptions = options.map(o => o.text.trim()).join('", "');
            return {
              found: false,
              message: `Option "${optionText}" not found in dropdown element with index ${elementIndex}. Available options: "${availableOptions}"`,
            };
          }

          // Set the value and dispatch events
          const previousValue = select.value;
          select.value = option.value;

          // Only dispatch events if the value actually changed
          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
          }

          return {
            found: true,
            message: `Selected option "${optionText}" with value "${option.value}"`,
          };
        },
        text,
        index,
      );

      logger.debug('Selection result:', result);
      // whether found or not, return the message
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async locateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      logger.warning('Puppeteer is not connected');
      return null;
    }
    let currentFrame: PuppeteerPage | Frame = this._puppeteerPage;

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = [];
    let current = element;
    while (current.parent) {
      parents.push(current.parent);
      current = current.parent;
    }

    // Process all iframe parents in sequence (in reverse order - top to bottom)
    const iframes = parents.reverse().filter(item => item.tagName === 'iframe');
    for (const parent of iframes) {
      const cssSelector = parent.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
      const frameElement: ElementHandle | null = await currentFrame.$(cssSelector);
      if (!frameElement) {
        logger.warning(`Could not find iframe with selector: ${cssSelector}`);
        return null;
      }
      const frame: Frame | null = await frameElement.contentFrame();
      if (!frame) {
        logger.warning(`Could not access frame content for selector: ${cssSelector} (cross-origin or blocked)`);
        return null;
      }
      currentFrame = frame;
      logger.info('currentFrame changed', currentFrame);
    }

    // Step 1: Shadow-piercing lookup by unique data-nanobrowser-id stamped during DOM tree extraction
    if (element.highlightIndex !== undefined && element.highlightIndex !== null) {
      try {
        const handle = await currentFrame.evaluateHandle(idx => {
          function searchRoot(root: Node | ShadowRoot): Element | null {
            if (!root) return null;
            if ((root as Element).querySelector) {
              const el = (root as Element).querySelector(`[data-nanobrowser-id="${idx}"]`);
              if (el) return el;
            }
            const all = (root as Element).querySelectorAll ? (root as Element).querySelectorAll('*') : [];
            for (let i = 0; i < all.length; i++) {
              const child = all[i];
              if (child.shadowRoot) {
                const found = searchRoot(child.shadowRoot);
                if (found) return found;
              }
            }
            return null;
          }
          return searchRoot(document.body || document.documentElement);
        }, element.highlightIndex);

        const elHandle = handle.asElement() as ElementHandle<Element> | null;
        if (elHandle) {
          const isHidden = await elHandle.isHidden().catch(() => false);
          if (!isHidden) {
            await this._scrollIntoViewIfNeeded(elHandle).catch(() => {});
          }
          return elHandle;
        }
      } catch (err) {
        logger.debug('Shadow-piercing data-nanobrowser-id search failed:', err);
      }
    }

    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);

    try {
      // Step 2: Try CSS selector directly on frame
      let elementHandle: ElementHandle | null = await currentFrame.$(cssSelector);

      // Step 3: If CSS selector failed, search across open shadow roots using selector
      if (!elementHandle && cssSelector) {
        try {
          const handle = await currentFrame.evaluateHandle(sel => {
            function searchShadowWithSelector(root: Node | ShadowRoot): Element | null {
              if (!root) return null;
              try {
                if ((root as Element).querySelector) {
                  const el = (root as Element).querySelector(sel);
                  if (el) return el;
                }
              } catch {}
              const all = (root as Element).querySelectorAll ? (root as Element).querySelectorAll('*') : [];
              for (let i = 0; i < all.length; i++) {
                const child = all[i];
                if (child.shadowRoot) {
                  const found = searchShadowWithSelector(child.shadowRoot);
                  if (found) return found;
                }
              }
              return null;
            }
            return searchShadowWithSelector(document.body || document.documentElement);
          }, cssSelector);

          elementHandle = (handle.asElement() as ElementHandle) || null;
        } catch {}
      }

      // Step 4: If CSS selector failed, try XPath
      if (!elementHandle) {
        const xpath = element.xpath;
        if (xpath) {
          try {
            logger.info('Trying XPath selector:', xpath);
            const fullXpath = xpath.startsWith('/') ? xpath : `/${xpath}`;
            const xpathSelector = `::-p-xpath(${fullXpath})`;
            elementHandle = await currentFrame.$(xpathSelector);
          } catch (xpathError) {
            logger.debug('Failed to locate element using XPath:', xpathError);
          }
        }
      }

      // Step 5: Check if element might be trapped in a closed shadow root or iframe
      if (!elementHandle) {
        const hasClosedShadow = await currentFrame
          .evaluate(() => {
            const customElements = document.querySelectorAll('*');
            for (let i = 0; i < customElements.length; i++) {
              const el = customElements[i];
              if (el.tagName.includes('-') && !el.shadowRoot) {
                return true;
              }
            }
            return false;
          })
          .catch(() => false);
        if (hasClosedShadow) {
          logger.warning(
            `[locateElement] Element "${formatElementNode(element)}" not found. Page contains custom elements with closed/inaccessible shadow roots.`,
          );
        }
      }

      // If element found, check visibility and scroll into view
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden().catch(() => false);
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(elementHandle).catch(() => {});
        }
        return elementHandle;
      }

      logger.info(`elementHandle not located for: ${formatElementNode(element)}`);
    } catch (error) {
      logger.error('Failed to locate element:', error);
    }

    return null;
  }

  async inputTextElementNode(useVision: boolean, elementNode: DOMElementNode, text: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      let element = await this.locateElement(elementNode);
      if (!element) {
        // Retry once after brief pause
        await new Promise(r => setTimeout(r, 300));
        element = await this.locateElement(elementNode);
      }
      if (!element) {
        throw new Error(`Element: ${formatElementNode(elementNode)} not found`);
      }

      // Ensure element is ready for input
      try {
        // First wait for element stability
        await this._waitForElementStability(element, 1500);

        // Then check visibility and scroll into view if needed
        const isHidden = await element.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(element, 1500);
        }
      } catch (e) {
        // Continue even if these operations fail
        logger.debug(`Non-critical error preparing element: ${e}`);
      }

      // Robust input setting that handles inputs, textareas, contenteditables, and container wrappers (e.g. YouTube searchbox, Google, Flipkart divs)
      await element.evaluate((el, value) => {
        // Find target input element: el itself or nested input/textarea/contenteditable
        let target: HTMLElement | null = null;
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          (el instanceof HTMLElement && el.isContentEditable)
        ) {
          target = el;
        } else {
          // Check shadow root if web component (e.g., ytd-searchbox)
          const shadowRoot = (el as HTMLElement).shadowRoot;
          if (shadowRoot) {
            target = shadowRoot.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
          }
          if (!target) {
            target = el.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]');
          }
        }

        if (!target) {
          target = el as HTMLElement;
        }

        try {
          target.focus();
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            if (target instanceof HTMLInputElement && target.type === 'file') {
              return;
            }
            // Use native prototype setter to ensure React / Angular / Polymer / Vue state updates
            const prototype =
              target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            try {
              if (nativeSetter) {
                nativeSetter.call(target, value);
              } else {
                target.value = value;
              }
            } catch (err) {
              console.warn('[Page] Error setting input value:', err);
              return;
            }

            target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          } else if (target instanceof HTMLElement && target.isContentEditable) {
            target.textContent = value;
            target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
        } catch (e) {
          console.error('Failed to set input value directly:', e);
        }
      }, text);

      // Attempt Puppeteer typing if element or its child is active
      try {
        const canType = await element.evaluate(el => {
          const active = document.activeElement;
          return (
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement ||
            (active as HTMLElement)?.isContentEditable
          );
        });
        if (!canType) {
          // Try clicking the element to focus it, then select all and type
          await element.click().catch(() => {});
          await element.type(text, { delay: 30 }).catch(() => {});
        }
      } catch (typeErr) {
        logger.debug(`Puppeteer type attempt completed or skipped: ${typeErr}`);
      }

      // Wait for page stability after input
      await this.waitForPageAndFramesLoad();
    } catch (error) {
      const errorMsg = `Failed to input text into element: ${formatElementNode(elementNode)}. Error: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  /**
   * Wait for an element to become stable (no position/size changes)
   * Similar to Playwright's wait_for_element_state('stable')
   */
  private async _waitForElementStability(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();
    let lastRect = await element.boundingBox();

    while (Date.now() - startTime < timeout) {
      // Wait a short time
      await new Promise(resolve => setTimeout(resolve, 50));

      // Get current position and size
      const currentRect = await element.boundingBox();

      // If element is no longer in DOM or not visible
      if (!currentRect) {
        break;
      }

      // Compare with previous position/size
      if (
        lastRect &&
        Math.abs(lastRect.x - currentRect.x) < 2 &&
        Math.abs(lastRect.y - currentRect.y) < 2 &&
        Math.abs(lastRect.width - currentRect.width) < 2 &&
        Math.abs(lastRect.height - currentRect.height) < 2
      ) {
        // Position is stable - wait a bit more to be sure and then return
        await new Promise(resolve => setTimeout(resolve, 50));
        return;
      }

      // Update last position
      lastRect = currentRect;
    }

    // If we got here, either the element stabilized or we timed out
    logger.debug('Element stability check completed (timeout or stable)');
  }

  private async _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check if element is in viewport
      const isVisible = await element.evaluate(el => {
        const rect = el.getBoundingClientRect();

        // Check if element has size
        if (rect.width === 0 || rect.height === 0) return false;

        // Check if element is hidden
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return false;
        }

        // Check if element is in viewport
        const isInViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        if (!isInViewport) {
          // Scroll into view if not visible
          el.scrollIntoView({
            behavior: 'auto',
            block: 'center',
            inline: 'center',
          });
          return false;
        }

        return true;
      });

      if (isVisible) break;

      // Check timeout - log warning and return instead of throwing
      if (Date.now() - startTime > timeout) {
        logger.warning('Timed out while trying to scroll element into view, continuing anyway');
        break;
      }

      // Small delay before next check
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async clickElementNode(useVision: boolean, elementNode: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before clicking
      // if (elementNode.highlightIndex !== null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${formatElementNode(elementNode)} not found`);
      }

      // Scroll element into view if needed
      await this._scrollIntoViewIfNeeded(element);

      try {
        // First attempt: Use Puppeteer's click method with timeout
        await Promise.race([
          element.click(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout')), 2000)),
        ]);
        await this._checkAndHandleNavigation();
      } catch (error) {
        // if URLNotAllowedError, throw it
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        // Second attempt: Use evaluate to perform a direct click, with anchor fallback
        logger.info('Failed to click element, trying again', error);
        try {
          await element.evaluate(el => {
            const htmlEl = el as HTMLElement;
            htmlEl.scrollIntoView({ behavior: 'instant', block: 'center' });
            htmlEl.focus();
            const mouseOpts = { bubbles: true, cancelable: true, view: window };
            htmlEl.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
            htmlEl.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
            htmlEl.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
            htmlEl.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
            htmlEl.click();
            const anchor = (
              htmlEl.tagName.toLowerCase() === 'a' ? htmlEl : htmlEl.closest('a') || htmlEl.querySelector('a')
            ) as HTMLAnchorElement | null;
            if (anchor && anchor.href && anchor.href.startsWith('http')) {
              window.location.href = anchor.href;
            }
          });
          await this._checkAndHandleNavigation();
        } catch (secondError) {
          // if URLNotAllowedError, throw it
          if (secondError instanceof URLNotAllowedError) {
            throw secondError;
          }
          throw new Error(
            `Failed to click element: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
          );
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to click element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getSelectorMap(): Map<number, DOMElementNode> {
    // If there is no cached state, return an empty map
    if (this._cachedState === null) {
      return new Map();
    }
    // Otherwise return the cached state's selector map
    return this._cachedState.selectorMap;
  }

  /**
   * Generic Ad Detection & Skip Handler
   * Detects skip buttons (e.g. YouTube, media players, streaming sites, banners) and clicks them.
   * Returns true if an ad skip button was found and clicked.
   */
  async detectAndSkipAd(): Promise<boolean> {
    if (!this._puppeteerPage) {
      return false;
    }

    try {
      const skipped = await this._puppeteerPage.evaluate(() => {
        // 1. Common platform skip ad selectors
        const skipSelectors = [
          '.ytp-ad-skip-button-modern',
          '.ytp-skip-ad-button',
          '.ytp-ad-skip-button',
          '.ytp-ad-skip-button-slot button',
          '.videoAdUiSkipButton',
          '.ytp-ad-overlay-close-button',
          'button.ytp-ad-skip-button',
          'button.ytp-ad-skip-button-modern',
          '[aria-label*="Skip Ad" i]',
          '[aria-label*="Skip ad" i]',
          '[aria-label*="skip advertisement" i]',
          '[data-testid*="skip-ad" i]',
        ];

        for (const selector of skipSelectors) {
          const el = document.querySelector<HTMLElement>(selector);
          if (el && el.offsetParent !== null && !el.hasAttribute('disabled')) {
            el.click();
            return true;
          }
        }

        // 2. Generic pattern matching on button/clickable text
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a'));
        for (const el of candidates) {
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const isSkip =
            text === 'skip' ||
            text === 'skip ad' ||
            text === 'skip ads' ||
            text.startsWith('skip ad in') ||
            aria.includes('skip ad') ||
            aria.includes('skip advertisement');

          if (isSkip && el.offsetParent !== null && !el.hasAttribute('disabled')) {
            el.click();
            return true;
          }
        }

        return false;
      });

      if (skipped) {
        logger.info('🎯 [AdDetector] Generic pattern-matcher detected and clicked an ad skip button');
        await new Promise(r => setTimeout(r, 400));
        return true;
      }
    } catch (e) {
      logger.debug(`[AdDetector] Non-critical error while checking for ads: ${e}`);
    }

    return false;
  }

  /**
   * Pre-Flight Error Interceptor:
   * Detects if the current LinkedIn page is a 404, removed job posting, or invalid page state.
   */
  async detectDeadJobOrErrorPage(): Promise<{ isDeadJob: boolean; reason?: string }> {
    if (!this._puppeteerPage) {
      return { isDeadJob: false };
    }

    try {
      return await this._puppeteerPage.evaluate(() => {
        // Only evaluate on LinkedIn pages
        if (!window.location.hostname.includes('linkedin.com')) {
          return { isDeadJob: false };
        }

        // Dead job pages have distinct global error headers or empty main containers
        const errorContainer = document.querySelector(
          '.artdeco-empty-state, .error-container, #error-page, .jobs-details-error',
        );
        const mainHeading = (document.querySelector('h1, h2')?.textContent || '').toLowerCase();
        const containerText = (errorContainer?.textContent || '').toLowerCase();

        const deadSignatures = [
          'unable to load the page. job id provided may not be valid',
          'job posting has been removed',
          'no longer accepting applications',
          'this job is no longer available',
          'the job you are trying to view is no longer available',
        ];

        for (const sig of deadSignatures) {
          if (mainHeading.includes(sig) || containerText.includes(sig)) {
            return {
              isDeadJob: true,
              reason: sig,
            };
          }
        }

        return { isDeadJob: false };
      });
    } catch {
      return { isDeadJob: false };
    }
  }

  /**
   * Option A: The CAPTCHA & Security Shield (Anomaly Detector)
   * Detects Arkose Labs FunCAPTCHA, reCAPTCHA, Cloudflare challenge, or LinkedIn security verification check.
   */
  async detectCaptchaOrSecurityCheck(): Promise<{ isCaptcha: boolean; type?: string }> {
    if (!this._puppeteerPage) {
      return { isCaptcha: false };
    }

    try {
      const result = await this._puppeteerPage.evaluate(() => {
        const url = window.location.href.toLowerCase();

        // 1. Explicit Checkpoint URLs (LinkedIn, Cloudflare, etc.)
        if (
          url.includes('/checkpoint/challenge') ||
          url.includes('/checkpoint/rp/') ||
          url.includes('/uas/consumer-captcha') ||
          url.includes('challenges.cloudflare.com')
        ) {
          return { isCaptcha: true, type: `Security checkpoint URL (${window.location.pathname})` };
        }

        // Helper: Check if element is genuinely visible and >= 100x100
        function isElementVisibleChallenge(el: Element | null): boolean {
          if (!el) return false;
          // Ignore invisible recaptcha badge container
          if (el.closest('.grecaptcha-badge') || el.classList.contains('grecaptcha-badge')) {
            return false;
          }
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.05) {
            return false;
          }
          const rect = htmlEl.getBoundingClientRect();
          // Must be larger than ~100x100px to be an interactive challenge (not a hidden tracker or badge)
          if (rect.width < 100 || rect.height < 100) {
            return false;
          }
          return true;
        }

        // 2. Specific dedicated CAPTCHA iframe and widget selectors (VISIBLE ONLY)
        const captchaSelectors = [
          'iframe[src*="arkoselabs.com"]',
          'iframe[src*="funcaptcha"]',
          'iframe[src*="recaptcha/api2/bframe"]',
          'iframe[src*="recaptcha/enterprise/bframe"]',
          'iframe[src*="hcaptcha.com"]',
          'iframe[src*="challenges.cloudflare.com"]',
          'form#checkpoint-challenge-form',
          'div#app__container.checkpoint',
          'div#captcha-internal',
          'div.checkpoint-challenge',
        ];

        for (const sel of captchaSelectors) {
          const els = Array.from(document.querySelectorAll(sel));
          for (const el of els) {
            if (isElementVisibleChallenge(el)) {
              return {
                isCaptcha: true,
                type: `Visible challenge widget (${sel}) [${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}]`,
              };
            }
          }
        }

        // 3. Visible text signatures on page
        const textNodes = Array.from(
          document.querySelectorAll('h1, h2, h3, [role="heading"], [role="alert"], p, div.challenge-header'),
        );
        const checkpointPhrases = [
          'quick security check',
          'let us know you are human',
          "let us know you're not a robot",
          'verify you are a human',
          'security verification',
          'please solve this puzzle',
          'unusual traffic from your computer network',
        ];

        for (const node of textNodes) {
          const txt = (node.textContent || '').trim().toLowerCase();
          if (!txt) continue;
          for (const phrase of checkpointPhrases) {
            if (txt.includes(phrase)) {
              const htmlNode = node as HTMLElement;
              const style = window.getComputedStyle(htmlNode);
              if (style.display !== 'none' && style.visibility !== 'hidden' && htmlNode.offsetParent !== null) {
                return { isCaptcha: true, type: `Visible text: "${phrase}"` };
              }
            }
          }
        }

        return { isCaptcha: false };
      });

      if (result.isCaptcha) {
        console.debug(`[CaptchaDetector] Triggered by: ${result.type}`);
      }
      return result;
    } catch {
      return { isCaptcha: false };
    }
  }

  async getElementByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap.get(index);
    if (!element) return null;
    return await this.locateElement(element);
  }

  getDomElementByIndex(index: number): DOMElementNode | null {
    const selectorMap = this.getSelectorMap();
    return selectorMap.get(index) || null;
  }

  isFileUploader(elementNode: DOMElementNode, maxDepth = 3, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    // Check current element
    if (elementNode.tagName === 'input') {
      // Check for file input attributes
      const attributes = elementNode.attributes;
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (attributes['type']?.toLowerCase() === 'file' || !!attributes['accept']) {
        return true;
      }
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if ('tagName' in child) {
          // DOMElementNode type guard
          if (this.isFileUploader(child as DOMElementNode, maxDepth, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async waitForPageLoadState(timeout?: number) {
    const timeoutValue = timeout || 8000;
    await this._puppeteerPage?.waitForNavigation({ timeout: timeoutValue });
  }

  private async _waitForStableNetwork() {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    const RELEVANT_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe']);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

    const IGNORED_URL_PATTERNS = new Set([
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs
      'cloudfront.net',
      'fastly.net',
    ]);

    const pendingRequests = new Set();
    let lastActivity = Date.now();

    const onRequest = (request: HTTPRequest) => {
      // Filter by resource type
      const resourceType = request.resourceType();
      if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio'
      ) {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now();
    };

    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip streaming content
      if (
        ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
          contentType.includes(t),
        )
      ) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip large responses
      const contentLength = response.headers()['content-length'];
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Add event listeners
    this._puppeteerPage.on('request', onRequest);
    this._puppeteerPage.on('response', onResponse);

    try {
      const startTime = Date.now();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const now = Date.now();
        const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

        if (pendingRequests.size === 0 && timeSinceLastActivity >= this._config.waitForNetworkIdlePageLoadTime) {
          break;
        }

        const elapsedTime = (now - startTime) / 1000; // Convert to seconds
        if (elapsedTime > this._config.maximumWaitPageLoadTime) {
          console.debug(
            `Network timeout after ${this._config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
            Array.from(pendingRequests).map(r => (r as HTTPRequest).url()),
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      this._puppeteerPage.off('request', onRequest);
      this._puppeteerPage.off('response', onResponse);
    }
    console.debug(`Network stabilized for ${this._config.waitForNetworkIdlePageLoadTime} seconds`);
  }

  async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = Date.now();

    // Wait for page load
    try {
      await this._waitForStableNetwork();

      // Check if the loaded URL is allowed
      if (this._puppeteerPage) {
        await this._checkAndHandleNavigation();
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }
      console.warn('Page load failed, continuing...', error);
    }

    // Calculate remaining time to meet minimum wait time
    const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
    const minWaitTime = timeoutOverwrite || this._config.minimumWaitPageLoadTime;
    const remaining = Math.max(minWaitTime - elapsed, 0);

    console.debug(
      `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
    }
  }

  /**
   * Check the current page URL and handle if it's not allowed
   * @throws URLNotAllowedError if the current URL is not allowed
   */
  private async _checkAndHandleNavigation(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    const currentUrl = this._puppeteerPage.url();
    if (!isUrlAllowed(currentUrl, this._config.allowedUrls, this._config.deniedUrls)) {
      const errorMessage = `URL: ${currentUrl} is not allowed`;
      logger.error(errorMessage);

      // Navigate to home page or about:blank
      const safeUrl = this._config.homePageUrl || 'about:blank';
      logger.info(`Redirecting to safe URL: ${safeUrl}`);

      try {
        await this._puppeteerPage.goto(safeUrl);
      } catch (error) {
        logger.error(`Failed to redirect to safe URL: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw new URLNotAllowedError(errorMessage);
    }
  }

  /**
   * Fast check to see if the Easy Apply modal is currently open.
   */
  async isEasyApplyModalOpen(): Promise<boolean> {
    const checkInPage = () => {
      function check(root: any): boolean {
        const dialog = root.querySelector
          ? root.querySelector(
              '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal, .artdeco-modal, [role="dialog"], [aria-modal="true"], dialog[open], [data-test-modal]',
            )
          : null;
        if (dialog) return true;
        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.shadowRoot && check(el.shadowRoot)) return true;
        }
        return false;
      }
      return check(document);
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(checkInPage);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: checkInPage,
        });
        return Boolean(results?.[0]?.result);
      } catch {}
    }

    return false;
  }

  /**
   * Clicks the Easy Apply button in the active job details pane.
   * Scoped specifically to details pane in split-view or standalone view.
   */
  async clickEasyApplyButton(): Promise<{ success: boolean; error?: string }> {
    const clickInPage = () => {
      function isVisible(el: HTMLElement): boolean {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function isFilterOrNav(el: HTMLElement): boolean {
        if (!el) return true;
        // Exclude global nav, search header, messaging overlays, and filter dropdowns
        if (
          el.closest(
            'header, nav, #global-nav, .global-nav, .jobs-search-box, .search-reusables__filter-list, .search-reusables__filter-pill-button, .search-reusables__primary-filter, .artdeco-pill, [data-view-name="search-filter-pills"], .scaffold-layout__header, .msg-overlay-container, #msg-overlay',
          )
        ) {
          return true;
        }
        // Exclude left-pane search results list items
        if (el.closest('.jobs-search-results-list, .scaffold-layout__list, ul.scaffold-layout__list-container')) {
          return true;
        }
        if (el.classList.contains('artdeco-pill')) return true;
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const id = (el.getAttribute('id') || '').trim().toLowerCase();
        if (text.includes('filter') || aria.includes('filter') || id.includes('filter')) return true;
        return false;
      }

      function isEasyApplyMatch(btn: HTMLElement): boolean {
        if (isFilterOrNav(btn) || !isVisible(btn)) return false;
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        return (
          btn.classList.contains('jobs-apply-button') ||
          /\beasy\s*apply\b/i.test(text) ||
          /\beasy\s*apply\b/i.test(aria) ||
          btn.querySelector('svg[data-test-icon*="easy-apply"], .jobs-apply-button__label') !== null
        );
      }

      // Find active details container in split view or standalone
      const detailsContainer =
        document.querySelector('.jobs-search__job-details--container') ||
        document.querySelector('.jobs-search__job-details') ||
        document.querySelector('.jobs-details__main-content') ||
        document.querySelector('.scaffold-layout__detail') ||
        document.querySelector('[data-view-name="job-details-top-card"]') ||
        document.querySelector('.jobs-unified-top-card') ||
        document.querySelector('.job-details-jobs-unified-top-card__container--two-pane') ||
        document.querySelector('.job-view-layout');

      const candidateSelectors = [
        'button.jobs-apply-button',
        '.jobs-apply-button--top-card button',
        '.jobs-s-apply button',
        'button.jobs-apply-button--top-card',
        '[data-view-name="job-details-top-card"] button',
        'button[data-control-name="jobdetails_topcard_inapply"]',
        'button[data-live-test-easy-apply-button]',
        'button[data-job-id]',
        'button[aria-label*="Easy Apply" i]',
        'a.jobs-apply-button',
        '[role="button"][aria-label*="Easy Apply" i]',
      ];

      let easyApplyBtn: HTMLElement | null = null;

      // 1. Search inside detailsContainer first
      if (detailsContainer) {
        for (const sel of candidateSelectors) {
          const matches = Array.from(detailsContainer.querySelectorAll(sel)) as HTMLElement[];
          for (const btn of matches) {
            if (isEasyApplyMatch(btn)) {
              easyApplyBtn = btn;
              break;
            }
          }
          if (easyApplyBtn) break;
        }

        // Generic button/a search inside detailsContainer
        if (!easyApplyBtn) {
          const allBtns = Array.from(detailsContainer.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
          for (const btn of allBtns) {
            if (isEasyApplyMatch(btn)) {
              easyApplyBtn = btn;
              break;
            }
          }
        }
      }

      // 2. Global fallback across document
      if (!easyApplyBtn) {
        for (const sel of candidateSelectors) {
          const matches = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          for (const btn of matches) {
            if (isEasyApplyMatch(btn)) {
              easyApplyBtn = btn;
              break;
            }
          }
          if (easyApplyBtn) break;
        }
      }

      // 3. Generic button/a search globally
      if (!easyApplyBtn) {
        const allBtns = Array.from(document.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
        for (const btn of allBtns) {
          if (isEasyApplyMatch(btn)) {
            easyApplyBtn = btn;
            break;
          }
        }
      }

      if (easyApplyBtn) {
        const target = (easyApplyBtn.closest('button, [role="button"], a') || easyApplyBtn) as HTMLElement;
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        target.focus();
        const opts = { bubbles: true, cancelable: true, view: window };
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.click();
        return { clicked: true, reason: '' };
      }
      return { clicked: false, reason: 'Easy Apply button not found in active job details' };
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        const clickResult = await this._puppeteerPage.evaluate(clickInPage);
        return { success: clickResult.clicked, error: clickResult.reason };
      } catch (pErr) {
        logger.debug('[clickEasyApplyButton] Puppeteer click threw, trying chrome.scripting fallback:', pErr);
      }
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: clickInPage,
        });
        const res = results?.[0]?.result;
        if (res) {
          return { success: Boolean(res.clicked), error: res.reason };
        }
      } catch (sErr) {
        logger.debug('[clickEasyApplyButton] chrome.scripting fallback error:', sErr);
      }
    }

    return { success: false, error: 'Could not click Easy Apply button (page context unavailable)' };
  }

  /**
   * Polls up to maxWaitMs (every pollIntervalMs) for the Easy Apply modal.
   * Checks light DOM and open shadow roots (#interop-outlet).
   * Automatically handles known intermediate dialogs:
   *   - "Continue applying?" -> Clicks Continue
   *   - "Job search safety reminder" -> Clicks Continue / Dismiss
   *   - "Save this application?" -> Clicks Discard
   *   - Unknown modal/dialog -> Halts with clear error!
   * Checks if modal is already open before waiting.
   * Provides detailed debug logging of modal and interactive elements.
   */
  async waitForEasyApplyModal(
    maxWaitMs = 5000,
    pollIntervalMs = 250,
  ): Promise<{
    opened: boolean;
    inShadowRoot?: boolean;
    interactiveCount?: number;
    error?: string;
  }> {
    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    const startTime = Date.now();
    let attempt = 0;
    let lastUnknownDialog: string | null = null;

    const checkInPage = () => {
      function inspectRoot(root: any): {
        modalFound: boolean;
        inShadow: boolean;
        dialogTitle?: string;
        isIntermediate?: boolean;
        intermediateAction?: 'continue' | 'safety' | 'discard' | 'unknown';
        inputsCount: number;
        buttonsCount: number;
        hasClosedShadow: boolean;
      } {
        // Helper to ensure an element is a genuine visible modal dialog
        function isGenuineVisibleModal(dialog: HTMLElement): boolean {
          if (!dialog || !dialog.isConnected) return false;

          // Direct match: If it is explicitly marked as the Easy Apply modal, always accept!
          if (
            dialog.classList.contains('jobs-easy-apply-modal') ||
            dialog.querySelector(
              '.jobs-easy-apply-content, [data-easy-apply-modal], form.jobs-easy-apply-form, [data-test-modal-id="easy-apply-modal"]',
            )
          ) {
            const style = window.getComputedStyle(dialog);
            return style.display !== 'none' && style.visibility !== 'hidden';
          }

          // 1. Exclude global navigation, headers, footers, search list, filter list, or messaging docks/flyouts
          if (
            dialog.closest(
              'nav, header, #global-nav, .global-nav, .global-nav__nav, .msg-overlay-container, #msg-overlay, .msg-overlay-bubble-header, .artdeco-dropdown, .artdeco-dropdown__content, .jobs-search-results-list, .scaffold-layout__list, [role="tooltip"], .tooltip, .search-reusables__filter-list, .search-reusables__filter-dropdown, .search-reusables__primary-filter, [data-view-name="search-filter-pills"], .artdeco-pill, .scaffold-layout__header, .jobs-search-box',
            )
          ) {
            return false;
          }

          // Exclude messaging overlay / chat dock specifically
          const aria = (dialog.getAttribute('aria-label') || '').trim().toLowerCase();
          if (
            dialog.classList.contains('msg-overlay-container') ||
            dialog.id.includes('msg-overlay') ||
            /messaging/i.test(aria) ||
            /chat/i.test(aria)
          ) {
            return false;
          }

          // 2. Exclude notification badges, counters, or alert flyouts (e.g. "0 notifications")
          if (
            dialog.classList.contains('notification-badge') ||
            dialog.closest(
              '.notifications-badge, .nav-item--notifications, [data-test-global-nav-link="notifications"]',
            ) ||
            /notifications\s+dialog/i.test(aria) ||
            dialog.id.includes('notifications')
          ) {
            return false;
          }

          // 3. Exclude tooltips, dropdowns, and toast messages
          if (
            dialog.getAttribute('role') === 'tooltip' ||
            dialog.classList.contains('artdeco-toast') ||
            dialog.classList.contains('artdeco-hoverable-content')
          ) {
            return false;
          }

          // 4. Must be genuinely visible (not display: none, visibility: hidden, opacity ~ 0)
          const style = window.getComputedStyle(dialog);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.05) {
            return false;
          }

          // 5. Must have genuine modal dimensions (minimum 200px width, 100px height)
          const rect = dialog.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) {
            return false;
          }

          return true;
        }

        // Check for dialogs (scoped strictly to genuine visible modals)
        const rawDialogs = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                'div.jobs-easy-apply-modal, div[data-test-modal], div.artdeco-modal, dialog[open], div[role="dialog"], [aria-modal="true"]',
              ),
            ) as HTMLElement[])
          : [];

        const dialogs = rawDialogs.filter(isGenuineVisibleModal);

        // Pass 1: Direct check for Easy Apply modal
        for (const dialog of dialogs) {
          const text = (dialog.innerText || dialog.textContent || '').trim();
          const titleEl = dialog.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const title = (titleEl?.textContent || text.slice(0, 100)).trim();

          const formInputs = dialog.querySelectorAll(
            'input:not([type="hidden"]), textarea, select, [contenteditable="true"]',
          );
          const buttons = Array.from(dialog.querySelectorAll('button'));
          const hasNavButtons = buttons.some(b => {
            const bt = (b.textContent || '').trim().toLowerCase();
            const bAria = (b.getAttribute('aria-label') || '').toLowerCase();
            return (
              bt.includes('next') ||
              bt.includes('review') ||
              bt.includes('submit') ||
              bt.includes('continue to next step') ||
              bAria.includes('next') ||
              bAria.includes('review') ||
              bAria.includes('submit') ||
              bAria.includes('continue to next step')
            );
          });
          const hasDocumentUpload =
            dialog.querySelector('.jobs-document-upload, [type="file"], .ui-attachment') !== null;
          const hasExplicitEasyApplyClass =
            dialog.classList.contains('jobs-easy-apply-modal') ||
            dialog.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-content, [data-easy-apply-modal], .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-test-modal-id="easy-apply-modal"]',
            ) !== null;

          const isEasyApply =
            hasExplicitEasyApplyClass ||
            dialog.querySelector('.jobs-easy-apply-content, [data-easy-apply-modal], form.jobs-easy-apply-form') !==
              null ||
            ((formInputs.length > 0 || hasDocumentUpload) && hasNavButtons) ||
            ((formInputs.length > 0 || hasDocumentUpload) &&
              (/easy apply/i.test(title) ||
                /apply to/i.test(title) ||
                /apply for/i.test(title) ||
                /contact info/i.test(title) ||
                /home address/i.test(title) ||
                /resume/i.test(title)));

          if (isEasyApply) {
            return {
              modalFound: true,
              inShadow: root instanceof ShadowRoot,
              dialogTitle: title,
              inputsCount: formInputs.length,
              buttonsCount: buttons.length,
              hasClosedShadow: false,
            };
          }
        }

        // Pass 2: Check for known intermediate dialogs (Continue, Safety, Discard)
        for (const dialog of dialogs) {
          const text = (dialog.innerText || dialog.textContent || '').trim();
          const titleEl = dialog.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const title = (titleEl?.textContent || text.slice(0, 100)).trim();

          // Known intermediate dialog 1: "Continue applying?"
          if (/continue applying/i.test(title) || /continue applying/i.test(text)) {
            const buttons = Array.from(dialog.querySelectorAll('button'));
            const continueBtn = buttons.find(b => /continue/i.test(b.textContent || ''));
            if (continueBtn) {
              continueBtn.click();
              return {
                modalFound: false,
                inShadow: root instanceof ShadowRoot,
                dialogTitle: title,
                isIntermediate: true,
                intermediateAction: 'continue',
                inputsCount: 0,
                buttonsCount: 0,
                hasClosedShadow: false,
              };
            }
          }

          // Known intermediate dialog 2: "Job search safety reminder"
          if (/job search safety/i.test(title) || /safety reminder/i.test(title) || /safety reminder/i.test(text)) {
            const buttons = Array.from(dialog.querySelectorAll('button'));
            const okBtn = buttons.find(b => /continue|got it|dismiss|understand/i.test(b.textContent || ''));
            if (okBtn) {
              okBtn.click();
              return {
                modalFound: false,
                inShadow: root instanceof ShadowRoot,
                dialogTitle: title,
                isIntermediate: true,
                intermediateAction: 'safety',
                inputsCount: 0,
                buttonsCount: 0,
                hasClosedShadow: false,
              };
            }
          }

          // Known intermediate dialog 3: "Save this application?" from an old unsubmitted draft -> Discard old draft
          if (
            (/save this application/i.test(title) || /save application/i.test(title) || /discard draft/i.test(title)) &&
            !/easy apply/i.test(title)
          ) {
            const buttons = Array.from(dialog.querySelectorAll('button'));
            const discardBtn = buttons.find(b => /^\s*discard\s*$/i.test((b.textContent || '').trim()));
            if (discardBtn) {
              discardBtn.click();
              return {
                modalFound: false,
                inShadow: root instanceof ShadowRoot,
                dialogTitle: title,
                isIntermediate: true,
                intermediateAction: 'discard',
                inputsCount: 0,
                buttonsCount: 0,
                hasClosedShadow: false,
              };
            }
          }
        }

        // Check for shadow roots (e.g. #interop-outlet)
        let foundClosed = false;
        const allEls = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < allEls.length; i++) {
          const el = allEls[i];
          if (el.shadowRoot) {
            const res = inspectRoot(el.shadowRoot);
            if (res.modalFound || res.isIntermediate) return res;
          } else if (el.tagName && el.tagName.includes('-')) {
            foundClosed = true;
          }
        }

        return {
          modalFound: false,
          inShadow: false,
          inputsCount: 0,
          buttonsCount: 0,
          hasClosedShadow: foundClosed,
        };
      }

      return inspectRoot(document);
    };

    while (Date.now() - startTime < maxWaitMs) {
      attempt++;

      let checkResult: any = null;
      if (this._puppeteerPage) {
        try {
          checkResult = await this._puppeteerPage.evaluate(checkInPage);
        } catch (pErr) {
          checkResult = null;
        }
      }

      if (!checkResult && this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: this._tabId },
            func: checkInPage,
          });
          checkResult = results?.[0]?.result || null;
        } catch (sErr) {
          checkResult = null;
        }
      }

      if (!checkResult) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
        continue;
      }

      if (checkResult.isIntermediate) {
        if (checkResult.intermediateAction === 'unknown') {
          lastUnknownDialog = checkResult.dialogTitle || 'Unknown dialog';
          console.debug(
            `[JobApplyAgent] Potential unknown dialog noted: "${lastUnknownDialog}". Continuing to poll for Easy Apply modal...`,
          );
        } else {
          console.debug(
            `[JobApplyAgent] Handled intermediate dialog: ${checkResult.dialogTitle} (${checkResult.intermediateAction})`,
          );
          logger.info(`Handled intermediate dialog: ${checkResult.dialogTitle} (${checkResult.intermediateAction})`);
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
      }

      if (checkResult.modalFound) {
        console.debug(
          `[JobApplyAgent] Easy Apply modal detected! In shadow root: ${checkResult.inShadow}, Interactive inputs: ${checkResult.inputsCount}, Buttons: ${checkResult.buttonsCount}`,
        );
        logger.info(
          `[JobApplyAgent] Easy Apply modal detected (inShadow=${checkResult.inShadow}, inputs=${checkResult.inputsCount}, buttons=${checkResult.buttonsCount})`,
        );
        return {
          opened: true,
          inShadowRoot: checkResult.inShadow,
          interactiveCount: checkResult.inputsCount + checkResult.buttonsCount,
        };
      }

      if (checkResult.hasClosedShadow && attempt === 1) {
        console.debug('[JobApplyAgent] Note: Page contains custom elements. Checking accessibility...');
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    if (lastUnknownDialog) {
      const err = `Unknown dialog encountered ("${lastUnknownDialog}"). Aborting without clicking to ensure safety.`;
      console.debug(`[JobApplyAgent] ${err}`);
      logger.warning(err);
      return { opened: false, error: err };
    }

    console.debug(`[JobApplyAgent] Easy Apply modal did not appear within ${maxWaitMs}ms`);
    return { opened: false, error: 'Easy Apply modal failed to open within timeout' };
  }

  /**
   * Verifies if the page shows explicit application submission confirmation.
   * Required before marking any application task as successful.
   */
  async verifyApplicationConfirmation(): Promise<{ confirmed: boolean; message?: string }> {
    const checkInPage = () => {
      function searchConfirmation(root: any): string | null {
        const confirmationPatterns = [
          /your application was sent/i,
          /application submitted/i,
          /your application has been submitted/i,
          /application received/i,
          /successfully applied/i,
          /thanks for applying/i,
          /thank you for applying/i,
          /we have received your application/i,
          /application sent to/i,
          /\bapplication sent\b/i,
          /\bapplication has been sent\b/i,
          /\byou applied\b/i,
          /\bapplied to\b/i,
          /\bapplication delivered\b/i,
          /\bapplied successfully\b/i,
        ];

        // 1. Check headings, alerts, feedback banners
        const headingsAndBadges = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                'h1, h2, h3, h4, [role="alert"], [class*="toast"], [class*="success"], [class*="confirm"], .artdeco-inline-feedback',
              ),
            ) as HTMLElement[])
          : [];

        for (const el of headingsAndBadges) {
          const txt = (el.textContent || '').trim();
          for (const pattern of confirmationPatterns) {
            if (pattern.test(txt)) {
              return txt;
            }
          }
        }

        // 2. Check dialog text if present
        const dialog = root.querySelector
          ? root.querySelector('div[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal')
          : null;
        if (dialog) {
          const dialogText = (dialog.textContent || '').trim();
          for (const pattern of confirmationPatterns) {
            if (pattern.test(dialogText)) {
              return dialogText.slice(0, 150);
            }
          }
        }

        // 3. Search shadow roots
        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          const child = all[i];
          if (child.shadowRoot) {
            const found = searchConfirmation(child.shadowRoot);
            if (found) return found;
          }
        }

        return null;
      }

      const match = searchConfirmation(document);
      return match ? { confirmed: true, message: match } : { confirmed: false };
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(checkInPage);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: checkInPage,
        });
        const res = results?.[0]?.result;
        if (res) return res;
      } catch {}
    }

    return { confirmed: false, message: 'Confirmation check unavailable' };
  }

  /**
   * Robust multi-selector validation guard for the active Easy Apply modal.
   * Checks aria-invalid, inline error texts, and empty required fields.
   */
  async validateModalFormState(): Promise<{
    hasErrors: boolean;
    errors: Array<{ fieldLabel: string; errorText: string }>;
    emptyRequiredFields: Array<{
      id?: string;
      label: string;
      fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
      options?: string[];
      min?: number;
      max?: number;
      placeholder?: string;
      hintText?: string;
      currentValue?: string;
      errorText?: string;
    }>;
    invalidFieldsWithErrors: Array<{
      id?: string;
      label: string;
      currentValue: string;
      errorText: string;
      fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
      min?: number;
      max?: number;
      placeholder?: string;
      hintText?: string;
    }>;
    unfulfilledMandatoryFileUpload?: {
      label: string;
      documentType: string;
    };
  }> {
    const validateInPage = () => {
      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];

        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) {
            continue;
          }
          const text = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (/^\d+\s*notifications?$/i.test(text) || c.closest('.notifications-badge')) {
            continue;
          }
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;

          if (
            c.classList.contains('jobs-easy-apply-modal') ||
            c.hasAttribute('data-easy-apply-modal') ||
            c.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
            c.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
            ) !== null
          ) {
            return c;
          }

          const titleEl = c.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const titleText = (titleEl?.textContent || text.slice(0, 100)).toLowerCase();
          const hasApplyTitle = /apply|application|job/i.test(titleText);
          const hasPrimaryBtn =
            c.querySelector(
              'button.artdeco-button--primary, button[data-easy-apply-next-button], button[aria-label*="next" i], button[aria-label*="submit" i], button[aria-label*="review" i], button[aria-label*="continue" i]',
            ) !== null;

          if (hasApplyTitle || hasPrimaryBtn) {
            return c;
          }
        }

        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            const found = findActiveModal(all[i].shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      function cleanDuplicateText(rawText: string): string {
        if (!rawText) return '';
        let text = rawText
          .replace(/[\n\r\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length <= 4) return text;

        // 1. Direct concatenation without separator: "Question?Question?"
        if (text.length % 2 === 0) {
          const half = text.slice(0, text.length / 2);
          if (half + half === text) return half;
        }

        // 2. Space-separated exact duplication: "Question? Question?"
        const mid = Math.floor(text.length / 2);
        if (text[mid] === ' ') {
          const left = text.slice(0, mid).trim();
          const right = text.slice(mid + 1).trim();
          if (left === right) return left;
        }

        // 3. Word-based even split:
        const words = text.split(/\s+/);
        if (words.length >= 4 && words.length % 2 === 0) {
          const halfLen = words.length / 2;
          const w1 = words.slice(0, halfLen).join(' ');
          const w2 = words.slice(halfLen).join(' ');
          if (w1 === w2) return w1;
        }

        // 4. Repeated sentence split on punctuation:
        const punctMatch = text.match(/^(.+?[?.!*])\s+(.+)$/);
        if (punctMatch) {
          const p1 = punctMatch[1].trim();
          const p2 = punctMatch[2].trim();
          const normP1 = p1.replace(/[*?.\s]/g, '').toLowerCase();
          const normP2 = p2.replace(/[*?.\s]/g, '').toLowerCase();
          if (normP1 && (normP1 === normP2 || normP2.startsWith(normP1))) return p1;
        }

        // 5. General substring repetition search:
        for (let len = Math.floor(text.length / 2); len >= 8; len--) {
          const candidate = text.slice(0, len).trim();
          const remainder = text.slice(len).trim();
          if (candidate.length > 6) {
            const normC = candidate.replace(/[*?.\s]/g, '').toLowerCase();
            const normR = remainder.replace(/[*?.\s]/g, '').toLowerCase();
            if (normC.length > 6 && (normC === normR || normR.startsWith(normC))) {
              return candidate;
            }
          }
        }

        return text;
      }

      function cleanElementText(el: Element | null): string {
        if (!el) return '';
        const clone = el.cloneNode(true) as HTMLElement;
        const hidden = clone.querySelectorAll(
          '.visually-hidden, [aria-hidden="true"], .sr-only, .u-screen-reader-only',
        );
        hidden.forEach(h => h.remove());
        let txt = (clone.textContent || '')
          .replace(/[\n\r\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!txt) {
          txt = (el.textContent || '')
            .replace(/[\n\r\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }
        return cleanDuplicateText(txt);
      }

      function cleanDuplicateString(text: string): string {
        return cleanDuplicateText(text);
      }

      const modal = findActiveModal(document);
      if (!modal) {
        return { hasErrors: false, errors: [], emptyRequiredFields: [], invalidFieldsWithErrors: [] };
      }
      const errors: Array<{ fieldLabel: string; errorText: string }> = [];
      const emptyRequiredFields: Array<{
        id?: string;
        label: string;
        fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
        options?: string[];
        min?: number;
        max?: number;
        placeholder?: string;
        hintText?: string;
        currentValue?: string;
        errorText?: string;
      }> = [];
      const invalidFieldsWithErrors: Array<{
        id?: string;
        label: string;
        currentValue: string;
        errorText: string;
        fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
        min?: number;
        max?: number;
        placeholder?: string;
        hintText?: string;
      }> = [];

      const errorRegex =
        /decimal|whole\s*number|between\s*\d+|larger\s*than|greater\s*than|more\s*than|number|valid|required|please\s*enter|please\s*make|select\s*an\s*option|choose|failed|must\s*be/i;

      // 1. Check elements with aria-invalid="true"
      const invalidEls = Array.from(
        modal.querySelectorAll('[aria-invalid="true"], .artdeco-text-input--error input'),
      ) as HTMLElement[];
      for (const el of invalidEls) {
        let label = '';
        const id = el.getAttribute('id');
        if (id) {
          const lbl = modal.querySelector(`label[for="${id}"]`);
          if (lbl) label = cleanElementText(lbl);
        }
        if (!label) {
          const closestContainer = el.closest(
            '.fb-dash-form-element, .jobs-easy-apply-form-element, fieldset, div[data-test-form-element]',
          );
          if (closestContainer) {
            const legend = closestContainer.querySelector('legend, label');
            if (legend) label = cleanElementText(legend);
          }
        }
        if (!label) {
          label = cleanDuplicateString(el.getAttribute('aria-label') || '');
        }

        let errorMsg = '';
        const describedBy = el.getAttribute('aria-describedby');
        if (describedBy) {
          const ids = describedBy.split(/\s+/);
          for (const did of ids) {
            if (!did) continue;
            try {
              const descEl = modal.querySelector(`[id="${CSS.escape(did)}"]`) || document.getElementById(did);
              if (descEl) {
                const t = cleanElementText(descEl);
                if (t) {
                  errorMsg = t;
                  break;
                }
              }
            } catch {}
          }
        }
        if (!errorMsg) {
          const container =
            el.closest('.fb-dash-form-element, .jobs-easy-apply-form-element, fieldset, div[data-test-form-element]') ||
            el.parentElement?.parentElement ||
            el.parentElement;
          const feedback = container?.querySelector?.(
            '.artdeco-inline-feedback, .artdeco-inline-feedback--error, .artdeco-inline-feedback__message, .inline-feedback, [class*="error" i], [role="alert"]',
          );
          if (feedback) errorMsg = cleanElementText(feedback);
        }
        errors.push({ fieldLabel: label || 'Form Field', errorText: errorMsg || 'Field is invalid' });

        // Include invalid element in emptyRequiredFields and invalidFieldsWithErrors so runner re-resolves it
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          const isSelect = el.tagName.toLowerCase() === 'select';
          const placeholder = el.getAttribute('placeholder') || '';
          const rawMin = el.getAttribute('min');
          const rawMax = el.getAttribute('max');
          const isNumeric =
            (el as HTMLInputElement).type === 'number' ||
            el.inputMode === 'numeric' ||
            el.inputMode === 'decimal' ||
            /decimal|number|between|larger than|greater than/i.test(errorMsg);
          const isCheckbox = (el as HTMLInputElement).type === 'checkbox';
          const isRadio = (el as HTMLInputElement).type === 'radio';

          const fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox' = isSelect
            ? 'dropdown'
            : isCheckbox
              ? 'checkbox'
              : isRadio
                ? 'radio'
                : isNumeric
                  ? 'number'
                  : 'text';

          const curVal = (el.value || '').trim();
          const minVal = /larger\s*than\s*0(?:\.0)?|greater\s*than\s*0(?:\.0)?/i.test(errorMsg)
            ? 1
            : rawMin !== null && !isNaN(Number(rawMin))
              ? Number(rawMin)
              : undefined;

          const invalidDesc = {
            id: el.id || undefined,
            label: label || 'Form Field',
            currentValue: curVal,
            errorText: errorMsg || 'Invalid field',
            fieldType,
            options: isSelect
              ? Array.from((el as HTMLSelectElement).options)
                  .map(o => cleanDuplicateString(o.text.trim()))
                  .filter(t => !/select an option/i.test(t))
              : undefined,
            min: minVal,
            max: rawMax !== null && !isNaN(Number(rawMax)) ? Number(rawMax) : undefined,
            placeholder: placeholder || undefined,
            hintText: errorMsg || undefined,
          };

          if (!invalidFieldsWithErrors.some(e => e.label === invalidDesc.label)) {
            invalidFieldsWithErrors.push(invalidDesc);
          }
          if (!emptyRequiredFields.some(e => e.label === invalidDesc.label)) {
            emptyRequiredFields.push(invalidDesc);
          }
        }
      }

      // 2. Check inline error feedback elements & red alerts
      const errorEls = Array.from(
        modal.querySelectorAll(
          '.artdeco-inline-feedback, .artdeco-inline-feedback--error, .artdeco-inline-feedback__message, .inline-feedback, .inline-feedback--error, [class*="inline-feedback" i], p[id*="error" i], span[id*="error" i], [class*="error-message" i], [data-test-form-element-error-message], [data-test-form-builder-error], [role="alert"]',
        ),
      ) as HTMLElement[];

      for (const errEl of errorEls) {
        const txt = cleanElementText(errEl);
        if (!txt || txt.length < 3) continue;
        if (
          errorRegex.test(txt) ||
          errEl.classList.contains('artdeco-inline-feedback--error') ||
          errEl.closest('.artdeco-inline-feedback--error')
        ) {
          let label = '';
          const container =
            errEl.closest(
              'div.fb-dash-form-element, div.jobs-easy-apply-form-element, fieldset, div[data-test-form-element], .jobs-easy-apply-form-section__grouping',
            ) ||
            errEl.parentElement?.parentElement ||
            errEl.parentElement;

          const inputEl = container
            ? (container.querySelector('input, select, textarea') as
                | HTMLInputElement
                | HTMLSelectElement
                | HTMLTextAreaElement
                | null)
            : null;

          if (container) {
            const lbl = container.querySelector('label, legend');
            if (lbl) label = cleanElementText(lbl);
          }
          if (!label && inputEl) {
            const id = inputEl.getAttribute('id');
            if (id) {
              const lbl = modal.querySelector(`label[for="${id}"]`);
              if (lbl) label = cleanElementText(lbl);
            }
            if (!label) label = cleanDuplicateString(inputEl.getAttribute('aria-label') || '');
          }

          if (!errors.some(e => e.errorText === txt)) {
            errors.push({ fieldLabel: label || 'Field', errorText: txt });
          }

          if (inputEl) {
            const curVal = (inputEl.value || '').trim();
            const isSelect = inputEl.tagName.toLowerCase() === 'select';
            const isNumeric =
              (inputEl as HTMLInputElement).type === 'number' ||
              inputEl.inputMode === 'numeric' ||
              inputEl.inputMode === 'decimal' ||
              /decimal|number|larger than|greater than/i.test(txt);
            const isCheckbox = (inputEl as HTMLInputElement).type === 'checkbox';
            const isRadio = (inputEl as HTMLInputElement).type === 'radio';

            const fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox' = isSelect
              ? 'dropdown'
              : isCheckbox
                ? 'checkbox'
                : isRadio
                  ? 'radio'
                  : isNumeric
                    ? 'number'
                    : 'text';

            const rawMin = inputEl.getAttribute('min');
            const minVal = /larger\s*than\s*0(?:\.0)?|greater\s*than\s*0(?:\.0)?/i.test(txt)
              ? 1
              : rawMin !== null && !isNaN(Number(rawMin))
                ? Number(rawMin)
                : undefined;

            const errDesc = {
              id: inputEl.id || undefined,
              label: label || 'Form Field',
              currentValue: curVal,
              errorText: txt,
              fieldType,
              min: minVal,
              placeholder: inputEl.getAttribute('placeholder') || undefined,
              hintText: txt,
            };

            if (!invalidFieldsWithErrors.some(e => e.label === errDesc.label && e.errorText === txt)) {
              invalidFieldsWithErrors.push(errDesc);
            }
            if (!emptyRequiredFields.some(e => e.label === errDesc.label)) {
              emptyRequiredFields.push(errDesc);
            }
          }
        }
      }

      // 3. Check radio groups and checkbox groups
      const fieldsets = Array.from(
        modal.querySelectorAll('fieldset, div[role="radiogroup"], div[role="group"]'),
      ) as HTMLElement[];
      for (const fs of fieldsets) {
        const radios = Array.from(fs.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
        const checkboxes = Array.from(fs.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];

        if (radios.length > 0) {
          const legend = fs.querySelector('legend, [role="heading"], label');
          const legendText = cleanElementText(legend);
          const anyChecked = radios.some(r => r.checked);

          // Check if explicitly marked optional by LinkedIn
          const isExplicitlyOptional =
            /\boptional\b/i.test(legendText) ||
            Boolean(
              fs.querySelector(
                '.fb-dash-form-element__label-title--optional, [data-test-form-element-optional], .artdeco-form__label--optional',
              ) || fs.closest('.fb-dash-form-element--optional, [data-test-form-element-optional]'),
            );

          // In LinkedIn Easy Apply modals, radio groups are required screening questions unless explicitly marked optional
          if (!anyChecked && !isExplicitlyOptional) {
            const options = radios
              .map(r => {
                const rId = r.getAttribute('id');
                let rLbl: HTMLElement | null = null;
                if (rId) {
                  try {
                    rLbl = fs.querySelector(`label[for="${CSS.escape(rId)}"]`);
                  } catch {
                    const allLabels = Array.from(fs.querySelectorAll('label'));
                    rLbl = allLabels.find(l => l.getAttribute('for') === rId) || null;
                  }
                }
                if (!rLbl) {
                  rLbl = r.closest('label') || (r.parentElement?.querySelector('label') as HTMLElement | null);
                }
                return cleanElementText(rLbl) || (r.value || '').trim();
              })
              .filter(Boolean);

            emptyRequiredFields.push({
              label: legendText,
              fieldType: 'radio',
              options,
            });
          }
        } else if (checkboxes.length > 0) {
          const legend = fs.querySelector('legend, [role="heading"], label');
          const legendText = cleanElementText(legend);
          const anyChecked = checkboxes.some(c => c.checked);

          const isExplicitlyOptional =
            /\boptional\b/i.test(legendText) ||
            Boolean(
              fs.querySelector(
                '.fb-dash-form-element__label-title--optional, [data-test-form-element-optional], .artdeco-form__label--optional',
              ) || fs.closest('.fb-dash-form-element--optional, [data-test-form-element-optional]'),
            );

          if (!anyChecked && !isExplicitlyOptional) {
            const options = checkboxes
              .map(c => {
                const cId = c.getAttribute('id');
                let cLbl: HTMLElement | null = null;
                if (cId) {
                  try {
                    cLbl = fs.querySelector(`label[for="${CSS.escape(cId)}"]`);
                  } catch {
                    const allLabels = Array.from(fs.querySelectorAll('label'));
                    cLbl = allLabels.find(l => l.getAttribute('for') === cId) || null;
                  }
                }
                if (!cLbl) {
                  cLbl = c.closest('label') || (c.parentElement?.querySelector('label') as HTMLElement | null);
                }
                return cleanElementText(cLbl) || (c.value || '').trim();
              })
              .filter(Boolean);

            emptyRequiredFields.push({
              label: legendText,
              fieldType: 'checkbox',
              options,
            });
          }
        }
      }

      // 3b. Standalone required checkboxes
      const standaloneCheckboxes = Array.from(modal.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
      for (const cb of standaloneCheckboxes) {
        if (cb.closest('fieldset, div[role="radiogroup"], div[role="group"]')) continue;
        if (cb.checked) continue;

        let label = '';
        const id = cb.getAttribute('id');
        if (id) {
          const lbl = modal.querySelector(`label[for="${id}"]`);
          if (lbl) label = cleanElementText(lbl);
        }
        if (!label) {
          const parent = cb.closest('.fb-dash-form-element, div[data-test-form-element], label');
          if (parent) label = cleanElementText(parent);
        }
        if (!label) label = cleanDuplicateString(cb.getAttribute('aria-label') || '');

        const isRequired =
          cb.hasAttribute('required') ||
          cb.getAttribute('aria-required') === 'true' ||
          /agree|terms|certify|acknowledge|consent|confirm/i.test(label);

        if (isRequired && label) {
          emptyRequiredFields.push({
            id: cb.id || undefined,
            label,
            fieldType: 'checkbox',
            options: ['Yes', 'No'],
          });
        }
      }

      // 4. Text and numeric inputs
      const textInputs = Array.from(
        modal.querySelectorAll(
          'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select',
        ),
      ) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];

      for (const input of textInputs) {
        if (input instanceof HTMLInputElement && input.type === 'file') continue;
        const val = (input.value || '').trim();
        const isSelect = input.tagName.toLowerCase() === 'select';
        const isRequired =
          input.required || input.hasAttribute('required') || input.getAttribute('aria-required') === 'true';

        let label = '';
        const id = input.getAttribute('id');
        if (id) {
          const lbl = modal.querySelector(`label[for="${id}"]`);
          if (lbl) label = cleanElementText(lbl);
        }
        const parentEl =
          input.closest(
            'div.fb-dash-form-element, div.jobs-easy-apply-form-element, div[data-test-form-element], .jobs-easy-apply-form-section__grouping, fieldset, div[class*="form-element" i]',
          ) ||
          input.parentElement?.parentElement ||
          input.parentElement;

        if (!label && parentEl) {
          const lbl = parentEl.querySelector('label');
          if (lbl) label = cleanElementText(lbl);
        }
        if (!label) {
          label = cleanDuplicateString(input.getAttribute('aria-label') || '');
        }

        const placeholder = cleanDuplicateString(input.getAttribute('placeholder') || '');
        let hintText = '';
        const describedBy = input.getAttribute('aria-describedby');
        if (describedBy) {
          const ids = describedBy.split(/\s+/);
          const parts: string[] = [];
          for (const did of ids) {
            if (!did) continue;
            try {
              const el = modal.querySelector(`[id="${CSS.escape(did)}"]`) || document.getElementById(did);
              if (el) {
                const t = cleanElementText(el);
                if (t) parts.push(t);
              }
            } catch {}
          }
          if (parts.length > 0) hintText = parts.join(' ');
        }
        if (!hintText && parentEl) {
          const hintEl = parentEl.querySelector(
            '.fb-dash-form-element__hint, .artdeco-text-input--hint, .artdeco-form-element__sub-text, span.t-12, [id*="hint"], [id*="helper"], [data-test-form-element-hint]',
          );
          if (hintEl) hintText = cleanElementText(hintEl);
        }
        // Also check for inline error text right next to the input
        const errEl = parentEl?.querySelector(
          '.artdeco-inline-feedback, .artdeco-inline-feedback--error, .artdeco-inline-feedback__message, .inline-feedback, [class*="error" i], [role="alert"], [data-test-form-element-error-message]',
        );
        const activeErrorText = errEl ? cleanElementText(errEl) : '';
        if (activeErrorText) {
          hintText = hintText ? `${hintText} ${activeErrorText}` : activeErrorText;
        }

        const rawMin = input.getAttribute('min');
        const rawMax = input.getAttribute('max');
        let parsedMin = rawMin !== null && !isNaN(Number(rawMin)) ? Number(rawMin) : undefined;
        const parsedMax = rawMax !== null && !isNaN(Number(rawMax)) ? Number(rawMax) : undefined;

        const combinedHint = (placeholder + ' ' + hintText).toLowerCase();
        const isSkillOrNumeric =
          /how many years|experience|years|\bdays\b|\bmonths\b|whole\s*number|only\s*(?:whole\s*)?numbers|in\s*inr|in\s*lpa|ctc|decimal\s*number|larger\s*than|greater\s*than/i.test(
            label + ' ' + combinedHint,
          ) ||
          input.type === 'number' ||
          input.inputMode === 'numeric' ||
          input.inputMode === 'decimal' ||
          input.getAttribute('data-test-fb-numeric-input') === 'true' ||
          input.getAttribute('data-test-fb-decimal-input') === 'true' ||
          input.hasAttribute('step') ||
          /example:\s*\d+/i.test(combinedHint) ||
          /whole\s*number|decimal\s*number|between \d+ and \d+|larger than \d+|greater than \d+|0 and 99/i.test(
            combinedHint,
          );

        if (/larger\s*than\s*0(?:\.0)?|greater\s*than\s*0(?:\.0)?/i.test(combinedHint)) {
          parsedMin = Math.max(1, parsedMin || 1);
        }

        const hasActiveError =
          Boolean(activeErrorText) && (errorRegex.test(activeErrorText) || activeErrorText.length > 5);
        const isInvalidValue =
          hasActiveError || (!val && (isRequired || isSkillOrNumeric)) || (isSelect && /select an option/i.test(val));

        if (isInvalidValue) {
          let fieldType: 'text' | 'number' | 'dropdown' = 'text';
          if (isSelect) {
            fieldType = 'dropdown';
          } else if (
            input.type === 'number' ||
            isSkillOrNumeric ||
            /decimal\s*number|whole\s*number|larger than|greater than/i.test(combinedHint)
          ) {
            fieldType = 'number';
          }

          let options: string[] | undefined = undefined;
          if (isSelect) {
            options = Array.from((input as HTMLSelectElement).options)
              .map(o => cleanDuplicateString(o.text.trim()))
              .filter(t => !/select an option/i.test(t));
          }

          const fieldDesc = {
            id: input.id || undefined,
            label: label || 'Form Field',
            fieldType,
            options,
            min: parsedMin !== undefined ? parsedMin : fieldType === 'number' ? 0 : undefined,
            max: parsedMax !== undefined ? parsedMax : /0 and 99/i.test(combinedHint) ? 99 : undefined,
            placeholder: placeholder || undefined,
            hintText: hintText || undefined,
            currentValue: val,
            errorText: activeErrorText || undefined,
          };

          if (!emptyRequiredFields.some(e => e.label === fieldDesc.label)) {
            emptyRequiredFields.push(fieldDesc);
          }

          if (hasActiveError && !invalidFieldsWithErrors.some(e => e.label === fieldDesc.label)) {
            invalidFieldsWithErrors.push({
              ...fieldDesc,
              currentValue: val,
              errorText: activeErrorText,
            });
          }
        }
      }

      let unfulfilledMandatoryFileUpload: { label: string; documentType: string } | undefined = undefined;

      // Check for mandatory file upload elements (Cover Letter, Portfolio, Custom Attachment)
      const fileInputs = Array.from(modal.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
      for (const fi of fileInputs) {
        const isRequired =
          fi.required ||
          fi.hasAttribute('required') ||
          fi.getAttribute('aria-required') === 'true' ||
          Boolean(fi.closest('.jobs-document-upload--required, [data-test-document-upload-required]'));
        const hasFiles = fi.files && fi.files.length > 0;
        const container = fi.closest('.jobs-document-upload, .fb-dash-form-element, section, div');
        const hasError = container?.querySelector(
          '.artdeco-inline-feedback--error, [aria-live="assertive"], .inline-feedback, [class*="error" i]',
        );
        const errText = (hasError?.textContent || '').trim();
        const isUploadError =
          /upload (?:a |your )?(?:cover letter|resume|portfolio|file|document)|document is required|file is required/i.test(
            errText,
          );

        if ((isRequired || isUploadError) && !hasFiles) {
          const rawLabel =
            cleanElementText(container?.querySelector('h3, h4, label, legend') || null) || 'Document Upload';
          const docType =
            /cover\s*letter/i.test(rawLabel) || /cover\s*letter/i.test(errText)
              ? 'Cover Letter'
              : /portfolio/i.test(rawLabel) || /portfolio/i.test(errText)
                ? 'Portfolio'
                : 'Custom Attachment';
          unfulfilledMandatoryFileUpload = { label: rawLabel, documentType: docType };
          break;
        }
      }

      return {
        hasErrors:
          errors.length > 0 ||
          emptyRequiredFields.length > 0 ||
          invalidFieldsWithErrors.length > 0 ||
          Boolean(unfulfilledMandatoryFileUpload),
        errors,
        emptyRequiredFields,
        invalidFieldsWithErrors,
        unfulfilledMandatoryFileUpload,
      };
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(validateInPage);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: validateInPage,
        });
        const res = results?.[0]?.result;
        if (res) return res;
      } catch {}
    }

    return {
      hasErrors: false,
      errors: [],
      emptyRequiredFields: [],
      invalidFieldsWithErrors: [],
      unfulfilledMandatoryFileUpload: undefined,
    };
  }

  /**
   * Sets value for a form element directly inside the active modal
   */
  async fillModalFieldDirect(identifier: { id?: string; label?: string }, value: string): Promise<boolean> {
    const fillInPage = async (ident: { id?: string; label?: string }, val: string) => {
      function cleanDuplicateText(rawText: string): string {
        if (!rawText) return '';
        let text = rawText
          .replace(/[\n\r\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length <= 4) return text;

        // 1. Direct concatenation without separator: "Question?Question?"
        if (text.length % 2 === 0) {
          const half = text.slice(0, text.length / 2);
          if (half + half === text) return half;
        }

        // 2. Space-separated exact duplication: "Question? Question?"
        const mid = Math.floor(text.length / 2);
        if (text[mid] === ' ') {
          const left = text.slice(0, mid).trim();
          const right = text.slice(mid + 1).trim();
          if (left === right) return left;
        }

        // 3. Word-based even split:
        const words = text.split(/\s+/);
        if (words.length >= 4 && words.length % 2 === 0) {
          const halfLen = words.length / 2;
          const w1 = words.slice(0, halfLen).join(' ');
          const w2 = words.slice(halfLen).join(' ');
          if (w1 === w2) return w1;
        }

        // 4. Repeated sentence split on punctuation:
        const punctMatch = text.match(/^(.+?[?.!*])\s+(.+)$/);
        if (punctMatch) {
          const p1 = punctMatch[1].trim();
          const p2 = punctMatch[2].trim();
          const normP1 = p1.replace(/[*?.\s]/g, '').toLowerCase();
          const normP2 = p2.replace(/[*?.\s]/g, '').toLowerCase();
          if (normP1 && (normP1 === normP2 || normP2.startsWith(normP1))) return p1;
        }

        // 5. General substring repetition search:
        for (let len = Math.floor(text.length / 2); len >= 8; len--) {
          const candidate = text.slice(0, len).trim();
          const remainder = text.slice(len).trim();
          if (candidate.length > 6) {
            const normC = candidate.replace(/[*?.\s]/g, '').toLowerCase();
            const normR = remainder.replace(/[*?.\s]/g, '').toLowerCase();
            if (normC.length > 6 && (normC === normR || normR.startsWith(normC))) {
              return candidate;
            }
          }
        }

        return text;
      }

      function cleanElementText(el: Element | null): string {
        if (!el) return '';
        const clone = el.cloneNode(true) as HTMLElement;
        const hidden = clone.querySelectorAll(
          '.visually-hidden, [aria-hidden="true"], .sr-only, .u-screen-reader-only',
        );
        hidden.forEach(h => h.remove());
        let txt = (clone.textContent || '')
          .replace(/[\n\r\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!txt) {
          txt = (el.textContent || '')
            .replace(/[\n\r\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }
        return cleanDuplicateText(txt);
      }

      function cleanDuplicateString(text: string): string {
        return cleanDuplicateText(text);
      }

      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];

        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) {
            continue;
          }
          const text = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (/^\d+\s*notifications?$/i.test(text) || c.closest('.notifications-badge')) {
            continue;
          }
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;

          if (
            c.classList.contains('jobs-easy-apply-modal') ||
            c.hasAttribute('data-easy-apply-modal') ||
            c.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
            c.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
            ) !== null
          ) {
            return c;
          }

          const titleEl = c.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const titleText = (titleEl?.textContent || text.slice(0, 100)).toLowerCase();
          const hasApplyTitle = /apply|application|job/i.test(titleText);
          const hasPrimaryBtn =
            c.querySelector(
              'button.artdeco-button--primary, button[data-easy-apply-next-button], button[aria-label*="next" i], button[aria-label*="submit" i], button[aria-label*="review" i], button[aria-label*="continue" i]',
            ) !== null;

          if (hasApplyTitle || hasPrimaryBtn) {
            return c;
          }
        }

        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            const found = findActiveModal(all[i].shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const modal = findActiveModal(document);
      if (!modal) return false;
      let targetEl: HTMLElement | null = null;
      let targetRadioLabel: HTMLElement | null = null;

      if (ident.id) {
        try {
          targetEl =
            document.getElementById(ident.id) ||
            (modal.querySelector ? modal.querySelector(`[id="${CSS.escape(ident.id)}"]`) : null);
        } catch {
          targetEl = document.getElementById(ident.id);
        }
      }

      function labelsMatch(a: string, b: string): boolean {
        if (!a || !b) return false;
        if (a === b || a.includes(b) || b.includes(a)) return true;
        const normA = a
          .replace(/[^\w\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const normB = b
          .replace(/[^\w\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (normA && normB && (normA === normB || normA.includes(normB) || normB.includes(normA))) return true;
        return false;
      }

      if (!targetEl && ident.label) {
        const cleanLabel = cleanDuplicateString(ident.label).toLowerCase().trim();

        // 1. Check radio and checkbox groups (fieldsets / role="radiogroup") first
        const fieldsets = Array.from(
          modal.querySelectorAll('fieldset, div[role="radiogroup"], div[role="group"]'),
        ) as HTMLElement[];
        for (const fs of fieldsets) {
          const legend = fs.querySelector('legend, [role="heading"], label');
          const legendText = cleanElementText(legend).toLowerCase().trim();
          if (legendText && labelsMatch(legendText, cleanLabel)) {
            const radios = Array.from(fs.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
            const checkboxes = Array.from(fs.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
            const items = radios.length > 0 ? radios : checkboxes;
            const normVal = val.toLowerCase().trim();
            const isTargetYes = /^(yes|true|1|y|immediate|available|agree|authorized)$/i.test(normVal);
            const isTargetNo = /^(no|false|0|n|not)$/i.test(normVal);

            for (const r of items) {
              const rId = r.getAttribute('id');
              let rLbl: HTMLElement | null = null;
              if (rId) {
                try {
                  rLbl =
                    fs.querySelector(`label[for="${CSS.escape(rId)}"]`) ||
                    modal.querySelector(`label[for="${CSS.escape(rId)}"]`);
                } catch {
                  const allLabels = Array.from(fs.querySelectorAll('label'));
                  rLbl = allLabels.find(l => l.getAttribute('for') === rId) || null;
                }
              }
              if (!rLbl) {
                rLbl = r.closest('label') || (r.parentElement?.querySelector('label') as HTMLElement | null);
              }

              const rawLblText = cleanElementText(rLbl).toLowerCase().trim();
              const rawVal = (r.value || '').toLowerCase().trim();

              let matched = false;
              if (isTargetYes && (/\byes\b/i.test(rawLblText) || /^(true|1|yes|y)$/i.test(rawVal))) {
                matched = true;
              } else if (isTargetNo && (/\bno\b/i.test(rawLblText) || /^(false|0|no|n)$/i.test(rawVal))) {
                matched = true;
              } else if (
                rawLblText &&
                (rawLblText === normVal || rawLblText.includes(normVal) || normVal.includes(rawLblText))
              ) {
                matched = true;
              } else if (rawVal && (rawVal === normVal || rawVal.includes(normVal) || normVal.includes(rawVal))) {
                matched = true;
              }

              if (matched) {
                targetEl = r;
                targetRadioLabel = rLbl;
                break;
              }
            }
          }
          if (targetEl) break;
        }

        // 2. If not found in fieldset, check standard labels
        if (!targetEl) {
          const labels = Array.from(modal.querySelectorAll('label')) as HTMLElement[];
          for (const l of labels) {
            const lText = cleanElementText(l).toLowerCase().trim();
            if (lText && labelsMatch(lText, cleanLabel)) {
              const forId = l.getAttribute('for');
              if (forId) {
                try {
                  targetEl = document.getElementById(forId) || modal.querySelector(`[id="${CSS.escape(forId)}"]`);
                } catch {
                  targetEl = document.getElementById(forId);
                }
              }
              if (!targetEl) targetEl = l.querySelector('input:not([type="file"]), select, textarea');
              if (!targetEl) {
                const parent = l.closest(
                  '.fb-dash-form-element, div[data-test-form-element], .jobs-easy-apply-form-element, .artdeco-dropdown',
                );
                if (parent) {
                  targetEl = parent.querySelector(
                    'select, input:not([type="file"]), textarea, button[aria-haspopup="listbox"], button.artdeco-dropdown__trigger, [role="combobox"]',
                  );
                }
              }
              if (targetEl) break;
            }
          }
        }

        if (!targetEl) {
          // 3. Fallback: check standalone checkboxes by label, aria-label, or text in parent/wrapper
          const allCheckboxes = Array.from(modal.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
          for (const cb of allCheckboxes) {
            const cbAria = cleanDuplicateString(cb.getAttribute('aria-label') || '')
              .toLowerCase()
              .trim();
            if (cbAria && labelsMatch(cbAria, cleanLabel)) {
              targetEl = cb;
              break;
            }
            const parent = cb.closest('label, div, p, span, li');
            if (parent) {
              const pText = cleanElementText(parent).toLowerCase().trim();
              if (pText && labelsMatch(pText, cleanLabel)) {
                targetEl = cb;
                break;
              }
            }
          }
        }
      }

      if (!targetEl) return false;

      // Ensure target element is scrolled into view in modal before interaction
      const scrollTarget = targetRadioLabel || targetEl.closest('label') || targetEl.parentElement || targetEl;
      try {
        scrollTarget.scrollIntoView({ behavior: 'instant', block: 'center' });
      } catch {}

      // Fill element
      if (targetEl instanceof HTMLInputElement && (targetEl.type === 'radio' || targetEl.type === 'checkbox')) {
        const clickable = targetRadioLabel || targetEl.closest('label') || targetEl.parentElement || targetEl;

        try {
          targetEl.focus();
        } catch {}

        const normVal = val.toLowerCase().trim();
        const shouldBeChecked =
          targetEl.type === 'checkbox' ? /^(yes|true|1|y|checked|agree|authorized)$/i.test(normVal) : true;

        if (targetEl.type === 'checkbox') {
          if (targetEl.checked !== shouldBeChecked) {
            // Trigger click via clickable wrapper or element to fire framework change events
            clickable.click();

            // If framework or default action didn't match the desired state, invoke native setter and dispatch input/change
            if (targetEl.checked !== shouldBeChecked) {
              const proto = HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
              if (setter) {
                setter.call(targetEl, shouldBeChecked);
              } else {
                targetEl.checked = shouldBeChecked;
              }
              targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
          }
          return targetEl.checked === shouldBeChecked;
        } else {
          // Radio button
          clickable.click();
          if (!targetEl.checked) {
            const proto = HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
            if (setter) {
              setter.call(targetEl, true);
            } else {
              targetEl.checked = true;
            }
            targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
          return targetEl.checked;
        }
      } else if (targetEl instanceof HTMLInputElement && targetEl.type === 'file') {
        // File input elements can only accept an empty string programmatically in web browsers
        // for security reasons. Never attempt to set non-empty string on input[type="file"].
        return false;
      } else if (targetEl instanceof HTMLInputElement || targetEl instanceof HTMLTextAreaElement) {
        const proto = targetEl instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

        let finalVal = val;
        if (
          targetEl instanceof HTMLInputElement &&
          (targetEl.type === 'number' || targetEl.inputMode === 'numeric' || targetEl.inputMode === 'decimal')
        ) {
          let numStr = String(val).replace(/,/g, '').trim();
          const minAttr = targetEl.getAttribute('min');
          const minNum = minAttr !== null ? parseFloat(minAttr) : NaN;
          const minRequiresPositive = !isNaN(minNum) && minNum > 0;

          if (/^(immediate|immediately|now|none|0\s*days?)$/i.test(numStr)) {
            numStr = minRequiresPositive ? String(Math.max(1, minNum)) : '0';
          } else {
            const numMatch = numStr.match(/-?\d+(?:\.\d+)?/);
            if (numMatch) {
              let parsed = parseFloat(numMatch[0]);
              if (minRequiresPositive && parsed < minNum) {
                parsed = minNum;
              }
              numStr = String(parsed);
            } else {
              numStr = minRequiresPositive ? String(Math.max(1, minNum)) : '0';
            }
          }
          finalVal = numStr;
        }

        try {
          targetEl.focus();
          if (setter) {
            setter.call(targetEl, finalVal);
          } else {
            targetEl.value = finalVal;
          }
          targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        } catch (fillErr) {
          console.warn('[Page] fillModalFieldDirect value setter caught error:', fillErr);
          return false;
        }

        // Autocomplete / typeahead suggestion selection (e.g. Location (city), School/University, Company, Title)
        const isLocationField =
          /location|city/i.test(ident.label || '') ||
          /location|city/i.test(ident.id || '') ||
          /location|city/i.test(targetEl.id || '') ||
          /location|city/i.test(targetEl.name || '');

        const isTypeahead =
          targetEl.getAttribute('role') === 'combobox' ||
          targetEl.getAttribute('aria-autocomplete') === 'list' ||
          targetEl.hasAttribute('aria-controls') ||
          Boolean(targetEl.closest('.basic-typeahead, .artdeco-typeahead, [data-test-typeahead]')) ||
          isLocationField ||
          /school|college|university|company|title/i.test(ident.label || '');

        // If location field, sanitize remote/hybrid clauses e.g. "Bengaluru, India or Remote" -> "Bengaluru, India"
        let cleanVal = val.trim();
        if (isLocationField) {
          cleanVal = cleanVal
            .replace(/\b(?:or|and|\/)\s*remote\b/gi, '')
            .replace(/\bremote\s*(?:or|and|\/)\b/gi, '')
            .replace(/\(remote\)/gi, '')
            .replace(/\[remote\]/gi, '')
            .replace(/\b(?:or|and|\/)\s*hybrid\b/gi, '')
            .replace(/\(hybrid\)/gi, '')
            .replace(/\[hybrid\]/gi, '')
            .replace(/\s*,\s*remote\b/gi, '')
            .replace(/\bremote\s*,\s*/gi, '')
            .replace(/^[,\-\s/]+|[,\-\s/]+$/g, '')
            .trim();
          if (/^remote$/i.test(cleanVal)) cleanVal = '';
          if (!cleanVal) cleanVal = val.trim();

          // Re-apply cleaned value to input if modified
          if (cleanVal !== val) {
            if (setter) {
              setter.call(targetEl, cleanVal);
            } else {
              targetEl.value = cleanVal;
            }
            targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
        }

        if (isTypeahead) {
          // For location typeaheads with state/country, type primary city first so LinkedIn's remote typeahead API responds
          const typeQuery = isLocationField && cleanVal.includes(',') ? cleanVal.split(',')[0].trim() : cleanVal;
          if (typeQuery && typeQuery !== targetEl.value) {
            if (setter) {
              setter.call(targetEl, typeQuery);
            } else {
              targetEl.value = typeQuery;
            }
            targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }

          // Dispatch key events to activate LinkedIn's typeahead listener
          targetEl.dispatchEvent(new KeyboardEvent('keydown', { key: typeQuery.slice(-1) || 'a', bubbles: true }));
          targetEl.dispatchEvent(new KeyboardEvent('keyup', { key: typeQuery.slice(-1) || 'a', bubbles: true }));

          const listboxSelectors = [
            'div[role="listbox"]',
            'ul[role="listbox"]',
            '.basic-typeahead__triggered-content',
            '.artdeco-typeahead__results-list',
            '.basic-typeahead__selectable-list',
            '.typeahead-results',
            'div[data-artdeco-typeahead-results]',
          ];

          let optionEls: HTMLElement[] = [];
          let listbox: HTMLElement | null = null;

          // Poll for up to 2 seconds (10 attempts * 200ms) for suggestions to render
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(r => setTimeout(r, 200));

            const container = targetEl.closest(
              '.basic-typeahead, .artdeco-typeahead, .fb-dash-form-element, div[data-test-form-element]',
            );
            if (container) {
              listbox = container.querySelector(listboxSelectors.join(', '));
            }
            if (!listbox) {
              listbox =
                modal.querySelector(listboxSelectors.join(', ')) || document.querySelector(listboxSelectors.join(', '));
            }

            if (listbox) {
              optionEls = Array.from(
                listbox.querySelectorAll(
                  'div[role="option"], li[role="option"], .basic-typeahead__selectable-item, .artdeco-typeahead__result, [role="option"]',
                ),
              ) as HTMLElement[];
              if (optionEls.length > 0) {
                break;
              }
            }

            // After 4 attempts (800ms) with no options, if this is a location field with a comma, try typing just the city name!
            if (attempt === 3 && optionEls.length === 0 && isLocationField && cleanVal.includes(',')) {
              const primaryCity = cleanVal.split(',')[0].trim();
              if (primaryCity && primaryCity !== cleanVal) {
                if (setter) {
                  setter.call(targetEl, primaryCity);
                } else {
                  targetEl.value = primaryCity;
                }
                targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                targetEl.dispatchEvent(
                  new KeyboardEvent('keydown', { key: primaryCity.slice(-1) || 'a', bubbles: true }),
                );
                targetEl.dispatchEvent(
                  new KeyboardEvent('keyup', { key: primaryCity.slice(-1) || 'a', bubbles: true }),
                );
              }
            }
          }

          if (optionEls.length > 0) {
            const normVal = cleanVal.toLowerCase().trim();
            const tokens = normVal
              .replace(/[^\w\s]/g, ' ')
              .split(/\s+/)
              .filter(t => t.length > 2);
            const primaryToken = tokens[0] || normVal;

            let bestOpt: HTMLElement | null = null;
            let highestScore = -1;

            for (const opt of optionEls) {
              const txt = (opt.textContent || '').toLowerCase().trim();
              let score = 0;

              if (txt === normVal) {
                score = 100;
              } else if (txt.startsWith(normVal)) {
                score = 90;
              } else if (txt.includes(normVal) || normVal.includes(txt)) {
                score = 80;
              } else if (primaryToken && txt.includes(primaryToken)) {
                // e.g. "bengaluru" in "Bengaluru, Karnataka, India" or "Greater Bengaluru Area"
                score = 70;
                for (const tok of tokens.slice(1)) {
                  if (txt.includes(tok)) score += 10;
                }
              } else {
                for (const tok of tokens) {
                  if (txt.includes(tok)) score += 10;
                }
              }

              if (score > highestScore) {
                highestScore = score;
                bestOpt = opt;
              }
            }

            if (!bestOpt) {
              bestOpt = optionEls[0];
            }

            if (bestOpt) {
              const clickable = (bestOpt.querySelector('span, div, p, a') as HTMLElement) || bestOpt;
              ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                clickable.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                bestOpt!.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
              });
              try {
                clickable.click();
              } catch {}
              try {
                bestOpt.click();
              } catch {}

              // Accessible combobox keyboard selection fallback: ArrowDown + Enter
              targetEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
              targetEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', keyCode: 40, bubbles: true }));
              await new Promise(r => setTimeout(r, 80));
              targetEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
              targetEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));

              await new Promise(r => setTimeout(r, 300));
            }
          }
        }

        return true;
      } else if (targetEl instanceof HTMLSelectElement) {
        // If select is currently disabled or options haven't hydrated yet (cascading parent -> child AJAX delay),
        // poll up to 1200ms for options to load
        for (let poll = 0; poll < 6; poll++) {
          if (!targetEl.disabled && targetEl.options.length > 1) {
            break;
          }
          await new Promise(r => setTimeout(r, 200));
        }

        const options = Array.from(targetEl.options);
        const normVal = val.toLowerCase().trim();
        const isAffirmative = /^(yes|true|1|y|immediate|available|agree|authorized)$/i.test(normVal);
        const isNegative = /^(no|false|0|n|requires|not)$/i.test(normVal);

        // 1. Exact or loose match on option text or value
        let opt = options.find(
          o =>
            cleanDuplicateString(o.text).toLowerCase().trim() === normVal ||
            o.value.toLowerCase().trim() === normVal ||
            (normVal.length > 2 && cleanDuplicateString(o.text).toLowerCase().includes(normVal)) ||
            (cleanDuplicateString(o.text).length > 2 && normVal.includes(cleanDuplicateString(o.text).toLowerCase())),
        );

        // 2. Boolean/affirmative fallback (e.g. "Immediate" -> "Yes", "Bengaluru" -> "Yes")
        if (!opt) {
          if (isAffirmative) {
            opt = options.find(
              o => /^(yes|agree)$/i.test(cleanDuplicateString(o.text).trim()) || /^(yes|true|1)$/i.test(o.value),
            );
          } else if (isNegative) {
            opt = options.find(
              o => /^no$/i.test(cleanDuplicateString(o.text).trim()) || /^(no|false|0)$/i.test(o.value),
            );
          }
        }

        // 3. City token match & common geographic synonyms (e.g. Bengaluru <-> Bangalore, Mumbai <-> Bombay)
        if (!opt && normVal.length > 3) {
          const citySynonyms: Record<string, string[]> = {
            bengaluru: ['bangalore', 'bengaluru'],
            bangalore: ['bengaluru', 'bangalore'],
            mumbai: ['bombay', 'mumbai'],
            bombay: ['mumbai', 'bombay'],
            kolkata: ['calcutta', 'kolkata'],
            calcutta: ['kolkata', 'calcutta'],
            chennai: ['madras', 'chennai'],
            madras: ['chennai', 'madras'],
            gurugram: ['gurgaon', 'gurugram'],
            gurgaon: ['gurugram', 'gurgaon'],
          };

          for (const [key, aliases] of Object.entries(citySynonyms)) {
            if (normVal.includes(key)) {
              opt = options.find(o => {
                const optText = cleanDuplicateString(o.text).toLowerCase();
                return aliases.some(a => optText.includes(a));
              });
              if (opt) break;
            }
          }

          if (!opt) {
            const tokens = normVal.split(/[\s,/-]+/).filter(t => t.length > 2);
            opt = options.find(o => {
              const optText = cleanDuplicateString(o.text).toLowerCase();
              return tokens.some(t => optText.includes(t));
            });
          }
        }

        if (opt) {
          targetEl.focus();
          const proto = HTMLSelectElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(targetEl, opt.value);
          } else {
            targetEl.value = opt.value;
          }
          opt.selected = true;
          targetEl.selectedIndex = opt.index;
          targetEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          targetEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return true;
        }
      } else {
        // Check for custom Artdeco dropdown button or combobox
        const customTrigger =
          targetEl.getAttribute('aria-haspopup') === 'listbox' ||
          targetEl.getAttribute('role') === 'combobox' ||
          targetEl.classList.contains('artdeco-dropdown__trigger')
            ? targetEl
            : (targetEl
                .closest('.artdeco-dropdown, .fb-dash-form-element')
                ?.querySelector(
                  'button[aria-haspopup="listbox"], button.artdeco-dropdown__trigger, div[role="combobox"]',
                ) as HTMLElement | null);

        if (customTrigger) {
          // Click trigger to open dropdown
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
            customTrigger.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
          });
          await new Promise(r => setTimeout(r, 250));

          const normVal = val.toLowerCase().trim();
          const isAffirmative = /^(yes|true|1|y|immediate|available|agree|authorized)$/i.test(normVal);
          const isNegative = /^(no|false|0|n|requires|not)$/i.test(normVal);

          const listbox = modal.querySelector('div[role="listbox"], ul[role="listbox"], .artdeco-dropdown__content');
          if (listbox) {
            const optionEls = Array.from(
              listbox.querySelectorAll('[role="option"], li, .artdeco-dropdown__item'),
            ) as HTMLElement[];

            let matchedOpt = optionEls.find(o => {
              const txt = cleanDuplicateString(o.textContent || '')
                .toLowerCase()
                .trim();
              return txt === normVal || (normVal.length > 2 && txt.includes(normVal));
            });

            if (!matchedOpt && isAffirmative) {
              matchedOpt = optionEls.find(o => /^(yes|agree)$/i.test(cleanDuplicateString(o.textContent || '').trim()));
            } else if (!matchedOpt && isNegative) {
              matchedOpt = optionEls.find(o => /^no$/i.test(cleanDuplicateString(o.textContent || '').trim()));
            }

            if (matchedOpt) {
              ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                matchedOpt.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
              });
              await new Promise(r => setTimeout(r, 150));
              return true;
            }
          }
        }
      }

      return false;
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(fillInPage, identifier, value);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: fillInPage,
          args: [identifier, value],
        });
        return Boolean(results?.[0]?.result);
      } catch {}
    }

    return false;
  }

  /**
   * Extracts job top-card context (title, company, location, closed status, already applied, hasEasyApply, login wall)
   * Polling up to timeoutMs to allow asynchronous page components to render.
   */
  async extractJobTopCardContext(timeoutMs = 12000): Promise<JobTopCardContext> {
    const startTime = Date.now();
    const pollInterval = 600;

    const extractTopCardInPage = () => {
      const url = window.location.href.toLowerCase();
      const pathname = window.location.pathname.toLowerCase();

      // 1. Check for Login wall / Auth redirect
      const isAuthUrl =
        pathname.includes('/login') ||
        pathname.includes('/authwall') ||
        pathname.includes('/checkpoint') ||
        url.includes('linkedin.com/uas/login');

      const hasLoginForm = !!(
        document.querySelector('form.login__form') ||
        document.querySelector('#username') ||
        document.querySelector('input[name="session_key"]') ||
        document.querySelector('.authwall-join-form') ||
        document.querySelector('form[data-id="sign-in-form"]')
      );

      const hasJobContent = !!document.querySelector(
        '.jobs-unified-top-card, .jobs-search__job-details--container, div[data-job-id], h1.job-details-jobs-unified-top-card__job-title, .topcard',
      );

      const isLoginWall = isAuthUrl || (hasLoginForm && !hasJobContent);

      function cleanLinkedInJobTitle(raw: string): string {
        if (!raw) return '';
        let txt = raw
          .replace(/\bwith verification\b/gi, '')
          .replace(/\bactively recruiting\b/gi, '')
          .replace(/\bpromoted\b/gi, '')
          .replace(/\beasy apply\b/gi, '')
          .replace(/[\n\r]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (txt.length > 4 && txt.length % 2 === 0) {
          const half = txt.slice(0, txt.length / 2);
          if (half + half === txt) {
            txt = half;
          }
        }

        const words = txt.split(' ');
        if (words.length >= 2 && words.length % 2 === 0) {
          const halfLen = words.length / 2;
          const firstHalf = words.slice(0, halfLen).join(' ');
          const secondHalf = words.slice(halfLen).join(' ');
          if (firstHalf.toLowerCase() === secondHalf.toLowerCase()) {
            txt = firstHalf;
          }
        }

        const match = txt.match(/^(.{3,40}?)\s+\1(?:\b.*)?$/i);
        if (match && match[1]) {
          txt = match[1];
        }

        return txt.trim();
      }

      function cleanElementText(el: Element | null): string {
        if (!el) return '';
        const clone = el.cloneNode(true) as HTMLElement;
        const hidden = clone.querySelectorAll(
          '.visually-hidden, [aria-hidden="true"], .sr-only, .job-card-container__verification-badge, .job-details-jobs-unified-top-card__verification-badge, .artdeco-entity-lockup__badge, [data-test-icon*="verification"]',
        );
        hidden.forEach(h => h.remove());
        let txt = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) {
          txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        }
        return cleanLinkedInJobTitle(txt);
      }

      function cleanDuplicateString(text: string): string {
        if (!text) return '';
        text = text
          .replace(/[\n\r\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length <= 4) return text;

        if (text.length % 2 === 0) {
          const half = text.slice(0, text.length / 2);
          if (half + half === text) return half;
        }

        const mid = Math.floor(text.length / 2);
        if (text[mid] === ' ') {
          const left = text.slice(0, mid).trim();
          const right = text.slice(mid + 1).trim();
          if (left === right) return left;
        }

        const words = text.split(/\s+/);
        if (words.length >= 4 && words.length % 2 === 0) {
          const halfLen = words.length / 2;
          const w1 = words.slice(0, halfLen).join(' ');
          const w2 = words.slice(halfLen).join(' ');
          if (w1 === w2) return w1;
        }

        for (let len = Math.floor(text.length / 2); len >= 8; len--) {
          const candidate = text.slice(0, len).trim();
          const remainder = text.slice(len).trim();
          if (candidate.length > 6) {
            const normC = candidate.replace(/[*?.\s]/g, '').toLowerCase();
            const normR = remainder.replace(/[*?.\s]/g, '').toLowerCase();
            if (normC.length > 6 && (normC === normR || normR.startsWith(normC))) {
              return candidate;
            }
          }
        }

        return text;
      }

      // 2. Extract Title (broadened selectors for search pane, collections & standalone view)
      const titleEl = document.querySelector(
        'h1.job-details-jobs-unified-top-card__job-title, h2.job-details-jobs-unified-top-card__job-title, .job-details-jobs-unified-top-card__job-title a, .jobs-unified-top-card__job-title, .jobs-search__job-details--container h1, .jobs-search__job-details--container h2, .jobs-details__main-content h1, .jobs-details__main-content h2, h1.t-24, h1.top-card-layout__title, .job-view-layout h1, .job-view-layout h2, [data-job-id].jobs-search-results-list__list-item--active .job-card-list__title, [data-job-id].jobs-search-results-list__list-item--active a[href*="/jobs/view/"]',
      );
      let title = cleanLinkedInJobTitle(cleanElementText(titleEl));

      // 3. Extract Company (broadened selectors for search pane, collections & standalone view)
      const companyEl = document.querySelector(
        '.job-details-jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name a, a.topcard__org-name-link, a[data-tracking-control-name*="company"], .jobs-details__main-content a[href*="/company/"], .jobs-unified-top-card__subtitle-primary-grouping a, .jobs-unified-top-card__primary-description a, .jobs-search-results-list__list-item--active .job-card-container__company-name, .jobs-search-results-list__list-item--active .artdeco-entity-lockup__subtitle',
      );
      let company = cleanElementText(companyEl);
      if (!company) {
        const compLink = document.querySelector('.jobs-unified-top-card a[href*="/company/"]');
        company = cleanElementText(compLink);
      }
      if (!company) {
        company = 'Unknown Company';
      }

      // Fallback: If title or company missing from DOM selectors, extract from document.title
      // LinkedIn document.title pattern: "Full Stack Developer | AutoRABIT | LinkedIn" or "Job Title - Company - Location"
      if (!title || company === 'Unknown Company') {
        const rawDocTitle = (document.title || '')
          .replace(/\s*\|\s*LinkedIn$/i, '')
          .replace(/\s*-\s*LinkedIn$/i, '')
          .trim();
        if (rawDocTitle && !rawDocTitle.toLowerCase().includes('feed') && !/^jobs\b/i.test(rawDocTitle)) {
          let parsedTitle = '';
          let parsedCompany = '';
          if (rawDocTitle.includes(' | ')) {
            const parts = rawDocTitle.split(' | ');
            parsedTitle = parts[0]?.trim();
            parsedCompany = parts[1]?.trim();
          } else if (rawDocTitle.includes(' at ')) {
            const parts = rawDocTitle.split(' at ');
            parsedTitle = parts[0]?.trim();
            parsedCompany = parts[1]?.trim();
          } else if (rawDocTitle.includes(' - ')) {
            const parts = rawDocTitle.split(' - ');
            parsedTitle = parts[0]?.trim();
            parsedCompany = parts[1]?.trim();
          }
          if (!title && parsedTitle) title = cleanLinkedInJobTitle(cleanDuplicateString(parsedTitle));
          if (company === 'Unknown Company' && parsedCompany) company = cleanDuplicateString(parsedCompany);
        }
      }

      // 4. Extract Location
      const locationEl = document.querySelector(
        '.job-details-jobs-unified-top-card__bullet, .jobs-unified-top-card__bullet, .topcard__flavor--bullet, .jobs-unified-top-card__workplace-type, .jobs-unified-top-card__primary-description span:nth-of-type(2)',
      );
      let location = (locationEl?.textContent || '').trim().replace(/^·\s*/, '');

      // 5. Closed check: "No longer accepting applications"
      const fullText = document.body ? document.body.innerText || '' : '';
      const isClosed =
        /no longer accepting applications/i.test(fullText) ||
        !!document.querySelector('.artdeco-inline-feedback--error, .jobs-details-top-card__closed-badge');

      // 6. Already applied check
      let isAlreadyApplied = false;
      const appliedBadge = document.querySelector(
        '.jobs-s-apply__application-link, .artdeco-inline-feedback--success, .jobs-details-top-card__applied-badge, [data-test-applied-badge]',
      );
      if (appliedBadge && /applied/i.test(appliedBadge.textContent || '')) {
        isAlreadyApplied = true;
      } else {
        const applyButtons = Array.from(
          document.querySelectorAll('button.jobs-apply-button, .jobs-apply-button--top-card, button[data-job-id]'),
        );
        for (const btn of applyButtons) {
          const btnText = (btn.textContent || '').trim();
          if (/^applied/i.test(btnText)) {
            isAlreadyApplied = true;
            break;
          }
        }
        if (!isAlreadyApplied && /you applied on|applied \d+ (day|hour|week|month)s? ago/i.test(fullText)) {
          isAlreadyApplied = true;
        }
      }

      // 7. Easy Apply check: scoped to job details container to avoid search card false matches
      let hasEasyApply = false;
      const detailsRoot =
        document.querySelector('.jobs-search__job-details--container') ||
        document.querySelector('.jobs-details__main-content') ||
        document.querySelector('.job-view-layout') ||
        document.querySelector('.jobs-unified-top-card') ||
        document.querySelector('[data-view-name="job-details-top-card"]') ||
        document;

      const applyButtons = Array.from(detailsRoot.querySelectorAll('button, a'));
      for (const btn of applyButtons) {
        if (btn.closest('.jobs-search-results-list, .scaffold-layout__list')) {
          continue;
        }
        const btnText = (btn.textContent || '').trim();
        const ariaLabel = (btn.getAttribute('aria-label') || '').trim();
        if (
          /easy\s*apply/i.test(btnText) ||
          /easy\s*apply/i.test(ariaLabel) ||
          btn.querySelector('svg[data-test-icon*="easy-apply"]') !== null
        ) {
          hasEasyApply = true;
          break;
        }
      }

      // 8. Extract Description Snippet
      const descEl = document.querySelector(
        '#job-details, .jobs-description__content, .jobs-description, .jobs-box__html-content, article.jobs-description__container',
      );
      const descriptionSnippet = (descEl?.textContent || '')
        .replace(/[\n\r]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 3000);

      return {
        title: title || 'LinkedIn Job',
        company: company || 'Unknown Company',
        location,
        isClosed,
        isAlreadyApplied,
        hasEasyApply,
        isLoginWall,
        descriptionSnippet,
      };
    };

    while (Date.now() - startTime < timeoutMs) {
      if (!this._puppeteerPage) {
        await this.attachPuppeteer().catch(() => false);
      }

      try {
        let info: JobTopCardContext | null = null;
        if (this._puppeteerPage) {
          try {
            info = await this._puppeteerPage.evaluate(extractTopCardInPage);
          } catch (pErr) {
            logger.debug(
              '[extractJobTopCardContext] Puppeteer evaluate threw, trying chrome.scripting fallback:',
              pErr,
            );
          }
        }

        if (!info && this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: this._tabId },
              func: extractTopCardInPage,
            });
            info = (results?.[0]?.result as JobTopCardContext) || null;
          } catch (sErr) {
            logger.debug('[extractJobTopCardContext] chrome.scripting fallback error:', sErr);
          }
        }

        if (info) {
          // If login wall, return immediately so runner can handle pause
          if (info.isLoginWall) {
            return info;
          }

          // Return immediately only if BOTH title and company were successfully resolved,
          // or if known terminal state (closed, already applied)
          if ((info.title && info.company) || info.isClosed || info.isAlreadyApplied) {
            return info;
          }
        }
      } catch (e) {
        logger.debug('Error extracting job top-card:', e);
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    return {
      title: '',
      company: '',
      location: '',
      isClosed: false,
      isAlreadyApplied: false,
      hasEasyApply: false,
      isLoginWall: false,
    };
  }

  /**
   * Reads job cards from the LinkedIn left-hand search results pane.
   * Scrolls the list container to trigger lazy loading of cards.
   */
  async readJobListFromSearchPane(scrollAttempts = 4): Promise<SearchJobCard[]> {
    const extractCardsInPage = async (scrolls: number) => {
      for (let s = 0; s < scrolls; s++) {
        const containers = [
          document.querySelector('.jobs-search-results-list'),
          document.querySelector('.scaffold-layout__list'),
          document.querySelector('.scaffold-layout__list-container'),
          document.querySelector('.jobs-search-results-list__list'),
          document.querySelector('div[data-view-name="job-card"]')?.parentElement,
          document.querySelector('div[data-view-name*="job-card"]')?.parentElement,
          document.querySelector('ul.scaffold-layout__list-container'),
        ].filter(Boolean) as HTMLElement[];

        let scrolled = false;
        for (const c of containers) {
          if (c.scrollHeight > c.clientHeight) {
            c.scrollBy(0, 500);
            scrolled = true;
          }
        }
        if (!scrolled) {
          window.scrollBy(0, 500);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      function cleanLinkedInJobTitle(raw: string): string {
        if (!raw) return '';
        let txt = raw
          .replace(/\bwith verification\b/gi, '')
          .replace(/\bactively recruiting\b/gi, '')
          .replace(/\bpromoted\b/gi, '')
          .replace(/\beasy apply\b/gi, '')
          .replace(/[\n\r]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (txt.length > 4 && txt.length % 2 === 0) {
          const half = txt.slice(0, txt.length / 2);
          if (half + half === txt) {
            txt = half;
          }
        }

        const words = txt.split(' ');
        if (words.length >= 2 && words.length % 2 === 0) {
          const halfLen = words.length / 2;
          const firstHalf = words.slice(0, halfLen).join(' ');
          const secondHalf = words.slice(halfLen).join(' ');
          if (firstHalf.toLowerCase() === secondHalf.toLowerCase()) {
            txt = firstHalf;
          }
        }

        const match = txt.match(/^(.{3,40}?)\s+\1(?:\b.*)?$/i);
        if (match && match[1]) {
          txt = match[1];
        }

        return txt.trim();
      }

      function cleanElementText(el: Element | null): string {
        if (!el) return '';
        const clone = el.cloneNode(true) as HTMLElement;
        const hidden = clone.querySelectorAll(
          '.visually-hidden, [aria-hidden="true"], .sr-only, .job-card-container__verification-badge, .job-details-jobs-unified-top-card__verification-badge, .artdeco-entity-lockup__badge, [data-test-icon*="verification"]',
        );
        hidden.forEach(h => h.remove());
        let txt = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) {
          txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        }
        if (txt.length <= 4) return txt;

        if (txt.length % 2 === 0) {
          const half = txt.slice(0, txt.length / 2);
          if (half + half === txt) return half;
        }

        const mid = Math.floor(txt.length / 2);
        if (txt[mid] === ' ') {
          const left = txt.slice(0, mid).trim();
          const right = txt.slice(mid + 1).trim();
          if (left === right) return left;
        }

        const words = txt.split(/\s+/);
        if (words.length >= 4 && words.length % 2 === 0) {
          const halfLen = words.length / 2;
          const w1 = words.slice(0, halfLen).join(' ');
          const w2 = words.slice(halfLen).join(' ');
          if (w1 === w2) return w1;
        }

        return txt;
      }

      const candidateContainers = [
        document.querySelector('.jobs-search-results-list'),
        document.querySelector('.scaffold-layout__list'),
        document.querySelector('.scaffold-layout__list-container'),
        document.querySelector('.jobs-search-results-list__list'),
        document.querySelector('ul.scaffold-layout__list-container'),
        document,
      ].filter(Boolean) as (Element | Document)[];

      const cardSelectors = [
        'li.jobs-search-results__list-item',
        'li.scaffold-layout__list-item',
        'li[data-occludable-job-id]',
        'div.job-card-container',
        'div[data-job-id]',
        'div[data-occludable-job-id]',
        '[data-view-name="job-card"]',
        '[data-view-name*="job-card"]',
        '[data-view-name="search-entity-result-universal-template"]',
        '.job-card-list__entity-lockup',
        'div.base-card',
      ].join(', ');

      let cards: HTMLElement[] = [];
      for (const container of candidateContainers) {
        const found = Array.from(container.querySelectorAll(cardSelectors)) as HTMLElement[];
        if (found.length > 0) {
          cards = found;
          break;
        }
      }

      // Global fallback across entire document
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll(cardSelectors)) as HTMLElement[];
      }

      // Fallback: search for any anchor tag with /jobs/view/ or currentJobId=
      if (cards.length === 0) {
        const links = Array.from(
          document.querySelectorAll('a[href*="/jobs/view/"], a[href*="currentJobId="]'),
        ) as HTMLElement[];
        const linkParents = new Set<HTMLElement>();
        for (const l of links) {
          const parent = (l.closest('li, div[data-job-id], .job-card-container, [data-view-name="job-card"]') ||
            l.parentElement) as HTMLElement;
          if (parent) linkParents.add(parent);
        }
        cards = Array.from(linkParents);
      }

      const results: SearchJobCard[] = [];
      const seenJobIds = new Set<string>();

      for (const card of cards) {
        // 1. Try finding job ID from data attributes on card or child elements
        let jobId =
          card.getAttribute('data-job-id') ||
          card.getAttribute('data-occludable-job-id') ||
          card.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
          card.querySelector('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id') ||
          (card as any).dataset?.jobId ||
          (card as any).dataset?.occludableJobId ||
          '';

        if (jobId && jobId.includes('urn:li:jobPosting:')) {
          const urnMatch = jobId.match(/(\d+)/);
          if (urnMatch && urnMatch[1]) {
            jobId = urnMatch[1];
          }
        }

        // 2. Try finding job link
        const link =
          card.querySelector<HTMLAnchorElement>(
            'a.job-card-container__link, a.job-card-list__title, a.job-card-container__link--cursor-pointer, a[href*="/jobs/view/"], a[href*="currentJobId="], a[data-control-name="job_card_title"], a[href*="/jobs/"]',
          ) || (card.tagName.toLowerCase() === 'a' ? (card as HTMLAnchorElement) : null);

        if (!jobId && link) {
          const href = link.href || '';
          const match = href.match(/(?:\/jobs\/view\/|currentJobId=|\/jobs\/)(\d+)/);
          if (match && match[1]) {
            jobId = match[1];
          }
        }

        // 3. Check any anchor tag inside card
        if (!jobId) {
          const anyLink = card.querySelector<HTMLAnchorElement>('a[href*="/jobs/"], a[href*="currentJobId="]');
          if (anyLink) {
            const href = anyLink.href || '';
            const match = href.match(/(?:\/jobs\/view\/|currentJobId=)(\d+)/) || href.match(/(\d{7,12})/);
            if (match && match[1]) {
              jobId = match[1];
            }
          }
        }

        // 4. Try finding urn anywhere in card or its children
        if (!jobId) {
          const urnEl = card.querySelector('[data-entity-urn], [data-job-urn]');
          const urn =
            card.getAttribute('data-entity-urn') ||
            card.getAttribute('data-job-urn') ||
            urnEl?.getAttribute('data-entity-urn') ||
            urnEl?.getAttribute('data-job-urn') ||
            '';
          const urnMatch = urn.match(/urn:li:jobPosting:(\d+)/) || urn.match(/(\d{7,12})/);
          if (urnMatch && urnMatch[1]) {
            jobId = urnMatch[1];
          }
        }

        if (!jobId || seenJobIds.has(jobId)) {
          continue;
        }
        seenJobIds.add(jobId);

        // Extract title
        const titleEl = card.querySelector(
          'a.job-card-list__title, .job-card-container__link, .artdeco-entity-lockup__title, strong, h3, [data-control-name="job_card_title"]',
        );
        const rawTitle = cleanElementText(titleEl) || cleanElementText(link);
        const title = cleanLinkedInJobTitle(rawTitle);

        // Extract company
        const companyEl = card.querySelector(
          '.job-card-container__company-name, .artdeco-entity-lockup__subtitle, .job-card-container__primary-description, span.t-14, [data-control-name="job_card_company"]',
        );
        const company = cleanElementText(companyEl) || 'Unknown Company';

        const url = `https://www.linkedin.com/jobs/view/${jobId}/`;

        results.push({
          jobId,
          title: title || 'LinkedIn Job',
          company: company,
          url,
        });
      }

      return results;
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        const cards = await this._puppeteerPage.evaluate(extractCardsInPage, scrollAttempts);
        if (Array.isArray(cards) && cards.length > 0) {
          return cards;
        }
      } catch (err) {
        logger.warning(
          '[readJobListFromSearchPane] Puppeteer evaluation failed, trying chrome.scripting fallback:',
          err,
        );
      }
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: extractCardsInPage,
          args: [scrollAttempts],
        });
        const cards = results?.[0]?.result;
        if (Array.isArray(cards) && cards.length > 0) {
          return cards as SearchJobCard[];
        }
      } catch (scriptErr) {
        logger.warning('[readJobListFromSearchPane] chrome.scripting fallback error:', scriptErr);
      }
    }

    return [];
  }

  /**
   * Clicks a specific job item in the left-hand search results pane to load it in the right details pane.
   */
  async clickJobInSearchList(jobId: string): Promise<boolean> {
    const clickInPage = (targetId: string): boolean => {
      function findAndClickCard(): boolean {
        const candidateContainers = [
          document.querySelector('.jobs-search-results-list'),
          document.querySelector('.scaffold-layout__list'),
          document.querySelector('.scaffold-layout__list-container'),
          document.querySelector('.jobs-search-results-list__list'),
          document,
        ].filter(Boolean) as (Element | Document)[];

        const cardSelectors = [
          'li.jobs-search-results__list-item',
          'li.scaffold-layout__list-item',
          'li[data-occludable-job-id]',
          'div.job-card-container',
          'div[data-job-id]',
          'div[data-occludable-job-id]',
          '[data-view-name="job-card"]',
          '[data-view-name*="job-card"]',
          '[data-view-name="search-entity-result-universal-template"]',
          '.job-card-list__entity-lockup',
          'div.base-card',
        ].join(', ');

        let cards: HTMLElement[] = [];
        for (const container of candidateContainers) {
          const found = Array.from(container.querySelectorAll(cardSelectors)) as HTMLElement[];
          if (found.length > 0) {
            cards = found;
            break;
          }
        }
        if (cards.length === 0) {
          cards = Array.from(document.querySelectorAll(cardSelectors)) as HTMLElement[];
        }

        for (const card of cards) {
          const cardJobId =
            card.getAttribute('data-job-id') ||
            card.getAttribute('data-occludable-job-id') ||
            (card as any).dataset?.jobId ||
            (card as any).dataset?.occludableJobId ||
            '';

          const link = card.querySelector<HTMLAnchorElement>(
            'a.job-card-container__link, a.job-card-list__title, a[href*="/jobs/view/"], a[href*="currentJobId="]',
          );

          let matches = cardJobId === targetId;
          if (!matches && link) {
            matches = link.href.includes(targetId);
          }
          if (!matches) {
            const anyLink = card.querySelector<HTMLAnchorElement>(`a[href*="${targetId}"]`);
            if (anyLink) matches = true;
          }

          if (matches) {
            const targetEl = link || card.querySelector<HTMLElement>('a, .job-card-list__title') || card;
            targetEl.scrollIntoView({ behavior: 'instant', block: 'center' });
            targetEl.focus?.();
            targetEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            targetEl.click();
            return true;
          }
        }

        // Direct anchor fallback
        const directAnchor = document.querySelector<HTMLAnchorElement>(`a[href*="${targetId}"]`);
        if (directAnchor) {
          directAnchor.scrollIntoView({ behavior: 'instant', block: 'center' });
          directAnchor.focus?.();
          directAnchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          directAnchor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          directAnchor.click();
          return true;
        }

        return false;
      }

      // First attempt on visible DOM cards
      if (findAndClickCard()) return true;

      // Second attempt: progressive scroll on left pane container to bring virtualized cards into DOM
      const scrollableList =
        (document.querySelector('.jobs-search-results-list') as HTMLElement) ||
        (document.querySelector('.scaffold-layout__list') as HTMLElement) ||
        (document.querySelector('.jobs-search-results-list__list') as HTMLElement);
      if (scrollableList) {
        scrollableList.scrollTop += 500;
        return findAndClickCard();
      }

      return false;
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        const clicked = await this._puppeteerPage.evaluate(clickInPage, jobId);
        if (clicked) return true;
      } catch (err) {
        logger.warning('[clickJobInSearchList] Puppeteer click failed, trying chrome.scripting fallback:', err);
      }
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: clickInPage,
          args: [jobId],
        });
        return Boolean(results?.[0]?.result);
      } catch (scriptErr) {
        logger.warning('[clickJobInSearchList] chrome.scripting click fallback error:', scriptErr);
      }
    }

    return false;
  }

  /**
   * Dismisses the active Easy Apply modal cleanly, handling any "Save application? -> Discard" dialogs.
   */
  async dismissEasyApplyModal(maxWaitMs = 5000): Promise<boolean> {
    const dismissInPage = () => {
      // Check if modal or intermediate dialog exists
      const modal = document.querySelector(
        'div.jobs-easy-apply-modal, div[data-test-modal], div.artdeco-modal, dialog[open], div[role="dialog"]',
      );
      if (!modal) {
        return { isClosed: true };
      }

      // Check for Discard confirmation dialog buttons
      const buttons = Array.from(document.querySelectorAll('button'));
      const discardBtn = buttons.find(
        b =>
          /discard/i.test(b.textContent || '') ||
          b.getAttribute('data-control-name') === 'discard_application_confirm_btn',
      );
      if (discardBtn) {
        discardBtn.click();
        return { clickedDiscard: true };
      }

      // Look for modal close/dismiss button
      const closeBtn =
        modal.querySelector<HTMLButtonElement>(
          'button[aria-label*="Dismiss" i], button[aria-label*="Close" i], button[data-test-modal-close-btn], button[data-control-name="overlay.close_conversation_window"]',
        ) || (document.querySelector('button[data-test-modal-close-btn]') as HTMLButtonElement);

      if (closeBtn) {
        closeBtn.click();
        return { clickedClose: true };
      }

      return { notClosed: true };
    };

    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      let status: { isClosed?: boolean; clickedDiscard?: boolean; clickedClose?: boolean; notClosed?: boolean } = {
        isClosed: true,
      };

      if (!this._puppeteerPage) {
        await this.attachPuppeteer().catch(() => false);
      }

      if (this._puppeteerPage) {
        try {
          status = await this._puppeteerPage.evaluate(dismissInPage);
        } catch {}
      } else if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: this._tabId },
            func: dismissInPage,
          });
          if (results?.[0]?.result) {
            status = results[0].result;
          }
        } catch {}
      }

      if (status.isClosed) {
        return true;
      }
      await new Promise(r => setTimeout(r, 400));
    }

    const isOpen = await this.isEasyApplyModalOpen();
    return !isOpen;
  }

  /**
   * Discovers all interactive form fields within the active Easy Apply modal.
   */
  async discoverModalFormFields(): Promise<FormFieldDescriptor[]> {
    const discoverInPage = () => {
      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];

        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) {
            continue;
          }
          const text = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (/^\d+\s*notifications?$/i.test(text) || c.closest('.notifications-badge')) {
            continue;
          }
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;

          if (
            c.classList.contains('jobs-easy-apply-modal') ||
            c.hasAttribute('data-easy-apply-modal') ||
            c.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
            c.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
            ) !== null
          ) {
            return c;
          }

          const titleEl = c.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const titleText = (titleEl?.textContent || text.slice(0, 100)).toLowerCase();
          const hasApplyTitle = /apply|application|job/i.test(titleText);
          const hasPrimaryBtn =
            c.querySelector(
              'button.artdeco-button--primary, button[data-easy-apply-next-button], button[aria-label*="next" i], button[aria-label*="submit" i], button[aria-label*="review" i], button[aria-label*="continue" i]',
            ) !== null;

          if (hasApplyTitle || hasPrimaryBtn) {
            return c;
          }
        }

        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            const found = findActiveModal(all[i].shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      function cleanDuplicateText(rawText: string): string {
        if (!rawText) return '';
        let text = rawText
          .replace(/[\n\r\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length <= 4) return text;

        // 1. Direct concatenation without separator: "Question?Question?"
        if (text.length % 2 === 0) {
          const half = text.slice(0, text.length / 2);
          if (half + half === text) return half;
        }

        // 2. Space-separated exact duplication: "Question? Question?"
        const mid = Math.floor(text.length / 2);
        if (text[mid] === ' ') {
          const left = text.slice(0, mid).trim();
          const right = text.slice(mid + 1).trim();
          if (left === right) return left;
        }

        // 3. Word-based even split:
        const words = text.split(/\s+/);
        if (words.length >= 4 && words.length % 2 === 0) {
          const halfLen = words.length / 2;
          const w1 = words.slice(0, halfLen).join(' ');
          const w2 = words.slice(halfLen).join(' ');
          if (w1 === w2) return w1;
        }

        // 4. Repeated sentence split on punctuation:
        const punctMatch = text.match(/^(.+?[?.!*])\s+(.+)$/);
        if (punctMatch) {
          const p1 = punctMatch[1].trim();
          const p2 = punctMatch[2].trim();
          const normP1 = p1.replace(/[*?.\s]/g, '').toLowerCase();
          const normP2 = p2.replace(/[*?.\s]/g, '').toLowerCase();
          if (normP1 && (normP1 === normP2 || normP2.startsWith(normP1))) return p1;
        }

        // 5. General substring repetition search:
        for (let len = Math.floor(text.length / 2); len >= 8; len--) {
          const candidate = text.slice(0, len).trim();
          const remainder = text.slice(len).trim();
          if (candidate.length > 6) {
            const normC = candidate.replace(/[*?.\s]/g, '').toLowerCase();
            const normR = remainder.replace(/[*?.\s]/g, '').toLowerCase();
            if (normC.length > 6 && (normC === normR || normR.startsWith(normC))) {
              return candidate;
            }
          }
        }

        return text;
      }

      function cleanElementText(el: Element | null): string {
        if (!el) return '';
        const clone = el.cloneNode(true) as HTMLElement;
        const hidden = clone.querySelectorAll(
          '.visually-hidden, [aria-hidden="true"], .sr-only, .u-screen-reader-only',
        );
        hidden.forEach(h => h.remove());
        let txt = (clone.textContent || '')
          .replace(/[\n\r\t]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!txt) {
          txt = (el.textContent || '')
            .replace(/[\n\r\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }
        return cleanDuplicateText(txt);
      }

      function cleanDuplicateString(text: string): string {
        return cleanDuplicateText(text);
      }

      const modal = findActiveModal(document);
      if (!modal) return [];
      const descriptors: FormFieldDescriptor[] = [];

      // 1. Radio groups and Checkbox groups (fieldsets / role="radiogroup")
      const fieldsets = Array.from(
        modal.querySelectorAll('fieldset, div[role="radiogroup"], div[role="group"]'),
      ) as HTMLElement[];
      for (const fs of fieldsets) {
        const radios = Array.from(fs.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
        const checkboxes = Array.from(fs.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];

        if (radios.length > 0) {
          const legend = fs.querySelector('legend, [role="heading"], label');
          const legendText = cleanElementText(legend);
          if (!legendText) continue;

          const anyChecked = radios.some(r => r.checked);
          if (!anyChecked) {
            const options = radios
              .map(r => {
                const rId = r.getAttribute('id');
                const rLbl = rId ? fs.querySelector(`label[for="${rId}"]`) : null;
                return cleanElementText(rLbl) || (r.value || '').trim();
              })
              .filter(Boolean);

            let hintText = '';
            const hintEl = fs.querySelector(
              '.fb-dash-form-element__hint, .artdeco-text-input--hint, span.t-12, [id*="hint"], [data-test-form-element-hint]',
            );
            if (hintEl) hintText = cleanElementText(hintEl);

            const isExplicitlyOptional =
              /\boptional\b/i.test(legendText) ||
              Boolean(
                fs.querySelector(
                  '.fb-dash-form-element__label-title--optional, [data-test-form-element-optional], .artdeco-form__label--optional',
                ) || fs.closest('.fb-dash-form-element--optional, [data-test-form-element-optional]'),
              );

            descriptors.push({
              label: legendText,
              fieldType: 'radio',
              options,
              hintText: hintText || undefined,
              required: !isExplicitlyOptional,
            });
          }
        } else if (checkboxes.length > 0) {
          const legend = fs.querySelector('legend, [role="heading"], label');
          const legendText = cleanElementText(legend);
          if (!legendText) continue;

          const anyChecked = checkboxes.some(c => c.checked);
          if (!anyChecked) {
            const options = checkboxes
              .map(c => {
                const cId = c.getAttribute('id');
                const cLbl = cId ? fs.querySelector(`label[for="${cId}"]`) : null;
                return cleanElementText(cLbl) || (c.value || '').trim();
              })
              .filter(Boolean);

            const isExplicitlyOptional =
              /\boptional\b/i.test(legendText) ||
              Boolean(
                fs.querySelector(
                  '.fb-dash-form-element__label-title--optional, [data-test-form-element-optional], .artdeco-form__label--optional',
                ) || fs.closest('.fb-dash-form-element--optional, [data-test-form-element-optional]'),
              );

            descriptors.push({
              label: legendText,
              fieldType: 'checkbox',
              options,
              required: !isExplicitlyOptional,
            });
          }
        }
      }

      // 1b. Standalone checkboxes outside fieldsets (e.g. Terms, Acknowledgment, Agreements)
      const standaloneCheckboxes = Array.from(modal.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
      for (const cb of standaloneCheckboxes) {
        if (cb.closest('fieldset, div[role="radiogroup"], div[role="group"]')) continue;
        if (cb.checked) continue;

        let label = '';
        const id = cb.getAttribute('id');
        if (id) {
          const lbl = modal.querySelector(`label[for="${id}"]`);
          if (lbl) label = cleanElementText(lbl);
        }
        if (!label) {
          const parent = cb.closest('.fb-dash-form-element, div[data-test-form-element], label');
          if (parent) label = cleanElementText(parent);
        }
        if (!label) label = cleanDuplicateString(cb.getAttribute('aria-label') || '');

        if (!label) continue;

        const isRequired =
          cb.hasAttribute('required') ||
          cb.getAttribute('aria-required') === 'true' ||
          /agree|terms|certify|acknowledge|consent|confirm/i.test(label);

        descriptors.push({
          id: cb.id || undefined,
          label,
          fieldType: 'checkbox',
          options: ['Yes', 'No'],
          required: isRequired,
        });
      }

      // 2. Selects / Dropdowns
      const selects = Array.from(modal.querySelectorAll('select')) as HTMLSelectElement[];
      for (const sel of selects) {
        const val = sel.value || '';
        const selectedText = sel.selectedOptions[0]?.text || '';
        if (!val || /select an option|please select|^--/i.test(selectedText)) {
          let label = '';
          const id = sel.getAttribute('id');
          if (id) {
            const lbl = modal.querySelector(`label[for="${id}"]`);
            if (lbl) label = cleanElementText(lbl);
          }
          let parent: HTMLElement | null = null;
          if (!label) {
            parent = sel.closest(
              'div.fb-dash-form-element, div.jobs-easy-apply-form-element, div[data-test-form-element]',
            );
            const lbl = parent?.querySelector('label');
            if (lbl) label = cleanElementText(lbl);
          }
          if (!label) label = cleanDuplicateString(sel.getAttribute('aria-label') || '');

          let hintText = '';
          const describedBy = sel.getAttribute('aria-describedby');
          if (describedBy) {
            const ids = describedBy.split(/\s+/);
            const parts: string[] = [];
            for (const did of ids) {
              if (!did) continue;
              try {
                const el = modal.querySelector(`[id="${CSS.escape(did)}"]`) || document.getElementById(did);
                if (el) {
                  const t = cleanElementText(el);
                  if (t) parts.push(t);
                }
              } catch {}
            }
            if (parts.length > 0) hintText = parts.join(' ');
          }
          if (!hintText) {
            if (!parent) {
              parent = sel.closest(
                'div.fb-dash-form-element, div.jobs-easy-apply-form-element, div[data-test-form-element]',
              );
            }
            const hintEl = parent?.querySelector(
              '.fb-dash-form-element__hint, .artdeco-text-input--hint, span.t-12, [id*="hint"], [data-test-form-element-hint]',
            );
            if (hintEl) hintText = cleanElementText(hintEl);
          }

          const options = Array.from(sel.options)
            .map(o => cleanDuplicateString(o.text.trim()))
            .filter(t => !/select an option|please select|^--/i.test(t));

          const isExplicitlyOptional =
            /\boptional\b/i.test(label) ||
            /\boptional\b/i.test(hintText) ||
            Boolean(
              sel.closest(
                '.fb-dash-form-element--optional, [data-test-form-element-optional], .artdeco-form__label--optional',
              ) ||
                parent?.querySelector(
                  '.fb-dash-form-element__label-title--optional, [data-test-form-element-optional]',
                ),
            );
          const isRequired =
            sel.hasAttribute('required') || sel.getAttribute('aria-required') === 'true' || !isExplicitlyOptional;

          descriptors.push({
            id: sel.id || undefined,
            label,
            fieldType: 'dropdown',
            options,
            hintText: hintText || undefined,
            required: isRequired,
          });
        }
      }

      // 3. Inputs (text, number, tel, email) & Textareas
      const inputs = Array.from(
        modal.querySelectorAll(
          'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="file"]), textarea',
        ),
      ) as (HTMLInputElement | HTMLTextAreaElement)[];

      for (const input of inputs) {
        const val = (input.value || '').trim();
        if (!val) {
          let label = '';
          const id = input.getAttribute('id');
          if (id) {
            const lbl = modal.querySelector(`label[for="${id}"]`);
            if (lbl) label = cleanElementText(lbl);
          }
          let parent: HTMLElement | null = null;
          if (!label) {
            parent = input.closest(
              'div.fb-dash-form-element, div.jobs-easy-apply-form-element, div[data-test-form-element]',
            );
            const lbl = parent?.querySelector('label');
            if (lbl) label = cleanElementText(lbl);
          }
          if (!label) label = cleanDuplicateString(input.getAttribute('aria-label') || '');

          const placeholder = cleanDuplicateString(input.getAttribute('placeholder') || '');
          let hintText = '';
          const describedBy = input.getAttribute('aria-describedby');
          if (describedBy) {
            const ids = describedBy.split(/\s+/);
            const parts: string[] = [];
            for (const did of ids) {
              if (!did) continue;
              try {
                const el = modal.querySelector(`[id="${CSS.escape(did)}"]`) || document.getElementById(did);
                if (el) {
                  const t = cleanElementText(el);
                  if (t) parts.push(t);
                }
              } catch {}
            }
            if (parts.length > 0) hintText = parts.join(' ');
          }
          if (!parent) {
            parent = input.closest(
              'div.fb-dash-form-element, div.jobs-easy-apply-form-element, div[data-test-form-element], .artdeco-text-input',
            );
          }
          if (!hintText) {
            const hintEl = parent?.querySelector(
              '.fb-dash-form-element__hint, .artdeco-text-input--hint, .artdeco-form-element__sub-text, span.t-12, [id*="hint"], [id*="helper"], [data-test-form-element-hint]',
            );
            if (hintEl) hintText = cleanElementText(hintEl);
          }
          // Also check for inline error text right next to the input
          const errEl = parent?.querySelector(
            '.artdeco-inline-feedback--error, .inline-feedback--error, [class*="inline-feedback--error"], p[id*="error"], [role="alert"]',
          );
          const activeErrorText = errEl ? cleanElementText(errEl) : '';
          if (activeErrorText) {
            hintText = hintText ? `${hintText} ${activeErrorText}` : activeErrorText;
          }

          const rawMin = input.getAttribute('min');
          const rawMax = input.getAttribute('max');
          let parsedMin = rawMin !== null && !isNaN(Number(rawMin)) ? Number(rawMin) : undefined;
          const parsedMax = rawMax !== null && !isNaN(Number(rawMax)) ? Number(rawMax) : undefined;

          const isTextArea = input.tagName.toLowerCase() === 'textarea';
          const combinedHint = (placeholder + ' ' + hintText).toLowerCase();
          const isSkillOrNumeric =
            /how many years|experience|years|\bdays\b|\bmonths\b|whole\s*number|only\s*(?:whole\s*)?numbers|in\s*inr|in\s*lpa|ctc|decimal\s*number|larger\s*than|greater\s*than|notice\s*period|how\s*soon\s*can\s*you\s*start|availability\s*to\s*join|joining\s*time/i.test(
              label + ' ' + combinedHint,
            ) ||
            input.type === 'number' ||
            input.inputMode === 'numeric' ||
            input.inputMode === 'decimal' ||
            input.getAttribute('data-test-fb-numeric-input') === 'true' ||
            input.getAttribute('data-test-fb-decimal-input') === 'true' ||
            input.hasAttribute('step') ||
            /example:\s*\d+/i.test(combinedHint) ||
            /whole\s*number|decimal\s*number|between \d+ and \d+|larger than \d+|greater than \d+|0 and 99/i.test(
              combinedHint,
            );

          if (/larger\s*than\s*0(?:\.0)?|greater\s*than\s*0(?:\.0)?/i.test(combinedHint)) {
            parsedMin = Math.max(1, parsedMin || 1);
          }

          const isExplicitlyOptional =
            /\boptional\b/i.test(label) ||
            /\boptional\b/i.test(combinedHint) ||
            Boolean(
              input.closest(
                '.fb-dash-form-element--optional, [data-test-form-element-optional], .artdeco-form__label--optional',
              ) ||
                parent?.querySelector(
                  '.fb-dash-form-element__label-title--optional, [data-test-form-element-optional]',
                ),
            );
          const isRequired =
            input.hasAttribute('required') || input.getAttribute('aria-required') === 'true' || !isExplicitlyOptional;

          descriptors.push({
            id: input.id || undefined,
            label,
            fieldType: isSkillOrNumeric ? 'number' : 'text',
            min: parsedMin !== undefined ? parsedMin : isSkillOrNumeric ? 0 : undefined,
            max: parsedMax !== undefined ? parsedMax : /0 and 99/i.test(combinedHint) ? 99 : undefined,
            isTextArea,
            placeholder: placeholder || undefined,
            hintText: hintText || undefined,
            required: isRequired,
          });
        }
      }

      // 4. Standalone Checkboxes
      const checkboxes = Array.from(
        modal.querySelectorAll('input[type="checkbox"]:not([disabled])'),
      ) as HTMLInputElement[];
      for (const cb of checkboxes) {
        if (cb.checked) continue;
        if (cb.closest('fieldset, div[role="radiogroup"], div[role="group"]')) continue;

        let label = '';
        const id = cb.getAttribute('id');
        if (id) {
          const lbl = modal.querySelector(`label[for="${id}"]`);
          if (lbl) label = cleanElementText(lbl);
        }
        let parent: HTMLElement | null = null;
        if (!label) {
          parent = cb.closest(
            'div.fb-dash-form-element, div.jobs-easy-apply-form-element, div[data-test-form-element], label',
          );
          const lbl = parent instanceof HTMLLabelElement ? parent : parent?.querySelector('label');
          if (lbl) label = cleanElementText(lbl);
        }
        if (!label) label = cleanDuplicateString(cb.getAttribute('aria-label') || '');

        if (label) {
          const parentEl = parent || cb.closest('div, section, fieldset, li') || cb.parentElement;
          const parentText = parentEl ? cleanElementText(parentEl).toLowerCase() : '';
          const isTopChoice = /top\s*choice/i.test(label) || /top\s*choice/i.test(parentText);
          const isExplicitlyOptional =
            isTopChoice ||
            /\boptional\b/i.test(label) ||
            /\boptional\b/i.test(parentText) ||
            Boolean(
              parentEl?.querySelector(
                '.fb-dash-form-element__label-title--optional, [data-test-form-element-optional], .artdeco-form__label--optional',
              ),
            );

          const isRequired = cb.hasAttribute('required') || cb.getAttribute('aria-required') === 'true';

          descriptors.push({
            id: cb.id || undefined,
            label,
            fieldType: 'checkbox',
            options: ['Yes', 'No'],
            required: isRequired || !isExplicitlyOptional,
          });
        }
      }

      return descriptors;
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(discoverInPage);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: discoverInPage,
        });
        const res = results?.[0]?.result;
        if (Array.isArray(res)) return res;
      } catch {}
    }

    return [];
  }

  /**
   * Inspects which forward or submission buttons are available on the active modal.
   */
  async getModalActionButtons(): Promise<{
    hasNext: boolean;
    hasReview: boolean;
    hasSubmit: boolean;
  }> {
    const checkInPage = () => {
      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];

        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) {
            continue;
          }
          const text = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (/^\d+\s*notifications?$/i.test(text) || c.closest('.notifications-badge')) continue;
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;

          if (
            c.classList.contains('jobs-easy-apply-modal') ||
            c.hasAttribute('data-easy-apply-modal') ||
            c.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
            c.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
            ) !== null
          ) {
            return c;
          }

          const titleEl = c.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const titleText = (titleEl?.textContent || text.slice(0, 100)).toLowerCase();
          const hasApplyTitle = /apply|application|job|contact info|home address|resume/i.test(titleText);
          const hasPrimaryBtn =
            c.querySelector(
              'button.artdeco-button--primary, button[data-easy-apply-next-button], button[aria-label*="next" i], button[aria-label*="submit" i], button[aria-label*="review" i], button[aria-label*="continue" i]',
            ) !== null;

          if (hasApplyTitle || hasPrimaryBtn) {
            return c;
          }
        }

        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            const found = findActiveModal(all[i].shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const modal = findActiveModal(document);
      const searchRoots: HTMLElement[] = [];
      if (modal) searchRoots.push(modal);
      const artdecoModal = document.querySelector(
        'div.artdeco-modal, .jobs-easy-apply-modal, div[role="dialog"][aria-modal="true"]',
      ) as HTMLElement | null;
      if (artdecoModal && !searchRoots.includes(artdecoModal)) searchRoots.push(artdecoModal);

      const seen = new Set<HTMLElement>();
      const candidateButtons: HTMLElement[] = [];
      const addButton = (b: HTMLElement | null) => {
        if (!b || seen.has(b)) return;
        seen.add(b);
        candidateButtons.push(b);
      };

      // 1. Direct targeted queries for action buttons in modal footers & actionbars (highest priority)
      const actionSelectors = [
        '.jobs-easy-apply-modal__footer button',
        '.jobs-easy-apply-modal__footer [role="button"]',
        '.artdeco-modal__actionbar button',
        '.artdeco-modal__actionbar [role="button"]',
        'div[role="dialog"] footer button',
        'div[role="dialog"] .artdeco-modal__actionbar button',
        'button[data-easy-apply-next-button]',
        'button[aria-label*="continue to next" i]',
        'button[aria-label*="next" i]',
        'button[aria-label*="review" i]',
        'button[aria-label*="submit" i]',
        'button.artdeco-button--primary',
      ];
      for (const sel of actionSelectors) {
        for (const root of searchRoots) {
          try {
            root.querySelectorAll(sel).forEach(el => addButton(el as HTMLElement));
          } catch {}
        }
        try {
          document.querySelectorAll(sel).forEach(el => addButton(el as HTMLElement));
        } catch {}
      }

      // 2. Also add any button inside searchRoots
      for (const root of searchRoots) {
        try {
          root.querySelectorAll('button, [role="button"]').forEach(el => addButton(el as HTMLElement));
        } catch {}
      }

      if (candidateButtons.length === 0 && !modal) return { hasNext: false, hasReview: false, hasSubmit: false };

      let hasNext = false;
      let hasReview = false;
      let hasSubmit = false;

      for (const btn of candidateButtons) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        const dataControl = (btn.getAttribute('data-control-name') || '').trim().toLowerCase();
        const testId = (
          btn.getAttribute('data-test-modal-close-btn') ||
          btn.getAttribute('data-test-dialog-close-btn') ||
          ''
        ).toLowerCase();

        // Skip dismiss / cancel / close / back buttons
        if (
          testId.includes('close') ||
          text === 'dismiss' ||
          text === 'cancel' ||
          text === 'back' ||
          aria.includes('dismiss') ||
          aria.includes('cancel') ||
          aria.includes('close') ||
          btn.classList.contains('artdeco-modal__dismiss')
        ) {
          continue;
        }

        if (
          aria.includes('submit application') ||
          aria.includes('submit') ||
          text === 'submit' ||
          text === 'submit application' ||
          text.includes('submit application') ||
          dataControl.includes('submit')
        ) {
          hasSubmit = true;
        } else if (
          aria.includes('review your application') ||
          aria.includes('review') ||
          text === 'review' ||
          text === 'review application' ||
          text.includes('review your application') ||
          dataControl.includes('review')
        ) {
          hasReview = true;
        } else if (
          aria.includes('continue to next step') ||
          aria.includes('next') ||
          aria.includes('continue') ||
          text === 'next' ||
          text === 'continue' ||
          text.includes('next') ||
          text.includes('continue to next step') ||
          btn.hasAttribute('data-easy-apply-next-button') ||
          dataControl.includes('continue')
        ) {
          hasNext = true;
        }
      }

      // Robust fallback: Check primary button across searchRoots and document
      if (!hasNext && !hasReview && !hasSubmit) {
        for (const scope of [...searchRoots, document]) {
          const primaryBtn = scope.querySelector(
            '.jobs-easy-apply-modal__footer button.artdeco-button--primary, .artdeco-modal__actionbar button.artdeco-button--primary, footer button.artdeco-button--primary, button.artdeco-button--primary',
          ) as HTMLButtonElement | null;
          if (primaryBtn) {
            const pText = (primaryBtn.innerText || primaryBtn.textContent || '').trim().toLowerCase();
            const pAria = (primaryBtn.getAttribute('aria-label') || '').trim().toLowerCase();
            if (
              !pText.includes('dismiss') &&
              !pText.includes('cancel') &&
              !pAria.includes('dismiss') &&
              !pAria.includes('cancel') &&
              !pAria.includes('close')
            ) {
              if (pText.includes('submit') || pAria.includes('submit')) {
                hasSubmit = true;
              } else if (pText.includes('review') || pAria.includes('review')) {
                hasReview = true;
              } else {
                hasNext = true;
              }
              break;
            }
          }
        }
      }

      return { hasNext, hasReview, hasSubmit };
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(checkInPage);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: checkInPage,
        });
        const res = results?.[0]?.result;
        if (res) return res;
      } catch {}
    }

    return { hasNext: false, hasReview: false, hasSubmit: false };
  }

  /**
   * Scrolls the content area of the active modal (top, bottom, or down).
   */
  async scrollModalContent(target: 'bottom' | 'top' | 'down' = 'bottom'): Promise<boolean> {
    const scrollInPage = (dir: 'bottom' | 'top' | 'down') => {
      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];

        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) continue;
          const text = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (/^\d+\s*notifications?$/i.test(text) || c.closest('.notifications-badge')) continue;
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;
          return c;
        }

        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            const found = findActiveModal(all[i].shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const modal = findActiveModal(document);
      const searchRoots: HTMLElement[] = [];
      if (modal) searchRoots.push(modal);
      const artdecoModal = document.querySelector(
        'div.artdeco-modal, .jobs-easy-apply-modal, div[role="dialog"][aria-modal="true"]',
      ) as HTMLElement | null;
      if (artdecoModal && !searchRoots.includes(artdecoModal)) searchRoots.push(artdecoModal);

      // Find scrollable body in modal
      let scrollableContainer: HTMLElement | null = null;
      for (const rootEl of searchRoots) {
        const found = rootEl.querySelector(
          '.jobs-easy-apply-modal__content, .artdeco-modal__content, form.jobs-easy-apply-form, div[role="dialog"] .overflow-y-auto, [data-test-modal-content], .overflow-y-auto',
        ) as HTMLElement | null;
        if (found) {
          scrollableContainer = found;
          break;
        }
      }

      if (!scrollableContainer && modal) {
        // Try finding any element with scrollHeight > clientHeight
        const allDivs = Array.from(modal.querySelectorAll('div, form, section')) as HTMLElement[];
        for (const d of allDivs) {
          if (d.scrollHeight > d.clientHeight && d.clientHeight > 100) {
            scrollableContainer = d;
            break;
          }
        }
      }

      if (!scrollableContainer) {
        scrollableContainer = document.querySelector(
          '.jobs-easy-apply-modal__content, .artdeco-modal__content',
        ) as HTMLElement | null;
      }

      if (!scrollableContainer) return false;

      if (dir === 'bottom') {
        scrollableContainer.scrollTop = scrollableContainer.scrollHeight;
      } else if (dir === 'top') {
        scrollableContainer.scrollTop = 0;
      } else if (dir === 'down') {
        scrollableContainer.scrollTop += Math.max(300, Math.floor(scrollableContainer.clientHeight * 0.7));
      }

      scrollableContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(scrollInPage, target);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: scrollInPage,
          args: [target],
        });
        return Boolean(results?.[0]?.result);
      } catch {}
    }

    return false;
  }

  /**
   * Clicks the Next or Review button in the active modal.
   */
  async clickModalForwardButton(): Promise<{ clicked: boolean; type?: 'next' | 'review' }> {
    const clickInPage = () => {
      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];

        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) {
            continue;
          }
          const text = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (/^\d+\s*notifications?$/i.test(text) || c.closest('.notifications-badge')) continue;
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;

          if (
            c.classList.contains('jobs-easy-apply-modal') ||
            c.hasAttribute('data-easy-apply-modal') ||
            c.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
            c.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
            ) !== null
          ) {
            return c;
          }

          const titleEl = c.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const titleText = (titleEl?.textContent || text.slice(0, 100)).toLowerCase();
          const hasApplyTitle = /apply|application|job|contact info|home address|resume/i.test(titleText);
          const hasPrimaryBtn =
            c.querySelector(
              'button.artdeco-button--primary, button[data-easy-apply-next-button], button[aria-label*="next" i], button[aria-label*="submit" i], button[aria-label*="review" i], button[aria-label*="continue" i]',
            ) !== null;

          if (hasApplyTitle || hasPrimaryBtn) {
            return c;
          }
        }

        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            const found = findActiveModal(all[i].shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const modal = findActiveModal(document);
      const searchRoots: HTMLElement[] = [];
      if (modal) searchRoots.push(modal);
      const artdecoModal = document.querySelector(
        'div.artdeco-modal, .jobs-easy-apply-modal, div[role="dialog"][aria-modal="true"]',
      ) as HTMLElement | null;
      if (artdecoModal && !searchRoots.includes(artdecoModal)) searchRoots.push(artdecoModal);

      // Auto-scroll modal content to bottom so bottom questions & consent checkboxes are in view
      const contentEl = (modal || document).querySelector(
        '.jobs-easy-apply-modal__content, .artdeco-modal__content, form.jobs-easy-apply-form, div[role="dialog"] .overflow-y-auto',
      ) as HTMLElement | null;
      if (contentEl) {
        contentEl.scrollTop = contentEl.scrollHeight;
        contentEl.dispatchEvent(new Event('scroll', { bubbles: true }));
      }

      // Check required or agreement checkboxes if unchecked
      const checkBoxes = Array.from(
        (modal || document).querySelectorAll('input[type="checkbox"]'),
      ) as HTMLInputElement[];
      for (const cb of checkBoxes) {
        if (!cb.checked) {
          const parentText = (cb.closest('label, div, p, fieldset')?.textContent || '').toLowerCase();
          const isConsentOrReq =
            cb.required ||
            cb.getAttribute('aria-required') === 'true' ||
            /agree|consent|terms|acknowledge|certify|confirm|policy/i.test(parentText);
          if (isConsentOrReq) {
            const clickable = cb.closest('label') || cb.parentElement || cb;
            clickable.click();
            if (!cb.checked) {
              cb.checked = true;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }
      }

      const seen = new Set<HTMLElement>();
      const candidateButtons: HTMLElement[] = [];
      const addButton = (b: HTMLElement | null) => {
        if (!b || seen.has(b)) return;
        seen.add(b);
        candidateButtons.push(b);
      };

      // 1. Direct targeted queries for forward action buttons in footers & actionbars
      const actionSelectors = [
        '.jobs-easy-apply-modal__footer button',
        '.jobs-easy-apply-modal__footer [role="button"]',
        '.artdeco-modal__actionbar button',
        '.artdeco-modal__actionbar [role="button"]',
        'div[role="dialog"] footer button',
        'div[role="dialog"] .artdeco-modal__actionbar button',
        'button[data-easy-apply-next-button]',
        'button[aria-label*="continue to next" i]',
        'button[aria-label*="next" i]',
        'button[aria-label*="review" i]',
        'button.artdeco-button--primary',
      ];
      for (const sel of actionSelectors) {
        for (const root of searchRoots) {
          try {
            root.querySelectorAll(sel).forEach(el => addButton(el as HTMLElement));
          } catch {}
        }
        try {
          document.querySelectorAll(sel).forEach(el => addButton(el as HTMLElement));
        } catch {}
      }

      // 2. Also add any button inside searchRoots
      for (const root of searchRoots) {
        try {
          root.querySelectorAll('button, [role="button"]').forEach(el => addButton(el as HTMLElement));
        } catch {}
      }

      if (candidateButtons.length === 0 && !modal) return { clicked: false };

      function isButtonDisabled(btn: HTMLElement): boolean {
        return (
          (btn as HTMLButtonElement).disabled === true ||
          btn.hasAttribute('disabled') ||
          btn.getAttribute('aria-disabled') === 'true' ||
          btn.classList.contains('artdeco-button--disabled')
        );
      }

      function dispatchFullClick(el: HTMLElement) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus();
        const opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
      }

      // 1. Try Review
      for (const btn of candidateButtons) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        const dataControl = (btn.getAttribute('data-control-name') || '').trim().toLowerCase();
        if (
          aria.includes('dismiss') ||
          aria.includes('close') ||
          text === 'dismiss' ||
          text === 'cancel' ||
          text === 'back'
        )
          continue;

        if (aria.includes('review') || text === 'review' || text.includes('review') || dataControl.includes('review')) {
          if (!isButtonDisabled(btn)) {
            dispatchFullClick(btn);
            return { clicked: true, type: 'review' as const };
          }
        }
      }

      // 2. Try Next / Continue
      for (const btn of candidateButtons) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        const dataControl = (btn.getAttribute('data-control-name') || '').trim().toLowerCase();
        if (
          aria.includes('dismiss') ||
          aria.includes('close') ||
          text === 'dismiss' ||
          text === 'cancel' ||
          text === 'back'
        )
          continue;

        if (
          aria.includes('continue to next step') ||
          aria.includes('next') ||
          aria.includes('continue') ||
          text === 'next' ||
          text === 'continue' ||
          text.includes('next') ||
          text.includes('continue to next step') ||
          btn.hasAttribute('data-easy-apply-next-button') ||
          dataControl.includes('continue')
        ) {
          if (!isButtonDisabled(btn)) {
            dispatchFullClick(btn);
            return { clicked: true, type: 'next' as const };
          }
        }
      }

      // 3. Fallback to primary button across searchRoots and document
      for (const scope of [...searchRoots, document]) {
        const primaryBtn = scope.querySelector(
          '.jobs-easy-apply-modal__footer button.artdeco-button--primary, .artdeco-modal__actionbar button.artdeco-button--primary, footer button.artdeco-button--primary, button.artdeco-button--primary',
        ) as HTMLElement | null;
        if (primaryBtn && !isButtonDisabled(primaryBtn)) {
          const pText = (primaryBtn.innerText || primaryBtn.textContent || '').trim().toLowerCase();
          const pAria = (primaryBtn.getAttribute('aria-label') || '').trim().toLowerCase();
          if (
            !pText.includes('dismiss') &&
            !pText.includes('cancel') &&
            !pAria.includes('dismiss') &&
            !pAria.includes('cancel') &&
            !pAria.includes('close')
          ) {
            dispatchFullClick(primaryBtn);
            const actionType: 'next' | 'review' =
              pText.includes('review') || pAria.includes('review') ? 'review' : 'next';
            return { clicked: true, type: actionType };
          }
        }
      }

      return { clicked: false };
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(clickInPage);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: clickInPage,
        });
        const res = results?.[0]?.result;
        if (res) return res;
      } catch {}
    }

    return { clicked: false };
  }

  /**
   * Submits the application in the Review step.
   */
  async submitApplication(): Promise<{ clicked: boolean; error?: string }> {
    const submitInPage = () => {
      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];

        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const aria = (c.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) {
            continue;
          }
          const text = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (/^\d+\s*notifications?$/i.test(text) || c.closest('.notifications-badge')) continue;
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;

          if (
            c.classList.contains('jobs-easy-apply-modal') ||
            c.hasAttribute('data-easy-apply-modal') ||
            c.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
            c.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
            ) !== null
          ) {
            return c;
          }

          const titleEl = c.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const titleText = (titleEl?.textContent || text.slice(0, 100)).toLowerCase();
          const hasApplyTitle = /apply|application|job/i.test(titleText);
          const hasPrimaryBtn =
            c.querySelector(
              'button.artdeco-button--primary, button[data-easy-apply-next-button], button[aria-label*="next" i], button[aria-label*="submit" i], button[aria-label*="review" i], button[aria-label*="continue" i]',
            ) !== null;

          if (hasApplyTitle || hasPrimaryBtn) {
            return c;
          }
        }

        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            const found = findActiveModal(all[i].shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const modal = findActiveModal(document);
      const searchRoots: HTMLElement[] = [];
      if (modal) searchRoots.push(modal);
      const artdecoModal = document.querySelector(
        'div.artdeco-modal, .jobs-easy-apply-modal, div[role="dialog"][aria-modal="true"]',
      ) as HTMLElement | null;
      if (artdecoModal && !searchRoots.includes(artdecoModal)) searchRoots.push(artdecoModal);

      // 1. Scroll content to bottom to ensure review screen is fully loaded
      const scrollable = (modal || artdecoModal)?.querySelector(
        '.jobs-easy-apply-modal__content, .artdeco-modal__content, div[role="dialog"] > div',
      );
      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
      }

      // 2. Ensure any review agreement checkboxes are checked
      const checkboxes = Array.from(
        (modal || artdecoModal || document).querySelectorAll('input[type="checkbox"]'),
      ) as HTMLInputElement[];
      for (const cb of checkboxes) {
        if (!cb.checked) {
          const txt = (cb.closest('label, div')?.textContent || cb.getAttribute('aria-label') || '').toLowerCase();
          if (/agree|confirm|acknowledge|consent|certify|terms/i.test(txt)) {
            cb.click();
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }

      const seen = new Set<HTMLElement>();
      const candidateButtons: HTMLElement[] = [];
      const addButton = (b: HTMLElement | null) => {
        if (!b || seen.has(b)) return;
        seen.add(b);
        candidateButtons.push(b);
      };

      // 1. Direct targeted queries for submit buttons
      const actionSelectors = [
        '.jobs-easy-apply-modal__footer button',
        '.jobs-easy-apply-modal__footer [role="button"]',
        '.artdeco-modal__actionbar button',
        '.artdeco-modal__actionbar [role="button"]',
        'div[role="dialog"] footer button',
        'div[role="dialog"] .artdeco-modal__actionbar button',
        'button[aria-label*="submit application" i]',
        'button[aria-label*="submit" i]',
        'button.artdeco-button--primary',
      ];
      for (const sel of actionSelectors) {
        for (const root of searchRoots) {
          try {
            root.querySelectorAll(sel).forEach(el => addButton(el as HTMLElement));
          } catch {}
        }
        try {
          document.querySelectorAll(sel).forEach(el => addButton(el as HTMLElement));
        } catch {}
      }

      for (const root of searchRoots) {
        try {
          root.querySelectorAll('button, [role="button"]').forEach(el => addButton(el as HTMLElement));
        } catch {}
      }

      if (candidateButtons.length === 0 && !modal) return { clicked: false, error: 'Easy Apply modal is not open' };

      function dispatchFullClick(el: HTMLElement) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus();
        const opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
      }

      for (const btn of candidateButtons) {
        const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        const dataControl = (btn.getAttribute('data-control-name') || '').trim().toLowerCase();
        if (
          aria.includes('dismiss') ||
          aria.includes('close') ||
          text === 'dismiss' ||
          text === 'cancel' ||
          text === 'back'
        )
          continue;

        const isSubmit =
          aria.includes('submit application') ||
          aria.includes('submit') ||
          text === 'submit application' ||
          text === 'submit' ||
          text.includes('submit application') ||
          dataControl === 'submit_unify' ||
          (btn.hasAttribute('data-easy-apply-next-button') && text.includes('submit'));

        if (isSubmit) {
          dispatchFullClick(btn);
          return { clicked: true };
        }
      }

      // Primary button fallback on review step across searchRoots and document
      for (const scope of [...searchRoots, document]) {
        const primaryBtn = scope.querySelector(
          '.jobs-easy-apply-modal__footer button.artdeco-button--primary, .artdeco-modal__actionbar button.artdeco-button--primary, footer button.artdeco-button--primary, button.artdeco-button--primary',
        ) as HTMLElement | null;
        if (primaryBtn) {
          const pText = (primaryBtn.innerText || primaryBtn.textContent || '').trim().toLowerCase();
          const pAria = (primaryBtn.getAttribute('aria-label') || '').trim().toLowerCase();
          if (
            !pText.includes('dismiss') &&
            !pText.includes('cancel') &&
            !pAria.includes('dismiss') &&
            !pAria.includes('cancel') &&
            !pAria.includes('close')
          ) {
            dispatchFullClick(primaryBtn);
            return { clicked: true };
          }
        }
      }

      return { clicked: false, error: 'Submit button not found in active modal' };
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(submitInPage);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: submitInPage,
        });
        const res = results?.[0]?.result;
        if (res) return res;
      } catch {}
    }

    return { clicked: false, error: 'Failed to execute submitApplication via Puppeteer or chrome.scripting' };
  }

  /**
   * Verifies explicit application submission confirmation over up to maxWaitMs.
   */
  async verifySubmissionConfirmation(maxWaitMs = 8000): Promise<{ confirmed: boolean; message?: string }> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const check = await this.verifyApplicationConfirmation();
      if (check.confirmed) {
        return check;
      }

      const topCard = await this.extractJobTopCardContext(1000).catch(() => null);
      if (topCard?.isAlreadyApplied) {
        return { confirmed: true, message: 'Verified applied status on LinkedIn top-card' };
      }

      const isModalStillOpen = await this.isEasyApplyModalOpen().catch(() => false);
      if (!isModalStillOpen && topCard && !topCard.hasEasyApply) {
        return { confirmed: true, message: 'Verified: Easy Apply modal closed and application completed' };
      }

      await new Promise(r => setTimeout(r, 600));
    }
    return { confirmed: false, message: 'Submission confirmation was not observed within timeout' };
  }

  /**
   * Checks passively whether the current tab presents a Security Checkpoint,
   * CAPTCHA / Arkose challenge, or SMS/Phone OTP verification wall.
   */
  async detectSecurityCheckpoint(): Promise<{
    isCheckpoint: boolean;
    type?: 'captcha' | 'otp' | 'challenge' | 'unknown';
    title?: string;
  }> {
    if (!this._puppeteerPage) return { isCheckpoint: false };

    return this._puppeteerPage
      .evaluate(() => {
        const url = (window.location.href || '').toLowerCase();
        const title = (document.title || '').toLowerCase();

        // 1. URL Checkpoint patterns
        if (
          url.includes('/checkpoint/') ||
          url.includes('/challenge/') ||
          url.includes('security-check') ||
          url.includes('/uas/consumer-captcha') ||
          url.includes('arkose')
        ) {
          return { isCheckpoint: true, type: 'challenge' as const, title: document.title };
        }

        // 2. Title security keywords
        if (
          title.includes('security verification') ||
          title.includes('quick verification') ||
          title.includes('phone verification') ||
          title.includes('verify your identity') ||
          title.includes("verify you're human") ||
          title.includes('just a moment') ||
          title.includes('attention required')
        ) {
          return { isCheckpoint: true, type: 'challenge' as const, title: document.title };
        }

        // 3. CAPTCHA / Arkose iframes & containers
        const captchaElements = document.querySelectorAll(
          'iframe[src*="arkose"], iframe[src*="funcaptcha"], iframe[src*="recaptcha"], iframe[src*="captcha"], #captcha-internal, div.checkpoint-container, div.challenge-dialog',
        );
        for (const el of Array.from(captchaElements)) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return { isCheckpoint: true, type: 'captcha' as const, title: document.title };
          }
        }

        // 4. SMS / Phone OTP verification inputs
        const otpInputs = document.querySelectorAll<HTMLInputElement>(
          'input[name="pin"], input[id*="verification-code"], input[id*="phone-pin"], input[autocomplete="one-time-code"]',
        );
        for (const inp of Array.from(otpInputs)) {
          if (inp.offsetParent !== null) {
            return { isCheckpoint: true, type: 'otp' as const, title: document.title };
          }
        }

        return { isCheckpoint: false };
      })
      .catch(() => ({ isCheckpoint: false }));
  }

  /**
   * Detects LinkedIn daily/weekly Easy Apply rate limits and maximum application warnings.
   */
  async detectPlatformRateLimit(): Promise<{ isLimited: boolean; reason?: string }> {
    if (!this._puppeteerPage) return { isLimited: false };

    return this._puppeteerPage
      .evaluate(() => {
        const bodyText = (
          document.body ? document.body.innerText || document.body.textContent || '' : ''
        ).toLowerCase();
        const limitPatterns = [
          /maximum number of applications/i,
          /reached the (?:application )?limit/i,
          /reached your (?:application )?limit/i,
          /applications are temporarily limited/i,
          /try again tomorrow/i,
          /exceeded the application limit/i,
          /submitted the maximum/i,
        ];

        for (const pattern of limitPatterns) {
          if (pattern.test(bodyText)) {
            const limitEl = document.querySelector(
              '.artdeco-modal, [role="alertdialog"], [role="alert"], .jobs-easy-apply-modal, .artdeco-inline-feedback--error, .feed-shared-banner',
            );
            if (limitEl) {
              const elText = (limitEl.textContent || '').toLowerCase();
              if (pattern.test(elText)) {
                return { isLimited: true, reason: (limitEl.textContent || '').trim().slice(0, 150) };
              }
            }
            const headerOrDialog = Array.from(
              document.querySelectorAll('h1, h2, h3, [role="dialog"], [role="alertdialog"]'),
            );
            for (const hd of headerOrDialog) {
              if (pattern.test((hd.textContent || '').toLowerCase())) {
                return { isLimited: true, reason: (hd.textContent || '').trim().slice(0, 150) };
              }
            }
          }
        }
        return { isLimited: false };
      })
      .catch(() => ({ isLimited: false }));
  }

  /**
   * Waits adaptively for DOM mutations to settle and loading spinners to disappear.
   * Eliminates race conditions on slower machines (i3/i5, 5-10Mbps) while maintaining
   * instant near-zero latency on high-end hardware (i9, gigabit).
   */
  async waitForDomSettlement(
    targetSelector = 'div.jobs-easy-apply-modal, div[data-test-modal], div.artdeco-modal, div[role="dialog"]',
    options: {
      maxWaitMs?: number;
      quietPeriodMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<{ settled: boolean; elapsedMs: number }> {
    if (!this._puppeteerPage) {
      return { settled: false, elapsedMs: 0 };
    }

    const maxWaitMs = options.maxWaitMs ?? 4000;
    const quietPeriodMs = options.quietPeriodMs ?? 150;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const check = await this._puppeteerPage
        .evaluate((sel: string) => {
          // Check for active loading spinners
          const spinnerSelectors = [
            '.artdeco-loader',
            '.loading-spinner',
            '.jobs-easy-apply-modal__spinner',
            '[data-test-loading-indicator]',
            '.artdeco-inline-feedback--loading',
            '[aria-busy="true"]',
            '.fb-form-element--loading',
            '.spinner',
          ];
          const hasSpinner = Boolean(document.querySelector(spinnerSelectors.join(', ')));
          if (hasSpinner) {
            return { hasSpinner: true, targetFound: false };
          }

          // Target container inspection: If sel is provided, we MUST find sel; do NOT fall back to document.body
          const target = sel ? document.querySelector(sel) : document.body;
          if (!target) {
            return { hasSpinner: false, targetFound: false };
          }

          const style = window.getComputedStyle(target);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return { hasSpinner: false, targetFound: false };
          }

          return { hasSpinner: false, targetFound: true };
        }, targetSelector)
        .catch(() => ({ hasSpinner: false, targetFound: false }));

      if (!check.hasSpinner && check.targetFound) {
        // Allow quietPeriodMs to guarantee layout stability
        await new Promise(r => setTimeout(r, quietPeriodMs));
        return { settled: true, elapsedMs: Date.now() - startTime };
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    return { settled: false, elapsedMs: Date.now() - startTime };
  }

  /**
   * Dismisses LinkedIn's post-application thank-you / confirmation dialog
   * so it does not block subsequent job applications.
   */
  async dismissPostSubmitModal(timeoutMs = 4000): Promise<boolean> {
    const dismissInPage = () => {
      const dismissSelectors = [
        'button[aria-label="Dismiss"]',
        'button.artdeco-modal__dismiss',
        'button[data-test-modal-close-btn]',
        'div.jobs-easy-apply-modal button[aria-label*="Dismiss"]',
        'div.artdeco-modal button[aria-label*="Dismiss"]',
        'button.artdeco-button--primary[data-test-easy-apply-dismiss-button]',
        'button[data-control-name="overlay.close_overlay"]',
      ];

      for (const sel of dismissSelectors) {
        const btn = document.querySelector<HTMLButtonElement>(sel);
        if (btn && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }

      // Search for button with text "Done"
      const allButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
      for (const btn of allButtons) {
        const txt = (btn.textContent || '').trim().toLowerCase();
        if (txt === 'done' && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }

      return false;
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        const res = await this._puppeteerPage.evaluate(dismissInPage);
        if (res) return true;
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: dismissInPage,
        });
        if (results?.[0]?.result) return true;
      } catch {}
    }

    return false;
  }

  /**
   * Selects the best matching resume radio button in the Easy Apply modal.
   * Compares pre-uploaded resume cards against targetFileName and resumeTags.
   */
  async selectResumeInModal(
    targetFileName?: string,
    candidateFileNames: string[] = [],
    resumeTags: string[] = [],
  ): Promise<{ selected: boolean; label?: string; needsFileUpload?: boolean }> {
    const selectInPage = (fileNameTarget?: string, altFileNames: string[] = [], tags: string[] = []) => {
      function findActiveModal(root: any): HTMLElement | null {
        const candidates = root.querySelectorAll
          ? (Array.from(
              root.querySelectorAll(
                '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [data-test-modal]',
              ),
            ) as HTMLElement[])
          : [];
        for (const c of candidates) {
          if (
            c.closest(
              'nav, header, #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown, .search-reusables__filter-list, .search-reusables__filter-dropdown, .jobs-search-box, .scaffold-layout__header, .jobs-search-results-list, .scaffold-layout__list, .artdeco-pill',
            )
          ) {
            continue;
          }
          const style = window.getComputedStyle(c);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = c.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 100) continue;

          if (
            c.classList.contains('jobs-easy-apply-modal') ||
            c.hasAttribute('data-easy-apply-modal') ||
            c.getAttribute('data-test-modal-id') === 'easy-apply-modal' ||
            c.querySelector(
              '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
            ) !== null
          ) {
            return c;
          }

          const titleEl = c.querySelector('h1, h2, h3, [id*="header"], [class*="header"]');
          const titleText = (titleEl?.textContent || (c.innerText || c.textContent || '').slice(0, 100)).toLowerCase();
          const hasApplyTitle = /apply|application|job/i.test(titleText);
          const hasPrimaryBtn =
            c.querySelector(
              'button.artdeco-button--primary, button[data-easy-apply-next-button], button[aria-label*="next" i], button[aria-label*="submit" i], button[aria-label*="review" i], button[aria-label*="continue" i]',
            ) !== null;

          if (hasApplyTitle || hasPrimaryBtn) {
            return c;
          }
        }
        return null;
      }

      const modal = findActiveModal(document);
      if (!modal) return { selected: false, needsFileUpload: false };

      function clickReactRadio(radio: HTMLInputElement) {
        try {
          radio.focus();
        } catch {}

        // 1. Native prototype setter so React 18 tracks the transition
        const proto = HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
        if (setter) {
          setter.call(radio, true);
        } else {
          radio.checked = true;
        }

        // 2. Identify clickable label or card container
        const clickable =
          (radio.id ? modal!.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null) ||
          radio.closest('label') ||
          radio.closest(
            '.jobs-document-upload__resume-card, .ui-attachment, div[data-test-form-builder-radio-button-form-component]',
          ) ||
          radio.parentElement ||
          radio;

        // 3. Dispatch full pointer/mouse sequence on the clickable element
        const mouseOpts = { bubbles: true, cancelable: true, view: window };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
          clickable.dispatchEvent(new MouseEvent(evt, mouseOpts));
        });

        // 4. Fire React input and change events
        radio.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

        // 5. Dismiss any visible "A resume is required" red alert message
        const errorEls = Array.from(
          modal!.querySelectorAll(
            '.artdeco-inline-feedback--error, [data-test-form-element-error-messages], .fb-form-element__error-text, p[id*="error"]',
          ),
        );
        for (const errEl of errorEls) {
          if (/resume\s+is\s+required/i.test(errEl.textContent || '')) {
            (errEl as HTMLElement).style.display = 'none';
          }
        }
      }

      function normalizeFileName(str: string): string {
        return (str || '')
          .toLowerCase()
          .replace(/\.(pdf|doc|docx)$/i, '')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      const radios = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="radio"]'));

      if (radios.length === 0) {
        // Check if file upload button is present for fresh accounts with 0 pre-uploaded resumes
        const hasUploadInput = Boolean(modal.querySelector('input[type="file"]'));
        return { selected: false, needsFileUpload: hasUploadInput };
      }

      const normTarget = normalizeFileName(fileNameTarget || '');
      const normAltTargets = (altFileNames || []).map(normalizeFileName).filter(Boolean);
      const cleanTags = (tags || []).map(t => t.toLowerCase().trim()).filter(Boolean);

      // Filter out generic file stop words so fuzzy token matching doesn't match all resumes
      const stopWords = new Set(['resume', 'cv', 'doc', 'docx', 'pdf', 'profile', 'updated', 'latest', 'final']);
      const targetWords = normTarget.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

      let bestRadio: HTMLInputElement | null = null;
      let bestRadioLabel = '';
      let highestScore = -1;

      for (const radio of radios) {
        const cardEl = radio.closest('div, label, li, tr') || radio.parentElement;
        const rawCardText = (cardEl?.textContent || '').toLowerCase().trim();

        const isResumeRadio =
          rawCardText.includes('.pdf') ||
          rawCardText.includes('.doc') ||
          rawCardText.includes('resume') ||
          radio.name.toLowerCase().includes('resume') ||
          radio.id.toLowerCase().includes('resume');

        if (!isResumeRadio) continue;

        const normCard = normalizeFileName(rawCardText);
        let score = 0;

        // Tier 1: Exact or strong match on Primary Target resume (Default / Active in extension)
        if (normTarget && normCard === normTarget) {
          score += 1000;
        } else if (normTarget && normCard.includes(normTarget)) {
          score += 800;
        } else if (targetWords.length > 0) {
          for (const word of targetWords) {
            if (normCard.includes(word)) score += 100;
          }
        }

        // Tier 2: Match against any other uploaded resume in the extension
        for (const alt of normAltTargets) {
          if (alt && normCard === alt) {
            score += 500;
            break;
          } else if (alt && normCard.includes(alt)) {
            score += 400;
            break;
          }
        }

        // Tier 3: Resume tags match in card text
        for (const tag of cleanTags) {
          if (normCard.includes(tag)) {
            score += 20;
          }
        }

        // Tier 4: Fallback - if no match found, first available resume gets 10 points
        if (score === 0) {
          score = 10;
        }

        // Preference for already checked radio if tied
        if (radio.checked) {
          score += 1;
        }

        if (score > highestScore) {
          highestScore = score;
          bestRadio = radio;
          bestRadioLabel = rawCardText.slice(0, 80);
        }
      }

      if (bestRadio) {
        clickReactRadio(bestRadio);
        return { selected: true, label: bestRadioLabel };
      }

      // Check if modal contains an active file upload input or button (fresh LinkedIn account with 0 prior resumes)
      const hasUploadUploader = Boolean(
        modal.querySelector(
          'input[type="file"], button[aria-label*="Upload resume"], .jobs-document-upload__upload-button, [data-test-form-builder-document-upload-button], label[for*="jobs-document-upload"]',
        ),
      );

      return { selected: false, needsFileUpload: hasUploadUploader };
    };

    if (!this._puppeteerPage) {
      await this.attachPuppeteer().catch(() => false);
    }

    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.evaluate(selectInPage, targetFileName, candidateFileNames, resumeTags);
      } catch {}
    }

    if (this._tabId && typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: this._tabId },
          func: selectInPage,
          args: [targetFileName, candidateFileNames, resumeTags],
        });
        const res = results?.[0]?.result;
        if (res) return res;
      } catch {}
    }

    return { selected: false };
  }
}

export interface FormFieldDescriptor {
  id?: string;
  label: string;
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
  options?: string[];
  min?: number;
  max?: number;
  isTextArea?: boolean;
  placeholder?: string;
  hintText?: string;
  required?: boolean;
}

export interface SearchJobCard {
  jobId: string;
  title: string;
  company: string;
  url: string;
}

export interface JobTopCardContext {
  title: string;
  company: string;
  location: string;
  isClosed: boolean;
  isAlreadyApplied: boolean;
  hasEasyApply: boolean;
  isLoginWall: boolean;
  descriptionSnippet?: string;
}
