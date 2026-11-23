/**
 * Facade test harness.
 *
 * A `GitClient` is built over a mock fetch, so a test can assert exactly what
 * left the facade (URL, method, headers, body) and, just as importantly, that a
 * refused call left nothing at all.
 */
import { GitClient } from '../../src/client.js';
import type { GitClientOptions } from '../../src/client.js';
import { createMockFetch } from './mockFetch.js';
import type { MockFetch, MockRoute } from './mockFetch.js';
import { TEST_TOKEN } from './expectError.js';

/** Base URLs the facade must default to. */
export const EXPECTED_BASE_URLS = {
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  atomgit: 'https://api.atomgit.com/api/v5',
} as const;

/** Web base URLs the facade derives `Branch.html_url` from. */
export const EXPECTED_WEB_BASE_URLS = {
  github: 'https://github.com',
  gitee: 'https://gitee.com',
  atomgit: 'https://atomgit.com',
} as const;

/** A client plus the mock backing it. */
export interface ClientHarness {
  client: GitClient;
  mock: MockFetch;
}

/**
 * Builds a client whose every provider has a token.
 *
 * Retries default to zero so an error-path test sees exactly one request; retry
 * behaviour belongs to `core` and is covered there.
 */
export function buildClient(
  options: GitClientOptions = {},
  routes: MockRoute[] = [],
): ClientHarness {
  const mock = createMockFetch(routes);
  const base: GitClientOptions = {
    github: { token: TEST_TOKEN, ...options.github },
    gitee: { token: TEST_TOKEN, ...options.gitee },
    atomgit: { token: TEST_TOKEN, ...options.atomgit },
    fetch: mock.fetch,
    sleep: () => Promise.resolve(),
    random: () => 0,
    retry: { maxRetries: 0 },
    ...options,
  };
  return { client: new GitClient(base), mock };
}

/**
 * Builds a client with no token for any provider.
 *
 * Used by the `AUTH_MISSING` cases: passing `undefined` explicitly keeps the
 * default token from being applied.
 */
export function buildTokenlessClient(
  options: Omit<GitClientOptions, 'github' | 'gitee' | 'atomgit'> = {},
  routes: MockRoute[] = [],
): ClientHarness {
  const mock = createMockFetch(routes);
  return {
    client: new GitClient({
      fetch: mock.fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      retry: { maxRetries: 0 },
      ...options,
    }),
    mock,
  };
}

/** The repository reference every fixture and route uses. */
export const REPO = { owner: 'example-org', repo: 'demo-kit' } as const;

/** Extracts the query string of the single recorded call. */
export function onlyCallQuery(mock: MockFetch): URLSearchParams {
  const call = mock.calls[0];
  if (call === undefined) {
    throw new Error('expected exactly one HTTP call, found none');
  }
  return new URL(call.url).searchParams;
}

/** Params of the first recorded call, as JSON. */
export function onlyCallJson(mock: MockFetch): Record<string, unknown> {
  const call = mock.calls[0];
  if (call === undefined) {
    throw new Error('expected exactly one HTTP call, found none');
  }
  return (call.json ?? {}) as Record<string, unknown>;
}
