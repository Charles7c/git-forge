import { describe, expect, it } from 'vitest';

import { HttpClient } from '../../src/core/http.js';
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_PER_PAGE,
  MAX_PAGES_LIMIT,
  MAX_PER_PAGE,
  collectPages,
  dedupeBy,
  normalizeMaxPages,
  normalizePerPage,
  parseLinkHeader,
  readTotalCount,
  readTotalPage,
  resolveNextPage,
} from '../../src/core/paginate.js';
import { createMockFetch, createRecordingSleep, jsonResponse } from '../helpers/mockFetch.js';

/**
 * Synthetic GitHub-style Link header with double-quoted relations.
 */
const GITHUB_LINK =
  '<https://api.github.com/repositories/5100/issues?per_page=2&page=2>; rel="next", ' +
  '<https://api.github.com/repositories/5100/issues?per_page=2&page=80>; rel="last"';

/**
 * Synthetic Gitee-style Link header with single-quoted relations. Gitee
 * also sends `total_count` / `total_page`, which this string pairs with.
 */
const GITEE_LINK =
  "<https://gitee.com/api/v5/repos/example-org/demo-kit/issues?page=2&per_page=2>; rel='next', " +
  "<https://gitee.com/api/v5/repos/example-org/demo-kit/issues?page=80&per_page=2>; rel='last', " +
  "<https://gitee.com/api/v5/repos/example-org/demo-kit/issues?page=1&per_page=2>; rel='first'";

describe('parseLinkHeader', () => {
  it('parses double-quoted rel values (GitHub)', () => {
    const parsed = parseLinkHeader(GITHUB_LINK);
    expect(parsed.next).toContain('page=2');
    expect(parsed.last).toContain('page=80');
  });

  it('parses single-quoted rel values (Gitee)', () => {
    const parsed = parseLinkHeader(GITEE_LINK);
    expect(parsed.next).toContain('page=2');
    expect(parsed.last).toContain('page=80');
    expect(parsed.first).toContain('page=1');
  });

  it('returns an empty record for a missing header (AtomGit sends none)', () => {
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader(undefined)).toEqual({});
    expect(parseLinkHeader('')).toEqual({});
  });

  it('returns an empty record for an unparseable header instead of throwing', () => {
    expect(parseLinkHeader('garbage without brackets')).toEqual({});
    expect(parseLinkHeader('<>; rel=next')).toEqual({});
  });

  it('preserves the full URL so a cursor is not lost', () => {
    const parsed = parseLinkHeader(
      '<https://api.github.com/repos/o/r/issues?after=cursor123&per_page=100>; rel="next"',
    );
    expect(parsed.next).toContain('after=cursor123');
  });

  it('is stateless across repeated calls', () => {
    const first = parseLinkHeader(GITHUB_LINK);
    const second = parseLinkHeader(GITHUB_LINK);
    expect(second).toEqual(first);
  });

  it('handles a rel with multiple space-separated tokens', () => {
    const parsed = parseLinkHeader('<https://x.test/?p=2>; rel="next last"');
    expect(parsed.next).toBe('https://x.test/?p=2');
    expect(parsed.last).toBe('https://x.test/?p=2');
  });
});

describe('resolveNextPage', () => {
  it('returns true when a Link next entry is present (Gitee single quotes)', () => {
    expect(
      resolveNextPage({
        link: GITEE_LINK,
        totalPage: 80,
        page: 1,
        itemCount: 2,
        perPage: 2,
      }),
    ).toBe(true);
  });

  it('returns true when a Link next entry is present (GitHub double quotes)', () => {
    expect(
      resolveNextPage({ link: GITHUB_LINK, totalPage: null, page: 1, itemCount: 2, perPage: 2 }),
    ).toBe(true);
  });

  it('stops at the last page using total_page alone (AtomGit, no Link)', () => {
    expect(resolveNextPage({ link: null, totalPage: 37, page: 37, itemCount: 2, perPage: 2 })).toBe(
      false,
    );
    expect(resolveNextPage({ link: null, totalPage: 37, page: 36, itemCount: 2, perPage: 2 })).toBe(
      true,
    );
  });

  it('falls back to a full page when both headers are absent', () => {
    expect(
      resolveNextPage({ link: null, totalPage: null, page: 3, itemCount: 41, perPage: 100 }),
    ).toBe(false);
    expect(
      resolveNextPage({ link: null, totalPage: null, page: 1, itemCount: 100, perPage: 100 }),
    ).toBe(true);
  });

  it('returns false for an empty page regardless of headers', () => {
    expect(resolveNextPage({ link: null, totalPage: 5, page: 1, itemCount: 0, perPage: 100 })).toBe(
      true,
    ); // total_page still says more exists
    expect(
      resolveNextPage({ link: null, totalPage: null, page: 1, itemCount: 0, perPage: 100 }),
    ).toBe(false);
  });

  it('lets a Link header win over a short page', () => {
    // A platform may cap per_page below what was asked for; trusting the short
    // page alone would truncate the result silently.
    expect(
      resolveNextPage({ link: GITHUB_LINK, totalPage: null, page: 1, itemCount: 1, perPage: 100 }),
    ).toBe(true);
  });
});

