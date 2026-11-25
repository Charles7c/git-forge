/**
 * Repository tools: list / get / create and the file reader.
 *
 * `git_get_file_contents` belongs here because the SDK serves it from
 * `RepositoryDomain`; the write tools live in `files.ts` so the read/write split
 * matches the capability split.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { wrap } from '../errors.js';
import type { ToolContext } from './index.js';
import { composeDescription, platformSummary, LISTING_NOTE, WRITE_NOTE } from './descriptions.js';
import { maxPagesSchema, pathSchema, refSchema, repoSchemas, z } from './schemas.js';

/** Registers the four repository tools. */
export function registerRepositoryTools(server: McpServer, ctx: ToolContext): void {
  const { snapshot } = ctx;

  server.registerTool(
    'git_list_repositories',
    {
      title: 'List repositories',
      description: composeDescription({
        summary:
          'Lists repositories. Pass `org` or `user` to scope the listing; omit both to ' +
          'list the authenticated account\u2019s repositories.',
        platforms: platformSummary(snapshot, 'repos.list'),
        notes: [LISTING_NOTE],
      }),
      inputSchema: {
        provider: repoSchemas.provider,
        org: z.string().min(1).optional().describe('Organization login.'),
        user: z.string().min(1).optional().describe('User login.'),
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listRepositories({
          provider: args.provider,
          org: args.org,
          user: args.user,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_get_repository',
    {
      title: 'Get repository',
      description: composeDescription({
        summary:
          'Reads one repository. `html_url` is always a web URL: a clone suffix is ' +
          'stripped where present, and the platform\u2019s own web URL is used where the ' +
          'primary field is null.',
        platforms: platformSummary(snapshot, 'repos.get'),
      }),
      inputSchema: { ...repoSchemas },
    },
    (args) =>
      wrap(() =>
        ctx.client.getRepository({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
        }),
      ),
  );

  server.registerTool(
    'git_create_repository',
    {
      title: 'Create repository',
      description: composeDescription(
        {
          summary: 'Creates a repository. `name` is required; pass `org` to create it there.',
          platforms: platformSummary(snapshot, 'repos.create'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        provider: repoSchemas.provider,
        name: z.string().min(1).describe('Repository name.'),
        description: z.string().optional().describe('Repository description.'),
        private: z.boolean().optional().describe('Create as private.'),
        org: z.string().min(1).optional().describe('Create inside this organization.'),
        auto_init: z.boolean().optional().describe('Initialise with a README.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createRepository({
          provider: args.provider,
          name: args.name,
          description: args.description,
          private: args.private,
          org: args.org,
          auto_init: args.auto_init,
        }),
      ),
  );

  server.registerTool(
    'git_list_stargazers',
    {
      title: 'List stargazers',
      description: composeDescription({
        summary:
          'Lists stargazers. `timestamps: true` asks for `starred_at`, which only GitHub ' +
          '(via a media type) and AtomGit can answer, so it is refused elsewhere rather ' +
          'than returning rows without the field. Gitee cannot list stargazers at all: its ' +
          'endpoint answers an empty array for every repository, so it is declared unsupported.',
        platforms: platformSummary(snapshot, 'repos.listStargazers'),
        notes: [
          LISTING_NOTE,
          'Use the repository\u2019s stargazers_count for a current total; this list is for surviving stars, not net growth.',
        ],
      }),
      inputSchema: {
        ...repoSchemas,
        timestamps: z.boolean().optional().describe('Ask for the time each star was added.'),
        maxPages: maxPagesSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.listStargazers({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          timestamps: args.timestamps,
          maxPages: args.maxPages,
        }),
      ),
  );

  server.registerTool(
    'git_get_file_contents',
    {
      title: 'Get file contents',
      description: composeDescription({
        summary:
          'Reads one file. `content` keeps the platform\u2019s encoding (base64). A ' +
          'directory path is refused: this SDK reads single files only.',
        platforms: platformSummary(snapshot, 'repos.getFileContents'),
        notes: [
          'A missing path is not uniform: Gitee answers 200 with an empty array, ' +
            'GitHub and AtomGit answer 404. The adapter normalizes both to a typed error.',
        ],
      }),
      inputSchema: {
        ...repoSchemas,
        path: pathSchema,
        ref: refSchema.optional().describe('Branch, tag or commit to read from.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.getFileContents({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          path: args.path,
          ref: args.ref,
        }),
      ),
  );
}
