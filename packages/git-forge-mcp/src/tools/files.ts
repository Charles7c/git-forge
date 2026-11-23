/**
 * File tools: the four write capabilities.
 *
 * `git_create_or_update_file` is one tool over two capabilities
 * (`files.create` / `files.update`), which is why the 23 tools cover 24
 * capabilities. The SDK picks the endpoint from the presence of `sha`, and the
 * description says so, because a caller who omits `sha` on an existing file will
 * get an upstream rejection rather than a silent overwrite on Gitee.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { wrap } from '../errors.js';
import type { ToolContext } from './index.js';
import {
  composeDescription,
  platformSummary,
  pushFilesDescription,
  WRITE_NOTE,
} from './descriptions.js';
import {
  encodingSchema,
  pathSchema,
  pushFileSchema,
  repoSchemas,
  shaSchema,
  z,
} from './schemas.js';

/** Registers the four file tools. */
export function registerFileTools(server: McpServer, ctx: ToolContext): void {
  const { snapshot } = ctx;

  server.registerTool(
    'git_create_or_update_file',
    {
      title: 'Create or update file',
      description: composeDescription(
        {
          summary:
            'Creates or replaces one file in a single commit. Omit `sha` to create a new ' +
            'file; pass the current blob sha to replace an existing one. Content is ' +
            'expected in the encoding you declare (utf8 by default).',
          platforms:
            `${platformSummary(snapshot, 'files.create')} ` +
            `Updates: ${platformSummary(snapshot, 'files.update')}`,
          notes: [
            'The commit URL is derived where the platform omits it from the response.',
            WRITE_NOTE,
          ],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        path: pathSchema,
        content: z.string().describe('File content, in the declared encoding.'),
        message: z.string().min(1).describe('Commit message.'),
        branch: z
          .string()
          .min(1)
          .optional()
          .describe('Target branch (default: the default branch).'),
        sha: shaSchema
          .optional()
          .describe('Current blob sha; required to replace an existing file.'),
        encoding: encodingSchema,
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.createOrUpdateFile({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          path: args.path,
          content: args.content,
          message: args.message,
          branch: args.branch,
          sha: args.sha,
          encoding: args.encoding,
        }),
      ),
  );

  server.registerTool(
    'git_delete_file',
    {
      title: 'Delete file',
      description: composeDescription(
        {
          summary:
            'Deletes one file in a single commit. The current blob `sha` is required by ' +
            'every platform.',
          platforms: platformSummary(snapshot, 'files.delete'),
          notes: [WRITE_NOTE],
          writes: true,
        },
        ctx.readonly,
      ),
      inputSchema: {
        ...repoSchemas,
        path: pathSchema,
        message: z.string().min(1).describe('Commit message.'),
        sha: shaSchema.describe('Blob sha of the file being deleted.'),
        branch: z.string().min(1).optional().describe('Target branch.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.deleteFile({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          path: args.path,
          message: args.message,
          sha: args.sha,
          branch: args.branch,
        }),
      ),
  );

  server.registerTool(
    'git_push_files',
    {
      title: 'Push one or more files in one commit',
      // Derive platform support from the SDK so the tool advertises the same capabilities.
      description: pushFilesDescription(snapshot, ctx.readonly),
      inputSchema: {
        ...repoSchemas,
        branch: z.string().min(1).describe('Branch to commit onto.'),
        message: z.string().min(1).describe('Commit message for the single commit.'),
        files: z
          .array(pushFileSchema)
          .min(1)
          .describe('One or more batch entries. Deletes must not carry content.'),
      },
    },
    (args) =>
      wrap(() =>
        ctx.client.pushFiles({
          provider: args.provider,
          owner: args.owner,
          repo: args.repo,
          branch: args.branch,
          message: args.message,
          files: args.files,
        }),
      ),
  );
}