describe('strict pagination links', () => {
  it.each([
    [2, 1, false],
    [3, 0, true],
  ])('uses rel=last page %i when there is no rel=next', (lastPage, itemCount, hasNext) => {
    const link = `<https://pagination.invalid/issues?page=${lastPage}>; rel="last"`;
    expect(resolveNextPage({ link, totalPage: null, page: 2, itemCount, perPage: 1 }, true)).toBe(
      hasNext,
    );
  });
});

describe('readTotalPage / readTotalCount', () => {
  it('reads total_page from a Headers instance', () => {
    expect(readTotalPage(new Headers({ total_page: '37' }))).toBe(37);
  });

  it('accepts the x-total-pages spelling', () => {
    expect(readTotalPage({ 'x-total-pages': '12' })).toBe(12);
  });

  it('returns null for missing or invalid values', () => {
    expect(readTotalPage(undefined)).toBeNull();
    expect(readTotalPage(new Headers())).toBeNull();
    expect(readTotalPage({ total_page: 'many' })).toBeNull();
    expect(readTotalPage({ total_page: '0' })).toBeNull();
  });

  it('reads total_count including zero', () => {
    expect(readTotalCount(new Headers({ total_count: '0' }))).toBe(0);
    expect(readTotalCount(new Headers({ total_count: '157' }))).toBe(157);
    expect(readTotalCount(undefined)).toBeNull();
  });
});

describe('dedupeBy', () => {
  it('keeps the first occurrence and preserves order', () => {
    const items = [
      { key: 'c', v: 1 },
      { key: 'a', v: 2 },
      { key: 'c', v: 3 },
      { key: 'b', v: 4 },
      { key: 'a', v: 5 },
    ];
    const result = dedupeBy(items, (item) => item.key);
    expect(result.map((item) => item.v)).toEqual([1, 2, 4]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeBy([], (item: never) => String(item))).toEqual([]);
  });

  it('does not reorder even when duplicates appear late', () => {
    const result = dedupeBy(['b', 'a', 'b'], (item) => item);
    expect(result).toEqual(['b', 'a']);
  });
});

describe('normalizePerPage / normalizeMaxPages', () => {
  it('defaults to 100 items and 10 pages', () => {
    expect(normalizePerPage(undefined)).toBe(DEFAULT_PER_PAGE);
    expect(normalizeMaxPages(undefined)).toBe(DEFAULT_MAX_PAGES);
    expect(DEFAULT_PER_PAGE).toBe(100);
    expect(DEFAULT_MAX_PAGES).toBe(10);
  });

  it('clamps to the hard caps', () => {
    expect(normalizePerPage(500)).toBe(MAX_PER_PAGE);
    expect(normalizePerPage(0)).toBe(1);
    expect(normalizeMaxPages(500)).toBe(MAX_PAGES_LIMIT);
    expect(normalizeMaxPages(0)).toBe(1);
  });

  it('truncates fractional values', () => {
    expect(normalizePerPage(50.9)).toBe(50);
    expect(normalizeMaxPages(3.7)).toBe(3);
  });

  it('documents the worst-case page budget', () => {
    expect(DEFAULT_MAX_PAGES * DEFAULT_PER_PAGE).toBe(1_000);
  });
});

