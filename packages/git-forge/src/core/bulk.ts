/**
 * Partial-failure isolation for batched operations.
 *
 * A batch that aborts on the first error is nearly useless for the intended use
 * case — fanning one call out across platforms and repositories. The caller
 * wants "these 3 of 5 worked, here is why the other 2 did not", with enough
 * structure to retry selectively.
 */
import { GitForgeError, invalidArgumentError, isGitForgeError } from './errors.js';
import type { GitForgeErrorJson } from './errors.js';

/** Outcome of one item in a bulk run. */
export type BulkItemResult<T> =
  { ok: true; value: T; index: number } | { ok: false; error: GitForgeErrorJson; index: number };

/** Options for {@link bulk}. */
export interface BulkOptions {
  /**
   * Maximum items in flight at once. Defaults to 4.
   *
   * Four keeps a batch inside typical 60-requests-per-hour quotas without
   * triggering rate limiting itself.
   */
  concurrency?: number;
}

/** Default in-flight limit. */
export const DEFAULT_BULK_CONCURRENCY = 4;

/**
 * Runs a task over every item, isolating failures.
 *
 * The returned array always matches the input length and order, and this
 * function never rejects: a failure becomes an `{ ok: false }` entry carrying
 * `code`/`provider`/`status`/`requestId`, so a caller can tell a missing token
 * from a 404 without re-parsing a message string.
 *
 * Non-`GitForgeError` failures are still isolated, but reported as
 * `PROVIDER_ERROR` because a public API must not surface an untyped error.
 *
 * @throws GitForgeError `INVALID_ARGUMENT` only for caller mistakes — a
 *         non-array `items` or a concurrency below 1.
 */
export async function bulk<A, T>(
  items: readonly A[],
  run: (item: A, index: number) => Promise<T>,
  options: BulkOptions = {},
): Promise<BulkItemResult<T>[]> {
  if (!Array.isArray(items)) {
    throw invalidArgumentError('Invalid `items`: expected an array');
  }
  if (typeof run !== 'function') {
    throw invalidArgumentError('Invalid `run`: expected a function');
  }

  const concurrency = normalizeConcurrency(options.concurrency);
  if (items.length === 0) {
    return [];
  }

  const results = new Array<BulkItemResult<T>>(items.length);
  let nextIndex = 0;

  /** Pulls the next index to process, sharing the cursor between workers. */
  const claimNext = (): number | undefined => {
    if (nextIndex >= items.length) {
      return undefined;
    }
    const index = nextIndex;
    nextIndex += 1;
    return index;
  };

  /** Processes one item, recording success or a normalized failure. */
  const processItem = async (item: A, index: number): Promise<void> => {
    try {
      const value = await run(item, index);
      results[index] = { ok: true, value, index };
    } catch (error) {
      results[index] = { ok: false, error: toErrorJson(error), index };
    }
  };

  /** One worker: drains the shared cursor until it is exhausted. */
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = claimNext();
      if (index === undefined) {
        return;
      }
      const item = items[index] as A;
      await processItem(item, index);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/** Clamps concurrency to a sane positive integer. */
function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_BULK_CONCURRENCY;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw invalidArgumentError('Invalid `concurrency`: expected a positive integer');
  }
  return Math.trunc(value);
}

/**
 * Normalizes any thrown value into a serializable error record.
 *
 * `GitForgeError` keeps its fields; anything else is wrapped so the result type
 * stays uniform and no raw error text leaks into a public payload.
 */
function toErrorJson(error: unknown): GitForgeErrorJson {
  if (isGitForgeError(error)) {
    return error.toJSON();
  }
  const detail = error instanceof Error ? error.name : typeof error;
  return new GitForgeError({
    code: 'PROVIDER_ERROR',
    message: `Unexpected failure (${detail})`,
  }).toJSON();
}

/** Partitions a result set into its successes and failures. */
export function partitionBulk<T>(results: readonly BulkItemResult<T>[]): {
  succeeded: T[];
  failed: GitForgeErrorJson[];
} {
  const succeeded: T[] = [];
  const failed: GitForgeErrorJson[] = [];
  for (const result of results) {
    if (result.ok) {
      succeeded.push(result.value);
    } else {
      failed.push(result.error);
    }
  }
  return { succeeded, failed };
}

/** Whether every item in a bulk run succeeded. */
export function allSucceeded<T>(results: readonly BulkItemResult<T>[]): boolean {
  return results.every((result) => result.ok);
}
