import { describe, it, expect, vi } from 'vitest';
import { extractStructuralFieldLabel, isGenericPlaceholderText } from '../../browser/easyApplyContainer';
import {
  matchRuleBased,
  adaptAnswerToFieldFormat,
  isSkillMentionedInText,
  resolveModalFieldWithAudit,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';
import { validateAnswerForField } from '../intelligence';
import { resolveIndeedQuestion } from '../platforms/indeed/indeedResolver';
import { resolveNaukriQuestion } from '../platforms/naukri/naukriResolver';
import { type ICareerBrain, DEFAULT_CAREER_BRAIN } from '@extension/storage';

describe('Resolver Guards & Regression Test Suite', () => {
  const baseCareerBrain: ICareerBrain = {
    ...DEFAULT_CAREER_BRAIN,
    fullName: 'Mubasshir Ali',
    email: 'mubasshir@example.com',
    phoneNumber: '+91 70031 51313',
    currentTitle: 'Senior Full Stack Engineer',
    currentLocation: 'Noida, Uttar Pradesh, India',
    yearsOfExperience: 5,
    hasWorkExperience: true,
    workExperience: [
      {
        id: 'exp_1',
        title: 'Full Stack Engineer',
        company: 'Tech Solutions Inc',
        startMonth: 'January',
        startYear: '2021',
        endMonth: '',
        endYear: '',
        isCurrent: true,
        description: 'Developed modern applications with React, Node.js, and TypeScript.',
        source: 'manual',
      },
    ],
    skills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL', 'AWS'],
    skillExperience: {
      C: 2,
      React: 4,
      'Node.js': 4,
      TypeScript: 3,
    },
    noticePeriod: '15 days',
    currentCTC: '12 LPA',
    expectedCTC: '18 LPA',
  };

  // 1. Label Extraction on new <dialog> layout
  describe('Requirement 1: Structural Label Extraction (New <dialog> Layout)', () => {
    it('extracts real question text from fieldset legend instead of "Form Field"', () => {
      const mockFieldset = {
        querySelector: (sel: string) => {
          if (sel === 'legend') {
            return {
              textContent: 'Are you legally authorized to work in the United States?',
              innerText: 'Are you legally authorized to work in the United States?',
            };
          }
          return null;
        },
        getAttribute: () => null,
        closest: () => null,
      };

      const mockControl = {
        id: 'radio-1',
        getAttribute: (attr: string) => (attr === 'name' ? 'work_auth' : null),
        closest: (sel: string) => (sel === 'fieldset' ? mockFieldset : null),
      };

      const extracted = extractStructuralFieldLabel(mockControl as any);
      expect(extracted).toBe('Are you legally authorized to work in the United States?');
      expect(isGenericPlaceholderText(extracted)).toBe(false);
    });

    it('extracts label from aria-labelledby or aria-label when legend is absent', () => {
      const mockControlWithAria = {
        id: 'text-input-1',
        getAttribute: (attr: string) => (attr === 'aria-label' ? 'Current City of Residence' : null),
        closest: () => null,
      };

      const extracted = extractStructuralFieldLabel(mockControlWithAria as any);
      expect(extracted).toBe('Current City of Residence');
    });

    it('identifies generic placeholder "Form Field" as invalid and flags for rejection', () => {
      expect(isGenericPlaceholderText('Form Field')).toBe(true);
      expect(isGenericPlaceholderText('form-field')).toBe(true);
      expect(isGenericPlaceholderText('input')).toBe(true);
      expect(isGenericPlaceholderText('How many years of React experience do you have?')).toBe(false);
    });
  });

  // 2. "C" Bug: Overall IT Industry Experience
  describe('Requirement 2: Overall IT Industry Experience vs Skill "C"', () => {
    it('resolves "How many years of overall IT industry experience do you have?" from careerBrain.yearsOfExperience (5), NOT skillExperience["C"] (2)', () => {
      const field: FormFieldDescriptor = {
        label: 'How many years of overall IT industry experience do you have?',
        fieldType: 'number',
      };

      const match = matchRuleBased(field, baseCareerBrain);
      expect(match.matched).toBe(true);
      expect(match.answer).toBe('5');
      expect(match.answer).not.toBe('2');
    });

    it('resolves overall IT industry experience on Indeed from yearsOfExperience (5), NOT "C" (2)', () => {
      const indeedRes = resolveIndeedQuestion(
        'How many years of overall IT industry experience do you have?',
        'number',
        [],
        baseCareerBrain,
      );
      expect(indeedRes.value).toBe('5');
      expect(indeedRes.value).not.toBe('2');
    });

    it('resolves total work experience on Naukri from yearsOfExperience (5), NOT "C" (2)', () => {
      const naukriRes = resolveNaukriQuestion(
        'How many years of total experience do you have in the IT industry?',
        'number',
        [],
        baseCareerBrain,
      );
      expect(naukriRes.value).toBe('5');
      expect(naukriRes.value).not.toBe('2');
    });
  });

  // 3. LLM / Machine Learning Experience Matching
  describe('Requirement 3: LLM / Machine Learning Questions vs Skill "C"', () => {
    it('resolves to 0 years when candidate has NO LLM/ML skills, never borrowing from "C" (2)', () => {
      const field: FormFieldDescriptor = {
        label: 'How many years of hands-on experience do you have working with LLMs or applied machine learning?',
        fieldType: 'number',
      };

      const match = matchRuleBased(field, baseCareerBrain);
      expect(match.matched).toBe(true);
      expect(match.answer).toBe('0');
      expect(match.answer).not.toBe('2');
    });

    it('matches registered machine learning skills when present in profile', () => {
      const brainWithML: ICareerBrain = {
        ...baseCareerBrain,
        skillExperience: {
          ...baseCareerBrain.skillExperience,
          'machine learning': 3,
        },
      };

      const field: FormFieldDescriptor = {
        label: 'How many years of hands-on experience do you have working with LLMs or applied machine learning?',
        fieldType: 'number',
      };

      const match = matchRuleBased(field, brainWithML);
      expect(match.matched).toBe(true);
      expect(match.answer).toBe('3');
      expect(match.answer).not.toBe('2');
    });
  });

  // 4. Token-Based Skill Matching ("C", "R", "Go")
  describe('Requirement 4: Whole-Word and Token-Based Skill Matching', () => {
    it('does NOT match single letter "C" inside longer words like "experience", "client", "communication", or "machine"', () => {
      expect(isSkillMentionedInText('C', 'How many years of experience do you have?')).toBe(false);
      expect(isSkillMentionedInText('C', 'Do you have good client communication skills?')).toBe(false);
      expect(isSkillMentionedInText('C', 'Experience with machine learning models')).toBe(false);
      expect(isSkillMentionedInText('C', 'Continuous integration and deployment')).toBe(false);
    });

    it('does NOT match "R" inside "remote" or "ready"', () => {
      expect(isSkillMentionedInText('R', 'Are you ready for remote work?')).toBe(false);
    });

    it('does NOT match "Go" inside "good" or "algorithm"', () => {
      expect(isSkillMentionedInText('Go', 'Strong problem solving and algorithm design')).toBe(false);
    });

    it('DOES match exact skill tokens when explicitly asked as an isolated word or token', () => {
      expect(isSkillMentionedInText('C', 'How many years of C programming experience do you have?')).toBe(true);
      expect(isSkillMentionedInText('C', 'Experience in C / C++')).toBe(true);
      expect(isSkillMentionedInText('Go', 'Experience with Go and Python')).toBe(true);
      expect(isSkillMentionedInText('React', 'Hands-on experience with React.js')).toBe(true);
    });
  });

  // 5. Empty Answers Rejection
  describe('Requirement 5: Empty Answers Never Injected Into DOM', () => {
    it('rejects empty string and whitespace-only answers in validateAnswerForField', () => {
      const field: FormFieldDescriptor = { label: 'Notice Period', fieldType: 'text' };
      const resEmpty = validateAnswerForField('', field);
      expect(resEmpty.valid).toBe(false);
      expect(resEmpty.value).toBe('');

      const resSpaces = validateAnswerForField('   ', field);
      expect(resSpaces.valid).toBe(false);
      expect(resSpaces.value).toBe('');

      const resNull = validateAnswerForField(null as any, field);
      expect(resNull.valid).toBe(false);
      expect(resNull.value).toBe('');
    });

    it('rejects empty string in adaptAnswerToFieldFormat', () => {
      const field: FormFieldDescriptor = { label: 'Notice Period', fieldType: 'text' };
      const res = adaptAnswerToFieldFormat('', field);
      expect(res.valid).toBe(false);
      expect(res.value).toBe('');
    });
  });

  // 6. Salary Field Paragraph Rejection (Prose Guard)
  describe('Requirement 6: Salary Field Paragraph Rejection (Prose Guard)', () => {
    const longBio =
      'I am an experienced full-stack engineer with over 5 years of experience building scalable distributed web systems and microservices using React, Node.js, and cloud architectures.';

    it('rejects full bio paragraph into salary / CTC text field', () => {
      const field: FormFieldDescriptor = {
        label: 'Current salary in Lakhs per annum',
        fieldType: 'text',
      };

      const res = validateAnswerForField(longBio, field);
      expect(res.valid).toBe(false);
      expect(res.value).toBe('');
      expect(res.reason).toContain('Rejected long prose');
    });

    it('adaptAnswerToFieldFormat rejects full bio paragraph for salary field without DOM corruption', () => {
      const field: FormFieldDescriptor = {
        label: 'Current salary in Lakhs per annum',
        fieldType: 'text',
      };

      const res = adaptAnswerToFieldFormat(longBio, field);
      expect(res.valid).toBe(false);
      expect(res.value).toBe('');
    });

    it('accepts valid salary numbers in Lakhs or INR', () => {
      const fieldLPA: FormFieldDescriptor = {
        label: 'Current salary in Lakhs per annum',
        fieldType: 'text',
      };

      const resLPA = validateAnswerForField('12 LPA', fieldLPA);
      expect(resLPA.valid).toBe(true);
      expect(resLPA.value).toBe('12');

      const fieldINR: FormFieldDescriptor = {
        label: 'What is your current CTC in INR?',
        fieldType: 'number',
      };

      const resINR = validateAnswerForField('1200000', fieldINR);
      expect(resINR.valid).toBe(true);
      expect(resINR.value).toBe('1200000');
    });
  });

  // 7. Dropdown Option Validation
  describe('Requirement 7: Dropdown Option Validation (No Fabricated Defaults)', () => {
    it('rejects dropdown answer that does not match available options', () => {
      const field: FormFieldDescriptor = {
        label: 'Notice Period',
        fieldType: 'dropdown',
        options: ['Immediate', '15 days', '30 days', '60 days'],
      };

      const res = validateAnswerForField('2 weeks maybe or next month depending on company policy', field);
      expect(res.valid).toBe(false);
      expect(res.value).toBe('');
      expect(res.value).not.toBe('Immediate'); // Must NEVER default to options[0]!
    });

    it('accepts matching option and aligns Yes/No options properly', () => {
      const fieldYesNo: FormFieldDescriptor = {
        label: 'Are you comfortable working on-site?',
        fieldType: 'radio',
        options: ['Yes', 'No'],
      };

      const resYes = validateAnswerForField('Yes', fieldYesNo);
      expect(resYes.valid).toBe(true);
      expect(resYes.value).toBe('Yes');

      const resTrue = validateAnswerForField('true', fieldYesNo);
      expect(resTrue.valid).toBe(true);
      expect(resTrue.value).toBe('Yes');
    });
  });

  // 8. LLM Failure Fallback Behavior (Mocked LLM)
  describe('Requirement 8: LLM Failure Leaves Field UNRESOLVED (No Fabricated Defaults)', () => {
    it('leaves question UNRESOLVED when mocked LLM returns 400 Bad Request on unknown question', async () => {
      const mockFailingLLM: any = {
        invoke: vi.fn().mockRejectedValue(new Error('L3: 400 {"code":"PROVIDER_BAD_REQUEST"}')),
      };

      const mockPage: any = {
        fillModalFieldDirect: vi.fn().mockResolvedValue(true),
      };

      const field: FormFieldDescriptor = {
        label: 'What is your secret clearance level for government projects?',
        fieldType: 'text',
      };

      const res = await resolveModalFieldWithAudit(mockPage, field, baseCareerBrain, mockFailingLLM, undefined, {
        skipAskUser: true,
      });

      expect(res.success).toBe(false);
      expect(res.needsUserAnswer).toBe(true);
      // DOM fill must NEVER be called with fabricated answers
      expect(mockPage.fillModalFieldDirect).not.toHaveBeenCalled();
    });

    it('rejects placeholder "Form Field" immediately without calling LLM', async () => {
      const mockLLM: any = {
        invoke: vi.fn(),
      };

      const mockPage: any = {
        fillModalFieldDirect: vi.fn().mockResolvedValue(true),
      };

      const field: FormFieldDescriptor = {
        label: 'Form Field',
        fieldType: 'radio',
        options: ['Option 1', 'Option 2'],
      };

      const res = await resolveModalFieldWithAudit(mockPage, field, baseCareerBrain, mockLLM, undefined, {
        skipAskUser: true,
      });

      expect(res.success).toBe(false);
      expect(res.needsUserAnswer).toBe(true);
      expect(mockLLM.invoke).not.toHaveBeenCalled();
      expect(mockPage.fillModalFieldDirect).not.toHaveBeenCalled();
    });
  });
});
