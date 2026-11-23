/**
 * MCP test harness.
 *
 * The server under test is the real one — `buildServer` — connected to a real
 * `Client` over `InMemoryTransport`. Only the transport is substituted, so what a
 * test observes is what a remote client would observe: same handshake, same
 * `tools/list`, same `tools/call` result shape.
 *
 * The transport is in-memory on purpose: no port, no fixture server, no flake,
 * and the suite stays inside the "no network in tests" rule.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { ServerConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { createMockFetch } from '../../../git-forge/test/helpers/mockFetch.js';
import type { MockFetch, MockRoute } from '../../../git-forge/test/helpers/mockFetch.js';

/** Fixture token, assembled at runtime so no literal looks like a credential. */
export const TEST_TOKEN = ['mcp', 'fixture', 'token'].join('-');

/** A connected client/server pair plus the mock backing the SDK. */
export interface McpHarness {
  client: Client;
  mock: MockFetch;
  /** Closes both ends; call in `afterEach`. */
  close(): Promise<void>;
}

/** Builds a configuration with all three providers configured. */
export function fullConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    tokens: { github: TEST_TOKEN, gitee: TEST_TOKEN, atomgit: TEST_TOKEN },
    readonly: false,
    configured: ['github', 'gitee', 'atomgit'],
    ...overrides,
  };
}

/** Builds a configuration with no tokens, as a fresh install would have. */
export function emptyConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { tokens: {}, readonly: false, configured: [], ...overrides };
}

/**
 * Wires a real client to a real server over an in-memory transport.
 *
 * Accepts a route table so a `tools/call` test can decide exactly what the
 * platform "returns" and then assert on the result and the recorded requests.
 */
export async function connect(
  config: ServerConfig = fullConfig(),
  routes: MockRoute[] = [],
): Promise<McpHarness> {
  const mock = createMockFetch(routes);
  const server = buildServer({ config, fetch: mock.fetch });
  const client = new Client({ name: 'git-forge-mcp-test', version: '0.0.0' });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    mock,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Reads the text payload of a tool result. */
export function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? '').join('\n');
}

/** Parses the JSON payload of a successful tool result. */
export function resultJson<T = unknown>(result: unknown): T {
  return JSON.parse(resultText(result)) as T;
}

/** Whether a tool result is flagged as an error. */
export function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** A minimal repository payload every adapter maps without extra fields. */
export const REPOSITORY = {
  id: 1,
  name: 'demo-kit',
  full_name: 'example-org/demo-kit',
  owner: { login: 'example-org' },
  namespace: { path: 'example-org' },
  html_url: 'https://example.com/example-org/demo-kit',
  web_url: 'https://example.com/example-org/demo-kit',
  private: false,
  public: true,
  default_branch: 'dev',
  description: 'demo',
};

/** A minimal issue payload. */
export const ISSUE = {
  number: 101,
  title: 'an issue',
  state: 'open',
  html_url: 'https://example.com/issues/101',
  labels: [],
  user: { login: 'tester' },
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

/** A minimal branch payload. */
export const BRANCH = { name: 'dev', commit: { sha: 'a'.repeat(40) } };
