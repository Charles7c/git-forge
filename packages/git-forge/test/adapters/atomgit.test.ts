import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GitForgeError } from '../../src/core/errors.js';
import { atomgitAdapter } from '../../src/adapters/atomgit/adapter.js';
import { CAPABILITY_IDS } from '../../src/core/types.js';
import type { ListIssuesParams, ListPullRequestsParams } from '../../src/core/types.js';
import type { WithProvider } from '../../src/adapters/types.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import {
  buildHarness,
  capabilityState,
  expectCompleteCapabilityTable,
  paramCapabilityState,
} from '../helpers/adapterHarness.js';

/** Loads a fixture from `test/fixtures/atomgit`. */
async function fixture(name: string): Promise<unknown> {
  const path = fileURLToPath(new URL(`../fixtures/atomgit/${name}.json`, import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Adds the `provider` field the facade threads through every call. */
function withProvider<T extends object>(params: T): WithProvider<T> {
  return { ...params, provider: 'atomgit' };
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

describe('atomgit adapter capability table', () => {
  it('declares all 29 capabilities with pushFiles as the only gap', () => {
    expectCompleteCapabilityTable(atomgitAdapter);
    expect(Object.keys(atomgitAdapter.capabilities)).toHaveLength(CAPABILITY_IDS.length);

    const unsupported = CAPABILITY_IDS.filter(
      (id) => capabilityState(atomgitAdapter, id) === 'unsupported',
    );
    expect(unsupported).toEqual(['files.pushFiles']);
  });

  it('declares the parameter-level gaps', () => {
    expect(paramCapabilityState(atomgitAdapter, 'pulls.list.headFilter')).toBe('unsupported');
    expect(paramCapabilityState(atomgitAdapter, 'files.pushFiles.atomic')).toBe('unsupported');
    expect(paramCapabilityState(atomgitAdapter, 'pulls.list.milestoneFilter')).toBe('supported');
    expect(paramCapabilityState(atomgitAdapter, 'issues.list.milestoneFilter')).toBe('supported');
    // AtomGit always reports `starred_at`, so no special request is needed.
    expect(paramCapabilityState(atomgitAdapter, 'repos.listStargazers.timestamps')).toBe(
      'supported',
    );
  });

  it('differs from github and gitee exactly on pushFiles', async () => {
    // Cross-provider assertion in one place so a copy-paste capability table
    // cannot silently claim AtomGit supports batch commits.
    const { githubAdapter } = await import('../../src/adapters/github/adapter.js');
    const { giteeAdapter } = await import('../../src/adapters/gitee/adapter.js');
    expect(capabilityState(githubAdapter, 'files.pushFiles')).toBe('supported');
    expect(capabilityState(giteeAdapter, 'files.pushFiles')).toBe('supported');
    expect(capabilityState(atomgitAdapter, 'files.pushFiles')).toBe('unsupported');
  });
});

describe('atomgit adapter issues', () => {
  it('keeps a numeric string id and derives the numeric alias', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/issues/205', responses: [jsonResponse(issue)] }]);

    const result = await atomgitAdapter.getIssue(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: '205' }),
    );

    expect(result.number).toBe('205');
    expect(result.number_as_number).toBe(205);
    expect(typeof result.number_as_number).toBe('number');
    // Chinese `issue_state` never reaches the model.
    expect(result.state).toBe('open');
  });

  it('maps merged pull requests and preserves the merge_requests html_url', async () => {
    const pull = await fixture('pull-detail-no-head');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/pulls/403', responses: [jsonResponse(pull)] },
      { match: '/pulls', responses: [jsonResponse([])] },
    ]);

    const result = await atomgitAdapter.getPullRequest(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 403 }),
    );

    expect(result.state).toBe('closed');
    expect(result.merged).toBe(true);
    expect(result.merged_at).toBe('2025-04-02T03:04:05+08:00');
    // AtomGit serves pull requests at /merge_requests/<n>; rewriting to /pulls/
    // would 404.
    expect(result.html_url).toBe('https://atomgit.com/example-org/demo-kit/merge_requests/403');
  });

  it('creates an issue through the owner-scoped path with repo in the body', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/repos/example-org/issues',
        method: 'POST',
        responses: [jsonResponse(issue, { status: 201 })],
      },
    ]);

    await atomgitAdapter.createIssue(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', title: 't', labels: ['bug', 'docs'] }),
    );

    expect(mock.calls[0]?.url).toBe('https://api.atomgit.com/api/v5/repos/example-org/issues');
    expect(mock.calls[0]?.json).toMatchObject({
      repo: 'demo-kit',
      title: 't',
      labels: 'bug,docs',
    });
  });

  it('translates contract state values into close/reopen', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/repos/example-org/issues/205', method: 'PATCH', responses: [jsonResponse(issue)] },
    ]);

    await atomgitAdapter.updateIssue(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        number: '205',
        title: 't',
        state: 'closed' as const,
      }),
    );
    expect(mock.calls[0]?.json).toMatchObject({ repo: 'demo-kit', title: 't', state: 'close' });

    mock.reset();
    await atomgitAdapter.updateIssue(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        number: '205',
        title: 't',
        state: 'open' as const,
      }),
    );
    expect(mock.calls[0]?.json).toMatchObject({ state: 'reopen' });
  });

  it('backfills title with one extra read when the caller omits it', async () => {
    const issue = await fixture('issue');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/issues/205', method: 'GET', responses: [jsonResponse(issue)] },
      { match: '/repos/example-org/issues/205', method: 'PATCH', responses: [jsonResponse(issue)] },
    ]);

    await atomgitAdapter.updateIssue(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        number: '205',
        state: 'closed' as const,
      }),
    );

    // AtomGit requires `title` on update, so a state-only update costs one read.
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.method).toBe('GET');
    expect(mock.calls[1]?.json).toMatchObject({
      repo: 'demo-kit',
      title: 'Add a sample greeting',
      state: 'close',
    });
  });

  it('falls back to the parent issue URL for comment html_url', async () => {
    const comments = await fixture('comments');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/issues/205/comments', responses: [jsonResponse(comments)] }]);

    const result = await atomgitAdapter.listIssueComments(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: '205' }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.html_url).toBe('https://atomgit.com/example-org/demo-kit/issues/205');
    expect(result[0]?.html_url).not.toContain('#');
  });

  it('maps a trace_id into requestId and ignores the response url field', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/issues/205',
        responses: [
          jsonResponse(
            {
              error_code: 404,
              error_code_name: 'UN_KNOW',
              error_message: 'Project or file not found',
              trace_id: 'trace-abc-123',
            },
            { status: 404 },
          ),
        ],
      },
    ]);

    const error = await expectGitForgeError(
      atomgitAdapter.getIssue(ctx, withProvider({ owner: 'o', repo: 'r', number: '205' })),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(error.requestId).toBe('trace-abc-123');
    expect(error.provider).toBe('atomgit');
    // Every request uses the fixed API host, never the `url` echoed in payloads.
    expect(mock.calls[0]?.url.startsWith('https://api.atomgit.com/api/v5/')).toBe(true);
  });

  it('surfaces 401 as AUTH_INVALID', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/issues/205',
        responses: [jsonResponse({ error_message: 'unauthorized' }, { status: 401 })],
      },
    ]);

    const error = await expectGitForgeError(
      atomgitAdapter.getIssue(ctx, withProvider({ owner: 'o', repo: 'r', number: '205' })),
    );
    expect(error.code).toBe('AUTH_INVALID');
  });
});

