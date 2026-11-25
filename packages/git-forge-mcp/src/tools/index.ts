/**
 * Tool registry: the one place a tool group is added.
 *
 * Each domain module registers its own tools against the shared
 * {@link ToolContext}, so adding a domain is one import plus one call here, and
 * no module needs to know about the others.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { GitClient } from '@charles7c/git-forge';

import { registerBranchCommitTools } from './branch-commit.js';
import { registerFileTools } from './files.js';
import { registerIssueTools } from './issue.js';
import { registerLabelTools } from './label.js';
import { registerPullRequestTools } from './pull-request.js';
import { registerReleaseTools } from './release.js';
import { registerRepositoryTools } from './repository.js';
import type { CapabilitySnapshot } from './descriptions.js';

/** Everything a tool handler needs, resolved once per server. */
export interface ToolContext {
  /** The SDK facade; the only path to a platform. */
  client: GitClient;
  /** Per-provider capability tables, used to generate descriptions. */
  snapshot: CapabilitySnapshot;
  /**
   * Whether write tools are blocked.
   *
   * Read only to choose the description suffix; the *enforcement* is the SDK's
   * `readonly` flag on `client`, never a check here.
   */
  readonly: boolean;
}

/** A registered tool name paired with the capability it consumes. */
export interface ToolRegistryEntry {
  name: string;
  /** Capability the tool exercises, used to decide the read-only annotation. */
  capability: string;
}

/**
 * The 29 tools, in registration order.
 *
 * Exported so a test can assert the published list without duplicating it. The
 * tool count trails the capability count in two places: `git_create_or_update_file`
 * covers both `files.create` and `files.update`, and `git_ensure_label` is a
 * facade-side composition over `labels.list` + `labels.create` rather than a
 * capability of its own.
 */
export const TOOL_NAMES: readonly string[] = [
  'git_list_issues',
  'git_get_issue',
  'git_create_issue',
  'git_update_issue',
  'git_list_issue_comments',
  'git_create_issue_comment',
  'git_list_issue_events',
  'git_list_pull_requests',
  'git_get_pull_request',
  'git_create_pull_request',
  'git_merge_pull_request',
  'git_list_pull_request_comments',
  'git_create_pull_request_comment',
  'git_list_repositories',
  'git_get_repository',
  'git_create_repository',
  'git_list_stargazers',
  'git_get_file_contents',
  'git_create_or_update_file',
  'git_delete_file',
  'git_push_files',
  'git_list_branches',
  'git_create_branch',
  'git_list_commits',
  'git_get_commit',
  'git_list_releases',
  'git_list_labels',
  'git_create_label',
  'git_ensure_label',
];

/** Registers every tool group against one server. */
export function registerAll(server: McpServer, ctx: ToolContext): void {
  registerIssueTools(server, ctx);
  registerPullRequestTools(server, ctx);
  registerRepositoryTools(server, ctx);
  registerFileTools(server, ctx);
  registerBranchCommitTools(server, ctx);
  registerReleaseTools(server, ctx);
  registerLabelTools(server, ctx);
}
