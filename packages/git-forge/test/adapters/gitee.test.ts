import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GitForgeError } from '../../src/core/errors.js';
import { giteeAdapter } from '../../src/adapters/gitee/adapter.js';
import { CAPABILITY_IDS } from '../../src/core/types.js';
import type { ListIssuesParams, ListPullRequestsParams } from '../../src/core/types.js';
import type { WithProvider } from '../../src/adapters/types.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import type { MockCall } from '../helpers/mockFetch.js';
import {
  buildHarness,
  capabilityState,
  expectCompleteCapabilityTable,
  paramCapabilityState,
} from '../helpers/adapterHarness.js';

/** Loads a fixture from `test/fixtures/gitee`. */
async function fixture(name: string): Promise<unknown> {
  const path = fileURLToPath(new URL(`../fixtures/gitee/${name}.json`, import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Adds the `provider` field the facade threads through every call. */
function withProvider<T extends object>(params: T): WithProvider<T> {
  return { ...params, provider: 'gitee' };
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

/** Reads the `state` query parameter of a recorded call. */
function stateOf(call: MockCall): string | null {
  return new URL(call.url).searchParams.get('state');
}

describe('gitee adapter capability table', () => {
  it('declares all 29 method-level capabilities with stargazer listing as the only gap', () => {
    expectCompleteCapabilityTable(giteeAdapter);
    expect(Object.keys(giteeAdapter.capabilities)).toHaveLength(CAPABILITY_IDS.length);

    // The endpoint is routable but answers an empty array for every
    // repository, so an empty list would be a wrong answer rather than a
    // missing feature.
    const unsupported = CAPABILITY_IDS.filter(
      (id) => capabilityState(giteeAdapter, id) === 'unsupported',
    );
    expect(unsupported).toEqual(['repos.listStargazers']);

    // The batch endpoint accepts all actions in one commit.
    expect(capabilityState(giteeAdapter, 'files.pushFiles')).toBe('supported');
    expect(paramCapabilityState(giteeAdapter, 'files.pushFiles.atomic')).toBe('supported');
    expect(paramCapabilityState(giteeAdapter, 'repos.listStargazers.timestamps')).toBe(
      'unsupported',
    );
  });
});

describe('gitee adapter issues', () => {
  it('keeps a non-numeric issue code in number and omits its numeric alias entirely', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues/IEXA01', responses: [jsonResponse(issue)] }]);

    const result = await giteeAdapter.getIssue(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 'IEXA01' }),
    );

    expect(result.number).toBe('IEXA01');
    // `'number_as_number' in issue` distinguishes "omitted" from "explicitly undefined";
    // the latter would serialize as a present key and hide the gap.
    expect('number_as_number' in result).toBe(false);
    expect(result.provider).toBe('gitee');
    expect(result.html_url).toBe('https://gitee.com/example-org/demo-kit/issues/IEXA01');
  });

  it('flattens label objects into names', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues/IEXA01', responses: [jsonResponse(issue)] }]);

    const result = await giteeAdapter.getIssue(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 'IEXA01' }),
    );
    expect(result.labels).toEqual(['bug', 'docs']);
  });

  it('maps progressing to open and rejected to closed', async () => {
    const open = await fixture('issues-open');
    const progressing = await fixture('issues-progressing');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: (call) => stateOf(call) === 'open', responses: [jsonResponse(open)] },
      { match: (call) => stateOf(call) === 'progressing', responses: [jsonResponse(progressing)] },
    ]);

    const issues = await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'example-org', repo: 'demo-kit', state: 'open' }),
    );

    const progressingIssue = issues.find((issue) => issue.number === 'IEXA02');
    expect(progressingIssue?.state).toBe('open');
    // Chinese `issue_state` must not leak into the model.
    expect(issues.every((issue) => issue.state === 'open')).toBe(true);
  });

  it('maps the rejected state to closed', async () => {
    const rejected = [
      {
        id: 1,
        number: 'IEXA03',
        state: 'rejected',
        issue_state: '已取消',
        title: '已取消',
        html_url: 'https://gitee.com/example-org/demo-kit/issues/IEXA03',
        labels: [],
        created_at: '2025-02-01T00:00:00+08:00',
        updated_at: '2025-02-02T00:00:00+08:00',
        finished_at: '2025-02-02T00:00:00+08:00',
      },
    ];
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: (call) => stateOf(call) === 'closed', responses: [jsonResponse(rejected)] },
      { match: (call) => stateOf(call) === 'rejected', responses: [jsonResponse([])] },
    ]);

    const issues = await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({
        owner: 'example-org',
        repo: 'demo-kit',
        state: 'closed',
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.state).toBe('closed');
    expect(issues[0]?.number).toBe('IEXA03');
  });

  it('creates an issue through the owner-scoped path with repo in the body', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/repos/example-org/issues',
        method: 'POST',
        responses: [jsonResponse(issue, { status: 201 })],
      },
    ]);

    await giteeAdapter.createIssue(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        title: 't',
        body: 'b',
        labels: ['bug', 'docs'],
      }),
    );

    const [call] = mock.calls;
    expect(call?.url).toBe('https://gitee.com/api/v5/repos/example-org/issues');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.json).toMatchObject({
      repo: 'demo-kit',
      title: 't',
      body: 'b',
      // Gitee takes a comma-joined string, not an array.
      labels: 'bug,docs',
    });
  });

  it('updates an issue through the owner-scoped path', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/repos/example-org/issues/IEXA01',
        method: 'PATCH',
        responses: [jsonResponse(issue)],
      },
    ]);

    await giteeAdapter.updateIssue(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        number: 'IEXA01',
        state: 'closed' as const,
        labels: ['bug'],
      }),
    );

    expect(mock.calls[0]?.url).toBe('https://gitee.com/api/v5/repos/example-org/issues/IEXA01');
    expect(mock.calls[0]?.json).toMatchObject({ repo: 'demo-kit', state: 'closed', labels: 'bug' });
  });

  it('falls back to the parent issue URL for comment html_url', async () => {
    const comments = await fixture('comments');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues/IEXA01/comments', responses: [jsonResponse(comments)] }]);

    const result = await giteeAdapter.listIssueComments(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 'IEXA01' }),
    );

    // Gitee comment payloads have no html_url; the parent issue URL is used with
    // no invented anchor.
    expect(result).toHaveLength(2);
    expect(result[0]?.html_url).toBe('https://gitee.com/example-org/demo-kit/issues/IEXA01');
    expect(result[0]?.html_url).not.toContain('#');
    expect(result[0]?.html_url).not.toBe('');
  });

  it('rejects a numeric milestone filter on issue lists', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([])] }]);

    const error = await expectGitForgeError(
      giteeAdapter.listIssues(
        ctx,
        withProvider<ListIssuesParams>({
          owner: 'example-org',
          repo: 'demo-kit',
          milestone: 3,
        }),
      ),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('title');
    expect(mock.calls).toHaveLength(0);
  });

  it('surfaces a 401 as AUTH_INVALID', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/issues/IEXA01',
        responses: [jsonResponse({ message: '401 Unauthorized' }, { status: 401 })],
      },
    ]);

    const error = await expectGitForgeError(
      giteeAdapter.getIssue(ctx, withProvider({ owner: 'o', repo: 'r', number: 'IEXA01' })),
    );
    expect(error.code).toBe('AUTH_INVALID');
    expect(error.provider).toBe('gitee');
  });

  it('surfaces a 404 as NOT_FOUND', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/issues/ZZZZZZ',
        responses: [jsonResponse({ message: 'Not Found' }, { status: 404 })],
      },
    ]);

    const error = await expectGitForgeError(
      giteeAdapter.getIssue(ctx, withProvider({ owner: 'o', repo: 'r', number: 'ZZZZZZ' })),
    );
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('gitee adapter state fan-out', () => {
  it('fans out state=open into open + progressing and merges without duplicates', async () => {
    const open = await fixture('issues-open');
    const progressing = await fixture('issues-progressing');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: (call) => stateOf(call) === 'open', responses: [jsonResponse(open)] },
      { match: (call) => stateOf(call) === 'progressing', responses: [jsonResponse(progressing)] },
    ]);

    const issues = await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'example-org', repo: 'demo-kit', state: 'open' }),
    );

    // Two requests, one per platform state value.
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.map(stateOf).sort()).toEqual(['open', 'progressing']);
    // Merged: one open issue plus one progressing issue, no overlap.
    expect(issues.map((issue) => issue.number)).toEqual(['IEXA01', 'IEXA02']);
    const keys = issues.map((issue) => issue.number);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('fans out state=closed into closed + rejected', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([])] }]);

    await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({
        owner: 'example-org',
        repo: 'demo-kit',
        state: 'closed',
      }),
    );

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.map(stateOf).sort()).toEqual(['closed', 'rejected']);
  });

  it('sends a single request for state=all', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([])] }]);

    await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'example-org', repo: 'demo-kit', state: 'all' }),
    );

    expect(mock.calls).toHaveLength(1);
    expect(stateOf(mock.calls[0] as MockCall)).toBe('all');
  });

  it('never sends a comma-joined state, which the platform rejects with 400', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([])] }]);

    await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'example-org', repo: 'demo-kit', state: 'open' }),
    );

    for (const call of mock.calls) {
      expect(stateOf(call)).not.toContain(',');
    }
  });

  it('deduplicates an issue returned by both states', async () => {
    const shared = {
      id: 42,
      number: 'IAAAAA',
      state: 'open',
      title: 'shared',
      html_url: 'https://gitee.com/o/r/issues/IAAAAA',
      labels: [],
      created_at: '2025-01-01T00:00:00+08:00',
      updated_at: '2025-01-02T00:00:00+08:00',
    };
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([shared])] }]);

    const issues = await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'o', repo: 'r', state: 'open' }),
    );

    expect(mock.calls).toHaveLength(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe('IAAAAA');
  });

  it('treats an omitted state as open and fans out', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([])] }]);

    await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'example-org', repo: 'demo-kit' }),
    );

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls.map(stateOf).sort()).toEqual(['open', 'progressing']);
  });

  it('joins labels on each fanned-out request', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/issues', responses: [jsonResponse([])] }]);

    await giteeAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({
        owner: 'example-org',
        repo: 'demo-kit',
        state: 'open',
        labels: ['bug', 'docs'],
      }),
    );

    for (const call of mock.calls) {
      expect(new URL(call.url).searchParams.get('labels')).toBe('bug,docs');
    }
  });
});

