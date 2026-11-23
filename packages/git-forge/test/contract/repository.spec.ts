import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../../src/index.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';
import { expectError, expectNoHttp } from '../helpers/expectError.js';
import { contractRoutes, loadFixtures } from './contractContext.js';

/**
 * Repository contract.
 *
 * `html_url` must be a non-empty web URL on all three platforms even though they
 * expose it three different ways (GitHub `html_url`, Gitee a clone URL to be
 * stripped, AtomGit `web_url`), and `default_branch` must be present.
 */
describe.each(PROVIDERS)('repository contract (%s)', (provider) => {
  const data = loadFixtures(provider);
  const routes = contractRoutes(data);

  it('lists repositories as normalized models', async () => {
    const { client } = buildClient({}, routes);
    const repos = await client.listRepositories({ provider, org: 'example-org' });

    expect(repos.length).toBeGreaterThan(0);
    for (const repo of repos) {
      expect(typeof repo.name).toBe('string');
      expect(repo.name.length).toBeGreaterThan(0);
      expect(repo.provider).toBe(provider);
      expect(typeof repo.default_branch).toBe('string');
      expect(repo.html_url.startsWith('https://')).toBe(true);
      expect(typeof repo.private).toBe('boolean');
      // The `.git` suffix belongs to clone URLs only, never to a web URL.
      expect(repo.html_url.endsWith('.git')).toBe(false);
    }
  });

  it('reads one repository with a web html_url', async () => {
    const { client } = buildClient({}, routes);
    const repo = await client.getRepository({ provider, ...REPO });

    expect(repo.provider).toBe(provider);
    expect(repo.owner).toBe(REPO.owner);
    expect(repo.repo).toBe(REPO.repo);
    expect(repo.html_url.startsWith('https://')).toBe(true);
    expect(repo.html_url.endsWith('.git')).toBe(false);
    expect(repo.html_url.length).toBeGreaterThan('https://'.length);
  });

  it('creates a repository', async () => {
    const { client } = buildClient({}, routes);
    const repo = await client.createRepository({
      provider,
      name: 'contract-repo',
      description: 'contract',
      private: false,
    });
    expect(repo.provider).toBe(provider);
    expect(repo.html_url.startsWith('https://')).toBe(true);
  });

  it('reads one file as FileContent', async () => {
    const { client } = buildClient({}, routes);
    const file = await client.getFileContents({ provider, ...REPO, path: 'README.md' });

    expect(file.provider).toBe(provider);
    expect(file.path).toBe('README.md');
    expect(typeof file.content).toBe('string');
    expect(file.content.length).toBeGreaterThan(0);
    expect(typeof file.encoding).toBe('string');
  });

  it('refuses a directory listing as INVALID_ARGUMENT', async () => {
    // An array response means "this is a directory"; v0.1.0 has no directory
    // listing, so it is rejected rather than guessed at.
    const { client } = buildClient({}, [
      { match: /.*/, responses: [{ body: [{ name: 'nested', type: 'file' }] }] },
    ]);
    await expectError(client.getFileContents({ provider, ...REPO, path: 'src' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['directory'],
    });
  });

  it('surfaces a 404 file read as NOT_FOUND', async () => {
    const { client } = buildClient({}, [
      { match: /.*/, responses: [{ status: 404, body: { message: 'Not Found' } }] },
    ]);
    await expectError(client.getFileContents({ provider, ...REPO, path: 'missing.md' }), {
      code: 'NOT_FOUND',
      provider,
      status: 404,
    });
  });

  it('refuses a repository name without a value before any request', async () => {
    const { client, mock } = buildClient({}, routes);
    await expectError(client.createRepository({ provider, name: '   ' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['name'],
    });
    expectNoHttp(mock);
  });
});
