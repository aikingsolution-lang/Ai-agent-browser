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
 * Standard Daily Application Quota Mapping based on Subscription:
 * - Free Trial: 15 applications / day (Safety protected, non-negotiable for trial accounts)
 * - Starter: 35 applications / day
 * - Pro: 50 applications / day
 * - Power / Enterprise: 75 applications / day
 */
export const PLAN_DAILY_LIMITS: Record<string, PlanLimitDetails> = {
  'free-trial': {
    planCode: 'free-trial',
    planDisplayName: 'Free Trial',
    maxDailyApplications: 15,
    isFreeTrial: true,
    tier: 'free',
  },
  free: {
    planCode: 'free',
    planDisplayName: 'Free Plan',
    maxDailyApplications: 15,
    isFreeTrial: true,
    tier: 'free',
  },
  starter: {
    planCode: 'starter',
    planDisplayName: 'Starter Plan',
    maxDailyApplications: 35,
    isFreeTrial: false,
    tier: 'starter',
  },
  pro: {
    planCode: 'pro',
    planDisplayName: 'Pro Plan',
    maxDailyApplications: 50,
    isFreeTrial: false,
    tier: 'pro',
  },
  power: {
    planCode: 'power',
    planDisplayName: 'Power Enterprise Plan',
    maxDailyApplications: 75,
    isFreeTrial: false,
    tier: 'power',
  },
};

/**
 * Resolves the user's active plan limit details based on the current authenticated session.
 * If user has no active subscription or is on free-trial, strictly limits to 15 apps/day.
 */
export async function getPlanLimitDetails(): Promise<PlanLimitDetails> {
  try {
    const session = await authStorage.getSession();
    const rawPlan = (session?.subscription?.planCode || '').toLowerCase().trim();
    const status = (session?.subscription?.status || '').toLowerCase().trim();

    // Check if user has an active paid subscription
    if (status === 'active' && rawPlan && PLAN_DAILY_LIMITS[rawPlan]) {
      return PLAN_DAILY_LIMITS[rawPlan];
    }

    // Check legacy / external premium tier if present
    const premiumTier = (session?.premium?.tier || '').toLowerCase();
    if (session?.premium?.isPremium && !session?.premium?.expired) {
      if (premiumTier === 'diamond') return PLAN_DAILY_LIMITS.power;
      if (premiumTier === 'premium') return PLAN_DAILY_LIMITS.pro;
    }

    // Default: Free Trial (15/day safe default)
    return PLAN_DAILY_LIMITS['free-trial'];
  } catch {
    return PLAN_DAILY_LIMITS['free-trial'];
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
