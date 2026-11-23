import { defineConfig } from 'vitest/config';

/**
 * Transport checks against a loopback HTTP listener and the built stdio binary.
 * No hosted endpoints, credentials or opt-in switches are required. These tests
 * run separately from source-level unit tests and require a prior build.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/git-forge/e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
