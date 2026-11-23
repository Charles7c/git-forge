import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GitForgeError } from '../../src/core/errors.js';
import { githubAdapter } from '../../src/adapters/github/adapter.js';
import { CAPABILITY_IDS } from '../../src/core/types.js';
import type { ListIssuesParams, ListPullRequestsParams } from '../../src/core/types.js';
import type { WithProvider } from '../../src/adapters/types.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import type { MockRoute } from '../helpers/mockFetch.js';
import {
  buildHarness,
  capabilityState,
  expectCompleteCapabilityTable,
  paramCapabilityState,
} from '../helpers/adapterHarness.js';

/** Loads a fixture from `test/fixtures/github`. */
async function fixture(name: string): Promise<unknown> {
  const path = fileURLToPath(new URL(`../fixtures/github/${name}.json`, import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Adds the `provider` field the facade threads through every call. */
function withProvider<T extends object>(params: T): WithProvider<T> {
  return { ...params, provider: 'github' };
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

describe('github adapter capability table', () => {
  it('declares all 24 method-level capabilities', () => {
    expectCompleteCapabilityTable(githubAdapter);
    expect(Object.keys(githubAdapter.capabilities)).toHaveLength(24);
    expect(Object.keys(githubAdapter.capabilities)).toHaveLength(CAPABILITY_IDS.length);
  });

  it('supports every capability, including the atomic batch commit', () => {
    for (const id of CAPABILITY_IDS) {
      expect(capabilityState(githubAdapter, id)).toBe('supported');
    }
    expect(capabilityState(githubAdapter, 'files.pushFiles')).toBe('supported');
    expect(paramCapabilityState(githubAdapter, 'files.pushFiles.atomic')).toBe('supported');
  });

  it('supports the head and milestone filters', () => {
    expect(paramCapabilityState(githubAdapter, 'pulls.list.headFilter')).toBe('supported');
    expect(paramCapabilityState(githubAdapter, 'pulls.list.milestoneFilter')).toBe('supported');
    expect(paramCapabilityState(githubAdapter, 'issues.list.milestoneFilter')).toBe('supported');
  });
});

describe('github adapter request conventions', () => {
  it('sends bearer auth, the pinned API version and api.github.com', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/issues/101', responses: [jsonResponse(issue)] }]);

    await githubAdapter.getIssue(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 101 }),
    );

    const [call] = mock.calls;
    expect(call).toBeDefined();
    expect(call?.url.startsWith('https://api.github.com/repos/example-org/demo-kit')).toBe(true);
    expect(call?.headers.authorization).toBe(`Bearer ${['adapter', 'fixture', 'token'].join('-')}`);
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(call?.headers.accept).toBe('application/vnd.github+json');
    expect(call?.url).not.toContain('access_token=');
  });
});

describe('github adapter issues', () => {
  it('aggregates pages and filters out pull requests', async () => {
    const page1 = await fixture('issues-page-1');
    const page2 = await fixture('issues-page-2');
    const { ctx, mock } = buildHarness(githubAdapter);
    // Matched on the parsed `page` value: a substring match on "page=1" would
    // also hit "per_page=100" and loop over page one forever.
    mock.setRoutes([
      {
        match: (call) => new URL(call.url).searchParams.get('page') === '1',
        responses: [
          jsonResponse(page1, {
            headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
          }),
        ],
      },
      {
        match: (call) => new URL(call.url).searchParams.get('page') === '2',
        responses: [jsonResponse(page2)],
      },
    ]);

    const issues = await githubAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'example-org', repo: 'demo-kit' }),
    );

    // Page one holds one issue and one pull request; only the issue survives.
    expect(issues.map((issue) => issue.number)).toEqual(['101', '103']);
    expect(issues.every((issue) => issue.number_as_number !== undefined)).toBe(true);
    expect(issues[0]).toMatchObject({
      provider: 'github',
      owner: 'example-org',
      repo: 'demo-kit',
      state: 'open',
      labels: ['enhancement', 'docs'],
      html_url: 'https://github.com/example-org/demo-kit/issues/101',
      comments_count: 3,
      created_at: '2025-01-05T12:34:56Z',
    });
    expect(issues[1]?.state).toBe('closed');
    expect(issues[1]?.labels).toEqual(['bug']);
    expect(mock.calls).toHaveLength(2);
  });

  it('joins labels and forwards the state filter', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([])] }]);

    await githubAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({
        owner: 'example-org',
        repo: 'demo-kit',
        state: 'closed',
        labels: ['bug', 'docs'],
        milestone: 3,
      }),
    );

    const url = new URL(mock.calls[0]?.url ?? '');
    expect(url.searchParams.get('state')).toBe('closed');
    expect(url.searchParams.get('labels')).toBe('bug,docs');
    expect(url.searchParams.get('milestone')).toBe('3');
  });

  it('maps a single issue and derives the numeric alias', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/issues/101', responses: [jsonResponse(issue)] }]);

    const result = await githubAdapter.getIssue(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 101 }),
    );

    expect(result.number).toBe('101');
    expect(result.number_as_number).toBe(101);
    expect(result.state).toBe('open');
    expect(result.assignees?.[0]?.login).toBe('example-author');
  });

  it('creates an issue through the repository-scoped path with a JSON body', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/issues', method: 'POST', responses: [jsonResponse(issue, { status: 201 })] },
    ]);

    const created = await githubAdapter.createIssue(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        title: 't',
        body: 'b',
        labels: ['bug'],
      }),
    );

    const [call] = mock.calls;
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('https://api.github.com/repos/example-org/demo-kit/issues');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.json).toMatchObject({ title: 't', body: 'b', labels: ['bug'] });
    expect(created.number).toBe('101');
  });

  it('surfaces a 401 as AUTH_INVALID with the provider attached', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/issues/1',
        responses: [jsonResponse({ message: 'Bad credentials' }, { status: 401 })],
      },
    ]);

    const error = await expectGitForgeError(
      githubAdapter.getIssue(ctx, withProvider({ owner: 'o', repo: 'r', number: 1 })),
    );
    expect(error.code).toBe('AUTH_INVALID');
    expect(error.provider).toBe('github');
    expect(error.status).toBe(401);
  });

  it('surfaces a 404 as NOT_FOUND', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/issues/999',
        responses: [jsonResponse({ message: 'Not Found' }, { status: 404 })],
      },
    ]);

    const error = await expectGitForgeError(
      githubAdapter.getIssue(ctx, withProvider({ owner: 'o', repo: 'r', number: 999 })),
    );
    expect(error.code).toBe('NOT_FOUND');
  });

  it('surfaces a 422 as INVALID_ARGUMENT', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/issues',
        method: 'POST',
        responses: [jsonResponse({ message: 'Validation Failed' }, { status: 422 })],
      },
    ]);

    const error = await expectGitForgeError(
      githubAdapter.createIssue(ctx, withProvider({ owner: 'o', repo: 'r', title: '' })),
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.status).toBe(422);
  });

  it('lists and creates issue comments', async () => {
    const comments = await fixture('comments');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/issues/101/comments', method: 'GET', responses: [jsonResponse(comments)] },
      {
        match: '/issues/101/comments',
        method: 'POST',
        responses: [jsonResponse((comments as unknown[])[0], { status: 201 })],
      },
    ]);

    const listed = await githubAdapter.listIssueComments(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 101 }),
    );
    expect(listed).toHaveLength(2);
    expect(listed[0]?.html_url).toBe(
      'https://github.com/example-org/demo-kit/issues/101#issuecomment-5020',
    );

    const created = await githubAdapter.createIssueComment(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 101, body: 'ok' }),
    );
    expect(created.id).toBe(5020);
  });
});

