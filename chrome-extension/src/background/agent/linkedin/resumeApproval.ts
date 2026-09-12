/**
 * LinkedIn Easy Apply — Resume Approval Gate (Extension Agent Wrapper)
 */

import { resumeApprovalStore, type IPendingResumeItem, type ResumeApprovalStatus } from '@extension/storage';
import { createLogger } from '@src/background/log';
import type { IJobData } from './types';

const logger = createLogger('LinkedInResumeApproval');

export type { IPendingResumeItem, ResumeApprovalStatus };

export class ResumeApprovalGate {
  static async enqueueResumeForApproval(params: {
    jobData: IJobData;
    fileName: string;
    fileSize: number;
    base64Pdf: string;
    highlightedKeywords: string[];
  }): Promise<IPendingResumeItem> {
    logger.info(
      `[ResumeApprovalGate] Enqueued resume "${params.fileName}" for job "${params.jobData.title}" at "${params.jobData.company}". Status: PENDING_RESUME_APPROVAL`,
    );

    return resumeApprovalStore.enqueueResumeForApproval({
      jobId: params.jobData.jobId,
      jobTitle: params.jobData.title,
      company: params.jobData.company,
      location: params.jobData.location,
      fileName: params.fileName,
      fileSize: params.fileSize,
      base64Pdf: params.base64Pdf,
      highlightedKeywords: params.highlightedKeywords,
    });
  }

  static async getPendingApprovals(): Promise<IPendingResumeItem[]> {
    return resumeApprovalStore.getPendingApprovals();
  }

  static async getAllApprovals(): Promise<IPendingResumeItem[]> {
    return resumeApprovalStore.getAllApprovals();
  }

  static async approveResume(id: string): Promise<boolean> {
    return resumeApprovalStore.approveResume(id);
  }

  static async rejectResume(id: string): Promise<boolean> {
    return resumeApprovalStore.rejectResume(id);
  }

  static async getApprovedResumeForJob(jobId: string): Promise<IPendingResumeItem | null> {
    return resumeApprovalStore.getApprovedResumeForJob(jobId);
  }
}

export default ResumeApprovalGate;
