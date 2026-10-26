import { describe, it, expect } from 'vitest';
import type { ICareerBrain } from '@extension/storage';
import { resolveNaukriQuestion, matchNumericRangeOption } from '../platforms/naukri/naukriResolver';
import { NAUKRI_SELECTORS } from '../platforms/naukri/selectors';

describe('Naukri Questionnaire & Drawer Resolvers', () => {
  const baseCareerBrain: Partial<ICareerBrain> = {
    fullName: 'Alex Smith',
    email: 'alex.smith@example.com',
    phoneNumber: '+91 9876543210',
    currentTitle: 'Full Stack Developer',
    currentCTC: '700000',
    expectedCTC: '1200000',
    noticePeriod: '15 Days',
    yearsOfExperience: 3,
    skills: ['AWS Devops', 'React', 'Node.js'],
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

  describe('Naukri Selectors for Drawer, Modal and Chatbot', () => {
    it('includes drawer-wrapper and modern drawer selectors in MODAL_CONTAINER', () => {
      expect(NAUKRI_SELECTORS.MODAL_CONTAINER).toContain('div.drawer-wrapper');
      expect(NAUKRI_SELECTORS.MODAL_CONTAINER.some(s => s.includes('drawer'))).toBe(true);
      expect(NAUKRI_SELECTORS.MODAL_CONTAINER.some(s => s.includes('chatbot'))).toBe(true);
    });

    it('includes skip question buttons in SKIP_QUESTION_BUTTON', () => {
      expect(NAUKRI_SELECTORS.SKIP_QUESTION_BUTTON.length).toBeGreaterThan(0);
      expect(NAUKRI_SELECTORS.SKIP_QUESTION_BUTTON.some(s => s.includes('skip'))).toBe(true);
    });

    it('includes chatbot bubbles and options selectors', () => {
      expect(NAUKRI_SELECTORS.CHATBOT_QUESTION_BUBBLE.length).toBeGreaterThan(0);
      expect(NAUKRI_SELECTORS.CHATBOT_OPTIONS.length).toBeGreaterThan(0);
    });
  });

  describe('Numeric Range Option Matching (matchNumericRangeOption)', () => {
    const binaryOptions = ['6+', 'Less than 6'];

    it('matches "Less than 6" when candidate experience is 3 years', () => {
      expect(matchNumericRangeOption(3, binaryOptions)).toBe('Less than 6');
    });

    it('matches "6+" when candidate experience is 6 years or more', () => {
      expect(matchNumericRangeOption(6, binaryOptions)).toBe('6+');
      expect(matchNumericRangeOption(8, binaryOptions)).toBe('6+');
    });

    it('matches interval ranges correctly (e.g. "3-5 Years")', () => {
      const ranges = ['0-1 Years', '1-3 Years', '3-5 Years', '5+ Years'];
      expect(matchNumericRangeOption(4, ranges)).toBe('3-5 Years');
      expect(matchNumericRangeOption(2, ranges)).toBe('1-3 Years');
      expect(matchNumericRangeOption(7, ranges)).toBe('5+ Years');
    });

    it('matches Fresher when experience is 0', () => {
      const ranges = ['Fresher', '1-3 Years', '3+ Years'];
      expect(matchNumericRangeOption(0, ranges)).toBe('Fresher');
    });
  });

  describe('Naukri Chatbot Screening Questions', () => {
    it('correctly resolves chatbot choice options "6+" vs "Less than 6" for candidate with 3 years experience', () => {
      const res = resolveNaukriQuestion(
        'How many years of experience do you have in Aws Devops?',
        'radio',
        ['6+', 'Less than 6'],
        baseCareerBrain as ICareerBrain,
      );
      expect(res.value).toBe('Less than 6');
      expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('correctly resolves chatbot text input when placeholder is "Type message here..."', () => {
      const res = resolveNaukriQuestion(
        'How many years of experience do you have in AWS Devops?',
        'text',
        [],
        baseCareerBrain as ICareerBrain,
        'Type message here...',
      );
      expect(res.value).toBe('3');
      expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('uses skillExperience when specific skill is registered in Career Brain', () => {
      const brainWithSkillExp: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        skillExperience: {
          'aws devops': 7,
        },
      };
      const res = resolveNaukriQuestion(
        'How many years of experience do you have in Aws Devops?',
        'radio',
        ['6+', 'Less than 6'],
        brainWithSkillExp,
      );
      expect(res.value).toBe('6+');
    });

    it('correctly resolves "How many years of experience do you have in Kubernetes?" when skill is in candidate profile', () => {
      const brainWithK8s: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        skills: ['Kubernetes', 'Docker', 'AWS', 'Python'],
        yearsOfExperience: 3,
      };
      // Text / Number input: returns candidate's years of experience
      const resText = resolveNaukriQuestion(
        'How many years of experience do you have in Kubernetes?',
        'text',
        [],
        brainWithK8s,
        'Type message here...',
      );
      expect(resText.value).toBe('3');
      expect(resText.confidence).toBeGreaterThanOrEqual(0.9);

      // Radio choice options (e.g. 1-3 vs 3-5 vs 5+)
      const resRadio = resolveNaukriQuestion(
        'How many years of experience do you have in Kubernetes?',
        'radio',
        ['0-1 Years', '1-3 Years', '3-5 Years', '5+ Years'],
        brainWithK8s,
      );
      expect(resRadio.value).toBe('1-3 Years');

      // Specific skillExperience override (e.g. 4 years in Kubernetes)
      const brainWithK8sExp: ICareerBrain = {
        ...brainWithK8s,
        skillExperience: {
          kubernetes: 4,
        },
      };
      const resOverride = resolveNaukriQuestion(
        'How many years of experience do you have in Kubernetes?',
        'text',
        [],
        brainWithK8sExp,
      );
      expect(resOverride.value).toBe('4');
    });
  });

  describe('Naukri Red Error Alert Selectors & Healing', () => {
    it('has comprehensive inline red error indicators defined in NAUKRI_SELECTORS', () => {
      expect(NAUKRI_SELECTORS.ERROR_INDICATORS).toContain('.err-msg');
      expect(NAUKRI_SELECTORS.ERROR_INDICATORS).toContain('.err');
      expect(NAUKRI_SELECTORS.ERROR_INDICATORS).toContain('[class*="field-error" i]');
      expect(NAUKRI_SELECTORS.ERROR_INDICATORS).toContain('[class*="validation-err" i]');
    });

    it('has drawer save and skip buttons in selectors', () => {
      expect(NAUKRI_SELECTORS.SUBMIT_BUTTON).toContain('button.drawer-save');
      expect(NAUKRI_SELECTORS.SUBMIT_BUTTON).toContain('button.send-btn');
      expect(NAUKRI_SELECTORS.SKIP_QUESTION_BUTTON).toContain('button[class*="skip" i]');
      expect(NAUKRI_SELECTORS.SKIP_QUESTION_BUTTON).toContain('.skip-btn');
    });
  });

  describe('Comprehensive Question Intents & Input Formats', () => {
    it('resolves relocation preference (Yes)', () => {
      const res = resolveNaukriQuestion(
        'Are you ready to relocate for this position?',
        'radio',
        ['Yes', 'No'],
        baseCareerBrain as ICareerBrain,
      );
      expect(res.value).toBe('Yes');
      expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('resolves shift comfort (Night / Rotational Shifts)', () => {
      const res = resolveNaukriQuestion(
        'Are you comfortable working in rotational night shifts?',
        'radio',
        ['Yes', 'No'],
        baseCareerBrain as ICareerBrain,
      );
      expect(res.value).toBe('Yes');
    });

    it('resolves education level / degree question', () => {
      const res = resolveNaukriQuestion(
        'Are you a graduate in Computer Science, Information Technology, or an equivalent field?',
        'radio',
        ['Yes', 'No'],
        baseCareerBrain as ICareerBrain,
      );
      expect(res.value).toBe('Yes');
    });

    it('resolves professional certification when present in skills', () => {
      const brainWithCert: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        skills: ['AWS Certified Solutions Architect', 'Docker', 'Kubernetes'],
      };
      const res = resolveNaukriQuestion('Are you AWS certified?', 'radio', ['Yes', 'No'], brainWithCert);
      expect(res.value).toBe('Yes');
    });

    it('resolves job change reason for textarea/long text', () => {
      const res = resolveNaukriQuestion(
        'Why are you leaving your current job?',
        'text_long',
        [],
        baseCareerBrain as ICareerBrain,
      );
      expect(res.value).toContain('Looking for better career growth');
    });

    it('resolves multi-select checkboxes by matching all candidate skills', () => {
      const brainWithSkills: ICareerBrain = {
        ...(baseCareerBrain as ICareerBrain),
        skills: ['Python', 'Docker', 'Kubernetes', 'React'],
      };
      const res = resolveNaukriQuestion(
        'Which of the following technologies do you have experience in?',
        'checkbox',
        ['Python', 'Java', 'Docker', 'Ruby', 'Kubernetes'],
        brainWithSkills,
      );
      expect(res.value).toContain('Python');
      expect(res.value).toContain('Docker');
      expect(res.value).toContain('Kubernetes');
      expect(res.value).not.toContain('Java');
    });

    it('distinguishes descriptive experience questions from numeric total experience questions', () => {
      const descriptiveQ = 'What is your experience with FastAPI/Flask, MLOps/LLMOps, and production deployment?';
      const descRes = resolveNaukriQuestion(
        descriptiveQ,
        'text',
        [],
        baseCareerBrain as ICareerBrain,
        'Type message here...',
      );

      // Must NOT return numeric "3"
      expect(descRes.value).not.toBe('3');
      expect(descRes.value.length).toBeGreaterThan(100);
      expect(descRes.value.length).toBeLessThanOrEqual(200);
      expect(descRes.value.toLowerCase()).toContain('experience');
      // Confidence must be <= 0.8 so LLM will be consulted when available
      expect(descRes.confidence).toBeLessThanOrEqual(0.8);

      // Meanwhile, explicit numeric question must still return "3"
      const numericQ = 'How many years of experience do you have in total?';
      const numRes = resolveNaukriQuestion(numericQ, 'number', [], baseCareerBrain as ICareerBrain);
      expect(numRes.value).toBe('3');
      expect(numRes.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });
});
