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
 * page-load sign-in keeps an existing session of the same account and is ignored after a
 * NanoBrowser-only sign-out until the user clicks "Login with JobForm Automator".
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
  isWebsiteAutoLoginPaused,
  resumeWebsiteAutoLogin,
  sessionUserId,
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

export async function handleWebsiteMessage(
  message: { type?: unknown } & Record<string, unknown>,
  options: { paymentRecheckDelaysMs?: number[] } = {},
): Promise<Record<string, unknown>> {
  switch (message?.type) {
    case JOBFORM_WEBSITE_MESSAGES.login: {
      const input = parseLoginMessage(message);
      if (!input) return { ok: false, reason: 'malformed' };
      const fromPageLoad = message.trigger === 'page-load';
      const result: WebsiteSessionResult | { ok: false; reason: 'paused' } = await enqueue(async () => {
        if (fromPageLoad) {
          if (await isWebsiteAutoLoginPaused()) return { ok: false, reason: 'paused' } as const;
          const current = await authStorage.getSession();
          if (current.token && sessionUserId(current.user) === input.uid) {
            return { ok: true, uid: input.uid, clearedPreviousAccount: false, unchanged: true } as const;
          }
        }
        return acceptWebsiteSession(input);
      });
      if (result.ok) {
        if (!result.unchanged) logger.info('Signed in from the JobForm Automator website session');
      } else if (result.reason !== 'paused') {
        logger.warning(`Website session not accepted: ${result.reason}`);
      }
      return { ...result };
    }
    case JOBFORM_WEBSITE_MESSAGES.logout: {
      const fromPageLoad = message.trigger === 'page-load';
      const signedOut = await enqueue(async () => {
        const current = await authStorage.getSession();
        if (fromPageLoad && !current.token && !current.user) {
          await resumeWebsiteAutoLogin(); // signed out on both sides: nothing to clear
          return false;
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
 * Actively checks open JobForm Automator tabs in the browser, reads their Firebase session
 * via scripting, and syncs it immediately into the extension.
 */
export async function syncSessionFromOpenJobformTabs(): Promise<{ ok: boolean; reason?: string; uid?: string }> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.scripting?.executeScript) {
      return { ok: false, reason: 'unsupported' };
    }
    const tabs = await chrome.tabs.query({
      url: ['https://www.jobformautomator.com/*', 'https://jobformautomator.com/*'],
    });
    if (!tabs || tabs.length === 0) {
      return { ok: false, reason: 'no-tabs' };
    }

    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            try {
              const storage = window.localStorage;
              let authRecord: string | null = null;
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key && key.startsWith('firebase:authUser:') && key.endsWith(':[DEFAULT]')) {
                  authRecord = storage.getItem(key);
                  break;
                }
              }
              const flag = storage.getItem('IsLogin') ?? storage.getItem('isLogin') ?? storage.getItem('is_login');
              return { authRecord, flag };
            } catch {
              return null;
            }
          },
        });

        const data = results?.[0]?.result;
        if (!data || !data.authRecord) continue;

        const flagNorm = data.flag ? data.flag.toLowerCase().trim() : null;
        if (flagNorm === 'false' || flagNorm === '0') continue;

        let user: { uid?: string; stsTokenManager?: { accessToken?: string; refreshToken?: string } } | null = null;
        try {
          user = JSON.parse(data.authRecord);
        } catch {
          continue;
        }

        const tokens = user?.stsTokenManager;
        if (
          typeof user?.uid === 'string' &&
          typeof tokens?.accessToken === 'string' &&
          typeof tokens?.refreshToken === 'string'
        ) {
          const res = await handleWebsiteMessage({
            type: JOBFORM_WEBSITE_MESSAGES.login,
            trigger: 'page-load',
            uid: user.uid,
            idToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          });
          if (res.ok) {
            logger.info(`Synced session from active JobForm Automator tab ${tab.id}`);
            return { ok: true, uid: user.uid };
          }
        }
      } catch (e) {
        logger.warning(`Failed to inspect tab ${tab.id}:`, e);
      }
    }
    return { ok: false, reason: 'no-session-found' };
  } catch (error) {
    logger.error('syncSessionFromOpenJobformTabs error:', error);
    return { ok: false, reason: 'error' };
  }
}

export function registerWebsiteSessionSync(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'SYNC_JOBFORM_SESSION') {
      syncSessionFromOpenJobformTabs()
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
    handleWebsiteMessage(message)
      .then(sendResponse)
      .catch(error => {
        logger.error('Website session message failed:', error);
        sendResponse({ ok: false, reason: 'error' });
      });
    return true;
  });
}
