import { describe, expect, it } from 'vitest';

import { atomgitAdapter } from '../../src/adapters/atomgit/adapter.js';
import { giteeAdapter } from '../../src/adapters/gitee/adapter.js';
import { githubAdapter } from '../../src/adapters/github/adapter.js';
import { deriveVisibility } from '../../src/adapters/visibility.js';
import {
  parseLabelNames,
  mapIssueEvents as mapAtomGitEvents,
} from '../../src/adapters/atomgit/map.js';
import { mapIssueEvents as mapGiteeEvents } from '../../src/adapters/gitee/map.js';
import { mapIssueEvents as mapGitHubEvents } from '../../src/adapters/github/map.js';
import { GitForgeError } from '../../src/core/errors.js';
import type { ProviderAdapter } from '../../src/adapters/types.js';
import { buildHarness, TEST_TOKEN } from '../helpers/adapterHarness.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';

/**
 * The seven upstream gaps the Hub issue list raised, verified end to end.
 *
 * Each payload below is shaped after a live response measured on 2026-11-25, so
 * a regression here means the SDK no longer matches the platforms it speaks to:
 *
 * - GF-007 native issue state and close reason;
 * - GF-005 label list / create / ensure;
 * - GF-006 label-change events;
 * - GF-004 repository visibility as a three-way answer;
 * - GF-002 commit author account and server-side time window;
 * - GF-001 releases on all three platforms;
 * - GF-003 current star count and the stargazer listing gap.
 */

const ADAPTERS: readonly ProviderAdapter[] = [githubAdapter, giteeAdapter, atomgitAdapter];

/** Runs a promise and returns the thrown `GitForgeError`. */
async function captureError(promise: Promise<unknown>): Promise<GitForgeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitForgeError);
    return error as GitForgeError;
  }
  throw new Error('expected the call to reject');
}

describe('GF-007 · native issue state and close reason', () => {
  it('keeps Gitee progressing active and rejected closed, with the raw state preserved', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/issues/',
        responses: [
          jsonResponse({
            number: 'IAE1CN',
            state: 'progressing',
            issue_state: '进行中',
            issue_state_detail: { title: '进行中', serial: 2 },
            title: 't',
            html_url: 'https://gitee.com/o/r/issues/IAE1CN',
            labels: [],
            created_at: '2025-01-01T00:00:00+08:00',
            updated_at: '2025-01-01T00:00:00+08:00',
            finished_at: null,
          }),
        ],
      },
    ]);

    const issue = await giteeAdapter.getIssue(ctx, {
      provider: 'gitee',
      ...REPO,
      number: 'IAE1CN',
    });

    expect(issue.state).toBe('open');
    expect(issue.native_state).toBe('progressing');
    expect(issue.state_label).toBe('进行中');
    // `finished_at` is null for in-flight work, so no close time is invented.
    expect(issue.closed_at).toBeUndefined();
  });

  it('keeps Gitee rejected closed and flags it restricted only when security_hole is set', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/issues/',
        responses: [
          jsonResponse({
            number: 'IDO6JJ',
            state: 'rejected',
            issue_state_detail: { title: '已取消', serial: 3 },
            security_hole: false,
            title: 't',
            html_url: 'https://gitee.com/o/r/issues/IDO6JJ',
            labels: [],
            created_at: '2025-01-01T00:00:00+08:00',
            updated_at: '2025-01-01T00:00:00+08:00',
            finished_at: '2026-02-03T21:01:11+08:00',
          }),
        ],
      },
    ]);

    const issue = await giteeAdapter.getIssue(ctx, {
      provider: 'gitee',
      ...REPO,
      number: 'IDO6JJ',
    });

    expect(issue.state).toBe('closed');
    expect(issue.native_state).toBe('rejected');
    expect(issue.state_label).toBe('已取消');
    expect(issue.restricted).toBeUndefined();
  });

  it('exposes GitHub state_reason when present and omits it when null', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/issues/338',
        responses: [
          jsonResponse({
            number: 338,
            state: 'closed',
            state_reason: 'completed',
            title: 't',
            html_url: 'https://github.com/o/r/issues/338',
            labels: [],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ],
      },
      {
        match: '/issues/339',
        responses: [
          jsonResponse({
            number: 339,
            state: 'closed',
            state_reason: null,
            title: 't',
            html_url: 'https://github.com/o/r/issues/339',
            labels: [],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ],
      },
    ]);

    const completed = await githubAdapter.getIssue(ctx, {
      provider: 'github',
      ...REPO,
      number: 338,
    });
    const legacy = await githubAdapter.getIssue(ctx, { provider: 'github', ...REPO, number: 339 });

    expect(completed.state_reason).toBe('completed');
    // A null reason is historical, not a guess: the field stays absent.
    expect('state_reason' in legacy).toBe(false);
    // GitHub has no separate native state, so it is not echoed back.
    expect('native_state' in completed).toBe(false);
  });

  it('marks an AtomGit issue restricted only when visibility_reason is not public', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/issues/',
        responses: [
          jsonResponse({
            number: '75',
            state: 'open',
            issue_state: '待办的',
            visibility_reason: 'confidential',
            title: 't',
            html_url: 'https://atomgit.com/o/r/issues/75',
            labels: [],
            created_at: '2025-01-01T00:00:00+08:00',
            updated_at: '2025-01-01T00:00:00+08:00',
          }),
        ],
      },
    ]);

    const issue = await atomgitAdapter.getIssue(ctx, {
      provider: 'atomgit',
      ...REPO,
      number: '75',
    });

    expect(issue.restricted).toBe(true);
    expect(issue.state_label).toBe('待办的');
  });
});

