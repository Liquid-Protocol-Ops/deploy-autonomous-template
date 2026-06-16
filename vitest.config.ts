import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Platform services have their own package.json + test runner.
    // Exclude them from the root vitest run.
    exclude: ['**/node_modules/**', '**/dist/**', 'platform/services/**'],
  },
});