describe('github adapter pull requests', () => {
  it('lists pull requests and derives merged from the merged flag', async () => {
    const pulls = await fixture('pulls');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/pulls', responses: [jsonResponse(pulls)] }]);

    const result = await githubAdapter.listPullRequests(
      ctx,
      withProvider<ListPullRequestsParams>({
        owner: 'example-org',
        repo: 'demo-kit',
        state: 'all',
      }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      number: 304,
      state: 'open',
      merged: false,
      html_url: 'https://github.com/example-org/demo-kit/pull/304',
    });
    expect(result[0]?.head).toEqual({
      ref: 'feat/sample',
      sha: 'ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03',
    });
    expect(result[1]?.merged).toBe(true);
    expect(result[1]?.state).toBe('closed');
    expect(result[1]?.merged_at).toBe('2025-03-05T00:00:00Z');
  });

  it('forwards head, base and milestone filters', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/pulls', responses: [jsonResponse([])] }]);

    await githubAdapter.listPullRequests(
      ctx,
      withProvider<ListPullRequestsParams>({
        owner: 'o',
        repo: 'r',
        head: 'example-org:feat',
        base: 'dev',
        milestone: 2,
        labels: ['bug'],
      }),
    );

    const url = new URL(mock.calls[0]?.url ?? '');
    expect(url.searchParams.get('head')).toBe('example-org:feat');
    expect(url.searchParams.get('base')).toBe('dev');
    expect(url.searchParams.get('milestone')).toBe('2');
    expect(url.searchParams.get('labels')).toBe('bug');
  });

  it('reads one pull request', async () => {
    const pull = await fixture('pull');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/pulls/304', responses: [jsonResponse(pull)] }]);

    const result = await githubAdapter.getPullRequest(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 304 }),
    );
    expect(result.number).toBe(304);
    expect(result.base.ref).toBe('dev');
  });

  it('merges then re-reads the pull request', async () => {
    const pull = await fixture('pull');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/pulls/304/merge',
        method: 'PUT',
        responses: [jsonResponse({ merged: true, sha: 'abc' })],
      },
      { match: '/pulls/304', method: 'GET', responses: [jsonResponse(pull)] },
    ]);

    const result = await githubAdapter.mergePullRequest(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        number: 304,
        merge_method: 'squash' as const,
      }),
    );

    expect(mock.calls[0]?.method).toBe('PUT');
    expect(mock.calls[0]?.json).toMatchObject({ merge_method: 'squash' });
    expect(mock.calls[1]?.method).toBe('GET');
    expect(result.number).toBe(304);
  });

  it('reuses the issue-comment endpoint for pull-request comments', async () => {
    const comments = await fixture('comments');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/issues/304/comments', responses: [jsonResponse(comments)] }]);

    const result = await githubAdapter.listPullRequestComments(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 304 }),
    );

    expect(mock.calls[0]?.url).toContain('/issues/304/comments');
    expect(result).toHaveLength(2);
  });
});

