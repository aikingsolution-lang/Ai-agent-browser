import { describe, it, expect } from 'vitest';
import {
  adaptAnswerToFieldFormat,
  generateAutonomousFallbackAnswerWithSource,
  matchRuleBased,
} from '../linkedin/formQuestionResolver';
import { validateAnswerForField } from '../intelligence';
import { DEFAULT_CAREER_BRAIN, type ICareerBrain } from '@extension/storage';

describe('LinkedIn Easy Apply - Radio Button Answering & Screening Fallbacks', () => {
  const dummyCareerBrain: ICareerBrain = {
    ...DEFAULT_CAREER_BRAIN,
    fullName: 'Mubasshir Ali',
    email: 'mubasshir@example.com',
    currentLocation: 'Bengaluru, India',
    yearsOfExperience: 3,
    willingToRelocate: 'Yes',
  };

  describe('adaptAnswerToFieldFormat for Radio Fields', () => {
    it('normalizes sentence and punctuated Yes answers to the exact Yes option', () => {
      const field = {
        label: "Are you comfortable commuting to this job's location?",
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };

      expect(adaptAnswerToFieldFormat('Yes', field)).toEqual({ valid: true, value: 'Yes', wasConverted: false });
      expect(adaptAnswerToFieldFormat('Yes.', field)).toEqual({ valid: true, value: 'Yes', wasConverted: true });
      expect(adaptAnswerToFieldFormat('Yes, I am comfortable with daily commute', field)).toEqual({
        valid: true,
        value: 'Yes',
        wasConverted: true,
      });
      expect(adaptAnswerToFieldFormat('true', field)).toEqual({ valid: true, value: 'Yes', wasConverted: true });
      expect(adaptAnswerToFieldFormat('authorized', field)).toEqual({ valid: true, value: 'Yes', wasConverted: true });
    });

    it('normalizes sentence and punctuated No answers to the exact No option', () => {
      const field = {
        label: 'Will you require visa sponsorship?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };

      expect(adaptAnswerToFieldFormat('No', field)).toEqual({ valid: true, value: 'No', wasConverted: false });
      expect(adaptAnswerToFieldFormat('No.', field)).toEqual({ valid: true, value: 'No', wasConverted: true });
      expect(adaptAnswerToFieldFormat('No, I do not require sponsorship', field)).toEqual({
        valid: true,
        value: 'No',
        wasConverted: true,
      });
      expect(adaptAnswerToFieldFormat('false', field)).toEqual({ valid: true, value: 'No', wasConverted: true });
    });

    it('maps Yes/No intent to phrase-based options', () => {
      const field = {
        label: 'Work Authorization',
        fieldType: 'radio' as const,
        options: ['Yes, I am legally authorized to work in India', 'No, I am not authorized'],
      };

      const yesRes = adaptAnswerToFieldFormat('Yes', field);
      expect(yesRes.valid).toBe(true);
      expect(yesRes.value).toBe('Yes, I am legally authorized to work in India');

      const noRes = adaptAnswerToFieldFormat('No', field);
      expect(noRes.valid).toBe(true);
      expect(noRes.value).toBe('No, I am not authorized');
    });
  });

  describe('generateAutonomousFallbackAnswerWithSource for Screening Questions', () => {
    it('answers qualifying screening questions affirmatively (Yes) to prevent skips', () => {
      const commuteField = {
        label: "Are you comfortable commuting to this job's location?",
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };
      const commuteRes = generateAutonomousFallbackAnswerWithSource(commuteField, dummyCareerBrain);
      expect(commuteRes.answer).toBe('Yes');

      const relocationField = {
        label: 'Are you willing to relocate to Bengaluru for this position?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };
      const relocationRes = generateAutonomousFallbackAnswerWithSource(relocationField, dummyCareerBrain);
      expect(relocationRes.answer).toBe('Yes');

      const hybridField = {
        label: 'Are you comfortable working in a hybrid 3-days-in-office model?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };
      const hybridRes = generateAutonomousFallbackAnswerWithSource(hybridField, dummyCareerBrain);
      expect(hybridRes.answer).toBe('Yes');
    });

    it('answers disqualifying / negative screening questions with No', () => {
      const criminalField = {
        label: 'Have you ever been convicted of a criminal felony?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };
      const criminalRes = generateAutonomousFallbackAnswerWithSource(criminalField, dummyCareerBrain);
      expect(criminalRes.answer).toBe('No');

      const sponsorshipField = {
        label: 'Will you now or in the future require employment visa sponsorship?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };
      const sponsorshipRes = generateAutonomousFallbackAnswerWithSource(sponsorshipField, dummyCareerBrain);
      expect(sponsorshipRes.answer).toBe('No');
    });
  });

  describe('Financial Expectations & Salary Answering Stability', () => {
    const salaryProfile: ICareerBrain = {
      ...dummyCareerBrain,
      expectedCTC: '12 LPA',
      salaryExpectation: '1200000',
      currentCTC: '10 LPA',
    };

    it('matches "What are your financial expectations (monthly gross)?" on Attempt 1 and calculates monthly amount', () => {
      const field = {
        label: 'What are your financial expectations (monthly gross)?',
        fieldType: 'text' as const,
      };

      const match = matchRuleBased(field, salaryProfile);
      expect(match.matched).toBe(true);
      // 12 LPA = 1,200,000 INR per year -> 100,000 INR per month
      expect(match.answer).toBe('100000');
    });

    it('matches "What are your salary expectations?" on Attempt 1', () => {
      const field = {
        label: 'What are your salary expectations?',
        fieldType: 'text' as const,
      };

      const match = matchRuleBased(field, salaryProfile);
      expect(match.matched).toBe(true);
      expect(match.answer).toBe('1200000');
    });

    it('matches "Financial expectations" without failing or needing AI', () => {
      const field = {
        label: 'Financial expectations',
        fieldType: 'text' as const,
      };

      const match = matchRuleBased(field, salaryProfile);
      expect(match.matched).toBe(true);
      expect(match.answer).toBe('1200000');
    });

    it('never generates "Not applicable" for financial expectation fields in autonomous fallback', () => {
      const field = {
        label: 'What are your financial expectations (monthly gross)?',
        fieldType: 'text' as const,
      };

      // Even on attempt 2 or 3, fallback must return numeric amount, NEVER "Not applicable"
      const fallback = generateAutonomousFallbackAnswerWithSource(field, salaryProfile, undefined, 2);
      expect(fallback.answer).not.toBe('Not applicable');
      expect(fallback.answer).toBe('100000');
    });

    it('rejects "Not applicable" in validateAnswerForField for financial expectations', () => {
      const field = {
        label: 'What are your financial expectations (monthly gross)?',
        fieldType: 'text' as const,
      };

      const guardResult = validateAnswerForField('Not applicable', field);
      expect(guardResult.valid).toBe(false);
      expect(guardResult.reason).toContain('Non-numeric answer');
    });

    it('accepts and converts monthly gross in validateAnswerForField', () => {
      const field = {
        label: 'What are your financial expectations (monthly gross)?',
        fieldType: 'text' as const,
      };

      const guardResult = validateAnswerForField('12 LPA', field);
      expect(guardResult.valid).toBe(true);
      expect(guardResult.value).toBe('100000');
    });
  });
});
