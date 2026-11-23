import { describe, expect, it, vi } from 'vitest';

import { GitForgeError } from '../../src/core/errors.js';
import { DEFAULT_TIMEOUT_MS, HttpClient } from '../../src/core/http.js';
import type { HttpClientOptions } from '../../src/core/http.js';
import {
  createMockFetch,
  createRecordingSleep,
  createSequenceRandom,
  jsonResponse,
} from '../helpers/mockFetch.js';

/**
 * Fixture token. Clearly not a credential, and URL-safe so it survives
 * `URLSearchParams` encoding unmodified when query-style auth is exercised.
 */
const TOKEN = ['fixture', 'token', 'not', 'a', 'credential'].join('-');

/** Builds a client with recording sleep and deterministic random by default. */
function buildClient(
  overrides: Partial<HttpClientOptions> & { mock: ReturnType<typeof createMockFetch> },
): { client: HttpClient; delays: number[] } {
  const { mock, ...rest } = overrides;
  const recorder = createRecordingSleep();
  const client = new HttpClient({
    baseUrl: 'https://api.github.com',
    provider: 'github',
    fetch: mock.fetch,
    sleep: recorder.sleep,
    random: () => 0,
    ...rest,
  });
  return { client, delays: recorder.delays };
}

/** Asserts a promise rejects with a `GitForgeError` and returns it. */
async function expectGitForgeError(promise: Promise<unknown>): Promise<GitForgeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitForgeError);
    return error as GitForgeError;
  }
  throw new Error('expected a GitForgeError');
}