describe('atomgit adapter pull request listing', () => {
  it('rejects the head filter with UNSUPPORTED_ON_PROVIDER and sends nothing', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/pulls', responses: [jsonResponse([])] }]);

    const error = await expectGitForgeError(
      atomgitAdapter.listPullRequests(
        ctx,
        withProvider<ListPullRequestsParams>({
          owner: 'example-org',
          repo: 'demo-kit',
          head: 'dev',
        }),
      ),
    );

    expect(error.code).toBe('UNSUPPORTED_ON_PROVIDER');
    expect(error.provider).toBe('atomgit');
    expect(error.capability).toBe('pulls.list.headFilter');
    expect(error.retryable).toBe(false);
    // The whole point: no unfiltered result is returned as if filtered.
    expect(mock.calls).toHaveLength(0);
  });

  it('lists pull requests normally when no head filter is given', async () => {
    const pulls = await fixture('pulls');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/pulls', responses: [jsonResponse(pulls)] }]);

    const result = await atomgitAdapter.listPullRequests(
      ctx,
      withProvider<ListPullRequestsParams>({
        owner: 'example-org',
        repo: 'demo-kit',
        state: 'all',
      }),
    );

    expect(result).toHaveLength(3);
    expect(result.map((pull) => pull.state)).toEqual(['closed', 'open', 'closed']);
    expect(result.map((pull) => pull.merged)).toEqual([true, false, false]);
  });

  it('uses milestone_number for pull requests and milestone for issues', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/pulls', responses: [jsonResponse([])] },
      { match: '/issues', responses: [jsonResponse([])] },
    ]);

    await atomgitAdapter.listPullRequests(
      ctx,
      withProvider<ListPullRequestsParams>({ owner: 'o', repo: 'r', milestone: 5 }),
    );
    await atomgitAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'o', repo: 'r', milestone: 5 }),
    );

    const pullUrl = new URL(mock.calls[0]?.url ?? '');
    expect(pullUrl.searchParams.get('milestone_number')).toBe('5');
    expect(pullUrl.searchParams.get('milestone')).toBeNull();

    const issueUrl = new URL(mock.calls[1]?.url ?? '');
    expect(issueUrl.searchParams.get('milestone')).toBe('5');
    expect(issueUrl.searchParams.get('milestone_number')).toBeNull();
  });

  it('forwards labels as a comma-joined string on both list endpoints', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/pulls', responses: [jsonResponse([])] },
      { match: '/issues', responses: [jsonResponse([])] },
    ]);

    await atomgitAdapter.listPullRequests(
      ctx,
      withProvider<ListPullRequestsParams>({ owner: 'o', repo: 'r', labels: ['bug', 'docs'] }),
    );
    await atomgitAdapter.listIssues(
      ctx,
      withProvider<ListIssuesParams>({ owner: 'o', repo: 'r', labels: ['bug', 'docs'] }),
    );

    for (const call of mock.calls) {
      expect(new URL(call.url).searchParams.get('labels')).toBe('bug,docs');
    }
  });
});