describe('github adapter repositories', () => {
  it('lists repositories with owner and repo taken from the payload', async () => {
    const repos = await fixture('repos');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/orgs/example-org/repos', responses: [jsonResponse(repos)] }]);

    const result = await githubAdapter.listRepositories(ctx, withProvider({ org: 'example-org' }));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      provider: 'github',
      owner: 'example-org',
      repo: 'demo-kit',
      html_url: 'https://github.com/example-org/demo-kit',
      default_branch: 'dev',
    });
  });

  it("lists a user's repositories through /users/{user}/repos", async () => {
    const repos = await fixture('repos');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/users/example-user/repos', responses: [jsonResponse(repos)] }]);

    const result = await githubAdapter.listRepositories(
      ctx,
      withProvider({ user: 'example-user' }),
    );

    // The `user` branch is distinct from the default `/user/repos`; asserting the
    // exact URL proves the placeholder was substituted into the right template.
    expect(mock.calls[0]?.url).toBe(
      'https://api.github.com/users/example-user/repos?per_page=100&page=1',
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.owner).toBe('example-org');
  });

  it('uses /user/repos when neither org nor user is given', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/user/repos', responses: [jsonResponse([])] }]);

    await githubAdapter.listRepositories(ctx, withProvider({}));
    expect(mock.calls[0]?.url).toBe('https://api.github.com/user/repos?per_page=100&page=1');
  });

  it('reads one repository', async () => {
    const repo = await fixture('repo');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/repos/example-org/demo-kit', responses: [jsonResponse(repo)] }]);

    const result = await githubAdapter.getRepository(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit' }),
    );
    expect(result.html_url).toBe('https://github.com/example-org/demo-kit');
  });

  it('creates a repository under an organization', async () => {
    const repo = await fixture('repo');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/orgs/example-org/repos',
        method: 'POST',
        responses: [jsonResponse(repo, { status: 201 })],
      },
    ]);

    const result = await githubAdapter.createRepository(
      ctx,
      withProvider({ name: 'demo-kit', org: 'example-org', private: true }),
    );

    expect(mock.calls[0]?.url).toBe('https://api.github.com/orgs/example-org/repos');
    expect(mock.calls[0]?.json).toMatchObject({ name: 'demo-kit', private: true });
    expect(result.repo).toBe('demo-kit');
  });

  it('maps file contents and keeps the platform encoding', async () => {
    const contents = await fixture('contents');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/contents/README.md', responses: [jsonResponse(contents)] }]);

    const result = await githubAdapter.getFileContents(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', path: 'README.md', ref: 'dev' }),
    );

    expect(result.path).toBe('README.md');
    expect(result.encoding).toBe('base64');
    expect(result.sha).toBe('ab04ab04ab04ab04ab04ab04ab04ab04ab04ab04');
    const url = new URL(mock.calls[0]?.url ?? '');
    expect(url.searchParams.get('ref')).toBe('dev');
  });

  it('rejects a directory response and maps a missing path to NOT_FOUND', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/contents/docs', responses: [jsonResponse([{ name: 'a.md', type: 'file' }])] },
      {
        match: '/contents/missing.md',
        responses: [jsonResponse({ message: 'Not Found' }, { status: 404 })],
      },
    ]);

    const dirError = await expectGitForgeError(
      githubAdapter.getFileContents(ctx, withProvider({ owner: 'o', repo: 'r', path: 'docs' })),
    );
    expect(dirError.code).toBe('INVALID_ARGUMENT');
    expect(dirError.message).toContain('directory');

    const missingError = await expectGitForgeError(
      githubAdapter.getFileContents(
        ctx,
        withProvider({ owner: 'o', repo: 'r', path: 'missing.md' }),
      ),
    );
    expect(missingError.code).toBe('NOT_FOUND');
  });

  it('encodes each path segment but keeps separators', async () => {
    const contents = await fixture('contents');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/contents/docs/a%20b.md', responses: [jsonResponse(contents)] }]);

    await githubAdapter.getFileContents(
      ctx,
      withProvider({ owner: 'o', repo: 'r', path: 'docs/a b.md' }),
    );
    expect(mock.calls[0]?.url).toContain('/contents/docs/a%20b.md');
  });
});

