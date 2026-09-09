import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface UserSessionData {
  token: string | null;
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
}

export type AuthStorage = BaseStorage<UserSessionData> & {
  getSession: () => Promise<UserSessionData>;
  setSession: (data: Partial<UserSessionData>) => Promise<void>;
  clearSession: () => Promise<void>;
};

const DEFAULT_AUTH_SESSION: UserSessionData = {
  token: null,
  user: null,
  subscription: null,
  credits: null,
};

const storage = createStorage<UserSessionData>('nanobrowser_auth_session', DEFAULT_AUTH_SESSION, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const authStorage: AuthStorage = {
  ...storage,
  getSession: async () => {
    return (await storage.get()) || DEFAULT_AUTH_SESSION;
  },
  setSession: async (data: Partial<UserSessionData>) => {
    const current = (await storage.get()) || DEFAULT_AUTH_SESSION;
    await storage.set({ ...current, ...data });
  },
  clearSession: async () => {
    await storage.set(DEFAULT_AUTH_SESSION);
  },
};

export default authStorage;
