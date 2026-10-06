import { authStorage } from '../auth/authStorage';

export type CopilotTier = 'free' | 'pro' | 'premium';

export interface CopilotAccessResult {
  /** Whether the user can access Career Copilot features */
  allowed: boolean;
  /** Active tier of the user */
  tier: CopilotTier;
  /** Human-readable status reason */
  reason?: string;
  /** Whether beta mode is currently granting access for testing */
  isBetaUnlocked: boolean;
}

/**
 * Checks whether the current user is eligible for Career Copilot (PRO) features.
 * Designed with future subscription monetization in mind.
 */
export async function checkCopilotAccess(): Promise<CopilotAccessResult> {
  try {
    const session = await authStorage.getSession();
    const plan = (session?.subscription?.planCode || '').toLowerCase();
    const status = (session?.subscription?.status || '').toLowerCase();
    const isSubscriber = status === 'active' && (plan === 'pro' || plan === 'premium');

    // BETA / DEV FLAG: Currently set to true so the user can fully test & experience
    // all futuristic Copilot features during development.
    // In production, when the subscription payment gateway is finalized,
    // setting this to false will automatically gate free users to an upgrade modal!
    const isBetaUnlocked = true;

    return {
      allowed: isSubscriber || isBetaUnlocked,
      tier: isSubscriber ? 'pro' : 'free',
      isBetaUnlocked,
      reason: isSubscriber
        ? 'Active Pro Subscription'
        : isBetaUnlocked
          ? 'Unlocked for Beta Testing'
          : 'Subscription Required',
    };
  } catch {
    return {
      allowed: true,
      tier: 'free',
      isBetaUnlocked: true,
      reason: 'Fallback Access',
    };
  }
}
