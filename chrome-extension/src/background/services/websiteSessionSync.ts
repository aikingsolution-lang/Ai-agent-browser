/**
 * Background side of the JobForm Automator website session sync (see pages/content/src/jobformWebsiteBridge.ts).
 *
 *   JOBFORM_WEBSITE_LOGIN              → verify the ID token with the backend, then start that session
 *                                        (another account's local data is wiped first)
 *   JOBFORM_WEBSITE_LOGOUT             → sign the extension out
 *   JOBFORM_WEBSITE_PAYMENT_COMPLETED  → the website's `paymentSuccessfull` { uid, plan } (the JobForm
 *                                        Automator extension's `paymentProcessed`): re-read the plan
 *                                        from the backend until it reports the paid plan, then credits
 *                                        and today's quota; the event itself never grants anything
 *
 * `trigger: 'event'` — the website announced it (sign-in pages, settings sign-out).
 * `trigger: 'page-load'` — the website's stored sign-in state when one of its pages loaded (covers a
 * session that already existed and the navbar sign-out, which the website does not announce). A
 * page-load sign-in keeps an existing session of the same account, never switches to another
 * account (and so never wipes local data), and is ignored after an extension-only sign-out until
 * the user clicks "Login with JobForm Automator". A page-load sign-out is only trusted from the
 * host (www or bare domain) that supplied the session, since the two keep separate sign-in state.
 *
 * Messages are accepted only from this extension's content script running in the top frame of a
 * JobForm Automator website tab, and are handled one at a time.
 */

import {
  acceptWebsiteSession,
  isJobformWebsiteOrigin,
  originOf,
  planCovers,
  refreshAccountCredits,
  refreshAccountQuota,
  refreshAccountStatus,
  saveJobformPaymentEvent,
  type JobformPaymentOutcome,
  type JobformPlanId,
  type WebsiteSessionResult,
} from '@extension/shared';
import {
  authStorage,
  endAccountSession,
  getAccountDataOwner,
  getWebsiteSessionOrigin,
  isWebsiteAutoLoginPaused,
  resumeWebsiteAutoLogin,
  sessionUserId,
  setWebsiteSessionOrigin,
} from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('WebsiteSessionSync');

export const JOBFORM_WEBSITE_MESSAGES = {
  login: 'JOBFORM_WEBSITE_LOGIN',
  logout: 'JOBFORM_WEBSITE_LOGOUT',
  paymentCompleted: 'JOBFORM_WEBSITE_PAYMENT_COMPLETED',
} as const;

const HANDLED_TYPES = new Set<string>(Object.values(JOBFORM_WEBSITE_MESSAGES));

/**
 * The website fires `paymentSuccessfull` before its server has verified the payment
 * (/api/payment/confirm), so the plan is re-read at these delays (ms). No gap is longer than 20 s,
 * so the service worker stays alive between checks; the plans views keep checking after that.
 */
export const PAYMENT_RECHECK_DELAYS_MS = [0, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000, 80_000, 100_000, 120_000];

const MAX_TOKEN_LENGTH = 8192;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const UID_PATTERN = /^[^\s/.#$[\]]{1,128}$/;

export function isTrustedWebsiteSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab || sender.frameId !== 0) return false;
  const urlOrigin = originOf(sender.url);
  if (!isJobformWebsiteOrigin(urlOrigin)) return false;
  // sender.origin (Chrome 80+) is set by the browser, not the page
  return sender.origin === undefined || isJobformWebsiteOrigin(sender.origin);
}

export function parseLoginMessage(message: unknown): { uid: string; idToken: string; refreshToken: string } | null {
  if (!message || typeof message !== 'object') return null;
  const { uid, idToken, refreshToken } = message as Record<string, unknown>;
  if (typeof uid !== 'string' || !UID_PATTERN.test(uid)) return null;
  if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN_LENGTH || !JWT_PATTERN.test(idToken)) return null;
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || refreshToken.length > MAX_TOKEN_LENGTH))
    return null;
  return { uid, idToken, refreshToken: refreshToken || '' };
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs website events strictly in order (a sign-in racing a sign-out must not interleave). */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The website's payment event: `paymentSuccessfull` { uid, plan }, forwarded as is (the JobForm
 * Automator extension's `paymentProcessed`). Both fields are only hints: `uid` says which account
 * paid, `plan` which plan to wait for (as there, no plan means Premium).
 */
