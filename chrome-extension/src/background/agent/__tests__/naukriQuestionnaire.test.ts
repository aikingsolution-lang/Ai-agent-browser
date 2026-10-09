import { describe, it, expect } from 'vitest';
import type { ICareerBrain } from '@extension/storage';
import { resolveNaukriQuestion } from '../platforms/naukri/naukriResolver';
import { NAUKRI_SELECTORS } from '../platforms/naukri/selectors';

describe('Naukri Questionnaire & Drawer Resolvers', () => {
  const baseCareerBrain: Partial<ICareerBrain> = {
    fullName: 'Mubasshir Ali',
    email: 'mubasshir@example.com',
    phoneNumber: '+91 9876543210',
    currentTitle: 'Full Stack Developer',
    currentCTC: '700000',
    expectedCTC: '1200000',
    noticePeriod: '15 Days',
    yearsOfExperience: 3,
    currentLocation: 'Bengaluru, Karnataka, India',
    preferredLocations: ['Bengaluru, Karnataka, India', 'Remote'],
  };

  describe('Current CTC in Lacs per annum', () => {
    it('converts full CTC amount (700000) to Lakhs (7) when question asks in Lacs per annum', () => {
      const res = resolveNaukriQuestion(
        'What is your current CTC in Lacs per annum?',
        'text',
        [],
        baseCareerBrain as ICareerBrain,
        'For example: 7 lakhs',
      );
      expect(res.value).toBe('7');
      expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('converts decimal CTC amounts (750000 -> 7.5, 120000 -> 1.2)', () => {
      const brainWithDec: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        currentCTC: '750000',
      };
      const res1 = resolveNaukriQuestion(
        'What is your current CTC in Lacs per annum?',
        'text',
        [],
        brainWithDec,
        'For example: 7 lakhs',
      );
      expect(res1.value).toBe('7.5');

      const brainWithLow: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        currentCTC: '120000',
      };
      const res2 = resolveNaukriQuestion(
        'What is your current CTC in Lacs per annum?',
        'text',
        [],
        brainWithLow,
        'For example: 7 lakhs',
      );
      expect(res2.value).toBe('1.2');
    });

    it('handles CTC already formatted in Lakhs (e.g. "8 LPA" or "8")', () => {
      const brainAlreadyLakhs: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        currentCTC: '8 LPA',
      };
      const res = resolveNaukriQuestion(
        'What is your current CTC in Lacs per annum?',
        'text',
        [],
        brainAlreadyLakhs,
        'For example: 7 lakhs',
      );
      expect(res.value).toBe('8');
    });

    it('returns empty string with low confidence when CTC is missing so caller can click "Skip this question"', () => {
      const brainNoCtc: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        currentCTC: '',
        salaryExpectation: '',
      };
      const res = resolveNaukriQuestion(
        'What is your current CTC in Lacs per annum?',
        'text',
        [],
        brainNoCtc,
        'For example: 7 lakhs',
      );
      expect(res.value).toBe('');
      expect(res.confidence).toBeLessThan(0.5);
    });
  });

  describe('Expected CTC in Lacs per annum', () => {
    it('converts expected CTC amount (1200000) to Lakhs (12)', () => {
      const res = resolveNaukriQuestion(
        'What is your expected CTC in Lacs per annum?',
        'text',
        [],
        baseCareerBrain as ICareerBrain,
        'For example: 10 lakhs',
      );
      expect(res.value).toBe('12');
      expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('Notice Period resolution', () => {
    it('resolves notice period in days when field asks for days', () => {
      const res1 = resolveNaukriQuestion('Notice period (in days)', 'number', [], baseCareerBrain as ICareerBrain);
      expect(res1.value).toBe('15');

      const brainImmediate: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        noticePeriod: 'Immediate',
      };
      const res2 = resolveNaukriQuestion('Notice period in days', 'number', [], brainImmediate);
      expect(res2.value).toBe('0');
    });
  });

  describe('Naukri Selectors for Drawer and Skip Button', () => {
    it('includes drawer-wrapper and modern drawer selectors in MODAL_CONTAINER', () => {
      expect(NAUKRI_SELECTORS.MODAL_CONTAINER).toContain('div.drawer-wrapper');
      expect(NAUKRI_SELECTORS.MODAL_CONTAINER.some(s => s.includes('drawer'))).toBe(true);
    });

    it('includes skip question buttons in SKIP_QUESTION_BUTTON', () => {
      expect(NAUKRI_SELECTORS.SKIP_QUESTION_BUTTON.length).toBeGreaterThan(0);
      expect(NAUKRI_SELECTORS.SKIP_QUESTION_BUTTON.some(s => s.includes('skip'))).toBe(true);
    });
  });
});
