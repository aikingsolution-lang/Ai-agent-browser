import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';
import { dedicatedWindowManager, DedicatedWindowManager } from '../linkedin/dedicatedWindow';
import { indeedAdapter } from '../platforms/indeed/indeedAdapter';
import { queueSafetyStore, processedJobsStore } from '@extension/storage';

describe('DedicatedJobRunner - Indeed Auto Apply Flow & Scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes startIndeedJobLoop without reference errors (verifies currentPage scope)', async () => {
    // Mock runner window creation
    vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
      windowId: 10,
      tabId: 101,
      mode: 'tab',
    });
    vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();

    const mockPuppeteerPage = {
      evaluate: vi.fn().mockResolvedValue(true),
    };

    const mockPage: any = {
      tabId: 101,
      puppeteerPage: mockPuppeteerPage,
    };

    // Mock browser context
    const mockContext: any = {
      updateCurrentTabId: vi.fn(),
      getCurrentPage: vi.fn().mockResolvedValue(mockPage),
    };
    (dedicatedJobRunner as any).browserContext = mockContext;
    (dedicatedJobRunner as any).isRunning = true;
    (dedicatedJobRunner as any).activeRunId = 'test-run';

    // Mock sleep to skip real delays
    vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockResolvedValue(false);

    // Mock adapter methods
    vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);
    vi.spyOn(indeedAdapter, 'validateSession').mockResolvedValue({
      isLoggedIn: true,
      isLoginWall: false,
    });
    vi.spyOn(indeedAdapter, 'extractJobCards').mockResolvedValue([]);
    vi.spyOn(indeedAdapter, 'buildJobQueue').mockResolvedValue({
      queue: [],
      totalScanned: 0,
      totalQuickApply: 0,
      logMessage: '0 jobs found',
    });

    const stats = { applied: 0, skipped: 0, failed: 0 };
    const result = await (dedicatedJobRunner as any).startIndeedJobLoop(
      { platform: 'indeed' },
      {} as any,
      'Full Stack Developer',
      'Bengaluru',
      'test-run',
      stats,
    );

    // Assert it executes without throwing ReferenceError: currentPage is not defined
    expect(result).toBeDefined();
    expect(result.status).toBe('success');
    expect(mockContext.getCurrentPage).toHaveBeenCalled();
    expect(indeedAdapter.validateSession).toHaveBeenCalledWith(mockPage);
  });

  it('resumes search scan when search CAPTCHA is cleared during manual solve window', async () => {
    vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
      windowId: 10,
      tabId: 101,
      mode: 'tab',
    });
    vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();

    const mockPage: any = {
      tabId: 101,
      puppeteerPage: { evaluate: vi.fn().mockResolvedValue(true) },
    };

    (dedicatedJobRunner as any).browserContext = {
      updateCurrentTabId: vi.fn(),
      getCurrentPage: vi.fn().mockResolvedValue(mockPage),
    };
    (dedicatedJobRunner as any).isRunning = true;
    (dedicatedJobRunner as any).activeRunId = 'test-run';
    vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockResolvedValue(false);

    // Search captcha detected initially
    vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValueOnce(true).mockResolvedValue(false);
    vi.spyOn(indeedAdapter, 'waitForManualCaptchaResolution').mockResolvedValue({
      solved: true,
      aborted: false,
    });

    vi.spyOn(indeedAdapter, 'validateSession').mockResolvedValue({
      isLoggedIn: true,
      isLoginWall: false,
    });
    vi.spyOn(indeedAdapter, 'extractJobCards').mockResolvedValue([]);
    vi.spyOn(indeedAdapter, 'buildJobQueue').mockResolvedValue({
      queue: [],
      totalScanned: 0,
      totalQuickApply: 0,
      logMessage: '0 jobs found',
    });

    const stats = { applied: 0, skipped: 0, failed: 0 };
    const result = await (dedicatedJobRunner as any).startIndeedJobLoop(
      { platform: 'indeed' },
      {} as any,
      'Full Stack Developer',
      'Bengaluru',
      'test-run',
      stats,
    );

    expect(result.status).toBe('success');
    expect(indeedAdapter.waitForManualCaptchaResolution).toHaveBeenCalled();
    expect(indeedAdapter.validateSession).toHaveBeenCalledWith(mockPage);
  });

  it('handles tab open failure gracefully without hanging', async () => {
    vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockRejectedValue(
      new Error('Extension permission denied'),
    );

    const stats = { applied: 0, skipped: 0, failed: 0 };
    const result = await (dedicatedJobRunner as any).startIndeedJobLoop(
      { platform: 'indeed' },
      {} as any,
      'Full Stack Developer',
      'Bengaluru',
      'test-run-fail-open',
      stats,
    );

    expect(result).toBeDefined();
    expect(result.status).toBe('stopped');
    expect(result.message).toContain('Failed to open runner');
    expect((dedicatedJobRunner as any).isRunning).toBe(false);
  });

  it('triggers clean stop when runner tab is closed mid-run', async () => {
    let closeListenerCb: ((reason: any) => void) | null = null;
    vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
      windowId: 10,
      tabId: 101,
      mode: 'tab',
    });
    vi.spyOn(dedicatedWindowManager, 'onWindowClosed').mockImplementation((cb: any) => {
      closeListenerCb = cb;
      return () => {};
    });
    const stopSpy = vi.spyOn(dedicatedJobRunner, 'stop').mockResolvedValue();

    const mockPage: any = {
      tabId: 101,
      puppeteerPage: { evaluate: vi.fn().mockResolvedValue(true) },
    };
    (dedicatedJobRunner as any).browserContext = {
      updateCurrentTabId: vi.fn(),
      getCurrentPage: vi.fn().mockResolvedValue(mockPage),
    };
    (dedicatedJobRunner as any).isRunning = true;
    (dedicatedJobRunner as any).activeRunId = 'test-run-tab-close';

    // Keep loop in active pending state via interruptibleSleep
    let resolveSleep: any;
    vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockImplementation(() => {
      return new Promise(resolve => {
        resolveSleep = resolve;
      });
    });

    // Start loop (will register listener and wait in initial navigation settle)
    const runPromise = (dedicatedJobRunner as any).startIndeedJobLoop(
      { platform: 'indeed' },
      {} as any,
      'Full Stack Developer',
      'Bengaluru',
      'test-run-tab-close',
      { applied: 0, skipped: 0, failed: 0 },
    );

    // Yield to microtasks so getOrCreateRunnerWindow resolves and listeners register
    await new Promise(r => setTimeout(r, 10));

    expect(closeListenerCb).toBeDefined();

    // Trigger user closing the runner tab
    closeListenerCb!('tab_closed');

    expect(stopSpy).toHaveBeenCalled();
    resolveSleep?.(true);
    await runPromise.catch(() => {});
  });

  it('triggers clean stop when runner tab navigates away from Indeed', async () => {
    let navAwayCb: ((url: string) => void) | null = null;
    vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
      windowId: 10,
      tabId: 101,
      mode: 'tab',
    });
    vi.spyOn(dedicatedWindowManager, 'onNavigatedAway').mockImplementation((cb: any) => {
      navAwayCb = cb;
      return () => {};
    });
    const stopSpy = vi.spyOn(dedicatedJobRunner, 'stop').mockResolvedValue();

    const mockPage: any = {
      tabId: 101,
      puppeteerPage: { evaluate: vi.fn().mockResolvedValue(true) },
    };
    (dedicatedJobRunner as any).browserContext = {
      updateCurrentTabId: vi.fn(),
      getCurrentPage: vi.fn().mockResolvedValue(mockPage),
    };
    (dedicatedJobRunner as any).isRunning = true;
    (dedicatedJobRunner as any).activeRunId = 'test-run-nav-away';

    let resolveSleep: any;
    vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockImplementation(() => {
      return new Promise(resolve => {
        resolveSleep = resolve;
      });
    });

    const runPromise = (dedicatedJobRunner as any).startIndeedJobLoop(
      { platform: 'indeed' },
      {} as any,
      'Full Stack Developer',
      'Bengaluru',
      'test-run-nav-away',
      { applied: 0, skipped: 0, failed: 0 },
    );

    // Yield to microtasks so getOrCreateRunnerWindow resolves and listeners register
    await new Promise(r => setTimeout(r, 10));

    expect(navAwayCb).toBeDefined();

    // User types youtube.com in runner tab
    navAwayCb!('https://www.youtube.com');

    expect(stopSpy).toHaveBeenCalled();
    resolveSleep?.(true);
    await runPromise.catch(() => {});
  });

  describe('DedicatedWindowManager - RunnerMode & Safety', () => {
    it('tab mode creates a tab in current window and preserves user window on close', async () => {
      const tabsCreate = vi.fn().mockResolvedValue({ id: 505, windowId: 99 });
      const tabsRemove = vi.fn().mockResolvedValue(undefined);
      const windowsRemove = vi.fn().mockResolvedValue(undefined);
      const windowsGetLastFocused = vi.fn().mockResolvedValue({ id: 99 });

      (globalThis as any).chrome = {
        windows: {
          getLastFocused: windowsGetLastFocused,
          remove: windowsRemove,
          onRemoved: { addListener: vi.fn() },
        },
        tabs: {
          create: tabsCreate,
          remove: tabsRemove,
          onRemoved: { addListener: vi.fn() },
          onUpdated: { addListener: vi.fn() },
        },
      };

      const manager = new DedicatedWindowManager();
      const target = await manager.getOrCreateRunnerWindow('https://in.indeed.com', { mode: 'tab' });

      expect(target.tabId).toBe(505);
      expect(target.windowId).toBe(99);
      expect(target.mode).toBe('tab');
      expect(tabsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://in.indeed.com',
          windowId: 99,
          active: true,
        }),
      );
      expect(manager.isWindowOwner()).toBe(false);

      // Close runner
      await manager.closeRunnerWindow();

      // Only tab was removed, NOT the user's window
      expect(tabsRemove).toHaveBeenCalledWith(505);
      expect(windowsRemove).not.toHaveBeenCalled();
    });

    it('detects external navigation away and triggers callback', () => {
      let updateListener: any = null;
      (globalThis as any).chrome = {
        windows: { onRemoved: { addListener: vi.fn() } },
        tabs: {
          onRemoved: { addListener: vi.fn() },
          onUpdated: {
            addListener: vi.fn().mockImplementation(cb => {
              updateListener = cb;
            }),
          },
        },
      };

      const manager = new DedicatedWindowManager();
      manager.setAllowedUrlPatterns([/indeed\.com/i, /^about:blank$/i]);
      (manager as any).dedicatedTabId = 777;

      const navAwaySpy = vi.fn();
      manager.onNavigatedAway(navAwaySpy);

      // 1. Navigation within Indeed is allowed
      updateListener(777, { url: 'https://in.indeed.com/viewjob?jk=123' }, {});
      expect(navAwaySpy).not.toHaveBeenCalled();

      // 2. Navigation outside Indeed triggers callback
      updateListener(777, { url: 'https://www.youtube.com' }, {});
      expect(navAwaySpy).toHaveBeenCalledWith('https://www.youtube.com');
    });
  });

  describe('Prioritized Locations Waterfall Search', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
        windowId: 10,
        tabId: 101,
        mode: 'tab',
      });
      vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();

      const mockPuppeteerPage = {
        evaluate: vi.fn().mockResolvedValue(true),
        goto: vi.fn().mockResolvedValue(true),
      };

      const mockPage: any = {
        tabId: 101,
        puppeteerPage: mockPuppeteerPage,
      };

      const mockContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
      };
      (dedicatedJobRunner as any).browserContext = mockContext;
      (dedicatedJobRunner as any).isRunning = true;
      (dedicatedJobRunner as any).activeRunId = 'test-waterfall';

      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'validateSession').mockResolvedValue({
        isLoggedIn: true,
        isLoginWall: false,
      });
      vi.spyOn(indeedAdapter, 'applyToJob').mockResolvedValue({ status: 'applied' });
      vi.spyOn(processedJobsStore, 'isJobProcessed').mockResolvedValue({ isProcessed: false });
      vi.spyOn(processedJobsStore, 'recordJob').mockResolvedValue({} as any);
    });

    it('stops searching and does NOT try Location #2 or #3 if Location #1 reaches BATCH_CAP', async () => {
      const locations = ['Bengaluru, India', 'Hyderabad, India', 'Pune, India'];
      const buildSearchUrlSpy = vi.spyOn(indeedAdapter, 'buildSearchUrl');

      // Mock Location #1 returning 10 Quick Apply jobs on page 1
      const tenJobs: any[] = Array.from({ length: 10 }, (_, i) => ({
        jobId: `job-blr-${i}`,
        title: `Developer ${i}`,
        company: `Company ${i}`,
        url: `https://indeed.com/viewjob?jk=blr${i}`,
        isQuickApply: true,
      }));

      vi.spyOn(indeedAdapter, 'extractJobCards').mockResolvedValueOnce(tenJobs);

      const stats = { totalFound: 0, applied: 0, modalOpened: 0, skipped: 0, failed: 0 };
      const result = await (dedicatedJobRunner as any).startIndeedJobLoop(
        { platform: 'indeed', maxJobs: 10 },
        { fullName: 'Candidate Test' } as any,
        'Frontend Developer',
        locations,
        'test-waterfall-cap1',
        stats,
      );

      expect(result.status).toBe('success');
      expect(stats.applied).toBe(10);

      // Verify buildSearchUrl was called for Bengaluru, but NEVER for Hyderabad or Pune
      const searchCalls = buildSearchUrlSpy.mock.calls.map(c => c[1]); // 2nd param is location
      expect(searchCalls.some(l => l?.includes('Bengaluru'))).toBe(true);
      expect(searchCalls.some(l => l?.includes('Hyderabad'))).toBe(false);
      expect(searchCalls.some(l => l?.includes('Pune'))).toBe(false);
    });

    it('proceeds to Location #2 when Location #1 yields fewer jobs, and stops when BATCH_CAP is met', async () => {
      const locations = ['Bengaluru, India', 'Hyderabad, India', 'Pune, India'];
      const buildSearchUrlSpy = vi.spyOn(indeedAdapter, 'buildSearchUrl');

      // Location #1 (Bengaluru) yields only 3 jobs
      const threeJobsBLR: any[] = Array.from({ length: 3 }, (_, i) => ({
        jobId: `job-blr-${i}`,
        title: `Developer ${i}`,
        company: `Company ${i}`,
        url: `https://indeed.com/viewjob?jk=blr${i}`,
        isQuickApply: true,
      }));

      // Location #2 (Hyderabad) yields 7 jobs (making total 10)
      const sevenJobsHYD: any[] = Array.from({ length: 7 }, (_, i) => ({
        jobId: `job-hyd-${i}`,
        title: `Hyd Developer ${i}`,
        company: `Hyd Company ${i}`,
        url: `https://indeed.com/viewjob?jk=hyd${i}`,
        isQuickApply: true,
      }));

      let currentSearchedLoc = 'Bengaluru, India';
      buildSearchUrlSpy.mockImplementation((r, loc) => {
        if (loc) currentSearchedLoc = loc;
        return `https://in.indeed.com/jobs?q=${r}&l=${loc}`;
      });

      let blrCallCount = 0;
      vi.spyOn(indeedAdapter, 'extractJobCards').mockImplementation(async () => {
        if (currentSearchedLoc.includes('Bengaluru')) {
          blrCallCount++;
          if (blrCallCount === 1) return threeJobsBLR;
          return []; // empty on retry / page 2
        }
        if (currentSearchedLoc.includes('Hyderabad')) {
          return sevenJobsHYD;
        }
        return [];
      });

      const stats = { totalFound: 0, applied: 0, modalOpened: 0, skipped: 0, failed: 0 };
      const result = await (dedicatedJobRunner as any).startIndeedJobLoop(
        { platform: 'indeed', maxJobs: 10 },
        { fullName: 'Candidate Test' } as any,
        'Frontend Developer',
        locations,
        'test-waterfall-cap2',
        stats,
      );

      expect(result.status).toBe('success');
      expect(stats.applied).toBe(10);

      // Verify search was performed for Bengaluru and Hyderabad, but NOT Pune (since cap was reached)
      const searchCalls = buildSearchUrlSpy.mock.calls.map(c => c[1]);
      expect(searchCalls.some(l => l?.includes('Bengaluru'))).toBe(true);
      expect(searchCalls.some(l => l?.includes('Hyderabad'))).toBe(true);
      expect(searchCalls.some(l => l?.includes('Pune'))).toBe(false);
    });
  });
});
