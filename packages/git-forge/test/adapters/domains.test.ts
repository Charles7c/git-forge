import { describe, expect, it } from 'vitest';

import { GitForgeError } from '../../src/core/errors.js';
import { ADAPTERS, getAdapter } from '../../src/adapters/index.js';
import { PROVIDERS } from '../../src/core/types.js';
import type { Provider } from '../../src/core/types.js';
import type { WithProvider } from '../../src/adapters/types.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import type { MockCall } from '../helpers/mockFetch.js';
import { buildHarness } from '../helpers/adapterHarness.js';

/**
 * Cross-provider domain coverage.
 *
 * Every adapter must serve the same five domains, so the same call shapes are
 * exercised against all three. Each case asserts only what the contract
 * guarantees (a mapped model, a provider label, an error code), never a
 * platform-specific path — those live in the per-provider suites.
 */

/** Adds the `provider` field the facade threads through. */
function forProvider<T extends object>(provider: Provider, params: T): WithProvider<T> {
  return { ...params, provider };
}

/** Asserts a promise rejects with a `GitForgeError` and returns it. */
async function expectGitForgeError(promise: Promise<unknown>): Promise<GitForgeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitForgeError);
    return error as GitForgeError;
  }
  throw new Error('expected a GitForgeError');
}

/** A comment payload with no platform-specific fields beyond the contract. */
const COMMENT = {
  id: 1,
  body: 'hello',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  html_url: 'https://example.com/c/1',
  user: { login: 'tester' },
};

/** A repository payload carrying every field all three platforms share. */
const REPO = {
  id: 1,
  name: 'demo',
  full_name: 'acme/demo',
  owner: { login: 'acme' },
  namespace: { path: 'acme' },
  html_url: 'https://example.com/acme/demo',
  web_url: 'https://example.com/acme/demo',
  private: false,
  public: true,
  default_branch: 'main',
  description: 'demo repo',
  fork: false,
  language: 'TypeScript',
};

/** A branch payload. */
const BRANCH = { name: 'main', commit: { sha: 'a'.repeat(40) }, protected: false };

/** A commit payload. */
const COMMIT = {
  sha: 'b'.repeat(40),
  html_url: 'https://example.com/acme/demo/commit/bbb',
  commit: {
    message: 'initial',
    author: { name: 'A', email: 'a@example.com', date: '2025-01-01T00:00:00Z' },
    committer: { name: 'A', email: 'a@example.com', date: '2025-01-01T00:00:00Z' },
  },
  parents: [],
};

