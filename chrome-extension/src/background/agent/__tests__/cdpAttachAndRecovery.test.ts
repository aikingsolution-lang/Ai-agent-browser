// chrome-extension/src/background/agent/__tests__/cdpAttachAndRecovery.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { get: vi.fn(), query: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn() },
    windows: {
      get: vi.fn(),
      query: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      getLastFocused: vi.fn(),
    },
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

import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';
import { dedicatedWindowManager } from '../linkedin/dedicatedWindow';
import { authStorage, careerBrainStore } from '@extension/storage';
import * as preflightMod from '../linkedin/preflight';
import BrowserContext from '../../browser/context';
import Page from '../../browser/page';

describe('CDP Attach & Recovery (LinkedIn Runner)', () => {
  let mockChrome: any;
  let mockBrowser: any;
  let mockPuppeteerPage: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPuppeteerPage = {
      url: vi.fn().mockReturnValue('about:blank'),
      evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn?.toString() || '';
        if (fnStr.includes('nanobrowser-runner-indicator')) return undefined;
        if (fnStr.includes('isLoginWall') || fnStr.includes('/authwall')) return false;
        return {
          cardCount: 2,
          componentKeyCount: 2,
          occludableCount: 2,
          dataJobIdCount: 2,
          dataViewNameCount: 2,
          urlPath: '/jobs/search/?keywords=Software%20Engineer',
          visibilityState: 'visible',
          isLoginWall: false,
          isCheckpoint: false,
        };
      }),
      goto: vi.fn().mockResolvedValue(undefined),
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
            url: 'about:blank',
            title: 'New Tab',
            active: true,
            windowId: 10,
          }),
        ),
        query: vi.fn().mockResolvedValue([
          {
            id: 555,
            url: 'about:blank',
            title: 'New Tab',
            active: true,
            windowId: 10,
          },
        ]),
        create: vi.fn().mockResolvedValue({ id: 555, url: 'about:blank', windowId: 10 }),
        update: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
      windows: {
        getLastFocused: vi.fn().mockResolvedValue({ id: 10 }),
        get: vi.fn().mockResolvedValue({ id: 10 }),
        update: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
      debugger: {
        attach: vi.fn().mockResolvedValue({}),
        detach: vi.fn().mockResolvedValue({}),
        getTargets: vi.fn().mockResolvedValue([
          {
            id: 'target-555',
            tabId: 555,
            type: 'page',
            title: 'LinkedIn Runner',
            url: 'about:blank',
            attached: false,
          },
        ]),
      },
      runtime: { id: 'mock-ext-id' },
    };
    (globalThis as any).chrome = mockChrome;

    vi.spyOn(preflightMod, 'runPreflight').mockResolvedValue({
      ok: true,
      statusMessage: 'Preflight check passed',
      details: { remainingCredits: 20, healthOk: true, quotaAllowed: true },
    } as any);

    vi.spyOn(authStorage, 'getSession').mockResolvedValue({
      token: 'valid-test-token',
      user: { id: 'u1' },
    } as any);

    vi.spyOn(careerBrainStore, 'getCareerBrain').mockResolvedValue({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      phoneNumber: '+1234567890',
      yearsOfExperience: 5,
      workAuthorization: 'US Citizen',
      resumeText: 'Experienced Software Engineer with proficiency in React and Node.',
      targetRoles: ['Software Engineer'],
      skills: ['JavaScript', 'React'],
    } as any);

    let simulatedTime = 0;
    const realDateNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + simulatedTime);
    vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockImplementation(async (ms: any) => {
      simulatedTime += typeof ms === 'number' ? ms : 500;
      await new Promise(r => setTimeout(r, 2));
      return false;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Attach hangs then retry succeeds
  it('1. attach hangs on first attempt then retry with fresh blank tab succeeds', async () => {
    let connectCallCount = 0;
    mockConnectFn.mockImplementation(() => {
      connectCallCount++;
      if (connectCallCount === 1) {
        // First attempt hangs forever to trigger the 10s attempt timeout
        return new Promise(() => {});
      }
      // Retry attempt succeeds immediately
      return Promise.resolve(mockBrowser);
    });

    const closeSpy = vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow');

    const mockPage: any = {
      tabId: 555,
      attached: true,
      validWebPage: true,
      url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      navigateToDirect: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockImplementation(async (fn: any) => {
        const fnStr = fn?.toString() || '';
        if (fnStr.includes('nanobrowser-runner-indicator')) return undefined;
        if (fnStr.includes('/authwall') || fnStr.includes('login__form') || fnStr.includes('isAuthUrl')) return false;
        return {
          cardCount: 1,
          componentKeyCount: 1,
          occludableCount: 1,
          dataJobIdCount: 1,
          dataViewNameCount: 1,
          urlPath: '/jobs/search/?keywords=Software%20Engineer',
          visibilityState: 'visible',
          isLoginWall: false,
          isCheckpoint: false,
        };
      }),
      readJobListFromSearchPane: vi
        .fn()
        .mockResolvedValue([
          {
            jobId: '101',
            title: 'Software Engineer',
            company: 'Acme',
            location: 'Remote',
            url: 'https://linkedin.com/jobs/view/101',
          },
        ]),
      hasAnyOpenModalOrDialog: vi.fn().mockResolvedValue(false),
      isEasyApplyModalOpen: vi.fn().mockResolvedValue(false),
      extractJobTopCardContext: vi
        .fn()
        .mockResolvedValue({ title: 'Software Engineer', company: 'Acme', hasEasyApply: true }),
    };

    let pageGetCount = 0;
    const mockContext: any = {
      updateCurrentTabId: vi.fn(),
      detachPage: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getCurrentPage: vi.fn().mockImplementation(async () => {
        pageGetCount++;
        if (pageGetCount === 1) {
          // Trigger the timeout on first attempt
          throw new Error('attachPuppeteer timed out after 10000ms');
        }
        return mockPage;
      }),
    };

    (dedicatedJobRunner as any).browserContext = mockContext;
    vi.spyOn(dedicatedJobRunner as any, 'applySingleLinkedInJobInSplitPane').mockResolvedValue({
      status: 'applied',
      usedDirectFallback: false,
    });

    const result = await dedicatedJobRunner.startAutonomousJobLoop({
      platform: 'linkedin',
      portToSend: { postMessage: vi.fn() } as any,
      onLiveActivity: vi.fn(),
      runnerMode: 'tab',
    });

    // Verify first attempt timed out, closed the wedged tab, and retried
    expect(pageGetCount).toBeGreaterThanOrEqual(2);
    expect(closeSpy).toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  // 2. Attach hangs twice and run ends with clear error and full cleanup
  it('2. attach hangs on all attempts and run ends with clear error and full cleanup', async () => {
    mockConnectFn.mockImplementation(() => new Promise(() => {})); // Hangs forever

    const closeSpy = vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow');

    const mockContext: any = {
      updateCurrentTabId: vi.fn(),
      detachPage: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getCurrentPage: vi.fn().mockImplementation(async () => {
        throw new Error('attachPuppeteer timed out after 10000ms');
      }),
    };

    (dedicatedJobRunner as any).browserContext = mockContext;

    const statusUpdates: string[] = [];
    const mockPort: any = {
      postMessage: vi.fn((msg: any) => {
        if (msg?.text) statusUpdates.push(msg.text);
      }),
    };

    const result = await dedicatedJobRunner.startAutonomousJobLoop({
      platform: 'linkedin',
      portToSend: mockPort,
      onLiveActivity: vi.fn(),
      runnerMode: 'tab',
    });

    expect(result.status).toBe('stopped');
    expect(result.message).toContain('Failed to attach debugger to runner tab after');
    expect(result.message).toContain('Diagnostics:');

    // Full cleanup must have been called: debugger detached, context cleaned, runner window closed
    expect(mockChrome.debugger.detach).toHaveBeenCalled();
    expect(mockContext.cleanup).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });

  // 3. Tab already attached by another client gives specific message
  it('3. tab already attached by another client stops immediately with the specific message', async () => {
    // getTargets reports tab 555 attached by another extension
    mockChrome.debugger.getTargets.mockResolvedValue([
      {
        id: 'target-555',
        tabId: 555,
        type: 'page',
        title: 'LinkedIn',
        url: 'https://www.linkedin.com',
        attached: true,
        extensionId: 'some-foreign-extension-id',
      },
    ]);

    const liveActivityList: any[] = [];
    const statusUpdates: string[] = [];
    const mockPort: any = {
      postMessage: vi.fn((msg: any) => {
        if (msg?.text) statusUpdates.push(msg.text);
      }),
    };

    const mockContext: any = {
      updateCurrentTabId: vi.fn(),
      detachPage: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getCurrentPage: vi.fn(),
    };
    (dedicatedJobRunner as any).browserContext = mockContext;

    const result = await dedicatedJobRunner.startAutonomousJobLoop({
      platform: 'linkedin',
      portToSend: mockPort,
      onLiveActivity: (act: any) => liveActivityList.push(act),
      runnerMode: 'tab',
    });

    expect(result.status).toBe('stopped');
    expect(result.message).toContain(
      'Another extension or DevTools is debugging this tab (id 555). Close DevTools / disable other automation extensions and retry.',
    );

    // Exactly one Live Activity conflict error line
    const conflictAct = liveActivityList.find(a => a.jobId === 'debugger_conflict');
    expect(conflictAct).toBeDefined();
    expect(conflictAct.status).toBe('failed');
    expect(conflictAct.reason).toContain('Another extension or DevTools is debugging this tab');

    // Should NOT have attempted to attach
    expect(mockContext.getCurrentPage).not.toHaveBeenCalled();
  });

  // 4. No detach during pending attach
  it('4. recovery does not call chrome.debugger.detach while an attach is in flight', async () => {
    let attachResolver: any;
    const hangingAttachPromise = new Promise<any>(resolve => {
      attachResolver = resolve;
    });

    const mockPage: any = {
      tabId: 555,
      attached: true,
    };

    let detachCalledDuringPendingAttach = false;
    mockChrome.debugger.detach.mockImplementation(async () => {
      // Check if the pending attach is still unresolved
      if ((dedicatedJobRunner as any).pendingAttachPromise) {
        detachCalledDuringPendingAttach = true;
      }
      return {};
    });

    const mockContext: any = {
      updateCurrentTabId: vi.fn(),
      detachPage: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockResolvedValue(undefined),
      getCurrentPage: vi.fn().mockResolvedValue(mockPage),
    };

    (dedicatedJobRunner as any).browserContext = mockContext;
    (dedicatedJobRunner as any).attachingTabId = 555;
    (dedicatedJobRunner as any).pendingAttachPromise = hangingAttachPromise;

    // Fast-forward timers for recovery settlement wait
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
      const fastMs = ms === 20000 ? 30 : ms === 1000 ? 10 : ms;
      return originalSetTimeout(cb, fastMs);
    });

    // Start recovery while attach is pending
    const recoveryPromise = dedicatedJobRunner.recoverWedgedPage(555);

    // Resolve the pending attach after a moment
    setTimeout(() => {
      (dedicatedJobRunner as any).pendingAttachPromise = null;
      (dedicatedJobRunner as any).attachingTabId = null;
      attachResolver(mockPage);
    }, 20);

    const recoveredPage = await recoveryPromise;

    expect(recoveredPage).toBeDefined();
    expect(detachCalledDuringPendingAttach).toBe(false);
    expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 555 });
  });

  // 5. Stale session from a previous run is detached at start
  it('5. stale debugger session from a previous run is cleanly detached at the start of a new run', async () => {
    // Target 888 was left attached from a previous run by our extension
    mockChrome.debugger.getTargets.mockResolvedValue([
      {
        id: 'target-888',
        tabId: 888,
        type: 'page',
        title: 'Old LinkedIn Tab',
        url: 'https://linkedin.com',
        attached: true,
        extensionId: 'mock-ext-id',
      },
    ]);

    await dedicatedJobRunner.clearStaleDebuggerAttachments(555);

    // Tab 888 must be detached at start
    expect(mockChrome.debugger.detach).toHaveBeenCalledWith({ tabId: 888 });
  });
});
