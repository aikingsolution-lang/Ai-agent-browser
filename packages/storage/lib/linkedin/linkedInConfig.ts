import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export const DEFAULT_NEGATIVE_KEYWORDS: string[] = [
  'unpaid',
  'volunteer',
  'commission only',
  'senior architect',
  'staff engineer',
  'principal engineer',
  'director',
  'vp of engineering',
  'us citizen only',
  'security clearance required',
  'c2c',
];

export interface ILinkedInAutomationConfig {
  /** Target job title / keywords to search for */
  targetJobTitle: string;
  /** Preferred location (e.g. Remote, City) */
  targetLocation: string;
  /** Minimum RAG fit score required to apply (0-100, default: 50) */
  minFitScore: number;
  /** Maximum job applications allowed per day (default: 15) */
  dailyApplicationLimit: number;
  /** Whether Dry-Run simulation mode is enabled (Default: true) */
  dryRun: boolean;
  /** Whether backend tailored PDF resume generation is required before applying */
  requireTailoredResume: boolean;
  /** Overall automation active status */
  autoApplyEnabled: boolean;
  /** Negative keywords in job titles or descriptions to skip automatically */
  negativeKeywords: string[];
  /** Companies to never apply to (blacklist) */
  blacklistedCompanies: string[];
  /** Maximum experience gap (years) allowed before skipping (default: 3) */
  maxExperienceGapYears: number;
}

export const DEFAULT_LINKEDIN_CONFIG: ILinkedInAutomationConfig = {
  targetJobTitle: 'Full Stack Engineer',
  targetLocation: 'Remote',
  minFitScore: 50,
  dailyApplicationLimit: 15,
  dryRun: true, // Default ON for user safety
  requireTailoredResume: false,
  autoApplyEnabled: false,
  negativeKeywords: [...DEFAULT_NEGATIVE_KEYWORDS],
  blacklistedCompanies: [],
  maxExperienceGapYears: 3,
};

const storage = createStorage<ILinkedInAutomationConfig>('linkedin_automation_config', DEFAULT_LINKEDIN_CONFIG, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type LinkedInConfigStorage = BaseStorage<ILinkedInAutomationConfig> & {
  getConfig: () => Promise<ILinkedInAutomationConfig>;
  updateConfig: (updates: Partial<ILinkedInAutomationConfig>) => Promise<ILinkedInAutomationConfig>;
};

export const linkedInConfigStore: LinkedInConfigStorage = {
  ...storage,

  async getConfig(): Promise<ILinkedInAutomationConfig> {
    const data = await storage.get();
    return data || DEFAULT_LINKEDIN_CONFIG;
  },

  async updateConfig(updates: Partial<ILinkedInAutomationConfig>): Promise<ILinkedInAutomationConfig> {
    const current = await this.getConfig();
    const updated: ILinkedInAutomationConfig = {
      ...current,
      ...updates,
    };
    await storage.set(updated);
    return updated;
  },
};

export default linkedInConfigStore;
