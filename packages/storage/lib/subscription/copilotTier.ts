import { authStorage } from '../auth/authStorage';

export type CopilotTier = 'free' | 'starter' | 'pro' | 'power';

export interface PlanLimitDetails {
  planCode: string;
  planDisplayName: string;
  maxDailyApplications: number;
  isFreeTrial: boolean;
  tier: CopilotTier;
}

/**
 * Daily application limits per plan — a mirror of the backend's ApplicationQuotaService, which
 * counts and enforces them (these values only drive display and settings caps):
 * - Free / free trial: 10 per day
 * - JobForm Automator Premium or Diamond (verified on the website): 300 per day
 * - Starter 50, Pro 100, Power 500 per day
 * A user with several plans gets the highest limit.
 */
export const PLAN_DAILY_LIMITS: Record<string, PlanLimitDetails> = {
  'free-trial': {
    planCode: 'free-trial',
    planDisplayName: 'Free Trial',
    maxDailyApplications: 10,
    isFreeTrial: true,
    tier: 'free',
  },
  free: {
    planCode: 'free',
    planDisplayName: 'Free Plan',
    maxDailyApplications: 10,
    isFreeTrial: true,
    tier: 'free',
  },
  starter: {
    planCode: 'starter',
    planDisplayName: 'Starter Plan',
    maxDailyApplications: 50,
    isFreeTrial: false,
    tier: 'starter',
  },
  pro: {
    planCode: 'pro',
    planDisplayName: 'Pro Plan',
    maxDailyApplications: 100,
    isFreeTrial: false,
    tier: 'pro',
  },
  power: {
    planCode: 'power',
    planDisplayName: 'Power Enterprise Plan',
    maxDailyApplications: 500,
    isFreeTrial: false,
    tier: 'power',
  },
  premium: {
    planCode: 'premium',
    planDisplayName: 'Premium',
    maxDailyApplications: 300,
    isFreeTrial: false,
    tier: 'pro',
  },
  diamond: {
    planCode: 'diamond',
    planDisplayName: 'Diamond',
    maxDailyApplications: 300,
    isFreeTrial: false,
    tier: 'power',
  },
};

/**
 * The user's plan as stored in the session (both values come from the backend). The backend
 * remains the authority on the limit actually enforced.
 */
export async function getPlanLimitDetails(): Promise<PlanLimitDetails> {
  try {
    const session = await authStorage.getSession();
    const candidates: PlanLimitDetails[] = [PLAN_DAILY_LIMITS.free];

    const rawPlan = (session?.subscription?.planCode || '').toLowerCase().trim();
    const status = (session?.subscription?.status || '').toLowerCase().trim();
    if (status === 'active' && rawPlan && PLAN_DAILY_LIMITS[rawPlan]) {
      candidates.push(PLAN_DAILY_LIMITS[rawPlan]);
    }

    const premiumTier = (session?.premium?.tier || '').toLowerCase();
    if (session?.premium?.isPremium && !session?.premium?.expired) {
      candidates.push(premiumTier === 'diamond' ? PLAN_DAILY_LIMITS.diamond : PLAN_DAILY_LIMITS.premium);
    }

    return candidates.reduce((best, plan) => (plan.maxDailyApplications > best.maxDailyApplications ? plan : best));
  } catch {
    return PLAN_DAILY_LIMITS.free;
  }
}

export interface CopilotAccessResult {
  /** Whether the user can access Career Copilot features */
  allowed: boolean;
  /** Active tier of the user */
  tier: CopilotTier;
  /** Human-readable status reason */
  reason?: string;
  /** Whether beta mode is currently granting access for testing */
  isBetaUnlocked: boolean;
  /** Daily application cap enforced by the active plan */
  dailyCap: number;
}

/**
 * Checks whether the current user is eligible for Career Copilot (PRO) features.
 * Designed with subscription monetization and daily application caps in mind.
 */
export async function checkCopilotAccess(): Promise<CopilotAccessResult> {
  try {
    const planDetails = await getPlanLimitDetails();
    const isSubscriber = !planDetails.isFreeTrial;

    // BETA / DEV FLAG: Currently set to true so the user can fully test & experience
    // all futuristic Copilot features during development.
    const isBetaUnlocked = true;

    return {
      allowed: isSubscriber || isBetaUnlocked,
      tier: planDetails.tier,
      isBetaUnlocked,
      dailyCap: planDetails.maxDailyApplications,
      reason: isSubscriber
        ? `Active ${planDetails.planDisplayName}`
        : isBetaUnlocked
          ? 'Unlocked for Beta Testing'
          : 'Subscription Required',
    };
  } catch {
    return {
      allowed: true,
      tier: 'free',
      isBetaUnlocked: true,
      dailyCap: 15,
      reason: 'Fallback Access',
    };
  }
}
