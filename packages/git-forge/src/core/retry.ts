/**
 * Retry policy: full-jitter exponential backoff.
 *
 * Jitter matters for more than politeness here. Three calls hitting the same
 * exhausted quota at the same instant would retry in lockstep and keep failing
 * together; spreading them out is what lets a batch recover.
 *
 * The delay formula is `random() * min(base * factor^(attempt-1), maxDelay)`,
 * so attempt 1 waits in `[0, 500]`, attempt 2 in `[0, 1000]`, attempt 3 in
 * `[0, 2000]`. A server-supplied delay takes precedence: wait the full interval
 * or return the original failure if that interval exceeds the retry budget.
 */
import { defaultRetryable, isRateLimitResponse, retryableForStatus } from './errors.js';
import type { ErrorCode } from './errors.js';

/** Retry tuning knobs. */
export interface RetryPolicy {
  /** Retries after the initial attempt. Defaults to 3. */
  maxRetries: number;
  /** First backoff ceiling in milliseconds. Defaults to 500. */
  baseMs: number;
  /** Multiplier per attempt. Defaults to 2. */
  factor: number;
  /** Backoff ceiling in milliseconds. Defaults to 8 000. */
  maxDelayMs: number;
  /** Whether non-idempotent methods may be retried. Defaults to `false`. */
  writes: boolean;
  /** Maximum server-requested wait we will accept before giving up. Defaults to 60 s. */
  maxRetryAfterMs: number;
}

/** Default policy. Read calls retry; write calls do not. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseMs: 500,
  factor: 2,
  maxDelayMs: 8_000,
  writes: false,
  maxRetryAfterMs: 60_000,
};

/** HTTP methods treated as idempotent. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a method is safe to retry without changing semantics.
 *
 * Deliberately conservative: `PUT` and `DELETE` are idempotent per RFC 9110 but
 * are still treated as writes, because retrying a partially applied change can
 * produce a second commit.
 */
export function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/** Merges caller overrides over the defaults. */
export function resolveRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  if (overrides === undefined) {
    return { ...DEFAULT_RETRY_POLICY };
  }
  return {
    maxRetries: overrides.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
    baseMs: overrides.baseMs ?? DEFAULT_RETRY_POLICY.baseMs,
    factor: overrides.factor ?? DEFAULT_RETRY_POLICY.factor,
    maxDelayMs: overrides.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    writes: overrides.writes ?? DEFAULT_RETRY_POLICY.writes,
    maxRetryAfterMs: overrides.maxRetryAfterMs ?? DEFAULT_RETRY_POLICY.maxRetryAfterMs,
  };
}

/**
 * Computes the backoff delay for an attempt.
 *
 * @param attempt 1-based retry number (1 is the first retry, not the initial
 *                request).
 * @param policy  Resolved policy.
 * @param random  Injected randomness; defaults to `Math.random`.
 * @param retryAfterMs Server hint, already converted to milliseconds.
 */
export function computeDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const ceiling = Math.min(
    policy.baseMs * policy.factor ** Math.max(attempt - 1, 0),
    policy.maxDelayMs,
  );
  return Math.floor(random() * ceiling);
}

/**
 * Parses a `retry-after` header into milliseconds.
 *
 * Handles both forms RFC 9110 allows: delta-seconds and an HTTP-date. Returns
 * `undefined` for a missing or unparseable value so the caller falls back to its
 * own backoff.
 *
 * @param maxMs Optional ceiling for callers that need a capped duration. The
 *              request layer omits it to distinguish an over-budget hint.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  maxMs?: number,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return maxMs === undefined ? ms : Math.min(ms, maxMs);
  }

  // Date.parse also accepts non-HTTP strings (including fractional seconds
  // interpreted as calendar dates). Only the three HTTP-date forms qualify.
  const imfDate = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  const rfc850 = /^[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
  const asctime = /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
  if (!imfDate.test(trimmed) && !rfc850.test(trimmed) && !asctime.test(trimmed)) return undefined;
  const date = Date.parse(trimmed.endsWith(' GMT') ? trimmed : `${trimmed} GMT`);
  if (Number.isNaN(date)) {
    return undefined;
  }
  const delta = date - Date.now();
  const ms = delta <= 0 ? 0 : delta;
  return maxMs === undefined ? ms : Math.min(ms, maxMs);
}

/** What the request layer knows when deciding whether to try again. */
export interface RetryDecisionInput {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  method: string;
  code: ErrorCode;
  /** Upstream status, when a response was received. */
  status?: number;
  /** Uncapped minimum wait requested by the provider. */
  retryAfterMs?: number;
  policy: RetryPolicy;
}

/**
 * Decides whether another attempt is warranted.
 *
 * Two independent conditions must hold: the error kind is retryable, and the
 * method is one the policy allows to repeat. A write call therefore stays
 * un-retried even on a 503 unless `retry.writes` was explicitly enabled.
 */
export function shouldRetry(input: RetryDecisionInput): boolean {
  const { attempt, method, code, status, retryAfterMs, policy } = input;

  // Node clamps larger setTimeout intervals to 1 ms, which would retry early.
  const maxServerWait = Math.min(policy.maxRetryAfterMs, 2 ** 31 - 1);
  if (retryAfterMs !== undefined && !(retryAfterMs <= maxServerWait)) return false;
  if (attempt > policy.maxRetries) {
    return false;
  }
  if (!isIdempotentMethod(method) && !policy.writes) {
    return false;
  }

  if (code === 'NETWORK_ERROR' || code === 'RATE_LIMITED') {
    return true;
  }
  if (code === 'PROVIDER_ERROR') {
    return status !== undefined ? retryableForStatus(code, status) : defaultRetryable(code);
  }
  return false;
}

/**
 * Reads the `retry-after` hint from response headers.
 *
 * Also understands `x-ratelimit-reset` (epoch seconds), which GitHub sends on a
 * 403 quota exhaustion where `retry-after` may be absent.
 */
export function retryAfterFromHeaders(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
  maxMs?: number,
): number | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const retryAfter = parseRetryAfter(readHeader(headers, 'retry-after'), maxMs);
  if (retryAfter !== undefined) {
    return retryAfter;
  }

  if (readHeader(headers, 'x-ratelimit-remaining')?.trim() !== '0') return undefined;
  const reset = readHeader(headers, 'x-ratelimit-reset');
  if (reset !== undefined && /^\d+$/.test(reset.trim())) {
    const delta = Number(reset.trim()) * 1000 - Date.now();
    if (delta > 0) {
      return maxMs === undefined ? delta : Math.min(delta, maxMs);
    }
  }

  return undefined;
}

/** Reads a header from either a `Headers` instance or a plain record. */
function readHeader(
  headers: Headers | Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(key);
    return value === null ? undefined : value;
  }
  const record = headers as Readonly<Record<string, string | undefined>>;
  return record[key] ?? record[key.toLowerCase()];
}

/**
 * Whether a response should be retried, from the response alone.
 *
 * Exposed so the request layer can short-circuit before building an error
 * object for a status it is about to retry anyway.
 */
export function isRetryableStatus(
  status: number,
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  if (status === 429) {
    return true;
  }
  if (status >= 500) {
    return true;
  }
  return isRateLimitResponse(status, headers);
}
