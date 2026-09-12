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