describe('atomgit adapter pull request head backfill', () => {
  it('backfills a missing head from a single list call and costs exactly 2 requests', async () => {
    const detail = await fixture('pull-detail-no-head');
    const list = await fixture('pulls');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/pulls/403', method: 'GET', responses: [jsonResponse(detail)] },
      { match: '/pulls', method: 'GET', responses: [jsonResponse(list)] },
    ]);

    const result = await atomgitAdapter.getPullRequest(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 403 }),
    );

    // The detail payload has no head and no source_branch; the list payload has
    // both, so the mapped object must end up with a non-empty ref.
    expect(result.head?.ref).toBe('dev');
    expect(result.head?.sha).toBe('ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03');

    // Exactly two requests: one detail read plus one list read. A per-missing-row
    // strategy would have issued N calls; this asserts the bounded form.
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.url).toContain('/pulls/403');
    expect(mock.calls[1]?.url).toContain('/pulls?');
    const listUrl = new URL(mock.calls[1]?.url ?? '');
    expect(listUrl.searchParams.get('state')).toBe('all');
    expect(listUrl.searchParams.get('per_page')).toBe('100');
  });

  it('does not issue a list call when the detail payload already has head', async () => {
    const list = await fixture('pulls');
    const withHead = (list as Record<string, unknown>[])[0];
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/pulls/403', responses: [jsonResponse(withHead)] }]);

    const result = await atomgitAdapter.getPullRequest(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 403 }),
    );

    expect(result.head?.ref).toBe('dev');
    expect(mock.calls).toHaveLength(1);
  });

  it('leaves head absent when the list does not contain the pull request', async () => {
    const detail = await fixture('pull-detail-no-head');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/pulls/403', responses: [jsonResponse(detail)] },
      // An empty list means the pull request genuinely is not there.
      { match: '/pulls', responses: [jsonResponse([])] },
    ]);

    const result = await atomgitAdapter.getPullRequest(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 403 }),
    );

    // Absent rather than invented: a fabricated `{ref:'', sha:''}` would look
    // valid to a caller.
    expect(result).not.toHaveProperty('head');
    expect(mock.calls).toHaveLength(2);
  });

  it('makes only one list call regardless of how many rows miss head', async () => {
    const list = await fixture('pulls');
    const rows = list as Record<string, unknown>[];
    // Two pull requests without head in the detail payload.
    const detailOne = { ...rows[0], head: undefined };
    const detailThree = { ...rows[2], head: undefined };

    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/pulls/403', method: 'GET', responses: [jsonResponse(detailOne)] },
      { match: '/pulls/401', method: 'GET', responses: [jsonResponse(detailThree)] },
      { match: '/pulls', method: 'GET', responses: [jsonResponse(list)] },
    ]);

    await atomgitAdapter.getPullRequest(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 403 }),
    );
    await atomgitAdapter.getPullRequest(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', number: 401 }),
    );

    // Two detail reads + two list reads: the list is fetched once per call, never
    // once per missing row inside a call.
    expect(mock.calls).toHaveLength(4);
    expect(mock.calls.filter((call) => new URL(call.url).pathname.endsWith('/pulls'))).toHaveLength(
      2,
    );
  });
});

