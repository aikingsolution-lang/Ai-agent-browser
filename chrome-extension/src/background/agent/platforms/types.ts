// chrome-extension/src/background/agent/platforms/types.ts
import type { ICareerBrain } from '@extension/storage';
import type BrowserContext from '../../browser/context';
import type Page from '../../browser/page';

export type SupportedPlatform = 'linkedin' | 'naukri' | 'indeed';

export interface IJobQueueItem {
  platform: SupportedPlatform;
  jobId: string;
  title: string;
  company: string;
  url: string;
  location?: string;
  experience?: string;
  salary?: string;
  isQuickApply?: boolean;
  descriptionSnippet?: string;
}

export interface IPlatformSession {
  isLoggedIn: boolean;
  userName?: string;
  isLoginWall: boolean;
  loginUrl?: string;
}

export interface IApplicationResult {
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
  creditsUsed?: number;
  modalOpened?: boolean;
}

export interface IPlatformExecutionContext {
  page: Page;
  browserContext: BrowserContext;
  careerBrain: ICareerBrain;
  portToSend?: chrome.runtime.Port | null;
  onLiveActivity?: (activity: {
    jobId: string;
    url: string;
    title: string;
    company: string;
    status: 'applied' | 'skipped' | 'failed' | 'running' | 'modal_opened' | 'modal_failed' | 'needs_verification';
    reason?: string;
    creditsUsed?: number;
  }) => void;
  signal?: AbortSignal;
  runId: string;
  scopedLLM?: any;
}

export interface IPlatformAdapter {
  readonly platformId: SupportedPlatform;
  readonly displayName: string;
  readonly domainMatches: string[];

  isMatchingUrl(url: string): boolean;
  buildSearchUrl(role: string, location: string, ...args: any[]): string;
  validateSession(page: Page): Promise<IPlatformSession>;
  extractJobCards(page: Page): Promise<IJobQueueItem[]>;
  applyToJob(job: IJobQueueItem, context: IPlatformExecutionContext): Promise<IApplicationResult>;
}
