/**
 * Issue tools: list / get / create / update and the comment pair.
 *
 * Each handler does exactly four things — zod has already validated, so it maps
 * arguments onto the SDK call, awaits it, and lets `wrap` turn the outcome into
 * an MCP result. No platform logic lives here: the facade and adapters own that.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { wrap } from '../errors.js';
import type { ToolContext } from './index.js';
import { composeDescription, platformSummary, LISTING_NOTE, WRITE_NOTE } from './descriptions.js';
import { issueNumberSchema, labelsSchema, maxPagesSchema, repoSchemas, z } from './schemas.js';

/** Registers the six issue tools. */
export function registerIssueTools(server: McpServer, ctx: ToolContext): void {
  const { snapshot } = ctx;

  server.registerTool(
    'git_list_issues',
    {
      title: 'List issues',
      description: composeDescription({
        summary:
          'Lists issues of a repository. Optional state, labels and milestone filters. ' +
          'Pull requests are excluded even where the platform serves both from one endpoint.',
        platforms: platformSummary(snapshot, 'issues.list'),
        notes: [LISTING_NOTE],
      }),
      inputSchema: {
        ...repoSchemas,
        state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter.'),
        labels: labelsSchema,
        milestone: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Milestone number. Gitee filters by title, so a number is refused there.'),
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listIssues({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          state: args.state,
          labels: args.labels,
          milestone: args.milestone,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_get_issue',
    {
      title: 'Get issue',
      description: composeDescription({
        summary:
          'Reads one issue by its platform id. Gitee ids can be codes such as `IEXA01`. ' +
          'The returned number is always a string; safe decimal ids also include number_as_number.',
        platforms: platformSummary(snapshot, 'issues.get'),
      }),
      inputSchema: {
        ...repoSchemas,
        number: issueNumberSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.getIssue({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
        }),
      ),
  );

  server.registerTool(
    'git_create_issue',
    {
      title: 'Create issue',
      description: composeDescription(
        {
          summary: 'Creates an issue. `title` is required and must not be empty.',
          platforms: platformSummary(snapshot, 'issues.create'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        title: z.string().min(1).describe('Issue title.'),
        body: z.string().optional().describe('Issue body (Markdown).'),
        labels: labelsSchema,
        milestone: z.number().int().positive().optional().describe('Milestone number.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createIssue({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          title: args.title,
          body: args.body,
          labels: args.labels,
          milestone: args.milestone,
        }),
      ),
  );

  server.registerTool(
    'git_update_issue',
    {
      title: 'Update issue',
      description: composeDescription(
        {
          summary:
            'Updates an issue. Omitted fields are left untouched; AtomGit receives its ' +
            '`close`/`reopen` state vocabulary instead of open/closed.',
          platforms: platformSummary(snapshot, 'issues.update'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        number: issueNumberSchema,
        title: z.string().min(1).optional().describe('New title.'),
        body: z.string().optional().describe('New body (Markdown).'),
        state: z.enum(['open', 'closed']).optional().describe('New state.'),
        labels: labelsSchema,
        milestone: z.number().int().positive().optional().describe('Milestone number.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.updateIssue({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
          title: args.title,
          body: args.body,
          state: args.state,
          labels: args.labels,
          milestone: args.milestone,
        }),
      ),
  );

  server.registerTool(
    'git_list_issue_comments',
    {
      title: 'List issue comments',
      description: composeDescription({
        summary:
          'Lists an issue\u2019s comments. `html_url` is absent where the platform does ' +
          'not provide one; it is never blanked or fabricated.',
        platforms: platformSummary(snapshot, 'issues.listComments'),
        notes: [LISTING_NOTE],
      }),
      inputSchema: {
        ...repoSchemas,
        number: issueNumberSchema,
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listIssueComments({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_create_issue_comment',
    {
      title: 'Create issue comment',
      description: composeDescription(
        {
          summary: 'Adds a comment to an issue.',
          platforms: platformSummary(snapshot, 'issues.createComment'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        number: issueNumberSchema,
        body: z.string().min(1).describe('Comment body (Markdown).'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createIssueComment({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
          body: args.body,
        }),
      ),
  );
}
