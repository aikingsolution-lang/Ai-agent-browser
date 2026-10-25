import { describe, it, expect } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ICareerBrain } from '@extension/storage';
import {
  isProfileHeadlineField,
  isProfileSummaryField,
  buildProfessionalHeadline,
  buildProfileSummaryFallback,
  generateProfileHeadline,
  generateProfileSummaryAnswer,
  isFreeTextNarrativeQuestion,
  matchRuleBased,
  adaptAnswerToFieldFormat,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';

function makeBrain(overrides: Partial<ICareerBrain> = {}): ICareerBrain {
  return {
    fullName: 'Test Candidate',
    email: 'test@example.com',
    phoneNumber: '+91 9876543210',
    currentTitle: 'Full Stack Developer',
    yearsOfExperience: 3,
    currentLocation: 'Bengaluru, Karnataka, India',
    skills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL', 'AWS', 'Docker'],
    skillExperience: {},
    goldenAnswers: [],
    customAnswers: {},
    backgroundNarrative: '',
    resumeText: '',
    workExperience: [
      {
        id: 'w1',
        title: 'Full Stack Developer',
        company: 'Acme Corp',
        startMonth: 'March',
        startYear: '2021',
        endMonth: null,
        endYear: null,
        isCurrent: true,
        description: 'Built and shipped web applications for enterprise customers.',
        source: 'manual',
      },
    ],
    ...overrides,
  } as ICareerBrain;
}

const fakeLlm = (content: string): BaseChatModel => ({ invoke: async () => ({ content }) }) as unknown as BaseChatModel;

const field = (label: string, isTextArea = false): FormFieldDescriptor => ({
  label,
  fieldType: 'text',
  isTextArea,
});

describe('Headline / Summary field detection', () => {
  it('detects plain "Headline" and decorated variants', () => {
    expect(isProfileHeadlineField(field('Headline'))).toBe(true);
    expect(isProfileHeadlineField(field('Headline*'))).toBe(true);
    expect(isProfileHeadlineField(field('Professional Headline'))).toBe(true);
    expect(isProfileHeadlineField(field('Headline (required)'))).toBe(true);
  });

  it('does not treat screening questions or textareas as a headline', () => {
    expect(isProfileHeadlineField(field('What is the headline of your latest project?'))).toBe(false);
    expect(isProfileHeadlineField(field('Headline', true))).toBe(false);
    expect(isProfileHeadlineField(field('Current company'))).toBe(false);
  });

  it('detects "Summary", "Professional Summary" and "About you"', () => {
    expect(isProfileSummaryField(field('Summary', true))).toBe(true);
    expect(isProfileSummaryField(field('Summary*', true))).toBe(true);
    expect(isProfileSummaryField(field('Professional Summary', true))).toBe(true);
    expect(isProfileSummaryField(field('Summary of your experience', true))).toBe(true);
    expect(isProfileSummaryField(field('About you', true))).toBe(true);
  });

  it('does not treat a project summary or unrelated questions as a profile summary', () => {
    expect(isProfileSummaryField(field('Summary of your latest project', true))).toBe(false);
    expect(isProfileSummaryField(field('Current CTC', false))).toBe(false);
  });

  it('treats headline/summary as narrative questions for the LLM path', () => {
    expect(isFreeTextNarrativeQuestion(field('Headline'))).toBe(true);
    expect(isFreeTextNarrativeQuestion(field('Professional Summary', true))).toBe(true);
  });

  it('routes a plain "Summary" to profile-summary generation, not the work-history description', () => {
    const brain = makeBrain();
    expect(matchRuleBased(field('Summary', true), brain).matched).toBe(false);
    expect(matchRuleBased(field('Description', true), brain).answer).toContain('Built and shipped');
  });
});

describe('Deterministic profile fallbacks', () => {
  it('builds "<title> | <skills>" and skips skills already in the title', () => {
    const headline = buildProfessionalHeadline(makeBrain());
    expect(headline).toBe('Full Stack Developer | React, Node.js, TypeScript');
  });

  it('caps the headline at 127 characters', () => {
    const longSkill = 'Extremely Long Technology Name That Eats Characters';
    const brain = makeBrain({
      currentTitle: 'Senior Principal Staff Software Engineer',
      skills: [longSkill, `${longSkill} Two`, `${longSkill} Three`, `${longSkill} Four`],
    });
    const headline = buildProfessionalHeadline(brain);
    expect(headline.length).toBeLessThanOrEqual(127);
    expect(headline.startsWith('Senior Principal Staff Software Engineer')).toBe(true);
  });

  it('falls back to skills when no title is known', () => {
    const brain = makeBrain({ currentTitle: '', workExperience: [] });
    expect(buildProfessionalHeadline(brain)).toBe('React, Node.js, TypeScript');
  });

  it('uses the background narrative for the summary fallback when available', () => {
    const narrative = 'I am a full stack developer who builds reliable web platforms end to end.';
    expect(buildProfileSummaryFallback(makeBrain({ backgroundNarrative: narrative }))).toBe(narrative);
  });

  it('composes a first-person summary fallback from title, years, skills and recent role', () => {
    const summary = buildProfileSummaryFallback(makeBrain());
    expect(summary.startsWith('I am a Full Stack Developer with 3+ years')).toBe(true);
    expect(summary).toContain('React, Node.js, TypeScript');
    expect(summary).toContain('Built and shipped web applications');
  });
});

describe('LLM headline / summary generation', () => {
  it('sanitizes chatter, quotes and extra lines from a generated headline', async () => {
    const llm = fakeLlm('Here is your headline:\n"Full Stack Developer | React, Node.js"\nExtra line');
    const headline = await generateProfileHeadline(makeBrain(), llm);
    expect(headline).toBe('Full Stack Developer | React, Node.js');
  });

  it('caps generated headlines at 127 characters', async () => {
    const headline = await generateProfileHeadline(makeBrain(), fakeLlm('A'.repeat(300)));
    expect(headline.length).toBe(127);
  });

  it('rejects empty/short headline output so the caller can fall back', async () => {
    expect(await generateProfileHeadline(makeBrain(), fakeLlm('N/A'))).toBe('');
  });

  it('cleans and returns a generated professional summary', async () => {
    const llm = fakeLlm(
      'Summary: I am a full stack developer with three years of experience building web applications. ' +
        'I work across React, Node.js, and TypeScript. I focus on reliable delivery and clean architecture.',
    );
    const summary = await generateProfileSummaryAnswer(makeBrain(), llm);
    expect(summary.startsWith('I am a full stack developer')).toBe(true);
    expect(summary).not.toMatch(/^Summary:/);
  });

  it('rejects too-short summary output so the caller can fall back', async () => {
    expect(await generateProfileSummaryAnswer(makeBrain(), fakeLlm('N/A'))).toBe('');
  });
});

describe('Website and Portfolio URL equivalence', () => {
  const brainWithPortfolio = makeBrain({
    portfolioUrl: 'https://mubasshir.dev',
    githubUrl: 'https://github.com/mubasshir',
    linkedinUrl: 'https://linkedin.com/in/mubasshir',
  });

  it('resolves both "Website" and "Portfolio" variants to portfolioUrl', () => {
    const variants = [
      'Website',
      'Website link',
      'Website URL',
      'Personal website',
      'Personal website link',
      'Portfolio',
      'Portfolio link',
      'Portfolio URL',
      'Online portfolio',
      'Link to your portfolio / website',
      'Website / Portfolio',
      'Portfolio / Website',
    ];

    for (const v of variants) {
      const res = matchRuleBased({ label: v, fieldType: 'text' }, brainWithPortfolio);
      expect(res.matched).toBe(true);
      expect(res.answer).toBe('https://mubasshir.dev');
    }
  });

  it('does not conflate GitHub or LinkedIn with website/portfolio', () => {
    expect(matchRuleBased({ label: 'GitHub Profile', fieldType: 'text' }, brainWithPortfolio).answer).toBe(
      'https://github.com/mubasshir',
    );
    expect(matchRuleBased({ label: 'LinkedIn Profile URL', fieldType: 'text' }, brainWithPortfolio).answer).toBe(
      'https://linkedin.com/in/mubasshir',
    );
  });

  it('answers binary portfolio/website questions favorably when portfolioUrl exists', () => {
    const res = matchRuleBased(
      { label: 'Do you have a personal website or portfolio?', fieldType: 'radio', options: ['Yes', 'No'] },
      brainWithPortfolio,
    );
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('Yes');
  });

  it('adaptAnswerToFieldFormat prepends https:// to bare domain names for url fields', () => {
    const adapted = adaptAnswerToFieldFormat('mubasshir.dev', { label: 'Website', fieldType: 'text' });
    expect(adapted.valid).toBe(true);
    expect(adapted.value).toBe('https://mubasshir.dev');
  });
});
