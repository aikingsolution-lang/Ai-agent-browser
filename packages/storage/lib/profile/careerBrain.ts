import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * Career Brain Data Model
 *
 * Stores rich background context for answering LinkedIn screening questions
 * and computing RAG-based job fit scores.
 */
export interface ICareerBrain {
  /** Freeform narrative describing user's background, past roles, strengths, and expertise */
  backgroundNarrative: string;
  /** List of top skills and technologies */
  skills: string[];
  /** Total years of relevant professional experience */
  yearsOfExperience: number;
  /** Current or most recent job title */
  currentTitle: string;
  /** Availability / notice period (e.g., 'Immediate', '2 weeks', '30 days') */
  noticePeriod: string;
  /** Work authorization status (e.g., 'US Citizen', 'Authorized without sponsorship', 'Citizen of India') */
  workAuthorization: string;
  /** Target / minimum salary expectations */
  salaryExpectation: string;
  /** Preferred work locations or remote preference */
  preferredLocation: string;
  /** Primary contact phone number */
  phoneNumber: string;
  /** Primary contact email address */
  email: string;
  /** Saved Q&A key-value pairs for common custom screening questions */
  customAnswers: Record<string, string>;
  /** Name of the active resume on file */
  resumeFileName?: string;
  /** Timestamp of last update */
  updatedAt: number;
}

export const DEFAULT_CAREER_BRAIN: ICareerBrain = {
  backgroundNarrative: '',
  skills: [],
  yearsOfExperience: 0,
  currentTitle: '',
  noticePeriod: 'Immediate',
  workAuthorization: 'Authorized to work without sponsorship',
  salaryExpectation: '',
  preferredLocation: 'Remote',
  phoneNumber: '',
  email: '',
  customAnswers: {},
  updatedAt: Date.now(),
};

const storage = createStorage<ICareerBrain>('linkedin_career_brain', DEFAULT_CAREER_BRAIN, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type CareerBrainStorage = BaseStorage<ICareerBrain> & {
  getCareerBrain: () => Promise<ICareerBrain>;
  updateCareerBrain: (updates: Partial<ICareerBrain>) => Promise<ICareerBrain>;
  setCustomAnswer: (questionKey: string, answer: string) => Promise<void>;
};

export const careerBrainStore: CareerBrainStorage = {
  ...storage,

  async getCareerBrain(): Promise<ICareerBrain> {
    const data = await storage.get();
    return data || DEFAULT_CAREER_BRAIN;
  },

  async updateCareerBrain(updates: Partial<ICareerBrain>): Promise<ICareerBrain> {
    const current = await this.getCareerBrain();
    const updated: ICareerBrain = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    await storage.set(updated);
    return updated;
  },

  async setCustomAnswer(questionKey: string, answer: string): Promise<void> {
    const current = await this.getCareerBrain();
    const customAnswers = { ...current.customAnswers, [questionKey]: answer };
    await this.updateCareerBrain({ customAnswers });
  },
};

export default careerBrainStore;
