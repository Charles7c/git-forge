import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../../src/index.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';
import { expectError, expectNoHttp } from '../helpers/expectError.js';
import { contractRoutes, loadFixtures } from './contractContext.js';

/**
 * Files contract, including the three-platform `pushFiles` split.
 *
 * `pushFiles` is the one capability where the platforms genuinely diverge:
 * GitHub and Gitee commit a batch in one commit, AtomGit cannot. The matrix is
 * asserted in one place so a future edit cannot flip one platform silently.
 */
const COMMIT_SHA = 'c'.repeat(40);
const COMMIT_URL = 'https://example.com/commit/c';

/** A single-file contents write response, shared by the create/update/delete cases. */
const WRITE_BODY = {
  content: { html_url: 'https://example.com/blob/dev/a.txt' },
  commit: { sha: COMMIT_SHA, html_url: COMMIT_URL },
};

describe.each(PROVIDERS)('files contract (%s)', (provider) => {
  const data = loadFixtures(provider);
  const routes = contractRoutes(data);

  it('creates a file and reports a commit', async () => {
    const { client } = buildClient({}, [{ match: /.*/, responses: [{ body: WRITE_BODY }] }]);
    const result = await client.createOrUpdateFile({
      provider,
      ...REPO,
      path: 'a.txt',
      content: Buffer.from('hi', 'utf8').toString('base64'),
      message: 'contract: create',
    });

    expect(result.provider).toBe(provider);
    expect(result.commit_sha).toBe(COMMIT_SHA);
    expect(result.commit_html_url.length).toBeGreaterThan(0);
    expect(result.paths).toEqual(['a.txt']);
  });

  it('updates a file when a blob sha is supplied', async () => {
    const { client } = buildClient({}, [{ match: /.*/, responses: [{ body: WRITE_BODY }] }]);
    const result = await client.createOrUpdateFile({
      provider,
      ...REPO,
      path: 'a.txt',
      content: 'aGk=',
      message: 'contract: update',
      sha: 'e'.repeat(40),
    });

    expect(result.provider).toBe(provider);
    expect(result.paths).toEqual(['a.txt']);
  });

  it('deletes a file and reports a commit', async () => {
    const { client } = buildClient({}, [{ match: /.*/, responses: [{ body: WRITE_BODY }] }]);
    const result = await client.deleteFile({
      provider,
      ...REPO,
      path: 'a.txt',
      message: 'contract: delete',
      sha: 'e'.repeat(40),
    });

    expect(result.provider).toBe(provider);
    expect(result.commit_sha.length).toBeGreaterThan(0);
  });

  it('reports the pushFiles matrix as GitHub yes / Gitee yes / AtomGit no', () => {
    const { client } = buildClient({}, routes);
    expect(client.capabilities(provider)['files.pushFiles']).toBe(
      provider === 'atomgit' ? 'unsupported' : 'supported',
    );
  });

  it('commits a batch in one commit where the platform supports it', async () => {
    const { client, mock } = buildClient({}, routes);

    const call = client.pushFiles({
      provider,
      ...REPO,
      branch: 'dev',
      message: 'contract: push',
      files: [
        { path: 'a.txt', action: 'create', content: 'hi' },
        { path: 'b.txt', action: 'update', content: 'aGk=', encoding: 'base64' },
        { path: 'c.txt', action: 'delete' },
      ],
    });

    if (provider === 'atomgit') {
      await expectError(call, {
        code: 'UNSUPPORTED_ON_PROVIDER',
        provider,
        capability: 'files.pushFiles',
      });
      expectNoHttp(mock);
      return;
    }

    const result = await call;
    expect(result.commit_sha).toBe(COMMIT_SHA);
    expect(result.commit_html_url).toBe(COMMIT_URL);
    // `paths` follows the caller's order, never the platform's response order.
    expect(result.paths).toEqual(['a.txt', 'b.txt', 'c.txt']);

    // Gitee answers the batch with exactly one request; GitHub runs the
    // five-step chain plus one blob upload per base64 entry.
    const expected = provider === 'gitee' ? 1 : 5 + 1;
    expect(mock.calls).toHaveLength(expected);
  });

  it('sends every entry of a batch to Gitee in one request with text encoding', async () => {
    if (provider === 'github') {
      return;
    }
    if (provider === 'atomgit') {
      return;
    }
    const { client, mock } = buildClient({}, [{ match: /.*/, responses: [{ body: WRITE_BODY }] }]);
    await client.pushFiles({
      provider,
      ...REPO,
      branch: 'dev',
      message: 'contract: push',
      files: [
        { path: 'a.txt', action: 'create', content: 'hi' },
        { path: 'b.txt', action: 'create', content: 'aGk=', encoding: 'base64' },
      ],
    });

    expect(mock.calls).toHaveLength(1);
    const body = mock.calls[0]!.json as { actions: { encoding?: string; path: string }[] };
    expect(body.actions).toHaveLength(2);
    // Gitee accepts `text`/`base64` only: `utf8` is rejected with HTTP 400.
    expect(body.actions[0]?.encoding).toBe('text');
    expect(body.actions[1]?.encoding).toBe('base64');
  });

  it('builds GitHub tree entries as content-or-sha, never both', async () => {
    if (provider !== 'github') {
      return;
    }
    const { client, mock } = buildClient({}, [
      { match: /\/git\/blobs$/, responses: [{ body: { sha: 'd'.repeat(40) } }] },
      {
        match: /\/git\/ref\/heads\//,
        responses: [{ body: { object: { sha: 'a'.repeat(40) } } }],
      },
      {
        match: /\/git\/commits\/[0-9a-f]+/,
        responses: [{ body: { sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } } }],
      },
      { match: /\/git\/trees$/, responses: [{ body: { sha: 'b'.repeat(40) } }] },
      {
        match: /\/git\/commits$/,
        responses: [{ body: { sha: COMMIT_SHA, html_url: COMMIT_URL } }],
      },
      { match: /\/git\/refs\/heads\//, responses: [{ body: { ref: 'refs/heads/dev' } }] },
    ]);

    await client.pushFiles({
      provider,
      ...REPO,
      branch: 'dev',
      message: 'contract: push',
      files: [
        { path: 'a.txt', action: 'create', content: 'hi' },
        { path: 'b.txt', action: 'create', content: 'aGk=', encoding: 'base64' },
        { path: 'c.txt', action: 'delete' },
      ],
    });

    const treeCall = mock.callsMatching(/\/git\/trees$/)[0];
    const tree = (treeCall?.json as { tree: Record<string, unknown>[] }).tree;

    expect(tree[0]).toEqual({ path: 'a.txt', mode: '100644', type: 'blob', content: 'hi' });
    expect(tree[1]).toEqual({ path: 'b.txt', mode: '100644', type: 'blob', sha: 'd'.repeat(40) });
    expect(tree[2]).toEqual({ path: 'c.txt', mode: '100644', type: 'blob', sha: null });
    // `base_tree` guards every file the batch does not mention.
    expect((treeCall?.json as { base_tree: string }).base_tree).toBe('b'.repeat(40));
  });

  it('refuses an empty batch on every provider with zero HTTP', async () => {
    const { client, mock } = buildClient({}, routes);
    await expectError(
      client.pushFiles({ provider, ...REPO, branch: 'dev', message: 'm', files: [] }),
      { code: 'INVALID_ARGUMENT', provider },
    );
    expectNoHttp(mock);
  });

  it('refuses a delete carrying content on every provider with zero HTTP', async () => {
    const { client, mock } = buildClient({}, routes);
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'delete', content: 'hi' }],
      }),
      { code: 'INVALID_ARGUMENT', provider },
    );
    expectNoHttp(mock);
  });

  it('refuses create/update without content on every provider', async () => {
    for (const action of ['create', 'update'] as const) {
      const { client, mock } = buildClient({}, routes);
      await expectError(
        client.pushFiles({
          provider,
          ...REPO,
          branch: 'dev',
          message: 'm',
          files: [{ path: 'a.txt', action }],
        }),
        { code: 'INVALID_ARGUMENT', provider },
      );
      expectNoHttp(mock);
    }
  });

  it('refuses invalid base64 on every provider', async () => {
    const { client, mock } = buildClient({}, routes);
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create', content: '%%%', encoding: 'base64' }],
      }),
      { code: 'INVALID_ARGUMENT', provider },
    );
    expectNoHttp(mock);
  });
});
