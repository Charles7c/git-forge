import { describe, expect, it } from 'vitest';

import { atomgitAdapter } from '../../src/adapters/atomgit/adapter.js';
import { giteeAdapter } from '../../src/adapters/gitee/adapter.js';
import { githubAdapter } from '../../src/adapters/github/adapter.js';
import { deriveVisibility } from '../../src/adapters/visibility.js';
import { mapIssueEvents as mapAtomGitEvents } from '../../src/adapters/atomgit/map.js';
import { mapCommit as mapAtomGitCommit } from '../../src/adapters/atomgit/map.js';
import { mapCommit as mapGiteeCommit } from '../../src/adapters/gitee/map.js';
import { mapCommit as mapGitHubCommit } from '../../src/adapters/github/map.js';
import { GitForgeError } from '../../src/core/errors.js';
import { MAX_PAGES_LIMIT } from '../../src/core/paginate.js';
import { buildHarness } from '../helpers/adapterHarness.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';

/**
 * Regression suite for the counter-examples Hub reproduced against the 0.1.0
 * pre-release work tree, plus the 0.2.0 release-blocking ones.
 *
 * Each case is a *wrong result*, not a missing feature: the call succeeded and
 * returned something plausible but unfounded. That is why they are asserted
 * here rather than left to coverage.
 */

async function captureError(promise: Promise<unknown>): Promise<GitForgeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitForgeError);
    return error as GitForgeError;
  }
  throw new Error('expected the call to reject');
}

/* -------------------------------------------------------------------------- */
/* P1 · GF-004 repository visibility                                           */
/* -------------------------------------------------------------------------- */

describe('P1 · a bare `private: false` is not a public statement', () => {
  it('answers unknown for `{ private: false }` alone', () => {
    // The counter-example: non-private is not the same fact as publicly
    // readable. GitHub Enterprise `internal` repositories also report
    // `private: false`, and a read-only deployment must not trust them.
    expect(deriveVisibility({ private: false })).toBe('unknown');
  });

  it('answers unknown for a bare `private: 0`', () => {
    expect(deriveVisibility({ private: 0 })).toBe('unknown');
  });

  it('answers unknown for a bare `public: true`? no — an explicit public flag is a statement', () => {
    // Kept as an explicit assertion so the asymmetry is deliberate and visible:
    // `public: true` names the fact directly, `private: false` does not.
    expect(deriveVisibility({ public: true })).toBe('public');
  });

  it('still answers public when GitHub states visibility: public', () => {
    expect(deriveVisibility({ visibility: 'public', private: false })).toBe('public');
  });

  it('still answers public when both flags agree', () => {
    expect(deriveVisibility({ private: false, public: true })).toBe('public');
  });

  it('still answers private from either private signal', () => {
    expect(deriveVisibility({ private: true })).toBe('private');
    expect(deriveVisibility({ public: false })).toBe('private');
  });

  it('still answers internal ahead of the booleans', () => {
    expect(deriveVisibility({ internal: true, private: false })).toBe('internal');
  });

  it('propagates unknown through a mapped GitHub repository payload', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    mock.setRoutes([
      {
        match: '/repos/',
        responses: [
          jsonResponse({
            name: 'r',
            owner: { login: 'o' },
            html_url: 'https://github.com/o/r',
            private: false,
            default_branch: 'main',
          }),
        ],
      },
    ]);

    const repo = await githubAdapter.getRepository(ctx, { provider: 'github', ...REPO });
    expect(repo.visibility).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */
/* P2 · GF-005 labels                                                          */
/* -------------------------------------------------------------------------- */

/** A full page of labels that never contains the wanted name. */
function fullPageOfLabels(): { name: string; color: string }[] {
  return Array.from({ length: 100 }, (_, index) => ({
    name: `filler-${String(index)}`,
    color: 'ededed',
  }));
}

describe('P2 · ensureLabel must not write when the listing was truncated', () => {
  it('refuses to create when the page budget ended while more pages existed', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [
          jsonResponse(fullPageOfLabels(), {
            headers: { total_page: String(MAX_PAGES_LIMIT + 5) },
          }),
        ],
      },
      {
        match: (call) => call.method === 'POST' && call.url.includes('/labels'),
        responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })],
      },
    ]);

    const error = await captureError(
      client.ensureLabel({ provider: 'github', ...REPO, name: '5.0.0', color: '#1f883d' }),
    );

    // The label may well exist on a page never read; creating would either
    // duplicate it or mask the truncation.
    expect(error.code).toBe('PAGINATION_LIMIT');
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('creates when the listing genuinely ended without the name', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse([{ name: 'bug', color: 'd73a4a' }])],
      },
      {
        match: (call) => call.method === 'POST' && call.url.includes('/labels'),
        responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })],
      },
    ]);

    const label = await client.ensureLabel({
      provider: 'github',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
    });

    expect(label.name).toBe('5.0.0');
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('matches the existing name case-insensitively and returns it untouched', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse([{ name: 'V5.0.0', color: '1f883d', description: 'kept' }])],
      },
    ]);

    const label = await client.ensureLabel({
      provider: 'github',
      ...REPO,
      name: 'v5.0.0',
      color: '#000000',
    });

    expect(label.name).toBe('V5.0.0');
    expect(label.description).toBe('kept');
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('lets a bare existence check omit the colour, and only requires it to create', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse([{ name: '5.0.0', color: '1f883d' }])],
      },
    ]);

    // No colour given and the label already exists: nothing to create, so the
    // colour requirement must not fire.
    const label = await client.ensureLabel({ provider: 'github', ...REPO, name: '5.0.0' });
    expect(label.name).toBe('5.0.0');
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('still requires a colour when the label actually has to be created', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse([])],
      },
    ]);

    const error = await captureError(
      client.ensureLabel({ provider: 'github', ...REPO, name: '5.0.0' }),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('color');
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('sends `color` without a `#` to Gitee as a form-encoded body', async () => {
    // Gitee's own Swagger declares `consumes: application/json` while listing
    // `name`/`color` as `formData` parameters, so the encoding is ambiguous in
    // the spec. Form encoding is what the parameter list describes; the assertion
    // pins the current choice so a future change is deliberate.
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      { match: '/labels', responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })] },
    ]);

    await giteeAdapter.createLabel(ctx, {
      provider: 'gitee',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
    });

    const call = mock.calls[0]!;
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.form).toEqual({ name: '5.0.0', color: '1f883d' });
  });

  it('does not send AtomGit a description, which its label write schema omits', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/labels',
        responses: [jsonResponse({ name: '5.0.0', color: '#1f883d', description: 'ignored' })],
      },
    ]);

    await atomgitAdapter.createLabel(ctx, {
      provider: 'atomgit',
      ...REPO,
      name: '5.0.0',
      color: '#1f883d',
      description: 'something',
    });

    // AtomGit's create-label body accepts only `name` and `color`; sending a
    // third field would be silently dropped, so it is not sent at all.
    expect(mock.calls[0]!.form).toEqual({ name: '5.0.0', color: '#1f883d' });
  });
});

