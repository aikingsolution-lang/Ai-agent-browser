/**
 * LinkedIn Easy Apply — Resume Approval Storage
 *
 * Shared storage layer for holding generated resumes in PENDING_RESUME_APPROVAL
 * state until user approves via Options UI.
 */

import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';

export type ResumeApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface IPendingResumeItem {
  id: string;
  jobId: string;
  jobTitle: string;
  company: string;
  location?: string;
  fileName: string;
  fileSize: number;
  base64Pdf: string;
  highlightedKeywords: string[];
  status: ResumeApprovalStatus;
  createdAt: number;
  reviewedAt: number | null;
}

const STORAGE_KEY = 'linkedin_pending_resume_approvals';

const pendingStorage = createStorage<IPendingResumeItem[]>(STORAGE_KEY, [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export class ResumeApprovalStorage {
  /**
   * Enqueues a newly generated resume for user review.
   */
  static async enqueueResumeForApproval(params: {
    jobId: string;
    jobTitle: string;
    company: string;
    location?: string;
    fileName: string;
    fileSize: number;
    base64Pdf: string;
    highlightedKeywords: string[];
  }): Promise<IPendingResumeItem> {
    const item: IPendingResumeItem = {
      id: crypto.randomUUID(),
      jobId: params.jobId,
      jobTitle: params.jobTitle,
      company: params.company,
      location: params.location,
      fileName: params.fileName,
      fileSize: params.fileSize,
      base64Pdf: params.base64Pdf,
      highlightedKeywords: params.highlightedKeywords,
      status: 'PENDING',
      createdAt: Date.now(),
      reviewedAt: null,
    };

    await pendingStorage.set(prev => [item, ...(prev || [])]);
    return item;
  }

  /**
   * Retrieves all pending approval items.
   */
  static async getPendingApprovals(): Promise<IPendingResumeItem[]> {
    const all = (await pendingStorage.get()) || [];
    return all.filter(item => item.status === 'PENDING');
  }

  /**
   * Retrieves all approval items (history).
   */
  static async getAllApprovals(): Promise<IPendingResumeItem[]> {
    return (await pendingStorage.get()) || [];
  }

  /**
   * Approves a specific generated resume for application use.
   */
  static async approveResume(id: string): Promise<boolean> {
    let updated = false;
    await pendingStorage.set(prev =>
      (prev || []).map(item => {
        if (item.id === id) {
          updated = true;
          return { ...item, status: 'APPROVED', reviewedAt: Date.now() };
        }
        return item;
      }),
    );
    return updated;
  }

  /**
   * Rejects a generated resume.
   */
  static async rejectResume(id: string): Promise<boolean> {
    let updated = false;
    await pendingStorage.set(prev =>
      (prev || []).map(item => {
        if (item.id === id) {
          updated = true;
          return { ...item, status: 'REJECTED', reviewedAt: Date.now() };
        }
        return item;
      }),
    );
    return updated;
  }

  /**
   * Checks if an approved tailored resume exists for a given jobId.
   */
  static async getApprovedResumeForJob(jobId: string): Promise<IPendingResumeItem | null> {
    const all = (await pendingStorage.get()) || [];
    return all.find(item => item.jobId === jobId && item.status === 'APPROVED') || null;
  }
}

export const resumeApprovalStore = ResumeApprovalStorage;
export default resumeApprovalStore;
