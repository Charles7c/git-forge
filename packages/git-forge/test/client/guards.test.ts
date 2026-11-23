import { describe, expect, it } from 'vitest';

import { GitClient } from '../../src/client.js';
import { CAPABILITY_IDS, PROVIDERS, WRITE_CAPABILITIES } from '../../src/index.js';
import type { CapabilityId, Provider } from '../../src/index.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import { expectError, expectNoHttp, TEST_TOKEN } from '../helpers/expectError.js';
import { REPO, buildClient, buildTokenlessClient } from '../helpers/clientHarness.js';

/**
 * Gate-level guarantees of the facade.
 *
 * Three properties are proven here, and each is stated for every provider so a
 * platform cannot regress alone:
 *
 * 1. A missing token refuses the call with zero HTTP.
 * 2. `readonly` refuses all 12 write capabilities with zero HTTP while every
 *    read capability still works.
 * 3. Gate order is fixed: validation, then read-only, then token, then method
 *    capability, then parameter capability.
 */

/** Fixture bodies good enough to satisfy each adapter's mapper. */
const ISSUE = {
  number: 101,
  title: 'an issue',
  state: 'open',
  html_url: 'https://example.com/issues/101',
  labels: [],
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  user: { login: 'tester' },
};

const PULL = {
  number: 304,
  title: 'a pull request',
  state: 'open',
  html_url: 'https://example.com/pulls/304',
  head: { ref: 'feat/x', sha: 'a'.repeat(40) },
  base: { ref: 'dev', sha: 'b'.repeat(40) },
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const REPOSITORY = {
  id: 1,
  name: 'demo-kit',
  full_name: 'example-org/demo-kit',
  owner: { login: 'example-org' },
  namespace: { path: 'example-org' },
  html_url: 'https://example.com/example-org/demo-kit',
  web_url: 'https://example.com/example-org/demo-kit',
  private: false,
  public: true,
  default_branch: 'dev',
};

const BRANCH = { name: 'dev', commit: { sha: 'c'.repeat(40) } };

const COMMIT = {
  sha: 'd'.repeat(40),
  html_url: 'https://example.com/commit/d',
  commit: {
    message: 'initial',
    author: { name: 'A', email: 'a@example.com', date: '2025-01-01T00:00:00Z' },
    committer: { name: 'A', email: 'a@example.com', date: '2025-01-01T00:00:00Z' },
  },
  parents: [],
};

const COMMENT = {
  id: 1,
  body: 'hello',
  created_at: '2025-01-01T00:00:00Z',
  html_url: 'https://example.com/c/1',
  user: { login: 'tester' },
};

const CONTENT = {
  name: 'README.md',
  path: 'README.md',
  sha: 'e'.repeat(40),
  size: 5,
  html_url: 'https://example.com/blob/dev/README.md',
  type: 'file',
  content: 'aGk=',
  encoding: 'base64',
};

/** A write response carrying a commit, accepted by every adapter. */
const WRITE = {
  content: { html_url: 'https://example.com/blob/dev/a.txt' },
  commit: {
    sha: 'f'.repeat(40),
    html_url: 'https://example.com/commit/f',
  },
};

/**
 * One callable per method-level capability, all with a payload that passes
 * validation, so a test can drive the gate machinery for each of the 24.
 */
const CALLS: Readonly<
  Record<
    CapabilityId,
    { method: string; invoke: (client: GitClient, provider: Provider) => Promise<unknown> }
  >
> = {
  'issues.list': {
    method: 'listIssues',
    invoke: (c, provider) => c.listIssues({ provider, ...REPO }),
  },
  'issues.get': {
    method: 'getIssue',
    invoke: (c, provider) => c.getIssue({ provider, ...REPO, number: 1 }),
  },
  'issues.create': {
    method: 'createIssue',
    invoke: (c, provider) => c.createIssue({ provider, ...REPO, title: 't' }),
  },
  'issues.update': {
    method: 'updateIssue',
    invoke: (c, provider) => c.updateIssue({ provider, ...REPO, number: 1, title: 't' }),
  },
  'issues.listComments': {
    method: 'listIssueComments',
    invoke: (c, provider) => c.listIssueComments({ provider, ...REPO, number: 1 }),
  },
  'issues.createComment': {
    method: 'createIssueComment',
    invoke: (c, provider) => c.createIssueComment({ provider, ...REPO, number: 1, body: 'b' }),
  },
  'pulls.list': {
    method: 'listPullRequests',
    invoke: (c, provider) => c.listPullRequests({ provider, ...REPO }),
  },
  'pulls.get': {
    method: 'getPullRequest',
    invoke: (c, provider) => c.getPullRequest({ provider, ...REPO, number: 1 }),
  },
  'pulls.create': {
    method: 'createPullRequest',
    invoke: (c, provider) =>
      c.createPullRequest({ provider, ...REPO, title: 't', head: 'h', base: 'b' }),
  },
  'pulls.merge': {
    method: 'mergePullRequest',
    invoke: (c, provider) => c.mergePullRequest({ provider, ...REPO, number: 1 }),
  },
  'pulls.listComments': {
    method: 'listPullRequestComments',
    invoke: (c, provider) => c.listPullRequestComments({ provider, ...REPO, number: 1 }),
  },
  'pulls.createComment': {
    method: 'createPullRequestComment',
    invoke: (c, provider) =>
      c.createPullRequestComment({ provider, ...REPO, number: 1, body: 'b' }),
  },
  'repos.list': {
    method: 'listRepositories',
    invoke: (c, provider) => c.listRepositories({ provider }),
  },
  'repos.get': {
    method: 'getRepository',
    invoke: (c, provider) => c.getRepository({ provider, ...REPO }),
  },
  'repos.create': {
    method: 'createRepository',
    invoke: (c, provider) => c.createRepository({ provider, name: 'n' }),
  },
  'repos.getFileContents': {
    method: 'getFileContents',
    invoke: (c, provider) => c.getFileContents({ provider, ...REPO, path: 'README.md' }),
  },
  'files.create': {
    method: 'createOrUpdateFile',
    invoke: (c, provider) =>
      c.createOrUpdateFile({ provider, ...REPO, path: 'a.txt', content: 'aGk=', message: 'm' }),
  },
  'files.update': {
    method: 'createOrUpdateFile',
    invoke: (c, provider) =>
      c.createOrUpdateFile({
        provider,
        ...REPO,
        path: 'a.txt',
        content: 'aGk=',
        message: 'm',
        sha: 'e'.repeat(40),
      }),
  },
  'files.delete': {
    method: 'deleteFile',
    invoke: (c, provider) =>
      c.deleteFile({ provider, ...REPO, path: 'a.txt', message: 'm', sha: 'e'.repeat(40) }),
  },
  'files.pushFiles': {
    method: 'pushFiles',
    invoke: (c, provider) =>
      c.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create', content: 'hi' }],
      }),
  },
  'branches.list': {
    method: 'listBranches',
    invoke: (c, provider) => c.listBranches({ provider, ...REPO }),
  },
  'branches.create': {
    method: 'createBranch',
    invoke: (c, provider) => c.createBranch({ provider, ...REPO, name: 'n', from: 'dev' }),
  },
  'commits.list': {
    method: 'listCommits',
    invoke: (c, provider) => c.listCommits({ provider, ...REPO }),
  },
  'commits.get': {
    method: 'getCommit',
    invoke: (c, provider) => c.getCommit({ provider, ...REPO, sha: 'a'.repeat(40) }),
  },
};

