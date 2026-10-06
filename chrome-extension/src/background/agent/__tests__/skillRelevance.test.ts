import { describe, it, expect } from 'vitest';
import { checkJobSkillRelevance } from '../linkedin/dedicatedJobRunner';
import type { ICareerBrain } from '@extension/storage';

describe('checkJobSkillRelevance - Tech Domain and Semantic Matching', () => {
  const dummyCareerBrain: ICareerBrain = {
    currentTitle: 'Full Stack Developer',
    yearsOfExperience: 3,
    skills: ['React', 'Node.js', 'TypeScript', 'JavaScript', 'Express', 'MongoDB'],
    skillExperience: {
      React: 3,
      'Node.js': 3,
      TypeScript: 2,
    },
    predefinedRoles: ['Full Stack Developer', 'Software Engineer'],
    preferredLocations: ['Bengaluru, India'],
    workArrangements: ['remote', 'hybrid'],
    jobTypes: ['full-time'],
    goldenAnswers: [],
  } as unknown as ICareerBrain;

  it('correctly matches software engineering roles when candidate targets "full stack development"', () => {
    const targetRole = 'full stack development';

    const testTitles = [
      'Senior Software Developer - AI Trainer',
      'Application Developer - AI Trainer',
      'Java Developer - AI Trainer',
      'Senior Software Engineer - AI Trainer',
      'Platform Engineer - AI Trainer',
      'DevOps Engineer - AI Trainer',
      'Backend Developer - AI Trainer',
      'Software Engineer - AI Trainer',
      'Full Stack Engineer - AI Trainer',
      'Senior Microsoft Solution Architect',
      'Web Developer (React / Frontend)',
    ];

    for (const title of testTitles) {
      const result = checkJobSkillRelevance(title, undefined, dummyCareerBrain, targetRole);
      expect(result.relevant, `Expected "${title}" to be relevant for target "${targetRole}"`).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(result.threshold);
      expect(result.threshold).toBe(25);
      expect(result.matchedSkills.length).toBeGreaterThan(0);
    }
  });

  it('rejects jobs from unrelated non-tech domains', () => {
    const targetRole = 'full stack development';

    const unrelatedTitles = [
      'Real Estate Sales Executive',
      'Registered Nurse - ICU',
      'Telecaller / Customer Support Associate',
      'Store Manager - Retail',
      'Accounts Executive / Accountant',
      'Delivery Boy / Courier Partner',
    ];

    for (const title of unrelatedTitles) {
      const result = checkJobSkillRelevance(title, undefined, dummyCareerBrain, targetRole);
      expect(result.relevant, `Expected "${title}" to be rejected`).toBe(false);
      expect(result.score).toBeLessThan(result.threshold);
      expect(result.score).toBe(0);
    }
  });

  it('matches via description snippet skills when job title is generic or non-standard', () => {
    const result = checkJobSkillRelevance(
      'Technical Specialist',
      'Looking for a professional with hands-on expertise in React, TypeScript, and Node.js web apps.',
      dummyCareerBrain,
      'Full Stack Developer',
    );
    expect(result.relevant).toBe(true);
    expect(result.matchedSkills).toContain('React');
    expect(result.matchedSkills).toContain('TypeScript');
  });

  it('matches via stemming between "development" and "developer"', () => {
    const candidateWithJustTitle: ICareerBrain = {
      ...dummyCareerBrain,
      skills: ['General Tech'],
      skillExperience: {},
      currentTitle: 'Web Development',
      predefinedRoles: [],
    };
    const result = checkJobSkillRelevance('Senior Web Developer', undefined, candidateWithJustTitle, 'Web Development');
    expect(result.relevant).toBe(true);
  });
});
