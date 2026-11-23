import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit-test configuration (single root config for all workspace packages).
 *
 * Deliberately excludes `e2e/**`: `pnpm test` must never reach the network.
 * The SDK public entry is aliased to `src` so tests exercise sources, not
 * build artifacts.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@charles7c/git-forge': fileURLToPath(
        new URL('./packages/git-forge/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    // `.spec.ts` is reserved for the cross-provider contract suites, `.test.ts`
    // for everything else. Both run from this one config; `e2e/**` still never
    // matches, which is what keeps `pnpm test` offline.
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      clean: false,
      cleanOnRerun: false,
      reporter: ['text', 'lcov'],
      include: ['packages/git-forge/src/**/*.ts'],
      exclude: [
        'packages/git-forge/src/**/types.ts',
        'packages/git-forge/src/adapters/*/capabilities.ts',
      ],
      thresholds: {
        lines: 80,
      },
    },
  },
});
