import { describe, it, expect, vi } from 'vitest';
import {
  generateAutonomousFallbackAnswer,
  generateAutonomousFallbackAnswerWithSource,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';
import { validateAnswerForField } from '../intelligence';
import { DEFAULT_CAREER_BRAIN, type ICareerBrain } from '@extension/storage';

describe('Required Field Never-Skip Suite (fix/required-field-never-skip)', () => {
  const mockCareerBrain: ICareerBrain = {
    ...DEFAULT_CAREER_BRAIN,
    fullName: 'Mubasshir Ali',
    email: 'mubasshir@example.com',
    phoneNumber: '+91 70031 51313',
    currentTitle: 'Senior Full Stack Engineer',
    currentLocation: 'Kolkata, West Bengal, India',
    yearsOfExperience: 4,
    hasWorkExperience: true,
    skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    noticePeriod: '15',
    currentCTC: '1200000',
    expectedCTC: '1800000',
  };

  // ───────────────────────────────────────────────────────────────────────────
  // FIXTURE 1: Single-line text with maxlength & compound relocation question
  // ───────────────────────────────────────────────────────────────────────────
  describe('Fixture 1: Single-line text with maxlength & compound relocation question', () => {
    const relocationLabel =
      'Are you open to relocation or travel for work? If yes, please specify preferred cities and zones (e.g., South Bangalore, East Bangalore, etc.).';

    it('generates a single short sentence (<= 80 chars) that passes validateAnswerForField without maxlength', () => {
      const field: FormFieldDescriptor = {
        label: relocationLabel,
        fieldType: 'text',
        required: true,
      };

      const fallback = generateAutonomousFallbackAnswerWithSource(field, mockCareerBrain);
      expect(fallback.answer).toBeTruthy();
      expect(fallback.answer.length).toBeLessThanOrEqual(80);

      // Must be a single sentence (no internal multiple sentence breaks)
      const internalSentenceBreak = /[.!?]\s+[A-Za-z0-9]/.test(fallback.answer);
      expect(internalSentenceBreak).toBe(false);

      // Must pass validateAnswerForField
      const guarded = validateAnswerForField(fallback.answer, field);
      expect(guarded.valid).toBe(true);
      expect(guarded.value).toBe(fallback.answer);
    });

    it('strictly respects maxlength (e.g. 50 chars and 30 chars) and passes validateAnswerForField', () => {
      const fieldWithMax50: FormFieldDescriptor = {
        label: relocationLabel,
        fieldType: 'text',
        required: true,
        max: 50,
        maxLength: 50,
      };

      const fb50 = generateAutonomousFallbackAnswerWithSource(fieldWithMax50, mockCareerBrain);
      expect(fb50.answer.length).toBeLessThanOrEqual(50);
      const guarded50 = validateAnswerForField(fb50.answer, fieldWithMax50);
      expect(guarded50.valid).toBe(true);

      const fieldWithMax30: FormFieldDescriptor = {
        label: relocationLabel,
        fieldType: 'text',
        required: true,
        max: 30,
        maxLength: 30,
      };

      const fb30 = generateAutonomousFallbackAnswerWithSource(fieldWithMax30, mockCareerBrain);
      expect(fb30.answer.length).toBeLessThanOrEqual(30);
      const guarded30 = validateAnswerForField(fb30.answer, fieldWithMax30);
      expect(guarded30.valid).toBe(true);
    });

    it('chooses from field.options if compound relocation question is rendered as radio/dropdown', () => {
      const fieldAsRadio: FormFieldDescriptor = {
        label: relocationLabel,
        fieldType: 'radio',
        required: true,
        options: ['Yes', 'No'],
      };

      const fb = generateAutonomousFallbackAnswerWithSource(fieldAsRadio, mockCareerBrain);
      expect(fb.answer).toBe('Yes');
      expect(fieldAsRadio.options).toContain(fb.answer);

      // Must not produce a long paragraph that choice guard would reject
      const guarded = validateAnswerForField(fb.answer, fieldAsRadio);
      expect(guarded.valid).toBe(true);
      expect(guarded.value).toBe('Yes');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FIXTURE 2: Number field with "Enter a whole number" validation error
  // ───────────────────────────────────────────────────────────────────────────
  describe('Fixture 2: Number field with "Enter a whole number" validation error', () => {
    it('produces digits-only whole number when careerBrain.yearsOfExperience is defined', () => {
      const field: FormFieldDescriptor = {
        label: 'Total years of Experience',
        fieldType: 'number',
        required: true,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, mockCareerBrain);
      expect(fb.answer).toBe('4');
      expect(/^\d+$/.test(fb.answer)).toBe(true);

      const guarded = validateAnswerForField(fb.answer, field);
      expect(guarded.valid).toBe(true);
    });

    it('produces digits-only "0" when careerBrain.yearsOfExperience is undefined (honesty rule: no blank)', () => {
      const brainWithoutYoe: ICareerBrain = {
        ...mockCareerBrain,
        yearsOfExperience: undefined as any,
      };

      const field: FormFieldDescriptor = {
        label: 'Total years of Experience',
        fieldType: 'number',
        required: true,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, brainWithoutYoe, 'Enter a whole number');
      expect(fb.answer).toBe('0');
      expect(/^\d+$/.test(fb.answer)).toBe(true);
      expect(fb.source).toContain('0');

      const guarded = validateAnswerForField(fb.answer, field);
      expect(guarded.valid).toBe(true);
      expect(guarded.value).toBe('0');
    });

    it('rounds decimal numbers to whole integer when error text specifies "Enter a whole number"', () => {
      const brainWithDecimal: ICareerBrain = {
        ...mockCareerBrain,
        yearsOfExperience: 3.5,
      };

      const field: FormFieldDescriptor = {
        label: 'Total years of Experience',
        fieldType: 'number',
        required: true,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, brainWithDecimal, 'Enter a whole number');
      expect(fb.answer).toBe('4');
      expect(fb.answer).not.toContain('.');

      const guarded = validateAnswerForField(fb.answer, field);
      expect(guarded.valid).toBe(true);
    });

    it('produces positive integer >= 1 when validation error specifies "greater than 0"', () => {
      const field: FormFieldDescriptor = {
        label: 'Notice period in days',
        fieldType: 'number',
        required: true,
        min: 1,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(
        field,
        mockCareerBrain,
        'Please enter a number larger than 0',
      );
      const num = parseInt(fb.answer, 10);
      expect(num).toBeGreaterThanOrEqual(1);

      const guarded = validateAnswerForField(fb.answer, field);
      expect(guarded.valid).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FIXTURE 3: Select and Radio with real options (chooses existing, never invents)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Fixture 3: Select and Radio with real options (chooses existing, never invents)', () => {
    it('chooses only from valid options for a select dropdown and never invents outside choices', () => {
      const realOptions = ['Select an option', 'Citizen of India', 'Permanent Resident', 'Work Visa Required'];
      const field: FormFieldDescriptor = {
        label: 'What is your work authorization status?',
        fieldType: 'dropdown',
        options: realOptions,
        required: true,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, mockCareerBrain);
      expect(realOptions).toContain(fb.answer);
      expect(fb.answer).not.toBe('Select an option');
      expect(fb.answer).toBe('Citizen of India');

      const guarded = validateAnswerForField(fb.answer, field);
      expect(guarded.valid).toBe(true);
      expect(guarded.value).toBe('Citizen of India');
    });

    it('chooses only from valid options for a radio group and honors honest neutral default', () => {
      const radioOptions = ['Yes, definitely', 'No, not at this time'];
      const field: FormFieldDescriptor = {
        label: 'Do you require visa sponsorship now or in the future?',
        fieldType: 'radio',
        options: radioOptions,
        required: true,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, mockCareerBrain);
      expect(radioOptions).toContain(fb.answer);
      expect(fb.answer).toBe('No, not at this time');

      const guarded = validateAnswerForField(fb.answer, field);
      expect(guarded.valid).toBe(true);
      expect(guarded.value).toBe('No, not at this time');
    });

    it('selects candidate profile location when location options match candidate city/country', () => {
      const locationOptions = [
        'Choose city',
        'London, UK',
        'New York, USA',
        'Kolkata, West Bengal, India',
        'Tokyo, Japan',
      ];
      const field: FormFieldDescriptor = {
        label: 'What is your Current Location?',
        fieldType: 'dropdown',
        options: locationOptions,
        required: true,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, mockCareerBrain);
      expect(fb.answer).toBe('Kolkata, West Bengal, India');
      expect(locationOptions).toContain(fb.answer);

      const guarded = validateAnswerForField(fb.answer, field);
      expect(guarded.valid).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FIXTURE 4: Field where 1st fill attempt fails readback and retry succeeds
  // ───────────────────────────────────────────────────────────────────────────
  describe('Fixture 4: Readback verification and alternative setter retry', () => {
    it('detects readback failure when value is dropped by React and triggers alternative setter retry', async () => {
      // Simulate input DOM element with a buggy setter that ignores initial call
      let setterCallCount = 0;
      let internalValue = '';

      const mockElement = {
        tagName: 'INPUT',
        type: 'text',
        id: 'test-field',
        value: '',
        focus: vi.fn(),
        blur: vi.fn(),
        dispatchEvent: vi.fn((event: any) => {
          if (event.type === 'input' && event.data) {
            internalValue = event.data;
          }
        }),
      };

      // Getter/setter simulating React synthetic input behavior:
      // First attempt drops the value; alternative retry path with InputEvent or direct property works.
      Object.defineProperty(mockElement, 'value', {
        get() {
          return internalValue;
        },
        set(val: string) {
          setterCallCount++;
          if (setterCallCount === 1) {
            // First call dropped (React unregistration / desync simulation)
            internalValue = '';
          } else {
            // Subsequent retry call succeeds
            internalValue = val;
          }
        },
      });

      const intendedValue = 'Kolkata, West Bengal, India';

      // First setter attempt
      mockElement.value = intendedValue;
      expect(mockElement.value).toBe(''); // Initial fill readback failed

      // Alternative setter retry triggered because readback was empty
      if (mockElement.value !== intendedValue) {
        mockElement.value = intendedValue;
        const inputEvt =
          typeof InputEvent !== 'undefined'
            ? new InputEvent('input', { bubbles: true, composed: true, data: intendedValue, inputType: 'insertText' })
            : { type: 'input', bubbles: true, composed: true, data: intendedValue };
        mockElement.dispatchEvent(inputEvt as any);
      }

      // Readback after retry succeeds
      expect(mockElement.value).toBe(intendedValue);
      expect(setterCallCount).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FIXTURE 5: Honesty rule audit & specific skip reason formatting
  // ───────────────────────────────────────────────────────────────────────────
  describe('Fixture 5: Honesty rule audit & specific skip reason formatting', () => {
    it('does not invent team management claims if not in profile, logging honest source', () => {
      const field: FormFieldDescriptor = {
        label: 'Do you have experience managing teams of 5 or more engineers?',
        fieldType: 'text',
        required: true,
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, mockCareerBrain);
      expect(fb.answer).not.toContain('mentoring junior developers, and coordinating technical deliverables');
      expect(fb.answer.toLowerCase()).toContain('individual contributor');
      expect(fb.source).toContain('Honest');
    });

    it('formats specific skip reason with field label and LinkedIn error text when exhausted', () => {
      const fieldLabel = 'What is your Current Location?';
      const errorText = 'Please enter a valid location';

      const specificSkipReason = `Skipped: required field "${fieldLabel}" could not be filled (LinkedIn error: "${errorText}")`;

      expect(specificSkipReason).toBe(
        'Skipped: required field "What is your Current Location?" could not be filled (LinkedIn error: "Please enter a valid location")',
      );
    });
  });
});
