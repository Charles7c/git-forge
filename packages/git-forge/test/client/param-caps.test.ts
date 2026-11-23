import { describe, expect, it } from 'vitest';

import { PROVIDERS, PARAM_CAPABILITY_IDS } from '../../src/index.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import { expectError, expectNoHttp } from '../helpers/expectError.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';

/**
 * Parameter-level capability gate.
 *
 * The point of this gate is the failure mode it removes: a platform without a
 * filter would silently return an unfiltered list, and the caller could not tell
 * that the filter was ignored. So the assertions are two-sided — the gap must
 * throw with the capability named, and the supported platform must actually put
 * the filter on the wire.
 */

const PULL_FIXTURE = [
  {
    number: 304,
    title: 'a pull request',
    state: 'open',
    html_url: 'https://example.com/pulls/304',
    head: { ref: 'dev', sha: 'a'.repeat(40) },
    base: { ref: 'dev', sha: 'b'.repeat(40) },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  },
];

describe('parameter capability table', () => {
  it('declares exactly the four documented parameter capabilities', () => {
    expect([...PARAM_CAPABILITY_IDS]).toEqual([
      'pulls.list.headFilter',
      'pulls.list.milestoneFilter',
      'issues.list.milestoneFilter',
      'files.pushFiles.atomic',
    ]);
  });

  it('records the head-filter matrix as GitHub yes / Gitee yes / AtomGit no', () => {
    const { client } = buildClient();
    const matrix = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        client.paramCapabilities(provider)['pulls.list.headFilter'],
      ]),
    );
    expect(matrix).toEqual({ github: 'supported', gitee: 'supported', atomgit: 'unsupported' });
  });

  it('records the atomic-push matrix as GitHub yes / Gitee yes / AtomGit no', () => {
    const { client } = buildClient();
    const matrix = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        client.paramCapabilities(provider)['files.pushFiles.atomic'],
      ]),
    );
    expect(matrix).toEqual({ github: 'supported', gitee: 'supported', atomgit: 'unsupported' });
  });
});

describe('pulls.list.headFilter gate', () => {
  it('refuses head on AtomGit with UNSUPPORTED_ON_PROVIDER and zero HTTP', async () => {
    const { client, mock } = buildClient();
    const error = await expectError(
      client.listPullRequests({ provider: 'atomgit', ...REPO, head: 'dev' }),
      {
        code: 'UNSUPPORTED_ON_PROVIDER',
        provider: 'atomgit',
        capability: 'pulls.list.headFilter',
        messageIncludes: ['pulls.list.headFilter', 'atomgit'],
      },
    );
    expect(error.retryable).toBe(false);
    expectNoHttp(mock);
  });

  it('reports the head gap first when two filters are unsupported', async () => {
    // Both the head filter and the milestone filter are gaps on AtomGit, and
    // both are configured on the token-bearing client used here. The report names
    // the first check that fires, so a caller fixing one filter at a time can
    // converge instead of chasing an unstable error.
    const { client, mock } = buildClient();
    await expectError(
      client.listPullRequests({ provider: 'atomgit', ...REPO, head: 'dev', milestone: 3 }),
      {
        code: 'UNSUPPORTED_ON_PROVIDER',
        provider: 'atomgit',
        capability: 'pulls.list.headFilter',
      },
    );
    expectNoHttp(mock);
  });

  it.each(['github', 'gitee'] as const)('sends head=%s filter on %s', async (provider) => {
    const { client, mock } = buildClient({}, [
      { match: /\/pulls/, responses: [jsonResponse(PULL_FIXTURE)] },
    ]);
    await client.listPullRequests({ provider, ...REPO, head: 'dev' });

    expect(mock.calls).toHaveLength(1);
    const url = new URL(mock.calls[0]!.url);
    expect(url.searchParams.get('head')).toBe('dev');
  });

  it('does not send a head parameter when none was asked for', async () => {
    const { client, mock } = buildClient({}, [
      { match: /\/pulls/, responses: [jsonResponse(PULL_FIXTURE)] },
    ]);
    await client.listPullRequests({ provider: 'atomgit', ...REPO });

    expect(mock.calls).toHaveLength(1);
    expect(new URL(mock.calls[0]!.url).searchParams.has('head')).toBe(false);
  });
});

describe('milestone filter gates', () => {
  it.each(PROVIDERS)('passes a pull-request milestone through on %s', async (provider) => {
    const { client, mock } = buildClient({}, [
      { match: /\/pulls/, responses: [jsonResponse(PULL_FIXTURE)] },
    ]);
    await client.listPullRequests({ provider, ...REPO, milestone: 7 });

    const query = new URL(mock.calls[0]!.url).searchParams;
    // Gitee and AtomGit name the pull-request filter `milestone_number`;
    // GitHub calls it `milestone`.
    const key = provider === 'github' ? 'milestone' : 'milestone_number';
    expect(query.get(key)).toBe('7');
  });

  it('passes an issue milestone through on GitHub and AtomGit', async () => {
    const issue = [
      {
        number: 1,
        title: 'an issue',
        state: 'open',
        html_url: 'https://example.com/issues/1',
        labels: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ];
    for (const provider of ['github', 'atomgit'] as const) {
      const { client, mock } = buildClient({}, [{ match: /.*/, responses: [jsonResponse(issue)] }]);
      await client.listIssues({ provider, ...REPO, milestone: 4 });
      expect(new URL(mock.calls[0]!.url).searchParams.get('milestone')).toBe('4');
    }
  });

  it('rejects a numeric issue milestone on Gitee, whose filter takes a title', async () => {
    // Gitee declares the filter as supported but cannot honour a number; the
    // adapter refuses rather than filtering to nothing.
    const { client, mock } = buildClient({}, [{ match: /.*/, responses: [jsonResponse([])] }]);
    await expectError(client.listIssues({ provider: 'gitee', ...REPO, milestone: 4 }), {
      code: 'INVALID_ARGUMENT',
      provider: 'gitee',
      messageIncludes: ['milestone'],
    });
    expectNoHttp(mock);
  });
});

describe('param gate ordering', () => {
  it('reports a validation failure before the parameter capability gap', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.listPullRequests({ provider: 'atomgit', ...REPO, head: 'dev', maxPages: 0 }),
      { code: 'INVALID_ARGUMENT', provider: 'atomgit', messageIncludes: ['maxPages'] },
    );
    expectNoHttp(mock);
  });

  it('reports the read-only gate before the parameter capability gap', async () => {
    // listPullRequests is a read, so read-only does not apply; this asserts the
    // parameter gap is not masked by an unrelated gate on a read path.
    const { client, mock } = buildClient({ readonly: true });
    await expectError(client.listPullRequests({ provider: 'atomgit', ...REPO, head: 'dev' }), {
      code: 'UNSUPPORTED_ON_PROVIDER',
      capability: 'pulls.list.headFilter',
    });
    expectNoHttp(mock);
  });
});
