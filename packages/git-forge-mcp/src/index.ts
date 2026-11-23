/**
 * Entry point of the `git-forge-mcp` binary.
 *
 * This module owns the process: it reads the environment, prints the startup
 * banner to stderr (stdout carries the MCP protocol and must stay clean), attaches
 * the stdio transport and is the only place allowed to set an exit code.
 *
 * Everything else is imported so the binary stays testable: the server factory
 * takes a configuration, and the configuration is a plain value.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { describeConfig, readConfig } from './config.js';
import type { ServerConfig } from './config.js';
import { SERVER_NAME, SERVER_VERSION, buildServer } from './server.js';

/** Semantic version of this build. Kept in sync with `package.json`. */
export const VERSION = SERVER_VERSION;

/**
 * Renders the single startup line printed to stderr.
 *
 * Only provider *names* appear. A token value reaching this line would be a
 * credential leak into terminal scrollback and CI logs, so the formatter is
 * given `ServerConfig`, whose `configured` list holds names by construction.
 */
export function startupBanner(config: ServerConfig): string {
  return `${SERVER_NAME} ${SERVER_VERSION} | ${describeConfig(config)}`;
}

/**
 * Builds and starts a stdio server.
 *
 * @returns The connected server, so a caller can close it deterministically.
 */
export async function serveStdio(config: ServerConfig = readConfig(process.env)) {
  process.stderr.write(`${startupBanner(config)}\n`);

  const server = buildServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

/**
 * True when this module is the process entry point.
 *
 * Comparing URLs (not raw paths) is required on Windows, where `argv[1]` is a
 * `D:\...` path while `import.meta.url` is a `file:///D:/...` URL.
 */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  if (pathToFileURL(entry).href === import.meta.url) {
    return true;
  }
  // Package-manager bin shims can leave argv[1] linked while Node resolves the module.
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    // Imports from stdin or a synthetic launcher need not have an on-disk entry.
    return false;
  }
}

if (isDirectExecution()) {
  serveStdio().catch((error: unknown) => {
    // A startup failure means no client will ever get a response, so it is the
    // one place a stack trace on stderr is the right signal.
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[${SERVER_NAME}] failed to start: ${detail}\n`);
    process.exitCode = 1;
  });
}
