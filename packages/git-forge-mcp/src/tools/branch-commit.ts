/**
 * Branch and commit tools.
 *
 * `git_create_branch` takes a source branch or sha; the adapters resolve a branch
 * name to a sha where the platform's endpoint needs one, so the tool stays a thin
 * mapping either way.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { wrap } from '../errors.js';
import type { ToolContext } from './index.js';
import { composeDescription, platformSummary, LISTING_NOTE, WRITE_NOTE } from './descriptions.js';
import { maxPagesSchema, repoSchemas, shaSchema, z } from './schemas.js';

/** Registers the four branch/commit tools. */
export function registerBranchCommitTools(server: McpServer, ctx: ToolContext): void {
  const { snapshot } = ctx;

  server.registerTool(
    'git_list_branches',
    {
      title: 'List branches',
      description: composeDescription({
        summary:
          'Lists branches. `html_url` is derived as `<web>/<owner>/<repo>/tree/<name>` ' +
          'because no platform returns one; deriving it costs no extra request.',
        platforms: platformSummary(snapshot, 'branches.list'),
        notes: [LISTING_NOTE],
      }),
      inputSchema: {
        ...repoSchemas,
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listBranches({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_create_branch',
    {
      title: 'Create branch',
      description: composeDescription(
        {
          summary: 'Creates a branch from a branch name or a commit sha.',
          platforms: platformSummary(snapshot, 'branches.create'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        name: z.string().min(1).describe('New branch name.'),
        from: z.string().min(1).describe('Source branch name or commit sha.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createBranch({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          name: args.name,
          from: args.from,
        }),
      ),
  );

  server.registerTool(
    'git_list_commits',
    {
      title: 'List commits',
      description: composeDescription({
        summary: 'Lists commits, optionally from a specific branch, tag or sha.',
        platforms: platformSummary(snapshot, 'commits.list'),
        notes: [LISTING_NOTE],
      }),
      inputSchema: {
        ...repoSchemas,
        branch: z.string().min(1).optional().describe('Branch, tag or sha to start from.'),
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listCommits({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          branch: args.branch,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_get_commit',
    {
      title: 'Get commit',
      description: composeDescription({
        summary: 'Reads one commit, including its author, committer and parents.',
        platforms: platformSummary(snapshot, 'commits.get'),
      }),
      inputSchema: {
        ...repoSchemas,
        sha: shaSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.getCommit({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          sha: args.sha,
        }),
      ),
  );
}
