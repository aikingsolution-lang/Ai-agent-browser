import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * JobForm Automator premium status as reported by the backend (GET /subscription/me), which reads
 * it from JobForm Automator's verified payment record. A cached copy for display only: the backend
 * decides access, so editing this value grants nothing.
 */
export interface PremiumStatus {
  source: 'jobform-automator';
  tier: 'Free' | 'Premium' | 'Diamond';
  isPremium: boolean;
  subscriptionType: string | null;
  startDate: string | null;
  endDate: string | null;
  expired: boolean;
  checkedAt: string;
}

export interface UserSessionData {
  token: string | null;
  refreshToken?: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
  } | null;
  subscription: {
    id?: string;
    status: string;
    planCode?: string;
    cancelAtPeriodEnd?: boolean;
    currentPeriodEnd?: string;
  } | null;
  credits: {
    allocatedCredits: number;
    usedCredits: number;
    remainingCredits: number;
  } | null;
  premium?: PremiumStatus | null;
  /** Where the session came from: the JobForm Automator website, or the extension's own sign-in. */
  source?: 'website' | 'extension' | null;
}

export type AuthStorage = BaseStorage<UserSessionData> & {
  getSession: () => Promise<UserSessionData>;
  setSession: (data: Partial<UserSessionData>) => Promise<void>;
  /** Replaces the whole session (a new sign-in); nothing from the previous session is kept. */
  replaceSession: (data: Partial<UserSessionData>) => Promise<void>;
  clearSession: () => Promise<void>;
};

export const DEFAULT_AUTH_SESSION: UserSessionData = {
  token: null,
  refreshToken: null,
  user: null,
  subscription: null,
  credits: null,
  premium: null,
  source: null,
};

export const AUTH_SESSION_STORAGE_KEY = 'nanobrowser_auth_session';

const storage = createStorage<UserSessionData>(AUTH_SESSION_STORAGE_KEY, DEFAULT_AUTH_SESSION, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/** Firebase uid of a stored session user (`uid` / `_id` from the backend, `id` from older sessions, or JWT sub/user_id). */
export function sessionUserId(user: unknown, token?: string | null): string | null {
  if (user && typeof user === 'object') {
    const record = user as Record<string, unknown>;
    const id = record.uid ?? record._id ?? record.id;
    if (typeof id === 'string' && id) return id;
  }
  if (typeof token === 'string' && token.includes('.')) {
    try {
      const payload = token.split('.')[1];
      if (payload) {
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const json = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
        const id = json?.user_id ?? json?.sub ?? json?.uid;
        if (typeof id === 'string' && id) return id;
      }
    } catch {}
  }
  return null;
}

export const authStorage: AuthStorage = {
  ...storage,
  getSession: async () => {
    return (await storage.get()) || DEFAULT_AUTH_SESSION;
  },
  setSession: async (data: Partial<UserSessionData>) => {
    const current = (await storage.get()) || DEFAULT_AUTH_SESSION;
    await storage.set({ ...current, ...data });
  },
  replaceSession: async (data: Partial<UserSessionData>) => {
    await storage.set({ ...DEFAULT_AUTH_SESSION, ...data });
  },
  clearSession: async () => {
    await storage.set(DEFAULT_AUTH_SESSION);
  },
};

export default authStorage;
