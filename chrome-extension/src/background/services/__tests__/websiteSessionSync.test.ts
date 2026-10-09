/**
 * JobForm Automator website ↔ extension session sync: sender checks, backend verification, account
 * isolation, sign-out, token refresh and server-only premium status. chrome.storage.local and the
 * network (backend + Firebase Secure Token API) are faked; the real extension modules run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const data: Record<string, any> = {};
  const listeners: Array<(changes: Record<string, any>, area: string) => void> = [];
  const clone = (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const emit = (changes: Record<string, any>) => listeners.forEach(listener => listener(changes, 'local'));
  const local = {
    async get(keys?: string | string[] | null) {
      if (keys === null || keys === undefined) return clone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, any> = {};
      for (const key of list) if (key in data) out[key] = clone(data[key]);
      return out;
    },
    async set(items: Record<string, any>) {
      const changes: Record<string, any> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data[key], newValue: clone(value) };
        data[key] = clone(value);
      }
      emit(changes);
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, any> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in data) {
          changes[key] = { oldValue: data[key] };
          delete data[key];
        }
      }
      emit(changes);
    },
    onChanged: { addListener: (listener: any) => listeners.push(listener), removeListener: () => undefined },
  };
  (globalThis as any).chrome = {
    runtime: { id: 'nanobrowser-extension-id', onMessage: { addListener: () => undefined }, getURL: (p: string) => p },
    storage: {
      local,
      sync: local,
      session: { ...local, setAccessLevel: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
    tabs: { create: () => undefined },
  };
  return { data, reset: () => Object.keys(data).forEach(key => delete data[key]) };
});

import {
  BACKEND_API_URL,
  backendApiClient,
  isPremiumActive,
  openJobformSignIn,
  refreshAccountStatus,
} from '@extension/shared';
import {
  authStorage,
  careerBrainStore,
  cloudApiSettingsStore,
  endAccountSession,
  isWebsiteAutoLoginPaused,
} from '@extension/storage';
import { readWebsiteSessionState, type KeyValueStorage } from '../../../../../pages/content/src/jobformWebsiteBridge';
import {
  handleWebsiteMessage,
  isTrustedWebsiteSender,
  JOBFORM_WEBSITE_MESSAGES,
  parseLoginMessage,
} from '../websiteSessionSync';

// ── Fake backend (verifies tokens like Firebase Admin) + Firebase Secure Token API ────────────────
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);
const idToken = (uid: string, ttlSec = 3600) =>
  `${b64url({ alg: 'RS256' })}.${b64url({ user_id: uid, exp: nowSec() + ttlSec })}.sig`;

interface FakeUser {
  email: string;
  name: string;
}
const backend = {
  users: new Map<string, FakeUser>(),
  refreshTokens: new Map<string, string>(), // refresh token → uid
  payments: new Map<string, { tier: 'Premium' | 'Diamond'; endDate: string }>(),
  subscriptionMeCalls: 0,
  meCalls: 0,
  online: true,
  secureTokenOnline: true,
};

function premiumFor(uid: string) {
  const payment = backend.payments.get(uid);
  const active = payment && Date.parse(payment.endDate) > Date.now();
  return {
    source: 'jobform-automator',
    tier: active ? payment!.tier : 'Free',
    isPremium: Boolean(active),
    subscriptionType: payment?.tier ?? null,
    startDate: null,
    endDate: payment?.endDate ?? null,
    expired: Boolean(payment && !active),
    checkedAt: new Date().toISOString(),
  };
}

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function authenticate(headers: any): { uid: string } | Response {
  const header = headers?.Authorization ?? headers?.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (token.split('.')[2] !== 'sig' || !backend.users.has(payload.user_id)) throw new Error('bad');
    if (payload.exp <= nowSec()) return json(401, { success: false, error: { code: 'TOKEN_EXPIRED' } });
    return { uid: payload.user_id };
  } catch {
    return json(401, { success: false, error: { code: 'INVALID_TOKEN' } });
  }
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url.startsWith('https://securetoken.googleapis.com/')) {
    if (!backend.secureTokenOnline) throw new TypeError('Failed to fetch');
    const refreshToken = new URLSearchParams(String(init.body)).get('refresh_token') ?? '';
    const uid = backend.refreshTokens.get(refreshToken);
    if (!uid) return json(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
    return json(200, { id_token: idToken(uid), refresh_token: refreshToken, user_id: uid });
  }
  if (!url.startsWith(BACKEND_API_URL) || !backend.online) throw new TypeError('Failed to fetch');
  const path = url.slice(BACKEND_API_URL.length);
  if (path === '/auth/refresh') return json(503, { success: false });
  if (path === '/auth/logout') return json(200, { success: true });
  const auth = authenticate(init.headers);
  if (auth instanceof Response) return auth;
  const user = backend.users.get(auth.uid)!;
  if (path === '/auth/me') {
    backend.meCalls++;
    return json(200, {
      success: true,
      data: { user: { uid: auth.uid, _id: auth.uid, ...user, role: 'user', status: 'active' } },
    });
  }
  if (path === '/subscription/me') {
    backend.subscriptionMeCalls++;
    return json(200, {
      success: true,
      data: {
        subscription: { _id: `sub_${auth.uid}`, status: 'TRIALING', planCodeSnapshot: 'free-trial' },
        premium: premiumFor(auth.uid),
      },
    });
  }
  if (path === '/credits/balance') {
    return json(200, {
      success: true,
      data: { allocatedCredits: 100, usedCredits: 0, remainingCredits: auth.uid === 'userA' ? 70 : 100 },
    });
  }
  return json(404, { success: false });
}) as typeof fetch;

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────
const WEBSITE_TAB = { id: 7 } as chrome.tabs.Tab;
const websiteSender = (overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({
  id: 'nanobrowser-extension-id',
  tab: WEBSITE_TAB,
  frameId: 0,
  url: 'https://www.jobformautomator.com/sign-in',
  origin: 'https://www.jobformautomator.com',
  ...overrides,
});

const login = (uid: string, token = idToken(uid), refreshToken = `refresh-${uid}`) =>
  handleWebsiteMessage({ type: JOBFORM_WEBSITE_MESSAGES.login, uid, idToken: token, refreshToken });

const session = () => authStorage.getSession();
const uidOf = (s: any) => s?.user?.uid ?? null;

beforeEach(async () => {
  fake.reset();
  backend.users = new Map([
    ['userA', { email: 'a@example.com', name: 'Asha A' }],
    ['userB', { email: 'b@example.com', name: 'Bo B' }],
  ]);
  backend.refreshTokens = new Map([
    ['refresh-userA', 'userA'],
    ['refresh-userB', 'userB'],
  ]);
  backend.payments = new Map();
  backend.subscriptionMeCalls = 0;
  backend.meCalls = 0;
  backend.online = true;
  backend.secureTokenOnline = true;
});

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────
describe('website messages are accepted only from the JobForm Automator website', () => {
  it('accepts the top frame of the website origins', () => {
    expect(isTrustedWebsiteSender(websiteSender())).toBe(true);
    expect(
      isTrustedWebsiteSender(
        websiteSender({ url: 'https://jobformautomator.com/dashboard', origin: 'https://jobformautomator.com' }),
      ),
    ).toBe(true);
  });

  it.each([
    ['another site', { url: 'https://evil.example/sign-in', origin: 'https://evil.example' }],
    [
      'a look-alike host',
      { url: 'https://jobformautomator.com.evil.example/', origin: 'https://jobformautomator.com.evil.example' },
    ],
    ['plain http', { url: 'http://www.jobformautomator.com/sign-in', origin: 'http://www.jobformautomator.com' }],
    ['an iframe', { frameId: 3 }],
    ['a non-tab context', { tab: undefined }],
    ['another extension', { id: 'other-extension' }],
    ['a mismatching browser-reported origin', { origin: 'https://evil.example' }],
  ])('rejects %s', (_label, overrides) => {
    expect(isTrustedWebsiteSender(websiteSender(overrides as any))).toBe(false);
  });

  it('rejects malformed login messages', () => {
    expect(parseLoginMessage({ uid: 'userA', idToken: idToken('userA'), refreshToken: 'r' })).not.toBeNull();
    expect(parseLoginMessage({ uid: '', idToken: idToken('userA') })).toBeNull();
    expect(parseLoginMessage({ uid: 'a/b', idToken: idToken('userA') })).toBeNull();
    expect(parseLoginMessage({ uid: 'userA', idToken: 'not a jwt' })).toBeNull();
    expect(parseLoginMessage({ uid: 'userA', idToken: 42 })).toBeNull();
    expect(parseLoginMessage({ uid: 'userA', idToken: idToken('userA'), refreshToken: { x: 1 } })).toBeNull();
  });
});

describe('scenario 1/2: website sign-in is recognised; signed-out users are blocked', () => {
  it('signed out: no token is available for backend features', async () => {
    expect((await session()).token).toBeNull();
    expect(await backendApiClient.getFreshToken()).toBeNull();
  });

  it('a session verified by the backend becomes the extension session (subscription, premium, credits from the backend)', async () => {
    backend.payments.set('userA', { tier: 'Premium', endDate: new Date(Date.now() + 86_400_000).toISOString() });
    const result = await login('userA');
    expect(result).toMatchObject({ ok: true, uid: 'userA' });

    const s = await session();
    expect(uidOf(s)).toBe('userA');
    expect(s.user).toMatchObject({ email: 'a@example.com', name: 'Asha A' });
    expect(s.source).toBe('website');
    expect(s.refreshToken).toBe('refresh-userA');
    expect(s.premium).toMatchObject({ tier: 'Premium', isPremium: true });
    expect(s.subscription).toMatchObject({ status: 'TRIALING', planCode: 'free-trial' });
    expect(s.credits?.remainingCredits).toBe(70);
    expect(await backendApiClient.getFreshToken()).toBe(s.token);
  });

  it('the same session announced again (every website visit) is a no-op', async () => {
    const token = idToken('userA');
    await login('userA', token);
    const calls = backend.subscriptionMeCalls;
    expect(await login('userA', token)).toMatchObject({ ok: true, unchanged: true });
    expect(backend.subscriptionMeCalls).toBe(calls);
  });
});

describe('scenario 5: expired or invalid tokens are handled safely', () => {
  it('an invalid / forged ID token is rejected and the current session is kept', async () => {
    await login('userA');
    const forged = `${b64url({ alg: 'none' })}.${b64url({ user_id: 'userB', exp: nowSec() + 3600 })}.forged`;
    expect(await login('userB', forged)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(uidOf(await session())).toBe('userA');
  });

  it('a valid token for a different uid than announced is rejected', async () => {
    expect(await login('userA', idToken('userB'))).toMatchObject({ ok: false, reason: 'mismatch' });
    expect((await session()).token).toBeNull();
  });

  it('an expired ID token is refreshed with the website refresh token before it is accepted', async () => {
    const result = await login('userA', idToken('userA', -60));
    expect(result).toMatchObject({ ok: true, uid: 'userA' });
    const s = await session();
    expect(s.token).not.toBe(idToken('userA', -60));
    expect(await backendApiClient.checkIdToken(s.token!)).toMatchObject({ status: 'ok' });
  });

  it('an expired ID token with a revoked refresh token is rejected', async () => {
    backend.refreshTokens.delete('refresh-userA');
    expect(await login('userA', idToken('userA', -60))).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await session()).token).toBeNull();
  });

  it('backend unreachable: nothing is stored (no unverified session)', async () => {
    backend.online = false;
    expect(await login('userA')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect((await session()).token).toBeNull();
  });

  it('browser restart with an expired stored token: refreshed on first use', async () => {
    await login('userA');
    await authStorage.setSession({ token: idToken('userA', -10) });
    const fresh = await backendApiClient.getFreshToken();
    expect(fresh).toBeTruthy();
    expect(await backendApiClient.checkIdToken(fresh!)).toMatchObject({ status: 'ok' });
    expect((await session()).token).toBe(fresh);
  });

  it('a refresh token revoked on the server ends the session', async () => {
    await login('userA');
    await authStorage.setSession({ token: idToken('userA', -10) });
    backend.refreshTokens.delete('refresh-userA');
    expect(await backendApiClient.getFreshToken()).toBeNull();
    const s = await session();
    expect(s.token).toBeNull();
    expect(s.user).toBeNull();
  });

  it('offline during refresh: the session is kept for a later retry', async () => {
    await login('userA');
    await authStorage.setSession({ token: idToken('userA', -10) });
    backend.secureTokenOnline = false;
    backend.online = false;
    expect(await backendApiClient.refreshAccessToken()).toBeNull();
    expect(uidOf(await session())).toBe('userA');
    expect((await session()).refreshToken).toBe('refresh-userA');
  });

  it('a refresh that yields another account’s token ends the session', async () => {
    await login('userA');
    backend.refreshTokens.set('refresh-userA', 'userB'); // corrupted / swapped refresh token
    await authStorage.setSession({ token: idToken('userA', -10) });
    expect(await backendApiClient.refreshAccessToken()).toBeNull();
    expect((await session()).token).toBeNull();
  });

  it('an API client instance never keeps a token after a sign-out made elsewhere', async () => {
    await login('userA');
    await backendApiClient.ensureToken();
    expect(backendApiClient.getToken()).toBeTruthy();
    await endAccountSession(); // e.g. the side panel signed out
    await backendApiClient.ensureToken();
    expect(backendApiClient.getToken()).toBeNull();
  });
});

describe('scenario 3/4: sign-out on the website or in the extension', () => {
  it('website sign-out clears the extension session', async () => {
    await login('userA');
    expect(await handleWebsiteMessage({ type: JOBFORM_WEBSITE_MESSAGES.logout })).toMatchObject({ ok: true });
    const s = await session();
    expect(s).toMatchObject({
      token: null,
      refreshToken: null,
      user: null,
      premium: null,
      credits: null,
      subscription: null,
    });
    expect(await backendApiClient.getFreshToken()).toBeNull();
  });

  it('extension sign-out clears the session', async () => {
    await login('userA');
    await endAccountSession();
    expect((await session()).token).toBeNull();
  });

  it('sign-in and sign-out events are applied in order', async () => {
    const [first, second] = await Promise.all([
      login('userA'),
      handleWebsiteMessage({ type: JOBFORM_WEBSITE_MESSAGES.logout }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await session()).token).toBeNull();
  });
});

describe('scenario 9: switching accounts never leaks data', () => {
  async function seedAccountData() {
    await careerBrainStore.set(prev => ({ ...prev, fullName: 'Asha A', email: 'a@example.com' }));
    await chrome.storage.local.set({
      linkedin_processed_jobs: { records: [{ jobId: 'j1' }] },
      chat_sessions_meta: [{ id: 's1' }],
      chat_messages_s1: [{ content: 'my resume details' }],
      nanobrowser_pending_refunds: ['run-a'],
      llm_providers: { openai: { apiKey: 'device-setting' } },
    });
  }

  it('a different account signing in on the website wipes the previous account’s local data first', async () => {
    backend.payments.set('userA', { tier: 'Diamond', endDate: new Date(Date.now() + 86_400_000).toISOString() });
    await login('userA');
    await seedAccountData();

    expect(await login('userB')).toMatchObject({ ok: true, uid: 'userB', clearedPreviousAccount: true });
    const s = await session();
    expect(uidOf(s)).toBe('userB');
    expect(s.premium?.isPremium).toBe(false); // A's Diamond is not carried over
    expect(s.credits?.remainingCredits).toBe(100);
    expect((await careerBrainStore.get()).fullName).not.toBe('Asha A');
    const stored = await chrome.storage.local.get(null);
    expect(stored.linkedin_processed_jobs).toBeUndefined();
    expect(stored.chat_sessions_meta).toBeUndefined();
    expect(stored.chat_messages_s1).toBeUndefined();
    expect(stored.nanobrowser_pending_refunds).toBeUndefined();
    expect(stored.llm_providers).toEqual({ openai: { apiKey: 'device-setting' } }); // device settings stay
    expect(stored.nanobrowser_account_owner).toBe('userB');
  });

  it('the same account signing in again keeps its local data', async () => {
    await login('userA');
    await seedAccountData();
    await handleWebsiteMessage({ type: JOBFORM_WEBSITE_MESSAGES.logout });
    expect(await login('userA')).toMatchObject({ ok: true, clearedPreviousAccount: false });
    expect((await careerBrainStore.get()).fullName).toBe('Asha A');
  });

  it('sign-out, then another account: the previous account’s data is still wiped', async () => {
    await login('userA');
    await seedAccountData();
    await handleWebsiteMessage({ type: JOBFORM_WEBSITE_MESSAGES.logout });
    await login('userB');
    expect((await careerBrainStore.get()).fullName).not.toBe('Asha A');
  });

  it('installs from before this change: the stored session user is treated as the owner', async () => {
    await chrome.storage.local.set({
      nanobrowser_auth_session: {
        token: 'old',
        refreshToken: null,
        user: { _id: 'userA', name: 'Asha A' },
        subscription: null,
        credits: null,
      },
    });
    await seedAccountData();
    await login('userB');
    expect((await careerBrainStore.get()).fullName).not.toBe('Asha A');
  });

  it('a status response for the previous account is dropped after a switch', async () => {
    await login('userA');
    const slowFetch = globalThis.fetch;
    let release!: () => void;
    globalThis.fetch = (async (input: any, init: any) => {
      if (String(input).endsWith('/subscription/me')) await new Promise<void>(resolve => (release = resolve));
      return slowFetch(input, init);
    }) as typeof fetch;
    backend.payments.set('userA', { tier: 'Diamond', endDate: new Date(Date.now() + 86_400_000).toISOString() });
    const pending = refreshAccountStatus(); // request made as userA
    await new Promise(resolve => setTimeout(resolve, 10));
    globalThis.fetch = slowFetch;
    await login('userB');
    release();
    expect(await pending).toBeNull();
    expect((await session()).premium?.isPremium).toBe(false);
    expect(uidOf(await session())).toBe('userB');
  });
});

describe('scenarios 6–8: premium comes only from the backend', () => {
  it('a payment event re-checks the backend; premium appears once the website has verified the payment', async () => {
    await login('userA');
    expect((await session()).premium?.isPremium).toBe(false);
    // JobForm Automator's /api/payment/confirm writes user/{uid}/Payment a moment after the event
    setTimeout(
      () =>
        backend.payments.set('userA', {
          tier: 'Premium',
          endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        }),
      15,
    );
    const result = await handleWebsiteMessage(
      { type: JOBFORM_WEBSITE_MESSAGES.paymentCompleted, uid: 'userA', plan: 'Diamond' },
      {
        paymentRecheckDelaysMs: [0, 30, 60],
      },
    );
    expect(result).toMatchObject({ ok: true, premium: true });
    expect((await session()).premium).toMatchObject({ tier: 'Premium', isPremium: true }); // not the event's "Diamond"
  });

  it('a payment event without a verified payment grants nothing', async () => {
    await login('userA');
    const result = await handleWebsiteMessage(
      { type: JOBFORM_WEBSITE_MESSAGES.paymentCompleted, uid: 'userA', plan: 'Diamond' },
      {
        paymentRecheckDelaysMs: [0, 5, 5],
      },
    );
    expect(result).toMatchObject({ ok: true, premium: false });
    expect((await session()).premium?.isPremium).toBe(false);
    expect(backend.subscriptionMeCalls).toBeGreaterThanOrEqual(3);
  });

  it('a payment event while signed out does nothing', async () => {
    const result = await handleWebsiteMessage(
      { type: JOBFORM_WEBSITE_MESSAGES.paymentCompleted },
      { paymentRecheckDelaysMs: [0] },
    );
    expect(result).toMatchObject({ ok: true, premium: false });
    expect(backend.subscriptionMeCalls).toBe(0);
  });

  it('expiry: a lapsed period shows as not premium locally and from the backend', async () => {
    backend.payments.set('userA', { tier: 'Premium', endDate: new Date(Date.now() + 86_400_000).toISOString() });
    await login('userA');
    const premium = (await session()).premium!;
    expect(isPremiumActive(premium)).toBe(true);
    expect(isPremiumActive(premium, Date.now() + 2 * 86_400_000)).toBe(false); // end date passed since the check

    backend.payments.set('userA', { tier: 'Premium', endDate: new Date(Date.now() - 1000).toISOString() });
    await refreshAccountStatus();
    expect((await session()).premium).toMatchObject({ isPremium: false, expired: true });
  });

  it('editing the stored premium status is overwritten by the backend on the next check', async () => {
    await login('userA');
    await authStorage.setSession({
      premium: { ...(await session()).premium!, tier: 'Diamond', isPremium: true, endDate: null },
    });
    await refreshAccountStatus();
    expect((await session()).premium?.isPremium).toBe(false);
  });

  it('the local "Premium Mode" plan mirror follows the backend, not checkout clicks', async () => {
    await login('userA');
    await cloudApiSettingsStore.updateSubscription({ planId: 'pro', status: 'active' }); // e.g. set before payment
    await cloudApiSettingsStore.setApiMode('premium');
    await refreshAccountStatus(); // backend: free trial, no paid plan
    const settings = await cloudApiSettingsStore.getSettings();
    expect(settings.subscription.planId).toBe('free');
    expect(settings.apiMode).toBe('free');
  });
});

// ── Website stored state (page load): covers sessions the website does not announce ──────────
const FIREBASE_KEY = 'firebase:authUser:AIzaSyDDrfKs64q7t2bZibGgjnylPDbZxf5hoig:[DEFAULT]';
function websiteStorage(entries: Record<string, string>): KeyValueStorage {
  const keys = Object.keys(entries);
  return { length: keys.length, key: i => keys[i] ?? null, getItem: k => (k in entries ? entries[k] : null) };
}
const firebaseRecord = (uid: string) =>
  JSON.stringify({
    uid,
    email: `${uid}@example.com`,
    stsTokenManager: {
      accessToken: idToken(uid),
      refreshToken: `refresh-${uid}`,
      expirationTime: Date.now() + 3_600_000,
    },
  });

describe("reading the website's stored sign-in state", () => {
  it('signed in: candidate flag + Firebase session → uid and tokens', () => {
    const state = readWebsiteSessionState(
      websiteStorage({ IsLogin: 'true', UID: 'userA', [FIREBASE_KEY]: firebaseRecord('userA') }),
    );
    expect(state).toMatchObject({ state: 'signed-in', uid: 'userA', refreshToken: 'refresh-userA' });
  });

  it('signed out: neither the flag nor a Firebase candidate session (e.g. after the navbar Logout)', () => {
    expect(readWebsiteSessionState(websiteStorage({}))).toEqual({ state: 'signed-out' });
    expect(
      readWebsiteSessionState(websiteStorage({ 'firebase:authUser:key:hr-app': firebaseRecord('hrUser') })),
    ).toEqual({ state: 'signed-out' });
  });

  it('anything partial is unknown and ignored', () => {
    expect(readWebsiteSessionState(websiteStorage({ IsLogin: 'true' }))).toEqual({ state: 'unknown' });
    expect(readWebsiteSessionState(websiteStorage({ [FIREBASE_KEY]: firebaseRecord('userA') }))).toEqual({
      state: 'unknown',
    });
    expect(readWebsiteSessionState(websiteStorage({ IsLogin: 'true', [FIREBASE_KEY]: '{not json' }))).toEqual({
      state: 'unknown',
    });
    expect(
      readWebsiteSessionState(websiteStorage({ IsLogin: 'true', [FIREBASE_KEY]: JSON.stringify({ uid: 'userA' }) })),
    ).toEqual({ state: 'unknown' });
    const throwing: KeyValueStorage = {
      length: 1,
      key: () => {
        throw new Error('denied');
      },
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(readWebsiteSessionState(throwing)).toEqual({ state: 'unknown' });
  });
});

describe('website session found on page load', () => {
  const pageLogin = (uid: string, token = idToken(uid)) =>
    handleWebsiteMessage({
      type: JOBFORM_WEBSITE_MESSAGES.login,
      trigger: 'page-load',
      uid,
      idToken: token,
      refreshToken: `refresh-${uid}`,
    });
  const pageLogout = () => handleWebsiteMessage({ type: JOBFORM_WEBSITE_MESSAGES.logout, trigger: 'page-load' });

  it('signs in automatically when the website is already signed in (verified by the backend)', async () => {
    expect(await pageLogin('userA')).toMatchObject({ ok: true, uid: 'userA' });
    expect(uidOf(await session())).toBe('userA');
    expect(backend.meCalls).toBe(1);
  });

  it('keeps an existing session of the same account without calling the backend again', async () => {
    await login('userA');
    const calls = backend.meCalls + backend.subscriptionMeCalls;
    expect(await pageLogin('userA', idToken('userA', 1800))).toMatchObject({ ok: true, unchanged: true });
    expect(backend.meCalls + backend.subscriptionMeCalls).toBe(calls);
  });

  it('follows an account switch on the website', async () => {
    await login('userA');
    expect(await pageLogin('userB')).toMatchObject({ ok: true, uid: 'userB', clearedPreviousAccount: true });
    expect(uidOf(await session())).toBe('userB');
  });

  it('is still verified: a forged stored token is rejected', async () => {
    const forged = `${b64url({ alg: 'none' })}.${b64url({ user_id: 'userA', exp: nowSec() + 3600 })}.forged`;
    expect(await pageLogin('userA', forged)).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await session()).token).toBeNull();
  });

  it('after a NanoBrowser-only sign-out, website pages do not sign back in until Login is clicked', async () => {
    await login('userA');
    await endAccountSession({ pauseWebsiteAutoLogin: true });
    expect(await isWebsiteAutoLoginPaused()).toBe(true);

    expect(await pageLogin('userA')).toMatchObject({ ok: false, reason: 'paused' });
    expect((await session()).token).toBeNull();

    await openJobformSignIn(); // "Login with JobForm Automator"
    expect(await isWebsiteAutoLoginPaused()).toBe(false);
    expect(await pageLogin('userA')).toMatchObject({ ok: true, uid: 'userA' });
  });

  it('a sign-in announced by the website itself is accepted even while paused (and lifts the pause)', async () => {
    await login('userA');
    await endAccountSession({ pauseWebsiteAutoLogin: true });
    expect(await login('userA')).toMatchObject({ ok: true, uid: 'userA' });
    expect(await isWebsiteAutoLoginPaused()).toBe(false);
  });

  it('website signed out (e.g. navbar Logout): NanoBrowser is signed out on the next website page', async () => {
    await login('userA');
    await pageLogout();
    expect(await session()).toMatchObject({ token: null, user: null });
  });

  it('signed out on both sides: nothing is written, and a pending pause is lifted', async () => {
    await endAccountSession({ pauseWebsiteAutoLogin: true });
    const before = JSON.stringify(await chrome.storage.local.get('nanobrowser_auth_session'));
    await pageLogout();
    expect(JSON.stringify(await chrome.storage.local.get('nanobrowser_auth_session'))).toBe(before);
    expect(await isWebsiteAutoLoginPaused()).toBe(false);
  });
});
