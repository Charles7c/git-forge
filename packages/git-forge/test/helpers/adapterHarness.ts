/**
 * Shared adapter test harness.
 *
 * Adapters are pure functions of (context, params) once an `HttpClient` is
 * injected, so every test builds a context over a mock fetch and asserts on what
 * the adapter actually put on the wire.
 */
import { expect } from 'vitest';

import { HttpClient } from '../../src/core/http.js';
import { CAPABILITY_IDS, PARAM_CAPABILITY_IDS } from '../../src/core/types.js';
import type { CapabilityState, Provider } from '../../src/core/types.js';
import type { AdapterCtx, ProviderAdapter } from '../../src/adapters/types.js';
import { createMockFetch } from './mockFetch.js';
import type { MockFetch } from './mockFetch.js';

/** Base URLs used by each provider. */
export const BASE_URLS: Readonly<Record<Provider, string>> = {
  github: 'https://api.github.com',
  gitee: 'https://gitee.com/api/v5',
  atomgit: 'https://api.atomgit.com/api/v5',
};

/** Web base URLs derived from each API base, as the facade will supply them. */
export const WEB_BASE_URLS: Readonly<Record<Provider, string>> = {
  github: 'https://github.com',
  gitee: 'https://gitee.com',
  atomgit: 'https://atomgit.com',
};

/**
 * Fixture token, assembled at runtime so the literal never appears in source and
 * cannot be mistaken for a credential by a secret scanner.
 */
export const TEST_TOKEN = ['adapter', 'fixture', 'token'].join('-');

/** A build adapter context plus the mock that backs it. */
export interface Harness {
  ctx: AdapterCtx;
  mock: MockFetch;
}

/**
 * Builds an adapter context over a fresh mock.
 *
 * `retry.maxRetries` defaults to 0 so an error-path test sees exactly one
 * request; retry behaviour is `core`'s concern and is covered there.
 */
export function buildHarness(
  adapter: ProviderAdapter,
  options: { baseUrl?: string; webBaseUrl?: string; token?: string } = {},
): Harness {
  const mock = createMockFetch();
  return { ctx: buildCtx(adapter, mock, options), mock };
}

/** Builds a context around an existing mock, so routes can be set first. */
export function buildCtx(
  adapter: ProviderAdapter,
  mock: MockFetch,
  options: { baseUrl?: string; webBaseUrl?: string; token?: string } = {},
): AdapterCtx {
  const provider = adapter.provider;
  const http = new HttpClient({
    baseUrl: options.baseUrl ?? BASE_URLS[provider],
    provider,
    token: options.token ?? TEST_TOKEN,
    auth: { style: 'bearer' },
    fetch: mock.fetch,
    sleep: () => Promise.resolve(),
    random: () => 0,
    retry: { maxRetries: 0 },
  });
  return {
    http,
    caps: adapter.capabilities,
    paramCaps: adapter.paramCapabilities,
    webBaseUrl: options.webBaseUrl ?? WEB_BASE_URLS[provider],
  };
}

/** Asserts every method-level capability has an explicit state on a provider. */
export function expectCompleteCapabilityTable(adapter: ProviderAdapter): void {
  const keys = Object.keys(adapter.capabilities).sort();
  expect(keys).toEqual([...CAPABILITY_IDS].sort());
  const paramKeys = Object.keys(adapter.paramCapabilities).sort();
  expect(paramKeys).toEqual([...PARAM_CAPABILITY_IDS].sort());
}

/** Reads one capability state, failing if the key is missing entirely. */
export function capabilityState(adapter: ProviderAdapter, id: string): CapabilityState {
  const state = (adapter.capabilities as Record<string, CapabilityState | undefined>)[id];
  if (state === undefined) {
    throw new Error(`capability ${id} is absent from provider=${adapter.provider}`);
  }
  return state;
}

/** Reads one parameter-level capability state, failing if absent. */
export function paramCapabilityState(adapter: ProviderAdapter, id: string): CapabilityState {
  const state = (adapter.paramCapabilities as Record<string, CapabilityState | undefined>)[id];
  if (state === undefined) {
    throw new Error(`param capability ${id} is absent from provider=${adapter.provider}`);
  }
  return state;
}
