import { defineConfig } from 'tsup';

/**
 * The MCP package ships a bin entry, so the shebang must survive bundling and
 * be present in both formats (`banner` runs for each output file).
 *
 * `shims: true` keeps `import.meta.url` working in the CJS build, which the
 * direct-execution guard needs.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: false,
  sourcemap: true,
  target: 'node20',
  platform: 'node',
  shims: true,
  banner: { js: '#!/usr/bin/env node' },
});