describe('HttpClient defaults', () => {
  it('uses a 30s timeout and the documented UA by default', () => {
    const mock = createMockFetch();
    const { client } = buildClient({ mock });
    expect(client.timeoutMs).toBe(30_000);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('strips a trailing slash from the base URL', () => {
    const mock = createMockFetch([{ match: '', responses: [jsonResponse({})] }]);
    const { client } = buildClient({ mock, baseUrl: 'https://api.github.com/' });
    expect(client.baseUrl).toBe('https://api.github.com');
  });

  it('exposes whether a token is configured', () => {
    const mock = createMockFetch();
    expect(buildClient({ mock, token: TOKEN }).client.hasToken).toBe(true);
    expect(buildClient({ mock }).client.hasToken).toBe(false);
    expect(buildClient({ mock, token: '' }).client.hasToken).toBe(false);
  });
});

describe('bearer auth', () => {
  it('sends Authorization: Bearer with the configured token', async () => {
    const mock = createMockFetch([{ match: '/user', responses: [jsonResponse({ login: 'me' })] }]);
    const { client } = buildClient({ mock, token: TOKEN, auth: { style: 'bearer' } });

    await client.request({ method: 'GET', path: '/user' });

    expect(mock.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(mock.calls[0]!.url).not.toContain(TOKEN);
  });

  it('sends no Authorization header when no token is configured', async () => {
    const mock = createMockFetch([{ match: '/user', responses: [jsonResponse({})] }]);
    const { client } = buildClient({ mock });

    await client.request({ method: 'GET', path: '/user' });

    expect(mock.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('sends the user agent and merges default headers', async () => {
    const mock = createMockFetch([{ match: '/user', responses: [jsonResponse({})] }]);
    const { client } = buildClient({
      mock,
      defaultHeaders: {
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github+json',
      },
    });

    await client.request({ method: 'GET', path: '/user' });

    const headers = mock.calls[0]!.headers;
    expect(headers['user-agent']).toBe('git-forge/0.1.0');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(headers.accept).toBe('application/vnd.github+json');
  });

  it('lets per-request headers override defaults', async () => {
    const mock = createMockFetch([{ match: '/user', responses: [jsonResponse({})] }]);
    const { client } = buildClient({ mock, defaultHeaders: { accept: 'default' } });

    await client.request({ method: 'GET', path: '/user', headers: { Accept: 'override' } });

    expect(mock.calls[0]!.headers.accept).toBe('override');
  });
});

describe('query auth (compatibility path)', () => {
  it('appends access_token to the URL and omits the Authorization header', async () => {
    const mock = createMockFetch([{ match: '/user', responses: [jsonResponse({})] }]);
    const { client } = buildClient({
      mock,
      provider: 'gitee',
      baseUrl: 'https://gitee.com/api/v5',
      token: TOKEN,
      auth: { style: 'query', param: 'access_token' },
    });

    await client.request({ method: 'GET', path: '/user' });

    expect(mock.calls[0]!.url).toContain(`access_token=${TOKEN}`);
    expect(mock.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('redacts the token when describing the request', () => {
    const mock = createMockFetch();
    const { client } = buildClient({
      mock,
      provider: 'gitee',
      baseUrl: 'https://gitee.com/api/v5',
      token: TOKEN,
      auth: { style: 'query' },
    });

    const description = client.describe({ method: 'GET', path: '/repos/{owner}/{repo}/issues' });
    expect(description).toContain('access_token=***');
    expect(description).not.toContain(TOKEN);
  });
});

describe('path substitution', () => {
  it('replaces placeholders and URL-encodes values', async () => {
    const mock = createMockFetch([{ match: '/repos', responses: [jsonResponse({})] }]);
    const { client } = buildClient({ mock });

    await client.request({
      method: 'GET',
      path: '/repos/{owner}/{repo}/issues/{number}',
      pathParams: { owner: 'example-org', repo: 'demo kit', number: 'IEXA01' },
    });

    expect(mock.calls[0]!.url).toBe(
      'https://api.github.com/repos/example-org/demo%20kit/issues/IEXA01',
    );
  });

  it('keeps the path template rather than substituting path parameters', () => {
    const mock = createMockFetch();
    const { client } = buildClient({ mock });

    expect(
      client.describe({
        method: 'GET',
        path: '/repos/{owner}/{repo}/contents/README.md',
        pathParams: { owner: 'o', repo: 'r' },
      }),
    ).toBe('https://api.github.com/repos/{owner}/{repo}/contents/README.md');
  });

  it('drops undefined query values and stringifies the rest', async () => {
    const mock = createMockFetch([{ match: '/issues', responses: [jsonResponse([])] }]);
    const { client } = buildClient({ mock });

    await client.request({
      method: 'GET',
      path: '/issues',
      query: { state: 'open', page: 2, draft: true, omitted: undefined },
    });

    const url = new URL(mock.calls[0]!.url);
    expect(url.searchParams.get('state')).toBe('open');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('draft')).toBe('true');
    expect(url.searchParams.has('omitted')).toBe(false);
  });
});

describe('body encodings', () => {
  it('sends JSON by default and sets content-type', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [jsonResponse({ number: '1' })] },
    ]);
    const { client } = buildClient({ mock, token: TOKEN });

    await client.request({
      method: 'POST',
      path: '/repos/{owner}/{repo}/issues',
      pathParams: { owner: 'o', repo: 'r' },
      body: { title: 'Bug', labels: ['bug'] },
    });

    const call = mock.calls[0]!;
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.json).toEqual({ title: 'Bug', labels: ['bug'] });
  });

  it('sends form data via URLSearchParams and joins arrays with commas', async () => {
    const mock = createMockFetch([{ match: '/issues', responses: [jsonResponse({})] }]);
    const { client } = buildClient({
      mock,
      provider: 'gitee',
      baseUrl: 'https://gitee.com/api/v5',
    });

    await client.request({
      method: 'POST',
      path: '/repos/{owner}/issues',
      pathParams: { owner: 'o' },
      body: { repo: 'r', title: 'Bug', labels: ['bug', 'docs'] },
      paramsIn: 'form',
    });

    const call = mock.calls[0]!;
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.form).toEqual({ repo: 'r', title: 'Bug', labels: 'bug,docs' });
    expect(call.json).toBeUndefined();
  });

  it('moves body fields into the query string when paramsIn is query', async () => {
    const mock = createMockFetch([{ match: '/contents', responses: [jsonResponse({})] }]);
    const { client } = buildClient({
      mock,
      provider: 'gitee',
      baseUrl: 'https://gitee.com/api/v5',
    });

    await client.request({
      method: 'DELETE',
      path: '/repos/{owner}/{repo}/contents/{path}',
      pathParams: { owner: 'o', repo: 'r', path: 'README.md' },
      body: { sha: 'abc123', message: 'delete readme' },
      paramsIn: 'query',
    });

    const call = mock.calls[0]!;
    const url = new URL(call.url);
    expect(url.searchParams.get('sha')).toBe('abc123');
    expect(url.searchParams.get('message')).toBe('delete readme');
    expect(call.body).toBeUndefined();
    expect(call.headers['content-type']).toBeUndefined();
  });

  it('sends JSON for DELETE when paramsIn is json (AtomGit)', async () => {
    const mock = createMockFetch([{ match: '/contents', responses: [jsonResponse({})] }]);
    const { client } = buildClient({
      mock,
      provider: 'atomgit',
      baseUrl: 'https://api.atomgit.com/api/v5',
    });

    await client.request({
      method: 'DELETE',
      path: '/repos/{owner}/{repo}/contents/{path}',
      pathParams: { owner: 'o', repo: 'r', path: 'README.md' },
      body: { sha: 'abc123', message: 'delete readme' },
      paramsIn: 'json',
    });

    const call = mock.calls[0]!;
    expect(call.json).toEqual({ sha: 'abc123', message: 'delete readme' });
    expect(new URL(call.url).search).toBe('');
    expect(call.headers['content-type']).toBe('application/json');
  });
});

describe('timeouts', () => {
  it('passes an AbortSignal to fetch', async () => {
    const mock = createMockFetch([{ match: '/user', responses: [jsonResponse({})] }]);
    const { client } = buildClient({ mock });

    await client.request({ method: 'GET', path: '/user' });

    expect(mock.calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a timeout to NETWORK_ERROR with retryability', async () => {
    const cause = new Error('timed out');
    cause.name = 'TimeoutError';
    const mock = createMockFetch([
      {
        match: '/user',
        responses: [{ throws: cause }, { throws: cause }, { throws: cause }, { throws: cause }],
      },
    ]);
    const { client } = buildClient({ mock, timeoutMs: 20 });

    const error = await expectGitForgeError(client.request({ method: 'GET', path: '/user' }));

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('20ms');
  });
});

describe('error mapping', () => {
  it('maps 401 to AUTH_INVALID without retrying', async () => {
    const mock = createMockFetch([
      {
        match: '/user',
        responses: [jsonResponse({ message: 'Bad credentials' }, { status: 401 })],
      },
    ]);
    const { client } = buildClient({ mock, token: TOKEN });

    const error = await expectGitForgeError(client.request({ method: 'GET', path: '/user' }));

    expect(error.code).toBe('AUTH_INVALID');
    expect(error.status).toBe(401);
    expect(mock.calls).toHaveLength(1);
  });

  it('maps 404 to NOT_FOUND', async () => {
    const mock = createMockFetch([
      { match: '/repos', responses: [jsonResponse({ message: 'Not Found' }, { status: 404 })] },
    ]);
    const { client } = buildClient({ mock });

    const error = await expectGitForgeError(
      client.request({
        method: 'GET',
        path: '/repos/{owner}/{repo}',
        pathParams: { owner: 'org', repo: 'repo' },
      }),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
  });

  it('maps 422 to INVALID_ARGUMENT without retrying', async () => {
    const mock = createMockFetch([
      {
        match: '/issues',
        responses: [jsonResponse({ message: 'Validation Failed' }, { status: 422 })],
      },
    ]);
    const { client } = buildClient({ mock, token: TOKEN });

    const error = await expectGitForgeError(
      client.request({ method: 'POST', path: '/issues', body: { title: '' } }),
    );

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(mock.calls).toHaveLength(1);
  });

  it('maps GitHub 403 with a zero quota to RATE_LIMITED and retries', async () => {
    const mock = createMockFetch([
      {
        match: '/issues',
        responses: [
          jsonResponse(
            { message: 'API rate limit exceeded' },
            {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0', 'x-github-request-id': 'rid' },
            },
          ),
        ],
      },
    ]);
    const { client } = buildClient({ mock });

    const error = await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.requestId).toBe('rid');
    // Initial attempt + 3 retries.
    expect(mock.calls).toHaveLength(4);
  });

  it('maps AtomGit error_message + trace_id to PROVIDER_ERROR with requestId', async () => {
    const mock = createMockFetch([
      {
        match: '/repos',
        responses: [
          jsonResponse(
            {
              error_code: 404,
              error_code_name: 'UN_KNOW',
              error_message: 'Project not found',
              trace_id: 'trace-xyz',
            },
            { status: 404 },
          ),
        ],
      },
    ]);
    const { client } = buildClient({
      mock,
      provider: 'atomgit',
      baseUrl: 'https://api.atomgit.com/api/v5',
    });

    const error = await expectGitForgeError(
      client.request({
        method: 'GET',
        path: '/repos/{owner}/{repo}',
        pathParams: { owner: 'org', repo: 'repo' },
      }),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(error.requestId).toBe('trace-xyz');
    expect(error.provider).toBe('atomgit');
    expect(error.message).toContain('Project not found');
  });

  it('maps an unhandled 4xx such as 405 to PROVIDER_ERROR and keeps the status', async () => {
    const mock = createMockFetch([
      { match: '/merge', responses: [jsonResponse({ message: 'nope' }, { status: 405 })] },
    ]);
    const { client } = buildClient({ mock, token: TOKEN });

    const error = await expectGitForgeError(
      client.request({
        method: 'PUT',
        path: '/pulls/{number}/merge',
        pathParams: { number: '1' },
        body: {},
      }),
    );

    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.status).toBe(405);
    expect(error.retryable).toBe(false);
  });

  it('maps 5xx to PROVIDER_ERROR, retryable', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [jsonResponse({ message: 'boom' }, { status: 500 })] },
    ]);
    const { client } = buildClient({ mock });

    const error = await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));

    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.retryable).toBe(true);
    expect(mock.calls).toHaveLength(4);
  });

  it('never leaks the token through the message or JSON', async () => {
    const mock = createMockFetch([
      {
        match: '/issues',
        responses: [jsonResponse({ message: `token ${TOKEN} rejected` }, { status: 401 })],
      },
    ]);
    const { client } = buildClient({ mock, token: TOKEN, auth: { style: 'bearer' } });

    const error = await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));
    const serialized = `${JSON.stringify(error)}${error.stack ?? ''}${error.message}`;

    expect(serialized).not.toContain(TOKEN);
    expect(error.message).not.toMatch(/access_token=[^*]/);
  });

  it('does not put a concrete URL into the message', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [jsonResponse({ message: 'x' }, { status: 404 })] },
    ]);
    const { client } = buildClient({ mock, token: TOKEN });

    const error = await expectGitForgeError(
      client.request({
        method: 'GET',
        path: '/repos/{owner}/{repo}/issues',
        pathParams: { owner: 'example-org', repo: 'secret-repo' },
      }),
    );

    // The template is reported, not the concrete path.
    expect(error.message).toContain('/repos/{owner}/{repo}/issues');
  });

  it('treats a non-JSON error body as text and still maps the status', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [{ text: '<html>Bad Gateway</html>', status: 502 }] },
    ]);
    const { client } = buildClient({ mock });

    const error = await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));

    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.status).toBe(502);
  });
});

