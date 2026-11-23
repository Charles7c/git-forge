#!/usr/bin/env node
/**
 * Enforces that both workspace packages share one version.
 *
 * The two packages are released together (see CONTRIBUTING), so a drifting
 * `version` field would make the MCP package depend on a non-existent SDK
 * version. `pnpm lint` runs this before ESLint.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = ['git-forge', 'git-forge-mcp'];

/** @returns {Promise<{dir: string, name: string, version: string}>} */
async function readManifest(dir) {
  const file = path.join(repoRoot, 'packages', dir, 'package.json');
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
    throw new Error(`${file}: missing "name" or "version"`);
  }
  return { dir, name: parsed.name, version: parsed.version };
}

const license = await readFile(path.join(repoRoot, 'LICENSE'));
for (const dir of packageDirs) {
  const copy = await readFile(path.join(repoRoot, 'packages', dir, 'LICENSE'));
  if (!license.equals(copy)) {
    throw new Error(`${dir}/LICENSE differs from the root license`);
  }
}

const manifests = await Promise.all(packageDirs.map(readManifest));
const versions = new Set(manifests.map((m) => m.version));

if (versions.size !== 1) {
  console.error('[check-package-versions] Package versions must match:');
  for (const m of manifests) {
    console.error(`  ${m.name}: ${m.version}`);
  }
  process.exit(1);
}

const [version] = [...versions];
console.log(
  `[check-package-versions] OK — ${manifests.map((m) => m.name).join(', ')} at ${version}`,
);
