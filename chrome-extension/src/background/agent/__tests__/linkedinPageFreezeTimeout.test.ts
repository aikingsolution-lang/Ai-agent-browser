// chrome-extension/src/background/agent/__tests__/linkedinPageFreezeTimeout.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    tabs: { get: vi.fn(), query: vi.fn(), update: vi.fn() },
    runtime: { id: 'mock-ext-id' },
  },
}));

import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';
import { dedicatedWindowManager } from '../linkedin/dedicatedWindow';
import { authStorage, careerBrainStore } from '@extension/storage';
import * as preflightMod from '../linkedin/preflight';
import Page from '../../browser/page';

describe('LinkedIn Freeze Prevention & Bounded Waits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      // Must exit within timeout (+ small test grace) and not hang
      expect(elapsed).toBeLessThan(1000);
      expect(res.elapsedMs).toBeGreaterThanOrEqual(250);
    });
  });

  describe('DedicatedJobRunner Autonomous Loop Bounded Search Ready', () => {
    it('reloads once and cleanly terminates with descriptive error when LinkedIn search pane never loads', async () => {
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

      let reloadCalled = false;
      const evaluateCalls: string[] = [];
      const mockPuppeteerPage = {
        evaluate: vi.fn().mockImplementation(async (fn: any) => {
          const fnStr = fn.toString();
          evaluateCalls.push(fnStr);
          // Visual banner
          if (fnStr.includes('nanobrowser-runner-indicator')) return undefined;
          // Login wall check
          if (fnStr.includes('/authwall') || fnStr.includes('login__form')) return false;
          // Search results ready check: details pane stays in loading skeleton state!
          if (fnStr.includes('jobs-search-results-list') || fnStr.includes('jobs-search-results')) {
            return false;
          }
          return false;
        }),
        reload: vi.fn().mockImplementation(async () => {
          reloadCalled = true;
          return undefined;
        }),
        url: () => 'https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer',
      };

      const mockPage: any = {
        tabId: 555,
        puppeteerPage: mockPuppeteerPage,
        evaluate: mockPuppeteerPage.evaluate,
        reload: mockPuppeteerPage.reload,
        extractJobTopCardContext: vi.fn().mockResolvedValue({
          title: '',
          company: '',
          hasEasyApply: false,
          isLoginWall: false,
        }),
      };

      const mockBrowserContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
      };

      (dedicatedJobRunner as any).browserContext = mockBrowserContext;

      // Virtual time simulation for interruptibleSleep and Date.now so the 20s/15s timeout
      // completes within ~15 iterations without burning CPU/memory in a tight synchronous spin loop.
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

      const liveActivities: any[] = [];
      const onLiveActivity = vi.fn((act: any) => liveActivities.push(act));

      // Execute autonomous loop
      const result = await dedicatedJobRunner.startAutonomousJobLoop({
        platform: 'linkedin',
        portToSend: mockPort,
        onLiveActivity,
        runnerMode: 'tab',
      });

      // Verify that runner did NOT hang and completed with error
      expect(result.status).toBe('error');
      expect(result.message).toContain('failed to finish loading');

      // Verify status notified reload attempt
      expect(statusMessages.some(m => m.includes('reloading once'))).toBe(true);
      expect(reloadCalled).toBe(true);

      // Verify final failure status message
      expect(statusMessages.some(m => m.includes('details pane stayed in skeleton state'))).toBe(true);
    }, 15000);
  });
});