describe('github adapter branches and commits', () => {
  it('derives branch html_url without an extra request', async () => {
    const branches = await fixture('branches');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/branches', responses: [jsonResponse(branches)] }]);

    const result = await githubAdapter.listBranches(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit' }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.html_url).toBe('https://github.com/example-org/demo-kit/tree/dev');
    expect(result[1]?.html_url).toBe('https://github.com/example-org/demo-kit/tree/feat/sample');
    expect(result[1]?.protected).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  it('creates a branch from a sha without resolving it', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/git/refs',
        method: 'POST',
        responses: [
          jsonResponse({
            ref: 'refs/heads/feat/x',
            object: { sha: 'ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03', type: 'commit' },
          }),
        ],
      },
    ]);

    const branch = await githubAdapter.createBranch(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        name: 'feat/x',
        from: 'ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03',
      }),
    );

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.json).toMatchObject({
      ref: 'refs/heads/feat/x',
      sha: 'ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03',
    });
    expect(branch.html_url).toBe('https://github.com/example-org/demo-kit/tree/feat/x');
  });

  it('resolves a branch source through the refs endpoint first', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/git/ref/heads/dev',
        responses: [
          jsonResponse({
            ref: 'refs/heads/dev',
            object: { sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02' },
          }),
        ],
      },
      {
        match: '/git/refs',
        method: 'POST',
        responses: [
          jsonResponse({
            ref: 'refs/heads/feat/y',
            object: { sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02' },
          }),
        ],
      },
    ]);

    await githubAdapter.createBranch(
      ctx,
      withProvider({ owner: 'o', repo: 'r', name: 'feat/y', from: 'dev' }),
    );

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.url).toContain('/git/ref/heads/dev');
    expect(mock.calls[1]?.json).toMatchObject({ sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02' });
  });

  it('lists and reads commits with parents preserved', async () => {
    const commits = await fixture('commits');
    const commit = await fixture('commit');
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/commits?sha=dev', responses: [jsonResponse(commits)] },
      { match: '/commits/ab03ab03', responses: [jsonResponse(commit)] },
    ]);

    const list = await githubAdapter.listCommits(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', branch: 'dev' }),
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      sha: 'ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03',
      message: 'Add the first example',
      html_url:
        'https://github.com/example-org/demo-kit/commit/ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03',
    });
    expect(list[0]?.author).toEqual({
      name: 'example-author',
      email: 'author@example.invalid',
      date: '2025-05-01T08:00:00Z',
    });
    expect(list[0]?.parents).toEqual(['ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02']);

    const single = await githubAdapter.getCommit(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        sha: 'ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03',
      }),
    );
    expect(single.sha).toBe('ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03');
  });
});

