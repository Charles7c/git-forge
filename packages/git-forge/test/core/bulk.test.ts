import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BULK_CONCURRENCY,
  allSucceeded,
  bulk,
  partitionBulk,
} from '../../src/core/bulk.js';
import { GitForgeError } from '../../src/core/errors.js';

/** A minimal GitForgeError factory for the failure cases. */
function fail(
  code: 'NOT_FOUND' | 'AUTH_MISSING' | 'RATE_LIMITED',
  provider: 'github' | 'gitee' | 'atomgit',
): GitForgeError {
  return new GitForgeError({ code, message: `${code} on ${provider}`, provider, status: 404 });
}

describe('bulk', () => {
  it('returns one result per item, in input order', async () => {
    const results = await bulk([1, 2, 3], (item) => Promise.resolve(item * 10));

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('isolates failures: 5 items with 2 failures yields 5 results', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const results = await bulk(items, (item) => {
      if (item === 'b') {
        return Promise.reject(fail('NOT_FOUND', 'gitee'));
      }
      if (item === 'd') {
        return Promise.reject(fail('AUTH_MISSING', 'atomgit'));
      }
      return Promise.resolve(item.toUpperCase());
    });

    expect(results).toHaveLength(5);

    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);
    expect(successes).toHaveLength(3);
    expect(failures).toHaveLength(2);

    expect(successes.map((result) => (result.ok ? result.value : null))).toEqual(['A', 'C', 'E']);
    expect(failures.map((result) => (result.ok ? null : result.index))).toEqual([1, 3]);
  });

  it('preserves code, provider and status on failed items', async () => {
    const results = await bulk([0], () => Promise.reject(fail('NOT_FOUND', 'gitee')));
    const failure = results[0]!;

    expect(failure.ok).toBe(false);
    if (failure.ok) {
      throw new Error('expected a failure');
    }
    expect(failure.error.code).toBe('NOT_FOUND');
    expect(failure.error.provider).toBe('gitee');
    expect(failure.error.status).toBe(404);
    expect(failure.error.retryable).toBe(false);
  });

  it('never rejects overall, even when every item fails', async () => {
    const results = await bulk([1, 2, 3], () => Promise.reject(fail('RATE_LIMITED', 'github')));

    expect(results).toHaveLength(3);
    expect(allSucceeded(results)).toBe(false);
  });

  it('wraps a non-GitForgeError failure instead of leaking it', async () => {
    const results = await bulk([1], () => Promise.reject(new Error('raw boom')));
    const failure = results[0]!;

    expect(failure.ok).toBe(false);
    if (failure.ok) {
      throw new Error('expected a failure');
    }
    expect(failure.error.code).toBe('PROVIDER_ERROR');
    expect(failure.error.message).not.toContain('raw boom');
  });

  it('returns an empty array for empty input', async () => {
    expect(await bulk([], () => Promise.resolve(1))).toEqual([]);
  });

  it('rejects a non-array items argument with INVALID_ARGUMENT', async () => {
    await expect(bulk(null as unknown as number[], () => Promise.resolve(1))).rejects.toMatchObject(
      {
        code: 'INVALID_ARGUMENT',
      },
    );
  });

  it('rejects a concurrency below 1', async () => {
    await expect(bulk([1], () => Promise.resolve(1), { concurrency: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('defaults concurrency to 4', () => {
    expect(DEFAULT_BULK_CONCURRENCY).toBe(4);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await bulk(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield so other workers can start.
        await Promise.resolve();
        inFlight -= 1;
        return item;
      },
      { concurrency: 2 },
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await bulk([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], (item) => {
      seen.push(item);
      return Promise.resolve(item);
    });

    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('passes the item index to the task', async () => {
    const results = await bulk(['x', 'y'], (item, index) => Promise.resolve(`${index}:${item}`));
    expect(results.map((result) => (result.ok ? result.value : ''))).toEqual(['0:x', '1:y']);
  });
});

describe('partitionBulk', () => {
  it('splits successes and failures', async () => {
    const results = await bulk([1, 2, 3], (item) =>
      item === 2 ? Promise.reject(fail('NOT_FOUND', 'github')) : Promise.resolve(item),
    );
    const { succeeded, failed } = partitionBulk(results);

    expect(succeeded).toEqual([1, 3]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.code).toBe('NOT_FOUND');
  });

  it('handles an all-success result set', async () => {
    const results = await bulk([1, 2], (item) => Promise.resolve(item));
    expect(partitionBulk(results)).toEqual({ succeeded: [1, 2], failed: [] });
  });
});

describe('allSucceeded', () => {
  it('is true only when every item succeeded', async () => {
    expect(allSucceeded(await bulk([1, 2], (item) => Promise.resolve(item)))).toBe(true);
    expect(allSucceeded(await bulk([1, 2], () => Promise.reject(fail('NOT_FOUND', 'gitee'))))).toBe(
      false,
    );
  });

  it('is true for an empty result set', () => {
    expect(allSucceeded([])).toBe(true);
  });
});
