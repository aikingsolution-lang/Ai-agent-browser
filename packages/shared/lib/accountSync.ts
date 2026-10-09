/**
 * Account session sync with JobForm Automator.
 *
 * JobForm Automator users sign in, sign out and pay on the website. Like the JobForm Automator
 * extension, NanoBrowser receives the website's Firebase session (uid, ID token, refresh token)
 * through its content script — both products use the same Firebase project, so that session is a
 * normal NanoBrowser session. It is accepted only after the backend has verified the ID token and
 * confirmed the uid; subscription and premium status always come from the backend.
 */

import {
  authStorage,
  cloudApiSettingsStore,
  resumeWebsiteAutoLogin,
  sessionUserId,
  startAccountSession,
  type PremiumStatus,
  type UserSessionData,
} from '@extension/storage';
import { backendApiClient, type JobformPremiumStatus } from './backend-api-client';
import { JOBFORM_SIGN_IN_URL, JOBFORM_PRICING_URL } from './config';

/** Subscription as returned by GET /subscription/me (fields used here). */
export interface BackendSubscription {
  _id?: string;
  id?: string;
  status?: string;
  planCodeSnapshot?: string;
  planCode?: string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string;
  [key: string]: unknown;
}

export interface WebsiteSessionInput {
  uid: string;
  idToken: string;
  refreshToken?: string;
}

export type WebsiteSessionResult =
  | { ok: true; uid: string; clearedPreviousAccount: boolean; unchanged?: boolean }
  | { ok: false; reason: 'invalid' | 'mismatch' | 'unavailable' };

/** Session subscription summary from the backend's subscription DTO. */
export function toSessionSubscription(
  subscription: BackendSubscription | null | undefined,
): UserSessionData['subscription'] {
  if (!subscription || typeof subscription !== 'object') return null;
  return {
    id: subscription._id ?? subscription.id,
    status: String(subscription.status ?? ''),
    planCode: subscription.planCodeSnapshot ?? subscription.planCode,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    currentPeriodEnd: subscription.currentPeriodEnd ?? undefined,
  };
}

/** Validated copy of the backend's premium status (anything malformed counts as not premium). */
export function toPremiumStatus(premium: JobformPremiumStatus | null | undefined): PremiumStatus | null {
  if (!premium || typeof premium !== 'object') return null;
  const tier = premium.tier === 'Premium' || premium.tier === 'Diamond' ? premium.tier : 'Free';
  return {
    source: 'jobform-automator',
    tier,
    isPremium: tier !== 'Free' && premium.isPremium === true,
    subscriptionType: typeof premium.subscriptionType === 'string' ? premium.subscriptionType : null,
    startDate: typeof premium.startDate === 'string' ? premium.startDate : null,
    endDate: typeof premium.endDate === 'string' ? premium.endDate : null,
    expired: premium.expired === true,
    checkedAt: typeof premium.checkedAt === 'string' ? premium.checkedAt : new Date().toISOString(),
  };
}

/**
 * Whether a stored premium status is active right now. Only ever narrows what the backend said
 * (an end date passing since the last check turns it off); it can never turn premium on.
 */
export function isPremiumActive(premium: PremiumStatus | null | undefined, now = Date.now()): boolean {
  if (!premium?.isPremium) return false;
  if (!premium.endDate) return true;
  const end = Date.parse(premium.endDate);
  return Number.isNaN(end) || end > now;
}

/**
 * Keeps the local plan mirror used by the options page's "Premium Mode" in line with the backend:
 * a paid plan only once the backend reports it ACTIVE (it used to be set when checkout started).
 */
export async function mirrorPlanToLocalSettings(subscription: BackendSubscription | null | undefined): Promise<void> {
  const planCode = subscription?.planCodeSnapshot ?? subscription?.planCode;
  const paidActive = subscription?.status === 'ACTIVE' && typeof planCode === 'string' && planCode !== 'free-trial';
  const settings = await cloudApiSettingsStore.getSettings();
  if (paidActive) {
    if (settings.subscription.planId !== planCode || settings.subscription.status !== 'active') {
      // Same plan codes the checkout used to store here (starter / pro / power)
      await cloudApiSettingsStore.updateSubscription({ planId: planCode as 'pro', status: 'active' });
    }
    return;
  }
  if (settings.subscription.planId !== 'free') {
    await cloudApiSettingsStore.updateSubscription({ planId: 'free', status: 'active' });
  }
  if (settings.apiMode === 'premium') {
    await cloudApiSettingsStore.setApiMode('free');
  }
}

