/**
 * Read-only policy, as the MCP server sees it.
 *
 * The server does not implement the block itself — that would duplicate a rule
 * the SDK already enforces, and the two copies could drift. This module only
 * annotates tool descriptions so clients can see the policy before issuing a write.
 * Either read-only environment switch enables the same SDK gate.
 *
 * Why the block lives in the SDK:
 *
 * - One implementation means the zero-HTTP guarantee is proven once and applies
 *   equally to SDK callers and to MCP clients.
 * - The gate sits before the HTTP layer, so "no request was sent" is structural
 *   rather than a convention.
 */
import { WRITE_CAPABILITIES } from '@charles7c/git-forge';
import type { CapabilityId } from '@charles7c/git-forge';

/** Suffix appended to a write tool's description while read-only is on. */
export const READONLY_TOOL_SUFFIX = '[blocked in readonly mode]';

/** Whether a capability mutates remote state. */
export function isWriteCapability(capability: CapabilityId): boolean {
  return WRITE_CAPABILITIES.has(capability);
}

/**
 * Returns the read-only annotation a tool description should carry.
 *
 * @param readonly Whether the server runs in read-only mode.
 * @param writes   Whether the tool performs a write.
 * @returns The suffix to append, or an empty string for a read tool or a
 *          writable server.
 */
export function readonlyAnnotation(readonly: boolean, writes: boolean): string {
  return readonly && writes ? ` ${READONLY_TOOL_SUFFIX}` : '';
}
