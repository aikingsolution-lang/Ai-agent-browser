import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dedicatedJobRunner } from '../linkedin/dedicatedJobRunner';
import { dedicatedWindowManager, DedicatedWindowManager } from '../linkedin/dedicatedWindow';
import { naukriAdapter } from '../platforms/naukri/naukriAdapter';
import { authStorage, careerBrainStore } from '@extension/storage';
import { DailyQuotaManager } from '../linkedin/rateLimiter';

describe('LinkedIn and Naukri Tab Runner Mode & Navigation Boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DedicatedWindowManager Defaults & Tab Mode', () => {
    it('defaults to "tab" runner mode when no mode option is provided', async () => {
      const manager = new DedicatedWindowManager();
      const mockTab = { id: 999, windowId: 50 };

      // Mock chrome APIs
      (globalThis as any).chrome = {
        windows: {
          getLastFocused: vi.fn().mockResolvedValue({ id: 50 }),
          update: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
        tabs: {
          get: vi.fn().mockRejectedValue(new Error('Tab not found')),
          create: vi.fn().mockResolvedValue(mockTab),
          remove: vi.fn().mockResolvedValue({}),
          onRemoved: { addListener: vi.fn() },
          onUpdated: { addListener: vi.fn() },
        },
      };

      const result = await manager.getOrCreateRunnerWindow('https://www.linkedin.com/jobs');

      expect(result.mode).toBe('tab');
      expect(result.tabId).toBe(999);
      expect(result.windowId).toBe(50);
      expect(manager.getRunnerMode()).toBe('tab');
    });

    it('enforces allowed domains boundary for LinkedIn', () => {
      const manager = new DedicatedWindowManager();
      const onNavAway = vi.fn();
      manager.onNavigatedAway(onNavAway);
      manager.setAllowedUrlPatterns([/linkedin\.com/i, /^about:blank$/i]);

      // Allowed URL - does not fire
      (manager as any).checkNavigationAway('https://www.linkedin.com/jobs/search?keywords=engineer');
      expect(onNavAway).not.toHaveBeenCalled();

      // Disallowed URL - fires callback
      (manager as any).checkNavigationAway('https://malicious-site.com/login');
      expect(onNavAway).toHaveBeenCalledWith('https://malicious-site.com/login');
    });

    it('enforces allowed domains boundary for Naukri', () => {
      const manager = new DedicatedWindowManager();
      const onNavAway = vi.fn();
      manager.onNavigatedAway(onNavAway);
      manager.setAllowedUrlPatterns([/naukri\.com/i, /^about:blank$/i]);

      // Allowed URL - does not fire
      (manager as any).checkNavigationAway('https://www.naukri.com/full-stack-developer-jobs');
      expect(onNavAway).not.toHaveBeenCalled();

      // Disallowed URL - fires callback
      (manager as any).checkNavigationAway('https://external-tracker.com');
      expect(onNavAway).toHaveBeenCalledWith('https://external-tracker.com');
    });
  });

  describe('Naukri Autonomous Job Loop in Tab Mode', () => {
    it('opens Naukri in current window tab with allowedDomains: [/naukri\\.com/i, /^about:blank$/i]', async () => {
      const getRunnerSpy = vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
        windowId: 22,
        tabId: 333,
        mode: 'tab',
      });
      vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();

      const mockPuppeteerPage = {
        evaluate: vi.fn().mockResolvedValue(true),
      };

      const mockPage: any = {
        tabId: 333,
        evaluate: vi.fn().mockResolvedValue(true),
        puppeteerPage: mockPuppeteerPage,
      };

      const mockContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
      };
      (dedicatedJobRunner as any).browserContext = mockContext;
      (dedicatedJobRunner as any).isRunning = true;
      (dedicatedJobRunner as any).activeRunId = 'test-naukri-run';

      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockResolvedValue(false);
      vi.spyOn(naukriAdapter, 'validateSession').mockResolvedValue({
        isLoggedIn: true,
        isLoginWall: false,
      });
      vi.spyOn(naukriAdapter, 'extractJobCards').mockResolvedValue([]);

      const stats = { totalFound: 0, applied: 0, modalOpened: 0, skipped: 0, failed: 0 };
      const result = await (dedicatedJobRunner as any).startNaukriJobLoop(
        { platform: 'naukri' },
        {} as any,
        'Frontend Developer',
        'Bengaluru',
        'test-naukri-run',
        stats,
      );

      expect(getRunnerSpy).toHaveBeenCalledWith(
        expect.stringContaining('naukri.com'),
        expect.objectContaining({
          mode: 'tab',
          allowedDomains: expect.arrayContaining([/naukri\.com/i, /^about:blank$/i]),
        }),
      );
      expect(result.status).toBe('success');
      expect(mockContext.updateCurrentTabId).toHaveBeenCalledWith(333);
    });
  });

  describe('Closing Runner Tab Mid-Run', () => {
    it('stops execution cleanly when runner tab is closed mid-run', async () => {
      let closeListener: any = null;
      vi.spyOn(dedicatedWindowManager, 'onWindowClosed').mockImplementation((cb: any) => {
        closeListener = cb;
        return () => {};
      });

      vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
        windowId: 10,
        tabId: 200,
        mode: 'tab',
      });

      const stopSpy = vi.spyOn(dedicatedJobRunner, 'stop').mockResolvedValue();

      (dedicatedJobRunner as any).browserContext = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue({ tabId: 200, evaluate: vi.fn() }),
      };
      (dedicatedJobRunner as any).isRunning = true;
      (dedicatedJobRunner as any).activeRunId = 'test-close-run';

      vi.spyOn(dedicatedJobRunner as any, 'interruptibleSleep').mockResolvedValue(false);
      vi.spyOn(naukriAdapter, 'validateSession').mockImplementation(async () => {
        // Tab closed mid-run during active session validation
        if (closeListener) {
          await closeListener('tab_closed');
        }
        return { isLoggedIn: true, isLoginWall: false };
      });
      vi.spyOn(naukriAdapter, 'extractJobCards').mockResolvedValue([]);

      const stats = { totalFound: 0, applied: 0, modalOpened: 0, skipped: 0, failed: 0 };
      await (dedicatedJobRunner as any).startNaukriJobLoop(
        { platform: 'naukri' },
        {} as any,
        'Software Engineer',
        'Remote',
        'test-close-run',
        stats,
      );

      // Verify listener was registered and called stop
      expect(closeListener).toBeDefined();
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('LinkedIn Tab Runner Mode & Easy Apply Modal Interaction', () => {
    it('opens LinkedIn single job run in current window tab with linkedin.com boundary', async () => {
      vi.spyOn(authStorage, 'getSession').mockResolvedValue({ token: 'mock-token' } as any);
      vi.spyOn(DailyQuotaManager, 'canApplyToday').mockResolvedValue({
        allowed: true,
        currentCount: 0,
        maxQuota: 20,
        remaining: 20,
      });
      vi.spyOn(careerBrainStore, 'getCareerBrain').mockResolvedValue({
        fullName: 'Test Candidate',
        email: 'test@example.com',
        phoneNumber: '+1234567890',
        currentTitle: 'Software Engineer',
        yearsOfExperience: 5,
        workAuthorization: 'Authorized',
        resumeText: 'Experienced developer',
        resumeBase64: 'base64...',
        skills: ['TypeScript', 'React'],
      } as any);

      const getRunnerSpy = vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
        windowId: 10,
        tabId: 555,
        mode: 'tab',
      });
      vi.spyOn(dedicatedWindowManager, 'closeRunnerWindow').mockResolvedValue();

      const mockPage: any = {
        tabId: 555,
        evaluate: vi.fn().mockResolvedValue(true),
        extractJobTopCardContext: vi.fn().mockResolvedValue({
          title: 'Senior Frontend Engineer',
          company: 'Acme Corp',
          hasEasyApply: true,
          isLoginWall: false,
        }),
      };

      const mockContext: any = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue(mockPage),
      };
      (dedicatedJobRunner as any).browserContext = mockContext;
      (dedicatedJobRunner as any).executorFactory = vi.fn();
      (dedicatedJobRunner as any).isRunning = false;

      // Run single job
      const runPromise = (dedicatedJobRunner as any).runJobByUrl({
        inputUrl: 'https://www.linkedin.com/jobs/view/1234567890',
      });

      // Allow async setup to proceed
      await new Promise(r => setTimeout(r, 50));

      expect(getRunnerSpy).toHaveBeenCalledWith(
        expect.stringContaining('linkedin.com/jobs/view/1234567890'),
        expect.objectContaining({
          mode: 'tab',
          allowedDomains: expect.arrayContaining([/linkedin\.com/i, /^about:blank$/i]),
        }),
      );

      // Clean up run
      (dedicatedJobRunner as any).cleanupRun();
    });

    it('navigating away from LinkedIn mid-run triggers stop and clean exit', async () => {
      vi.spyOn(authStorage, 'getSession').mockResolvedValue({ token: 'mock-token' } as any);
      vi.spyOn(DailyQuotaManager, 'canApplyToday').mockResolvedValue({
        allowed: true,
        currentCount: 0,
        maxQuota: 20,
        remaining: 20,
      });
      vi.spyOn(careerBrainStore, 'getCareerBrain').mockResolvedValue({
        fullName: 'Test Candidate',
        email: 'test@example.com',
        phoneNumber: '+1234567890',
        currentTitle: 'Software Engineer',
        yearsOfExperience: 5,
        workAuthorization: 'Authorized',
        resumeText: 'Experienced developer',
        resumeBase64: 'base64...',
        skills: ['TypeScript', 'React'],
      } as any);

      let navAwayListener: any = null;
      vi.spyOn(dedicatedWindowManager, 'onNavigatedAway').mockImplementation((cb: any) => {
        navAwayListener = cb;
        return () => {};
      });

      vi.spyOn(dedicatedWindowManager, 'getOrCreateRunnerWindow').mockResolvedValue({
        windowId: 10,
        tabId: 555,
        mode: 'tab',
      });

      const stopSpy = vi.spyOn(dedicatedJobRunner, 'stop').mockResolvedValue();

      (dedicatedJobRunner as any).browserContext = {
        updateCurrentTabId: vi.fn(),
        getCurrentPage: vi.fn().mockResolvedValue({
          tabId: 555,
          evaluate: vi.fn(),
          extractJobTopCardContext: vi.fn().mockResolvedValue({ hasEasyApply: true, isLoginWall: false }),
        }),
      };
      (dedicatedJobRunner as any).executorFactory = vi.fn();
      (dedicatedJobRunner as any).isRunning = false;

      (dedicatedJobRunner as any).runJobByUrl({
        inputUrl: 'https://www.linkedin.com/jobs/view/1234567890',
      });
      await new Promise(r => setTimeout(r, 50));

      expect(navAwayListener).toBeDefined();

      // Trigger navigation away
      await navAwayListener('https://youtube.com');

      expect((dedicatedJobRunner as any).isRunning).toBe(false);
    });
  });
});
