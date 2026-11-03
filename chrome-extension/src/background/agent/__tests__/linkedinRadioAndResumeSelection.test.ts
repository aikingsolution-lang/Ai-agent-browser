import { describe, it, expect } from 'vitest';
import { adaptAnswerToFieldFormat, generateAutonomousFallbackAnswerWithSource } from '../linkedin/formQuestionResolver';
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
});
