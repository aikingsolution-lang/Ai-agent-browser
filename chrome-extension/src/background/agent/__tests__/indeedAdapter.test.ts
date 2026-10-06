import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queueSafetyStore, isCandidateNameOrInvalidTitle } from '@extension/storage';
import { indeedAdapter, IndeedAdapter } from '../platforms/indeed/indeedAdapter';
import { matchSalaryToOptions } from '../platforms/indeed/indeedResolver';
import { resolveTargetRoleFromResumeWithLLM, getLastResolvedAlternateRole } from '../linkedin/dedicatedJobRunner';

describe('IndeedAdapter - Phase 1', () => {
  it('correctly matches Indeed URLs', () => {
    expect(indeedAdapter.isMatchingUrl('https://www.indeed.com/jobs?q=engineer')).toBe(true);
    expect(indeedAdapter.isMatchingUrl('https://in.indeed.com/jobs')).toBe(true);
    expect(indeedAdapter.isMatchingUrl('https://uk.indeed.com')).toBe(true);
    expect(indeedAdapter.isMatchingUrl('https://www.linkedin.com/jobs')).toBe(false);
    expect(indeedAdapter.isMatchingUrl('')).toBe(false);
  });

  describe('buildSearchUrl', () => {
    it('builds India search URL when location is in India', () => {
      const url = indeedAdapter.buildSearchUrl('Frontend Developer', 'Bengaluru, India');
      expect(url).toContain('https://in.indeed.com/jobs');
      expect(url).toContain('q=Frontend+Developer');
      expect(url).toContain('l=Bengaluru');
      expect(url).not.toContain('India'); // redundant country stripped
    });

    it('builds Global search URL for US / international locations', () => {
      const url = indeedAdapter.buildSearchUrl('Software Engineer', 'San Francisco, CA');
      expect(url).toContain('https://www.indeed.com/jobs');
      expect(url).toContain('q=Software+Engineer');
      expect(url).toContain('l=San+Francisco%2C+CA');
    });

    it('uses fallback role Software Engineer if role is empty', () => {
      const url = indeedAdapter.buildSearchUrl('', 'Remote');
      expect(url).toContain('q=Software+Engineer');
    });

    it('defensively sanitizes candidate personal names to Software Engineer', () => {
      const url1 = indeedAdapter.buildSearchUrl('MUBASSHIR ALI', 'Bengaluru, India', 0, 'Mubasshir Ali');
      expect(url1).toContain('q=Software+Engineer');
      expect(url1).not.toContain('MUBASSHIR');

      const url2 = indeedAdapter.buildSearchUrl('MUBASSHIR', 'Bengaluru, India', 0, 'Mubasshir Ali');
      expect(url2).toContain('q=Software+Engineer');
      expect(url2).not.toContain('MUBASSHIR');

      const url3 = indeedAdapter.buildSearchUrl('MUBASSHIR', 'Bengaluru, India');
      expect(url3).toContain('q=Software+Engineer');
      expect(url3).not.toContain('MUBASSHIR');
    });

    it('preserves valid target job titles', () => {
      const url = indeedAdapter.buildSearchUrl('Full Stack Developer', 'Bengaluru, India', 0, 'Mubasshir Ali');
      expect(url).toContain('q=Full+Stack+Developer');
    });

    it('appends start query parameter for pagination when start > 0', () => {
      const url = indeedAdapter.buildSearchUrl('Software Engineer', 'Bengaluru, India', 20);
      expect(url).toContain('start=20');
      expect(url).toContain('https://in.indeed.com/jobs');
    });
  });

  describe('validateSession', () => {
    it('detects logged-in state when profile indicator is present and sign-in button is absent', async () => {
      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockImplementation(async fn => {
            // Emulate browser evaluation with profile indicator
            return {
              isLoggedIn: true,
              isLoginWall: false,
            };
          }),
        },
      };

      const session = await indeedAdapter.validateSession(mockPage);
      expect(session.isLoggedIn).toBe(true);
      expect(session.isLoginWall).toBe(false);
    });

    it('detects logged-out state on search page with sign-in button', async () => {
      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockImplementation(async () => {
            return {
              isLoggedIn: false,
              isLoginWall: false,
            };
          }),
        },
      };

      const session = await indeedAdapter.validateSession(mockPage);
      expect(session.isLoggedIn).toBe(false);
      expect(session.isLoginWall).toBe(false);
    });

    it('detects login wall state when on auth url or login form', async () => {
      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockImplementation(async () => {
            return {
              isLoggedIn: false,
              isLoginWall: true,
            };
          }),
        },
      };

      const session = await indeedAdapter.validateSession(mockPage);
      expect(session.isLoggedIn).toBe(false);
      expect(session.isLoginWall).toBe(true);
    });
  });

  describe('checkCaptchaPresent', () => {
    it('returns true when challenge markers are present', async () => {
      const mockPuppeteerPage: any = {
        evaluate: vi.fn().mockResolvedValue(true),
      };
      const result = await indeedAdapter.checkCaptchaPresent(mockPuppeteerPage);
      expect(result).toBe(true);
    });

    it('returns false when no challenge markers exist', async () => {
      const mockPuppeteerPage: any = {
        evaluate: vi.fn().mockResolvedValue(false),
      };
      const result = await indeedAdapter.checkCaptchaPresent(mockPuppeteerPage);
      expect(result).toBe(false);
    });

    describe('evaluateCaptchaDOM real DOM regression checks', () => {
      let origDoc: any;
      let origWin: any;

      beforeEach(() => {
        origDoc = (globalThis as any).document;
        origWin = (globalThis as any).window;
      });

      afterEach(() => {
        (globalThis as any).document = origDoc;
        (globalThis as any).window = origWin;
      });

      function createMockEnvironment(options: {
        title?: string;
        bodyText?: string;
        elements?: Array<{
          selector: string;
          tagName?: string;
          className?: string;
          rect?: { width: number; height: number };
          style?: Record<string, string>;
          attributes?: Record<string, string>;
          isV3Badge?: boolean;
        }>;
      }) {
        const title = options.title || '';
        const bodyText = options.bodyText || '';
        const elements = options.elements || [];

        const mockElements = elements.map(e => ({
          tagName: (e.tagName || 'DIV').toUpperCase(),
          className: e.className || '',
          classList: {
            contains: (cls: string) => (e.className || '').split(' ').includes(cls),
          },
          attributes: e.attributes || {},
          style: e.style || {},
          rect: e.rect || { width: 100, height: 100 },
          selector: e.selector,
          closest: (sel: string) => {
            if (e.isV3Badge) return {};
            return null;
          },
          getBoundingClientRect: () => e.rect || { width: 100, height: 100 },
          getAttribute: (attr: string) => e.attributes?.[attr] || null,
        }));

        (globalThis as any).window = {
          getComputedStyle: (el: any) => el?.style || {},
        };

        (globalThis as any).document = {
          title,
          body: {
            innerText: bodyText,
          },
          querySelector: (sel: string) => {
            return (
              mockElements.find(m => {
                if (m.selector === sel) return true;
                if (sel.includes('src*=')) {
                  const targetSrc = sel
                    .split('src*=')[1]
                    .replace(/["'\]]/gi, '')
                    .toLowerCase();
                  return m.attributes['src']?.toLowerCase().includes(targetSrc);
                }
                return false;
              }) || null
            );
          },
          querySelectorAll: (sel: string) => {
            const sels = sel.split(',').map(s => s.trim());
            return mockElements.filter(m => {
              return sels.some(s => {
                if (m.selector === s) return true;
                if (s.includes('src*=')) {
                  const match = s.match(/src\*=["']?([^"'\]\s]+)/i);
                  const targetSrc = (match ? match[1] : '').toLowerCase();
                  return Boolean(targetSrc && m.attributes['src']?.toLowerCase().includes(targetSrc));
                }
                return false;
              });
            });
          },
        };
      }

      it('returns false on normal Indeed page with invisible reCAPTCHA v3 badge and disclaimer text', async () => {
        createMockEnvironment({
          title: 'Apply to Full Stack Engineer - Indeed.com',
          bodyText:
            'Select a resume. This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.',
          elements: [
            {
              selector: 'iframe[src*="recaptcha"]',
              tagName: 'IFRAME',
              className: '',
              attributes: { src: 'https://www.google.com/recaptcha/api2/anchor' },
              style: { position: 'fixed' },
              rect: { width: 256, height: 60 },
              isV3Badge: true,
            },
          ],
        });

        const mockPuppeteerPage: any = {
          evaluate: vi.fn().mockImplementation(async (fn: () => boolean) => fn()),
        };

        const result = await indeedAdapter.checkCaptchaPresent(mockPuppeteerPage);
        expect(result).toBe(false);
      });

      it('returns true when Cloudflare Turnstile title is present', async () => {
        createMockEnvironment({
          title: 'Just a moment...',
          bodyText: 'Checking your browser before accessing indeed.com',
        });

        const mockPuppeteerPage: any = {
          evaluate: vi.fn().mockImplementation(async (fn: () => boolean) => fn()),
        };

        const result = await indeedAdapter.checkCaptchaPresent(mockPuppeteerPage);
        expect(result).toBe(true);
      });

      it('returns true when visible #challenge-stage element is present', async () => {
        createMockEnvironment({
          title: 'Security Check',
          elements: [
            {
              selector: '#challenge-stage',
              tagName: 'DIV',
              rect: { width: 300, height: 120 },
              style: { display: 'block' },
            },
          ],
        });

        const mockPuppeteerPage: any = {
          evaluate: vi.fn().mockImplementation(async (fn: () => boolean) => fn()),
        };

        const result = await indeedAdapter.checkCaptchaPresent(mockPuppeteerPage);
        expect(result).toBe(true);
      });

      it('returns true when a genuine large interactive reCAPTCHA challenge modal is present', async () => {
        createMockEnvironment({
          title: 'Apply - Indeed',
          elements: [
            {
              selector: 'iframe[src*="recaptcha"]',
              tagName: 'IFRAME',
              attributes: { src: 'https://www.google.com/recaptcha/api2/bframe' },
              rect: { width: 400, height: 580 },
              isV3Badge: false,
            },
          ],
        });

        const mockPuppeteerPage: any = {
          evaluate: vi.fn().mockImplementation(async (fn: () => boolean) => fn()),
        };

        const result = await indeedAdapter.checkCaptchaPresent(mockPuppeteerPage);
        expect(result).toBe(true);
      });

      it('returns true on explicit Cloudflare Ray ID blocking page', async () => {
        createMockEnvironment({
          title: 'Attention Required! | Cloudflare',
          bodyText: 'Sorry, you have been blocked. Ray ID: 8f921345678 Cloudflare',
        });

        const mockPuppeteerPage: any = {
          evaluate: vi.fn().mockImplementation(async (fn: () => boolean) => fn()),
        };

        const result = await indeedAdapter.checkCaptchaPresent(mockPuppeteerPage);
        expect(result).toBe(true);
      });
    });
  });

  describe('extractJobCards - Phase 2', () => {
    it('correctly marks jobs as isQuickApply when both badge element and text line confirm and not external', async () => {
      const mockCards = [
        {
          platform: 'indeed' as const,
          jobId: '82193f799e22849a',
          title: 'Full Stack Engineer - I',
          company: 'MyAdvice',
          url: 'https://in.indeed.com/viewjob?jk=82193f799e22849a',
          isQuickApply: true,
        },
        {
          platform: 'indeed' as const,
          jobId: '3fc2762b67503973',
          title: 'Full Stack Developer',
          company: 'Airbus India Private Limited',
          url: 'https://in.indeed.com/viewjob?jk=3fc2762b67503973',
          isQuickApply: false,
        },
      ];

      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockResolvedValue(mockCards),
        },
      };

      const extracted = await indeedAdapter.extractJobCards(mockPage);
      expect(extracted).toHaveLength(2);
      expect(extracted[0].isQuickApply).toBe(true);
      expect(extracted[1].isQuickApply).toBe(false);
    });

    it('returns empty array when page evaluation returns no jobs or no-results banner', async () => {
      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockResolvedValue([]),
        },
      };

      const extracted = await indeedAdapter.extractJobCards(mockPage);
      expect(extracted).toEqual([]);
    });
  });

  describe('buildJobQueue - Phase 3', () => {
    const mockJobsList = [
      {
        platform: 'indeed' as const,
        jobId: 'qa-1',
        title: 'Full Stack Engineer',
        company: 'Quick Co 1',
        url: 'https://in.indeed.com/viewjob?jk=qa-1',
        isQuickApply: true,
      },
      {
        platform: 'indeed' as const,
        jobId: 'ext-1',
        title: 'Full Stack Developer',
        company: 'External Co 1',
        url: 'https://in.indeed.com/viewjob?jk=ext-1',
        isQuickApply: false,
      },
      {
        platform: 'indeed' as const,
        jobId: 'qa-2',
        title: 'MERN Developer',
        company: 'Quick Co 2',
        url: 'https://in.indeed.com/viewjob?jk=qa-2',
        isQuickApply: true,
      },
      {
        platform: 'indeed' as const,
        jobId: 'ext-2',
        title: 'Senior Developer',
        company: 'External Co 2',
        url: 'https://in.indeed.com/viewjob?jk=ext-2',
        isQuickApply: false,
      },
      {
        platform: 'indeed' as const,
        jobId: 'qa-3',
        title: 'Frontend Engineer',
        company: 'Quick Co 3',
        url: 'https://in.indeed.com/viewjob?jk=qa-3',
        isQuickApply: true,
      },
    ];

    it('strictly queues ONLY jobs with isQuickApply === true and excludes external jobs', async () => {
      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockResolvedValue(mockJobsList),
        },
      };

      const result = await indeedAdapter.buildJobQueue(mockPage, { maxJobs: 10 });
      expect(result.totalScanned).toBe(5);
      expect(result.totalQuickApply).toBe(3);
      expect(result.queue).toHaveLength(3);
      expect(result.queue.every(j => j.isQuickApply === true)).toBe(true);
      expect(result.queue.map(j => j.jobId)).toEqual(['qa-1', 'qa-2', 'qa-3']);
      expect(result.logMessage).toContain('Only 3 Quick Apply jobs found');
    });

    it('caps queue at maxJobs without backfilling from external listings', async () => {
      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockResolvedValue(mockJobsList),
        },
      };

      const result = await indeedAdapter.buildJobQueue(mockPage, { maxJobs: 2 });
      expect(result.queue).toHaveLength(2);
      expect(result.queue.map(j => j.jobId)).toEqual(['qa-1', 'qa-2']);
      expect(result.queue.every(j => j.isQuickApply === true)).toBe(true);
    });

    it('excludes previously processed jobs and notifies onJobSkipped callback', async () => {
      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockResolvedValue(mockJobsList),
        },
      };

      const skippedCallback = vi.fn();
      const isJobProcessed = vi.fn().mockImplementation(async (id: string) => id === 'qa-1');

      const result = await indeedAdapter.buildJobQueue(mockPage, {
        maxJobs: 10,
        isJobProcessed,
        onJobSkipped: skippedCallback,
      });

      expect(result.queue).toHaveLength(2);
      expect(result.queue.map(j => j.jobId)).toEqual(['qa-2', 'qa-3']);
      expect(skippedCallback).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'qa-1' }),
        'Already applied previously',
      );
    });

    it('handles scenario when 0 Quick Apply jobs exist among scanned listings', async () => {
      const externalOnlyList = [
        {
          platform: 'indeed' as const,
          jobId: 'ext-1',
          title: 'Full Stack Developer',
          company: 'External Co 1',
          url: 'https://in.indeed.com/viewjob?jk=ext-1',
          isQuickApply: false,
        },
      ];

      const mockPage: any = {
        puppeteerPage: {
          evaluate: vi.fn().mockResolvedValue(externalOnlyList),
        },
      };

      const result = await indeedAdapter.buildJobQueue(mockPage, { maxJobs: 10 });
      expect(result.queue).toHaveLength(0);
      expect(result.totalQuickApply).toBe(0);
      expect(result.logMessage).toContain('No direct "Easily apply" jobs found');
    });
  });

  describe('Phase 5 - Apply Flow & CAPTCHA Checkpoints', () => {
    beforeEach(() => {
      indeedAdapter.captchaManualSolveTimeoutMs = 15;
      indeedAdapter.captchaPollIntervalMs = 5;
    });

    const mockJob = {
      platform: 'indeed' as const,
      jobId: 'indeed-test-123',
      title: 'Full Stack Engineer',
      company: 'Tech Innovations',
      url: 'https://in.indeed.com/viewjob?jk=indeed-test-123',
      isQuickApply: true,
    };

    it('Checkpoint 1: Detects CAPTCHA immediately after navigation and pauses platform for today', async () => {
      const pauseSpy = vi.spyOn(queueSafetyStore, 'pausePlatformForToday').mockResolvedValue();
      const waitPageSettleSpy = vi
        .spyOn(indeedAdapter.pacing, 'waitPageSettle')
        .mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });

      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockResolvedValue(true), // Simulates CAPTCHA detected
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Indeed Captcha/Bot Challenge detected');
      expect(pauseSpy).toHaveBeenCalledWith('indeed', 'Indeed requested additional verification');
      expect(waitPageSettleSpy).toHaveBeenCalled();
    });

    it('skips job cleanly if already applied', async () => {
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);

      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockResolvedValue(true), // Simulates already applied found
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('Already applied on Indeed');
    });

    it('skips job cleanly if Apply button points to an external company site', async () => {
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);

      let evalCallCount = 0;
      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async () => {
            evalCallCount++;
            if (evalCallCount === 1) return false; // already applied check
            return {
              found: true,
              isExternal: true,
              strategy: 'selector: external',
              text: 'Apply on company site',
            };
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('Requires applying directly on company site');
    });

    it('skips cleanly with accurate auth-wall message if session redirected to sign in / login wall', async () => {
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'validateSession').mockResolvedValue({
        isLoggedIn: false,
        isLoginWall: true,
      });

      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async (fn: any) => {
            // Already applied check returns false
            return false;
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe(
        'Indeed session appears logged out — please sign in to Indeed in the runner window to continue.',
      );
    });

    it('Checkpoint 2: Detects CAPTCHA immediately after clicking Apply button and pauses platform', async () => {
      const pauseSpy = vi.spyOn(queueSafetyStore, 'pausePlatformForToday').mockResolvedValue();
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });

      let captchaCheckCount = 0;
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockImplementation(async () => {
        captchaCheckCount++;
        // Checkpoint 1: false; Checkpoint 2 (after apply click): true
        return captchaCheckCount >= 2;
      });

      let evalCallCount = 0;
      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async () => {
            evalCallCount++;
            if (evalCallCount === 1) return false; // already applied check
            return {
              found: true,
              isExternal: false,
              strategy: 'text-match: "Apply now"',
              text: 'Apply now',
            };
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Indeed Captcha/Bot Challenge detected');
      expect(pauseSpy).toHaveBeenCalledWith('indeed', 'Indeed requested additional verification');
    });

    it('Checkpoint 4: Detects CAPTCHA during multi-step transition and pauses platform', async () => {
      const pauseSpy = vi.spyOn(queueSafetyStore, 'pausePlatformForToday').mockResolvedValue();
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitStepTransition').mockResolvedValue({ delayMs: 0, wasAborted: false });

      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkCaptchaPresentOnTab').mockResolvedValue(true); // Checkpoint 4 triggers

      let evalCallCount = 0;
      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async () => {
            evalCallCount++;
            if (evalCallCount === 1) return false; // already applied
            if (evalCallCount === 2) {
              return {
                found: true,
                isExternal: false,
                strategy: 'selector: #indeedApplyButton',
                text: 'Apply now',
              };
            }
            return true; // inline modal detected
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Indeed Captcha/Bot Challenge detected');
      expect(pauseSpy).toHaveBeenCalledWith('indeed', 'Indeed requested additional verification');
    });

    it('resumes application when challenge is manually solved within the window', async () => {
      indeedAdapter.captchaManualSolveTimeoutMs = 1000;
      indeedAdapter.captchaPollIntervalMs = 5;

      const pauseSpy = vi.spyOn(queueSafetyStore, 'pausePlatformForToday').mockResolvedValue();
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitStepTransition').mockResolvedValue({ delayMs: 0, wasAborted: false });

      // First check returns true (challenge presented); subsequent poll check returns false (solved!)
      let captchaPollCount = 0;
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockImplementation(async () => {
        captchaPollCount++;
        return captchaPollCount === 1;
      });
      vi.spyOn(indeedAdapter, 'checkCaptchaPresentOnTab').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkApplicationSubmitted').mockResolvedValue(true);
      vi.spyOn(indeedAdapter, 'findStepActionButton').mockResolvedValue({
        found: true,
        type: 'submit',
        text: 'Submit your application',
      });
      vi.spyOn(indeedAdapter, 'clickStepActionButton').mockResolvedValue(true);

      const mockLiveActivity = vi.fn();
      let evalCount = 0;
      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async () => {
            evalCount++;
            if (evalCount === 1) return false; // already applied: false
            return {
              found: true,
              isExternal: false,
              strategy: 'selector: #indeedApplyButton',
              text: 'Apply now',
            };
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
        onLiveActivity: mockLiveActivity,
      });

      expect(result.status).toBe('applied');
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(mockLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'needs_verification',
        }),
      );
      expect(mockLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
          reason: expect.stringContaining('Verification solved'),
        }),
      );
    });

    it('challenge timing out falls back to daily pause', async () => {
      indeedAdapter.captchaManualSolveTimeoutMs = 15;
      indeedAdapter.captchaPollIntervalMs = 5;

      const pauseSpy = vi.spyOn(queueSafetyStore, 'pausePlatformForToday').mockResolvedValue();
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });

      // Keeps returning true until timeout
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(true);

      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockResolvedValue(true),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Indeed Captcha/Bot Challenge detected');
      expect(pauseSpy).toHaveBeenCalledWith('indeed', 'Indeed requested additional verification');
    });

    it('respects Stop button during verification wait window without pausing platform', async () => {
      indeedAdapter.captchaManualSolveTimeoutMs = 60_000;
      indeedAdapter.captchaPollIntervalMs = 5;

      const pauseSpy = vi.spyOn(queueSafetyStore, 'pausePlatformForToday').mockResolvedValue();
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });

      const abortController = new AbortController();

      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockImplementation(async () => {
        // User clicks Stop during wait
        abortController.abort();
        return { delayMs: 0, wasAborted: true };
      });

      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(true);

      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockResolvedValue(true),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
        signal: abortController.signal,
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('Stopped by user');
      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it('progresses through form steps and returns applied status upon submission confirmation', async () => {
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitStepTransition').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkCaptchaPresentOnTab').mockResolvedValue(false);

      let stepNum = 0;
      vi.spyOn(indeedAdapter, 'checkApplicationSubmitted').mockImplementation(async () => {
        return stepNum >= 2; // Submitted after step 2
      });

      vi.spyOn(indeedAdapter, 'findStepActionButton').mockImplementation(async () => {
        stepNum++;
        if (stepNum === 1) {
          return { found: true, type: 'continue', text: 'Continue', inputCount: 1 };
        }
        return { found: true, type: 'submit', text: 'Submit your application', inputCount: 0 };
      });

      vi.spyOn(indeedAdapter, 'clickStepActionButton').mockResolvedValue(true);

      let evalCallCount = 0;
      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async () => {
            evalCallCount++;
            if (evalCallCount === 1) return false; // already applied
            if (evalCallCount === 2) {
              return {
                found: true,
                isExternal: false,
                strategy: 'selector: [data-testid="viewjob-indeed-apply"]',
                text: 'Apply now',
              };
            }
            return true; // modal detected
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('applied');
      expect(result.creditsUsed).toBe(1);
    });

    it('breaks loop and skips cleanly if form gets stuck on the same step for 3 consecutive attempts', async () => {
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitStepTransition').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkCaptchaPresentOnTab').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkApplicationSubmitted').mockResolvedValue(false);

      // Same step repeating
      vi.spyOn(indeedAdapter, 'findStepActionButton').mockResolvedValue({
        found: true,
        type: 'continue',
        text: 'Continue',
        inputCount: 2,
      });

      vi.spyOn(indeedAdapter, 'clickStepActionButton').mockResolvedValue(true);

      let evalCallCount = 0;
      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async () => {
            evalCallCount++;
            if (evalCallCount === 1) return false; // already applied
            if (evalCallCount === 2) {
              return {
                found: true,
                isExternal: false,
                strategy: 'selector: #indeedApplyButton',
                text: 'Apply now',
              };
            }
            return true; // modal detected
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('Form requires unanswered required fields or manual input');
    });

    it('does not treat pre-existing browser tabs as external application tabs in tab runner mode', async () => {
      vi.spyOn(indeedAdapter.pacing, 'waitPageSettle').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter.pacing, 'waitStepTransition').mockResolvedValue({ delayMs: 0, wasAborted: false });
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkCaptchaPresentOnTab').mockResolvedValue(false);
      vi.spyOn(indeedAdapter, 'checkApplicationSubmitted').mockResolvedValue(true);

      const removeSpy = vi.fn().mockResolvedValue(undefined);
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn().mockResolvedValue([
            { id: 101, url: 'https://in.indeed.com/viewjob?jk=test' },
            { id: 888, url: 'https://github.com/my-repo' },
            { id: 999, url: 'https://google.com' },
          ]),
          remove: removeSpy,
        },
      };

      let evalCallCount = 0;
      const mockPage: any = {
        tabId: 101,
        puppeteerPage: {
          goto: vi.fn().mockResolvedValue(null),
          evaluate: vi.fn().mockImplementation(async () => {
            evalCallCount++;
            if (evalCallCount === 1) return false;
            if (evalCallCount === 2) {
              return {
                found: true,
                isExternal: false,
                strategy: 'selector: #indeedApplyButton',
                text: 'Apply now',
              };
            }
            return true; // inline modal detected
          }),
        },
      };

      const result = await indeedAdapter.applyToJob(mockJob, {
        page: mockPage,
        browserContext: {} as any,
        careerBrain: {} as any,
        runId: 'run-test',
      });

      expect(result.status).toBe('applied');
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });

  describe('Phase 6 - Form Field Resolution, Resume Picker & Auto-Healing', () => {
    it('scans and fills unfilled inputs using resolveIndeedQuestion and pacing', async () => {
      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });

      const mockFields = [
        {
          index: 0,
          labelText: 'How many years of experience do you have with React?',
          fieldType: 'number',
          options: [],
          isFilled: false,
        },
        {
          index: 1,
          labelText: 'Will you require visa sponsorship?',
          fieldType: 'radio',
          options: ['Yes', 'No'],
          isFilled: false,
        },
        {
          index: 2,
          labelText: 'Already filled field',
          fieldType: 'text',
          options: [],
          isFilled: true,
        },
      ];

      const evaluateMock = vi.fn().mockImplementation(async (fn: any, ...args: any[]) => {
        if (typeof fn === 'function' && args.length === 0) {
          // evaluateScanDOM call
          return mockFields;
        }
        // evaluateFillDOM call
        return true;
      });

      const mockPuppeteerPage: any = {
        target: () => ({ tabId: 101 }),
        evaluate: evaluateMock,
      };

      const mockLiveActivity = vi.fn();
      const mockContext: any = {
        careerBrain: {
          yearsOfExperience: 3,
          skillExperience: { React: 3 },
          currentTitle: 'Full Stack Engineer',
        },
        onLiveActivity: mockLiveActivity,
      };

      const mockJob: any = {
        jobId: 'test-qa-job',
        title: 'Full Stack Developer',
        company: 'AI-King',
        url: 'https://in.indeed.com/viewjob?jk=test-qa-job',
      };

      const filledCount = await indeedAdapter.scanAndFillCurrentStepFields(
        101,
        mockPuppeteerPage,
        mockContext,
        mockJob,
      );

      expect(filledCount).toBe(2);
      expect(mockLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'test-qa-job',
          reason: expect.stringContaining('[profile]'),
        }),
      );
    });

    it('does NOT corrupt numeric years of experience questions into 100000', async () => {
      const mockFields = [
        {
          index: 0,
          labelText: 'How many years of MERN Stack experience do you have? *',
          fieldType: 'number',
          options: [],
          isFilled: false,
        },
        {
          index: 1,
          labelText: 'How many years of AI experience do you have? *',
          fieldType: 'number',
          options: [],
          isFilled: false,
        },
        {
          index: 2,
          labelText: 'How many years of DevOps experience do you have? *',
          fieldType: 'number',
          options: [],
          isFilled: false,
        },
      ];

      const filledValues: Record<number, string> = {};
      const evaluateMock = vi.fn().mockImplementation(async (fn: any, ...args: any[]) => {
        if (typeof fn === 'function' && args.length === 0) {
          return mockFields;
        }
        if (args.length >= 3) {
          const [targetIdx, , val] = args;
          filledValues[targetIdx] = val;
        }
        return true;
      });

      const mockPuppeteerPage: any = {
        target: () => ({ tabId: 101 }),
        evaluate: evaluateMock,
      };

      const mockContext: any = {
        careerBrain: {
          yearsOfExperience: 2,
          skillExperience: {
            'MERN Stack': 2,
            AI: 1,
            DevOps: 0,
          },
        },
      };

      const mockJob: any = {
        jobId: 'test-exp-job',
        title: 'Full Stack Engineer',
        company: 'AI Corp',
        url: 'https://in.indeed.com/viewjob?jk=test-exp-job',
      };

      const filledCount = await indeedAdapter.scanAndFillCurrentStepFields(
        101,
        mockPuppeteerPage,
        mockContext,
        mockJob,
      );

      expect(filledCount).toBe(3);
      // Values must be reasonable years (0 <= y <= 99), NEVER multiplied by 100000!
      expect(filledValues[0]).toBe('2');
      expect(Number(filledValues[0])).toBeLessThanOrEqual(99);
      expect(filledValues[0]).not.toBe('100000');

      expect(filledValues[1]).toBe('1');
      expect(Number(filledValues[1])).toBeLessThanOrEqual(99);
      expect(filledValues[1]).not.toBe('100000');

      expect(filledValues[2]).toBe('0');
      expect(Number(filledValues[2])).toBeLessThanOrEqual(99);
      expect(filledValues[2]).not.toBe('100000');
    });

    it('auto-heals validation errors by scanning error containers and refilling inputs', async () => {
      let evalCall = 0;
      const mockPuppeteerPage: any = {
        target: () => ({ tabId: 101 }),
        evaluate: vi.fn().mockImplementation(async (fn: any) => {
          evalCall++;
          if (evalCall === 1) {
            // evaluateErrorDOM detects red validation errors
            return true;
          }
          if (evalCall === 2) {
            // evaluateScanDOM returns the missing field
            return [
              {
                index: 0,
                labelText: 'Notice Period',
                fieldType: 'text',
                options: [],
                isFilled: false,
              },
            ];
          }
          // evaluateFillDOM
          return true;
        }),
      };

      vi.spyOn(indeedAdapter.pacing, 'waitFieldInteraction').mockResolvedValue({ delayMs: 0, wasAborted: false });

      const mockContext: any = {
        careerBrain: { noticePeriod: '15 days' },
      };

      const mockJob: any = { jobId: 'job-1', title: 'Dev', company: 'Co', url: 'https://indeed.com' };

      const healed = await indeedAdapter.autoHealValidationErrors(101, mockPuppeteerPage, mockContext, mockJob);
      expect(healed).toBe(true);
    });

    it('handles resume selection step by ensuring candidate Indeed resume radio is selected', async () => {
      const mockPuppeteerPage: any = {
        target: () => ({ tabId: 101 }),
        evaluate: vi.fn().mockResolvedValue(true),
      };

      const result = await indeedAdapter.handleResumeStep(101, mockPuppeteerPage, {});
      expect(result).toBe(true);
    });
  });

  describe('Phase 7 - Candidate Name Protection & Salary Dropdown Intelligence', () => {
    it('isCandidateNameOrInvalidTitle correctly identifies candidate names and invalid titles', () => {
      // Candidate's name: Mubasshir Ali
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR ALI', 'Mubasshir Ali')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR', 'Mubasshir Ali')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Mubasshir', 'Mubasshir Ali')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Ali', 'Mubasshir Ali')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Software Professional', 'Mubasshir Ali')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Candidate', 'Mubasshir Ali')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('', 'Mubasshir Ali')).toBe(true);
      expect(isCandidateNameOrInvalidTitle(undefined, 'Mubasshir Ali')).toBe(true);

      // Real technical titles must NOT be flagged as names
      expect(isCandidateNameOrInvalidTitle('Full Stack Developer', 'Mubasshir Ali')).toBe(false);
      expect(isCandidateNameOrInvalidTitle('MERN Stack Developer', 'Mubasshir Ali')).toBe(false);
      expect(isCandidateNameOrInvalidTitle('Frontend Engineer', 'Mubasshir Ali')).toBe(false);
      expect(isCandidateNameOrInvalidTitle('Software Engineer', 'Mubasshir Ali')).toBe(false);
      expect(isCandidateNameOrInvalidTitle('Backend Developer', 'Mubasshir Ali')).toBe(false);
    });

    it('matchSalaryToOptions correctly matches salary ranges to dropdown options without picking placeholders', () => {
      const options = [
        'Select an option',
        '₹2,00,000 - ₹4,00,000 a year',
        '₹4,00,000 - ₹6,00,000 a year',
        '₹6,00,000 - ₹8,00,000 a year',
        '₹8,00,000 - ₹10,00,000 a year',
        '₹10,00,000+ a year',
      ];

      // 6-10 LPA / 6,00,000 - 10,00,000 should match 6-8L or 8-10L, NEVER "Select an option" or 2-4L
      const res1 = matchSalaryToOptions('6,00,000 - 10,00,000', options);
      expect(res1).not.toBe('Select an option');
      expect(res1).not.toBe('₹2,00,000 - ₹4,00,000 a year');
      expect(['₹6,00,000 - ₹8,00,000 a year', '₹8,00,000 - ₹10,00,000 a year']).toContain(res1);

      // 8 LPA
      const res2 = matchSalaryToOptions('8 LPA', options);
      expect(res2).toBe('₹8,00,000 - ₹10,00,000 a year');

      // 12 LPA
      const res3 = matchSalaryToOptions('1200000', options);
      expect(res3).toBe('₹10,00,000+ a year');

      // 300000
      const res4 = matchSalaryToOptions('300000', options);
      expect(res4).toBe('₹2,00,000 - ₹4,00,000 a year');
    });

    it('emits the actionable user-facing CAPTCHA message when verification is requested', async () => {
      indeedAdapter.captchaManualSolveTimeoutMs = 1000;
      indeedAdapter.captchaPollIntervalMs = 5;

      const liveActivitySpy = vi.fn();
      let pollCount = 0;
      vi.spyOn(indeedAdapter, 'checkCaptchaPresent').mockImplementation(async () => {
        pollCount++;
        return pollCount === 1; // first check true, second check false (solved)
      });

      const res = await indeedAdapter.waitForManualCaptchaResolution(
        101,
        { url: () => 'https://indeed.com/jobs' },
        { onLiveActivity: liveActivitySpy, runId: 'test-run' } as any,
        'Frontend Developer',
      );

      expect(res.solved).toBe(true);
      expect(liveActivitySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'needs_verification',
          reason:
            "Indeed needs you to verify you're human — click the runner tab and complete the check. We'll check automatically every few seconds.",
        }),
      );
    });

    it('resolveTargetRoleFromResumeWithLLM extracts both primary and alternate roles in a single call', async () => {
      const mockLLM = {
        invoke: vi.fn().mockResolvedValue({
          content: 'Primary: Full Stack Developer | Alternate: Software Engineer',
        }),
      };
      const testBrain = {
        fullName: 'Test Candidate',
        resumeText: 'Experience in React, Node.js, and TypeScript building web applications.',
        skills: ['React', 'Node.js', 'TypeScript'],
      };

      const primary = await resolveTargetRoleFromResumeWithLLM(testBrain as any, mockLLM as any);
      const alternate = getLastResolvedAlternateRole();

      expect(primary).toBe('Full Stack Developer');
      expect(alternate).toBe('Software Engineer');
      expect(mockLLM.invoke).toHaveBeenCalledTimes(1);
    });
  });
});
