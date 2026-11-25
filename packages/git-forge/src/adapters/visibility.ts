/**
 * Repository visibility derivation shared by the three adapters.
 *
 * The platforms describe visibility in three different vocabularies:
 *
 * - GitHub sends `visibility: 'public' | 'private' | 'internal'` and also a
 *   `private` boolean.
 * - Gitee sends `private` and `public` booleans, both of which are usually
 *   present in repository payloads.
 * - AtomGit sends `private`, `public` and `internal` booleans; its repository
 *   object has no `visibility` field at all.
 *
 * Only an explicit statement counts as evidence. A payload with neither a
 * visibility string nor any boolean yields `unknown`, because "the field was not
 * sent" is not the same fact as "the repository is public" — treating the two as
 * one is how a read-only deployment ends up trusting a private source.
 */
import type { RepositoryVisibility } from '../core/types.js';

/** Visibility words the platforms use, mapped onto the contract vocabulary. */
const VISIBILITY_WORDS: Readonly<Record<string, RepositoryVisibility>> = {
  public: 'public',
  private: 'private',
  internal: 'internal',
};

/** Raw fields that may carry a visibility statement. */
export interface VisibilityFields {
  /** GitHub's `visibility`. Ignored on the other platforms. */
  visibility?: unknown;
  private?: unknown;
  public?: unknown;
  internal?: unknown;
}

/**
 * Reads a visibility flag that may arrive as a boolean or as `0`/`1`.
 *
 * AtomGit's OpenAPI declares `private` / `public` as integers in several
 * schemas while the live payloads send booleans, so both spellings are accepted
 * and every other value (a string, `null`, a missing key) yields `undefined` —
 * "no statement", never `false`.
 */
function flag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  return undefined;
}

/**
 * Derives a {@link RepositoryVisibility} from a raw repository payload.
 *
 * Precedence: an explicit `visibility` word wins, then an `internal` flag, then
 * an explicit `public: true`, then either private signal. Anything else is
 * `unknown`.
 *
 * **`private: false` alone is not a public statement.** GitHub Enterprise
 * `internal` repositories also report `private: false`, and a payload that omits
 * visibility entirely lands on the same value. Answering `public` for that input
 * is how a read-only deployment ends up trusting a repository it cannot actually
 * read anonymously, so only a field that names the fact — `visibility: 'public'`
 * or `public: true` — yields `public`.
 */
export function deriveVisibility(fields: VisibilityFields): RepositoryVisibility {
  if (typeof fields.visibility === 'string') {
    const word = VISIBILITY_WORDS[fields.visibility.toLowerCase()];
    if (word !== undefined) {
      return word;
    }
  }
  const isPrivate = flag(fields.private);
  const isPublic = flag(fields.public);
  // `internal` is its own answer on GitHub Enterprise and AtomGit; it must not
  // collapse into `private` or a caller testing for `public` would accept it.
  if (flag(fields.internal) === true) {
    return 'internal';
  }
  if (isPrivate === true || isPublic === false) {
    return 'private';
  }
  // Only a positive public statement counts. `private: false` is deliberately
  // absent here: it says "not private", which `internal` also satisfies.
  if (isPublic === true) {
    return 'public';
  }
  return 'unknown';
}

/**
 * Whether a payload stated that the repository is private.
 *
 * `Repository.private` predates `visibility`, so it keeps its boolean shape;
 * this helper is what makes it agree with {@link deriveVisibility} instead of
 * defaulting a missing field to `false`.
 */
export function isPrivateVisibility(visibility: RepositoryVisibility): boolean {
  return visibility === 'private' || visibility === 'internal';
}
