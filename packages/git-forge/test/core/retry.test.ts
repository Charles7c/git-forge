import { describe, expect, it } from 'vitest';

import { isRateLimitResponse } from '../../src/core/errors.js';
import {
  DEFAULT_RETRY_POLICY,
  computeDelay,
  isIdempotentMethod,
  isRetryableStatus,
  parseRetryAfter,
  resolveRetryPolicy,
  retryAfterFromHeaders,
  shouldRetry,
} from '../../src/core/retry.js';

describe('DEFAULT_RETRY_POLICY', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.baseMs).toBe(500);
    expect(DEFAULT_RETRY_POLICY.factor).toBe(2);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(8_000);
    expect(DEFAULT_RETRY_POLICY.writes).toBe(false);
    expect(DEFAULT_RETRY_POLICY.maxRetryAfterMs).toBe(60_000);
  });
});

describe('resolveRetryPolicy', () => {
  it('returns a copy of the defaults when no override is given', () => {
    const policy = resolveRetryPolicy();
    expect(policy).toEqual(DEFAULT_RETRY_POLICY);
    expect(policy).not.toBe(DEFAULT_RETRY_POLICY);
  });

  it('applies only the supplied overrides', () => {
    const policy = resolveRetryPolicy({ maxRetries: 1, writes: true });
    expect(policy.maxRetries).toBe(1);
    expect(policy.writes).toBe(true);
    expect(policy.baseMs).toBe(DEFAULT_RETRY_POLICY.baseMs);
    expect(policy.maxDelayMs).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });
});

describe('computeDelay', () => {
  const policy = DEFAULT_RETRY_POLICY;

  it('scales the window per attempt: 500 / 1000 / 2000', () => {
    // random() = 1 gives the ceiling of each window.
    expect(computeDelay(1, policy, () => 1)).toBe(500);
    expect(computeDelay(2, policy, () => 1)).toBe(1_000);
    expect(computeDelay(3, policy, () => 1)).toBe(2_000);
  });

  it('never exceeds the per-attempt ceiling', () => {
    for (const attempt of [1, 2, 3]) {
      const ceiling = Math.min(policy.baseMs * policy.factor ** (attempt - 1), policy.maxDelayMs);
      expect(computeDelay(attempt, policy, () => 0.999)).toBeLessThanOrEqual(ceiling);
    }
  });

  it('gives a zero floor when the random source returns 0', () => {
    expect(computeDelay(1, policy, () => 0)).toBe(0);
  });

  it('clamps to maxDelayMs on a high attempt', () => {
    // 500 * 2^9 = 256000, capped at 8000.
    expect(Math.min(500 * 2 ** 9, policy.maxDelayMs)).toBe(8_000);
    expect(computeDelay(10, policy, () => 1)).toBe(8_000);
  });

  it('sums to at most 3500ms across the three default retries', () => {
    const total =
      computeDelay(1, policy, () => 1) +
      computeDelay(2, policy, () => 1) +
      computeDelay(3, policy, () => 1);
    expect(total).toBe(3_500);
  });

  it('does not shorten a server delay with local jitter', () => {
    expect(computeDelay(1, policy, () => 1, 5_000)).toBe(5_000);
    expect(computeDelay(1, policy, () => 0.5, 5_000)).toBe(5_000);
  });

  it('preserves over-budget hints so callers can decline the retry', () => {
    expect(computeDelay(1, policy, () => 1, 600_000)).toBe(600_000);
  });
});

describe('parseRetryAfter', () => {
  it('converts delta-seconds to milliseconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('1')).toBe(1_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('caps the value at the supplied maximum', () => {
    expect(parseRetryAfter('3600', 60_000)).toBe(60_000);
  });

  it('returns undefined for missing, empty or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('understands an HTTP-date in the future', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfter(future, 60_000);
    expect(parsed).toBeDefined();
    expect(parsed!).toBeGreaterThan(20_000);
    expect(parsed!).toBeLessThanOrEqual(60_000);
  });

  it('returns 0 for an HTTP-date in the past', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});

describe('retryAfterFromHeaders', () => {
  it('reads retry-after first', () => {
    const headers = new Headers({
      'retry-after': '2',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60),
    });
    expect(retryAfterFromHeaders(headers, 60_000)).toBe(2_000);
  });

  it('falls back to x-ratelimit-reset for GitHub quota exhaustion', () => {
    const reset = String(Math.floor(Date.now() / 1000) + 30);
    const headers = new Headers({ 'x-ratelimit-reset': reset, 'x-ratelimit-remaining': '0' });
    const value = retryAfterFromHeaders(headers, 60_000);
    expect(value).toBeDefined();
    expect(value!).toBeGreaterThan(20_000);
    expect(value!).toBeLessThanOrEqual(60_000);
  });

  it('returns undefined when neither header is usable', () => {
    expect(retryAfterFromHeaders(new Headers(), 60_000)).toBeUndefined();
    expect(retryAfterFromHeaders(undefined, 60_000)).toBeUndefined();
    const past = String(Math.floor(Date.now() / 1000) - 60);
    expect(retryAfterFromHeaders({ 'x-ratelimit-reset': past }, 60_000)).toBeUndefined();
  });
});

