import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config.
 *
 * The layering rules below encode the dependency direction from the design
 * (MCP -> facade -> adapters -> core): a lower layer must never import an
 * upper one. This is enforced in CI so a stray import cannot silently
 * introduce a cycle.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.d.cts',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        // Match typecheck: resolve the workspace SDK from source even before the first build.
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    extends: [...tseslint.configs.recommendedTypeChecked],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // core must not depend on adapters (dependency direction: core is the base).
    files: ['packages/git-forge/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**', '../adapters/*', '../../adapters/*'],
              message: 'core must not import adapters: core is the lowest layer.',
            },
          ],
        },
      ],
    },
  },
  {
    // Adapters must not import each other, the aggregate registry, or the facade.
    files: ['packages/git-forge/src/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/adapters/!(types)*',
                '**/adapters/index',
                '**/client',
                '../!(types)',
                '../../client',
              ],
              message:
                'adapters may only share adapters/types.ts and core/*: no cross-adapter or facade imports.',
            },
          ],
          paths: [{ name: '**/client', message: 'adapters must not import the facade.' }],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'All HTTP must go through core/http.ts so retry, auth and redaction stay in one place.',
        },
      ],
    },
  },
  {
    // The MCP package may only touch the public SDK surface.
    files: ['packages/git-forge-mcp/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@charles7c/git-forge/*'],
              message:
                'MCP must use the public SDK entry (@charles7c/git-forge), never deep-import internals.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'MCP must not perform HTTP; the SDK owns all network access.',
        },
      ],
    },
  },
  {
    // Build and maintenance scripts run in Node, so Node globals apply.
    files: ['scripts/**/*.mjs', '**/tsup.config.ts', 'vitest*.config.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The MCP entry writes its startup banner to stderr by design.
    files: ['packages/git-forge-mcp/src/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
);
