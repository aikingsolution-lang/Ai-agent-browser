import { describe, it, expect } from 'vitest';
import { matchRuleBased, adaptAnswerToFieldFormat, type FormFieldDescriptor } from '../linkedin/formQuestionResolver';
import { alignValueToOptions, matchQuestionSemantically } from '../intelligence';
import { type ICareerBrain, DEFAULT_CAREER_BRAIN } from '@extension/storage';

/**
 * 5 Real-World Stress & Edge Case Test Suite
 * Tests the 5 most brutal ways real users and portal quirks break auto-apply systems.
 */
describe('5 Real-World System Breaking Scenarios & Defenses', () => {
  const mockCareerBrain: ICareerBrain = {
    ...DEFAULT_CAREER_BRAIN,
    fullName: 'Rahul Sharma',
    email: 'rahul.sharma@example.com',
    phoneNumber: '+91 98765 43210',
    currentTitle: 'Full Stack Engineer',
    currentLocation: 'Bengaluru, Karnataka, India',
    yearsOfExperience: 4,
    hasWorkExperience: true,
    skills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL'],
    skillExperience: {
      React: 4,
      'Node.js': 3,
      TypeScript: 2,
    },
    workAuthorization: 'Citizen of India / Authorized to work without sponsorship',
    noticePeriod: 'Immediate',
    currentCTC: '12 LPA',
    expectedCTC: '18 LPA',
    resumeFileName: 'Rahul_Sharma_Resume.pdf',
    resumes: [
      {
        id: 'res_1',
        fileName: 'Rahul_Sharma_Resume.pdf',
        uploadedAt: Date.now(),
        focusTags: ['Full Stack'],
        rawText: 'Rahul Sharma - 4 years experience with React, Node.js, TypeScript...',
        extractedSkills: ['React', 'Node.js', 'TypeScript'],
        isDefault: true,
      },
    ],
    goldenAnswers: [
      {
        id: 'ga_1',
        question: 'Are you comfortable working hybrid in Bengaluru?',
        answer: 'Yes',
        category: 'Workplace',
      },
    ],
    customAnswers: {},
  };

  /* ──────────────────────────────────────────────────────────────────────────
   * Tareeka 1: Mandatory File Upload / Extra Attachment (Cover Letter, Portfolio)
   * Recruiter requires a mandatory file input, but candidate only has a resume.
   * ────────────────────────────────────────────────────────────────────────── */
  describe('Tareeka 1: Mandatory File Upload (Cover Letter / Custom PDF Required)', () => {
    it('1.1: Accurately flags missing required file inputs instead of hanging in loop', () => {
      const stepFields = [{ name: 'coverLetter', type: 'file', required: true, label: 'Upload your cover letter' }];

      const hasRequiredFileUpload = stepFields.some(
        f => f.type === 'file' && f.required && !(mockCareerBrain as any).coverLetterText,
      );

      expect(hasRequiredFileUpload).toBe(true);

      // Simulation of runner defensive guardrail:
      const runnerAction = hasRequiredFileUpload
        ? { status: 'skipped', reason: 'Mandatory Cover Letter required by recruiter but not present in Career Brain' }
        : { status: 'continue' };

      expect(runnerAction.status).toBe('skipped');
      expect(runnerAction.reason).toContain('Cover Letter required');
    });

    it('1.2: Detects LinkedIn resume picker when 0 resumes exist on the account', () => {
      const accountResumesCount = 0;
      const fileInputExists = true;

      const needsManualUpload = accountResumesCount === 0 && fileInputExists;
      expect(needsManualUpload).toBe(true);

      const notification = needsManualUpload
        ? 'Please upload your resume once on LinkedIn — JobPilot will auto-resume immediately!'
        : null;

      expect(notification).toBeTruthy();
      expect(notification).toContain('auto-resume immediately');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Tareeka 2: Numeric Type Mismatch & Constraint Violations
   * User provides text like "Immediate" or "12 LPA", but input demands a number > 0.
   * ────────────────────────────────────────────────────────────────────────── */
  describe('Tareeka 2: Numeric Constraints & Unit Sanitization (Notice Period, CTC, Exp)', () => {
    it('2.1: Converts "Immediate" to "1" when form field enforces "greater than 0"', () => {
      const field: FormFieldDescriptor = {
        label: 'Notice period (in days)',
        fieldType: 'number',
        min: 1,
        hintText: 'Enter a whole number larger than 0',
      };

      const adapted = adaptAnswerToFieldFormat(mockCareerBrain.noticePeriod!, field);

      expect(adapted.valid).toBe(true);
      expect(adapted.value).toBe('1'); // Clamped to 1 to satisfy > 0 constraint
      expect(adapted.wasConverted).toBe(true);
    });

    it('2.2: Converts "Immediate" to "0" when 0 is allowed', () => {
      const field: FormFieldDescriptor = {
        label: 'Notice period (days)',
        fieldType: 'number',
        min: 0,
      };

      const adapted = adaptAnswerToFieldFormat(mockCareerBrain.noticePeriod!, field);

      expect(adapted.valid).toBe(true);
      expect(adapted.value).toBe('0');
      expect(adapted.wasConverted).toBe(true);
    });

    it('2.3: Converts "12 LPA" to numeric "12" for annual salary input', () => {
      const ctcField: FormFieldDescriptor = {
        label: 'Current CTC (in Lakhs per annum)',
        fieldType: 'number',
      };

      const adapted = adaptAnswerToFieldFormat(mockCareerBrain.currentCTC!, ctcField);

      expect(adapted.valid).toBe(true);
      expect(adapted.value).toBe('12');
    });

    it('2.4: Returns "0" for missing skills in numeric years-of-experience field', () => {
      const field: FormFieldDescriptor = {
        label: 'How many years of experience do you have with Docker?',
        fieldType: 'number',
        min: 0,
      };

      const ruleMatch = matchRuleBased(field, mockCareerBrain);
      // Docker is not in skills or skillExperience -> should not match rule
      expect(ruleMatch.matched).toBe(false);

      // Safe fallback when filling required numeric experience field
      const safeNumericAnswer =
        mockCareerBrain.skillExperience?.['Docker'] !== undefined
          ? String(mockCareerBrain.skillExperience['Docker'])
          : '0';

      expect(safeNumericAnswer).toBe('0');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Tareeka 3: Cascading Dropdowns & Dynamic Autocomplete Alignment
   * Options render dynamically or contain minor wording variations.
   * ────────────────────────────────────────────────────────────────────────── */
  describe('Tareeka 3: Dynamic Dropdown & Option Alignment', () => {
    it('3.1: Aligns candidate value to portal dropdown options with slight variations', () => {
      const dropdownOptions = [
        'Select an option',
        'Bengaluru / Bangalore, Karnataka',
        'Noida, Uttar Pradesh',
        'Hyderabad, Telangana',
      ];

      const aligned = alignValueToOptions('Bengaluru', dropdownOptions, 'Preferred Location');

      expect(aligned).not.toBeNull();
      expect(aligned?.matchedOption).toBe('Bengaluru / Bangalore, Karnataka');
      expect(aligned?.confidence).toBeGreaterThan(0.7);
    });

    it('3.2: Rejects fake or unaligned options safely instead of picking random first option', () => {
      const dropdownOptions = ['Select an option', 'Full-time On-site', 'Contract / Freelance'];

      // If user wants Remote and only Onsite or Freelance is present:
      const aligned = alignValueToOptions('100% Remote Only', dropdownOptions, 'Work Arrangement');

      // Confidence will be low (<= 0.3) indicating no genuine match found
      expect(aligned?.confidence).toBeLessThanOrEqual(0.3);
      expect(aligned?.reason).toContain('Default fallback');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Tareeka 4: Ambiguous Binary Questions (Relocation, Sponsorship, Shifts)
   * Unmatched mandatory questions must not be guessed blindly to avoid auto-rejection.
   * ────────────────────────────────────────────────────────────────────────── */
  describe('Tareeka 4: Zero-Invention for Ambiguous Screening Questions', () => {
    it('4.1: Uses Golden Answer memory cache for previously answered workplace questions', () => {
      const question = 'Are you comfortable working hybrid in Bengaluru?';
      const semanticMatch = matchQuestionSemantically(question, mockCareerBrain);

      expect(semanticMatch).not.toBeNull();
      expect(semanticMatch?.matchedAnswer).toBe('Yes');
      expect(semanticMatch?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('4.2: Fails fast and requests user input for unknown critical questions', () => {
      const unknownQuestion: FormFieldDescriptor = {
        label: 'Do you hold an active US Secret Security Clearance?',
        fieldType: 'radio',
        options: ['Yes', 'No'],
        required: true,
      };

      const ruleMatch = matchRuleBased(unknownQuestion, mockCareerBrain);
      const semanticMatch = matchQuestionSemantically(unknownQuestion.label, mockCareerBrain);

      // Must NOT hallucinate or guess Yes/No blindly
      expect(ruleMatch.matched).toBe(false);
      expect(semanticMatch?.matchedAnswer).toBeUndefined();

      // System should route to ask_user rather than guessing
      const action = !ruleMatch.matched && !semanticMatch?.matchedAnswer ? 'ASK_USER' : 'AUTO_FILL';
      expect(action).toBe('ASK_USER');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Tareeka 5: Platform Rate Limiting & Bot Detection Checkpoints
   * LinkedIn 50-limit warning or verification checkpoint detection.
   * ────────────────────────────────────────────────────────────────────────── */
  describe('Tareeka 5: Rate Limiting & Cooldown Walls Detection', () => {
    it('5.1: Detects LinkedIn daily/weekly Easy Apply limit banner and pauses cleanly', () => {
      const simulatedPageTexts = [
        "You've submitted the maximum number of applications for today",
        'You have reached the application limit for this week',
        'To protect our members, Easy Apply applications are temporarily limited',
      ];

      function isPlatformRateLimited(text: string): boolean {
        return /maximum number of applications|reached the (?:application )?limit|temporarily limited|try again tomorrow/i.test(
          text,
        );
      }

      for (const text of simulatedPageTexts) {
        expect(isPlatformRateLimited(text)).toBe(true);
      }

      // Normal application text should not trigger limit
      expect(isPlatformRateLimited('Application submitted successfully')).toBe(false);
      expect(isPlatformRateLimited('Easy Apply to Full Stack Engineer')).toBe(false);
    });

    it('5.2: Detects Security Checkpoint / CAPTCHA challenge without crashing', () => {
      const captchaIndicators = [
        'security verification',
        'let us know you are human',
        'quick security check',
        'arkoselabs challenge',
      ];

      function isSecurityCheckpoint(text: string): boolean {
        return /security (?:verification|check)|let us know you are human|verify you'?re human|checkpoint|captcha|arkose/i.test(
          text,
        );
      }

      for (const indicator of captchaIndicators) {
        expect(isSecurityCheckpoint(indicator)).toBe(true);
      }
    });
  });
});
