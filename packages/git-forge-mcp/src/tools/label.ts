/**
 * Label tools: list, create and ensure-exists.
 *
 * `git_ensure_label` is the tool the version-board workflow actually needs: a
 * version label has to exist before it can be written onto an issue, and doing
 * that by hand in three platform UIs is the friction the SDK removes. It composes
 * the two capabilities rather than adding a third, so the read-only gate applies
 * to it exactly as it does to `git_create_label`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { wrap } from '../errors.js';
import type { ToolContext } from './index.js';
import { composeDescription, platformSummary, LISTING_NOTE, WRITE_NOTE } from './descriptions.js';
import { maxPagesSchema, repoSchemas, z } from './schemas.js';

/** Registers the label tools. */
export function registerLabelTools(server: McpServer, ctx: ToolContext): void {
  const { snapshot } = ctx;

  server.registerTool(
    'git_list_labels',
    {
      title: 'List labels',
      description: composeDescription({
        summary:
          'Lists repository labels. `color` is always normalized to `#rrggbb`, whatever ' +
          'shape the platform sent.',
        platforms: platformSummary(snapshot, 'labels.list'),
        notes: [LISTING_NOTE],
      }),
      inputSchema: {
        ...repoSchemas,
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listLabels({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_create_label',
    {
      title: 'Create label',
      description: composeDescription(
        {
          summary:
            'Creates a repository label. `color` accepts 3- or 6-digit hex with or ' +
            'without `#` and is sent in the form each platform requires.',
          platforms: platformSummary(snapshot, 'labels.create'),
          notes: [
            WRITE_NOTE,
            'Gitee and AtomGit have no label description field: a description is accepted ' +
              'and dropped there, since their create body carries only name and color.',
          ],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        name: z.string().min(1).describe('Label name.'),
        color: z.string().min(3).describe('Hex colour, e.g. #d73a4a, d73a4a or f00.'),
        description: z.string().optional().describe('Label description (GitHub only).'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createLabel({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          name: args.name,
          color: args.color,
          description: args.description,
        }),
      ),
  );

  server.registerTool(
    'git_ensure_label',
    {
      title: 'Ensure label exists',
      description: composeDescription(
        {
          summary:
            'Returns the named label, creating it only when absent. Lists first, so an ' +
            'existing label keeps its colour and description untouched.',
          platforms: platformSummary(snapshot, 'labels.create'),
          notes: [
            'Reads the complete label list first (auto-paginated, capped by maxPages) and ' +
              'creates only when the name is provably absent. `color` is needed only for ' +
              'that create: omit it to check existence. A truncated listing is refused ' +
              'with PAGINATION_LIMIT rather than read as "absent".',
            WRITE_NOTE,
          ],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        name: z.string().min(1).describe('Label name to ensure.'),
        color: z
          .string()
          .min(3)
          .optional()
          .describe('Hex colour used only if the label has to be created.'),
        description: z
          .string()
          .optional()
          .describe('Description used only if the label has to be created (GitHub only).'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.ensureLabel({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          name: args.name,
          color: args.color,
          description: args.description,
        }),
      ),
  );
}
