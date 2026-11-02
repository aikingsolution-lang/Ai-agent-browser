// chrome-extension/src/background/agent/__tests__/linkedinPageFreezeTimeout.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { get: vi.fn(), query: vi.fn(), update: vi.fn(), reload: vi.fn() },
    runtime: { id: 'mock-ext-id' },
  },
}));

import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';
import { dedicatedWindowManager } from '../linkedin/dedicatedWindow';
import { authStorage, careerBrainStore } from '@extension/storage';
import * as preflightMod from '../linkedin/preflight';
import Page from '../../browser/page';

describe('LinkedIn Freeze Prevention & Bounded Waits', () => {
  let mockChrome: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 555, active: true, windowId: 10 }),
        update: vi.fn().mockResolvedValue({}),
        reload: vi.fn().mockResolvedValue({}),
      },
      runtime: { id: 'mock-ext-id' },
    };
    (globalThis as any).chrome = mockChrome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Page.waitForDomSettlement Bounded Behavior', () => {
    it('settles cleanly without getting stuck when target container is found and free of spinners', async () => {
      let pollCount = 0;
      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(async () => {
          pollCount++;
          // Target found and no spinners in target container
          return {
            hasSpinner: false,
            targetFound: true,
          };
        }),
      };

      const page = new Page(101, 'https://www.linkedin.com/jobs', 'LinkedIn Jobs');
      (page as any)._puppeteerPage = mockPuppeteerPage;

      const startTime = Date.now();
      const res = await page.waitForDomSettlement('.jobs-search-results-list', {
        maxWaitMs: 1000,
        quietPeriodMs: 50,
        pollIntervalMs: 50,
      });
      const elapsed = Date.now() - startTime;

      expect(res.settled).toBe(true);
      expect(elapsed).toBeLessThan(1000);
      expect(pollCount).toBeGreaterThan(0);
    });

    it('exits cleanly within maxWaitMs when container has persistent mutation/spinner', async () => {
      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(async () => {
          // Page permanently spinning
          return {
            hasSpinner: true,
            targetFound: false,
          };
        }),
      };

      const page = new Page(101, 'https://www.linkedin.com/jobs', 'LinkedIn Jobs');
      (page as any)._puppeteerPage = mockPuppeteerPage;

      const startTime = Date.now();
      const res = await page.waitForDomSettlement('.jobs-search-results-list', {
        maxWaitMs: 300,
        quietPeriodMs: 50,
        pollIntervalMs: 50,
      });
      const elapsed = Date.now() - startTime;

      expect(res.settled).toBe(false);
      expect(elapsed).toBeLessThan(1000);
      expect(res.elapsedMs).toBeGreaterThanOrEqual(250);
    });
  });

  describe('LinkedIn Search Results Settlement & Autonomous Loop', () => {
    const setupBaseMocks = () => {
      vi.spyOn(preflightMod, 'runPreflight').mockResolvedValue({
        ok: true,
        statusMessage: 'Preflight check passed',
        details: { remainingCredits: 20, healthOk: true, quotaAllowed: true },
      });

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

      vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
        windowId: 10,
        tabId: 555,
        mode: 'tab',
      });
      vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();
    };

    // (a) list loaded and details pane skeleton: scan proceeds
    it('(a) list loaded and details pane skeleton: scan proceeds without blocking', async () => {
      setupBaseMocks();

      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(async (fn: any) => {
          const fnStr = fn.toString();
          // inspectSearchListSettlement: card count is 5, details pane is skeleton (ignored by inspectSearchListSettlement)
          if (
            fn.name === 'inspectSearchListSettlement' ||
            fnStr.includes('distinctElements') ||
            fnStr.includes('job-card-component-ref')
          ) {
            return {
              cardCount: 5,
              componentKeyCount: 5,
              occludableCount: 5,
              dataJobIdCount: 5,
              dataViewNameCount: 5,
              urlPath: '/jobs/search/?keywords=Software%20Engineer',
              visibilityState: 'visible',
              isLoginWall: false,
              isCheckpoint: false,
            };
          }
          if (fnStr.includes('nanobrowser-runner-indicator')) return undefined;
          if (fnStr.includes('/authwall') || fnStr.includes('login__form')) return false;
          return false;
        }),
        reload: vi.fn(),
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      const mockJob = {
        jobId: '1001',
        title: 'Full Stack Engineer',
        company: 'TechCorp',
        location: 'Remote',
        url: 'https://www.linkedin.com/jobs/view/1001/',
      };

      const mockPage: any = {
        tabId: 555,
        puppeteerPage: mockPuppeteerPage,
        evaluate: mockPuppeteerPage.evaluate,
        reload: mockPuppeteerPage.reload,
        readJobListFromSearchPane: vi.fn().mockResolvedValue([mockJob]),
        hasAnyOpenModalOrDialog: vi.fn().mockResolvedValue(false),
        isEasyApplyModalOpen: vi.fn().mockResolvedValue(false),
        extractJobTopCardContext: vi.fn().mockResolvedValue({
          title: 'Full Stack Engineer',
          company: 'TechCorp',
          hasEasyApply: true,
          isLoginWall: false,
        }),
      };

      const mockBrowserContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
      };

      (dedicatedJobRunner as any).browserContext = mockBrowserContext;

      // Mock applySingleLinkedInJobInSplitPane to succeed immediately
      vi.spyOn(dedicatedJobRunner as any, 'applySingleLinkedInJobInSplitPane').mockResolvedValue({
        status: 'applied',
        usedDirectFallback: false,
      });

      let simulatedTime = 0;
      const realDateNow = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + simulatedTime);
      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockImplementation(async (ms: any) => {
        // Advance simulated time by at least 2100ms so card count is stable for >= 2s
        simulatedTime += Math.max(typeof ms === 'number' ? ms : 2100, 2100);
        await new Promise(r => setTimeout(r, 10));
        return false;
      });

      const statusMessages: string[] = [];
      const mockPort: any = {
        postMessage: vi.fn((msg: any) => {
          if (msg?.text) {
            statusMessages.push(msg.text);
          }
        }),
      };

      const result = await dedicatedJobRunner.startAutonomousJobLoop({
        platform: 'linkedin',
        portToSend: mockPort,
        onLiveActivity: vi.fn(),
        runnerMode: 'tab',
      });

      // Scan proceeds!
      expect(statusMessages.some(m => m.includes('reloading once'))).toBe(false);
      expect(statusMessages.some(m => m.includes('Scanning LinkedIn job search results'))).toBe(true);
      expect(result.status).toBe('success');
    }, 15000);

    // (b) no cards at all: clean failure with the diagnostic message within the timeout
    it('(b) no cards at all: clean failure with the diagnostic message within the timeout (no "details pane")', async () => {
      setupBaseMocks();

      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(async (fn: any) => {
          const fnStr = fn.toString();
          // inspectSearchListSettlement: 0 cards found
          if (
            fn.name === 'inspectSearchListSettlement' ||
            fnStr.includes('distinctElements') ||
            fnStr.includes('job-card-component-ref')
          ) {
            return {
              cardCount: 0,
              componentKeyCount: 0,
              occludableCount: 0,
              dataJobIdCount: 0,
              dataViewNameCount: 0,
              urlPath: '/jobs/search/?keywords=Software%20Engineer',
              visibilityState: 'visible',
              isLoginWall: false,
              isCheckpoint: false,
            };
          }
          if (fnStr.includes('nanobrowser-runner-indicator')) return undefined;
          if (fnStr.includes('/authwall') || fnStr.includes('login__form')) return false;
          return false;
        }),
        reload: vi.fn(),
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      const mockPage: any = {
        tabId: 555,
        puppeteerPage: mockPuppeteerPage,
        evaluate: mockPuppeteerPage.evaluate,
        reload: mockPuppeteerPage.reload,
        readJobListFromSearchPane: vi.fn().mockResolvedValue([]),
      };

      const mockBrowserContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
      };

      (dedicatedJobRunner as any).browserContext = mockBrowserContext;

      let simulatedTime = 0;
      const realDateNow = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + simulatedTime);
      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockImplementation(async (ms: any) => {
        simulatedTime += Math.max(typeof ms === 'number' ? ms : 3000, 3000);
        await new Promise(r => setTimeout(r, 10));
        return false;
      });

      const statusMessages: string[] = [];
      const mockPort: any = {
        postMessage: vi.fn((msg: any) => {
          if (msg?.text) {
            statusMessages.push(msg.text);
          }
        }),
      };

      const result = await dedicatedJobRunner.startAutonomousJobLoop({
        platform: 'linkedin',
        portToSend: mockPort,
        onLiveActivity: vi.fn(),
        runnerMode: 'tab',
      });

      expect(result.status).toBe('error');
      // Clean diagnostic message including path, visibility, loginWall, checkpoint, card selectors
      expect(result.message).toContain('No LinkedIn job cards found after reload');
      expect(result.message).toContain('Path: "/jobs/search/?keywords=Software%20Engineer"');
      expect(result.message).toContain('loginWall: false');
      expect(result.message).toContain('checkpoint: false');
      expect(result.message).toContain('visibility: "visible"');
      expect(result.message).toContain(
        'card selectors: [componentkey: 0, occludable: 0, data-job-id: 0, data-view-name: 0]',
      );

      // Must NOT mention "details pane"
      expect(result.message).not.toContain('details pane');
      expect(statusMessages.some(m => m.includes('reloading once'))).toBe(true);
      expect(mockChrome.tabs.reload).toHaveBeenCalledWith(555);
    }, 15000);

    // (c) cards appear late (after 10s): scan proceeds
    it('(c) cards appear late (after 10s): scan proceeds without reload', async () => {
      setupBaseMocks();

      let simulatedTime = 0;
      const realDateNow = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + simulatedTime);
      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockImplementation(async (ms: any) => {
        simulatedTime += Math.max(typeof ms === 'number' ? ms : 2500, 2500);
        await new Promise(r => setTimeout(r, 10));
        return false;
      });

      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(async (fn: any) => {
          const fnStr = fn.toString();
          if (
            fn.name === 'inspectSearchListSettlement' ||
            fnStr.includes('distinctElements') ||
            fnStr.includes('job-card-component-ref')
          ) {
            // Before 10s: 0 cards. After 10s: 4 cards appear!
            const count = simulatedTime >= 10000 ? 4 : 0;
            return {
              cardCount: count,
              componentKeyCount: count,
              occludableCount: count,
              dataJobIdCount: count,
              dataViewNameCount: count,
              urlPath: '/jobs/search/?keywords=Software%20Engineer',
              visibilityState: 'visible',
              isLoginWall: false,
              isCheckpoint: false,
            };
          }
          if (fnStr.includes('nanobrowser-runner-indicator')) return undefined;
          if (fnStr.includes('/authwall') || fnStr.includes('login__form')) return false;
          return false;
        }),
        reload: vi.fn(),
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      const mockJob = {
        jobId: '2001',
        title: 'Full Stack Engineer',
        company: 'TechCorp',
        location: 'Remote',
        url: 'https://www.linkedin.com/jobs/view/2001/',
      };

      const mockPage: any = {
        tabId: 555,
        puppeteerPage: mockPuppeteerPage,
        evaluate: mockPuppeteerPage.evaluate,
        reload: mockPuppeteerPage.reload,
        readJobListFromSearchPane: vi.fn().mockResolvedValue([mockJob]),
        hasAnyOpenModalOrDialog: vi.fn().mockResolvedValue(false),
        isEasyApplyModalOpen: vi.fn().mockResolvedValue(false),
        extractJobTopCardContext: vi.fn().mockResolvedValue({
          title: 'Full Stack Engineer',
          company: 'TechCorp',
          hasEasyApply: true,
          isLoginWall: false,
        }),
      };

      const mockBrowserContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
      };

      (dedicatedJobRunner as any).browserContext = mockBrowserContext;

      vi.spyOn(dedicatedJobRunner as any, 'applySingleLinkedInJobInSplitPane').mockResolvedValue({
        status: 'applied',
        usedDirectFallback: false,
      });

      const statusMessages: string[] = [];
      const mockPort: any = {
        postMessage: vi.fn((msg: any) => {
          if (msg?.text) {
            statusMessages.push(msg.text);
          }
        }),
      };

      const result = await dedicatedJobRunner.startAutonomousJobLoop({
        platform: 'linkedin',
        portToSend: mockPort,
        onLiveActivity: vi.fn(),
        runnerMode: 'tab',
      });

      // No reload should be called because cards settled before 20s
      expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
      expect(statusMessages.some(m => m.includes('reloading once'))).toBe(false);
      expect(statusMessages.some(m => m.includes('Scanning LinkedIn job search results'))).toBe(true);
      expect(result.status).toBe('success');
    }, 15000);

    // (d) details pane skeleton after opening a job: direct navigation fallback is used once
    it('(d) details pane skeleton after opening a job: direct navigation fallback is used once', async () => {
      const page = new Page(101, 'https://www.linkedin.com/jobs/search', 'LinkedIn');
      const targetJobId = '987654321';
      const targetUrl = `https://www.linkedin.com/jobs/view/${targetJobId}/`;

      let directNavCallCount = 0;
      let navigatedUrl = '';
      vi.spyOn(page, 'navigateToDirect').mockImplementation(async (url: string) => {
        directNavCallCount++;
        navigatedUrl = url;
      });

      // Mock puppeteer evaluate: card click succeeds, but details pane stays skeleton
      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(async (fn: any, ...args: any[]) => {
          const fnStr = fn.toString();
          // Card click evaluation
          if (fnStr.includes('card.click()') || fnStr.includes('scrollIntoView')) {
            return true;
          }
          // checkDetailsPaneHeading evaluation: details pane is still a skeleton!
          if (fnStr.includes('checkDetailsPaneHeading') || fnStr.includes('detailsContainer')) {
            return {
              hasHeading: false,
              isSkeleton: true,
              headingText: '',
            };
          }
          return true;
        }),
      };

      (page as any)._puppeteerPage = mockPuppeteerPage;

      // Virtual time simulation for the 8s wait in clickJobInSearchList
      let simulatedWaitTime = 0;
      const realDateNow = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + simulatedWaitTime);
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
        simulatedWaitTime += Math.max(ms || 400, 400);
        return originalSetTimeout(cb, 5);
      });

      const res = await page.clickJobInSearchList(targetJobId);

      expect(res).toBe(true);
      expect(directNavCallCount).toBe(1);
      expect(navigatedUrl).toBe(targetUrl);
    }, 15000);
  });

  describe('Startup Watchdog & Recovery (MV3)', () => {
    const setupBaseMocks = () => {
      vi.spyOn(preflightMod, 'runPreflight').mockResolvedValue({
        ok: true,
        statusMessage: 'Preflight check passed',
        details: { remainingCredits: 20, healthOk: true, quotaAllowed: true },
      });

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

      vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
        windowId: 10,
        tabId: 555,
        mode: 'tab',
      });
      vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();
    };

    it('Page.evaluate in-flight guard prevents multiple concurrent evaluates on wedged connection', async () => {
      const page = new Page(101, 'https://www.linkedin.com/jobs', 'LinkedIn');
      let evalResolve: any;
      const hangingPromise = new Promise(resolve => {
        evalResolve = resolve;
      });

      const mockPuppeteer = {
        evaluate: vi.fn().mockImplementation(() => hangingPromise),
      };
      (page as any)._puppeteerPage = mockPuppeteer;

      // First evaluate is now in-flight
      const eval1Promise = page.evaluate(() => 1);
      expect(page.isEvaluating).toBe(true);

      // Second evaluate while first is in-flight must be rejected immediately by guard
      await expect(page.evaluate(() => 2)).rejects.toThrow(/An evaluate call is already in flight on this page/);

      // Clean up hanging promise
      evalResolve(1);
      await eval1Promise;
      expect(page.isEvaluating).toBe(false);

      // Detach puppeteer must also reset in-flight state
      (page as any)._isEvaluating = true;
      await page.detachPuppeteer();
      expect(page.isEvaluating).toBe(false);
    });

    it('finishes with clear error within budget when evaluate and readJobListFromSearchPane never resolve, and max 1 evaluate in flight', async () => {
      setupBaseMocks();

      let inFlightEvaluates = 0;
      let maxInFlightEvaluates = 0;

      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(() => {
          inFlightEvaluates++;
          maxInFlightEvaluates = Math.max(maxInFlightEvaluates, inFlightEvaluates);
          return new Promise(() => {}); // never resolves
        }),
        reload: vi.fn(),
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      const mockPage: any = {
        tabId: 555,
        puppeteerPage: mockPuppeteerPage,
        evaluate: vi.fn().mockImplementation(() => {
          inFlightEvaluates++;
          maxInFlightEvaluates = Math.max(maxInFlightEvaluates, inFlightEvaluates);
          return new Promise(() => {}); // never resolves
        }),
        readJobListFromSearchPane: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      const mockBrowserContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
        detachPage: vi.fn().mockResolvedValue(undefined),
      };

      (dedicatedJobRunner as any).browserContext = mockBrowserContext;
      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockResolvedValue(false);

      const statusMessages: string[] = [];
      const liveActivityUpdates: any[] = [];
      const mockPort: any = {
        postMessage: vi.fn((msg: any) => {
          if (msg?.text) statusMessages.push(msg.text);
        }),
      };

      const result = await dedicatedJobRunner.startAutonomousJobLoop({
        platform: 'linkedin',
        portToSend: mockPort,
        onLiveActivity: (act: any) => liveActivityUpdates.push(act),
        runnerMode: 'tab',
        startupBudgetMs: 600,
        heartbeatIntervalMs: 150,
      } as any);

      // Finished cleanly with error within budget
      expect(result.status).toBe('error');
      expect(result.message).toContain('LinkedIn startup watchdog exceeded 90s budget');
      expect(result.message).toContain('Please retry');

      // ONE Live Activity error naming the step, time, and path
      const timeoutActivity = liveActivityUpdates.find(a => a.jobId === 'startup_timeout');
      expect(timeoutActivity).toBeDefined();
      expect(timeoutActivity.status).toBe('failed');
      expect(timeoutActivity.reason).toContain('LinkedIn startup watchdog exceeded');
      expect(timeoutActivity.url).toContain('/jobs/search');

      // Heartbeat sent updates while working
      expect(
        statusMessages.some(m => m.includes('Still working:')) ||
          liveActivityUpdates.some(a => a.jobId === 'startup_heartbeat'),
      ).toBe(true);

      // In-flight evaluates never piled up (guarded)
      expect(maxInFlightEvaluates).toBeLessThanOrEqual(1);
    }, 15000);

    it('recovery on timeout: first attempt hangs, recovery re-attaches fresh page, and retry succeeds', async () => {
      setupBaseMocks();

      const mockJob = {
        jobId: '2002',
        title: 'Full Stack Engineer',
        company: 'CloudCorp',
        location: 'Remote',
        url: 'https://www.linkedin.com/jobs/view/2002/',
      };

      // Mock chrome.debugger.detach
      (globalThis as any).chrome.debugger = {
        detach: vi.fn().mockResolvedValue({}),
      };

      // Mock Page 1 (hangs on first attempt)
      let attemptCount = 0;
      const mockPage1: any = {
        tabId: 555,
        evaluate: vi.fn().mockImplementation(async (fn: any) => {
          const fnStr = fn.toString();
          if (fn.name === 'inspectSearchListSettlement' || fnStr.includes('distinctElements')) {
            return {
              cardCount: 3,
              componentKeyCount: 3,
              occludableCount: 3,
              dataJobIdCount: 3,
              dataViewNameCount: 3,
              urlPath: '/jobs/search/?keywords=Software%20Engineer',
              visibilityState: 'visible',
              isLoginWall: false,
              isCheckpoint: false,
            };
          }
          if (fnStr.includes('nanobrowser-runner-indicator')) return undefined;
          if (fnStr.includes('/authwall') || fnStr.includes('login__form')) return false;
          return false;
        }),
        readJobListFromSearchPane: vi.fn().mockImplementation(() => {
          attemptCount++;
          // First attempt hangs forever to simulate wedged CDP call
          return new Promise(() => {});
        }),
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      // Mock Page 2 (fresh page after recovery succeeds)
      const mockPage2: any = {
        tabId: 555,
        evaluate: mockPage1.evaluate,
        readJobListFromSearchPane: vi.fn().mockResolvedValue([mockJob]),
        hasAnyOpenModalOrDialog: vi.fn().mockResolvedValue(false),
        isEasyApplyModalOpen: vi.fn().mockResolvedValue(false),
        extractJobTopCardContext: vi.fn().mockResolvedValue({
          title: 'Full Stack Engineer',
          company: 'CloudCorp',
          hasEasyApply: true,
          isLoginWall: false,
        }),
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      let pageGetCount = 0;
      const mockBrowserContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockImplementation(async () => {
          pageGetCount++;
          return pageGetCount === 1 ? mockPage1 : mockPage2;
        }),
        detachPage: vi.fn().mockResolvedValue(undefined),
      };

      (dedicatedJobRunner as any).browserContext = mockBrowserContext;
      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockResolvedValue(false);
      vi.spyOn(dedicatedJobRunner as any, 'applySingleLinkedInJobInSplitPane').mockResolvedValue({
        status: 'applied',
        usedDirectFallback: false,
      });

      // Advance timers when withTimeout is waiting
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: any, ms?: number) => {
        // Fast-forward any 15000ms scan timeout to 20ms in test environment
        const actualMs = ms === 15000 ? 20 : ms;
        return originalSetTimeout(cb, actualMs);
      });

      const statusMessages: string[] = [];
      const mockPort: any = {
        postMessage: vi.fn((msg: any) => {
          if (msg?.text) statusMessages.push(msg.text);
        }),
      };

      const result = await dedicatedJobRunner.startAutonomousJobLoop({
        platform: 'linkedin',
        portToSend: mockPort,
        onLiveActivity: vi.fn(),
        runnerMode: 'tab',
      });

      // The connection was treated as wedged, recovered fresh Page, and succeeded
      expect(pageGetCount).toBeGreaterThanOrEqual(2);
      expect((globalThis as any).chrome.debugger.detach).toHaveBeenCalled();
      expect(mockBrowserContext.detachPage).toHaveBeenCalledWith(555);
      expect(result.status).toBe('success');
      expect(statusMessages.some(m => m.includes('Found 1 job cards'))).toBe(true);
    }, 15000);
  });
});
