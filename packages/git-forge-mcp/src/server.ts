/**
 * MCP server assembly.
 *
 * `buildServer` is a pure factory: it takes a configuration, builds a
 * `GitClient`, registers the 23 tools and hands back the server. Nothing here
 * touches stdin/stdout, so a test can drive the same server over an in-memory
 * transport and observe exactly what a real client would.
 *
 * The three runtime responsibilities are deliberately separated:
 *
 * - `config.ts` reads the environment (the only module that does).
 * - `index.ts` owns the process: transport, banner, exit code.
 * - this module wires the two together and knows nothing about either's details.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '@charles7c/git-forge';

import type { ServerConfig } from './config.js';
import { PROVIDERS } from './config.js';
import { snapshotFrom } from './tools/descriptions.js';
import { registerAll } from './tools/index.js';

/** Server name advertised during the MCP handshake. */
export const SERVER_NAME = 'git-forge-mcp';

/** Server version advertised during the MCP handshake. */
export const SERVER_VERSION = '0.2.0';

/** Options for {@link buildServer}. */
export interface BuildServerOptions {
  /** Environment-derived configuration. */
  config: ServerConfig;
  /** Injected transport, so a test never reaches the network. */
  fetch?: typeof fetch;
}

/** Builds a fully-wired MCP server without attaching a transport. */
export function buildServer(options: BuildServerOptions): McpServer {
  const { config } = options;

  // One client for all three providers: the facade holds one HTTP client per
  // provider, so a token cannot cross platforms. Read-only is passed through —
  // the SDK enforces it, this package never re-implements the block.
  const client = new GitClient({
    github: { token: config.tokens.github },
    gitee: { token: config.tokens.gitee },
    atomgit: { token: config.tokens.atomgit },
    readonly: config.readonly,
    fetch: options.fetch,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAll(server, {
    client,
    snapshot: snapshotFrom(client),
    readonly: config.readonly,
  });
  return server;
}

/**
 * Builds the client a server would use, for callers that need it directly.
 *
 * Exported so a test can assert client-level facts (which providers are
 * configured) without reaching into the server's internals.
 */
export function buildClient(config: ServerConfig, fetchImpl?: typeof fetch): GitClient {
  return new GitClient({
    github: { token: config.tokens.github },
    gitee: { token: config.tokens.gitee },
    atomgit: { token: config.tokens.atomgit },
    readonly: config.readonly,
    fetch: fetchImpl,
  });
}

/** Renders the provider list for diagnostics. Names only — never token values. */
export function configuredProviderNames(config: ServerConfig): string {
  return config.configured.length > 0 ? config.configured.join(', ') : 'none';
}

/** Asserts the configuration names only real providers. */
export function assertKnownProviders(config: ServerConfig): void {
  for (const provider of config.configured) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`unknown provider in configuration: ${String(provider)}`);
    }
  }
}
