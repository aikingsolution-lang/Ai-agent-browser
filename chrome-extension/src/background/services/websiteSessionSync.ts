/**
 * Background side of the JobForm Automator website session sync (see pages/content/src/jobformWebsiteBridge.ts).
 *
 *   JOBFORM_WEBSITE_LOGIN              → verify the ID token with the backend, then start that session
 *                                        (another account's local data is wiped first)
 *   JOBFORM_WEBSITE_LOGOUT             → sign the extension out
 *   JOBFORM_WEBSITE_PAYMENT_COMPLETED  → re-read subscription / premium status from the backend for a
 *                                        while; the event itself never grants anything
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
  refreshAccountStatus,
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

/** After a payment the website confirms it server-side; premium shows up within these delays (ms). */
export const PAYMENT_RECHECK_DELAYS_MS = [0, 3_000, 7_000, 15_000, 30_000];

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

let paymentRecheckRun = 0;

async function recheckPremiumAfterPayment(delays: number[]): Promise<boolean> {
  const run = ++paymentRecheckRun;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    if (run !== paymentRecheckRun) return false; // superseded by a newer payment event
    try {
      const status = await refreshAccountStatus();
      if (!status) return false; // signed out or the account changed
      if (status.premium?.isPremium) return true;
    } catch (error) {
      logger.warning('Premium re-check after payment failed:', error);
    }
  }
  return false;
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
    case JOBFORM_WEBSITE_MESSAGES.paymentCompleted: {
      const premium = await recheckPremiumAfterPayment(options.paymentRecheckDelaysMs ?? PAYMENT_RECHECK_DELAYS_MS);
      return { ok: true, premium };
    }
    default:
      return { ok: false, reason: 'unknown' };
  }
}

/**
 * Injected into a JobForm Automator tab (must stay self-contained). Reads only the candidate
 * session: the Firebase SDK keeps it under `firebase:authUser:<apiKey>:[DEFAULT]`, while the
 * website's recruiter (HR) sign-in uses the separate `hr-app` Firebase app and is never read.
 */
export function readCandidateFirebaseSession(): { uid: string; idToken: string; refreshToken: string } | null {
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || key.indexOf('firebase:authUser:') !== 0 || key.slice(-':[DEFAULT]'.length) !== ':[DEFAULT]') {
        continue;
      }
      const user = JSON.parse(storage.getItem(key) || 'null');
      const tokens = user && user.stsTokenManager;
      const uid = user && user.uid;
      const idToken = tokens && tokens.accessToken;
      if (typeof uid === 'string' && uid && typeof idToken === 'string' && idToken) {
        return { uid, idToken, refreshToken: typeof tokens.refreshToken === 'string' ? tokens.refreshToken : '' };
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
      return { ok: false, reason: 'no-tabs' };
    }

    let reason = 'no-session-found';
    for (const tab of tabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: readCandidateFirebaseSession,
        });
        const input = parseLoginMessage(results?.[0]?.result);
        if (!input) continue;

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
