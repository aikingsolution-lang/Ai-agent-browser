import { z } from 'zod';

export const generateResumeSchema = z.object({
  body: z.object({
    candidateName: z.string().min(1, 'Candidate name is required'),
    candidateEmail: z.string().email('Valid email is required'),
    candidatePhone: z.string().optional(),
    currentTitle: z.string().optional(),
    skills: z.array(z.string()).default([]),
    targetKeywords: z.array(z.string()).default([]),
    jobTitle: z.string().min(1, 'Job title is required'),
    company: z.string().min(1, 'Company name is required'),
    backgroundNarrative: z.string().optional(),
  }),
});

export type GenerateResumeInput = z.infer<typeof generateResumeSchema>;

export const workExperienceItemSchema = z.object({
  id: z.string().default(() => Math.random().toString(36).substring(2, 9)),
  company: z.string().default(''),
  title: z.string().default(''),
  startMonth: z.string().default(''),
  startYear: z.string().default(''),
  endMonth: z.string().nullable().default(null),
  endYear: z.string().nullable().default(null),
  isCurrent: z.boolean().default(false),
  description: z.string().default(''),
  source: z.enum(['manual', 'resume']).default('resume'),
});

export type WorkExperienceItem = z.infer<typeof workExperienceItemSchema>;

export const parsedResumeSchema = z.object({
  fullName: z.string().default('Candidate'),
  email: z.string().default(''),
  phoneNumber: z.string().default(''),
  currentTitle: z.string().default('Software Professional'),
  skills: z.array(z.string()).default([]),
  yearsOfExperience: z.number().default(0),
  hasWorkExperience: z.boolean().default(true),
  workExperience: z.array(workExperienceItemSchema).default([]),
  education: z.string().default(''),
  college: z.string().default(''),
  cgpa: z.string().default(''),
  noticePeriod: z.string().default(''),
  workHistory: z
    .array(
      z.object({
        role: z.string().default(''),
        company: z.string().default(''),
        duration: z.string().default(''),
        highlights: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  backgroundNarrative: z.string().default(''),
  preferredLocation: z.string().default(''),
  workAuthorization: z.string().default('Authorized to work without sponsorship'),
  skillExperience: z.record(z.string(), z.number()).default({}),
  salaryExpectation: z.string().default(''),
  portfolioUrl: z.string().default(''),
  githubUrl: z.string().default(''),
  linkedinUrl: z.string().default(''),
});

export type ParsedResumeData = z.infer<typeof parsedResumeSchema>;
