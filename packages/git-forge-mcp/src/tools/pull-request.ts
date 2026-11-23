/**
 * Pull-request tools: list / get / create / merge and the comment pair.
 *
 * `git_list_pull_requests` uses the generated description so the AtomGit
 * head-filter gap is stated from `ParamCapabilityTable` rather than typed by hand.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { wrap } from '../errors.js';
import type { ToolContext } from './index.js';
import {
  composeDescription,
  listPullRequestsDescription,
  platformSummary,
  LISTING_NOTE,
  WRITE_NOTE,
} from './descriptions.js';
import { labelsSchema, maxPagesSchema, pullNumberSchema, repoSchemas, z } from './schemas.js';

/** Registers the six pull-request tools. */
export function registerPullRequestTools(server: McpServer, ctx: ToolContext): void {
  const { snapshot } = ctx;

  server.registerTool(
    'git_list_pull_requests',
    {
      title: 'List pull requests',
      description: listPullRequestsDescription(snapshot),
      inputSchema: {
        ...repoSchemas,
        state: z.enum(['open', 'closed', 'all']).optional().describe('Pull-request state filter.'),
        head: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Source-branch filter. Refused with UNSUPPORTED_ON_PROVIDER on AtomGit, ' +
              'which has no such parameter.',
          ),
        base: z.string().min(1).optional().describe('Target-branch filter.'),
        labels: labelsSchema,
        milestone: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Milestone number (sent as milestone_number where required).'),
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listPullRequests({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          state: args.state,
          head: args.head,
          base: args.base,
          labels: args.labels,
          milestone: args.milestone,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_get_pull_request',
    {
      title: 'Get pull request',
      description: composeDescription({
        summary:
          'Reads one pull request. Where the detail response omits `head`, it is ' +
          'backfilled from a single list call rather than left missing.',
        platforms: platformSummary(snapshot, 'pulls.get'),
      }),
      inputSchema: {
        ...repoSchemas,
        number: pullNumberSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.getPullRequest({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
        }),
      ),
  );

  server.registerTool(
    'git_create_pull_request',
    {
      title: 'Create pull request',
      description: composeDescription(
        {
          summary: 'Opens a pull request. `title`, `head` and `base` are required.',
          platforms: platformSummary(snapshot, 'pulls.create'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        title: z.string().min(1).describe('Pull-request title.'),
        head: z.string().min(1).describe('Source branch.'),
        base: z.string().min(1).describe('Target branch.'),
        body: z.string().optional().describe('Pull-request body (Markdown).'),
        draft: z.boolean().optional().describe('Open as a draft.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createPullRequest({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body,
          draft: args.draft,
        }),
      ),
  );

  server.registerTool(
    'git_merge_pull_request',
    {
      title: 'Merge pull request',
      description: composeDescription(
        {
          summary:
            'Merges a pull request and returns its post-merge state. The merge response ' +
            'describes the merge only, so the pull request is read back.',
          platforms: platformSummary(snapshot, 'pulls.merge'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        number: pullNumberSchema,
        merge_method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge strategy.'),
        commit_title: z.string().optional().describe('Title for the merge commit.'),
        commit_message: z.string().optional().describe('Message for the merge commit.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.mergePullRequest({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
          merge_method: args.merge_method,
          commit_title: args.commit_title,
          commit_message: args.commit_message,
        }),
      ),
  );

  server.registerTool(
    'git_list_pull_request_comments',
    {
      title: 'List pull-request comments',
      description: composeDescription({
        summary:
          'Lists a pull request\u2019s comments. `html_url` is absent where the platform ' +
          'does not provide one; it is never blanked or fabricated.',
        platforms: platformSummary(snapshot, 'pulls.listComments'),
        notes: [LISTING_NOTE],
      }),
      inputSchema: {
        ...repoSchemas,
        number: pullNumberSchema,
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listPullRequestComments({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_create_pull_request_comment',
    {
      title: 'Create pull-request comment',
      description: composeDescription(
        {
          summary: 'Adds a comment to a pull request.',
          platforms: platformSummary(snapshot, 'pulls.createComment'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        number: pullNumberSchema,
        body: z.string().min(1).describe('Comment body (Markdown).'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createPullRequestComment({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
          body: args.body,
        }),
      ),
  );
}
