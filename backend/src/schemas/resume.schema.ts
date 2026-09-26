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

export const parsedResumeSchema = z.object({
  fullName: z.string().default('Candidate'),
  email: z.string().default(''),
  phoneNumber: z.string().default(''),
  currentTitle: z.string().default('Software Professional'),
  skills: z.array(z.string()).default([]),
  yearsOfExperience: z.number().default(0),
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
