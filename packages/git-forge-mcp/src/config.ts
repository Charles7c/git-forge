/**
 * Environment-derived configuration.
 *
 * This module is the only place that reads `process.env`: everything downstream
 * receives plain values, so a test can build a server without touching the
 * ambient environment.
 *
 * Two rules:
 *
 * 1. Token values are read here and handed straight to the SDK. They are never
 *    returned from an accessor, logged, or included in a status string — only
 *    the list of provider *names* is ever printable.
 * 2. A missing token is not an error. The server starts and answers `AUTH_MISSING`
 *    from the SDK on the first call for that provider, so one unconfigured
 *    platform does not disable the others.
 */
import type { Provider } from '@charles7c/git-forge';

/** Provider order used by every listing, banner and test. */
export const PROVIDERS: readonly Provider[] = ['github', 'gitee', 'atomgit'];

/** Environment variable that holds each provider's token. */
export const TOKEN_ENV_VARS: Readonly<Record<Provider, string>> = {
  github: 'GITHUB_TOKEN',
  gitee: 'GITEE_TOKEN',
  atomgit: 'ATOMGIT_TOKEN',
};

/** Environment variable that enables read-only mode when set to `1`. */
export const READONLY_ENV_VAR = 'GIT_FORGE_READONLY';

/** Configuration derived from the environment. */
export interface ServerConfig {
  /** Tokens by provider; a provider with no token is absent from the map. */
  tokens: Partial<Record<Provider, string>>;
  /** Whether write capabilities are blocked. */
  readonly: boolean;
  /** Providers that have a token, in {@link PROVIDERS} order. */
  configured: Provider[];
}

/**
 * Reads the environment into a configuration.
 *
 * An empty or whitespace-only token is treated as absent, so `GITEE_TOKEN=""`
 * behaves like an unset variable instead of producing `Authorization: Bearer `
 * and a confusing upstream 401.
 */
export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const tokens: Partial<Record<Provider, string>> = {};
  const configured: Provider[] = [];

  for (const provider of PROVIDERS) {
    const value = env[TOKEN_ENV_VARS[provider]];
    if (typeof value === 'string' && value.trim().length > 0) {
      tokens[provider] = value.trim();
      configured.push(provider);
    }
  }

  return {
    tokens,
    readonly: env[READONLY_ENV_VAR] === '1' || env.GITKIT_READONLY === '1',
    configured,
  };
}

/**
 * Describes the configuration for the startup banner.
 *
 * Only names appear: a token value must never reach a log line, and this string
 * is the one thing this package prints.
 */
export function describeConfig(config: ServerConfig): string {
  const providers = config.configured.length > 0 ? config.configured.join(', ') : 'none';
  return `providers configured: ${providers} | readonly: ${config.readonly ? 'on' : 'off'}`;
}
