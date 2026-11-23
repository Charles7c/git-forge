import { defineConfig } from 'tsup';

/**
 * ESM + CJS + type declarations in one pass.
 *
 * `dts: true` emits both `index.d.ts` (for `import`) and `index.d.cts` (for
 * `require`); the latter is required by the `exports` map, otherwise TS cannot
 * resolve types on the CJS channel. `target: node20` keeps the output within
 * the supported engine range.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: false,
  sourcemap: true,
  target: 'node20',
  platform: 'node',
  treeshake: true,
});