describe('github adapter single-file writes', () => {
  const writeResponse = {
    content: {
      name: 'a.txt',
      path: 'tmp/a.txt',
      sha: 'blobsha',
      html_url: 'https://github.com/example-org/demo-kit/blob/dev/tmp/a.txt',
    },
    commit: {
      sha: 'ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
      html_url:
        'https://github.com/example-org/demo-kit/commit/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    },
  };

  it('creates a file through the contents upsert endpoint', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/contents/tmp/a.txt',
        method: 'PUT',
        responses: [jsonResponse(writeResponse, { status: 201 })],
      },
    ]);

    const result = await githubAdapter.createFile(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        path: 'tmp/a.txt',
        content: 'hi',
        message: 'add a',
        branch: 'dev',
      }),
    );

    expect(mock.calls[0]?.method).toBe('PUT');
    expect(mock.calls[0]?.json).toMatchObject({ content: 'aGk=', message: 'add a', branch: 'dev' });
    expect((mock.calls[0]?.json as Record<string, unknown>).sha).toBeUndefined();
    expect(result).toEqual({
      provider: 'github',
      owner: 'example-org',
      repo: 'demo-kit',
      commit_sha: 'ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
      commit_html_url:
        'https://github.com/example-org/demo-kit/commit/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
      paths: ['tmp/a.txt'],
      file_html_urls: ['https://github.com/example-org/demo-kit/blob/dev/tmp/a.txt'],
      branch: 'dev',
    });
  });

  it('requires a sha on update and rejects one on create', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/contents/', responses: [jsonResponse(writeResponse)] }]);

    const missing = await expectGitForgeError(
      githubAdapter.updateFile(
        ctx,
        withProvider({ owner: 'o', repo: 'r', path: 'a.txt', content: 'aGk=', message: 'm' }),
      ),
    );
    expect(missing.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);

    const unexpected = await expectGitForgeError(
      githubAdapter.createFile(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          path: 'a.txt',
          content: 'aGk=',
          message: 'm',
          sha: 'x',
        }),
      ),
    );
    expect(unexpected.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);
  });

  it('deletes a file with the body carrying sha and message', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/contents/tmp/a.txt', method: 'DELETE', responses: [jsonResponse(writeResponse)] },
    ]);

    const result = await githubAdapter.deleteFile(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        path: 'tmp/a.txt',
        sha: 'blobsha',
        message: 'rm',
        branch: 'dev',
      }),
    );

    expect(mock.calls[0]?.method).toBe('DELETE');
    expect(mock.calls[0]?.json).toMatchObject({ sha: 'blobsha', message: 'rm', branch: 'dev' });
    expect(new URL(mock.calls[0]?.url ?? '').search).toBe('');
    expect(result.commit_sha).toBe('ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05');
    expect(result.file_html_urls).toBeUndefined();
  });
});