export function parsePaymentMessage(message: unknown): { uid: string | null; plan: JobformPlanId } {
  const { uid, plan } = (message && typeof message === 'object' ? message : {}) as Record<string, unknown>;
  return {
    uid: typeof uid === 'string' && UID_PATTERN.test(uid) ? uid : null,
    plan: typeof plan === 'string' && plan.trim().toLowerCase() === 'diamond' ? 'Diamond' : 'Premium',
  };
}

let paymentRecheckRun = 0;

type PaymentRecheckOutcome = Exclude<JobformPaymentOutcome, 'checking'> | 'superseded';

/**
 * Re-reads the plan from the backend until it covers the paid plan (an upgrade from Premium waits
 * for Diamond), then refreshes credits and today's quota — the unlock the JobForm Automator extension
 * does locally on `paymentProcessed`, here only once the backend confirms it. A payment by another
 * account than the one signed in here changes nothing.
 */
async function recheckPremiumAfterPayment(
  payment: { uid: string | null; plan: JobformPlanId },
  delays: number[],
): Promise<{ outcome: PaymentRecheckOutcome; premium: boolean }> {
  const run = ++paymentRecheckRun;
  let premium = false;
  let signedIn = false;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    if (run !== paymentRecheckRun) return { outcome: 'superseded', premium }; // a newer payment event
    const current = await authStorage.getSession();
    const uid = current.token ? sessionUserId(current.user) : null;
    if (!uid) continue; // the website's sign-in may still be on its way
    signedIn = true;
    if (payment.uid && payment.uid !== uid) return { outcome: 'other-account', premium: false };
    try {
      const status = await refreshAccountStatus();
      if (!status) continue; // the account changed meanwhile: checked again next round
      premium = status.premium?.isPremium === true;
      if (planCovers(status.premium, payment.plan)) {
        await refreshAccountCredits().catch(() => undefined);
        await refreshAccountQuota().catch(() => undefined);
        return { outcome: 'active', premium };
      }
    } catch (error) {
      logger.warning('Premium re-check after payment failed:', error);
    }
  }
  return { outcome: signedIn ? 'pending' : 'signed-out', premium };
}

async function handlePaymentEvent(message: unknown, delays: number[]): Promise<Record<string, unknown>> {
  const payment = parsePaymentMessage(message);
  const record = (outcome: JobformPaymentOutcome) =>
    saveJobformPaymentEvent({ plan: payment.plan, outcome, at: Date.now() }).catch(() => undefined);
  await record('checking');
  const result = await recheckPremiumAfterPayment(payment, delays);
  if (result.outcome !== 'superseded') await record(result.outcome);
  if (result.outcome === 'active') logger.info(`JobForm Automator ${payment.plan} confirmed after the website payment`);
  else if (result.outcome === 'other-account') logger.warning('Website payment was made by another account');
  return { ok: true, ...result };
}

/**
 * Only an explicit sign-in on the website (the `userLoggedIn` event) may switch the extension to
 * another account. Automatic syncs adopt a website session only when it belongs to the account
 * that owns the local data (or nothing does), so they never switch accounts or wipe local data.
 */
async function ownedByAnotherAccount(uid: string): Promise<boolean> {
  const owner = await getAccountDataOwner();
  return owner !== null && owner !== uid;
}

type LoginResult = WebsiteSessionResult | { ok: false; reason: 'paused' | 'different-account' };

/**
 * Stored-state reports (`page-load`, `focus`, `storage`) are automatic; only the website's own
 * announcements (`trigger: 'event'`, or no trigger) are explicit user actions.
 */
const isAutomaticReport = (message: Record<string, unknown>) =>
  message.trigger !== undefined && message.trigger !== 'event';