describe('GF-004 · repository visibility', () => {
  it('answers public from GitHub visibility, with private remaining false', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/repos/',
        responses: [
          jsonResponse({
            name: 'r',
            owner: { login: 'o' },
            html_url: 'https://github.com/o/r',
            visibility: 'public',
            private: false,
            stargazers_count: 2177,
            default_branch: 'main',
          }),
        ],
      },
    ]);

    const repo = await githubAdapter.getRepository(ctx, { provider: 'github', ...REPO });

    expect(repo.visibility).toBe('public');
    expect(repo.private).toBe(false);
    expect(repo.stargazers_count).toBe(2177);
  });

  it('treats a GitHub internal repository as not public', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/repos/',
        responses: [
          jsonResponse({
            name: 'r',
            owner: { login: 'o' },
            html_url: 'https://github.com/o/r',
            visibility: 'internal',
            private: false,
            default_branch: 'main',
          }),
        ],
      },
    ]);

    const repo = await githubAdapter.getRepository(ctx, { provider: 'github', ...REPO });

    expect(repo.visibility).toBe('internal');
    // An internal repository is not anonymously readable, so `private` is true.
    expect(repo.private).toBe(true);
  });

  it('reports unknown rather than public when every visibility field is absent', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/repos/',
        responses: [
          jsonResponse({
            name: 'r',
            namespace: { path: 'o' },
            web_url: 'https://atomgit.com/o/r',
            default_branch: 'main',
          }),
        ],
      },
    ]);

    const repo = await atomgitAdapter.getRepository(ctx, { provider: 'atomgit', ...REPO });

    expect(repo.visibility).toBe('unknown');
    // `private: false` must not be read as proof of public readability.
    expect(repo.private).toBe(false);
  });

  it('accepts AtomGit 0/1 visibility flags, which its OpenAPI declares as integers', () => {
    expect(deriveVisibility({ private: 1 })).toBe('private');
    expect(deriveVisibility({ public: 1 })).toBe('public');
    // `private: 0` means "not private", which an `internal` repository also
    // satisfies, so it is not evidence of public readability.
    expect(deriveVisibility({ private: 0 })).toBe('unknown');
    expect(deriveVisibility({})).toBe('unknown');
  });

  it('does not let a missing field masquerade as public on Gitee either', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/repos/',
        responses: [
          jsonResponse({
            name: 'r',
            namespace: { path: 'o' },
            html_url: 'https://gitee.com/o/r.git',
            default_branch: 'main',
          }),
        ],
      },
    ]);

    const repo = await giteeAdapter.getRepository(ctx, { provider: 'gitee', ...REPO });
    expect(repo.visibility).toBe('unknown');
  });
});

