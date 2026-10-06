import { describe, it, expect } from 'vitest';
import { resolveIndeedQuestion } from '../platforms/indeed/indeedResolver';
import { DEFAULT_CAREER_BRAIN, type ICareerBrain } from '@extension/storage';

describe('IndeedResolver - Phase 6 Question Resolution', () => {
  const mockCareerBrain: ICareerBrain = {
    ...DEFAULT_CAREER_BRAIN,
    fullName: 'Mubasshir Ali',
    email: 'mubasshir@example.com',
    phoneNumber: '+91 9876543210',
    currentLocation: 'Bengaluru, Karnataka, India',
    preferredLocations: ['Bengaluru, Karnataka, India', 'Remote'],
    yearsOfExperience: 3,
    currentTitle: 'Senior Full Stack Developer',
    currentCTC: '1200000',
    expectedCTC: '1800000',
    noticePeriod: '15 days',
    education: "Bachelor's Degree",
    highestEducation: 'B.Tech in Computer Science',
    college: 'Maulana Abul Kalam Azad University of Technology',
    gender: 'Male',
    workExperience: [
      {
        id: 'exp-1',
        company: 'AI-King Solutions',
        title: 'Full Stack Developer',
        isCurrent: true,
        startMonth: 'January',
        startYear: '2023',
        endMonth: null,
        endYear: null,
        description: 'Building web applications',
        source: 'manual',
      },
    ],
    skillExperience: {
      React: 3,
      'Node.js': 3,
      TypeScript: 2,
      Python: 1,
    },
    goldenAnswers: [
      {
        id: 'ga-1',
        question: 'Do you have experience with microservices architecture?',
        answer: 'Yes, built multiple scalable microservices with Docker and Kubernetes.',
      },
    ],
  };

  describe('Policy, Consent & Conditional fields', () => {
    it('resolves consent and terms questions with 0.99 confidence', () => {
      const res = resolveIndeedQuestion(
        'Do you agree to our privacy policy and terms?',
        'checkbox',
        ['I Agree', 'Decline'],
        mockCareerBrain,
      );
      expect(res.value).toBe('I Agree');
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
      expect(res.source).toBe('profile');
    });

    it('keeps conditional "If yes..." follow-up fields strictly empty', () => {
      const res = resolveIndeedQuestion(
        'If yes, approximate date(s) of previous employment:',
        'text',
        [],
        mockCareerBrain,
      );
      expect(res.value).toBe('');
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('resolves job referral source questions to Indeed', () => {
      const res = resolveIndeedQuestion(
        'How did you hear about this role?',
        'dropdown',
        ['Indeed', 'LinkedIn', 'Friend'],
        mockCareerBrain,
      );
      expect(res.value).toBe('Indeed');
      expect(res.source).toBe('profile');
    });
  });

  describe('Work Authorization & Sponsorship', () => {
    it('resolves sponsorship questions to No', () => {
      const res = resolveIndeedQuestion(
        'Will you now or in the future require visa sponsorship?',
        'radio',
        ['Yes', 'No'],
        mockCareerBrain,
      );
      expect(res.value).toBe('No');
      expect(res.source).toBe('profile');
    });

    it('resolves authorized to work questions to Yes', () => {
      const res = resolveIndeedQuestion(
        'Are you legally authorized to work in India?',
        'radio',
        ['Yes', 'No'],
        mockCareerBrain,
      );
      expect(res.value).toBe('Yes');
      expect(res.source).toBe('profile');
    });
  });

  describe('Experience & Skill Questions', () => {
    it('matches skill-specific years of experience accurately from CareerBrain', () => {
      const res = resolveIndeedQuestion(
        'How many years of experience do you have with React?',
        'number',
        [],
        mockCareerBrain,
      );
      expect(res.value).toBe('3');
      expect(res.source).toBe('profile');
      expect(res.confidence).toBe(0.95);
    });

    it('falls back to overall years of experience for generic experience questions', () => {
      const res = resolveIndeedQuestion(
        'How many total years of professional experience do you have?',
        'number',
        [],
        mockCareerBrain,
      );
      expect(res.value).toBe('3');
      expect(res.source).toBe('profile');
      expect(res.confidence).toBe(0.95);
    });

    it('returns 0 with low confidence (0.2) for unlisted skills so LLM verifies with full context, never inventing total YOE', () => {
      const res = resolveIndeedQuestion(
        'How many years of MERN Stack experience do you have?',
        'number',
        [],
        mockCareerBrain,
      );
      expect(res.value).toBe('0');
      expect(res.confidence).toBe(0.2);
      expect(res.source).toBe('default');

      const resAi = resolveIndeedQuestion(
        'How many years of AI experience do you have?',
        'number',
        [],
        mockCareerBrain,
      );
      expect(resAi.value).toBe('0');
      expect(resAi.confidence).toBe(0.2);

      const resDevOps = resolveIndeedQuestion(
        'How many years of DevOps experience do you have?',
        'number',
        [],
        mockCareerBrain,
      );
      expect(resDevOps.value).toBe('0');
      expect(resDevOps.confidence).toBe(0.2);
    });

    it('picks 0 or None option for unlisted skills when options are provided', () => {
      const res = resolveIndeedQuestion(
        'How many years of Kubernetes experience do you have?',
        'dropdown',
        ['None', '1-2 years', '3-5 years', '5+ years'],
        mockCareerBrain,
      );
      expect(res.value).toBe('None');
      expect(res.confidence).toBe(0.2);
    });
  });

  describe('Compensation & Notice Period', () => {
    it('resolves notice period from CareerBrain', () => {
      const res = resolveIndeedQuestion(
        'What is your official notice period?',
        'dropdown',
        ['Immediate', '15 days', '1 month', '3 months'],
        mockCareerBrain,
      );
      expect(res.value).toBe('15 days');
      expect(res.source).toBe('profile');
    });

    it('resolves expected salary cleanly without non-numeric clutter', () => {
      const res = resolveIndeedQuestion('What is your expected annual salary (CTC)?', 'number', [], mockCareerBrain);
      expect(res.value).toBe('1800000');
      expect(res.source).toBe('profile');
    });
  });

  describe('Golden Answers Semantic Matching', () => {
    it('matches golden answer when present in candidate profile', () => {
      const res = resolveIndeedQuestion(
        'Have you previously worked with microservices architecture?',
        'text',
        [],
        mockCareerBrain,
      );
      expect(res.value).toContain('microservices');
      expect(res.source).toBe('golden_answer');
    });
  });

  describe('Company Previous Employment vs Technical Skill Experience', () => {
    it('answers No for previous employment at this company', () => {
      const res = resolveIndeedQuestion(
        'Have you previously worked for this company?',
        'radio',
        ['Yes', 'No'],
        mockCareerBrain,
      );
      expect(res.value).toBe('No');
      expect(res.source).toBe('profile');
    });

    it('does not falsely trigger previous company check on technical questions', () => {
      const res = resolveIndeedQuestion(
        'Have you previously worked with TypeScript in production?',
        'number',
        [],
        mockCareerBrain,
      );
      expect(res.value).toBe('2'); // From skillExperience: TypeScript: 2
      expect(res.source).toBe('profile');
    });
  });

  describe('Background Checks & Commute', () => {
    it('answers Yes to background check and drug screen consent', () => {
      const res = resolveIndeedQuestion(
        'Are you willing to undergo a background investigation and drug test?',
        'radio',
        ['Yes', 'No'],
        mockCareerBrain,
      );
      expect(res.value).toBe('Yes');
      expect(res.source).toBe('profile');
    });

    it('answers Yes to commute and relocation readiness', () => {
      const res = resolveIndeedQuestion(
        'Are you able to reliably commute to the Bengaluru office?',
        'radio',
        ['Yes', 'No'],
        mockCareerBrain,
      );
      expect(res.value).toBe('Yes');
      expect(res.source).toBe('profile');
    });
  });

  describe('Education & Diversity Categories', () => {
    it('resolves highest education degree matching profile', () => {
      const res = resolveIndeedQuestion(
        'What is your highest level of education completed?',
        'dropdown',
        ['High School', "Bachelor's Degree", "Master's Degree"],
        mockCareerBrain,
      );
      expect(res.value).toBe("Bachelor's Degree");
      expect(res.source).toBe('profile');
    });

    it('resolves veteran and disability status with non-protected defaults', () => {
      const vet = resolveIndeedQuestion(
        'Veteran status:',
        'dropdown',
        ['I am not a protected veteran', 'I identify as a protected veteran'],
        mockCareerBrain,
      );
      expect(vet.value).toContain('not a protected veteran');

      const dis = resolveIndeedQuestion(
        'Disability status:',
        'dropdown',
        ['No, I do not have a disability', 'Yes, I have a disability'],
        mockCareerBrain,
      );
      expect(dis.value).toContain('No');
    });
  });

  describe('Country & Location Dropdowns', () => {
    it('resolves Country * dropdown accurately to India and ignores placeholder options', () => {
      const res = resolveIndeedQuestion(
        'Country *',
        'dropdown',
        ['Select an option', 'Afghanistan', 'India', 'United States'],
        mockCareerBrain,
      );
      expect(res.value).toBe('India');
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
      expect(res.source).toBe('profile');
    });

    it('resolves Country dropdown with ISO country codes to IN', () => {
      const res = resolveIndeedQuestion(
        'Country',
        'dropdown',
        ['Choose a country', 'AF', 'IN', 'US', 'GB'],
        mockCareerBrain,
      );
      expect(res.value).toBe('IN');
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('resolves Country * to India even when currentLocation only mentions Bengaluru', () => {
      const brainWithoutCountry: ICareerBrain = {
        ...mockCareerBrain,
        currentLocation: 'Bengaluru, Karnataka',
      };
      const res = resolveIndeedQuestion(
        'Country *',
        'dropdown',
        ['Select an option', 'India', 'United States'],
        brainWithoutCountry,
      );
      expect(res.value).toBe('India');
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
    });
  });
});
