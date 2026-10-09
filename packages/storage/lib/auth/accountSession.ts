/**
 * Account isolation for the extension's local data.
 *
 * Besides the auth session, chrome.storage.local holds data that belongs to the signed-in account:
 * the Career Brain (resume profile), job queue / processed jobs / runner state, tailored-resume
 * approvals, dry-run records, LinkedIn search settings, chat history and pending credit refunds.
 * The Career Brain is also synced to the backend under the signed-in uid, so one account's local
 * data must never be shown to, or uploaded as, another account.
 *
 * The uid that owns the local data is recorded. Every sign-in (website or extension) goes through
 * startAccountSession(): when a different account signs in, the previous account's data is wiped
 * before the new session is stored. Signing out removes the session only, so the same account gets
 * its local profile back when it signs in again (the Career Brain is not restored from the backend).
 */

import { authStorage, AUTH_SESSION_STORAGE_KEY, sessionUserId, type UserSessionData } from './authStorage';

export const ACCOUNT_OWNER_STORAGE_KEY = 'nanobrowser_account_owner';

/** chrome.storage.local keys that hold one account's data. */
export const ACCOUNT_DATA_STORAGE_KEYS: readonly string[] = [
  'linkedin_career_brain',
  'linkedin_daily_quota',
  'linkedin_processed_jobs',
  'linkedin_job_queue',
  'job_runner_state',
  'linkedin_pending_resume_approvals',
  'linkedin_queue_safety',
  'linkedin_dry_run_records',
  'linkedin_automation_config',
  'nanobrowser_pending_refunds',
  'chat_sessions_meta',
];

/** Per-session chat keys (chat_messages_<id>, chat_agent_step_<id>). */
const ACCOUNT_DATA_KEY_PREFIXES: readonly string[] = ['chat_messages_', 'chat_agent_step_'];

function localArea(): chrome.storage.LocalStorageArea {
  const area = globalThis.chrome?.storage?.local;
  if (!area) throw new Error('chrome.storage.local is not available');
  return area;
}

/** Removes every account-scoped key (stores fall back to their defaults) and the auth session. */
export async function clearAccountData(): Promise<void> {
  const area = localArea();
  const all = await area.get(null);
  const keys = Object.keys(all ?? {}).filter(
    key => ACCOUNT_DATA_STORAGE_KEYS.includes(key) || ACCOUNT_DATA_KEY_PREFIXES.some(prefix => key.startsWith(prefix)),
  );
  if (keys.length > 0) await area.remove(keys);
  await authStorage.clearSession();
  await area.remove(ACCOUNT_OWNER_STORAGE_KEY);
}

/**
 * Makes `uid` the owner of the local account data, wiping the previous owner's data first when it
 * is a different account. Installs from before this change have no owner recorded: the uid of the
 * stored session (if any) is taken as the owner, otherwise the data is adopted by `uid`.
 * Returns true when another account's data was removed.
 */
export async function claimAccountData(uid: string): Promise<boolean> {
  if (!uid) throw new Error('claimAccountData requires a uid');
  const area = localArea();
  const stored = await area.get([ACCOUNT_OWNER_STORAGE_KEY, AUTH_SESSION_STORAGE_KEY]);
  const recordedOwner =
    typeof stored?.[ACCOUNT_OWNER_STORAGE_KEY] === 'string' ? stored[ACCOUNT_OWNER_STORAGE_KEY] : null;
  const owner = recordedOwner ?? sessionUserId(stored?.[AUTH_SESSION_STORAGE_KEY]?.user) ?? uid;

  let cleared = false;
  if (owner !== uid) {
    await clearAccountData();
    cleared = true;
  }
  await area.set({ [ACCOUNT_OWNER_STORAGE_KEY]: uid });
  return cleared;
}

/**
 * Starts the session for a verified sign-in: claims the local data for this account (wiping another
 * account's) and replaces the stored session, so nothing — subscription, credits, premium — carries
 * over from a previous session.
 */
export async function startAccountSession(
  session: Partial<UserSessionData>,
): Promise<{ clearedPreviousAccount: boolean }> {
  const uid = sessionUserId(session.user);
  if (!session.token || !uid) throw new Error('A session needs an ID token and a user id');
  const clearedPreviousAccount = await claimAccountData(uid);
  await authStorage.replaceSession(session);
  await localArea().remove(WEBSITE_AUTO_LOGIN_PAUSED_KEY);
  return { clearedPreviousAccount };
}

/**
 * Set when the user signs out of NanoBrowser while staying signed in on the JobForm Automator
 * website: the website session found when a website page loads is then not used to sign back in,
 * until the user clicks "Login with JobForm Automator" or signs in on the website again.
 */
export const WEBSITE_AUTO_LOGIN_PAUSED_KEY = 'nanobrowser_website_autologin_paused';

export async function isWebsiteAutoLoginPaused(): Promise<boolean> {
  const stored = await localArea().get(WEBSITE_AUTO_LOGIN_PAUSED_KEY);
  return stored?.[WEBSITE_AUTO_LOGIN_PAUSED_KEY] === true;
}

export async function resumeWebsiteAutoLogin(): Promise<void> {
  await localArea().remove(WEBSITE_AUTO_LOGIN_PAUSED_KEY);
}

/**
 * Signs out locally: removes the session (tokens, user, subscription, premium, credits).
 * `pauseWebsiteAutoLogin` — the user signed out of NanoBrowser only (the website stays signed in).
 */
export async function endAccountSession(options: { pauseWebsiteAutoLogin?: boolean } = {}): Promise<void> {
  await authStorage.clearSession();
  if (options.pauseWebsiteAutoLogin) {
    await localArea().set({ [WEBSITE_AUTO_LOGIN_PAUSED_KEY]: true });
  } else {
    await localArea().remove(WEBSITE_AUTO_LOGIN_PAUSED_KEY);
  }
}
