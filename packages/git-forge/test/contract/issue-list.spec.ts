import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../../src/index.js';
import type { Provider } from '../../src/index.js';
import { buildClient, EXPECTED_BASE_URLS, REPO } from '../helpers/clientHarness.js';
import { expectError, expectNoHttp } from '../helpers/expectError.js';

const NEXT_HEADERS: Record<Provider, Record<string, string>> = {
  github: { link: '<https://pagination.invalid/issues?page=2>; rel="next"' },
  gitee: { link: "<https://pagination.invalid/issues?page=2>; rel='next'" },
  atomgit: { total_page: '2' },
};
const LAST_HEADERS: Record<Provider, Record<string, string>> = {
  github: { link: '<https://pagination.invalid/issues?page=1>; rel="prev first"' },
  gitee: { total_page: '2' },
  atomgit: { 'x-total-pages': '2' },
};
const LIST_ROUTE = /\/issues\?/;
const ISSUE = { number: '0007', state: 'open' };

function pageOf(url: string): string | null {
  return new URL(url).searchParams.get('page');
}

describe.each(PROVIDERS)('Issue list completeness (%s)', (provider) => {
  const params = { provider, ...REPO, state: 'all' as const };

  it('returns an actual empty array', async () => {
    const { client, mock } = buildClient({}, [{ match: LIST_ROUTE, responses: [{ body: [] }] }]);
    await expect(client.listIssues({ ...params, requireComplete: true })).resolves.toEqual([]);
    expect(mock.calls).toHaveLength(1);
  });

  it.each([
    { label: 'non-array body', body: { unexpected: [] } },
    { label: 'missing number with internal ID only', body: [{ id: 42, state: 'open' }] },
    { label: 'blank number', body: [{ number: ' ', state: 'open' }] },
    { label: 'zero number', body: [{ number: 0, state: 'open' }] },
    { label: 'negative number', body: [{ number: -1, state: 'open' }] },
    { label: 'fractional number', body: [{ number: 1.5, state: 'open' }] },
    { label: 'unsafe number', body: [{ number: 9_007_199_254_740_992, state: 'open' }] },
    { label: 'missing state', body: [{ number: '0007' }] },
    { label: 'unknown state on a duplicate', body: [ISSUE, { ...ISSUE, state: 'future-state' }] },
  ])('rejects a successful response with $label', async ({ body }) => {
    const { client, mock } = buildClient({}, [
      { match: LIST_ROUTE, responses: [{ body, headers: { 'x-request-id': 'fixture-bad-page' } }] },
    ]);
    const error = await expectError(client.listIssues(params), {
      code: 'PROVIDER_ERROR',
      provider,
      status: 200,
    });
    expect(error.toJSON()).toMatchObject({ requestId: 'fixture-bad-page', retryable: false });
    expect(mock.calls).toHaveLength(1);
  });

  it('rejects a malformed second page with its request ID, not a partial array', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: LIST_ROUTE,
        responses: [
          { body: [ISSUE], headers: NEXT_HEADERS[provider] },
          { body: { unexpected: [] }, headers: { 'x-request-id': 'fixture-page-two' } },
        ],
      },
    ]);
    const error = await expectError(client.listIssues({ ...params, requireComplete: true }), {
      code: 'PROVIDER_ERROR',
      provider,
      status: 200,
    });
    expect(error.requestId).toBe('fixture-page-two');
    expect(mock.calls.map(({ url }) => pageOf(url))).toEqual(['1', '2']);
  });

  it('preserves capped arrays by default and rejects when strict', async () => {
    const { client, mock } = buildClient({ retry: { maxRetries: 3 } }, [
      { match: LIST_ROUTE, responses: [{ body: [ISSUE], headers: NEXT_HEADERS[provider] }] },
    ]);
    const capped = { ...params, maxPages: 1 };
    const partial = await client.listIssues(capped);
    expect(partial.map(({ number }) => number)).toEqual(['0007']);
    await expect(client.listIssues({ ...capped, requireComplete: false })).resolves.toEqual(
      partial,
    );
    const error = await expectError(client.listIssues({ ...capped, requireComplete: true }), {
      code: 'PAGINATION_LIMIT',
      provider,
      messageIncludes: ['maxPages=1'],
    });
    expect(error.retryable).toBe(false);
    expect(mock.calls.map(({ url }) => pageOf(url))).toEqual(['1', '1', '1']);
  });

  it('accepts a full, explicitly terminal page at the exact budget', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ ...ISSUE, number: index + 10 }));
    const { client, mock } = buildClient({}, [
      {
        match: LIST_ROUTE,
        responses: [
          { body: [ISSUE], headers: NEXT_HEADERS[provider] },
          { body: fullPage, headers: LAST_HEADERS[provider] },
        ],
      },
    ]);
    const issues = await client.listIssues({ ...params, maxPages: 2, requireComplete: true });
    expect(issues.map(({ number }) => number)).toEqual([
      '0007',
      ...fullPage.map(({ number }) => String(number)),
    ]);
    expect(mock.calls.map(({ url }) => pageOf(url))).toEqual(['1', '2']);
  });

  it('preserves distinct textual identities and accepts the largest safe numeric identity', async () => {
    const numbers = ['9007199254740992', '9007199254740993', '0007', '7', 'IEXA01'];
    const body = [...numbers, Number.MAX_SAFE_INTEGER].map((number) => ({ ...ISSUE, number }));
    const { client, mock } = buildClient({}, [{ match: LIST_ROUTE, responses: [{ body }] }]);
    const issues = await client.listIssues({ ...params, requireComplete: true });
    expect(issues.map(({ number }) => number)).toEqual([...numbers, '9007199254740991']);
    expect(mock.calls).toHaveLength(1);
  });

  it.each([false, true])(
    'uses only request ID headers for malformed pages (header=%s)',
    async (withHeader) => {
      const diagnostic = 'synthetic upstream private diagnostic';
      const requestId = withHeader ? 'fixture-header-id' : undefined;
      const { client, mock } = buildClient({}, [
        {
          match: LIST_ROUTE,
          responses: [
            {
              body: { trace_id: diagnostic },
              ...(requestId ? { headers: { 'x-request-id': requestId } } : {}),
            },
          ],
        },
      ]);
      const error = await expectError(client.listIssues(params), {
        code: 'PROVIDER_ERROR',
        provider,
        status: 200,
      });
      expect(error.retryable).toBe(false);
      expect(error.requestId).toBe(requestId);
      expect(error.toJSON().requestId).toBe(requestId);
      expect(JSON.stringify(error)).not.toContain(diagnostic);
      expect(mock.calls).toHaveLength(1);
    },
  );

  it('rejects an invalid runtime flag before any HTTP', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.listIssues({ ...params, requireComplete: 'true' as unknown as boolean }),
      { code: 'INVALID_ARGUMENT', messageIncludes: ['requireComplete'] },
    );
    expectNoHttp(mock);
  });
});

