/**
 * JobForm Automator website → NanoBrowser session bridge (content script side).
 *
 * The JobForm Automator website announces sign-in, sign-out and payments with DOM events — the same
 * events the JobForm Automator extension listens to:
 *   userLoggedIn        detail: { uid, idToken, refreshToken }   (sign-in page, Google sign-in)
 *   onLogout            (settings pages, account deletion)
 *   paymentSuccessfull  detail: { uid, plan }                    (checkout)
 *
 * The website does not announce a session that already exists (e.g. signed in earlier, now on the
 * home page) and its navbar "Logout" announces nothing, so when a website page loads the bridge also
 * reports the website's stored sign-in state (see readWebsiteSessionState).
 *
 * Everything is reported only from the top frame of the website's own origins to the background,
 * which checks the sender again, verifies the session with the backend and reads premium status from
 * the backend (the payment event is only a hint to re-check; its contents are ignored).
 */

// Keep in sync with JOBFORM_WEBSITE_ORIGINS in packages/shared/lib/config.ts (the background
// re-checks every message against that list).
const JOBFORM_WEBSITE_ORIGINS = ['https://www.jobformautomator.com', 'https://jobformautomator.com'];

export const JOBFORM_WEBSITE_MESSAGES = {
  login: 'JOBFORM_WEBSITE_LOGIN',
  logout: 'JOBFORM_WEBSITE_LOGOUT',
  paymentCompleted: 'JOBFORM_WEBSITE_PAYMENT_COMPLETED',
} as const;

/** Set by the website (localStorage) once a candidate is signed in and their profile exists. */
const WEBSITE_LOGIN_FLAG = 'IsLogin';
/**
 * The website's Firebase candidate session, kept by the Firebase SDK (browserLocalPersistence) under
 * `firebase:authUser:<apiKey>:[DEFAULT]`. The website's recruiter (HR) session uses another app name.
 */
const FIREBASE_AUTH_USER_PREFIX = 'firebase:authUser:';
const FIREBASE_DEFAULT_APP_SUFFIX = ':[DEFAULT]';

export type WebsiteSessionState =
  | { state: 'signed-in'; uid: string; idToken: string; refreshToken: string }
  | { state: 'signed-out' }
  | { state: 'unknown' };

/** The part of `localStorage` used here (a plain object can stand in for it in tests). */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

/**
 * Reads the website's sign-in state from its localStorage:
 *   signed-in  — candidate flag set and a Firebase session with tokens (the backend verifies them);
 *   signed-out — neither the flag nor a Firebase session (e.g. after the navbar "Logout");
 *   unknown    — anything in between (recruiter-only session, partial state): nothing is done.
 */
export function readWebsiteSessionState(storage: KeyValueStorage): WebsiteSessionState {
  let loginFlag: string | null = null;
  let authRecord: string | null = null;
  try {
    loginFlag = storage.getItem(WEBSITE_LOGIN_FLAG) ?? storage.getItem('isLogin') ?? storage.getItem('is_login');
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && key.startsWith(FIREBASE_AUTH_USER_PREFIX) && key.endsWith(FIREBASE_DEFAULT_APP_SUFFIX)) {
        authRecord = storage.getItem(key);
        break;
      }
    }
  } catch {
    return { state: 'unknown' };
  }

  if (loginFlag === null && authRecord === null) return { state: 'signed-out' };
  const flagNormalized = loginFlag ? loginFlag.toLowerCase().trim() : null;
  const isLoginTrue = flagNormalized === 'true' || flagNormalized === '1';
  // Also check if UID is present in storage (another candidate indicator used by JobForm)
  const hasCandidateFlag = isLoginTrue || Boolean(storage.getItem('UID') || storage.getItem('candidate'));
  if (!hasCandidateFlag || !authRecord) return { state: 'unknown' };

  try {
    const user = JSON.parse(authRecord);
    const tokens = user?.stsTokenManager;
    const uid = user?.uid || user?.id;
    const idToken = tokens?.accessToken || user?.accessToken || user?.idToken;
    const refreshToken = tokens?.refreshToken || user?.refreshToken || '';
    if (typeof uid === 'string' && uid && typeof idToken === 'string' && idToken) {
      return { state: 'signed-in', uid, idToken, refreshToken };
    }
  } catch {
    // Not a Firebase user record
  }
  return { state: 'unknown' };
}

function send(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(message).catch(() => {
      // Background unavailable (extension reloading); the next page load reports the state again.
    });
  } catch {
    // Extension context invalidated (extension updated/removed while the page was open)
  }
}

/** Any frame of the JobForm Automator website (the bridge itself only runs in the top frame). */
export function isJobformWebsitePage(): boolean {
  return JOBFORM_WEBSITE_ORIGINS.includes(window.location.origin);
}

// Shared by every injection of this content script in the page (same isolated world), so a second
// injection never registers the listeners twice.
const STARTED_FLAG = '__nanobrowserJobformBridgeStarted';

export function initJobformWebsiteBridge(): void {
  if (window.top !== window) return;
  if (!isJobformWebsitePage()) return;
  const scope = window as unknown as Record<string, boolean>;
  if (scope[STARTED_FLAG]) return;
  scope[STARTED_FLAG] = true;

  const reportStoredSession = (trigger: 'page-load' | 'storage' | 'focus') => {
    const stored = readWebsiteSessionState(window.localStorage);
    if (stored.state === 'signed-in') {
      send({
        type: JOBFORM_WEBSITE_MESSAGES.login,
        trigger,
        uid: stored.uid,
        idToken: stored.idToken,
        refreshToken: stored.refreshToken,
      });
    } else if (stored.state === 'signed-out') {
      send({ type: JOBFORM_WEBSITE_MESSAGES.logout, trigger });
    }
  };

  document.addEventListener('userLoggedIn', event => {
    const detail = (event as CustomEvent).detail;
    if (!detail || typeof detail !== 'object') return;
    const { uid, idToken, refreshToken } = detail as Record<string, unknown>;
    if (typeof uid !== 'string' || typeof idToken !== 'string' || !uid || !idToken) return;
    send({
      type: JOBFORM_WEBSITE_MESSAGES.login,
      trigger: 'event',
      uid,
      idToken,
      refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    });
  });

  document.addEventListener('onLogout', () => {
    send({ type: JOBFORM_WEBSITE_MESSAGES.logout, trigger: 'event' });
  });

  document.addEventListener('paymentSuccessfull', () => {
    send({ type: JOBFORM_WEBSITE_MESSAGES.paymentCompleted });
  });

  // Cross-tab storage updates
  window.addEventListener('storage', () => {
    reportStoredSession('storage');
  });

  // When user returns to this tab
  window.addEventListener('focus', () => {
    reportStoredSession('focus');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reportStoredSession('focus');
    }
  });

  // Listen for sync queries from the extension background or side-panel
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request?.type === 'REQUEST_JOBFORM_SESSION') {
        const stored = readWebsiteSessionState(window.localStorage);
        if (stored.state === 'signed-in') {
          reportStoredSession('page-load');
          sendResponse({ ok: true, session: stored });
        } else {
          sendResponse({ ok: false, state: stored.state });
        }
        return true;
      }
      return false;
    });
  }

  // Initial check at document_start
  reportStoredSession('page-load');

  // Follow-up checks after DOM loads and short delays for async Firebase init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => reportStoredSession('page-load'), { once: true });
  }
  setTimeout(() => reportStoredSession('page-load'), 1000);
  setTimeout(() => reportStoredSession('page-load'), 3000);
}