describe('gitee adapter pull requests', () => {
  it('derives merged from merged_at and folds the state to closed', async () => {
    const pulls = await fixture('pulls');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/pulls', responses: [jsonResponse(pulls)] }]);

    const result = await giteeAdapter.listPullRequests(
      ctx,
      withProvider<ListPullRequestsParams>({
        owner: 'example-org',
        repo: 'demo-kit',
        state: 'all',
      }),
    );

    expect(result[0]).toMatchObject({ number: 304, state: 'open', merged: false });
    expect(result[1]).toMatchObject({ number: 303, state: 'closed', merged: true });
    expect(result[1]?.merged_at).toBe('2025-03-05T00:00:00+08:00');
    expect(result[0]?.html_url).toBe('https://gitee.com/example-org/demo-kit/pulls/304');
  });

  it('uses milestone_number and forwards head', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/pulls', responses: [jsonResponse([])] }]);

    await giteeAdapter.listPullRequests(
      ctx,
      withProvider<ListPullRequestsParams>({
        owner: 'o',
        repo: 'r',
        head: 'feat',
        milestone: 4,
      }),
    );

    const url = new URL(mock.calls[0]?.url ?? '');
    expect(url.searchParams.get('head')).toBe('feat');
    expect(url.searchParams.get('milestone_number')).toBe('4');
    expect(url.searchParams.get('milestone')).toBeNull();
  });

  it('merges then re-reads the pull request', async () => {
    const pull = await fixture('pull');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: '/pulls/304/merge', method: 'PUT', responses: [jsonResponse({ merged: true })] },
      { match: '/pulls/304', method: 'GET', responses: [jsonResponse(pull)] },
    ]);

    const result = await giteeAdapter.mergePullRequest(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        number: 304,
        merge_method: 'rebase' as const,
        commit_title: 'title',
      }),
    );

    expect(mock.calls[0]?.json).toMatchObject({ merge_method: 'rebase', title: 'title' });
    expect(result.number).toBe(304);
  });

  it('reads pull-request comments from the pull endpoint', async () => {
    const comments = await fixture('comments');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/pulls/304/comments', responses: [jsonResponse(comments)] }]);

    const result = await giteeAdapter.listPullRequestComments(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 304 }),
    );

    expect(mock.calls[0]?.url).toContain('/pulls/304/comments');
    expect(result[0]?.html_url).toBe('https://gitee.com/example-org/demo-kit/pulls/304');
  });
});

