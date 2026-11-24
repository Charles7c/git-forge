import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  GitForgeError,
  authMissingError,
  defaultRetryable,
  errorFromNetwork,
  errorFromResponse,
  extractRequestId,
  extractUpstreamMessage,
  isGitForgeError,
  isRateLimitResponse,
  mapStatusToCode,
  readonlyBlockedError,
  retryableForStatus,
  unsupportedCapabilityError,
  type ErrorCode,
} from '../../src/core/errors.js';

/** A synthetic token that must never survive into a serialized error. */
const SECRET_TOKEN = ['synth', 'etic', 'token', 'value', '0123456789'].join('-');

/** Field expectations for every public error code. */
const CODE_CASES: ReadonlyArray<{
  code: ErrorCode;
  error: GitForgeError;
  retryable: boolean;
  provider: string | undefined;
}> = [
  {
    code: 'UNSUPPORTED_ON_PROVIDER',
    error: unsupportedCapabilityError('atomgit', 'files.pushFiles'),
    retryable: false,
    provider: 'atomgit',
  },
  {
    code: 'AUTH_MISSING',
    error: authMissingError('gitee', 'GITEE_TOKEN'),
    retryable: false,
    provider: 'gitee',
  },
  {
    code: 'AUTH_INVALID',
    error: new GitForgeError({ code: 'AUTH_INVALID', message: 'bad token', provider: 'github' }),
    retryable: false,
    provider: 'github',
  },
  {
    code: 'NOT_FOUND',
    error: new GitForgeError({ code: 'NOT_FOUND', message: 'missing', provider: 'github' }),
    retryable: false,
    provider: 'github',
  },
  {
    code: 'RATE_LIMITED',
    error: new GitForgeError({ code: 'RATE_LIMITED', message: 'slow down', provider: 'github' }),
    retryable: true,
    provider: 'github',
  },
  {
    code: 'PROVIDER_ERROR',
    error: new GitForgeError({ code: 'PROVIDER_ERROR', message: 'boom', provider: 'gitee' }),
    retryable: false,
    provider: 'gitee',
  },
  {
    code: 'INVALID_ARGUMENT',
    error: new GitForgeError({ code: 'INVALID_ARGUMENT', message: 'bad title' }),
    retryable: false,
    provider: undefined,
  },
  {
    code: 'NETWORK_ERROR',
    error: new GitForgeError({ code: 'NETWORK_ERROR', message: 'offline', provider: 'atomgit' }),
    retryable: true,
    provider: 'atomgit',
  },
  {
    code: 'READONLY_BLOCKED',
    error: readonlyBlockedError('github', 'issues.create', 'createIssue'),
    retryable: false,
    provider: 'github',
  },
  {
    code: 'PAGINATION_LIMIT',
    error: new GitForgeError({
      code: 'PAGINATION_LIMIT',
      message: 'page budget',
      provider: 'gitee',
    }),
    retryable: false,
    provider: 'gitee',
  },
];

describe('error codes', () => {
  it('defines exactly ten codes', () => {
    expect(ERROR_CODES).toHaveLength(10);
    expect(new Set(ERROR_CODES).size).toBe(10);
  });

  it.each(CODE_CASES)(
    'constructs $code with the right fields',
    ({ code, error, retryable, provider }) => {
      expect(error).toBeInstanceOf(GitForgeError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.provider).toBe(provider);
      expect(error.message.length).toBeGreaterThan(0);
    },
  );

  it('covers every declared code with a case', () => {
    const covered = new Set(CODE_CASES.map((entry) => entry.code));
    for (const code of ERROR_CODES) {
      expect(covered.has(code)).toBe(true);
    }
  });

  it('marks UNSUPPORTED_ON_PROVIDER with the offending capability and provider', () => {
    const error = unsupportedCapabilityError('atomgit', 'files.pushFiles');
    expect(error.capability).toBe('files.pushFiles');
    expect(error.message).toContain('files.pushFiles');
    expect(error.message).toContain('atomgit');
  });

  it('names the environment variable a caller must set for AUTH_MISSING', () => {
    expect(authMissingError('gitee', 'GITEE_TOKEN').message).toContain('GITEE_TOKEN');
  });

  it('explains how to lift READONLY_BLOCKED', () => {
    const message = readonlyBlockedError('github', 'issues.create', 'createIssue').message;
    expect(message).toContain('read-only');
    expect(message).toContain('issues.create');
  });

  it('agrees with defaultRetryable on every code', () => {
    for (const code of ERROR_CODES) {
      expect(defaultRetryable(code)).toBe(
        CODE_CASES.find((entry) => entry.code === code)?.retryable,
      );
    }
  });

  it('is recognized by isGitForgeError and rejects plain errors', () => {
    expect(isGitForgeError(new GitForgeError({ code: 'NOT_FOUND', message: 'x' }))).toBe(true);
    expect(isGitForgeError(new Error('x'))).toBe(false);
    expect(isGitForgeError(undefined)).toBe(false);
  });
});