it.each<{ label: string; headers: Record<string, string>; full?: boolean }>([
  {
    label: 'next with preceding parameters, even with a terminal total',
    headers: {
      link: '<https://pagination.invalid/issues?page=3>; type="application/json"; rel="next", <https://pagination.invalid/issues?page=1>; rel="prev"',
      total_page: '2',
    },
  },
  {
    label: 'next after empty Link list members, even with a terminal total',
    headers: {
      link: ', <https://pagination.invalid/issues?page=1>; title="prev, page"; rel="prev", , <https://pagination.invalid/issues?page=3>; rel="next",',
      total_page: '2',
    },
  },
  {
    label: 'a malformed entry after a backward link on a full page',
    headers: { link: '<https://pagination.invalid/issues?page=1>; rel="prev", unparsed entry' },
    full: true,
  },
  {
    label: 'rel=last that contradicts a terminal total',
    headers: { link: '<https://pagination.invalid/issues?page=3>; rel="last"', total_page: '2' },
  },
  {
    label: 'a valid alias after an invalid total',
    headers: { total_page: 'garbage', 'x-total-pages': '3' },
  },
  {
    label: 'a continuing alias after a terminal total',
    headers: { total_page: '2', 'x-total-pages': '3' },
  },
  {
    label: 'a continuing total before a terminal alias',
    headers: { total_page: '3', 'x-total-pages': '2' },
  },
])('reports the strict cap for $label without following link URLs', async ({ headers, full }) => {
  const body = full
    ? Array.from({ length: 100 }, (_, index) => ({ ...ISSUE, number: index + 10 }))
    : [];
  const { client, mock } = buildClient({}, [
    {
      match: LIST_ROUTE,
      responses: [
        { body: [ISSUE], headers: NEXT_HEADERS.github },
        { body, headers },
      ],
    },
  ]);
  const error = await expectError(
    client.listIssues({ provider: 'github', ...REPO, maxPages: 2, requireComplete: true }),
    {
      code: 'PAGINATION_LIMIT',
      provider: 'github',
    },
  );
  expect(error.retryable).toBe(false);
  expect(mock.calls.map(({ url }) => pageOf(url))).toEqual(['1', '2']);
  expect(mock.calls.map(({ url }) => new URL(url).origin)).toEqual([
    EXPECTED_BASE_URLS.github,
    EXPECTED_BASE_URLS.github,
  ]);
});

