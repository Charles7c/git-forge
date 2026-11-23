/**
 * Tool descriptions, generated from the capability tables.
 *
 * Hand-writing "GitHub: yes, Gitee: yes, AtomGit: no" twenty-three times is how
 * a capability matrix rots: the code changes, the prose does not. So every
 * platform claim in a tool description is derived here from the same
 * `CapabilityTable` / `ParamCapabilityTable` the facade enforces, and the tests
 * assert the generated substrings rather than a prose string.
 *
 * `git_push_files` is the case that made this necessary: AtomGit has no batch
 * commit, but Gitee does. A description saying only "AtomGit unsupported" would
 * hide a working capability from the model, so the generator lists all three
 * platforms for every capability it describes.
 */
import { CAPABILITY_IDS, PARAM_CAPABILITY_IDS, PROVIDERS } from '@charles7c/git-forge';
import type {
  CapabilityId,
  CapabilityState,
  CapabilityTable,
  ParamCapabilityId,
  ParamCapabilityTable,
  Provider,
} from '@charles7c/git-forge';

/**
 * Per-provider capability tables, read from the SDK facade.
 *
 * The MCP package may not import adapters directly, so the tables are obtained
 * through the public `GitClient` accessors. A client with no credentials still
 * answers capability queries — capabilities are static declarations, not
 * credential-dependent.
 */
export interface CapabilitySnapshot {
  capabilities: Readonly<Record<Provider, CapabilityTable>>;
  paramCapabilities: Readonly<Record<Provider, ParamCapabilityTable>>;
}

/** Builds a snapshot from the facade. */
export function snapshotFrom(client: {
  capabilities(provider: Provider): CapabilityTable;
  paramCapabilities(provider: Provider): ParamCapabilityTable;
}): CapabilitySnapshot {
  const capabilities = {} as Record<Provider, CapabilityTable>;
  const paramCapabilities = {} as Record<Provider, ParamCapabilityTable>;
  for (const provider of PROVIDERS) {
    capabilities[provider] = client.capabilities(provider);
    paramCapabilities[provider] = client.paramCapabilities(provider);
  }
  return { capabilities, paramCapabilities };
}

/** Human-facing platform labels, matching the vendor spelling. */
const PROVIDER_LABELS: Readonly<Record<Provider, string>> = {
  github: 'GitHub',
  gitee: 'Gitee',
  atomgit: 'AtomGit',
};

/**
 * How a supported state reads in prose.
 *
 * Callers may override the reason, because "supported" is not equally
 * informative for every capability: `pushFiles` is supported by a six-step chain
 * on one platform and a single request on another.
 */
export type SupportNote = string;

/** Renders one platform's line, e.g. `GitHub: supported`. */
function platformLine(
  provider: Provider,
  state: CapabilityState,
  supportedNote: SupportNote,
  unsupportedNote: string,
): string {
  const label = PROVIDER_LABELS[provider];
  return state === 'supported' ? `${label}: ${supportedNote}` : `${label}: ${unsupportedNote}`;
}

/**
 * Builds the platform paragraph for a method-level capability.
 *
 * @param snapshot Per-provider capability tables.
 * @param capability Capability the tool consumes.
 * @param supportedNote Phrase used for a supporting platform.
 * @param unsupportedNote Phrase used for a gapped platform. The default states
 *        that the capability is unavailable.
 */
export function platformSummary(
  snapshot: CapabilitySnapshot,
  capability: CapabilityId,
  supportedNote: SupportNote = 'supported',
  unsupportedNote = 'unsupported (verified)',
): string {
  return PROVIDERS.map((provider) =>
    platformLine(
      provider,
      snapshot.capabilities[provider][capability],
      supportedNote,
      unsupportedNote,
    ),
  ).join(' | ');
}

/** Builds the platform paragraph for a parameter-level capability. */
export function paramSummary(
  snapshot: CapabilitySnapshot,
  capability: ParamCapabilityId,
  supportedNote: SupportNote,
  unsupportedNote: string,
): string {
  return PROVIDERS.map((provider) =>
    platformLine(
      provider,
      snapshot.paramCapabilities[provider][capability],
      supportedNote,
      unsupportedNote,
    ),
  ).join(' | ');
}

/**
 * The rendered fragment for the AtomGit `head` gap.
 *
 * This fragment includes the platform label. The per-platform note passed to
 * {@link platformSummary} is the bare phrase, because that helper prefixes the
 * label itself.
 */
export const ATOMGIT_NO_HEAD_FILTER = 'AtomGit: no head filter';

/** Bare note rendered for a gapped head filter (the label is added by the caller). */
export const NO_HEAD_FILTER_NOTE = 'no head filter';

/**
 * The rendered fragment for a gapped `pushFiles`.
 *
 * Gitee's support is stated in the same breath; describing only the AtomGit gap
 * is the mistake this constant exists to prevent.
 */
export const PUSH_FILES_UNSUPPORTED = 'AtomGit: unsupported (verified)';

