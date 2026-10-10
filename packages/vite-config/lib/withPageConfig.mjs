import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { watchRebuildPlugin } from '@extension/hmr';
import react from '@vitejs/plugin-react-swc';
import deepmerge from 'deepmerge';
import { isDev, isProduction } from './env.mjs';

// VITE_* values from the repository-root .env (e.g. VITE_BACKEND_API_URL for a local backend)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rootEnv = loadEnv(isDev ? 'development' : 'production', repoRoot, 'VITE_');

export const watchOption = isDev ? {
  buildDelay: 100,
  chokidar: {
    ignored:[
      /\/packages\/.*\.(ts|tsx|map)$/,
    ]
  }
}: undefined;

/**
 * @typedef {import('vite').UserConfig} UserConfig
 * @param {UserConfig} config
 * @returns {UserConfig}
 */
export function withPageConfig(config) {
  return defineConfig(
    deepmerge(
      {
        base: '',
        plugins: [react(), isDev && watchRebuildPlugin({ refresh: true })],
        server: {
          sourcemapIgnoreList: false,
        },
        build: {
          sourcemap: isDev,
          minify: isProduction,
          reportCompressedSize: isProduction,
          emptyOutDir: isProduction,
          watch: watchOption,
          rollupOptions: {
            external: ['chrome'],
          },
        },
        define: {
          'process.env.NODE_ENV': isDev ? `"development"` : `"production"`,
          'import.meta.env.VITE_BACKEND_API_URL': JSON.stringify(
            process.env.VITE_BACKEND_API_URL || rootEnv.VITE_BACKEND_API_URL || (isDev ? 'http://localhost:5000' : ''),
          ),
          // Backend address used by @extension/shared (empty → production backend)
          __NANOBROWSER_BACKEND_URL__: JSON.stringify(
            process.env.VITE_BACKEND_API_URL || rootEnv.VITE_BACKEND_API_URL || (isDev ? 'http://localhost:5000' : ''),
          ),
        },
        envDir: '../..',
      },
      config,
    ),
  );
}