it.each(
  [
    null,
    false,
    'not an object',
    [],
    {},
    ['not an object'],
    { unrelated: true },
    { url: null },
    { url: '  ' },
    { url: 'not a URL' },
  ].map((marker) => ({ marker })),
)(
  'does not let a GitHub pull_request marker of $marker hide invalid Issues or filter valid ones',
  async ({ marker: pull_request }) => {
    const { client, mock } = buildClient({}, [
      {
        match: LIST_ROUTE,
        responses: [
          { body: [{ pull_request, number: 0, state: 'open' }] },
          { body: [{ pull_request, ...ISSUE, state: 'unknown' }] },
          { body: [{ pull_request, ...ISSUE }] },
        ],
      },
    ]);
    const params = { provider: 'github', ...REPO, requireComplete: true } as const;
    await expectError(client.listIssues(params), { code: 'PROVIDER_ERROR', status: 200 });
    await expectError(client.listIssues(params), { code: 'PROVIDER_ERROR', status: 200 });
    const issues = await client.listIssues(params);
    expect(issues.map(({ number }) => number)).toEqual(['0007']);
    expect(mock.calls).toHaveLength(3);
  },
);

it('counts GitHub PR rows for the no-header probe without returning them as Issues', async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    state: 'open',
    pull_request: { url: 'https://pagination.invalid/pulls/example' },
  }));
  const { client, mock } = buildClient({}, [
    {
      match: LIST_ROUTE,
      responses: [{ body: fullPage }, { body: [{ number: 101, state: 'closed' }] }],
    },
  ]);
  const params = { provider: 'github', ...REPO, requireComplete: true } as const;
  await expectError(client.listIssues({ ...params, maxPages: 1 }), {
    code: 'PAGINATION_LIMIT',
    provider: 'github',
  });
  // Reset the canned sequence so the second call starts on the same full page.
  mock.setRoutes([
    {
      match: LIST_ROUTE,
      responses: [{ body: fullPage }, { body: [{ number: 101, state: 'closed' }] }],
    },
  ]);
  const issues = await client.listIssues({ ...params, maxPages: 2 });
  expect(issues.map(({ number }) => number)).toEqual(['101']);
  expect(mock.calls.map(({ url }) => pageOf(url))).toEqual(['1', '1', '2']);
});

it.each(['open', 'progressing'])(
  'rejects a Gitee fan-out if %s is truncated',
  async (truncated) => {
    const { client, mock } = buildClient({}, [
      ...['open', 'progressing'].map((state) => ({
        match: ({ url }: { url: string }) => new URL(url).searchParams.get('state') === state,
        responses: [
          {
            body: [{ number: state === 'open' ? 'IEXA01' : '00AbC', state }],
            headers: { total_page: state === truncated ? '2' : '1' },
          },
        ],
      })),
    ]);
    const params = { provider: 'gitee', ...REPO, state: 'open', maxPages: 1 } as const;
    const partial = await client.listIssues(params);
    expect(partial.map(({ number, state }) => [number, state])).toEqual([
      ['IEXA01', 'open'],
      ['00AbC', 'open'],
    ]);
    await expectError(client.listIssues({ ...params, requireComplete: true }), {
      code: 'PAGINATION_LIMIT',
      provider: 'gitee',
    });
    expect(mock.calls.slice(2).map(({ url }) => new URL(url).searchParams.get('state'))).toEqual(
      truncated === 'open' ? ['open'] : ['open', 'progressing'],
    );
  },
);