describe('github adapter pushFiles six-step chain', () => {
  const REF_RESPONSE = {
    ref: 'refs/heads/dev',
    object: { sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02', type: 'commit' },
  };
  const COMMIT_RESPONSE = {
    sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02',
    tree: { sha: 'ab06ab06ab06ab06ab06ab06ab06ab06ab06ab06' },
  };
  const TREE_RESPONSE = { sha: 'newtreesha' };
  const NEW_COMMIT_RESPONSE = {
    sha: 'ab09ab09ab09ab09ab09ab09ab09ab09ab09ab09',
    html_url:
      'https://github.com/example-org/demo-kit/commit/ab09ab09ab09ab09ab09ab09ab09ab09ab09ab09',
  };
  const PATCH_RESPONSE = {
    ref: 'refs/heads/dev',
    object: { sha: 'ab09ab09ab09ab09ab09ab09ab09ab09ab09ab09' },
  };

  /** Routes for the six steps, plus an optional blob create. */
  const parent = {
    truncated: false,
    tree: ['b.txt', 'b64.txt', 'gone.txt', 'untouched'].map((path) => ({
      path,
      type: 'blob',
      mode: path === 'b64.txt' ? '100755' : '100644',
    })),
  };
  function chainRoutes(blobSha?: string, snapshot: unknown = parent): MockRoute[] {
    const routes: MockRoute[] = [
      {
        match: `/git/trees/${COMMIT_RESPONSE.tree.sha}?recursive=1`,
        method: 'GET',
        responses: [jsonResponse(snapshot)],
      },
      { match: '/git/ref/heads/dev', method: 'GET', responses: [jsonResponse(REF_RESPONSE)] },
      { match: '/git/commits/ab02ab02', method: 'GET', responses: [jsonResponse(COMMIT_RESPONSE)] },
      {
        match: '/git/trees',
        method: 'POST',
        responses: [jsonResponse(TREE_RESPONSE, { status: 201 })],
      },
      {
        match: '/git/commits',
        method: 'POST',
        responses: [jsonResponse(NEW_COMMIT_RESPONSE, { status: 201 })],
      },
      { match: '/git/refs/heads/dev', method: 'PATCH', responses: [jsonResponse(PATCH_RESPONSE)] },
    ];
    if (blobSha !== undefined) {
      routes.splice(2, 0, {
        match: '/git/blobs',
        method: 'POST',
        responses: [jsonResponse({ sha: blobSha }, { status: 201 })],
      });
    }
    return routes;
  }

  it('commits utf8 entries in 6 requests and returns the confirmed commit', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes());

    const result = await githubAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        branch: 'dev',
        message: 'batch',
        files: [
          { path: 'a.txt', action: 'create' as const, content: 'hello' },
          { path: 'b.txt', action: 'update' as const, content: 'world' },
        ],
      }),
    );

    expect(mock.calls).toHaveLength(6);
    expect(mock.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /repos/example-org/demo-kit/git/ref/heads/dev',
      'GET /repos/example-org/demo-kit/git/commits/ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02',
      `GET /repos/example-org/demo-kit/git/trees/${COMMIT_RESPONSE.tree.sha}`,
      'POST /repos/example-org/demo-kit/git/trees',
      'POST /repos/example-org/demo-kit/git/commits',
      'PATCH /repos/example-org/demo-kit/git/refs/heads/dev',
    ]);
    expect(result.commit_sha).toBe('ab09ab09ab09ab09ab09ab09ab09ab09ab09ab09');
    expect(result.commit_html_url).toBe(
      'https://github.com/example-org/demo-kit/commit/ab09ab09ab09ab09ab09ab09ab09ab09ab09ab09',
    );
    expect(result.paths).toEqual(['a.txt', 'b.txt']);
    expect(result.branch).toBe('dev');
  });

  it('always sends base_tree so untouched files survive', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes());

    await githubAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create' as const, content: 'x' }],
      }),
    );

    const treeCall = mock.calls.find((call) => call.url.endsWith('/git/trees'));
    expect(treeCall?.json).toMatchObject({ base_tree: 'ab06ab06ab06ab06ab06ab06ab06ab06ab06ab06' });
  });

  it('builds tree entries per action and encoding', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes('blobsha1'));

    await githubAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'm',
        files: [
          { path: 'utf8.txt', action: 'create' as const, content: 'hello' },
          {
            path: 'b64.txt',
            action: 'update' as const,
            content: 'aGk=',
            encoding: 'base64' as const,
          },
          { path: 'gone.txt', action: 'delete' as const },
        ],
      }),
    );

    const treeCall = mock.calls.find((call) => call.url.endsWith('/git/trees'));
    const body = treeCall?.json as { tree: Record<string, unknown>[]; base_tree: string };

    // utf8: inline content, no sha.
    expect(body.tree[0]).toEqual({
      path: 'utf8.txt',
      mode: '100644',
      type: 'blob',
      content: 'hello',
    });
    expect(body.tree[0]?.sha).toBeUndefined();

    // base64: blob sha, no content.
    expect(body.tree[1]).toEqual({
      path: 'b64.txt',
      mode: '100755',
      type: 'blob',
      sha: 'blobsha1',
    });
    expect(body.tree[1]?.content).toBeUndefined();

    // delete: sha null, no content.
    expect(body.tree[2]).toEqual({
      path: 'gone.txt',
      mode: '100644',
      type: 'blob',
      sha: null,
    });
    expect(body.tree[2]?.content).toBeUndefined();

    // One blob per base64 entry: 6 + K.
    expect(mock.calls).toHaveLength(7);
    const blobCall = mock.calls.find((call) => call.url.endsWith('/git/blobs'));
    expect(blobCall?.json).toEqual({ content: 'aGk=', encoding: 'base64' });
  });

  it('scales request count as 6 + K with several base64 entries', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes('blobsha'));

    await githubAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'm',
        files: [
          { path: 'a', action: 'create' as const, content: 'aGk=', encoding: 'base64' as const },
          { path: 'b', action: 'create' as const, content: 'aGk=', encoding: 'base64' as const },
          { path: 'c', action: 'create' as const, content: 'aGk=', encoding: 'base64' as const },
        ],
      }),
    );

    expect(mock.calls).toHaveLength(9);
    expect(mock.calls.filter((call) => call.url.endsWith('/git/blobs'))).toHaveLength(3);
  });

  it('parents the new commit on the branch tip and forces nothing', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes());

    await githubAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'batch',
        files: [{ path: 'a.txt', action: 'create' as const, content: 'x' }],
      }),
    );

    const commitCall = mock.calls.find(
      (call) => call.url.endsWith('/git/commits') && call.method === 'POST',
    );
    expect(commitCall?.json).toEqual({
      message: 'batch',
      tree: 'newtreesha',
      parents: ['ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02'],
    });

    const patchCall = mock.calls.find((call) => call.method === 'PATCH');
    expect(patchCall?.json).toEqual({
      sha: 'ab09ab09ab09ab09ab09ab09ab09ab09ab09ab09',
      force: false,
    });
  });

  it.each([
    [
      'symlink',
      { truncated: false, tree: [{ path: 'file', type: 'blob', mode: '120000' }] },
      'update',
      'INVALID_ARGUMENT',
    ],
    [
      'submodule',
      { truncated: false, tree: [{ path: 'file', type: 'commit', mode: '160000' }] },
      'update',
      'INVALID_ARGUMENT',
    ],
    ['incomplete tree', { truncated: true, tree: [] }, 'create', 'PROVIDER_ERROR'],
    ['missing update', { truncated: false, tree: [] }, 'update', 'INVALID_ARGUMENT'],
    [
      'existing create',
      { truncated: false, tree: [{ path: 'file', type: 'blob', mode: '100644' }] },
      'create',
      'INVALID_ARGUMENT',
    ],
  ] as const)('rejects %s before writing objects', async (_name, snapshot, action, code) => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes(undefined, snapshot));
    await expect(
      githubAdapter.pushFiles(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'change',
          files: [{ path: 'file', action, content: 'hi' }],
        }),
      ),
    ).rejects.toMatchObject({ code });
    expect(mock.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('rejects an empty batch, a delete with content and bad base64 before any request', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes('blob'));

    const empty = await expectGitForgeError(
      githubAdapter.pushFiles(
        ctx,
        withProvider({ owner: 'o', repo: 'r', branch: 'dev', message: 'm', files: [] }),
      ),
    );
    expect(empty.code).toBe('INVALID_ARGUMENT');
    expect(empty.capability).toBe('files.pushFiles');

    const deleteWithContent = await expectGitForgeError(
      githubAdapter.pushFiles(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'm',
          files: [{ path: 'a', action: 'delete' as const, content: 'x' }],
        }),
      ),
    );
    expect(deleteWithContent.code).toBe('INVALID_ARGUMENT');

    const missingContent = await expectGitForgeError(
      githubAdapter.pushFiles(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'm',
          files: [{ path: 'a', action: 'create' as const }],
        }),
      ),
    );
    expect(missingContent.code).toBe('INVALID_ARGUMENT');

    const badBase64 = await expectGitForgeError(
      githubAdapter.pushFiles(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'm',
          files: [
            {
              path: 'a',
              action: 'create' as const,
              content: 'not base64!',
              encoding: 'base64' as const,
            },
          ],
        }),
      ),
    );
    expect(badBase64.code).toBe('INVALID_ARGUMENT');

    expect(mock.calls).toHaveLength(0);
  });

  it('rejects an unknown action instead of guessing upsert semantics', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes(chainRoutes());

    const error = await expectGitForgeError(
      githubAdapter.pushFiles(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'm',
          files: [{ path: 'a', action: 'upsert' as unknown as 'create', content: 'x' }],
        }),
      ),
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('upsert');
    expect(mock.calls).toHaveLength(0);
  });

  it('fails loudly when the branch tip cannot be resolved', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/git/ref/heads/dev',
        responses: [jsonResponse({ ref: 'refs/heads/dev', object: {} })],
      },
    ]);

    const error = await expectGitForgeError(
      githubAdapter.pushFiles(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'm',
          files: [{ path: 'a', action: 'create' as const, content: 'x' }],
        }),
      ),
    );
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.message).toContain('SHA');
    expect(mock.calls).toHaveLength(1);
  });
});
