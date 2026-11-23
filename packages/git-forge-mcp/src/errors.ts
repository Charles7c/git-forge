/**
 * Error rendering for MCP tool results.
 *
 * An MCP tool failure is not a protocol error: it is a *successful* JSON-RPC
 * response carrying `isError: true` and a text payload the model can read. So
 * every failure path funnels through {@link toToolResult}, which guarantees:
 *
 * - the tool never rejects (an unhandled rejection would kill the process or
 *   leave the client waiting);
 * - a `GitForgeError` keeps its `code` and provider context in the text, since
 *   those are what the model needs to decide whether to retry, ask for a token,
 *   or give up;
 * - an unexpected error is reported as `INTERNAL` without emitting untrusted details.
 */
import { isGitForgeError } from '@charles7c/git-forge';
import type { GitForgeError } from '@charles7c/git-forge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A content block in an MCP tool result. */
export interface ToolTextContent {
  type: 'text';
  text: string;
}

/**
 * The shape an MCP tool handler returns.
 *
 * Typed as the protocol's own `CallToolResult` so a handler's return value is
 * checked against the schema the client will parse, rather than against a local
 * approximation of it.
 */
export type ToolResult = CallToolResult & { content: ToolTextContent[] };

/** Renders a value as pretty-printed JSON. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // A cyclic or otherwise unserializable value must not break the tool.
    return String(value);
  }
}

/**
 * Wraps a successful value in MCP result shape.
 *
 * The payload is JSON rather than prose so the model receives the same field
 * names the SDK documents, and so a client can parse it mechanically.
 */
export function toToolResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: stringify(value) }] };
}

/** Environment variable that supplies each provider's token, for the error hint. */
const TOKEN_ENV_VARS: Readonly<Record<string, string>> = {
  github: 'GITHUB_TOKEN',
  gitee: 'GITEE_TOKEN',
  atomgit: 'ATOMGIT_TOKEN',
};

/**
 * Renders a `GitForgeError` as one line of text.
 *
 * Format: `[CODE] provider=<p> — <message>` plus optional `status`, `requestId`
 * and `capability` segments. The leading bracketed code is what the tests and
 * the model key on.
 *
 * `AUTH_MISSING` gets one extra sentence. The SDK's message says "set the
 * variable and retry", which is right for a library caller; an MCP client cannot
 * retry its way out, because the token is read once at startup. So the server —
 * the only layer that knows a process is involved — appends the restart advice.
 */
export function formatError(error: GitForgeError): string {
  const parts: string[] = [`[${error.code}]`];
  if (error.provider !== undefined) {
    parts.push(`provider=${error.provider}`);
  }
  parts.push(`— ${error.message}`);

  const details: string[] = [];
  if (error.status !== undefined) {
    details.push(`status=${error.status}`);
  }
  if (error.requestId !== undefined) {
    details.push(`requestId=${error.requestId}`);
  }
  if (error.capability !== undefined) {
    details.push(`capability=${error.capability}`);
  }
  if (error.retryable) {
    details.push('retryable=true');
  }
  if (details.length > 0) {
    parts.push(`(${details.join(', ')})`);
  }

  const hint = restartHint(error);
  if (hint !== undefined) {
    parts.push(hint);
  }
  return parts.join(' ');
}

/** Builds the restart guidance an MCP caller needs for a missing token. */
function restartHint(error: GitForgeError): string | undefined {
  if (error.code !== 'AUTH_MISSING' || error.provider === undefined) {
    return undefined;
  }
  const envVar = TOKEN_ENV_VARS[error.provider];
  if (envVar === undefined) {
    return undefined;
  }
  return `Set ${envVar} and restart the server.`;
}

/**
 * Turns any thrown value into an MCP error result.
 *
 * Never print an unexpected exception: even its name, stack or cause may contain credentials.
 */
export function toErrorResult(error: unknown): ToolResult {
  if (isGitForgeError(error)) {
    return { isError: true, content: [{ type: 'text', text: formatError(error) }] };
  }

  const kind = error instanceof TypeError ? 'TypeError' : 'internal failure';
  return {
    isError: true,
    content: [{ type: 'text', text: `[INTERNAL] Unexpected error (${kind})` }],
  };
}

/**
 * Runs a handler and normalizes both outcomes into an MCP result.
 *
 * Every tool body is wrapped in this, which is what makes "a tool error never
 * produces an unhandled rejection" a property of the server rather than of each
 * handler's discipline.
 */
export async function wrap<T>(run: () => Promise<T>): Promise<ToolResult> {
  try {
    return toToolResult(await run());
  } catch (error) {
    return toErrorResult(error);
  }
}