/** Bare note rendered for `pushFiles` where the batch is atomic. */
export const PUSH_FILES_SUPPORTED = 'supported (single commit)';

/** Bare note rendered where `pushFiles` is unavailable. */
export const PUSH_FILES_UNSUPPORTED_NOTE = 'unsupported (verified)';

/** One-line pagination/retry note appended to every list tool. */
export const LISTING_NOTE =
  'Lists auto-paginate (maxPages caps them) and retry rate limits with backoff.';

/** One-line note appended to every write tool. */
export const WRITE_NOTE = 'Writes are single-shot: no automatic retry on failure.';

/**
 * Suffix appended to a write tool's description while read-only mode is on.
 *
 * Composed at registration time from the server's `readonly` flag, so
 * `tools/list` advertises the block exactly when it applies. It is not a static
 * sentence: a description that always claims to be blocked would be wrong in the
 * default (writable) configuration.
 */
export const READONLY_TOOL_SUFFIX = '[blocked in readonly mode]';

/** Everything a tool description is assembled from. */
export interface DescriptionParts {
  /** What the tool does, in one sentence. */
  summary: string;
  /** Platform support sentence, from {@link platformSummary}. */
  platforms: string;
  /** Optional behavioural note (pagination, write semantics). */
  notes?: string[];
  /** Whether the tool mutates remote state; drives the read-only annotation. */
  writes?: boolean;
}

/**
 * Joins description parts into one MCP description string.
 *
 * The read-only annotation is appended here rather than passed in by each tool,
 * so every write tool advertises the block exactly when `readonly` is on and none
 * can forget to.
 *
 * @param parts    Description fragments.
 * @param readonly Whether the server runs in read-only mode.
 */
export function composeDescription(parts: DescriptionParts, readonly = false): string {
  const notes = [...(parts.notes ?? [])];
  if (readonly && parts.writes === true) {
    notes.push(READONLY_TOOL_SUFFIX);
  }
  return [parts.summary, parts.platforms, ...notes].join(' ');
}

/**
 * Builds the `git_push_files` description.
 *
 * Takes the snapshot so the platform sentence cannot drift: it is generated, not
 * typed. The regression this guards against is a description that mentions only
 * AtomGit and thereby hides Gitee's working single-commit batch.
 */
export function pushFilesDescription(snapshot: CapabilitySnapshot, readonly = false): string {
  const platforms = platformSummary(
    snapshot,
    'files.pushFiles',
    PUSH_FILES_SUPPORTED,
    PUSH_FILES_UNSUPPORTED_NOTE,
  );
  const atomic = paramSummary(
    snapshot,
    'files.pushFiles.atomic',
    'atomic',
    'not atomic (method unavailable)',
  );
  return composeDescription(
    {
      summary:
        'Commits every entry of a batch in one commit. Each entry has path, action ' +
        '(create | update | delete) and optional content plus encoding (utf8 | base64); ' +
        'an empty batch is rejected locally. There is no upsert: use create for a new ' +
        'path and update for an existing one.',
      platforms: `${platforms}. Atomicity: ${atomic}.`,
      notes: [WRITE_NOTE],
      writes: true,
    },
    readonly,
  );
}

/**
 * Builds the `git_list_pull_requests` description.
 *
 * The `head` filter is a parameter-level capability, so its per-platform state
 * comes from `ParamCapabilityTable`; AtomGit's gap is spelled out with the
 * wording the acceptance checklist names.
 */
export function listPullRequestsDescription(snapshot: CapabilitySnapshot): string {
  const head = paramSummary(
    snapshot,
    'pulls.list.headFilter',
    'head filter supported',
    NO_HEAD_FILTER_NOTE,
  );
  return composeDescription({
    summary:
      'Lists pull requests. Optional state, head, base, labels and milestone filters. ' +
      'A filter the platform does not implement is refused with ' +
      'UNSUPPORTED_ON_PROVIDER rather than silently ignored.',
    platforms: head,
    notes: [LISTING_NOTE],
  });
}

/** A capability matrix, rendered once for tools that summarize support. */
export function capabilityMatrix(snapshot: CapabilitySnapshot): string {
  return CAPABILITY_IDS.map((capability) => {
    const states = PROVIDERS.map(
      (provider) => `${PROVIDER_LABELS[provider]}=${snapshot.capabilities[provider][capability]}`,
    );
    return `${capability} (${states.join(', ')})`;
  }).join('; ');
}

/** The parameter capability matrix, for tools that expose a filter. */
export function paramMatrix(snapshot: CapabilitySnapshot): string {
  return PARAM_CAPABILITY_IDS.map((capability) => {
    const states = PROVIDERS.map(
      (provider) =>
        `${PROVIDER_LABELS[provider]}=${snapshot.paramCapabilities[provider][capability]}`,
    );
    return `${capability} (${states.join(', ')})`;
  }).join('; ');
}
