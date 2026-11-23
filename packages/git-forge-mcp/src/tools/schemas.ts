/**
 * Shared zod fragments for tool input schemas.
 *
 * Every schema mirrors an SDK input type. Where the two could drift — the
 * provider enum, the encoding set, the action set — the runtime list is imported
 * from the SDK, so adding a platform to `PROVIDERS` updates the tool schemas
 * without touching this file.
 */
import { PARAM_CAPABILITY_IDS, PROVIDERS } from '@charles7c/git-forge';
import { z } from 'zod';

/**
 * The three supported platforms, from the SDK's runtime constant.
 *
 * Passed as the tuple itself rather than a spread copy so zod infers the literal
 * union, which is what makes `args.provider` narrow to `Provider` at the call
 * site instead of a bare `string`.
 */
export const providerSchema = z.enum(PROVIDERS);

/** Owner login, a single path segment. */
export const ownerSchema = z.string().min(1).describe('Repository owner (user or organization).');

/** Repository name. */
export const repoSchema = z.string().min(1).describe('Repository name (without the owner).');

/**
 * Native issue identifier.
 *
 * The string form preserves provider codes and leading zeroes; numeric inputs
 * remain valid for callers using integer issue numbers.
 */
export const issueNumberSchema = z
  .union([z.string().min(1), z.number().int()])
  .describe('Issue id as the platform reports it: 42, "42" or "IEXA01".');

/** Pull-request number, always an integer on all three platforms. */
export const pullNumberSchema = z
  .number()
  .int()
  .positive()
  .describe('Pull-request number (integer on every platform).');

/** Repository reference shared by most tools. */
export const repoSchemas = {
  provider: providerSchema,
  owner: ownerSchema,
  repo: repoSchema,
} as const;

/** Page-limit override accepted by every list tool. */
export const maxPagesSchema = z
  .number()
  .int()
  .positive()
  .max(100)
  .optional()
  .describe('Maximum pages to fetch (default 10, hard cap 100).');

/** Label list, comma-joined on the wire by the adapters. */
export const labelsSchema = z
  .array(z.string().min(1))
  .optional()
  .describe('Label names. Sent comma-joined on the platforms that require it.');

/** File path inside the repository. */
export const pathSchema = z
  .string()
  .min(1)
  .describe('Repository-relative path, without a leading slash.');

/** Branch name, tag or commit sha. */
export const refSchema = z.string().min(1).describe('Branch name, tag or commit sha.');

/** Commit sha. */
export const shaSchema = z.string().min(1).describe('Commit or blob sha.');

/** Encoding of a file payload. */
export const encodingSchema = z
  .enum(['utf8', 'base64'])
  .optional()
  .describe("Encoding of `content` (default utf8). Gitee receives 'text' for utf8.");

/** `pushFiles` action: the closed three-value set, no upsert. */
export const pushActionSchema = z
  .enum(['create', 'update', 'delete'])
  .describe(
    'create | update | delete. No upsert: pass create for a new path, update for an existing one.',
  );

/** One `pushFiles` entry. */
export const pushFileSchema = z
  .object({
    path: pathSchema,
    action: pushActionSchema,
    content: z
      .string()
      .optional()
      .describe('Required for create/update; must be absent for delete.'),
    encoding: encodingSchema,
  })
  .describe('One file in the batch.');

/**
 * The parameter-capability ids, exposed for the tools that gate a filter.
 *
 * Imported rather than spelled out so a tool cannot gate on a capability the SDK
 * does not declare.
 */
export const PARAM_CAPABILITY_IDS_LIST = PARAM_CAPABILITY_IDS;

export { z };
