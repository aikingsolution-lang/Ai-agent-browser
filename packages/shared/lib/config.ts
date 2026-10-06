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

  return 'http://localhost:5000';
};

export const BACKEND_BASE_URL: string = getEnvBackendUrl();
export const BACKEND_API_URL: string = `${BACKEND_BASE_URL}/api/v1`;
export const BACKEND_LLM_URL: string = `${BACKEND_BASE_URL}/api/v1/llm`;