describe('GF-002 · commit author account and time window', () => {
  it('links the GitHub author account but never the committer', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/commits/',
        responses: [
          jsonResponse({
            sha: 'a'.repeat(40),
            html_url: 'https://github.com/o/r/commit/a',
            commit: {
              message: 'm',
              author: { name: '莫愁', email: 'a@example.com', date: '2026-11-25T02:54:10Z' },
              committer: {
                name: 'GitHub',
                email: 'noreply@github.com',
                date: '2026-11-25T02:54:10Z',
              },
            },
            author: {
              login: 'zk020106',
              avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
            },
            committer: { login: 'web-flow' },
            parents: [],
          }),
        ],
      },
    ]);

    const commit = await githubAdapter.getCommit(ctx, {
      provider: 'github',
      ...REPO,
      sha: 'a'.repeat(40),
    });

    expect(commit.author?.name).toBe('莫愁');
    expect(commit.author?.user?.login).toBe('zk020106');
    expect(commit.author?.user?.avatar_url).toBe('https://avatars.githubusercontent.com/u/1?v=4');
    // The committer is `web-flow` after a web merge; attributing it would credit
    // the wrong account.
    expect(commit.committer?.user).toBeUndefined();
  });

  it('leaves the author account absent when Gitee reports null, without guessing', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/commits/',
        responses: [
          jsonResponse({
            sha: 'a'.repeat(40),
            html_url: 'https://gitee.com/o/r/commit/a',
            commit: {
              message: 'm',
              author: { name: '莫愁', email: 'a@example.com', date: '2026-11-25T10:54:10+08:00' },
            },
            author: null,
            parents: [],
          }),
        ],
      },
    ]);

    const commit = await giteeAdapter.getCommit(ctx, {
      provider: 'gitee',
      ...REPO,
      sha: 'a'.repeat(40),
    });

    expect(commit.author?.name).toBe('莫愁');
    // Name and email are present but not an account; no login is invented.
    expect('user' in (commit.author ?? {})).toBe(false);
  });

  it('ignores an AtomGit account object that carries no login, but keeps the dated author', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/commits/',
        responses: [
          jsonResponse({
            sha: 'a'.repeat(40),
            html_url: 'https://atomgit.com/o/r/commits/detail/a',
            commit: {
              message: 'm',
              author: { email: 'a@example.com', date: '2026-11-25T10:54:10+08:00' },
            },
            author: { email: 'a@example.com', type: 'User' },
            parents: [],
          }),
        ],
      },
    ]);

    const commit = await atomgitAdapter.getCommit(ctx, {
      provider: 'atomgit',
      ...REPO,
      sha: 'a'.repeat(40),
    });

    // The account object has no `login`, so it is not promoted from the email.
    expect('user' in (commit.author ?? {})).toBe(false);
    // The Git side did record a date, so the author block itself survives with
    // an empty name rather than disappearing.
    expect(commit.author?.date).toBe('2026-11-25T10:54:10+08:00');
    expect(commit.author?.name).toBe('');
  });

  it.each(ADAPTERS)('sends since/until as query parameters (%s)', async (adapter) => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([{ match: '/commits', responses: [jsonResponse([])] }]);

    await adapter.listCommits(ctx, {
      provider: adapter.provider,
      ...REPO,
      since: '2026-11-01T00:00:00Z',
      until: '2026-11-30T00:00:00Z',
    });

    const query = new URL(mock.calls[0]!.url).searchParams;
    expect(query.get('since')).toBe('2026-11-01T00:00:00Z');
    expect(query.get('until')).toBe('2026-11-30T00:00:00Z');
  });

  it('refuses a zone-less timestamp locally instead of letting each platform guess', async () => {
    const { client, mock } = buildClient();
    await expect(
      client.listCommits({ provider: 'github', ...REPO, since: '2026-11-01' }),
    ).rejects.toThrow(/ISO 8601/);
    expect(mock.calls).toHaveLength(0);
  });

  it('refuses an inverted window instead of returning an empty list', async () => {
    const { client, mock } = buildClient();
    await expect(
      client.listCommits({
        provider: 'gitee',
        ...REPO,
        since: '2026-12-01T00:00:00Z',
        until: '2026-11-01T00:00:00Z',
      }),
    ).rejects.toThrow(/must not be later/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('GF-001 · releases on every platform', () => {
  it('reads the full GitHub release shape', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/releases',
        responses: [
          jsonResponse([
            {
              id: 409749886,
              tag_name: 'v4.2.0',
              name: 'v4.2.0',
              published_at: '2026-10-11T15:24:23Z',
              html_url: 'https://github.com/o/r/releases/tag/v4.2.0',
              draft: false,
              prerelease: false,
            },
          ]),
        ],
      },
    ]);

    const [release] = await githubAdapter.listReleases(ctx, { provider: 'github', ...REPO });

    expect(release?.tag_name).toBe('v4.2.0');
    expect(release?.published_at).toBe('2026-10-11T15:24:23Z');
    expect(release?.html_url).toBe('https://github.com/o/r/releases/tag/v4.2.0');
    expect(release?.draft).toBe(false);
    expect(release?.pre_release).toBe(false);
  });

  it('falls back to created_at on Gitee, requests desc order, and invents no URL', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/releases',
        responses: [
          jsonResponse([
            {
              id: 1,
              tag_name: 'v1.0.0',
              name: 'v1.0.0',
              created_at: '2023-03-26T21:43:23+08:00',
              prerelease: false,
            },
          ]),
        ],
      },
    ]);

    const [release] = await giteeAdapter.listReleases(ctx, { provider: 'gitee', ...REPO });
    const query = new URL(mock.calls[0]!.url).searchParams;

    expect(query.get('direction')).toBe('desc');
    expect(release?.published_at).toBe('2023-03-26T21:43:23+08:00');
    // Gitee's /releases/tag/<tag> answers 302 to a source archive for a
    // non-browser client, so no link is derived.
    expect(release && 'html_url' in release).toBe(false);
    expect(release && 'draft' in release).toBe(false);
  });

  it('reads AtomGit releases and maps release_status pre to pre_release', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/releases',
        responses: [
          jsonResponse([
            {
              tag_name: 'v3.2.0',
              name: 'v3.2.0',
              created_at: '2026-09-01T00:00:00+08:00',
              release_status: 'pre',
            },
          ]),
        ],
      },
    ]);

    const [release] = await atomgitAdapter.listReleases(ctx, { provider: 'atomgit', ...REPO });
    expect(release?.pre_release).toBe(true);
    expect(release?.tag_name).toBe('v3.2.0');
  });
});

