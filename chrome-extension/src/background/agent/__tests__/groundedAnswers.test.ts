import { describe, it, expect, vi } from 'vitest';

const { storageData } = vi.hoisted(() => {
  const data: Record<string, any> = {};
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const local = {
    get: async (keys?: string | string[] | null) => {
      if (!keys) return clone(data);
      const res: Record<string, any> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) res[k] = clone(data[k]);
      return res;
    },
    set: async (items: Record<string, any>) => {
      for (const [k, v] of Object.entries(items)) data[k] = clone(v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    onChanged: { addListener: () => undefined },
  };
  (globalThis as any).chrome = {
    storage: { local, sync: local, session: local, onChanged: { addListener: () => undefined } },
  };
  return { storageData: data };
});

import {
  matchFromResumeText,
  matchRuleBased,
  generateAutonomousFallbackAnswerWithSource,
  extractQuestionTopic,
  formatProjectedDate,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';
import { generateJobsCsv } from '@extension/storage';
import { processedJobsStore } from '@extension/storage';
import type { ICareerBrain } from '@extension/storage';

describe('Grounded Answers & Factual Integrity Suite (fix/grounded-answers)', () => {
  const baseCareerBrain: ICareerBrain = {
    fullName: 'Alex Developer',
    email: 'alex@example.com',
    phoneNumber: '+91 9876543210',
    currentTitle: 'Software Engineer',
    resumeText:
      'Full Stack Software Engineer with hands-on experience in React, TypeScript, and Node.js. Built scalable web applications and REST APIs.',
    backgroundNarrative: 'Full stack developer focused on frontend and backend systems.',
    skills: ['React', 'TypeScript', 'Node.js', 'PostgreSQL'],
    yearsOfExperience: 3,
    hasWorkExperience: true,
    workExperience: [
      {
        id: 'we1',
        title: 'Software Engineer',
        company: 'Tech Corp',
        startMonth: '01',
        startYear: '2022',
        endMonth: null,
        endYear: null,
        isCurrent: true,
        description: 'Developed React web apps and microservices.',
        source: 'manual',
      },
    ],
    education: 'Bachelor of Technology in Computer Science',
    currentLocation: 'Hyderabad, Telangana, India',
    noticePeriod: 'Immediate',
    willingToRelocate: 'Yes',
    goldenAnswers: [],
    customAnswers: {},
    skillExperience: { React: 3, TypeScript: 3, 'Node.js': 2 },
    predefinedRoles: ['Software Engineer'],
    preferredLocations: ['Bengaluru', 'Pune'],
    preferredLocation: 'Bengaluru',
    experienceLevels: ['Mid-Senior level'],
    jobTypes: ['Full-time'],
    resumes: [],
    autoExtractedSkills: [],
    gender: 'Male',
    highestEducation: "Bachelor's Degree",
    preferredShift: 'Day / Flexible',
    driverLicense: 'Yes',
    veteranStatus: 'I am not a protected veteran',
    disabilityStatus: 'No, I do not have a disability',
    workAuthorization: 'Citizen of India',
    salaryExpectation: '1200000',
    portfolioUrl: 'https://alex.dev',
    githubUrl: 'https://github.com/alex',
    linkedinUrl: 'https://linkedin.com/in/alex',
    updatedAt: Date.now(),
  };

  describe('Requirement 1 & 2: Resume-text matcher & Whole-Phrase Evidence (Offers in hand)', () => {
    it('does NOT extract "hand" as a skill topic from "Do you have any offer in hand?"', () => {
      const topic = extractQuestionTopic('Do you have any offer in hand?');
      expect(topic).not.toBe('hand');
      expect(topic).toBeNull();
    });

    it('rejects "Do you have any offer in hand" from resume matching even if resume contains "hands-on" or "hand"', async () => {
      const field: FormFieldDescriptor = {
        fieldType: 'radio',
        label: 'Do you have any offer in hand?',
        options: ['Yes', 'No'],
      };

      const result = await matchFromResumeText(field, baseCareerBrain);
      expect(result.matched).toBe(false);
      expect(result.answer).not.toBe('Yes');
    });

    it('truthfully matches Yes/No from resume text only with whole-phrase, question-relevant skill evidence', async () => {
      const field: FormFieldDescriptor = {
        fieldType: 'radio',
        label: 'Do you have experience with React?',
        options: ['Yes', 'No'],
      };

      const result = await matchFromResumeText(field, baseCareerBrain);
      expect(result.matched).toBe(true);
      expect(result.answer).toBe('Yes');
      expect(result.sourceDetail).toContain('explicit whole-phrase mention of "React"');
    });

    it('answers "Do you have any offer in hand?" with truthful neutral "No" from profile rule-based matching', () => {
      const field: FormFieldDescriptor = {
        fieldType: 'radio',
        label: 'Do you have any offer in hand?',
        options: ['Yes', 'No'],
      };

      const res = matchRuleBased(field, baseCareerBrain);
      expect(res.matched).toBe(true);
      expect(res.answer).toBe('No');
      expect(res.sourceDetail).toContain('profile: no competing offers recorded');
    });
  });

  describe('Requirement 3: Official Last Working Day Dynamic Calculation', () => {
    it('derives last working day from today application date when notice period is Immediate', () => {
      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Official last working day (DD/MM/YYYY)',
        placeholder: 'DD/MM/YYYY',
      };

      const today = new Date();
      const expectedDate = formatProjectedDate(today, 'dd/mm/yyyy');

      const res = matchRuleBased(field, baseCareerBrain);
      expect(res.matched).toBe(true);
      expect(res.answer).toContain(expectedDate);
      expect(res.sourceDetail).toContain('noticePeriod is Immediate -> derived from application date');
    });

    it('derives last working day in autonomous fallback from application date without hardcoded 15 days when notice is Immediate', () => {
      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Official last working day',
        placeholder: 'DD/MM/YYYY',
      };

      const today = new Date();
      const expectedDate = formatProjectedDate(today, 'dd/mm/yyyy');

      const fb = generateAutonomousFallbackAnswerWithSource(field, baseCareerBrain, 'Please enter a valid date', 2);
      expect(fb.answer).toBe(expectedDate);
      expect(fb.source).toContain('derived from application date for Immediate notice');
    });

    it('projects last working day accurately when notice period specifies days', () => {
      const brainWithNotice: ICareerBrain = {
        ...baseCareerBrain,
        noticePeriod: '30 days',
      };
      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Official last working day',
        placeholder: 'DD/MM/YYYY',
      };

      const projected = new Date(Date.now() + 30 * 86400000);
      const expectedDate = formatProjectedDate(projected, 'dd/mm/yyyy');

      const res = matchRuleBased(field, brainWithNotice);
      expect(res.matched).toBe(true);
      expect(res.answer).toContain(expectedDate);
      expect(res.sourceDetail).toContain('projected 30 days from application date');
    });

    it('does NOT invent a date when profile has no notice period', () => {
      const brainNoNotice: ICareerBrain = {
        ...baseCareerBrain,
        noticePeriod: undefined,
      };
      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Official last working day',
      };

      const res = matchRuleBased(field, brainNoNotice);
      expect(res.matched).toBe(false);

      const fb = generateAutonomousFallbackAnswerWithSource(field, brainNoNotice, undefined, 1);
      expect(fb.answer).toBe('');
    });
  });

  describe('Requirement 4: Current Location Grounding (Strict Profile currentLocation)', () => {
    it('uses profile currentLocation and NEVER preferred or search location', () => {
      const brain: ICareerBrain = {
        ...baseCareerBrain,
        currentLocation: 'Hyderabad, India',
        preferredLocation: 'Bengaluru, India',
        preferredLocations: ['Bengaluru', 'Pune'],
      };

      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Where are you currently located?',
      };

      const res = matchRuleBased(field, brain);
      expect(res.matched).toBe(true);
      expect(res.answer).toBe('Hyderabad, India');
      expect(res.answer).not.toContain('Bengaluru');
      expect(res.sourceDetail).toContain('profile: currentLocation ("Hyderabad, India")');
    });

    it('does NOT fall back to preferred location or Bengaluru when currentLocation is missing', () => {
      const brainNoLoc: ICareerBrain = {
        ...baseCareerBrain,
        currentLocation: undefined,
        preferredLocation: 'Bengaluru, India',
        preferredLocations: ['Bengaluru'],
      };

      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Where are you currently located?',
      };

      const res = matchRuleBased(field, brainNoLoc);
      expect(res.matched).toBe(false);

      const fb = generateAutonomousFallbackAnswerWithSource(field, brainNoLoc, undefined, 1);
      expect(fb.answer).toBe('');
    });
  });

  describe('Requirement 1: Strict Profile Grounding for Factual Answers', () => {
    it('does NOT invent self-ratings (1 to 5 or 1 to 10) without profile golden answers', () => {
      const field1to5: FormFieldDescriptor = {
        fieldType: 'number',
        label: 'Rate your communication skills on a scale of 1-5',
      };

      const res = matchRuleBased(field1to5, baseCareerBrain);
      expect(res.matched).toBe(false);

      const fb = generateAutonomousFallbackAnswerWithSource(field1to5, baseCareerBrain, 'Required', 1);
      expect(fb.answer).toBe('');
    });

    it('truthfully answers team management questions as individual contributor when candidate has no leadership roles', () => {
      const yesNoField: FormFieldDescriptor = {
        fieldType: 'radio',
        label: 'Have you managed teams?',
        options: ['Yes', 'No'],
      };

      const res = matchRuleBased(yesNoField, baseCareerBrain);
      expect(res.matched).toBe(true);
      expect(res.answer).toBe('No');
      expect(res.sourceDetail).toContain('profile: individual contributor');

      const textField: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Have you managed teams? If yes, what was the team size?',
      };

      const textRes = matchRuleBased(textField, baseCareerBrain);
      expect(textRes.matched).toBe(true);
      expect(textRes.answer).toContain('Individual contributor with no formal team management responsibilities');
      expect(textRes.answer).not.toContain('mentoring');
    });

    it('answers team management affirmatively ONLY when candidate profile has verified leadership', () => {
      const leadBrain: ICareerBrain = {
        ...baseCareerBrain,
        currentTitle: 'Lead Software Engineer',
        skills: ['React', 'Technical Leadership', 'Team Management'],
      };

      const yesNoField: FormFieldDescriptor = {
        fieldType: 'radio',
        label: 'Have you managed teams?',
        options: ['Yes', 'No'],
      };

      const res = matchRuleBased(yesNoField, leadBrain);
      expect(res.matched).toBe(true);
      expect(res.answer).toBe('Yes');
      expect(res.sourceDetail).toContain('profile: leadership role');
    });

    it('respects willingToRelocate = "No" and never invents unlisted preferred cities', () => {
      const noRelocateBrain: ICareerBrain = {
        ...baseCareerBrain,
        willingToRelocate: 'No',
        preferredLocations: [],
      };

      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Are you open to relocation or travel for work? If yes, please specify preferred cities and zones',
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, noRelocateBrain, undefined, 2);
      expect(fb.answer).toBe('No, not open to relocation.');
      expect(fb.source).toContain('profile: willingToRelocate is "No"');
    });

    it('only lists explicit preferredLocations for compound relocation questions without inventing cities', () => {
      const brainWithPrefs: ICareerBrain = {
        ...baseCareerBrain,
        willingToRelocate: 'Yes',
        preferredLocations: ['Bengaluru', 'Pune'],
      };

      const field: FormFieldDescriptor = {
        fieldType: 'text',
        label: 'Are you open to relocation or travel for work? If yes, please specify preferred cities and zones',
      };

      const fb = generateAutonomousFallbackAnswerWithSource(field, brainWithPrefs, undefined, 2);
      expect(fb.answer).toContain('preferred: Bengaluru, Pune');
      expect(fb.answer).not.toContain('Kolkata');
      expect(fb.source).toContain('preferredLocations (Bengaluru, Pune)');
    });
  });

  describe('Requirement 5: Job Title and Company Hygiene in Applied Records & CSV', () => {
    it('CSV export never outputs "LinkedIn Job" or "Unknown Company" for applied jobs', () => {
      const records = [
        {
          jobId: '4482667852',
          url: 'https://www.linkedin.com/jobs/view/4482667852/',
          title: 'Senior Software Engineer',
          company: 'Acme Systems',
          status: 'applied' as const,
          platform: 'linkedin',
          fitScore: 92,
          reason: 'Application submitted and verified',
          timestamp: Date.now(),
        },
        {
          jobId: '9988776655',
          url: 'https://www.linkedin.com/jobs/view/9988776655/',
          title: 'LinkedIn Job', // Placeholder should be sanitized
          company: 'Unknown Company', // Placeholder should be sanitized
          status: 'applied' as const,
          platform: 'linkedin',
          fitScore: 80,
          reason: 'Verified',
          timestamp: Date.now(),
        },
      ];

      const csv = generateJobsCsv(records);
      expect(csv).toContain('Senior Software Engineer');
      expect(csv).toContain('Acme Systems');
      expect(csv).not.toContain('LinkedIn Job');
      expect(csv).not.toContain('Unknown Company');
      expect(csv).toContain('Job #9988776655');
    });

    it('processedJobsStore sanitizes applied records to never persist "LinkedIn Job" or "Unknown Company"', async () => {
      await processedJobsStore.clearRecords();

      await processedJobsStore.recordJob({
        jobId: '1234567890',
        url: 'https://www.linkedin.com/jobs/view/1234567890/',
        title: 'LinkedIn Job',
        company: 'Unknown Company',
        status: 'applied',
        creditsUsed: 1,
      });

      const check = await processedJobsStore.isJobProcessed('1234567890');
      expect(check.isProcessed).toBe(true);
      expect(check.record?.title).toBe('Job #1234567890');
      expect(check.record?.company).toBe('');
      expect(check.record?.title).not.toBe('LinkedIn Job');
      expect(check.record?.company).not.toBe('Unknown Company');
    });
  });
});
