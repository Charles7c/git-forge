import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../../src/index.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';
import { expectError } from '../helpers/expectError.js';
import { contractRoutes, loadFixtures } from './contractContext.js';

/**
 * Branch and commit contract.
 *
 * `Branch.html_url` is derived on every platform (none returns one), and a
 * commit keeps its message, sha and parents. The derived URL must retain
 * the provider’s web host.
 */
const EXPECTED_WEB_BASE = {
  github: 'https://github.com',
  gitee: 'https://gitee.com',
  atomgit: 'https://atomgit.com',
} as const;

describe.each(PROVIDERS)('branch/commit contract (%s)', (provider) => {
  const data = loadFixtures(provider);
  const routes = contractRoutes(data);

  it('lists branches with a derived html_url', async () => {
    const { client } = buildClient({}, routes);
    const branches = await client.listBranches({ provider, ...REPO });

    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(typeof branch.name).toBe('string');
      expect(branch.commit_sha.length).toBeGreaterThan(0);
      expect(branch.provider).toBe(provider);
      expect(branch.owner).toBe(REPO.owner);
      expect(branch.repo).toBe(REPO.repo);
      // Derived, never fetched: `<webBase>/<owner>/<repo>/tree/<name>`.
      expect(branch.html_url).toBe(
        `${EXPECTED_WEB_BASE[provider]}/${REPO.owner}/${REPO.repo}/tree/${branch.name}`,
      );
    }
  });

  it('derives branch html_url without an extra request', async () => {
    const { client, mock } = buildClient({}, routes);
    await client.listBranches({ provider, ...REPO });

    // One page, no follow-up call for the links.
    expect(mock.calls).toHaveLength(1);
  });

  it('creates a branch and derives its html_url', async () => {
    const { client } = buildClient({}, routes);
    const branch = await client.createBranch({
      provider,
      ...REPO,
      name: 'feat/contract',
      from: 'dev',
    });

    expect(branch.provider).toBe(provider);
    expect(branch.name.length).toBeGreaterThan(0);
    expect(branch.html_url).toBe(
      `${EXPECTED_WEB_BASE[provider]}/${REPO.owner}/${REPO.repo}/tree/${branch.name}`,
    );
  });

  it('lists commits as normalized models', async () => {
    const { client } = buildClient({}, routes);
    const commits = await client.listCommits({ provider, ...REPO });

    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      expect(typeof commit.sha).toBe('string');
      expect(commit.sha.length).toBeGreaterThan(0);
      expect(typeof commit.message).toBe('string');
      expect(commit.html_url.startsWith('https://')).toBe(true);
      expect(commit.provider).toBe(provider);
      expect(Array.isArray(commit.parents ?? [])).toBe(true);
    }
  });

  it('reads one commit', async () => {
    const { client } = buildClient({}, routes);
    const commit = await client.getCommit({ provider, ...REPO, sha: 'a'.repeat(40) });

    expect(commit.provider).toBe(provider);
    expect(commit.sha.length).toBeGreaterThan(0);
    expect(commit.html_url.startsWith('https://')).toBe(true);
    expect(commit.author?.name).toBeDefined();
  });

  it('surfaces a 404 commit read as NOT_FOUND', async () => {
    const { client } = buildClient({}, [
      { match: /.*/, responses: [{ status: 404, body: { message: 'Not Found' } }] },
    ]);
    await expectError(client.getCommit({ provider, ...REPO, sha: 'f'.repeat(40) }), {
      code: 'NOT_FOUND',
      provider,
      status: 404,
    });
  });

  it('surfaces a 401 branch listing as AUTH_INVALID', async () => {
    const { client } = buildClient({}, [
      { match: /.*/, responses: [{ status: 401, body: { message: 'Bad credentials' } }] },
    ]);
    await expectError(client.listBranches({ provider, ...REPO }), {
      code: 'AUTH_INVALID',
      provider,
      status: 401,
    });
  });

  it('refuses a commit read without a sha', async () => {
    const { client } = buildClient({}, routes);
    await expectError(client.getCommit({ provider, ...REPO, sha: '' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['sha'],
    });
  });
});