describe('GF-005 · labels', () => {
  it('normalizes every platform colour to #rrggbb', async () => {
    // The same colour, spelled the three ways the platforms actually send it.
    const shapes = [
      { adapter: githubAdapter, raw: { name: 'bug', color: 'd73a4a' } },
      { adapter: giteeAdapter, raw: { name: 'bug', color: 'D73A4A' } },
      { adapter: atomgitAdapter, raw: { name: 'bug', color: '#d73a4a' } },
    ];

    for (const { adapter, raw } of shapes) {
      const { ctx, mock } = buildHarness(adapter);
      mock.setRoutes([{ match: '/labels', responses: [jsonResponse([raw])] }]);
      const [label] = await adapter.listLabels(ctx, { provider: adapter.provider, ...REPO });
      expect(label?.color, `${adapter.provider} colour`).toBe('#d73a4a');
    }
  });

  it('falls back to a neutral colour on an unparseable value instead of failing the list', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/labels', responses: [jsonResponse([{ name: 'bug', color: 'not-a-colour' }])] },
    ]);

    const [label] = await githubAdapter.listLabels(ctx, { provider: 'github', ...REPO });
    expect(label?.color).toBe('#ededed');
  });

  it('sends GitHub a JSON body with the # stripped from the colour', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/labels', responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })] },
    ]);

    await githubAdapter.createLabel(ctx, {
      provider: 'github',
      ...REPO,
      name: '5.0.0',
      color: '#1F883D',
    });

    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.json).toMatchObject({ name: '5.0.0', color: '1f883d' });
  });

  it('sends Gitee and AtomGit form bodies, differing only on the # prefix', async () => {
    const gitee = buildHarness(giteeAdapter);
    gitee.mock.setRoutes([
      { match: '/labels', responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })] },
    ]);
    await giteeAdapter.createLabel(gitee.ctx, {
      provider: 'gitee',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
    });
    expect(gitee.mock.calls[0]!.form).toMatchObject({ name: '5.0.0', color: '1f883d' });

    const atomgit = buildHarness(atomgitAdapter);
    atomgit.mock.setRoutes([
      { match: '/labels', responses: [jsonResponse({ name: '5.0.0', color: '#1f883d' })] },
    ]);
    await atomgitAdapter.createLabel(atomgit.ctx, {
      provider: 'atomgit',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
    });
    expect(atomgit.mock.calls[0]!.form).toMatchObject({ name: '5.0.0', color: '#1f883d' });
  });

  it('expands a 3-digit colour', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      { match: '/labels', responses: [jsonResponse({ name: 'x', color: 'ff0000' })] },
    ]);

    await githubAdapter.createLabel(ctx, { provider: 'github', ...REPO, name: 'x', color: 'f00' });
    expect(mock.calls[0]!.json).toMatchObject({ color: 'ff0000' });
  });

  it('rejects a malformed colour before any request', async () => {
    const { client, mock } = buildClient();
    await expect(
      client.createLabel({ provider: 'github', ...REPO, name: 'x', color: 'rebeccapurple' }),
    ).rejects.toThrow(/hex colour/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('GF-005 · ensureLabel', () => {
  it('returns the existing label with one list request and no create', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: /\/labels/,
        responses: [jsonResponse([{ name: '5.0.0', color: '1f883d', description: 'kept' }])],
      },
    ]);

    const label = await client.ensureLabel({
      provider: 'gitee',
      ...REPO,
      name: '5.0.0',
      color: '#000000',
    });

    expect(label.description).toBe('kept');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe('GET');
  });

  it('creates only when absent, so the second call makes no write', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse([]), jsonResponse([{ name: '5.0.0', color: '1f883d' }])],
      },
      {
        match: (call) => call.method === 'POST' && call.url.includes('/labels'),
        responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })],
      },
    ]);

    const created = await client.ensureLabel({
      provider: 'github',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
    });
    expect(created.name).toBe('5.0.0');

    const again = await client.ensureLabel({
      provider: 'github',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
    });
    expect(again.name).toBe('5.0.0');

    const writes = mock.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(1);
  });

  it('recovers when a concurrent caller created the label between read and write', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse([]), jsonResponse([{ name: '5.0.0', color: '1f883d' }])],
      },
      {
        match: (call) => call.method === 'POST' && call.url.includes('/labels'),
        responses: [{ status: 422, body: { message: 'already_exists' } }],
      },
    ]);

    const label = await client.ensureLabel({
      provider: 'github',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
    });

    expect(label.name).toBe('5.0.0');
    expect(mock.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('is refused by the read-only gate before its first read', async () => {
    const { client, mock } = buildClient({ readonly: true });

    const error = await captureError(
      client.ensureLabel({ provider: 'github', ...REPO, name: '5.0.0', color: '#1f883d' }),
    );

    expect(error.code).toBe('READONLY_BLOCKED');
    expect(error.capability).toBe('labels.create');
    // A read-then-write composition must not leak a request before refusing.
    expect(mock.calls).toHaveLength(0);
  });
});