describe('isIdempotentMethod', () => {
  it('treats GET, HEAD and OPTIONS as idempotent', () => {
    expect(isIdempotentMethod('GET')).toBe(true);
    expect(isIdempotentMethod('get')).toBe(true);
    expect(isIdempotentMethod('HEAD')).toBe(true);
    expect(isIdempotentMethod('OPTIONS')).toBe(true);
  });

  it('treats POST, PATCH, PUT and DELETE as writes', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(isIdempotentMethod(method)).toBe(false);
    }
  });
});

describe('shouldRetry', () => {
  const policy = DEFAULT_RETRY_POLICY;

  it('retries a GET on 429', () => {
    expect(
      shouldRetry({ attempt: 1, method: 'GET', code: 'RATE_LIMITED', status: 429, policy }),
    ).toBe(true);
  });

  it('retries a GET on 5xx', () => {
    expect(
      shouldRetry({ attempt: 1, method: 'GET', code: 'PROVIDER_ERROR', status: 503, policy }),
    ).toBe(true);
  });

  it('retries a GET on a network error', () => {
    expect(shouldRetry({ attempt: 1, method: 'GET', code: 'NETWORK_ERROR', policy })).toBe(true);
  });

  it('does not retry a GET on 401, 403, 404 or 422', () => {
    for (const [code, status] of [
      ['AUTH_INVALID', 401],
      ['AUTH_INVALID', 403],
      ['NOT_FOUND', 404],
      ['INVALID_ARGUMENT', 422],
    ] as const) {
      expect(shouldRetry({ attempt: 1, method: 'GET', code, status, policy })).toBe(false);
    }
  });

  it('does not retry 405 or 409, which are permanent upstream complaints', () => {
    expect(
      shouldRetry({ attempt: 1, method: 'GET', code: 'PROVIDER_ERROR', status: 405, policy }),
    ).toBe(false);
    expect(
      shouldRetry({ attempt: 1, method: 'GET', code: 'PROVIDER_ERROR', status: 409, policy }),
    ).toBe(false);
  });

  it('does not retry a POST by default, even on 503', () => {
    expect(
      shouldRetry({ attempt: 1, method: 'POST', code: 'PROVIDER_ERROR', status: 503, policy }),
    ).toBe(false);
    expect(
      shouldRetry({ attempt: 1, method: 'POST', code: 'RATE_LIMITED', status: 429, policy }),
    ).toBe(false);
  });

  it('retries a POST when retry.writes is enabled', () => {
    const writesPolicy = resolveRetryPolicy({ writes: true });
    expect(
      shouldRetry({
        attempt: 1,
        method: 'POST',
        code: 'RATE_LIMITED',
        status: 429,
        policy: writesPolicy,
      }),
    ).toBe(true);
  });

  it('stops once the retry budget is exhausted', () => {
    expect(
      shouldRetry({ attempt: 4, method: 'GET', code: 'RATE_LIMITED', status: 429, policy }),
    ).toBe(false);
    expect(
      shouldRetry({ attempt: 3, method: 'GET', code: 'RATE_LIMITED', status: 429, policy }),
    ).toBe(true);
  });

  it('never retries locally-decided failures', () => {
    for (const code of ['AUTH_MISSING', 'UNSUPPORTED_ON_PROVIDER', 'READONLY_BLOCKED'] as const) {
      expect(shouldRetry({ attempt: 1, method: 'GET', code, policy })).toBe(false);
    }
  });
});

describe('isRetryableStatus', () => {
  it('retries 429 and 5xx', () => {
    expect(isRetryableStatus(429, undefined)).toBe(true);
    expect(isRetryableStatus(500, undefined)).toBe(true);
    expect(isRetryableStatus(503, undefined)).toBe(true);
  });

  it('retries a 403 that is really a quota exhaustion', () => {
    expect(isRetryableStatus(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(true);
    expect(isRateLimitResponse(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(true);
  });

  it('does not retry a genuine 403 or a 404', () => {
    expect(isRetryableStatus(403, new Headers({ 'x-ratelimit-remaining': '9' }))).toBe(false);
    expect(isRetryableStatus(404, undefined)).toBe(false);
  });
});
