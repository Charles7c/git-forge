/**
 * Provider adapter registry.
 *
 * The facade resolves a provider to its adapter here, so this file is the single
 * place a new platform is added. Every entry is a `ProviderAdapter`, whose
 * capability table covers all 24 method-level capabilities by construction —
 * a provider with a gap declares it as `unsupported` and backs the method with
 * {@link unsupported}, never with a missing key.
 */
import type { Provider } from '../core/types.js';
import type { ProviderAdapter } from './types.js';
import { githubAdapter } from './github/adapter.js';
import { giteeAdapter } from './gitee/adapter.js';
import { atomgitAdapter } from './atomgit/adapter.js';

/** Every registered adapter, keyed by provider. */
export const ADAPTERS: Readonly<Record<Provider, ProviderAdapter>> = {
  github: githubAdapter,
  gitee: giteeAdapter,
  atomgit: atomgitAdapter,
};

/** Resolves the adapter for a provider. */
export function getAdapter(provider: Provider): ProviderAdapter {
  return ADAPTERS[provider];
}

export { githubAdapter, giteeAdapter, atomgitAdapter };