describe('atomgit adapter repositories', () => {
  it('takes owner from namespace.path and html_url from web_url verbatim', async () => {
    const repo = await fixture('repo');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/repos/example-org/demo-kit', responses: [jsonResponse(repo)] }]);

    const result = await atomgitAdapter.getRepository(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit' }),
    );

    expect(result.owner).toBe('example-org');
    // `web_url` is used as-is: no string building, no `human_name` (which has
    // spaces) and no null `html_url`.
    expect(result.html_url).toBe('https://atomgit.com/example-org/demo-kit');
    expect(result.html_url).not.toContain(' ');
    expect(result.full_name).toBe('example-org/demo-kit');
    expect(result.private).toBe(false);
  });

  it('lists organization repositories through the /orgs endpoint', async () => {
    const repos = await fixture('repos');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/orgs/example-org/repos', responses: [jsonResponse(repos)] }]);

    const result = await atomgitAdapter.listRepositories(ctx, withProvider({ org: 'example-org' }));

    expect(mock.calls[0]?.url).toContain('/orgs/example-org/repos');
    expect(result).toHaveLength(1);
    expect(result[0]?.html_url).toBe('https://atomgit.com/example-org/demo-kit');
  });

  it("lists a user's repositories through /users/{user}/repos", async () => {
    const repos = await fixture('repos');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/users/example-user/repos', responses: [jsonResponse(repos)] }]);

    const result = await atomgitAdapter.listRepositories(
      ctx,
      withProvider({ user: 'example-user' }),
    );

    expect(mock.calls[0]?.url).toBe(
      'https://api.atomgit.com/api/v5/users/example-user/repos?per_page=100&page=1',
    );
    expect(result).toHaveLength(1);
    // The payload's namespace still wins over the requested user.
    expect(result[0]?.owner).toBe('example-org');
  });

  it('maps a missing file path to NOT_FOUND and a directory to INVALID_ARGUMENT', async () => {
    const contents = await fixture('contents');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/contents/README.md', responses: [jsonResponse(contents)] },
      {
        match: '/contents/missing.md',
        responses: [
          jsonResponse(
            {
              error_code: 404,
              error_code_name: 'UN_KNOW',
              error_message: 'Project or file not found',
              trace_id: 't1',
            },
            { status: 404 },
          ),
        ],
      },
      { match: '/contents/docs', responses: [jsonResponse([{ name: 'a.md', type: 'file' }])] },
    ]);

    const file = await atomgitAdapter.getFileContents(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', path: 'README.md' }),
    );
    expect(file.path).toBe('README.md');
    expect(file.encoding).toBe('base64');

    // Unlike Gitee's 200 + [], AtomGit answers 404 for a missing path.
    const missing = await expectGitForgeError(
      atomgitAdapter.getFileContents(
        ctx,
        withProvider({ owner: 'o', repo: 'r', path: 'missing.md' }),
      ),
    );
    expect(missing.code).toBe('NOT_FOUND');

    const directory = await expectGitForgeError(
      atomgitAdapter.getFileContents(ctx, withProvider({ owner: 'o', repo: 'r', path: 'docs' })),
    );
    expect(directory.code).toBe('INVALID_ARGUMENT');
  });
});

