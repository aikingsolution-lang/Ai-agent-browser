import { describe, it, expect } from 'vitest';
import {
  extractResumeFocusTags,
  extractJobFocusTags,
  scoreResumeForJob,
  selectBestMatchingResume,
  type IResumeProfileItem,
} from '@extension/storage';

describe('Resume Best Match Auto-Select System', () => {
  const frontendResume: IResumeProfileItem = {
    id: 'res_frontend_1',
    fileName: 'John_Doe_Frontend_React.pdf',
    uploadedAt: Date.now() - 100000,
    focusTags: ['frontend', 'react', 'nextjs', 'typescript', 'tailwind'],
    rawText: `John Doe - Frontend Engineer
Experienced in React.js, Next.js, Redux, TypeScript, Tailwind CSS, responsive web apps, HTML5, JavaScript.
Built scalable customer-facing web applications.`,
    extractedSkills: ['React', 'TypeScript', 'Next.js', 'Tailwind CSS', 'Redux'],
    targetRole: 'Frontend Developer',
    isDefault: true,
  };

  const backendResume: IResumeProfileItem = {
    id: 'res_backend_2',
    fileName: 'John_Doe_Python_Backend.pdf',
    uploadedAt: Date.now() - 50000,
    focusTags: ['backend', 'python', 'fastapi', 'docker', 'postgresql', 'microservices'],
    rawText: `John Doe - Backend Software Engineer
Specialized in Python, FastAPI, Django, PostgreSQL, Docker, Kubernetes, REST APIs, Microservices architecture, Redis.
Architected high-throughput backend services and distributed databases.`,
    extractedSkills: ['Python', 'FastAPI', 'PostgreSQL', 'Docker', 'Kubernetes'],
    targetRole: 'Backend Engineer',
    isDefault: false,
  };

  const mlResume: IResumeProfileItem = {
    id: 'res_ml_3',
    fileName: 'John_Doe_AI_MachineLearning.pdf',
    uploadedAt: Date.now(),
    focusTags: ['ml-ai', 'python', 'pytorch', 'tensorflow', 'llm', 'langchain'],
    rawText: `John Doe - Machine Learning & AI Specialist
Expertise in Deep Learning, PyTorch, LLMs, LangChain, Hugging Face, NLP, Computer Vision, Python.
Fine-tuned LLMs and deployed AI model inference pipelines on AWS Bedrock.`,
    extractedSkills: ['PyTorch', 'Python', 'LLM', 'LangChain', 'TensorFlow'],
    targetRole: 'AI / Machine Learning Engineer',
    isDefault: false,
  };

  describe('Tag Extraction', () => {
    it('extracts frontend domain and tech tags from resume content', () => {
      const tags = extractResumeFocusTags(frontendResume.rawText, frontendResume.extractedSkills, 'Frontend Developer');
      expect(tags).toContain('frontend');
      expect(tags).toContain('react');
      expect(tags).toContain('typescript');
    });

    it('extracts backend domain and tech tags from resume content', () => {
      const tags = extractResumeFocusTags(backendResume.rawText, backendResume.extractedSkills, 'Backend Engineer');
      expect(tags).toContain('backend');
      expect(tags).toContain('python');
      expect(tags).toContain('docker');
    });

    it('extracts job focus tags from job titles and descriptions', () => {
      const jobTags = extractJobFocusTags(
        'Senior React / Next.js Frontend Developer',
        'We are looking for a frontend developer proficient in React, Next.js, and TypeScript with Tailwind.',
      );
      expect(jobTags).toContain('frontend');
      expect(jobTags).toContain('react');
      expect(jobTags).toContain('nextjs');
    });
  });

  describe('Resume Scoring for Jobs', () => {
    it('scores frontend resume significantly higher for a React frontend job', () => {
      const jobTitle = 'React.js Frontend Engineer';
      const jobDesc =
        'Seeking an experienced React developer to build rich user interfaces with TypeScript and Tailwind.';

      const feScore = scoreResumeForJob(frontendResume, jobTitle, jobDesc);
      const beScore = scoreResumeForJob(backendResume, jobTitle, jobDesc);

      expect(feScore.score).toBeGreaterThan(60);
      expect(feScore.score).toBeGreaterThan(beScore.score);
      expect(feScore.matchedTags).toContain('frontend');
      expect(feScore.matchedTags).toContain('react');
    });

    it('scores backend resume significantly higher for a Python backend job', () => {
      const jobTitle = 'Senior Python Backend Engineer';
      const jobDesc =
        'Seeking a backend developer with deep experience in Python, FastAPI, Docker, and PostgreSQL microservices.';

      const feScore = scoreResumeForJob(frontendResume, jobTitle, jobDesc);
      const beScore = scoreResumeForJob(backendResume, jobTitle, jobDesc);

      expect(beScore.score).toBeGreaterThan(60);
      expect(beScore.score).toBeGreaterThan(feScore.score);
      expect(beScore.matchedTags).toContain('backend');
      expect(beScore.matchedTags).toContain('python');
    });

    it('scores ML resume highest for an AI / LLM job', () => {
      const jobTitle = 'AI & LLM Application Engineer';
      const jobDesc = 'Looking for an AI engineer experienced with PyTorch, LLMs, and LangChain.';

      const mlScore = scoreResumeForJob(mlResume, jobTitle, jobDesc);
      const feScore = scoreResumeForJob(frontendResume, jobTitle, jobDesc);

      expect(mlScore.score).toBeGreaterThan(feScore.score);
      expect(mlScore.matchedTags).toContain('ml-ai');
      expect(mlScore.matchedTags).toContain('pytorch');
    });
  });

  describe('selectBestMatchingResume', () => {
    const allResumes = [frontendResume, backendResume, mlResume];

    it('auto-selects frontend resume for React / UI jobs', () => {
      const result = selectBestMatchingResume(allResumes, 'Frontend Developer (React / Next.js)');
      expect(result.bestResume?.id).toBe(frontendResume.id);
      expect(result.bestResume?.fileName).toBe(frontendResume.fileName);
      expect(result.matchedTags.length).toBeGreaterThan(0);
      expect(result.allScores.length).toBe(3);
    });

    it('auto-selects backend resume for Python / API jobs', () => {
      const result = selectBestMatchingResume(allResumes, 'Backend Developer (Python / PostgreSQL)');
      expect(result.bestResume?.id).toBe(backendResume.id);
      expect(result.bestResume?.fileName).toBe(backendResume.fileName);
    });

    it('auto-selects ML resume for Machine Learning / AI jobs', () => {
      const result = selectBestMatchingResume(allResumes, 'Machine Learning Engineer - NLP & LLM');
      expect(result.bestResume?.id).toBe(mlResume.id);
      expect(result.bestResume?.fileName).toBe(mlResume.fileName);
    });

    it('gracefully falls back to default resume when job has zero matching tags', () => {
      const result = selectBestMatchingResume(allResumes, 'Registered Nurse - Healthcare');
      expect(result.bestResume?.id).toBe(frontendResume.id); // default resume
    });

    it('handles empty resume list safely', () => {
      const result = selectBestMatchingResume([], 'Software Engineer');
      expect(result.bestResume).toBeNull();
      expect(result.score).toBe(0);
    });
  });
});
