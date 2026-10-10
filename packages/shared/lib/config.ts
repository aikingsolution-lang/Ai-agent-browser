/**
 * Global configuration and environment helpers for NanoBrowser
 */

/**
 * Backend address chosen at build time: VITE_BACKEND_API_URL in the repository-root .env (e.g.
 * http://localhost:5000 for a local backend), injected by the extension's Vite configs. Without it
 * the production Cloud Run backend is used.
 */
declare const __NANOBROWSER_BACKEND_URL__: string | undefined;

const getEnvBackendUrl = (): string => {
  const injected = typeof __NANOBROWSER_BACKEND_URL__ === 'string' ? __NANOBROWSER_BACKEND_URL__.trim() : '';
  if (injected) return injected.replace(/\/+$/, '');

  // Check build-time injected Vite/Node environment variable
  try {
    const proc = (globalThis as any)?.process;
    if (proc?.env?.VITE_BACKEND_API_URL) {
      return (proc.env.VITE_BACKEND_API_URL as string).replace(/\/+$/, '');
    }
  } catch {}

  try {
    const meta = (globalThis as any)?.import?.meta;
    if (meta?.env?.VITE_BACKEND_API_URL) {
      return String(meta.env.VITE_BACKEND_API_URL).replace(/\/+$/, '');
    }
  } catch {}

  return 'https://nanobrowser-backend-336340854879.asia-south1.run.app';
};

export const BACKEND_BASE_URL: string = getEnvBackendUrl();
export const BACKEND_API_URL: string = `${BACKEND_BASE_URL}/api/v1`;
export const BACKEND_LLM_URL: string = `${BACKEND_BASE_URL}/api/v1/llm`;
export const MINIMUM_RUN_CREDITS: number = 5;
export const ENABLE_CREDITS_RECONCILE: boolean = false;

const getEnvGoogleClientId = (): string => {
  try {
    const proc = (globalThis as any)?.process;
    if (proc?.env?.VITE_GOOGLE_CLIENT_ID) {
      return String(proc.env.VITE_GOOGLE_CLIENT_ID).trim();
    }
    if (proc?.env?.GOOGLE_CLIENT_ID) {
      return String(proc.env.GOOGLE_CLIENT_ID).trim();
    }
  } catch {}

  try {
    const meta = (globalThis as any)?.import?.meta;
    if (meta?.env?.VITE_GOOGLE_CLIENT_ID) {
      return String(meta.env.VITE_GOOGLE_CLIENT_ID).trim();
    }
    if (meta?.env?.GOOGLE_CLIENT_ID) {
      return String(meta.env.GOOGLE_CLIENT_ID).trim();
    }
  } catch {}

  return '336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com';
};

export const GOOGLE_CLIENT_ID: string = getEnvGoogleClientId();

const readEnv = (name: string): string | undefined => {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const value = env?.[name];
    if (value) return String(value).trim();
  } catch {
    // process.env is not available in extension contexts
  }
  return undefined;
};

/**
 * Public Firebase Web API key of the JobForm Automator Firebase project (the project the backend
 * verifies ID tokens for). Like the Google client ID above it is a public identifier, not a secret:
 * JobForm Automator's website and extension ship the same key. Used only to refresh Firebase ID
 * tokens (securetoken.googleapis.com), as the JobForm Automator extension does.
 */
export const FIREBASE_WEB_API_KEY: string =
  readEnv('VITE_FIREBASE_API_KEY') || 'AIzaSyDDrfKs64q7t2bZibGgjnylPDbZxf5hoig';

/** JobForm Automator website: users sign in, sign out and pay there; the extension follows that session. */
export const JOBFORM_WEBSITE_URL = 'https://www.jobformautomator.com';
export const JOBFORM_SIGN_IN_URL = `${JOBFORM_WEBSITE_URL}/sign-in`;
export const JOBFORM_PRICING_URL = `${JOBFORM_WEBSITE_URL}/pricing`;

/** Only these origins may hand a session to the extension (exact origin match, HTTPS only). */
export const JOBFORM_WEBSITE_ORIGINS: readonly string[] = [
  'https://www.jobformautomator.com',
  'https://jobformautomator.com',
];

export function isJobformWebsiteOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && JOBFORM_WEBSITE_ORIGINS.includes(origin);
}

/** Origin of a URL, or null when it can't be parsed. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