describe('retry behaviour', () => {
  it('makes 4 calls on repeated 429 and caps delays at 500/1000/2000', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [jsonResponse({ message: 'slow' }, { status: 429 })] },
    ]);
    const recorder = createRecordingSleep();
    const client = new HttpClient({
      baseUrl: 'https://api.github.com',
      provider: 'github',
      fetch: mock.fetch,
      sleep: recorder.sleep,
      // Deterministic maximum-ceiling jitter.
      random: () => 1,
    });

    const error = await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));

    expect(error.code).toBe('RATE_LIMITED');
    expect(mock.calls).toHaveLength(4);
    expect(recorder.delays).toEqual([500, 1_000, 2_000]);
    expect(recorder.delays.reduce((sum, value) => sum + value, 0)).toBe(3_500);
  });

  it('honours maxRetries: 1 with two total calls', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [jsonResponse({ message: 'slow' }, { status: 429 })] },
    ]);
    const recorder = createRecordingSleep();
    const client = new HttpClient({
      baseUrl: 'https://api.github.com',
      provider: 'github',
      fetch: mock.fetch,
      sleep: recorder.sleep,
      random: () => 1,
      retry: { maxRetries: 1 },
    });

    await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));

    expect(mock.calls).toHaveLength(2);
    expect(recorder.delays).toEqual([500]);
  });

  it('succeeds on a retry after a transient failure', async () => {
    const mock = createMockFetch([
      {
        match: '/issues',
        responses: [
          jsonResponse({ message: 'boom' }, { status: 503 }),
          jsonResponse([{ number: '1' }], { status: 200 }),
        ],
      },
    ]);
    const { client } = buildClient({ mock });

    const response = await client.request<{ number: string }[]>({ method: 'GET', path: '/issues' });

    expect(response.json).toEqual([{ number: '1' }]);
    expect(mock.calls).toHaveLength(2);
  });

  const now = Date.UTC(2030, 0, 1);
  const reset = String((now + 5_000) / 1_000);

  it.each([
    ['delta-seconds', 429, { 'retry-after': '5' }, 5_000],
    ['HTTP-date', 503, { 'retry-after': new Date(now + 5_000).toUTCString() }, 5_000],
    ['exhausted quota', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, 5_000],
    ['ordinary reset', 503, { 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': reset }, 250],
    [
      'unrelated server error',
      503,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      250,
    ],
    ['invalid hint', 503, { 'retry-after': '1.5' }, 250],
  ] as const)('schedules the next GET correctly for %s', async (_case, status, headers, delay) => {
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed);
    try {
      const mock = createMockFetch([
        {
          match: '/issues',
          responses: [jsonResponse({}, { status, headers }), jsonResponse(['ok'])],
        },
      ]);
      const attempts: number[] = [];
      const { client } = buildClient({
        mock,
        random: () => 0.5,
        retry: { maxRetryAfterMs: 5_000 },
        fetch: (input, init) => {
          attempts.push(elapsed);
          return mock.fetch(input, init);
        },
        sleep: (ms) => {
          elapsed += ms;
          return Promise.resolve();
        },
      });
      expect((await client.request({ method: 'GET', path: '/issues' })).json).toEqual(['ok']);
      expect(attempts).toEqual([0, delay]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['6', new Date(now + 6_000).toUTCString()])(
    'returns the original failure for over-budget hint %s',
    async (hint) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const mock = createMockFetch([
          {
            match: '/issues',
            responses: [
              jsonResponse(
                {},
                {
                  status: 429,
                  headers: { 'retry-after': hint, 'x-github-request-id': 'sample-id' },
                },
              ),
              jsonResponse(['unexpected retry']),
            ],
          },
        ]);
        const { client, delays } = buildClient({
          mock,
          random: () => 0.5,
          retry: { maxRetryAfterMs: 5_000 },
        });
        const error = await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));
        expect(error.toJSON()).toMatchObject({
          code: 'RATE_LIMITED',
          status: 429,
          provider: 'github',
          requestId: 'sample-id',
        });
        expect(mock.calls).toHaveLength(1);
        expect(delays).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('does not retry a write by default, even with Retry-After', async () => {
    const mock = createMockFetch([
      {
        match: '/issues',
        responses: [
          jsonResponse({ message: 'boom' }, { status: 503, headers: { 'retry-after': '5' } }),
        ],
      },
    ]);
    const { client, delays } = buildClient({ mock, token: TOKEN });

    const error = await expectGitForgeError(
      client.request({ method: 'POST', path: '/issues', body: { title: 'x' } }),
    );

    expect(error.status).toBe(503);
    expect(mock.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('retries a write when explicitly enabled', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [jsonResponse({ message: 'boom' }, { status: 503 })] },
    ]);
    const recorder = createRecordingSleep();
    const client = new HttpClient({
      baseUrl: 'https://api.github.com',
      provider: 'github',
      token: TOKEN,
      fetch: mock.fetch,
      sleep: recorder.sleep,
      random: () => 1,
      retry: { writes: true, maxRetries: 2 },
    });

    await expectGitForgeError(
      client.request({ method: 'POST', path: '/issues', body: { title: 'x' } }),
    );

    expect(mock.calls).toHaveLength(3);
  });

  it('records a deterministic delay sequence from an injected random source', async () => {
    const mock = createMockFetch([
      { match: '/issues', responses: [jsonResponse({ message: 'slow' }, { status: 429 })] },
    ]);
    const recorder = createRecordingSleep();
    const client = new HttpClient({
      baseUrl: 'https://api.github.com',
      provider: 'github',
      fetch: mock.fetch,
      sleep: recorder.sleep,
      random: createSequenceRandom([0, 0.5, 1]),
    });

    await expectGitForgeError(client.request({ method: 'GET', path: '/issues' }));

    expect(recorder.delays).toEqual([0, 500, 2_000]);
  });
});

