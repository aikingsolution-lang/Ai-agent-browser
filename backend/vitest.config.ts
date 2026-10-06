import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 120000,
    setupFiles: ['./src/tests/globalSetup.ts'],
  },
});
