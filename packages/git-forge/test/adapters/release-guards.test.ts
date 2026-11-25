import { describe, expect, it } from 'vitest';

import { atomgitAdapter } from '../../src/adapters/atomgit/adapter.js';
import { giteeAdapter } from '../../src/adapters/gitee/adapter.js';
import { githubAdapter } from '../../src/adapters/github/adapter.js';
import { mapIssueEvents as mapAtomGitEvents } from '../../src/adapters/atomgit/map.js';
import { mapIssueEvents as mapGiteeEvents } from '../../src/adapters/gitee/map.js';
import { mapCommit as mapAtomGitCommit } from '../../src/adapters/atomgit/map.js';
import { mapCommit as mapGiteeCommit } from '../../src/adapters/gitee/map.js';
import { mapCommit as mapGitHubCommit } from '../../src/adapters/github/map.js';
import type { ProviderAdapter } from '../../src/adapters/types.js';
import { GitForgeError } from '../../src/core/errors.js';
import { MAX_PAGES_LIMIT } from '../../src/core/paginate.js';
import { instantNanos } from '../../src/core/validate.js';
import { buildHarness } from '../helpers/adapterHarness.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';

/**
 * Release-blocking counter-examples for 0.2.0.
 *
 * Every case here is a call that used to *succeed* while returning something
 * unfounded — a truncated list read as "the name is absent", an event timeline
 * silently reordered, an email dropped on the floor. None of them is a missing
 * feature, which is why they are asserted rather than left to coverage.
 */

const ADAPTERS: readonly ProviderAdapter[] = [githubAdapter, giteeAdapter, atomgitAdapter];

/** `[provider, adapter]` pairs, so a parameterised test name stays readable. */
const ADAPTER_CASES = ADAPTERS.map((adapter) => [adapter.provider, adapter] as const);

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

/** A page of labels that never contains the wanted name. */
function fillerLabels(offset: number): { name: string; color: string }[] {
  return Array.from({ length: 100 }, (_, index) => ({
    name: `filler-${String(offset + index)}`,
    color: 'ededed',
  }));
}

/* -------------------------------------------------------------------------- */
/* 1 · Label listing shape                                                     */
/* -------------------------------------------------------------------------- */

