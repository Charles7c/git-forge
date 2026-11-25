import { describe, expect, it } from 'vitest';

import { eventKeyOf, sortEventsOldestFirst } from '../../src/adapters/events.js';
import { labelKeyOf, selectLabelRows } from '../../src/adapters/labels.js';
import { HttpClient } from '../../src/core/http.js';
import { GitForgeError } from '../../src/core/errors.js';
import type { IssueEvent } from '../../src/core/types.js';
import { jsonResponse } from '../helpers/mockFetch.js';
import { createMockFetch } from '../helpers/mockFetch.js';

/** Builds an `HttpClient` over a mock, so `invalidResponse` can be exercised. */
function buildHttp(): HttpClient {
  const mock = createMockFetch([{ match: /.*/, responses: [jsonResponse({}, { status: 502 })] }]);
  return new HttpClient({
    baseUrl: 'https://api.github.com',
    provider: 'github',
    token: 'fixture',
    fetch: mock.fetch,
    sleep: () => Promise.resolve(),
    random: () => 0,
    retry: { maxRetries: 0 },
  });
}

/** One label event with a controllable timestamp. */
function event(created_at: string, type: IssueEvent['type'] = 'labeled'): IssueEvent {
  return { provider: 'github', owner: 'o', repo: 'r', type, created_at };
}

describe('eventKeyOf', () => {
  it('keys a numeric id and a string id the same way', () => {
    const keyOf = eventKeyOf();
    expect(keyOf({ id: 7 })).toBe('id:7');
    expect(keyOf({ id: '7' })).toBe('id:7');
    expect(keyOf({ id: 7 })).toBe('id:7');
  });

  it('gives every id-less entry a distinct key', () => {
    // The whole point: two of these cannot be proven identical, so neither may
    // be dropped by cross-page deduplication.
    const keyOf = eventKeyOf();
    const keys = [keyOf({ event: 'labeled' }), keyOf({ event: 'labeled' }), keyOf(null)];
    expect(new Set(keys).size).toBe(3);
  });

  it('does not treat an empty string or a non-finite number as an id', () => {
    const keyOf = eventKeyOf();
    expect(keyOf({ id: '' })).not.toBe('id:');
    expect(keyOf({ id: Number.NaN })).not.toMatch(/^id:/);
    expect(keyOf({ id: {} })).toMatch(/^anonymous:/);
  });
});

describe('sortEventsOldestFirst', () => {
  it('orders by the parsed instant, not by the string', () => {
    // `+08:00` 09:00 is 01:00Z, which is earlier than 02:00Z, but sorts later
    // as a plain string.
    const sorted = sortEventsOldestFirst([
      event('2026-11-01T02:00:00Z', 'labeled'),
      event('2026-11-01T09:00:00+08:00', 'unlabeled'),
    ]);
    expect(sorted.map((entry) => entry.type)).toEqual(['unlabeled', 'labeled']);
  });

  it('is stable for equal instants written in different zones', () => {
    const first = event('2026-11-01T00:00:00Z', 'labeled');
    const second = event('2026-11-01T08:00:00+08:00', 'unlabeled');
    expect(sortEventsOldestFirst([first, second])).toEqual([first, second]);
    expect(sortEventsOldestFirst([second, first])).toEqual([second, first]);
  });

  it('keeps an unparseable timestamp last without reordering the rest', () => {
    const bad = event('not a timestamp', 'unknown');
    const early = event('2026-11-01T00:00:00Z', 'labeled');
    const late = event('2026-11-02T00:00:00Z', 'unlabeled');

    expect(sortEventsOldestFirst([bad, late, early]).map((entry) => entry.created_at)).toEqual([
      early.created_at,
      late.created_at,
      bad.created_at,
    ]);
    // Two unparseable entries keep their relative order too.
    const secondBad = event('also not a timestamp', 'unknown');
    const result = sortEventsOldestFirst([bad, early, secondBad]);
    expect(result.map((entry) => entry.created_at)).toEqual([
      early.created_at,
      bad.created_at,
      secondBad.created_at,
    ]);
  });

  it('returns an empty list unchanged', () => {
    expect(sortEventsOldestFirst([])).toEqual([]);
  });
});

describe('selectLabelRows', () => {
  it('passes a non-array body through as an empty list when strictness is off', () => {
    const http = buildHttp();
    expect(
      selectLabelRows(http, { status: 200, headers: new Headers(), json: {} }, undefined),
    ).toEqual([]);
  });

  it('accepts a well-formed catalog in strict mode', () => {
    const http = buildHttp();
    const rows = [{ name: 'bug' }, { name: 'docs' }];
    expect(
      selectLabelRows(http, { status: 200, headers: new Headers(), json: rows }, true),
    ).toEqual(rows);
  });

  it('rejects a non-array body and a nameless row with PROVIDER_ERROR', () => {
    const http = buildHttp();
    for (const json of [{}, [null], [{ name: 7 }], [{ name: '   ' }], [{ name: '' }]]) {
      try {
        selectLabelRows(http, { status: 200, headers: new Headers(), json }, true);
        throw new Error('expected the selector to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(GitForgeError);
        expect((error as GitForgeError).code).toBe('PROVIDER_ERROR');
      }
    }
  });
});

describe('labelKeyOf', () => {
  it('keys named rows by name and nameless rows separately', () => {
    const keyOf = labelKeyOf();
    expect(keyOf({ name: 'bug' })).toBe('name:bug');
    // Two nameless rows cannot be proven identical, so they must not merge.
    const keys = [keyOf({ color: 'ededed' }), keyOf({ color: 'ededed' })];
    expect(new Set(keys).size).toBe(2);
  });
});