export async function handleWebsiteMessage(
  message: { type?: unknown } & Record<string, unknown>,
  options: { paymentRecheckDelaysMs?: number[]; senderOrigin?: string | null } = {},
): Promise<Record<string, unknown>> {
  const senderOrigin = options.senderOrigin ?? null;
  switch (message?.type) {
    case JOBFORM_WEBSITE_MESSAGES.login: {
      const input = parseLoginMessage(message);
      if (!input) return { ok: false, reason: 'malformed' };
      const automatic = isAutomaticReport(message);
      const result: LoginResult = await enqueue(async () => {
        if (automatic) {
          if (await isWebsiteAutoLoginPaused()) return { ok: false, reason: 'paused' } as const;
          const current = await authStorage.getSession();
          if (current.token && sessionUserId(current.user) === input.uid) {
            if (senderOrigin && !(await getWebsiteSessionOrigin())) await setWebsiteSessionOrigin(senderOrigin);
            return { ok: true, uid: input.uid, clearedPreviousAccount: false, unchanged: true } as const;
          }
          if (await ownedByAnotherAccount(input.uid)) return { ok: false, reason: 'different-account' } as const;
        }
        const accepted = await acceptWebsiteSession(input);
        if (accepted.ok && senderOrigin) await setWebsiteSessionOrigin(senderOrigin);
        return accepted;
      });
      if (result.ok) {
        if (!result.unchanged) logger.info('Signed in from the JobForm Automator website session');
      } else if (result.reason !== 'paused') {
        logger.warning(`Website session not accepted: ${result.reason}`);
      }
      return { ...result };
    }
    case JOBFORM_WEBSITE_MESSAGES.logout: {
      const automatic = isAutomaticReport(message);
      const signedOut = await enqueue(async () => {
        const current = await authStorage.getSession();
        if (automatic && !current.token && !current.user) {
          await resumeWebsiteAutoLogin(); // signed out on both sides: nothing to clear
          return false;
        }
        if (automatic && senderOrigin) {
          // A page on the other host (www vs bare domain) has its own, unrelated sign-in state.
          const sessionOrigin = await getWebsiteSessionOrigin();
          if (sessionOrigin && sessionOrigin !== senderOrigin) return false;
        }
        await endAccountSession();
        return true;
      });
      if (signedOut) logger.info('Signed out: JobForm Automator website sign-out');
      return { ok: true };
    }
    case JOBFORM_WEBSITE_MESSAGES.paymentCompleted:
      return handlePaymentEvent(message, options.paymentRecheckDelaysMs ?? PAYMENT_RECHECK_DELAYS_MS);
    default:
      return { ok: false, reason: 'unknown' };
  }
}

/**
 * Injected into a JobForm Automator tab (must stay self-contained). Reads only the candidate
 * session: the Firebase SDK keeps it under `firebase:authUser:<apiKey>:[DEFAULT]`, while the
 * website's recruiter (HR) sign-in uses the separate `hr-app` Firebase app and is never read.
 *
 * Also checks the `IsLogin` / `isLogin` candidate flag and the `UID` shortcut key that the
 * JobForm Automator website writes on sign-in, so a session is found even when only one of the
 * two indicators is present (e.g. SPA navigation that cleared localStorage partially).
 */
export function readCandidateFirebaseSession(): { uid: string; idToken: string; refreshToken: string } | null {
  try {
    const storage = window.localStorage;

    // Quick candidate-presence check: at least one of these flags must be set.
    // The website writes `IsLogin = "true"` and often `UID = <uid>` on sign-in.
    const loginFlag = storage.getItem('IsLogin') ?? storage.getItem('isLogin') ?? storage.getItem('is_login');
    const uidShortcut = storage.getItem('UID') ?? storage.getItem('uid') ?? storage.getItem('candidate');
    const flagNormalized = loginFlag ? loginFlag.toLowerCase().trim() : null;
    const hasLoginFlag = flagNormalized === 'true' || flagNormalized === '1';
    const hasCandidatePresence = hasLoginFlag || Boolean(uidShortcut);

    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      // Accept both :[DEFAULT] and :[DEFAULT]-type suffixes in case the Firebase SDK version varies.
      if (
        !key ||
        key.indexOf('firebase:authUser:') !== 0 ||
        (!key.endsWith(':[DEFAULT]') && !key.includes(':[DEFAULT]'))
      ) {
        continue;
      }
      // Skip HR/recruiter app sessions (key contains '-hr-app' or similar)
      if (key.includes('-hr-') || key.includes(':hr-app')) continue;

      const user = JSON.parse(storage.getItem(key) || 'null');
      const tokens = user && user.stsTokenManager;
      const uid = (user && (user.uid || user.id)) as string | undefined;
      const idToken =
        (tokens && (tokens.accessToken || tokens.idToken)) || (user && (user.accessToken || user.idToken));

      if (typeof uid === 'string' && uid && typeof idToken === 'string' && idToken) {
        // If neither candidate flag is set, only trust this token if the UID matches the shortcut
        if (!hasCandidatePresence && uidShortcut && uidShortcut !== uid) continue;
        const refreshToken =
          (typeof tokens?.refreshToken === 'string' ? tokens.refreshToken : '') ||
          (typeof user?.refreshToken === 'string' ? user.refreshToken : '');
        return { uid, idToken, refreshToken };
      }
    }
  } catch {
    // Storage unavailable or not a Firebase user record
  }
  return null;
}