describe('describe', () => {
  it('renders the path template plus query parameters', () => {
    const mock = createMockFetch();
    const { client } = buildClient({ mock });

    expect(
      client.describe({
        method: 'GET',
        path: '/repos/{owner}/{repo}/issues',
        pathParams: { owner: 'o', repo: 'r' },
        query: { state: 'open' },
      }),
    ).toBe('https://api.github.com/repos/{owner}/{repo}/issues?state=open');
  });
});

describe('transport boundaries', () => {
  it.each([
    'https://forge.example.invalid/enterprise/api?flavor=oauth',
    'http://127.0.0.1:8123/api?flavor=oauth',
  ])('keeps the base, nested route and redirect policy at %s', async (baseUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }));
    const { client } = buildClient({ mock: createMockFetch(), fetch, baseUrl, token: TOKEN });
    await client.request({
      method: 'POST',
      path: '/repos/{owner}/heads/{branch}',
      pathParams: { owner: 'org', branch: 'feature/docs' },
      body: { name: 'draft' },
    });
    const [target, init] = fetch.mock.calls[0]!;
    const url = new URL(target instanceof Request ? target.url : target);
    expect(url.origin).toBe(new URL(baseUrl).origin);
    expect(url.pathname).toBe(`${new URL(baseUrl).pathname}/repos/org/heads/feature/docs`);
    expect(url.searchParams.get('flavor')).toBe('oauth');
    expect(init?.redirect).toBe('error');
  });

  it.each([
    ['/repos/{owner}', { owner: '.' }],
    ['/repos/{repo}', { repo: 'two/segments' }],
    ['/issues/{number}', { number: '..' }],
    ['/contents/{path}', { path: 'a/./b' }],
    ['not-absolute', {}],
  ] as const)('rejects malformed route %s locally', async (path, pathParams) => {
    const mock = createMockFetch();
    const { client } = buildClient({ mock, token: TOKEN });
    await expect(client.request({ method: 'GET', path, pathParams })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it.each(['header', 'trace'])('bounds and scrubs diagnostic fields from %s', async (source) => {
    const id = TOKEN + 'x'.repeat(300);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json(
          { message: TOKEN, trace_id: id },
          { status: 401, headers: source === 'header' ? { 'x-request-id': id } : {} },
        ),
      );
    const { client } = buildClient({
      mock: createMockFetch(),
      fetch,
      token: TOKEN,
      auth: { style: 'query', param: 'credential' },
    });
    const spec = { method: 'GET', path: '/issues' } as const;
    expect(client.describe(spec)).toContain('credential=***');
    const error = await expectGitForgeError(client.request(spec));
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(error.requestId).toMatch(/^\*\*\*/);
    expect(error.requestId!.length).toBeLessThan(140);
  });

  it.each([
    ['GET', 2, false],
    ['POST', 1, false],
    ['POST', 1, true],
  ] as const)(
    'normalizes interrupted %s bodies (%i attempts, writes=%s)',
    async (method, count, writes) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError(TOKEN));
              },
            }),
            { status: 200, headers: { 'x-request-id': 'body-id' } },
          ),
        ),
      );
      const { client } = buildClient({
        mock: createMockFetch(),
        fetch,
        retry: { maxRetries: 1, writes },
        token: TOKEN,
      });
      const error = await expectGitForgeError(client.request({ method, path: '/issues' }));
      expect(error.toJSON()).toMatchObject({
        code: 'NETWORK_ERROR',
        status: 200,
        requestId: 'body-id',
      });
      expect(String(error.cause)).not.toContain(TOKEN);
      expect(fetch).toHaveBeenCalledTimes(count);
    },
  );

  it('rejects non-JSON success but accepts a no-content response', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('not JSON', { headers: { 'x-request-id': 'format-id' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { client } = buildClient({ mock: createMockFetch(), fetch });
    await expect(client.request({ method: 'POST', path: '/issues' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 200,
      requestId: 'format-id',
    });
    expect((await client.request({ method: 'DELETE', path: '/item' })).status).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
