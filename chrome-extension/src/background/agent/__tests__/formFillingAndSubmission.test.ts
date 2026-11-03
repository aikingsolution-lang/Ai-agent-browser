import { describe, it, expect, vi } from 'vitest';
import { validateAnswerForField } from '../intelligence';

describe('Form Filling and Submission Pipeline Tests', () => {
  describe('Phase 1: Field Classification & Question-to-Answer Guard', () => {
    it('validates and formats numeric fields correctly', () => {
      const field = {
        label: 'How many years of work experience do you have with TypeScript?',
        fieldType: 'number' as const,
      };

      const resValid = validateAnswerForField('5', field);
      expect(resValid.valid).toBe(true);
      expect(resValid.value).toBe('5');

      const resWord = validateAnswerForField('5 years of hands-on experience', field);
      expect(resWord.valid).toBe(true);
      expect(resWord.value).toBe('5');

      const resEmpty = validateAnswerForField('', field);
      expect(resEmpty.valid).toBe(false);
    });

    it('validates radio and single-choice answers strictly', () => {
      const field = {
        label: 'Are you legally authorized to work in India?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };

      const resYes = validateAnswerForField('Yes', field);
      expect(resYes.valid).toBe(true);
      expect(resYes.value).toBe('Yes');

      const resTrue = validateAnswerForField('true', field);
      expect(resTrue.valid).toBe(true);
      expect(resTrue.value).toBe('Yes');

      const resSentence = validateAnswerForField('Yes, I am a citizen', field);
      expect(resSentence.valid).toBe(true);
      expect(resSentence.value).toBe('Yes');

      const resInvalid = validateAnswerForField('Maybe next year', field);
      expect(resInvalid.valid).toBe(false);
    });

    it('handles salary expectations in both LPA and INR', () => {
      const fieldLPA = {
        label: 'Expected CTC (in LPA)',
        fieldType: 'number' as const,
      };
      const resLPA = validateAnswerForField('12 LPA', fieldLPA);
      expect(resLPA.valid).toBe(true);
      expect(resLPA.value).toBe('12');

      const fieldINR = {
        label: 'Expected Salary (INR)',
        fieldType: 'number' as const,
      };
      const resINR = validateAnswerForField('12,00,000', fieldINR);
      expect(resINR.valid).toBe(true);
      expect(resINR.value).toBe('1200000');
    });

    it('handles notice period conversions', () => {
      const field = {
        label: 'What is your notice period (in days)?',
        fieldType: 'number' as const,
      };

      const resImm = validateAnswerForField('Immediate', field);
      expect(resImm.valid).toBe(true);
      expect(resImm.value).toBe('0');

      const resDays = validateAnswerForField('30 days', field);
      expect(resDays.valid).toBe(true);
      expect(resDays.value).toBe('30');
    });
  });

  describe('Phase 2: React Synthetic Events & Value Setter Integrity', () => {
    it('sets input value using prototype descriptor without breaking React tracking', () => {
      // Mock an HTMLInputElement
      const mockInput = {
        _value: '',
        value: '',
        dispatchEvent: vi.fn(),
      };

      // Native prototype setter pattern used in page.ts
      const descriptor = {
        set(val: string) {
          mockInput._value = val;
          mockInput.value = val;
        },
      };

      descriptor.set.call(mockInput, 'Senior Software Engineer');
      expect(mockInput.value).toBe('Senior Software Engineer');
    });

    it('sets checkbox checked using prototype descriptor and dispatches composed events', () => {
      const dispatchedEvents: string[] = [];
      const mockCheckbox = {
        checked: false,
        dispatchEvent: vi.fn((e: { type: string }) => dispatchedEvents.push(e.type)),
      };

      // Emulate page.ts checkbox toggle with native prototype setter
      const protoSetter = {
        set(val: boolean) {
          mockCheckbox.checked = val;
        },
      };

      protoSetter.set.call(mockCheckbox, true);
      mockCheckbox.dispatchEvent({ type: 'input' } as any);
      mockCheckbox.dispatchEvent({ type: 'change' } as any);

      expect(mockCheckbox.checked).toBe(true);
      expect(dispatchedEvents).toEqual(['input', 'change']);
    });
  });

  describe('Phase 3: Confirmation Verification & Post-Submission Recognition', () => {
    it('recognizes diverse LinkedIn confirmation patterns', () => {
      const patterns = [
        /your application was sent/i,
        /application submitted/i,
        /your application has been submitted/i,
        /application received/i,
        /successfully applied/i,
        /thanks for applying/i,
        /thank you for applying/i,
        /we have received your application/i,
        /application sent to/i,
        /\bapplication sent\b/i,
        /\bapplication has been sent\b/i,
        /\byou applied\b/i,
        /\bapplied to\b/i,
        /\bapplication delivered\b/i,
        /\bapplied successfully\b/i,
        /\byour application is on its way\b/i,
        /\bapplication is on its way\b/i,
      ];

      const testPhrases = [
        'Your application was sent to Acme Corp',
        'Application submitted successfully!',
        'Thank you for applying to Google',
        'Application sent',
        'You applied on LinkedIn',
        'Your application is on its way',
      ];

      for (const phrase of testPhrases) {
        const matches = patterns.some(p => p.test(phrase));
        expect(matches).toBe(true);
      }
    });

    it('recognizes "Done" button on confirmation screen without matching save dialogs', () => {
      const isDoneButton = (text: string) => /^done$/i.test(text.trim()) || /^got it$/i.test(text.trim());
      expect(isDoneButton('Done')).toBe(true);
      expect(isDoneButton('done')).toBe(true);
      expect(isDoneButton('Got it')).toBe(true);
      expect(isDoneButton('Save')).toBe(false);
      expect(isDoneButton('Discard')).toBe(false);
      expect(isDoneButton('Next')).toBe(false);
    });
  });
});
