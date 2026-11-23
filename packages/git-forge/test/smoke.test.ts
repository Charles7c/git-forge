import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as sdk from '../src/index.js';

interface Manifest {
  name: string;
  version: string;
}

async function readManifest(): Promise<Manifest> {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as Manifest;
}

describe('package smoke', () => {
  it('exposes the version advertised in package.json', async () => {
    const manifest = await readManifest();

    expect(sdk.VERSION).toBe(manifest.version);
    expect(sdk.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is published under the documented package name', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('@charles7c/git-forge');
  });

  it('keeps VERSION on the public entry', () => {
    expect(Object.keys(sdk)).toContain('VERSION');
  });
});
