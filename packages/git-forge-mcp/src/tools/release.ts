/**
 * Release tools: list releases.
 *
 * The SDK models only the fields every platform can answer, so the description
 * states the per-platform gap instead of advertising a uniform result: Gitee and
 * AtomGit report a creation time where GitHub reports a publication time, and
 * only GitHub carries a release URL and a draft flag.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { wrap } from '../errors.js';
import type { ToolContext } from './index.js';
import { composeDescription, platformSummary, LISTING_NOTE } from './descriptions.js';
import { maxPagesSchema, repoSchemas } from './schemas.js';

/** Registers the release tools. */
export function registerReleaseTools(server: McpServer, ctx: ToolContext): void {
  const { snapshot } = ctx;

  server.registerTool(
    'git_list_releases',
    {
      title: 'List releases',
      description: composeDescription({
        summary:
          'Lists releases, newest first. `published_at` is a real publication time on ' +
          'GitHub and a creation time on Gitee and AtomGit; `html_url` and `draft` ' +
          'exist on GitHub only, and are omitted rather than guessed elsewhere.',
        platforms: platformSummary(snapshot, 'releases.list'),
        notes: [
          LISTING_NOTE,
          'Gitee and AtomGit release pages are not addressable by a derived URL, so no URL is invented.',
        ],
      }),
      inputSchema: {
        ...repoSchemas,
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listReleases({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          maxPages: args.maxPages,
        }),
      ),
  );
}