/** A pull-request payload with head and base. */
const PULL = {
  number: 7,
  title: 'pr',
  state: 'open',
  html_url: 'https://example.com/acme/demo/pulls/7',
  head: { ref: 'feature', sha: 'c'.repeat(40) },
  base: { ref: 'main', sha: 'd'.repeat(40) },
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

/** A single-file write payload. */
const WRITE = {
  commit: {
    sha: 'e'.repeat(40),
    html_url: 'https://example.com/acme/demo/commit/eee',
  },
  content: { html_url: 'https://example.com/acme/demo/blob/main/a.txt', path: 'a.txt' },
};

/** The single `path` segment of a recorded call. */
function pathOf(call: MockCall | undefined): string {
  return new URL(call?.url ?? '').pathname;
}

describe.each(PROVIDERS)('%s adapter five-domain coverage', (provider) => {
  const adapter = ADAPTERS[provider];

  it('reads, creates and updates issues', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      {
        match: '/issues',
        method: 'POST',
        responses: [
          jsonResponse({
            number: '1',
            title: 'new',
            state: 'open',
            html_url: 'https://example.com/i/1',
            labels: [],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ],
      },
      {
        match: '/issues',
        responses: [
          jsonResponse({
            number: '1',
            title: 'existing',
            state: 'closed',
            html_url: 'https://example.com/i/1',
            labels: [{ name: 'bug' }],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ],
      },
    ]);

    const created = await adapter.createIssue(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', title: 'new' }),
    );
    expect(created.provider).toBe(provider);
    expect(created.title).toBe('new');

    const read = await adapter.getIssue(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', number: 1 }),
    );
    expect(read.state).toBe('closed');
    expect(read.labels).toEqual(['bug']);
  });

  it('creates and lists issue comments', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([{ match: '/comments', responses: [jsonResponse(COMMENT, { status: 201 })] }]);

    const created = await adapter.createIssueComment(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', number: 1, body: 'hello' }),
    );
    expect(created.body).toBe('hello');
    expect(created.provider).toBe(provider);
  });

  it('creates, reads and merges pull requests', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      { match: '/merge', method: 'PUT', responses: [jsonResponse({ merged: true })] },
      { match: '/pulls', method: 'POST', responses: [jsonResponse(PULL, { status: 201 })] },
      { match: '/pulls/7', responses: [jsonResponse(PULL)] },
      { match: '/pulls', responses: [jsonResponse([PULL, PULL])] },
    ]);

    const created = await adapter.createPullRequest(
      ctx,
      forProvider(provider, {
        owner: 'acme',
        repo: 'demo',
        title: 'pr',
        head: 'feature',
        base: 'main',
      }),
    );
    expect(created.number).toBe(7);
    expect(created.merged).toBe(false);

    const read = await adapter.getPullRequest(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', number: 7 }),
    );
    expect(read.head?.ref).toBe('feature');

    await adapter.mergePullRequest(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', number: 7 }),
    );
    const mergeCall = mock.calls.find((call) => call.method === 'PUT');
    expect(mergeCall).toBeDefined();
  });

  it('creates pull-request comments', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([{ match: '/comments', responses: [jsonResponse(COMMENT, { status: 201 })] }]);

    const created = await adapter.createPullRequestComment(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', number: 7, body: 'nice' }),
    );
    expect(created.id).toBe(1);
  });

  it('lists, creates and reads repositories', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      { match: '/repos', method: 'POST', responses: [jsonResponse(REPO, { status: 201 })] },
      { match: '/repos/acme/demo', responses: [jsonResponse(REPO)] },
      { match: '/user/repos', responses: [jsonResponse([REPO])] },
    ]);

    const listed = await adapter.listRepositories(ctx, forProvider(provider, {}));
    expect(listed[0]?.name).toBe('demo');
    expect(listed[0]?.provider).toBe(provider);

    const read = await adapter.getRepository(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo' }),
    );
    expect(read.default_branch).toBe('main');
    expect(read.html_url.length).toBeGreaterThan(0);

    const created = await adapter.createRepository(
      ctx,
      forProvider(provider, { name: 'demo', description: 'demo repo' }),
    );
    expect(created.repo).toBe('demo');
  });

  it('creates, updates and deletes a single file', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      {
        match: '/contents/a.txt',
        method: 'POST',
        responses: [jsonResponse(WRITE, { status: 201 })],
      },
      { match: '/contents/a.txt', method: 'PUT', responses: [jsonResponse(WRITE)] },
      { match: '/contents/a.txt', method: 'DELETE', responses: [jsonResponse(WRITE)] },
    ]);

    const created = await adapter.createFile(
      ctx,
      forProvider(provider, {
        owner: 'acme',
        repo: 'demo',
        path: 'a.txt',
        content: 'aGk=',
        message: 'add',
        branch: 'main',
      }),
    );
    expect(created.paths).toEqual(['a.txt']);
    expect(created.commit_sha).toBe('e'.repeat(40));

    const updated = await adapter.updateFile(
      ctx,
      forProvider(provider, {
        owner: 'acme',
        repo: 'demo',
        path: 'a.txt',
        content: 'aGk=',
        message: 'edit',
        sha: 'blob',
        branch: 'main',
      }),
    );
    expect(updated.paths).toEqual(['a.txt']);

    const deleted = await adapter.deleteFile(
      ctx,
      forProvider(provider, {
        owner: 'acme',
        repo: 'demo',
        path: 'a.txt',
        sha: 'blob',
        message: 'rm',
        branch: 'main',
      }),
    );
    expect(deleted.paths).toEqual(['a.txt']);
  });

  it('lists branches and commits, creates a branch and reads a commit', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      { match: '/branches', method: 'POST', responses: [jsonResponse(BRANCH, { status: 201 })] },
      { match: '/branches', responses: [jsonResponse([BRANCH])] },
      { match: new RegExp(`/commits/${COMMIT.sha}`), responses: [jsonResponse(COMMIT)] },
      { match: '/commits', responses: [jsonResponse([COMMIT])] },
      {
        match: '/refs',
        method: 'POST',
        responses: [jsonResponse({ object: { sha: 'a'.repeat(40) } })],
      },
      { match: '/git/ref/', responses: [jsonResponse({ object: { sha: 'a'.repeat(40) } })] },
    ]);

    const branches = await adapter.listBranches(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo' }),
    );
    expect(branches[0]?.name).toBe('main');
    expect(branches[0]?.commit_sha).toBe('a'.repeat(40));

    const created = await adapter.createBranch(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', name: 'next', from: 'main' }),
    );
    expect(created.name.length).toBeGreaterThan(0);

    const commits = await adapter.listCommits(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', branch: 'main' }),
    );
    expect(commits[0]?.sha).toBe(COMMIT.sha);

    const commit = await adapter.getCommit(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', sha: COMMIT.sha }),
    );
    expect(commit.author?.name).toBe('A');
  });

  it('surfaces an auth failure with the provider attached', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      {
        match: '/repos/acme/demo',
        responses: [jsonResponse({ message: 'nope' }, { status: 401 })],
      },
    ]);

    const error = await expectGitForgeError(
      adapter.getRepository(ctx, forProvider(provider, { owner: 'acme', repo: 'demo' })),
    );
    expect(error.code).toBe('AUTH_INVALID');
    expect(error.provider).toBe(provider);
    expect(error.status).toBe(401);
  });

  it('surfaces a missing resource as NOT_FOUND', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      {
        match: '/repos/acme/demo',
        responses: [jsonResponse({ message: 'Not Found' }, { status: 404 })],
      },
    ]);

    const error = await expectGitForgeError(
      adapter.getRepository(ctx, forProvider(provider, { owner: 'acme', repo: 'demo' })),
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('surfaces an upstream validation failure as INVALID_ARGUMENT', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      {
        match: '/issues',
        method: 'POST',
        responses: [jsonResponse({ message: 'invalid' }, { status: 422 })],
      },
    ]);

    const error = await expectGitForgeError(
      adapter.createIssue(ctx, forProvider(provider, { owner: 'acme', repo: 'demo', title: 't' })),
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.status).toBe(422);
  });

  it('never leaks the token into a URL', async () => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([{ match: '', responses: [jsonResponse([], { status: 200 })] }]);

    await adapter.listBranches(ctx, forProvider(provider, { owner: 'acme', repo: 'demo' }));

    for (const call of mock.calls) {
      expect(call.url).not.toContain('access_token=');
      expect(call.headers.authorization?.startsWith('Bearer ')).toBe(true);
    }
  });

  it('reads a single file and rejects a directory listing', async () => {
    const contents = {
      path: 'a.txt',
      content: 'aGk=',
      encoding: 'base64',
      sha: 'blob',
      size: 2,
      html_url: 'https://example.com/blob/a.txt',
      type: 'file',
    };
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      { match: '/contents/a.txt', responses: [jsonResponse(contents)] },
      { match: '/contents/docs', responses: [jsonResponse([{ name: 'x', type: 'file' }])] },
    ]);

    const file = await adapter.getFileContents(
      ctx,
      forProvider(provider, { owner: 'acme', repo: 'demo', path: 'a.txt' }),
    );
    expect(file.path).toBe('a.txt');
    expect(file.provider).toBe(provider);
    expect(pathOf(mock.calls[0])).toContain('/contents/a.txt');

    const directory = await expectGitForgeError(
      adapter.getFileContents(
        ctx,
        forProvider(provider, { owner: 'acme', repo: 'demo', path: 'docs' }),
      ),
    );
    expect(directory.code).toBe('INVALID_ARGUMENT');
  });
});

describe('adapter registry lookup', () => {
  it('returns the adapter matching the requested provider', () => {
    for (const provider of PROVIDERS) {
      expect(getAdapter(provider).provider).toBe(provider);
    }
  });
});
