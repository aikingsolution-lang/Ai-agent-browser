import { describe, it, expect } from 'vitest';
import {
  inspectLinkedInSplitPane,
  inspectLinkedInEasyApplyFailure,
  summarizeLinkedInCardScan,
} from '../../browser/linkedinDiagnostics';

describe('LinkedIn Easy Apply & Split-Pane Diagnostic Tests', () => {
  describe('inspectLinkedInSplitPane - Resilient DOM extraction', () => {
    it('does not throw when details pane is completely missing from document', () => {
      // Simulate an empty document with no details container
      const mockDoc = {
        querySelector: () => null,
      } as unknown as Document;

      const mockWin = {
        location: { pathname: '/jobs/search', search: '?keywords=developer' },
        innerWidth: 1200,
      } as unknown as Window;

      expect(() => {
        const diag = inspectLinkedInSplitPane('123456', mockDoc, mockWin);
        expect(diag).toBeDefined();
        expect(diag.urlPath).toBe('/jobs/search');
        expect(diag.viewportWidth).toBe(1200);
        expect(diag.detailsMatchesJobId).toBe(false);
        expect(diag.detailsJobIdFound).toBeNull();
        expect(diag.currentJobIdInUrl).toBeNull();
      }).not.toThrow();
    });

    it('does not throw when doc and win are null or undefined', () => {
      expect(() => {
        const diag = inspectLinkedInSplitPane('999999', null, null);
        expect(diag).toBeDefined();
        expect(diag.detailsMatchesJobId).toBe(false);
        expect(diag.viewportWidth).toBe(0);
      }).not.toThrow();
    });

    it('identifies when details pane matches target jobId via data-job-id or child link', () => {
      const mockContainer = {
        getAttribute: (attr: string) => (attr === 'data-job-id' ? '123456' : null),
        querySelector: (sel: string) => {
          if (sel.includes('123456')) return { tagName: 'A' };
          return null;
        },
      };

      const mockDoc = {
        querySelector: (sel: string) => (sel.includes('job-details') ? mockContainer : null),
      } as unknown as Document;

      const mockWin = {
        location: { pathname: '/jobs/search', search: '?currentJobId=123456' },
        innerWidth: 1440,
      } as unknown as Window;

      const diag = inspectLinkedInSplitPane('123456', mockDoc, mockWin);
      expect(diag.detailsMatchesJobId).toBe(true);
      expect(diag.detailsJobIdFound).toBe('123456');
      expect(diag.currentJobIdInUrl).toBe('123456');
      expect(diag.viewportWidth).toBe(1440);
    });

    it('identifies mismatched jobId when details pane shows a different job', () => {
      const mockJobEl = {
        getAttribute: (attr: string) => (attr === 'data-job-id' ? '888888' : null),
      };

      const mockContainer = {
        getAttribute: () => null,
        querySelector: (sel: string) => {
          if (sel.includes('123456')) return null; // Target not found
          if (sel.includes('[data-job-id]')) return mockJobEl;
          return null;
        },
      };

      const mockDoc = {
        querySelector: () => mockContainer,
      } as unknown as Document;

      const mockWin = {
        location: { pathname: '/jobs/search', search: '?currentJobId=888888' },
        innerWidth: 1024,
      } as unknown as Window;

      const diag = inspectLinkedInSplitPane('123456', mockDoc, mockWin);
      expect(diag.detailsMatchesJobId).toBe(false);
      expect(diag.detailsJobIdFound).toBe('888888');
      expect(diag.currentJobIdInUrl).toBe('888888');
    });
  });

  describe('inspectLinkedInEasyApplyFailure - Resilient diagnostics', () => {
    it('does not throw when details pane container is null or missing', () => {
      expect(() => {
        const diag = inspectLinkedInEasyApplyFailure(null);
        expect(diag).toBeDefined();
        expect(diag.headingText).toBe('<details pane missing>');
        expect(diag.isPaneLoading).toBe(false);
        expect(diag.hasSpinner).toBe(false);
        expect(diag.isEmptyHeading).toBe(true);
        expect(diag.buttonsAndLinks).toEqual([]);
        expect(diag.selectorSummary).toBe('details pane missing');
        expect(diag.selectorResults['button.jobs-apply-button']).toBe(false);
      }).not.toThrow();
    });

    it('does not throw when details pane has broken or empty DOM elements', () => {
      const mockContainer = {
        querySelector: () => null,
        querySelectorAll: () => [],
      } as unknown as Element;

      expect(() => {
        const diag = inspectLinkedInEasyApplyFailure(mockContainer);
        expect(diag.headingText).toBe('<empty>');
        expect(diag.isEmptyHeading).toBe(true);
        expect(diag.isPaneLoading).toBe(true); // empty heading marks as still loading
        expect(diag.buttonsAndLinks).toEqual([]);
        expect(diag.selectorSummary).toBe('all Easy Apply selectors failed');
      }).not.toThrow();
    });

    it('collects up to 15 buttons/links (truncated to 40 chars) and detects loading spinners', () => {
      const mockHeading = { textContent: 'Senior Software Engineer' };
      const mockSpinner = { tagName: 'DIV', className: 'artdeco-loader' };

      // Create 20 mock buttons/links
      const mockButtons = Array.from({ length: 20 }, (_, i) => ({
        tagName: i % 2 === 0 ? 'BUTTON' : 'A',
        textContent: `Button Action Number ${i + 1} with a very long text string that exceeds forty chars`,
        getAttribute: (attr: string) => (attr === 'aria-label' ? `aria-${i + 1}` : null),
        closest: () => null,
      }));

      const mockContainer = {
        querySelector: (sel: string) => {
          if (sel.includes('h1') || sel.includes('h2')) return mockHeading;
          if (sel.includes('artdeco-loader')) return mockSpinner;
          return null;
        },
        querySelectorAll: (sel: string) => {
          if (sel.includes('button')) return mockButtons;
          return [];
        },
      } as unknown as Element;

      const diag = inspectLinkedInEasyApplyFailure(mockContainer);
      expect(diag.headingText).toBe('Senior Software Engineer');
      expect(diag.isEmptyHeading).toBe(false);
      expect(diag.hasSpinner).toBe(true);
      expect(diag.isPaneLoading).toBe(true); // Spinner present
      // Max 15 items
      expect(diag.buttonsAndLinks.length).toBe(15);
      // Truncated to <= 40 chars (+ tag prefix)
      for (const item of diag.buttonsAndLinks) {
        expect(item.length).toBeLessThanOrEqual(55); // <button> (9 chars) + 40 chars max
      }
      expect(diag.selectorResults['btn_text_easy_apply']).toBe(false);
    });

    it('detects when an Easy Apply button or svg icon is present', () => {
      const mockHeading = { textContent: 'Lead Frontend Developer' };
      const mockEasyApplyBtn = {
        tagName: 'BUTTON',
        textContent: 'Easy Apply',
        getAttribute: () => null,
        closest: () => null,
      };

      const mockContainer = {
        querySelector: (sel: string) => {
          if (sel.includes('h1')) return mockHeading;
          if (sel.includes('button.jobs-apply-button')) return mockEasyApplyBtn;
          return null;
        },
        querySelectorAll: () => [mockEasyApplyBtn],
      } as unknown as Element;

      const diag = inspectLinkedInEasyApplyFailure(mockContainer);
      expect(diag.selectorResults['button.jobs-apply-button']).toBe(true);
      expect(diag.selectorResults['btn_text_easy_apply']).toBe(true);
      expect(diag.selectorSummary).toContain('button.jobs-apply-button');
      expect(diag.selectorSummary).toContain('btn_text_easy_apply');
    });
  });

  describe('summarizeLinkedInCardScan - Card counting and diagnostic summary', () => {
    it('summarizes cards count, valid titles/companies, and first 3 cards', () => {
      const sampleCards = [
        { jobId: '101', title: 'React Developer', company: 'Google', url: 'https://linkedin.com/jobs/view/101' },
        {
          jobId: '102',
          title: 'Luxoft India',
          company: 'Actively reviewing applicants',
          url: 'https://linkedin.com/jobs/view/102',
        },
        { jobId: '103', title: '', company: 'Meta', url: 'https://linkedin.com/jobs/view/103' },
        { jobId: '104', title: 'Backend Lead', company: 'Amazon', url: 'https://linkedin.com/jobs/view/104' },
      ];

      const summary = summarizeLinkedInCardScan(sampleCards);
      expect(summary.total).toBe(4);
      expect(summary.validCount).toBe(3); // 101, 102, 104 are non-empty title & company; 103 has empty title
      expect(summary.first3Summary).toContain('#1 "React Developer" @ "Google"');
      expect(summary.first3Summary).toContain('#2 "Luxoft India" @ "Actively reviewing applicants"');
      expect(summary.first3Summary).toContain('#3 "<empty>" @ "Meta"');
      expect(summary.consoleLog).toContain('[LinkedInCardScanDiag]');
      expect(summary.liveActivityLine).toContain('[Diag] Cards: 4 total, 3 valid');
    });

    it('handles empty cards array gracefully without throwing', () => {
      const summary = summarizeLinkedInCardScan([]);
      expect(summary.total).toBe(0);
      expect(summary.validCount).toBe(0);
      expect(summary.first3Summary).toBe('<none>');
      expect(summary.consoleLog).toBe(
        '[LinkedInCardScanDiag] Cards found: 0 | Non-empty title & company: 0/0 | First 3: [<none>]',
      );
      expect(summary.liveActivityLine).toBe('[Diag] Cards: 0 total, 0 valid | Top: <none>');
    });
  });
});