describe('atomgit adapter files', () => {
  it('throws UNSUPPORTED_ON_PROVIDER for pushFiles without any request', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '', responses: [jsonResponse({})] }]);

    // `unsupported()` throws synchronously, so the call is wrapped in a thunk
    // before the async assertion helper sees it.
    const error = await expectGitForgeError(
      Promise.resolve().then(() =>
        atomgitAdapter.pushFiles(
          ctx,
          withProvider({
            owner: 'o',
            repo: 'r',
            branch: 'dev',
            message: 'm',
            files: [{ path: 'a.txt', action: 'create' as const, content: 'x' }],
          }),
        ),
      ),
    );

    expect(error.code).toBe('UNSUPPORTED_ON_PROVIDER');
    expect(error.provider).toBe('atomgit');
    expect(error.capability).toBe('files.pushFiles');

    // The batch is not split into per-file commits: that would break the "one
    // commit" contract and could leave a partial, unrecoverable write.
    expect(mock.calls).toHaveLength(0);
  });

  it('sends delete parameters in a JSON body with no query string', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/contents/tmp/a.txt',
        method: 'DELETE',
        responses: [
          jsonResponse({
            commit: {
              sha: 'ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
              html_url:
                'https://atomgit.com/example-org/demo-kit/commits/detail/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
            },
            content: { html_url: 'https://atomgit.com/example-org/demo-kit/blob/dev/tmp/a.txt' },
          }),
        ],
      },
    ]);

    const result = await atomgitAdapter.deleteFile(
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
    expect(call?.method).toBe('DELETE');
    expect(new URL(call?.url ?? '').search).toBe('');
    expect(call?.json).toMatchObject({ sha: 'blobsha', message: 'rm', branch: 'dev' });
    expect(result.commit_sha).toBe('ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05');
    expect(result.commit_html_url).toContain('/commits/detail/');
  });

  it('creates a file through POST contents and keeps the platform commit url', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/contents/tmp/a.txt',
        method: 'POST',
        responses: [
          jsonResponse(
            {
              commit: {
                sha: 'ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
                html_url:
                  'https://atomgit.com/example-org/demo-kit/commits/detail/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
              },
              content: { html_url: 'https://atomgit.com/example-org/demo-kit/blob/dev/tmp/a.txt' },
            },
            { status: 201 },
          ),
        ],
      },
    ]);

    const result = await atomgitAdapter.createFile(
      ctx,
      withProvider({
        owner: 'example-org',
        repo: 'demo-kit',
        path: 'tmp/a.txt',
        content: 'aGk=',
        message: 'add',
        branch: 'dev',
      }),
    );

    expect(mock.calls[0]?.method).toBe('POST');
    expect(result.commit_html_url).toBe(
      'https://atomgit.com/example-org/demo-kit/commits/detail/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    );
    expect(result.file_html_urls).toEqual([
      'https://atomgit.com/example-org/demo-kit/blob/dev/tmp/a.txt',
    ]);
  });

  it('requires a sha on update', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/contents/', responses: [jsonResponse({})] }]);

    const error = await expectGitForgeError(
      atomgitAdapter.updateFile(
        ctx,
        withProvider({ owner: 'o', repo: 'r', path: 'a.txt', content: 'aGk=', message: 'm' }),
      ),
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('atomgit adapter branches and commits', () => {
  it('derives branch html_url on the web host', async () => {
    const branches = await fixture('branches');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([{ match: '/branches', responses: [jsonResponse(branches)] }]);

    const result = await atomgitAdapter.listBranches(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit' }),
    );

    expect(result[0]?.html_url).toBe('https://atomgit.com/example-org/demo-kit/tree/dev');
    expect(result[1]?.html_url).toBe('https://atomgit.com/example-org/demo-kit/tree/feat/sample');
    expect(mock.calls).toHaveLength(1);
  });

  it('creates a branch with refs and branch_name', async () => {
    const created = {
      commit: { sha: 'ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02' },
      name: 'feat/x',
      protected: false,
    };
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/branches', method: 'POST', responses: [jsonResponse(created, { status: 201 })] },
    ]);

    const branch = await atomgitAdapter.createBranch(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', name: 'feat/x', from: 'dev' }),
    );

    // AtomGit mirrors Gitee here: `refs` plus `branch_name`, not GitHub's `ref`/`sha`.
    expect(mock.calls[0]?.json).toEqual({ refs: 'dev', branch_name: 'feat/x' });
    expect(branch.name).toBe('feat/x');
    expect(branch.commit_sha).toBe('ab02ab02ab02ab02ab02ab02ab02ab02ab02ab02');
    expect(branch.html_url).toBe('https://atomgit.com/example-org/demo-kit/tree/feat/x');
    expect(mock.calls).toHaveLength(1);
  });

  it('keeps the commits/detail html_url verbatim', async () => {
    const commits = await fixture('commits');
    const commit = await fixture('commit');
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/commits/ab03ab03', responses: [jsonResponse(commit)] },
      { match: '/commits', method: 'GET', responses: [jsonResponse(commits)] },
    ]);

    const list = await atomgitAdapter.listCommits(
      ctx,
      withProvider({ owner: 'example-org', repo: 'demo-kit', branch: 'dev' }),
    );
    expect(list[0]?.html_url).toBe(
      'https://atomgit.com/example-org/demo-kit/commits/detail/ab03ab03ab03ab03ab03ab03ab03ab03ab03ab03',
    );
    expect(list[0]?.author?.date).toBe('2025-05-01T16:00:00+08:00');

    const single = await atomgitAdapter.getCommit(
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

describe('AtomGit PR detail and conversation links', () => {
  it.each([true, false])(
    'recovers a missing base only from the same list row (match=%s)',
    async (match) => {
      const { ctx, mock } = buildHarness(atomgitAdapter);
      const detail = { number: 7, head: { ref: 'feature', sha: 'h' } };
      const base = { ref: 'dev', sha: 'b' };
      mock.setRoutes([
        {
          match: '/pulls/7',
          responses: [jsonResponse(detail, { headers: { 'x-request-id': 'pr-id' } })],
        },
        { match: '/pulls', responses: [jsonResponse([{ number: match ? 7 : 8, base }])] },
      ]);
      const result = atomgitAdapter.getPullRequest(
        ctx,
        withProvider({ owner: 'o', repo: 'r', number: 7 }),
      );
      if (match) await expect(result).resolves.toMatchObject({ base, head: detail.head });
      else
        await expect(result).rejects.toMatchObject({
          code: 'PROVIDER_ERROR',
          status: 200,
          requestId: 'pr-id',
        });
      expect(mock.calls).toHaveLength(2);
    },
  );
  it('links listed and created notes to the web merge request, not the API path', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter, {
      webBaseUrl: 'https://forge.example.invalid',
    });
    mock.setRoutes([
      { match: '/pulls/7/comments', method: 'GET', responses: [jsonResponse([{ id: 4 }])] },
      { match: '/pulls/7/comments', method: 'POST', responses: [jsonResponse({ id: 5 })] },
    ]);
    const args = withProvider({ owner: 'o', repo: 'r', number: 7, body: 'note' });
    const [listed] = await atomgitAdapter.listPullRequestComments(ctx, args);
    const created = await atomgitAdapter.createPullRequestComment(ctx, args);
    expect([listed?.html_url, created.html_url]).toEqual(
      Array(2).fill('https://forge.example.invalid/o/r/merge_requests/7'),
    );
  });
});

describe('AtomGit pull request identity', () => {
  const args = withProvider({ owner: 'o', repo: 'r', number: 7 });
  const base = { ref: 'main', sha: 'base-tip' },
    head = { ref: 'topic', sha: 'head-tip' };
  it.each([
    ['fast path, wrong number', { number: 8, base, head }],
    ['fallback, wrong number', { number: 8 }],
    ['fast path, no number', { base, head }],
    ['fallback, no number', {}],
    ['array', []],
    ['null', null],
    ['scalar', '7'],
    ['fraction', { number: 7.5 }],
    ['unsafe integer', { number: 9007199254740992 }],
    ['exponent', { number: '7e0' }],
    ['boolean', { number: true }],
    ['zero', { number: 0 }],
    ['conflicting aliases', { number: '8', iid: 7 }],
  ])('rejects detail before any fallback: %s', async (_name, detail) => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/pulls/7',
        responses: [jsonResponse(detail, { headers: { 'x-request-id': 'detail-id' } })],
      },
      { match: '/pulls', responses: [jsonResponse([{ number: 7, base, head }])] },
    ]);
    await expect(atomgitAdapter.getPullRequest(ctx, args)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      provider: 'atomgit',
      status: 200,
      requestId: 'detail-id',
    });
    expect(mock.calls).toHaveLength(1);
    expect(new URL(mock.calls[0]!.url).pathname).toMatch(/\/pulls\/7$/);
  });
  it.each([{ number: '007' }, { iid: 7 }, { number: 7, iid: '7' }])(
    'accepts a verified detail identity %j',
    async (identity) => {
      const { ctx, mock } = buildHarness(atomgitAdapter);
      mock.setRoutes([
        { match: '/pulls/7', responses: [jsonResponse({ ...identity, base, head })] },
      ]);
      await expect(atomgitAdapter.getPullRequest(ctx, args)).resolves.toMatchObject({
        number: 7,
        base,
        head,
      });
      expect(mock.calls).toHaveLength(1);
    },
  );
  it.each([{}, { number: ' 7' }, { iid: '0x7' }, { number: '9007199254740993' }, { number: -1 }])(
    'rejects a list identity %j instead of manufacturing a number',
    async (identity) => {
      const { ctx, mock } = buildHarness(atomgitAdapter);
      mock.setRoutes([
        {
          match: '/pulls',
          responses: [
            jsonResponse([{ ...identity, base }], { headers: { 'x-request-id': 'list-id' } }),
          ],
        },
      ]);
      await expect(atomgitAdapter.listPullRequests(ctx, args)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        provider: 'atomgit',
        status: 200,
        requestId: 'list-id',
      });
      expect(mock.calls).toHaveLength(1);
    },
  );
  it('does not coerce a fallback row into the requested number', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      { match: '/pulls/7', responses: [jsonResponse({ number: 7, base })] },
      {
        match: '/pulls',
        responses: [
          jsonResponse([{ number: '7e0', head }], { headers: { 'x-request-id': 'fallback-id' } }),
        ],
      },
    ]);
    await expect(atomgitAdapter.getPullRequest(ctx, args)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      provider: 'atomgit',
      status: 200,
      requestId: 'fallback-id',
    });
    expect(mock.calls).toHaveLength(2);
  });
});