describe('error serialization never leaks tokens', () => {
  const leaks = (error: GitForgeError): boolean => {
    const serialized = `${JSON.stringify(error)}${error.stack ?? ''}`;
    return serialized.includes(SECRET_TOKEN) || /access_token=[^*]/.test(serialized);
  };

  it.each(CODE_CASES)('keeps $code clean', ({ error }) => {
    expect(leaks(error)).toBe(false);
  });

  it('scrubs a token pasted into the message', () => {
    const error = new GitForgeError({
      code: 'AUTH_INVALID',
      message: `token ${SECRET_TOKEN} was rejected`,
      provider: 'github',
      secrets: [SECRET_TOKEN],
    });
    expect(error.message).not.toContain(SECRET_TOKEN);
    expect(leaks(error)).toBe(false);
  });

  it('scrubs access_token query strings from a message', () => {
    const error = new GitForgeError({
      code: 'PROVIDER_ERROR',
      message: `GET https://gitee.com/api/v5/repos?access_token=${SECRET_TOKEN}&page=1 failed`,
    });
    expect(error.message).not.toContain(SECRET_TOKEN);
    expect(error.message).toContain('access_token=***');
  });

  it('omits absent optional fields instead of writing undefined', () => {
    const json = new GitForgeError({ code: 'NOT_FOUND', message: 'gone' }).toJSON();
    expect(json).toEqual({ code: 'NOT_FOUND', message: 'gone', retryable: false });
    expect('provider' in json).toBe(false);
    expect('status' in json).toBe(false);
    expect('requestId' in json).toBe(false);
    expect('capability' in json).toBe(false);
  });

  it('round-trips through JSON.stringify with all fields present', () => {
    const error = new GitForgeError({
      code: 'RATE_LIMITED',
      message: 'slow down',
      provider: 'github',
      status: 429,
      requestId: 'req-1',
      capability: 'pulls.list',
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'RATE_LIMITED',
      message: 'slow down',
      provider: 'github',
      status: 429,
      requestId: 'req-1',
      capability: 'pulls.list',
      retryable: true,
    });
  });

  it('does not serialize headers or the cause chain', () => {
    const error = new GitForgeError({
      code: 'NETWORK_ERROR',
      message: 'offline',
      cause: new Error(SECRET_TOKEN),
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain('headers');
    expect('cause' in error.toJSON()).toBe(false);
  });
});

describe('mapStatusToCode', () => {
  it('maps 401 to AUTH_INVALID', () => {
    expect(mapStatusToCode(401)).toBe('AUTH_INVALID');
  });

  it('maps 403 without a rate-limit header to AUTH_INVALID', () => {
    expect(mapStatusToCode(403, new Headers({ 'x-ratelimit-remaining': '42' }))).toBe(
      'AUTH_INVALID',
    );
    expect(mapStatusToCode(403)).toBe('AUTH_INVALID');
  });

  it('maps 403 with x-ratelimit-remaining: 0 to RATE_LIMITED', () => {
    expect(mapStatusToCode(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(
      'RATE_LIMITED',
    );
  });

  it('maps 404 to NOT_FOUND', () => {
    expect(mapStatusToCode(404)).toBe('NOT_FOUND');
  });

  it('maps 429 to RATE_LIMITED', () => {
    expect(mapStatusToCode(429)).toBe('RATE_LIMITED');
  });

  it('maps 400 and 422 to INVALID_ARGUMENT', () => {
    expect(mapStatusToCode(400)).toBe('INVALID_ARGUMENT');
    expect(mapStatusToCode(422)).toBe('INVALID_ARGUMENT');
  });

  it('maps 5xx, 405 and 409 to PROVIDER_ERROR', () => {
    expect(mapStatusToCode(500)).toBe('PROVIDER_ERROR');
    expect(mapStatusToCode(502)).toBe('PROVIDER_ERROR');
    expect(mapStatusToCode(405)).toBe('PROVIDER_ERROR');
    expect(mapStatusToCode(409)).toBe('PROVIDER_ERROR');
  });

  it('malformed retryability: 5xx retryable, 405/409 not', () => {
    expect(retryableForStatus('PROVIDER_ERROR', 500)).toBe(true);
    expect(retryableForStatus('PROVIDER_ERROR', 405)).toBe(false);
    expect(retryableForStatus('PROVIDER_ERROR', 409)).toBe(false);
    expect(retryableForStatus('RATE_LIMITED', 429)).toBe(true);
  });

  it('detects rate limit responses by status or header', () => {
    expect(isRateLimitResponse(429, undefined)).toBe(true);
    expect(isRateLimitResponse(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(true);
    expect(isRateLimitResponse(403, new Headers({ 'x-ratelimit-remaining': '1' }))).toBe(false);
    expect(isRateLimitResponse(403, undefined)).toBe(false);
    expect(isRateLimitResponse(404, undefined)).toBe(false);
  });
});

describe('requestId extraction', () => {
  it('reads x-github-request-id from response headers', () => {
    const headers = new Headers({ 'x-github-request-id': 'abc:def' });
    expect(extractRequestId(headers)).toBe('abc:def');
  });

  it('falls back to x-request-id when the GitHub header is absent', () => {
    expect(extractRequestId(new Headers({ 'x-request-id': 'gitee-1' }))).toBe('gitee-1');
  });

  it('prefers the GitHub header over the generic one', () => {
    const headers = new Headers({ 'x-github-request-id': 'gh', 'x-request-id': 'generic' });
    expect(extractRequestId(headers)).toBe('gh');
  });

  it('reads trace_id from an AtomGit error body', () => {
    // Exact shape observed from api.atomgit.com, including the UN_KNOW spelling.
    const body = {
      error_code: 404,
      error_code_name: 'UN_KNOW',
      error_message: 'Project not found',
      trace_id: 'abc',
    };
    expect(extractRequestId(undefined, body)).toBe('abc');
  });

  it('accepts a plain header record', () => {
    expect(extractRequestId({ 'x-request-id': 'from-record' })).toBe('from-record');
  });

  it('returns undefined — not an empty string or placeholder — when absent', () => {
    const requestId = extractRequestId(new Headers(), { error_message: 'no id here' });
    expect(requestId).toBeUndefined();
    expect(requestId).not.toBe('');
    expect(requestId).not.toBe('unknown');
  });

  it('ignores empty header values', () => {
    expect(extractRequestId(new Headers({ 'x-request-id': '' }))).toBeUndefined();
  });

  it('prefers headers over the body', () => {
    const headers = new Headers({ 'x-request-id': 'header-wins' });
    expect(extractRequestId(headers, { trace_id: 'body-loses' })).toBe('header-wins');
  });
});

describe('errorFromResponse', () => {
  it('produces a RATE_LIMITED error with the upstream status and request id', () => {
    const error = errorFromResponse({
      provider: 'github',
      status: 403,
      headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-github-request-id': 'rid-9' }),
      body: { message: 'API rate limit exceeded' },
      context: 'GET /repos/{owner}/{repo}/issues',
    });

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(403);
    expect(error.requestId).toBe('rid-9');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('403');
    expect(error.message).toContain('github');
  });

  it('keeps the template in the message rather than a concrete URL', () => {
    const error = errorFromResponse({
      provider: 'gitee',
      status: 404,
      body: { message: 'Not Found Project' },
      context: 'GET /repos/{owner}/{repo}/issues/{number}',
    });
    expect(error.message).toContain('/repos/{owner}/{repo}/issues/{number}');
    expect(error.code).toBe('NOT_FOUND');
  });

  it('carries the AtomGit trace_id into requestId for PROVIDER_ERROR', () => {
    const error = errorFromResponse({
      provider: 'atomgit',
      status: 500,
      body: {
        error_code: 500,
        error_code_name: 'UN_KNOW',
        error_message: 'internal error',
        trace_id: 'trace-42',
      },
      context: 'GET /repos/{owner}/{repo}/pulls',
    });
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.requestId).toBe('trace-42');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('internal error');
  });

  it('scrubs a token passed via secrets', () => {
    const error = errorFromResponse({
      provider: 'gitee',
      status: 401,
      body: { message: `bad credential ${SECRET_TOKEN}` },
      context: 'POST /repos/{owner}/issues',
      secrets: [SECRET_TOKEN],
    });
    expect(error.message).not.toContain(SECRET_TOKEN);
  });
});

describe('extractUpstreamMessage', () => {
  it('reads the message key used by GitHub and Gitee', () => {
    expect(extractUpstreamMessage({ message: 'Bad credentials' })).toBe('Bad credentials');
  });

  it('reads the error_message key used by AtomGit', () => {
    expect(extractUpstreamMessage({ error_message: 'Project not found' })).toBe(
      'Project not found',
    );
  });

  it('returns undefined for non-objects and missing keys', () => {
    expect(extractUpstreamMessage(null)).toBeUndefined();
    expect(extractUpstreamMessage('plain text')).toBeUndefined();
    expect(extractUpstreamMessage({ other: 'x' })).toBeUndefined();
  });

  it('truncates long messages', () => {
    const long = 'x'.repeat(500);
    const result = extractUpstreamMessage({ message: long }, 20);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThan(long.length);
  });
});

describe('errorFromNetwork', () => {
  it('reports a timeout when the cause is an AbortError', () => {
    const cause = new Error('aborted');
    cause.name = 'AbortError';
    const error = errorFromNetwork({
      provider: 'github',
      context: 'GET /repos/{owner}/{repo}',
      cause,
      timeoutMs: 30_000,
    });
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('30000ms');
  });

  it('does not echo the raw cause message', () => {
    const cause = new Error(`connect ECONNREFUSED with ${SECRET_TOKEN}`);
    const error = errorFromNetwork({
      provider: 'atomgit',
      context: 'GET /repos/{owner}/{repo}',
      cause,
    });
    expect(error.message).not.toContain(SECRET_TOKEN);
    expect(error.cause).toBeDefined();
    expect(String(error.cause)).not.toContain(SECRET_TOKEN);
  });
});
