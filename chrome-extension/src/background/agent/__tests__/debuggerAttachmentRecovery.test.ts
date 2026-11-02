// chrome-extension/src/background/agent/__tests__/debuggerAttachmentRecovery.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { get: vi.fn(), query: vi.fn(), update: vi.fn(), create: vi.fn() },
    runtime: { id: 'mock-ext-id' },
  },
}));

let mockConnectFn = vi.fn();
let mockConnectTabFn = vi.fn();

vi.mock('puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js', () => ({
  connect: (...args: any[]) => mockConnectFn(...args),
  ExtensionTransport: {
    connectTab: (...args: any[]) => mockConnectTabFn(...args),
  },
}));

import BrowserContext from '../../browser/context';
import Page from '../../browser/page';
import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';

describe('Debugger Attachment & Recovery Serialization', () => {
  let mockChrome: any;
  let mockBrowser: any;
  let mockPuppeteerPage: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPuppeteerPage = {
      url: vi.fn().mockReturnValue('https://www.linkedin.com/jobs/search/?keywords=Engineer'),
      evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    mockBrowser = {
      pages: vi.fn().mockResolvedValue([mockPuppeteerPage]),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    mockConnectTabFn.mockResolvedValue({ targetId: 'mock-target' });
    mockConnectFn.mockResolvedValue(mockBrowser);

    mockChrome = {
      tabs: {
        get: vi.fn().mockImplementation((tabId: number) =>
          Promise.resolve({
            id: tabId,
            url: 'https://www.linkedin.com/jobs/search/?keywords=Engineer',
            title: 'LinkedIn Jobs',
            active: true,
            windowId: 10,
          }),
        ),
        query: vi.fn().mockResolvedValue([
          {
            id: 101,
            url: 'https://www.linkedin.com/jobs/search/?keywords=Engineer',
            title: 'LinkedIn Jobs',
            active: true,
          },
        ]),
        create: vi.fn().mockResolvedValue({ id: 999, url: 'about:blank' }),
        update: vi.fn().mockResolvedValue({}),
      },
      debugger: {
        attach: vi.fn().mockResolvedValue({}),
        detach: vi.fn().mockResolvedValue({}),
      },
      runtime: { id: 'mock-ext-id' },
    };
    (globalThis as any).chrome = mockChrome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Successful debugger attachment
  it('1. attaches debugger successfully and marks Page as attached', async () => {
    const context = new BrowserContext({});
    context.updateCurrentTabId(101);

    const page = await context.getCurrentPage();

    expect(page).toBeDefined();
    expect(page.tabId).toBe(101);
    expect(page.attached).toBe(true);
    expect(mockConnectTabFn).toHaveBeenCalledWith(101);
    expect(mockConnectFn).toHaveBeenCalled();
    expect(mockPuppeteerPage.evaluateOnNewDocument).toHaveBeenCalled();
  });

  // 2. Network.enable failure
  it('2. handles Network.enable failure ("Detached while handling command") cleanly without reusing failed Page', async () => {
    mockConnectFn.mockRejectedValueOnce(new Error('Protocol error (Network.enable): Detached while handling command.'));

    const context = new BrowserContext({});
    context.updateCurrentTabId(101);

    // Initialization fails because CDP detached during Network.enable
    await expect(context.getCurrentPage()).rejects.toThrow(/Failed to attach debugger to tab 101/);

    // Subsequent call after error creates a fresh Page and retries cleanly
    mockConnectFn.mockResolvedValueOnce(mockBrowser);
    const retryPage = await context.getCurrentPage();

    expect(retryPage).toBeDefined();
    expect(retryPage.attached).toBe(true);
  });

  // 3. Concurrent recovery requests
  it('3. deduplicates concurrent recovery requests on the same tab ID to a single execution', async () => {
    const mockContext: any = {
      updateCurrentTabId: vi.fn(),
      detachPage: vi.fn().mockResolvedValue(undefined),
      getCurrentPage: vi.fn().mockImplementation(async () => {
        // Introduce small async tick
        await new Promise(r => setTimeout(r, 20));
        return {
          tabId: 101,
          attached: true,
        };
      }),
    };

    (dedicatedJobRunner as any).browserContext = mockContext;

    // Trigger two recoveries concurrently
    const [page1, page2] = await Promise.all([
      dedicatedJobRunner.recoverWedgedPage(101),
      dedicatedJobRunner.recoverWedgedPage(101),
    ]);

    expect(page1).toBe(page2);
    // debugger.detach should have only been called once because of deduplication
    expect(mockChrome.debugger.detach).toHaveBeenCalledTimes(1);
    expect(mockContext.detachPage).toHaveBeenCalledTimes(1);
  });

  // 4. Detachment during initialization
  it('4. marks page as destroyed on detachment and creates fresh Page rather than reusing destroyed instance', async () => {
    const page = new Page(101, 'https://www.linkedin.com/jobs', 'LinkedIn');
    expect(page.attached).toBe(false);

    // Simulate successful attachment first
    await page.attachPuppeteer();
    expect(page.attached).toBe(true);

    // External detachment event fires
    page.handleDetached();
    expect(page.attached).toBe(false);
    expect(page.isDestroyed).toBe(true);

    // A destroyed page cannot be reattached
    const reattachResult = await page.attachPuppeteer();
    expect(reattachResult).toBe(false);

    // BrowserContext must not reuse the destroyed page
    const context = new BrowserContext({});
    (context as any)._attachedPages.set(101, page);
    context.updateCurrentTabId(101);

    const freshPage = await context.getCurrentPage();
    expect(freshPage).not.toBe(page);
    expect(freshPage.attached).toBe(true);
  });

  // 5. Timed-out initialization
  it('5. releases in-flight attach promise on timeout/rejection so subsequent calls are not permanently wedged', async () => {
    let hangReject: any;
    const hangingConnect = new Promise((_, reject) => {
      hangReject = reject;
    });

    mockConnectFn.mockReturnValueOnce(hangingConnect);

    const context = new BrowserContext({});
    context.updateCurrentTabId(101);

    // Start first call which will reject
    const firstCall = context.getCurrentPage();
    hangReject(new Error('Connection timed out'));

    await expect(firstCall).rejects.toThrow(/Failed to attach debugger to tab 101/);

    // In-flight map must be clear, allowing a subsequent attempt to proceed
    mockConnectFn.mockResolvedValueOnce(mockBrowser);
    const secondCall = await context.getCurrentPage();
    expect(secondCall).toBeDefined();
    expect(secondCall.attached).toBe(true);
  });

  // 6. Recovery with a fresh Page object
  it('6. recoverWedgedPage detaches old debugger session and attaches a fresh Page object', async () => {
    const stalePage: any = {
      tabId: 101,
      attached: false,
      detachPuppeteer: vi.fn().mockResolvedValue(undefined),
    };

    const freshPage: any = {
      tabId: 101,
      attached: true,
    };

    let getPageCallCount = 0;
    const mockContext: any = {
      _currentTabId: 101,
      updateCurrentTabId: vi.fn(),
      detachPage: vi.fn().mockImplementation(async () => {
        await stalePage.detachPuppeteer();
      }),
      getCurrentPage: vi.fn().mockImplementation(async () => {
        getPageCallCount++;
        return freshPage;
      }),
    };

    (dedicatedJobRunner as any).browserContext = mockContext;

    const recovered = await dedicatedJobRunner.recoverWedgedPage(101);

    expect(recovered).toBe(freshPage);
    expect(recovered).not.toBe(stalePage);
    expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 101 });
    expect(stalePage.detachPuppeteer).toHaveBeenCalled();
    expect(mockContext.getCurrentPage).toHaveBeenCalled();
  });

  // 7. Tab closure during recovery
  it('7. cleanly aborts recovery if the tab was closed by user during recovery', async () => {
    mockChrome.tabs.get.mockRejectedValueOnce(new Error('Tab not found or closed'));

    const mockContext: any = {
      updateCurrentTabId: vi.fn(),
      detachPage: vi.fn().mockResolvedValue(undefined),
      getCurrentPage: vi.fn(),
    };

    (dedicatedJobRunner as any).browserContext = mockContext;

    await expect(dedicatedJobRunner.recoverWedgedPage(101)).rejects.toThrow(
      /Tab 101 was closed or unavailable during recovery/,
    );

    // getCurrentPage must NOT be called if the tab no longer exists
    expect(mockContext.getCurrentPage).not.toHaveBeenCalled();
  });
});