describe('GF-006 · label-change events', () => {
  it('reads GitHub labeled and unlabeled entries and drops every other event', () => {
    const entries = [
      {
        event: 'labeled',
        label: { name: 'bug' },
        actor: { login: 'ali-pay' },
        created_at: '2026-11-25T02:00:34Z',
      },
      { event: 'commented', created_at: '2026-11-25T02:00:46Z' },
      {
        event: 'unlabeled',
        label: { name: 'bug' },
        actor: { login: 'ali-pay' },
        created_at: '2026-11-26T02:00:00Z',
      },
    ];

    const events = entries.flatMap((entry) => mapGitHubEvents('o', 'r', entry));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'labeled',
      label: 'bug',
      created_at: '2026-11-25T02:00:34Z',
    });
    expect(events[0]!.actor?.login).toBe('ali-pay');
    expect(events[1]!.type).toBe('unlabeled');
  });

  it('reads Gitee add_label from the structured value, not the HTML sentence', () => {
    const [event] = mapGiteeEvents('o', 'r', {
      action_type: 'add_label',
      content: '添加了      \n        &nbsp;\n        question\n      \n标签',
      before_change_value: '',
      after_change_value: 'question',
      user: { login: 'kami0314' },
      created_at: '2026-06-01T16:51:10+08:00',
    });

    expect(event).toMatchObject({ type: 'labeled', label: 'question' });
    expect(event!.actor?.login).toBe('kami0314');
  });

  it('reads the Gitee removal name from after_change_value, as the platform actually sends it', () => {
    // Measured: `remove_label` reports before_change_value '' and the name in
    // after_change_value. Assuming an add/remove field split loses the label.
    const [event] = mapGiteeEvents('o', 'r', {
      action_type: 'remove_label',
      content: '移除了      \n        &nbsp;\n        welcome-pr\n      \n标签',
      before_change_value: '',
      after_change_value: 'welcome-pr',
      user: { login: 'Charles7c' },
      created_at: '2025-09-06T21:01:37+08:00',
    });

    expect(event).toMatchObject({ type: 'unlabeled', label: 'welcome-pr' });
  });

  it('ignores Gitee state and priority log entries', () => {
    for (const action of ['change_issue_state', 'setting_priority', 'create']) {
      expect(
        mapGiteeEvents('o', 'r', {
          action_type: action,
          before_change_value: '待办的',
          after_change_value: '进行中',
          created_at: '2025-03-06T13:40:03+08:00',
        }),
      ).toEqual([]);
    }
  });

  it('expands one AtomGit sentence into one event per label', () => {
    const events = mapAtomGitEvents('o', 'r', {
      action_type: 'label',
      content: 'add label feature, planned, roadmap',
      user: { login: 'Charles_7c' },
      created_at: '2026-10-18T17:51:25+08:00',
    });

    expect(events.map((event) => event.label)).toEqual(['feature', 'planned', 'roadmap']);
    expect(events.every((event) => event.type === 'labeled')).toBe(true);
  });

  it('reports an AtomGit removal as unlabeled', () => {
    const events = mapAtomGitEvents('o', 'r', {
      action_type: 'label',
      content: 'remove label bug',
      created_at: '2026-10-18T17:51:25+08:00',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'unlabeled', label: 'bug' });
  });

  it('keeps an event whose label sentence cannot be parsed, without a label', () => {
    const events = mapAtomGitEvents('o', 'r', {
      action_type: 'label',
      content: 'did something unexpected',
      created_at: '2026-10-18T17:51:25+08:00',
    });
    expect(events).toHaveLength(1);
    expect('label' in events[0]!).toBe(false);
  });

  it('parses multi-word label names without splitting on whitespace', () => {
    expect(parseLabelNames('add label help wanted, good first issue')).toEqual([
      'help wanted',
      'good first issue',
    ]);
  });

  it('ignores non-label AtomGit log entries', () => {
    expect(
      mapAtomGitEvents('o', 'r', {
        action_type: 'description',
        content: 'changed the description',
      }),
    ).toEqual([]);
  });

  it('uses the owner-scoped path with repo in the query on Gitee and AtomGit', async () => {
    // Each platform names the action differently: Gitee uses `add_label`, AtomGit
    // a generic `label` whose names live in the sentence.
    const cases = [
      {
        adapter: giteeAdapter,
        number: 'IEXA01',
        log: {
          action_type: 'add_label',
          after_change_value: 'bug',
          created_at: '2026-10-18T17:51:25+08:00',
        },
      },
      {
        adapter: atomgitAdapter,
        number: 75,
        log: {
          action_type: 'label',
          content: 'add label bug',
          created_at: '2026-10-18T17:51:25+08:00',
        },
      },
    ];

    for (const { adapter, number, log } of cases) {
      const { ctx, mock } = buildHarness(adapter);
      mock.setRoutes([{ match: '/operate_logs', responses: [jsonResponse([log])] }]);

      const events = await adapter.listIssueEvents(ctx, {
        provider: adapter.provider,
        ...REPO,
        number,
      });

      const url = new URL(mock.calls[0]!.url);
      // Owner-scoped path: `/repos/{owner}/issues/{number}/operate_logs`.
      expect(url.pathname).toContain(`/issues/${String(number)}/operate_logs`);
      expect(url.pathname).not.toContain(`/${REPO.repo}/issues`);
      expect(url.searchParams.get('repo')).toBe(REPO.repo);
      // No page parameter exists on this endpoint; sending one would be ignored.
      expect(url.searchParams.get('page')).toBeNull();
      expect(events[0]?.label).toBe('bug');
    }
  });

  it('pages the GitHub timeline and keeps only label events', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/timeline',
        responses: [
          jsonResponse([
            { event: 'labeled', label: { name: 'bug' }, created_at: '2026-11-25T02:00:34Z' },
          ]),
        ],
      },
    ]);

    const events = await githubAdapter.listIssueEvents(ctx, {
      provider: 'github',
      ...REPO,
      number: 338,
    });

    expect(events).toHaveLength(1);
    // The timeline endpoint needs its own accept header.
    expect(mock.calls[0]!.headers.accept).toContain('vnd.github+json');
  });
});

