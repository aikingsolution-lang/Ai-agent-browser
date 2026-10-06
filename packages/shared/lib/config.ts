/**
 * Global configuration and environment helpers for NanoBrowser
 */

const getEnvBackendUrl = (): string => {
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