/**
 * Re-reads subscription and premium status from the backend for the signed-in account. The result
 * is stored only if the same account is still signed in when it arrives. Returns null when nobody
 * is signed in or the account changed meanwhile.
 */
export async function refreshAccountStatus(): Promise<{
  premium: PremiumStatus | null;
  subscription: BackendSubscription | null;
} | null> {
  const before = await authStorage.getSession();
  const uid = sessionUserId(before.user);
  if (!before.token || !uid) return null;

  const res = await backendApiClient.getSubscriptionMe();

  const after = await authStorage.getSession();
  if (!after.token || sessionUserId(after.user) !== uid) return null;

  const premium = toPremiumStatus(res.data?.premium);
  const subscription = toSessionSubscription(res.data?.subscription);
  await authStorage.setSession({ premium, subscription });
  await mirrorPlanToLocalSettings(res.data?.subscription).catch(() => undefined);
  return { premium, subscription: res.data?.subscription ?? null };
}

/** Re-reads the credit balance for the signed-in account (stored only if the account is unchanged). */
export async function refreshAccountCredits(): Promise<void> {
  const before = await authStorage.getSession();
  const uid = sessionUserId(before.user);
  if (!before.token || !uid) return;
  const res = await backendApiClient.getCreditsBalance();
  const after = await authStorage.getSession();
  if (!after.token || sessionUserId(after.user) !== uid || !res.data) return;
  await authStorage.setSession({ credits: res.data });
}

/**
 * Accepts a session handed over by the JobForm Automator website. The ID token is verified by the
 * backend (GET /auth/me) and must belong to the uid the website announced; an expired ID token is
 * refreshed first. A different account than the current one wipes the previous account's local data.
 */
export async function acceptWebsiteSession(input: WebsiteSessionInput): Promise<WebsiteSessionResult> {
  const current = await authStorage.getSession();
  if (current.token === input.idToken && sessionUserId(current.user) === input.uid) {
    return { ok: true, uid: input.uid, clearedPreviousAccount: false, unchanged: true };
  }

  let idToken = input.idToken;
  let refreshToken = input.refreshToken || '';
  let check = await backendApiClient.checkIdToken(idToken);

  if (check.status === 'expired' && refreshToken) {
    const refreshed = await backendApiClient.exchangeRefreshToken(refreshToken);
    if (refreshed.status !== 'ok') return { ok: false, reason: refreshed.status };
    if (refreshed.userId && refreshed.userId !== input.uid) return { ok: false, reason: 'mismatch' };
    idToken = refreshed.idToken;
    refreshToken = refreshed.refreshToken;
    check = await backendApiClient.checkIdToken(idToken);
  }

  if (check.status !== 'ok') return { ok: false, reason: check.status === 'unavailable' ? 'unavailable' : 'invalid' };
  if (check.user.uid !== input.uid) return { ok: false, reason: 'mismatch' };

  const user = check.user;
  const { clearedPreviousAccount } = await startAccountSession({
    token: idToken,
    refreshToken: refreshToken || null,
    user: {
      id: user.uid,
      uid: user.uid,
      _id: user.uid,
      name: user.name || user.email?.split('@')[0] || 'User',
      email: user.email || '',
      role: user.role || 'user',
      status: user.status || 'active',
    } as UserSessionData['user'],
    source: 'website',
  });

  // Subscription, premium and credits come from the backend for the new account (best effort).
  await refreshAccountStatus().catch(() => null);
  await refreshAccountCredits().catch(() => undefined);

  return { ok: true, uid: user.uid, clearedPreviousAccount };
}

function openTab(url: string): void {
  if (typeof chrome !== 'undefined' && chrome?.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/**
 * Opens JobForm Automator's sign-in page; the session reaches the extension automatically. Also
 * lifts the pause set by a NanoBrowser-only sign-out, so a website that is still signed in is used
 * again (the user asked to log in).
 */
export async function openJobformSignIn(): Promise<void> {
  await resumeWebsiteAutoLogin().catch(() => undefined);
  openTab(JOBFORM_SIGN_IN_URL);
}
export const openJobformPricing = (): void => openTab(JOBFORM_PRICING_URL);