describe('L1 · a strict label catalog rejects a shape it cannot trust', () => {
  it.each(ADAPTER_CASES)('rejects a non-array body (%s)', async (_name, adapter) => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      { match: '/labels', responses: [jsonResponse({ message: 'upstream is unhappy' })] },
    ]);

    const error = await captureError(
      adapter.listLabels(ctx, {
        provider: adapter.provider,
        ...REPO,
        requireComplete: true,
      }),
    );

    // The body is not a catalog at all. Returning [] would read as "no labels",
    // which is exactly the premise `ensureLabel` must never act on.
    expect(error.code).toBe('PROVIDER_ERROR');
  });

  it.each(ADAPTER_CASES)('rejects an entry with no usable name (%s)', async (_name, adapter) => {
    const { ctx, mock } = buildHarness(adapter);
    mock.setRoutes([
      {
        match: '/labels',
        responses: [
          jsonResponse([
            { name: 'bug', color: 'd73a4a' },
            { color: 'ededed' },
            { name: '', color: 'ededed' },
            { name: 42, color: 'ededed' },
          ]),
        ],
      },
    ]);

    const error = await captureError(
      adapter.listLabels(ctx, {
        provider: adapter.provider,
        ...REPO,
        requireComplete: true,
      }),
    );

    expect(error.code).toBe('PROVIDER_ERROR');
  });

  it.each(ADAPTER_CASES)(
    'keeps the lenient reading when completeness was not required (%s)',
    async (_name, adapter) => {
      const { ctx, mock } = buildHarness(adapter);
      mock.setRoutes([
        {
          match: '/labels',
          responses: [jsonResponse([{ name: 'bug', color: 'd73a4a' }, { color: 'ededed' }])],
        },
      ]);

      // The strict contract is opt-in: a caller that only displays labels is not
      // refused because one row is odd.
      const labels = await adapter.listLabels(ctx, { provider: adapter.provider, ...REPO });
      expect(labels[0]?.name).toBe('bug');
    },
  );

  it.each(ADAPTER_CASES)('never creates on a non-array listing (%s)', async (_name, adapter) => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse({ message: 'upstream is unhappy' })],
      },
      {
        match: (call) => call.method === 'POST' && call.url.includes('/labels'),
        responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })],
      },
    ]);

    const error = await captureError(
      client.ensureLabel({ provider: adapter.provider, ...REPO, name: '5.0.0', color: '#1f883d' }),
    );

    expect(error.code).toBe('PROVIDER_ERROR');
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it.each(ADAPTER_CASES)(
    'never creates on a listing with a nameless entry (%s)',
    async (_name, adapter) => {
      const { client, mock } = buildClient({}, [
        {
          match: (call) => call.method === 'GET' && call.url.includes('/labels'),
          responses: [jsonResponse([{ name: 'bug', color: 'd73a4a' }, { color: 'ededed' }])],
        },
        {
          match: (call) => call.method === 'POST' && call.url.includes('/labels'),
          responses: [jsonResponse({ name: '5.0.0', color: '1f883d' })],
        },
      ]);

      const error = await captureError(
        client.ensureLabel({
          provider: adapter.provider,
          ...REPO,
          name: '5.0.0',
          color: '#1f883d',
        }),
      );

      expect(error.code).toBe('PROVIDER_ERROR');
      expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    },
  );

  it('still creates when a valid empty listing says the name is absent', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [jsonResponse([])],
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

  it('still refuses a truncated catalog with PAGINATION_LIMIT and zero writes', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: (call) => call.method === 'GET' && call.url.includes('/labels'),
        responses: [
          jsonResponse(fillerLabels(0), { headers: { total_page: String(MAX_PAGES_LIMIT + 5) } }),
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

    expect(error.code).toBe('PAGINATION_LIMIT');
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 · Instant comparison                                                      */
/* -------------------------------------------------------------------------- */

describe('T1 · instants compare at nine fractional digits, across offsets', () => {
  it('sees a one-nanosecond inversion that microsecond truncation hides', async () => {
    const { client, mock } = buildClient();

    // Both bounds name the same UTC second 2026-11-01T00:00:00Z. The `since`
    // bound is one nanosecond later (08:00:00.000000002+08:00 ≡ 00:00:00.000000002Z),
    // so the window is inverted. Truncating to microseconds compares them equal.
    const error = await captureError(
      client.listCommits({
        provider: 'github',
        ...REPO,
        since: '2026-11-01T08:00:00.000000002+08:00',
        until: '2026-11-01T00:00:00.000000001Z',
      }),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);
  });

  it('accepts the same instant written in two zones at full precision', async () => {
    const { client, mock } = buildClient({}, [
      { match: '/commits', responses: [jsonResponse([])] },
    ]);

    await client.listCommits({
      provider: 'github',
      ...REPO,
      // 08:00:00.000000001+08:00 is exactly 00:00:00.000000001Z.
      since: '2026-11-01T08:00:00.000000001+08:00',
      until: '2026-11-01T00:00:00.000000001Z',
    });

    expect(mock.calls).toHaveLength(1);
  });

  it('orders the ninth digit instead of discarding it', () => {
    expect(instantNanos('2026-11-01T00:00:00.000000001Z')).toBeLessThan(
      instantNanos('2026-11-01T00:00:00.000000002Z'),
    );
    expect(instantNanos('2026-11-01T08:00:00.000000002+08:00')).toBe(
      instantNanos('2026-11-01T00:00:00.000000002Z'),
    );
  });

  it('rejects an out-of-range offset minute and hour', async () => {
    const { client, mock } = buildClient();

    for (const value of [
      '2026-11-01T00:00:00+00:60',
      '2026-11-01T00:00:00+24:00',
      '2026-11-01T00:00:00-23:60',
    ]) {
      const error = await captureError(
        client.listCommits({ provider: 'gitee', ...REPO, since: value }),
      );
      expect(error.code, value).toBe('INVALID_ARGUMENT');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('accepts the largest real offsets', async () => {
    const { client, mock } = buildClient({}, [
      { match: '/commits', responses: [jsonResponse([])] },
    ]);

    // +23:59 is the earliest instant of the two for the same wall clock, so this
    // window is ordered — it just spans almost two days.
    await client.listCommits({
      provider: 'github',
      ...REPO,
      since: '2026-11-01T00:00:00+23:59',
      until: '2026-11-01T00:00:00-23:59',
    });
    expect(mock.calls).toHaveLength(1);
  });

  it('handles a four-digit year 0099 without rolling it into 1999', async () => {
    // `Date.UTC(99, 0, 1)` is 1999-01-01, not 0099-01-01: the two-digit-year
    // rule applies to any year below 100. 0099-01-01 is a real date, and it is
    // earlier than 0100-01-01.
    expect(instantNanos('0099-01-01T00:00:00Z')).toBeLessThan(instantNanos('0100-01-01T00:00:00Z'));

    const { client, mock } = buildClient({}, [
      { match: '/commits', responses: [jsonResponse([])] },
    ]);
    await client.listCommits({
      provider: 'github',
      ...REPO,
      since: '0099-01-01T00:00:00Z',
      until: '0100-01-01T00:00:00Z',
    });
    expect(mock.calls).toHaveLength(1);
  });

  it('still rejects a date that does not exist in a four-digit year', async () => {
    const { client, mock } = buildClient();
    const error = await captureError(
      client.listCommits({ provider: 'github', ...REPO, since: '0099-02-30T00:00:00Z' }),
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4 · Label events                                                            */
/* -------------------------------------------------------------------------- */

describe('E1 · GitHub event identity and ordering', () => {
  it('merges events across pages, deduplicates by native id and sorts ascending', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    const at = (second: number): string => `2026-11-25T02:00:${String(second).padStart(2, '0')}Z`;
    mock.setRoutes([
      {
        match: '/timeline',
        responses: [
          jsonResponse(
            [
              { id: 11, event: 'labeled', label: { name: 'bug' }, created_at: at(10) },
              { id: 13, event: 'labeled', label: { name: 'docs' }, created_at: at(20) },
            ],
            { headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } },
          ),
          jsonResponse([
            // Older than both entries on page one: upstream order is not sorted.
            { id: 10, event: 'labeled', label: { name: 'feature' }, created_at: at(5) },
            // The same native event seen again after a page boundary.
            { id: 11, event: 'labeled', label: { name: 'bug' }, created_at: at(10) },
            { id: 12, event: 'unlabeled', label: { name: 'bug' }, created_at: at(15) },
          ]),
        ],
      },
    ]);

    const events = await githubAdapter.listIssueEvents(ctx, {
      provider: 'github',
      ...REPO,
      number: 338,
    });

    expect(events.map((event) => event.type)).toEqual([
      'labeled',
      'labeled',
      'unlabeled',
      'labeled',
    ]);
    expect(events.map((event) => event.label)).toEqual(['feature', 'bug', 'bug', 'docs']);
    expect(events.map((event) => event.created_at)).toEqual([at(5), at(10), at(15), at(20)]);
  });

  it('does not merge events it cannot prove identical', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    // No native id, same second, same label: an addition, a removal and another
    // addition. They are indistinguishable by tuple, and merging them would
    // invert the resulting state — so none of them may be dropped.
    const same = '2026-11-25T02:00:34Z';
    mock.setRoutes([
      {
        match: '/timeline',
        responses: [
          jsonResponse([
            { event: 'labeled', label: { name: 'bug' }, created_at: same },
            { event: 'unlabeled', label: { name: 'bug' }, created_at: same },
            { event: 'labeled', label: { name: 'bug' }, created_at: same },
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

  it('keeps upstream order for events that share an instant', async () => {
    const { ctx, mock } = buildHarness(githubAdapter);
    const same = '2026-11-25T02:00:34Z';
    mock.setRoutes([
      {
        match: '/timeline',
        responses: [
          jsonResponse([
            { id: 1, event: 'labeled', label: { name: 'a' }, created_at: same },
            { id: 2, event: 'labeled', label: { name: 'b' }, created_at: same },
            { id: 3, event: 'unlabeled', label: { name: 'a' }, created_at: same },
          ]),
        ],
      },
    ]);

    const events = await githubAdapter.listIssueEvents(ctx, {
      provider: 'github',
      ...REPO,
      number: 338,
    });

    expect(events.map((event) => `${event.type}:${event.label ?? ''}`)).toEqual([
      'labeled:a',
      'labeled:b',
      'unlabeled:a',
    ]);
  });

  it('sorts the Gitee operation log ascending even though it is requested descending', async () => {
    const { ctx, mock } = buildHarness(giteeAdapter);
    mock.setRoutes([
      {
        match: '/operate_logs',
        responses: [
          jsonResponse([
            {
              action_type: 'add_label',
              after_change_value: 'newer',
              created_at: '2026-10-18T17:52:25+08:00',
            },
            {
              action_type: 'add_label',
              after_change_value: 'older',
              created_at: '2026-10-18T17:51:25+08:00',
            },
          ]),
        ],
      },
    ]);

    const events = await giteeAdapter.listIssueEvents(ctx, {
      provider: 'gitee',
      ...REPO,
      number: 'IEXA01',
    });

    expect(events.map((event) => event.label)).toEqual(['older', 'newer']);
  });

  it('keeps the labels of one AtomGit sentence adjacent and in sentence order', async () => {
    const { ctx, mock } = buildHarness(atomgitAdapter);
    mock.setRoutes([
      {
        match: '/operate_logs',
        responses: [
          jsonResponse([
            {
              action_type: 'label',
              content: 'add label second, third',
              created_at: '2026-10-18T17:52:25+08:00',
            },
            {
              action_type: 'label',
              content: 'add label first',
              created_at: '2026-10-18T17:51:25+08:00',
            },
          ]),
        ],
      },
    ]);

    const events = await atomgitAdapter.listIssueEvents(ctx, {
      provider: 'atomgit',
      ...REPO,
      number: 75,
    });

    expect(events.map((event) => event.label)).toEqual(['first', 'second', 'third']);
  });

  it('reports an unparseable AtomGit direction as unknown without dropping it', () => {
    const [event] = mapAtomGitEvents('o', 'r', {
      action_type: 'label',
      content: 'did something unexpected with labels',
      created_at: '2026-10-18T17:51:25+08:00',
    });
    expect(event?.type).toBe('unknown');
  });

  it('maps Gitee and AtomGit log directions without inventing an addition', () => {
    const [removed] = mapGiteeEvents('o', 'r', {
      action_type: 'remove_label',
      before_change_value: 'bug',
      created_at: '2026-10-18T17:51:25+08:00',
    });
    expect(removed?.type).toBe('unlabeled');
  });
});

/* -------------------------------------------------------------------------- */
/* 5 · Git author email                                                        */
/* -------------------------------------------------------------------------- */

describe('A1 · an email-only Git author keeps its email', () => {
  it('preserves the Git email when the commit object has no name or date', () => {
    const commit = mapGitHubCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://github.com/o/r/commit/a',
      commit: { message: 'm', author: { email: 'a@example.com' } },
      author: { login: 'real-login' },
    });

    // The email is the only Git-side fact available; it must survive.
    expect(commit.author).toMatchObject({
      name: '',
      email: 'a@example.com',
      user: { login: 'real-login' },
    });
  });

  it('preserves the email on Gitee and AtomGit too', () => {
    for (const [map, provider] of [
      [mapGiteeCommit, 'gitee'],
      [mapAtomGitCommit, 'atomgit'],
    ] as const) {
      const commit = map('o', 'r', {
        sha: 'b'.repeat(40),
        html_url: `https://${provider}.example/o/r/commit/b`,
        commit: { message: 'm', author: { email: 'a@example.com' } },
        author: { login: 'real-login' },
      });
      expect(commit.author, provider).toMatchObject({
        name: '',
        email: 'a@example.com',
        user: { login: 'real-login' },
      });
    }
  });

  it('never turns an email into an account', () => {
    // The top-level object carries the same address but no login. An email
    // identifies a person, not an account on this platform, so no `user`.
    const commit = mapGitHubCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://github.com/o/r/commit/a',
      commit: { message: 'm', author: { email: 'a@example.com' } },
      author: { email: 'a@example.com', name: 'Someone Display' },
    });

    expect(commit.author?.email).toBe('a@example.com');
    expect(commit.author?.user).toBeUndefined();
  });

  it('does not replace an existing email with an empty string when a login exists', () => {
    const commit = mapGitHubCommit('o', 'r', {
      sha: 'a'.repeat(40),
      html_url: 'https://github.com/o/r/commit/a',
      commit: { message: 'm', author: { email: 'a@example.com' } },
      author: { login: 'real-login', email: 'platform@example.com' },
    });

    // The Git-side email is the commit's own record; the platform's account
    // email is a different fact and does not overwrite it.
    expect(commit.author?.email).toBe('a@example.com');
  });
});
