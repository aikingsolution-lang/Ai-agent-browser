// chrome-extension/src/background/agent/platforms/linkedin/linkedinAdapter.ts
import type {
  IPlatformAdapter,
  IJobQueueItem,
  IPlatformSession,
  IApplicationResult,
  IPlatformExecutionContext,
  SupportedPlatform,
} from '../types';
import { sanitizeRoleSearchQuery } from '@extension/storage';
import { createLogger } from '@src/background/log';

const logger = createLogger('LinkedInAdapter');

export class LinkedInAdapter implements IPlatformAdapter {
  public readonly platformId: SupportedPlatform = 'linkedin';
  public readonly displayName: string = 'LinkedIn';
  public readonly domainMatches: string[] = ['linkedin.com'];

  public isMatchingUrl(url: string): boolean {
    if (!url) return false;
    return url.toLowerCase().includes('linkedin.com');
  }

  public buildSearchUrl(
    role: string,
    location: string,
    candidateName?: string | (string | undefined | null)[],
  ): string {
    const cleanRole = sanitizeRoleSearchQuery(role, candidateName, 'Software Engineer');
    const sanitizedRole = cleanRole
      .replace(/[/\\|]+/g, ' OR ')
      .replace(/[,+;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const searchParams = new URLSearchParams({
      keywords: sanitizedRole,
      f_AL: 'true', // Easy Apply filter
      sortBy: 'R', // Most relevant
    });

    if (location) {
      searchParams.set('location', location);
    }

    return `https://www.linkedin.com/jobs/search/?${searchParams.toString()}`;
  }

  public async validateSession(page: any): Promise<IPlatformSession> {
    try {
      const topCardCheck = await page.extractJobTopCardContext(5000);
      return {
        isLoggedIn: !topCardCheck.isLoginWall,
        isLoginWall: topCardCheck.isLoginWall,
      };
    } catch {
      return { isLoggedIn: true, isLoginWall: false };
    }
  }

  public async extractJobCards(page: any): Promise<IJobQueueItem[]> {
    try {
      const rawCards = await page.extractJobListCards(5000);
      return (rawCards || []).map((card: any) => ({
        platform: 'linkedin' as const,
        jobId: card.jobId,
        title: card.title,
        company: card.company,
        url: card.url,
        isQuickApply: true,
      }));
    } catch (err) {
      logger.error('[LinkedInAdapter] Failed to extract job cards:', err);
      return [];
    }
  }

  public async applyToJob(job: IJobQueueItem, context: IPlatformExecutionContext): Promise<IApplicationResult> {
    // LinkedIn execution is delegated to DedicatedJobRunner's granular modal loop
    return { status: 'applied', creditsUsed: 1 };
  }
}

export const linkedinAdapter = new LinkedInAdapter();