/* -------------------------------------------------------------------------- */
/* P3 · GF-002b commit author account                                          */
/* -------------------------------------------------------------------------- */

describe('P3 · a display name is never promoted to an account', () => {
  it('does not build a GitHub account from `name` alone', () => {
    const commit = mapGitHubCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://github.com/o/r/commit/a',
      commit: {
        message: 'm',
        author: { name: 'A', email: 'a@example.com', date: '2026-01-01T00:00:00Z' },
      },
      // Top-level account object with only a display name and no login.
      author: { name: 'Someone Display', email: 'a@example.com' },
    });

    // `login` must be a real login, not the display name.
    expect(commit.author?.user).toBeUndefined();
  });

  it('does not build a Gitee account from `name` alone', () => {
    const commit = mapGiteeCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://gitee.com/o/r/commit/a',
      commit: {
        message: 'm',
        author: { name: 'A', email: 'a@example.com', date: '2026-01-01T00:00:00Z' },
      },
      author: { name: 'Someone Display', avatar_url: 'https://example.com/a.png' },
    });

    expect(commit.author?.user).toBeUndefined();
  });

  it('keeps the account when the Git author has no name', () => {
    // The inverse failure: a real login exists, so dropping the account because
    // the Git-side name is missing loses a legitimate attribution.
    const commit = mapGitHubCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://github.com/o/r/commit/a',
      commit: {
        message: 'm',
        committer: { name: 'C', email: 'c@example.com', date: '2026-01-01T00:00:00Z' },
      },
      author: { login: 'real-login', avatar_url: 'https://example.com/a.png' },
    });

    expect(commit.author?.user?.login).toBe('real-login');
  });

  it('keeps the AtomGit account when the Git author has no name', () => {
    const commit = mapAtomGitCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://atomgit.com/o/r/commits/detail/a',
      commit: {
        message: 'm',
        committer: { name: 'C', email: 'c@example.com', date: '2026-01-01T00:00:00Z' },
      },
      author: { login: 'real-login', name: 'Display', avatar_url: 'https://example.com/a.png' },
    });

    expect(commit.author?.user?.login).toBe('real-login');
  });

  it('still maps the full author metadata when everything is present', () => {
    const commit = mapGitHubCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://github.com/o/r/commit/a',
      commit: {
        message: 'm',
        author: { name: '莫愁', email: 'a@example.com', date: '2026-11-25T02:54:10Z' },
      },
      author: { login: 'real-login', avatar_url: 'https://example.com/a.png' },
    });

    expect(commit.author).toMatchObject({
      name: '莫愁',
      email: 'a@example.com',
      date: '2026-11-25T02:54:10Z',
      user: { login: 'real-login', avatar_url: 'https://example.com/a.png' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* P4 · GF-002a commit time window                                             */
/* -------------------------------------------------------------------------- */

describe('P4 · the time window is validated as a real instant', () => {
  it('rejects a calendar-invalid date that Date.parse silently rolls over', async () => {
    // `2026-02-30T00:00:00Z` parses as March 2 under the loose parser, so a
    // caller asking for February would silently get March's window.
    const { client, mock } = buildClient();
    const error = await captureError(
      client.listCommits({ provider: 'github', ...REPO, since: '2026-02-30T00:00:00Z' }),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects 2026-13-01 and 2026-04-31 as well', async () => {
    const { client, mock } = buildClient();
    for (const value of ['2026-13-01T00:00:00Z', '2026-04-31T00:00:00Z']) {
      const error = await captureError(
        client.listCommits({ provider: 'gitee', ...REPO, until: value }),
      );
      expect(error.code).toBe('INVALID_ARGUMENT');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects a sub-second inverted window that truncated comparison would hide', async () => {
    // `.000900Z` is later than `.000100Z`; comparing truncated to seconds would
    // call these equal and send the request.
    const { client, mock } = buildClient();
    const error = await captureError(
      client.listCommits({
        provider: 'github',
        ...REPO,
        since: '2026-11-01T00:00:00.000900Z',
        until: '2026-11-01T00:00:00.000100Z',
      }),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);
  });

  it('accepts an equal-bounds window and an offset-formatted one', async () => {
    const { client, mock } = buildClient({}, [
      { match: '/commits', responses: [jsonResponse([])] },
    ]);

    await client.listCommits({
      provider: 'github',
      ...REPO,
      since: '2026-11-01T08:00:00+08:00',
      until: '2026-11-01T00:00:00Z',
    });
    expect(mock.calls).toHaveLength(1);
  });

  it('accepts a real leap day', async () => {
    const { client, mock } = buildClient({}, [
      { match: '/commits', responses: [jsonResponse([])] },
    ]);
    await client.listCommits({ provider: 'github', ...REPO, since: '2028-02-29T00:00:00Z' });
    expect(mock.calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* P5 · GF-001 releases                                                        */
/* -------------------------------------------------------------------------- */

describe('P5 · releases are returned in a stable newest-first order', () => {
  const february = {
    id: 1,
    tag_name: 'v1.0.0',
    name: 'v1.0.0',
    published_at: '2026-02-01T00:00:00Z',
    html_url: 'https://github.com/o/r/releases/tag/v1.0.0',
  };
  const november = {
    id: 2,
    tag_name: 'v2.0.0',
    name: 'v2.0.0',
    published_at: '2026-11-01T00:00:00Z',
    html_url: 'https://github.com/o/r/releases/tag/v2.0.0',
  };

  it('sorts the retrieved entries instead of trusting upstream order', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    // Upstream sends the older release first.
    mock.setRoutes([{ match: '/releases', responses: [jsonResponse([february, november])] }]);

    const releases = await githubAdapter.listReleases(ctx, { provider: 'github', ...REPO });
    expect(releases.map((release) => release.tag_name)).toEqual(['v2.0.0', 'v1.0.0']);
  });

  it('keeps entries without a timestamp after the dated ones, preserving their order', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/releases',
        responses: [
          jsonResponse([
            { id: 10, tag_name: 'no-date-a', name: 'no-date-a' },
            { id: 11, tag_name: 'dated', name: 'dated', created_at: '2026-05-01T00:00:00+08:00' },
            { id: 12, tag_name: 'no-date-b', name: 'no-date-b' },
          ]),
        ],
      },
    ]);

    const releases = await giteeAdapter.listReleases(ctx, { provider: 'gitee', ...REPO });
    expect(releases.map((release) => release.tag_name)).toEqual([
      'dated',
      'no-date-a',
      'no-date-b',
    ]);
  });

  it('maps AtomGit release_status latest to a known non-prerelease', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/releases',
        responses: [
          jsonResponse([
            { tag_name: 'v1.0.0', name: 'v1.0.0', created_at: '2026-01-01T00:00:00+08:00' },
            {
              tag_name: 'v2.0.0-rc.1',
              name: 'rc',
              created_at: '2026-02-01T00:00:00+08:00',
              release_status: 'pre',
            },
            {
              tag_name: 'v1.5.0',
              name: 'v1.5.0',
              created_at: '2026-01-15T00:00:00+08:00',
              release_status: 'latest',
            },
          ]),
        ],
      },
    ]);

    const releases = await atomgitAdapter.listReleases(ctx, { provider: 'atomgit', ...REPO });
    const byTag = new Map(releases.map((release) => [release.tag_name, release]));

    expect(byTag.get('v2.0.0-rc.1')?.pre_release).toBe(true);
    // A `latest` marker names a stable release, so it is a real answer rather
    // than a missing field.
    expect(byTag.get('v1.5.0')?.pre_release).toBe(false);
    // No status at all stays unknown instead of being guessed.
    expect(byTag.get('v1.0.0') && 'pre_release' in (byTag.get('v1.0.0') as object)).toBe(false);
    // Ordering still holds after the mapping change.
    expect(releases.map((release) => release.tag_name)).toEqual([
      'v2.0.0-rc.1',
      'v1.5.0',
      'v1.0.0',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* P6 · GF-006 label events                                                    */
/* -------------------------------------------------------------------------- */

describe('P6 · label events keep every mutation in order', () => {
  it('deduplicates GitHub events by their native id, not by a lossy tuple', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    // Same second, same label, three distinct events: labeled → unlabeled →
    // labeled. A (event, time, label) key collapses these into two and inverts
    // the resulting state.
    const same = '2026-11-25T02:00:34Z';
    mock.setRoutes([
      {
        match: '/timeline',
        responses: [
          jsonResponse([
            { id: 101, event: 'labeled', label: { name: 'bug' }, created_at: same },
            { id: 102, event: 'unlabeled', label: { name: 'bug' }, created_at: same },
            { id: 103, event: 'labeled', label: { name: 'bug' }, created_at: same },
          ]),
        ],
      },
    ]);

    const events = await githubAdapter.listIssueEvents(ctx, {
      provider: 'github',
      ...REPO,
      number: 338,
    });

    expect(events.map((event) => event.type)).toEqual(['labeled', 'unlabeled', 'labeled']);
  });

  it('still deduplicates identical events seen twice', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    const entry = {
      id: 500,
      event: 'labeled',
      label: { name: 'bug' },
      created_at: '2026-11-25T02:00:34Z',
    };
    mock.setRoutes([{ match: '/timeline', responses: [jsonResponse([entry, entry])] }]);

    const events = await githubAdapter.listIssueEvents(ctx, {
      provider: 'github',
      ...REPO,
      number: 338,
    });

    expect(events).toHaveLength(1);
  });

  it('does not record an unparseable AtomGit sentence as an addition', () => {
    const events = mapAtomGitEvents('o', 'r', {
      action_type: 'label',
      content: 'did something unexpected with labels',
      created_at: '2026-10-18T17:51:25+08:00',
    });

    // The mutation happened but its direction is unknown; claiming `labeled`
    // would make the event unusable for audit.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('unknown');
    expect('label' in events[0]!).toBe(false);
  });

  it('still reads an add and a remove sentence with a known direction', () => {
    const added = mapAtomGitEvents('o', 'r', {
      action_type: 'label',
      content: 'add label feature',
      created_at: '2026-10-18T17:51:25+08:00',
    });
    const removed = mapAtomGitEvents('o', 'r', {
      action_type: 'label',
      content: 'remove label feature',
      created_at: '2026-10-18T17:51:25+08:00',
    });

    expect(added[0]).toMatchObject({ type: 'labeled', label: 'feature' });
    expect(removed[0]).toMatchObject({ type: 'unlabeled', label: 'feature' });
  });
});