/**
 * "Login with JobForm Automator": reads the candidate session from open JobForm Automator tabs
 * and signs in with it after the backend has verified it. Like the automatic page-load sync, it
 * never switches to another account: a session of an account other than the one that owns the
 * local data is reported as `different-account`, and the user signs in on the website instead.
 */
export async function syncSessionFromOpenJobformTabs(
  options: { interactive?: boolean } = {},
): Promise<{ ok: boolean; reason?: string; uid?: string }> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.scripting?.executeScript) {
      return { ok: false, reason: 'unsupported' };
    }
    // Only a Login click lifts the pause left by an extension-only sign-out; an automatic check
    // (e.g. the sign-in view opening) must not sign the user straight back in.
    if (options.interactive) {
      await resumeWebsiteAutoLogin().catch(() => undefined);
    } else if (await isWebsiteAutoLoginPaused()) {
      return { ok: false, reason: 'paused' };
    }

    const allTabs = await chrome.tabs.query({});
    const tabs = (allTabs || []).filter(tab => tab.id && isJobformWebsiteOrigin(originOf(tab.url)));
    if (tabs.length === 0) {
      logger.info('[syncSession] No open JobForm Automator tabs found — open the website and try again');
      return { ok: false, reason: 'no-tabs' };
    }

    logger.info(`[syncSession] Checking ${tabs.length} JobForm Automator tab(s) for a signed-in session…`);
    let reason = 'no-session-found';
    for (const tab of tabs) {
      try {
        logger.info(`[syncSession] Reading localStorage from tab ${tab.id} (${originOf(tab.url)})`);
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: readCandidateFirebaseSession,
        });
        const rawResult = results?.[0]?.result;
        if (!rawResult) {
          logger.info(
            `[syncSession] Tab ${tab.id}: no Firebase candidate session in localStorage (not signed in on the website)`,
          );
          continue;
        }
        const input = parseLoginMessage(rawResult);
        if (!input) {
          logger.warning(
            `[syncSession] Tab ${tab.id}: session data found but failed validation (uid or idToken format rejected)`,
          );
          continue;
        }
        logger.info(`[syncSession] Tab ${tab.id}: session found — verifying with backend…`);

        const res: LoginResult = await enqueue(async () => {
          if (await ownedByAnotherAccount(input.uid)) return { ok: false, reason: 'different-account' } as const;
          const accepted = await acceptWebsiteSession(input);
          const tabOrigin = originOf(tab.url);
          if (accepted.ok && tabOrigin) await setWebsiteSessionOrigin(tabOrigin);
          return accepted;
        });

        if (res.ok) {
          logger.info(`Signed in from the JobForm Automator session in tab ${tab.id}`);
          return { ok: true, uid: input.uid };
        }
        reason = res.reason;
        logger.warning(`Website session from tab ${tab.id} not accepted: ${res.reason}`);
      } catch (e) {
        logger.warning(`Failed to inspect tab ${tab.id}:`, e);
      }
    }
    return { ok: false, reason };
  } catch (error) {
    logger.error('syncSessionFromOpenJobformTabs error:', error);
    return { ok: false, reason: 'error' };
  }
}

/** SYNC_JOBFORM_SESSION may only come from the extension's own pages (side panel, options). */
export function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)
  );
}

export function registerWebsiteSessionSync(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'SYNC_JOBFORM_SESSION') {
      if (!isExtensionPageSender(sender)) {
        logger.warning('Ignored SYNC_JOBFORM_SESSION from an untrusted sender');
        sendResponse({ ok: false, reason: 'untrusted-sender' });
        return false;
      }
      syncSessionFromOpenJobformTabs({ interactive: message.interactive === true })
        .then(sendResponse)
        .catch(error => {
          logger.error('SYNC_JOBFORM_SESSION failed:', error);
          sendResponse({ ok: false, reason: 'error' });
        });
      return true;
    }
    if (!message || typeof message.type !== 'string' || !HANDLED_TYPES.has(message.type)) return false;
    if (!isTrustedWebsiteSender(sender)) {
      logger.warning(`Ignored ${message.type} from an untrusted sender`);
      sendResponse({ ok: false, reason: 'untrusted-sender' });
      return false;
    }
    handleWebsiteMessage(message, { senderOrigin: originOf(sender.url) })
      .then(sendResponse)
      .catch(error => {
        logger.error('Website session message failed:', error);
        sendResponse({ ok: false, reason: 'error' });
      });
    return true;
  });
}