describe('gitee adapter repositories', () => {
  it('lists organization repositories through /orgs/{org}/repos', async () => {
    const repos = await fixture('repos');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/orgs/example-org/repos', responses: [jsonResponse(repos)] }]);

    const result = await giteeAdapter.listRepositories(ctx, withProvider({ org: 'example-org' }));

    expect(mock.calls[0]?.url).toBe(
      'https://gitee.com/api/v5/orgs/example-org/repos?per_page=100&page=1',
    );
    expect(result).toHaveLength(2);
    // `namespace.path` wins over the request parameter, and it happens to match.
    expect(result[0]?.owner).toBe('example-org');
  });

  it("lists a user's repositories through /users/{user}/repos", async () => {
    const repos = await fixture('repos');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/users/example-user/repos', responses: [jsonResponse(repos)] }]);

    const result = await giteeAdapter.listRepositories(ctx, withProvider({ user: 'example-user' }));

    expect(mock.calls[0]?.url).toBe(
      'https://gitee.com/api/v5/users/example-user/repos?per_page=100&page=1',
    );
    expect(result).toHaveLength(2);
    // The payload's namespace still wins: both fixtures belong to `example-org`.
    expect(result[0]?.owner).toBe('example-org');
  });

  it('falls back to the requested user when a row has no namespace', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    // A partial payload: no `namespace` at all, so the adapter must fall back
    // instead of emitting an empty owner.
    mock.setRoutes([
      {
        match: '/users/example-user/repos',
        responses: [
          jsonResponse([
            {
              id: 5099,
              name: 'demo-config',
              path: 'demo-config',
              html_url: 'https://gitee.com/example-user/demo-config.git',
              private: false,
              default_branch: 'main',
            },
          ]),
        ],
      },
    ]);

    const result = await giteeAdapter.listRepositories(ctx, withProvider({ user: 'example-user' }));

    expect(result).toHaveLength(1);
    expect(result[0]?.owner).toBe('example-user');
    expect(result[0]?.repo).toBe('demo-config');
    // `repo` and `html_url` come from the payload, not from the fallback owner;
    // the clone URL is still normalized to a web URL.
    expect(result[0]?.html_url).toBe('https://gitee.com/example-user/demo-config');
  });

  it('strips the .git suffix from html_url', async () => {
    const repo = await fixture('repo');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/repos/example-org/demo-kit', responses: [jsonResponse(repo)] }]);

    const result = await giteeAdapter.getRepository(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit' }),
    );

    expect(result.html_url).toBe('https://gitee.com/example-org/demo-kit');
    expect(result.html_url.endsWith('.git')).toBe(false);
    expect(result.owner).toBe('example-org');
    expect(result.default_branch).toBe('dev');
  });

  it('reads file contents and rejects an array payload as a directory', async () => {
    const contents = await fixture('contents');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: '/contents/README.md', responses: [jsonResponse(contents)] },
      { match: '/contents/missing', responses: [jsonResponse([])] },
      { match: '/contents/docs', responses: [jsonResponse([{ name: 'a.md', type: 'file' }])] },
    ]);

    const file = await giteeAdapter.getFileContents(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', path: 'README.md' }),
    );
    expect(file.encoding).toBe('base64');
    expect(file.path).toBe('README.md');

    // Gitee answers 200 + [] for a missing path: not NOT_FOUND, but the
    // contract cannot express it, so it is a caller error.
    const missing = await expectGitForgeError(
      giteeAdapter.getFileContents(ctx, withProvider({ owner: 'o', repo: 'r', path: 'missing' })),
    );
    expect(missing.code).toBe('INVALID_ARGUMENT');

    const directory = await expectGitForgeError(
      giteeAdapter.getFileContents(ctx, withProvider({ owner: 'o', repo: 'r', path: 'docs' })),
    );
    expect(directory.code).toBe('INVALID_ARGUMENT');
  });
});