describe('collectPages', () => {
  /**
   * Matches a request for one specific page number.
   *
   * A bare `/page=2/` would also match `per_page=2`, so the boundary has to be
   * explicit or every page request would hit the last route.
   */
  const pageIs =
    (page: number) =>
    (call: { url: string }): boolean => {
      const url = new URL(call.url);
      return url.searchParams.get('page') === String(page);
    };

  /** Builds a client over a mock fetch with recording sleep. */
  const build = (
    mock: ReturnType<typeof createMockFetch>,
  ): { http: HttpClient; delays: number[] } => {
    const recorder = createRecordingSleep();
    const http = new HttpClient({
      baseUrl: 'https://api.github.com',
      provider: 'github',
      fetch: mock.fetch,
      sleep: recorder.sleep,
      random: () => 0,
    });
    return { http, delays: recorder.delays };
  };

  it('aggregates two pages without duplicates, in page order', async () => {
    const mock = createMockFetch([
      {
        match: pageIs(2),
        responses: [jsonResponse([{ key: 'c' }, { key: 'd' }], { headers: { total_page: '2' } })],
      },
      {
        match: pageIs(1),
        responses: [jsonResponse([{ key: 'a' }, { key: 'b' }], { headers: { total_page: '2' } })],
      },
    ]);
    const { http } = build(mock);

    const result = await collectPages<{ key: string }>(
      http,
      {
        method: 'GET',
        path: '/repos/{owner}/{repo}/issues',
        pathParams: { owner: 'org', repo: 'repo' },
      },
      {
        perPage: 2,
        selectItems: (raw) => raw as { key: string }[],
        keyOf: (item) => item.key,
      },
    );

    expect(result.map((item) => item.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.url).toContain('page=1');
    expect(mock.calls[1]!.url).toContain('page=2');
  });

  it('drops a duplicate that appears on both pages', async () => {
    const mock = createMockFetch([
      {
        match: pageIs(2),
        responses: [jsonResponse([{ key: 'b' }, { key: 'c' }], { headers: { total_page: '2' } })],
      },
      {
        match: pageIs(1),
        responses: [jsonResponse([{ key: 'a' }, { key: 'b' }], { headers: { total_page: '2' } })],
      },
    ]);
    const { http } = build(mock);

    const result = await collectPages<{ key: string }>(
      http,
      { method: 'GET', path: '/issues' },
      { perPage: 2, selectItems: (raw) => raw as { key: string }[], keyOf: (item) => item.key },
    );

    expect(result.map((item) => item.key)).toEqual(['a', 'b', 'c']);
  });

  it('stops at maxPages even when the platform reports more pages', async () => {
    const mock = createMockFetch([
      {
        match: pageIs(1),
        responses: [jsonResponse([{ key: 'a' }], { headers: { total_page: '50' } })],
      },
      {
        match: pageIs(2),
        responses: [jsonResponse([{ key: 'b' }], { headers: { total_page: '50' } })],
      },
      {
        match: pageIs(3),
        responses: [jsonResponse([{ key: 'c' }], { headers: { total_page: '50' } })],
      },
    ]);
    const { http } = build(mock);

    const result = await collectPages<{ key: string }>(
      http,
      { method: 'GET', path: '/issues' },
      {
        perPage: 1,
        maxPages: 2,
        selectItems: (raw) => raw as { key: string }[],
        keyOf: (item) => item.key,
      },
    );

    expect(result).toHaveLength(2);
    expect(mock.calls).toHaveLength(2);
  });

  it('stops after an empty page', async () => {
    const mock = createMockFetch([
      { match: pageIs(1), responses: [jsonResponse([{ key: 'a' }])] },
      { match: pageIs(2), responses: [jsonResponse([])] },
      { match: pageIs(3), responses: [jsonResponse([{ key: 'never' }])] },
    ]);
    const { http } = build(mock);

    const result = await collectPages<{ key: string }>(
      http,
      { method: 'GET', path: '/issues' },
      { perPage: 1, selectItems: (raw) => raw as { key: string }[], keyOf: (item) => item.key },
    );

    expect(result.map((item) => item.key)).toEqual(['a']);
    expect(mock.calls).toHaveLength(2);
  });

  it('sends per_page and page on every request', async () => {
    const mock = createMockFetch([{ match: '/issues', responses: [jsonResponse([])] }]);
    const { http } = build(mock);

    await collectPages<unknown>(
      http,
      { method: 'GET', path: '/issues', query: { state: 'open' } },
      { perPage: 50, selectItems: () => [], keyOf: () => '' },
    );

    const url = mock.calls[0]!.url;
    expect(url).toContain('per_page=50');
    expect(url).toContain('page=1');
    expect(url).toContain('state=open');
  });

  it('keeps paging on AtomGit, which sends total_page but no Link', async () => {
    const mock = createMockFetch([
      {
        match: pageIs(1),
        responses: [jsonResponse([{ key: 'a' }, { key: 'b' }], { headers: { total_page: '2' } })],
      },
      {
        match: pageIs(2),
        responses: [jsonResponse([{ key: 'c' }], { headers: { total_page: '2' } })],
      },
    ]);
    const { http } = build(mock);

    const result = await collectPages<{ key: string }>(
      http,
      { method: 'GET', path: '/issues' },
      { perPage: 2, selectItems: (raw) => raw as { key: string }[], keyOf: (item) => item.key },
    );

    expect(result.map((item) => item.key)).toEqual(['a', 'b', 'c']);
  });

  it('keeps paging on Gitee, whose Link uses single quotes', async () => {
    const mock = createMockFetch([
      {
        match: pageIs(1),
        responses: [
          jsonResponse([{ key: 'a' }], {
            headers: { link: GITEE_LINK, total_count: '2', total_page: '2' },
          }),
        ],
      },
      {
        match: pageIs(2),
        responses: [
          jsonResponse([{ key: 'b' }], {
            headers: {
              link: "<https://gitee.com/x?page=1>; rel='first'",
              total_count: '2',
              total_page: '2',
            },
          }),
        ],
      },
    ]);
    const { http } = build(mock);

    const result = await collectPages<{ key: string }>(
      http,
      { method: 'GET', path: '/issues' },
      { perPage: 1, selectItems: (raw) => raw as { key: string }[], keyOf: (item) => item.key },
    );

    expect(result.map((item) => item.key)).toEqual(['a', 'b']);
    expect(mock.calls).toHaveLength(2);
  });
});