/**
 * Routes that answer every capability with a shape its mapper accepts.
 *
 * Git-specific routes come first because the generic `/commits` route would
 * otherwise shadow `GET /git/commits/{sha}`.
 */
const HAPPY_ROUTES = [
  {
    match: '/git/trees/' + 'b'.repeat(40),
    responses: [jsonResponse({ truncated: false, tree: [] })],
  },
  { match: /\/git\/ref\/heads\//, responses: [jsonResponse({ object: { sha: 'a'.repeat(40) } })] },
  {
    match: /\/git\/refs\/heads\//,
    responses: [jsonResponse({ ref: 'refs/heads/dev', object: { sha: 'e'.repeat(40) } })],
  },
  {
    match: /\/git\/commits\/[0-9a-f]+/,
    responses: [jsonResponse({ sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } })],
  },
  { match: /\/git\/trees$/, responses: [jsonResponse({ sha: 'c'.repeat(40) })] },
  { match: /\/git\/blobs$/, responses: [jsonResponse({ sha: 'd'.repeat(40) })] },
  {
    match: /\/git\/commits$/,
    responses: [jsonResponse({ sha: 'e'.repeat(40), html_url: 'https://example.com/c/e' })],
  },
  {
    match: (call: { url: string; method: string }) =>
      call.method === 'POST' && /\/commits$/.test(new URL(call.url).pathname),
    responses: [jsonResponse({ sha: 'f'.repeat(40), html_url: 'https://example.com/c/f' })],
  },
  { match: /\/issues\/\d+\/comments/, responses: [jsonResponse([COMMENT])] },
  { match: /\/pulls\/\d+\/comments/, responses: [jsonResponse([COMMENT])] },
  { match: /\/issues\/\d+$/, responses: [jsonResponse(ISSUE)] },
  { match: /\/pulls\/\d+\/merge/, responses: [jsonResponse({ merged: true })] },
  { match: /\/pulls\/\d+$/, responses: [jsonResponse(PULL)] },
  { match: /\/issues(\?|$)/, responses: [jsonResponse([ISSUE])] },
  { match: /\/pulls(\?|$)/, responses: [jsonResponse([PULL])] },
  { match: /\/issues$/, responses: [jsonResponse(ISSUE)] },
  { match: /\/pulls$/, responses: [jsonResponse(PULL)] },
  { match: /\/contents\//, responses: [jsonResponse(CONTENT)] },
  { match: /\/contents$/, responses: [jsonResponse(CONTENT)] },
  { match: /\/branches$/, responses: [jsonResponse([BRANCH])] },
  { match: /\/branches/, responses: [jsonResponse(BRANCH)] },
  { match: /\/commits\/[0-9a-f]+/, responses: [jsonResponse(COMMIT)] },
  { match: /\/commits/, responses: [jsonResponse([COMMIT])] },
  { match: /\/repos/, responses: [jsonResponse([REPOSITORY])] },
  { match: /.*/, responses: [jsonResponse(WRITE)] },
];

describe('facade wiring', () => {
  it('exposes the 24 capabilities of every provider', () => {
    const { client } = buildClient();
    for (const provider of PROVIDERS) {
      expect(Object.keys(client.capabilities(provider)).sort()).toEqual([...CAPABILITY_IDS].sort());
    }
  });

  it('reports configured providers by name only', () => {
    const { client } = buildClient();
    expect(client.configuredProviders()).toEqual(['github', 'gitee', 'atomgit']);

    const tokenless = buildTokenlessClient().client;
    expect(tokenless.configuredProviders()).toEqual([]);
  });

  it('refuses a plain-http base URL for a real host', () => {
    expect(
      () => new GitClient({ github: { token: TEST_TOKEN, baseUrl: 'http://api.github.com' } }),
    ).toThrow(/https:/);
  });

  it('accepts a loopback base URL so tests and proxies can be pointed at', () => {
    expect(
      () => new GitClient({ github: { token: TEST_TOKEN, baseUrl: 'http://localhost:8080' } }),
    ).not.toThrow();
    expect(
      () => new GitClient({ gitee: { token: TEST_TOKEN, baseUrl: 'http://127.0.0.1:9000' } }),
    ).not.toThrow();
  });

  it('refuses an unparseable base URL', () => {
    expect(() => new GitClient({ github: { token: TEST_TOKEN, baseUrl: 'not-a-url' } })).toThrow(
      /absolute URL/,
    );
  });

  it('refuses a plain-http web base URL as well', () => {
    expect(
      () => new GitClient({ github: { token: TEST_TOKEN, webBaseUrl: 'http://github.com' } }),
    ).toThrow(/https:/);
  });

  it('rejects an unknown provider before anything else', async () => {
    const { client, mock } = buildClient();
    const promise = client.getRepository({ provider: 'gitlab' as Provider, ...REPO });
    await expectError(promise, { code: 'INVALID_ARGUMENT', messageIncludes: ['provider'] });
    expectNoHttp(mock);
  });

  it('delegates bulk to the shared runner', async () => {
    const { client } = buildClient();
    const results = await client.bulk([1, 2, 3], (item) => Promise.resolve(item * 2));
    expect(results).toEqual([
      { ok: true, value: 2, index: 0 },
      { ok: true, value: 4, index: 1 },
      { ok: true, value: 6, index: 2 },
    ]);
  });
});

describe.each(PROVIDERS)('token gate (%s)', (provider) => {
  it('refuses every method with AUTH_MISSING before any request', async () => {
    const { client, mock } = buildTokenlessClient();
    for (const [capability, call] of Object.entries(CALLS)) {
      const error = await expectError(
        call.invoke(client, provider),
        {
          code: 'AUTH_MISSING',
          provider,
          messageIncludes: [String(capability).split('.')[0] === 'pulls' ? 'TOKEN' : 'TOKEN'],
        },
        [],
      );
      expect(error.message).toContain(`provider=${provider}`);
    }
    expectNoHttp(mock);
  });

  it('names the environment variable that would fix it', async () => {
    const { client } = buildTokenlessClient();
    const error = await expectError(
      client.listIssues({ provider, ...REPO }),
      { code: 'AUTH_MISSING', provider },
      [],
    );
    const envVar = { github: 'GITHUB_TOKEN', gitee: 'GITEE_TOKEN', atomgit: 'ATOMGIT_TOKEN' }[
      provider
    ];
    expect(error.message).toContain(envVar);
  });
});

describe.each(PROVIDERS)('read-only gate (%s)', (provider) => {
  it('blocks exactly the 12 write capabilities with zero HTTP', async () => {
    const { client, mock } = buildClient({ readonly: true }, HAPPY_ROUTES);
    expect(WRITE_CAPABILITIES.size).toBe(12);

    for (const capability of WRITE_CAPABILITIES) {
      const call = CALLS[capability];
      const error = await expectError(call.invoke(client, provider), {
        code: 'READONLY_BLOCKED',
        provider,
        capability,
      });
      expect(error.message).toContain(call.method);
    }
    expectNoHttp(mock);
  });

  it('still serves the 12 read capabilities', async () => {
    const { client } = buildClient({ readonly: true }, HAPPY_ROUTES);
    for (const capability of CAPABILITY_IDS) {
      if (WRITE_CAPABILITIES.has(capability)) {
        continue;
      }
      await expect(CALLS[capability].invoke(client, provider)).resolves.toBeDefined();
    }
  });

  it('lets a read through before the token gate would apply', async () => {
    // A read on a tokenless client must report AUTH_MISSING, proving read-only
    // did not short-circuit it: the gate only refuses writes.
    const { client, mock } = buildTokenlessClient();
    await expectError(
      client.listIssues({ provider, ...REPO }),
      { code: 'AUTH_MISSING', provider },
      [],
    );
    expectNoHttp(mock);
  });
});

describe.each(PROVIDERS)('gate ordering (%s)', (provider) => {
  it('reports INVALID_ARGUMENT before AUTH_MISSING for a malformed call', async () => {
    // No token and a bad title: validation must win, so the caller learns about
    // the payload rather than about credentials.
    const { client, mock } = buildTokenlessClient();
    const error = await expectError(
      client.createIssue({ provider, ...REPO, title: '' }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['title'] },
      [],
    );
    expect(error.code).not.toBe('AUTH_MISSING');
    expectNoHttp(mock);
  });

  it('reports INVALID_ARGUMENT before READONLY_BLOCKED for a malformed write', async () => {
    const { client, mock } = buildClient({ readonly: true });
    await expectError(client.createIssue({ provider, ...REPO, title: '' }), {
      code: 'INVALID_ARGUMENT',
      provider,
    });
    expectNoHttp(mock);
  });

  it('reports READONLY_BLOCKED before AUTH_MISSING for a valid write', async () => {
    // Both gates would refuse; read-only is reported because it is decidable
    // offline and does not depend on credentials.
    const { client, mock } = buildTokenlessClient({ readonly: true });
    const error = await expectError(client.createIssue({ provider, ...REPO, title: 't' }), {
      code: 'READONLY_BLOCKED',
      provider,
      capability: 'issues.create',
    });
    expect(error.code).not.toBe('AUTH_MISSING');
    expectNoHttp(mock);
  });

  it('reports AUTH_MISSING before UNSUPPORTED_ON_PROVIDER on a gapped method', async () => {
    // AtomGit has no pushFiles; with no token the fixable problem is reported
    // first. Other providers cannot reach the capability gate for this call.
    const { client, mock } = buildTokenlessClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create', content: 'hi' }],
      }),
      { code: 'AUTH_MISSING', provider },
      [],
    );
    expectNoHttp(mock);
  });

  it('reports READONLY_BLOCKED before UNSUPPORTED_ON_PROVIDER on a gapped method', async () => {
    const { client, mock } = buildClient({ readonly: true });
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create', content: 'hi' }],
      }),
      { code: 'READONLY_BLOCKED', provider, capability: 'files.pushFiles' },
    );
    expectNoHttp(mock);
  });

  it('reports INVALID_ARGUMENT before UNSUPPORTED_ON_PROVIDER for a bad push batch', async () => {
    // Empty batch + AtomGit's missing capability: the payload problem is
    // reported first because it is the caller's own mistake.
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({ provider, ...REPO, branch: 'dev', message: 'm', files: [] }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['files'] },
    );
    expectNoHttp(mock);
  });
});

describe.each(PROVIDERS)('capability gate (%s)', (provider) => {
  it('blocks pushFiles only on AtomGit, and issues no request', async () => {
    const { client, mock } = buildClient({}, HAPPY_ROUTES);
    const call = client.pushFiles({
      provider,
      ...REPO,
      branch: 'dev',
      message: 'm',
      files: [{ path: 'a.txt', action: 'create', content: 'hi' }],
    });

    if (provider === 'atomgit') {
      await expectError(call, {
        code: 'UNSUPPORTED_ON_PROVIDER',
        provider,
        capability: 'files.pushFiles',
        messageIncludes: ['files.pushFiles'],
      });
      expectNoHttp(mock);
      return;
    }

    await expect(call).resolves.toMatchObject({ provider });
    expect(mock.calls.length).toBeGreaterThan(0);
  });
});