describe('gitee adapter branches and commits', () => {
  it('derives branch html_url and keeps the platform-specific field out of the model', async () => {
    const branches = await fixture('branches');
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/branches', responses: [jsonResponse(branches)] }]);

    const result = await giteeAdapter.listBranches(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit' }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.html_url).toBe('https://gitee.com/example-org/demo-kit/tree/dev');
    expect(result[0]?.commit_sha).toBe('ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02');
    expect(result[1]?.protected).toBe(true);
    expect(Object.keys(result[0] ?? {})).not.toContain('protection_url');
    // Derivation costs no request.
    expect(mock.calls).toHaveLength(1);
  });

  it('creates a branch with refs and branch_name', async () => {
    const created = {
      commit: { sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02' },
      name: 'feat/x',
      protected: false,
      protection_url:
        'https://gitee.com/api/v5/repos/example-org/demo-kit/branches/feat/x/protection',
    };
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: '/branches', method: 'POST', responses: [jsonResponse(created, { status: 201 })] },
    ]);

    const branch = await giteeAdapter.createBranch(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', name: 'feat/x', from: 'dev' }),
    );

    // Gitee's create-branch endpoint takes `refs` (source) and `branch_name`.
    expect(mock.calls[0]?.json).toEqual({ refs: 'dev', branch_name: 'feat/x' });
    expect(branch.name).toBe('feat/x');
    expect(branch.commit_sha).toBe('ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02');
    expect(branch.html_url).toBe('https://gitee.com/example-org/demo-kit/tree/feat/x');
    expect(mock.calls).toHaveLength(1);
  });

  it('lists and reads commits', async () => {
    const commits = await fixture('commits');
    const commit = await fixture('commit');
    const { ctx, mock } = buildHarness(giteeAdapter);
    // The specific route must be listed first: routes match in declaration order
    // and `'/commits'` is a substring of `'/commits/<sha>'`.
    mock.setRoutes([
      { match: '/commits/ab03ab03', responses: [jsonResponse(commit)] },
      { match: '/commits', method: 'GET', responses: [jsonResponse(commits)] },
    ]);

    const list = await giteeAdapter.listCommits(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', branch: 'dev' }),
    );
    expect(list).toHaveLength(2);
    expect(list[0]?.author?.date).toBe('2025-05-01T16:00:00+08:00');
    expect(list[0]?.parents).toEqual(['ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02']);

    const single = await giteeAdapter.getCommit(
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

describe('gitee adapter pushFiles single request', () => {
  const commitResponse = {
    url: 'https://gitee.com/api/v5/repos/example-org/demo-kit/commits/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    sha: 'ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    html_url:
      'https://gitee.com/example-org/demo-kit/commit/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    parents: [{ sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02' }],
    stats: { additions: 2, deletions: 0, total: 2 },
    // Deliberately reversed relative to `actions[]`: response order is not the requested path order.
    files: [
      { filename: 'tmp/b.txt', status: 'added' },
      { filename: 'tmp/a.txt', status: 'modified' },
    ],
  };

  it('sends exactly one POST with no existence probe', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/commits',
        method: 'POST',
        responses: [jsonResponse(commitResponse, { status: 201 })],
      },
    ]);

    const result = await giteeAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        branch: 'dev',
        message: 'batch',
        files: [
          {
            path: 'tmp/a.txt',
            action: 'create' as const,
            content: 'aGk=',
            encoding: 'base64' as const,
          },
          { path: 'tmp/b.txt', action: 'update' as const, content: 'world' },
        ],
      }),
    );

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe('POST');
    expect(mock.calls[0]?.url).toContain('/repos/example-org/demo-kit/commits');
    // Zero GETs: the closed three-value contract needs no upsert probe.
    expect(mock.callsMatching('/contents')).toHaveLength(0);
    expect(mock.calls.filter((call) => call.method === 'GET')).toHaveLength(0);
    expect(result.commit_sha).toBe('ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05');
    expect(result.commit_html_url).toBe(
      'https://gitee.com/example-org/demo-kit/commit/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    );
  });

  it('translates utf8 to text and keeps base64 as base64', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/commits',
        method: 'POST',
        responses: [jsonResponse(commitResponse, { status: 201 })],
      },
    ]);

    await giteeAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'm',
        files: [
          { path: 'a.txt', action: 'create' as const, content: 'hello' },
          {
            path: 'b.txt',
            action: 'create' as const,
            content: 'aGk=',
            encoding: 'base64' as const,
          },
        ],
      }),
    );

    const body = mock.calls[0]?.json as { actions: Record<string, unknown>[] };
    // `utf8` is not a Gitee encoding; `text` is.
    expect(body.actions[0]?.encoding).toBe('text');
    expect(body.actions[1]?.encoding).toBe('base64');
  });

  it('omits content and encoding for a delete entry', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/commits',
        method: 'POST',
        responses: [jsonResponse(commitResponse, { status: 201 })],
      },
    ]);

    await giteeAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'm',
        files: [{ path: 'gone.txt', action: 'delete' as const }],
      }),
    );

    const body = mock.calls[0]?.json as { actions: Record<string, unknown>[] };
    expect(body.actions[0]).toEqual({ action: 'delete', path: 'gone.txt' });
    expect(body.actions[0]).not.toHaveProperty('content');
    expect(body.actions[0]).not.toHaveProperty('encoding');
  });

  it('rebuilds paths in the caller order rather than the response order', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/commits',
        method: 'POST',
        responses: [jsonResponse(commitResponse, { status: 201 })],
      },
    ]);

    const result = await giteeAdapter.pushFiles(
      ctx,
      withProvider({
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'm',
        files: [
          { path: 'tmp/a.txt', action: 'create' as const, content: 'x' },
          { path: 'tmp/b.txt', action: 'update' as const, content: 'y' },
        ],
      }),
    );

    expect(result.paths).toEqual(['tmp/a.txt', 'tmp/b.txt']);
  });

  it('rejects an empty batch without a request, which would create an empty commit', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/commits',
        method: 'POST',
        responses: [jsonResponse(commitResponse, { status: 201 })],
      },
    ]);

    const error = await expectGitForgeError(
      giteeAdapter.pushFiles(
        ctx,
        withProvider({ owner: 'o', repo: 'r', branch: 'dev', message: 'm', files: [] }),
      ),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.provider).toBe('gitee');
    expect(error.capability).toBe('files.pushFiles');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('gitee adapter single-file writes', () => {
  const createResponse = {
    commit: {
      author: {
        name: 'example-author',
        email: 'author@example.invalid',
        date: '2025-05-01T16:00:00+08:00',
      },
      committer: {
        name: 'example-author',
        email: 'author@example.invalid',
        date: '2025-05-01T16:00:00+08:00',
      },
      message: 'add a',
      parents: [{ sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02' }],
      sha: 'ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
      tree: { sha: 'ab06ab06ab06ab06ab06ab06ab06ab06ab06ab06' },
    },
    content: {
      html_url: 'https://gitee.com/example-org/demo-kit/blob/dev/tmp/a.txt',
      name: 'a.txt',
      path: 'tmp/a.txt',
      sha: 'blobsha',
      size: 2,
      type: 'file',
    },
  };

  it('derives commit_html_url because the response commit has none', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/contents/tmp/a.txt',
        method: 'POST',
        responses: [jsonResponse(createResponse, { status: 201 })],
      },
    ]);

    const result = await giteeAdapter.createFile(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        path: 'tmp/a.txt',
        content: 'aGk=',
        message: 'add a',
        branch: 'dev',
      }),
    );

    expect(result.commit_sha).toBe('ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05');
    expect(result.commit_html_url).toBe(
      'https://gitee.com/example-org/demo-kit/commit/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    );
    expect(result.file_html_urls).toEqual([
      'https://gitee.com/example-org/demo-kit/blob/dev/tmp/a.txt',
    ]);
  });

  it('sends delete parameters in the query with an empty body', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: '/contents/tmp/a.txt', method: 'DELETE', responses: [jsonResponse(createResponse)] },
    ]);

    await giteeAdapter.deleteFile(
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

    const call = mock.calls[0];
    const url = new URL(call?.url ?? '');
    expect(call?.method).toBe('DELETE');
    expect(url.searchParams.get('sha')).toBe('blobsha');
    expect(url.searchParams.get('message')).toBe('rm');
    expect(call?.body).toBeUndefined();
  });

  it('requires a sha on update and rejects one on create', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([{ match: '/contents/', responses: [jsonResponse(createResponse)] }]);

    const updateError = await expectGitForgeError(
      giteeAdapter.updateFile(
        ctx,
        withProvider({ owner: 'o', repo: 'r', path: 'a.txt', content: 'aGk=', message: 'm' }),
      ),
    );
    expect(updateError.code).toBe('INVALID_ARGUMENT');

    const createError = await expectGitForgeError(
      giteeAdapter.createFile(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          path: 'a.txt',
          content: 'aGk=',
          message: 'm',
          sha: 's',
        }),
      ),
    );
    expect(createError.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);
  });

  it('normalizes platform rejections to INVALID_ARGUMENT', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/commits',
        method: 'POST',
        responses: [jsonResponse({ message: '文件名已存在' }, { status: 400 })],
      },
    ]);

    const error = await expectGitForgeError(
      giteeAdapter.pushFiles(
        ctx,
        withProvider({
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'm',
          files: [{ path: 'a.txt', action: 'create' as const, content: 'x' }],
        }),
      ),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.status).toBe(400);
    // The upstream message is included so the caller can tell "already exists"
    // from "branch missing".
    expect(error.message).toContain('文件名已存在');
  });
});