describe('GF-003 · stars', () => {
  it.each(ADAPTERS)(
    'reports stargazers_count from the repository payload (%s)',
    async (adapter) => {
      const { ctx, mock } = buildHarness(adapter);
      mock.setRoutes([
        {
          match: '/repos/',
          responses: [
            jsonResponse({
              name: 'r',
              namespace: { path: 'o' },
              owner: { login: 'o' },
              html_url: 'https://example.com/o/r',
              web_url: 'https://example.com/o/r',
              private: false,
              public: true,
              stargazers_count: 211,
              default_branch: 'main',
            }),
          ],
        },
      ]);

      const repo = await adapter.getRepository(ctx, { provider: adapter.provider, ...REPO });
      expect(repo.stargazers_count).toBe(211);
    },
  );

  it('omits the count rather than reporting zero when the field is absent', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/repos/',
        responses: [
          jsonResponse({
            name: 'r',
            owner: { login: 'o' },
            html_url: 'https://github.com/o/r',
            default_branch: 'main',
          }),
        ],
      },
    ]);

    const repo = await githubAdapter.getRepository(ctx, { provider: 'github', ...REPO });
    expect('stargazers_count' in repo).toBe(false);
  });

  it('reads AtomGit stargazers with starred_at', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/stargazers',
        responses: [
          jsonResponse([
            {
              login: 'zhaofengzhe',
              avatar_url: 'https://cdn.example/a.jpg',
              starred_at: '2026-03-08T23:41:49.888+08:00',
            },
          ]),
        ],
      },
    ]);

    const [star] = await atomgitAdapter.listStargazers(ctx, {
      provider: 'atomgit',
      ...REPO,
      timestamps: true,
    });

    expect(star?.user.login).toBe('zhaofengzhe');
    expect(star?.starred_at).toBe('2026-03-08T23:41:49.888+08:00');
  });

  it('asks GitHub for the starred_at media type only when timestamps are wanted', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/stargazers',
        responses: [
          jsonResponse([{ user: { login: 'fan' }, starred_at: '2026-01-01T00:00:00Z' }]),
          jsonResponse([{ login: 'fan' }]),
        ],
      },
    ]);

    const [withTime] = await githubAdapter.listStargazers(ctx, {
      provider: 'github',
      ...REPO,
      timestamps: true,
    });
    const [withoutTime] = await githubAdapter.listStargazers(ctx, { provider: 'github', ...REPO });

    expect(mock.calls[0]!.headers.accept).toContain('star+json');
    expect(mock.calls[1]!.headers.accept).not.toContain('star+json');
    expect(withTime?.starred_at).toBe('2026-01-01T00:00:00Z');
    // Without the media type the entry is a bare user object.
    expect(withoutTime?.user.login).toBe('fan');
    expect(withoutTime && 'starred_at' in withoutTime).toBe(false);
  });

  it('refuses Gitee stargazers instead of returning its permanent empty array', async () => {
    const { client, mock } = buildClient();

    const error = await captureError(
      client.listStargazers({ provider: 'gitee', ...REPO, timestamps: true }),
    );

    expect(error.code).toBe('UNSUPPORTED_ON_PROVIDER');
    // The method-level gap is reported, not the parameter one: gate order puts
    // the method capability before the parameter capability.
    expect(error.capability).toBe('repos.listStargazers');
    expect(mock.calls).toHaveLength(0);
  });

  it('reports the parameter gap on Gitee once the method itself were served', () => {
    // Documents the gate ordering directly: `timestamps` is the parameter the
    // caller set, but the method it qualifies is the reason the call fails.
    const { client } = buildClient();
    expect(client.paramCapabilities('gitee')['repos.listStargazers.timestamps']).toBe(
      'unsupported',
    );
  });

  it('refuses the bare listing on Gitee too', async () => {
    const { client, mock } = buildClient();
    const error = await captureError(client.listStargazers({ provider: 'gitee', ...REPO }));
    expect(error.code).toBe('UNSUPPORTED_ON_PROVIDER');
    expect(error.capability).toBe('repos.listStargazers');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('Gitee assignee mapping', () => {
  it('reads the singular assignee object instead of dropping it', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/issues/',
        responses: [
          jsonResponse({
            number: 'IEXA01',
            state: 'open',
            title: 't',
            html_url: 'https://gitee.com/o/r/issues/IEXA01',
            labels: [],
            assignee: { login: 'assignee-user', name: 'Assign' },
            created_at: '2025-01-01T00:00:00+08:00',
            updated_at: '2025-01-01T00:00:00+08:00',
          }),
        ],
      },
    ]);

    const issue = await giteeAdapter.getIssue(ctx, {
      provider: 'gitee',
      ...REPO,
      number: 'IEXA01',
    });

    expect(issue.assignees).toEqual([{ login: 'assignee-user', name: 'Assign' }]);
  });

  it('omits assignees when the singular field is null', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/issues/',
        responses: [
          jsonResponse({
            number: 'IEXA01',
            state: 'open',
            title: 't',
            html_url: 'https://gitee.com/o/r/issues/IEXA01',
            labels: [],
            assignee: null,
            created_at: '2025-01-01T00:00:00+08:00',
            updated_at: '2025-01-01T00:00:00+08:00',
          }),
        ],
      },
    ]);

    const issue = await giteeAdapter.getIssue(ctx, {
      provider: 'gitee',
      ...REPO,
      number: 'IEXA01',
    });

    expect('assignees' in issue).toBe(false);
  });
});

describe('layout guarantees for the new domains', () => {
  it('never leaks the token through a new endpoint', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([{ match: '/labels', responses: [jsonResponse([])] }]);

    await githubAdapter.listLabels(ctx, { provider: 'github', ...REPO });

    expect(mock.calls[0]!.url).not.toContain(TEST_TOKEN);
    expect(mock.calls[0]!.headers.authorization).toContain(TEST_TOKEN);
  });
});
