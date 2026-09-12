/**
 * LinkedIn Easy Apply — Backend API Client
 *
 * Communicates with backend endpoints for:
 * 1. MongoDB JobApplication tracking & duplicate prevention
 * 2. Backend ATS-tailored PDF resume generation
 */

import { createLogger } from '@src/background/log';
import { userStore } from '@extension/storage';
import type { IJobData, JobApplicationStatus } from './types';

const logger = createLogger('LinkedInBackendClient');

const BACKEND_BASE_URL = 'http://localhost:3000/api/v1';

export interface BackendResumeResponse {
  fileName: string;
  fileSize: number;
  base64Pdf: string;
  highlightedKeywords: string[];
}

export class LinkedInBackendClient {
  /**
   * Checks if a job has already been applied to (or processed) in MongoDB.
   */
  static async checkDuplicateJob(jobId: string): Promise<boolean> {
    try {
      const userId = await userStore.getUserId();
      const res = await fetch(`${BACKEND_BASE_URL}/job-applications/check/${userId}/${jobId}`);
      if (!res.ok) return false;

      const data = await res.json();
      return Boolean(data.exists);
    } catch (err) {
      logger.warning('Backend duplicate check unavailable:', err);
      return false;
    }
  }

  /**
   * Records or updates a job application attempt in MongoDB.
   */
  static async recordJobApplication(params: {
    jobData: IJobData;
    fitScore: number;
    status: JobApplicationStatus;
    appliedAt?: Date | null;
  }): Promise<void> {
    try {
      const userId = await userStore.getUserId();
      const payload = {
        userId,
        jobId: params.jobData.jobId,
        title: params.jobData.title,
        company: params.jobData.company,
        location: params.jobData.location,
        salaryRange: params.jobData.salaryRange,
        fitScore: params.fitScore,
        status: params.status,
        appliedAt: params.appliedAt || (params.status === 'APPLIED' ? new Date() : null),
      };

      const res = await fetch(`${BACKEND_BASE_URL}/job-applications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        logger.info(
          `[BackendClient] Recorded job application "${params.jobData.title}" (${params.status}) in MongoDB.`,
        );
      }
    } catch (err) {
      logger.warning('Failed to record job application in backend MongoDB:', err);
    }
  }

  /**
   * Requests a tailored PDF resume from the backend resume generator service.
   */
  static async requestTailoredResume(params: {
    candidateName: string;
    candidateEmail: string;
    candidatePhone?: string;
    currentTitle?: string;
    skills: string[];
    targetKeywords: string[];
    jobTitle: string;
    company: string;
    backgroundNarrative?: string;
  }): Promise<BackendResumeResponse | null> {
    try {
      const res = await fetch(`${BACKEND_BASE_URL}/resume/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        logger.warning(`Backend resume generation failed with HTTP ${res.status}`);
        return null;
      }

      const json = await res.json();
      return json.data as BackendResumeResponse;
    } catch (err) {
      logger.warning('Backend resume generator endpoint unavailable:', err);
      return null;
    }
  }
}
