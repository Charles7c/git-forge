/**
 * Commit-author assembly shared by the three adapters.
 *
 * The two halves come from different places and fail independently:
 *
 * - the **Git side** (`commit.author`) carries the name, email and date as
 *   recorded in the commit object, and may be partial;
 * - the **platform side** is the account the hosting service linked to that
 *   commit email, and is frequently absent.
 *
 * Deciding "is there an author at all" from the Git name alone is what drops a
 * legitimate attribution when a platform knows the account but the commit object
 * lacks a name (measured on AtomGit: several commits ship only `{email, date}`).
 * So either half alone is enough to produce the block.
 *
 * The reverse mistake is just as costly: a display name is **not** a login, so
 * it is never used to synthesise an account. That filtering happens where the
 * account object is read; this module only joins the two.
 */
import type { CommitAuthor, UserRef } from '../core/types.js';

/**
 * Joins the Git-side authorship with the linked account.
 *
 * @param gitAuthor Parsed `commit.author`, or `undefined` when it stated none of
 *                  name, email or date.
 * @param account   Linked platform account, already validated to have a `login`.
 * @returns The block, or `undefined` when neither half says anything.
 */
export function buildCommitAuthor(
  gitAuthor: CommitAuthor | undefined,
  account: UserRef | undefined,
): CommitAuthor | undefined {
  if (gitAuthor === undefined && account === undefined) {
    return undefined;
  }
  // An empty `name` means "the commit object did not record one"; it is left
  // empty rather than filled with the login, which is a different fact and is
  // already available as `user.login`.
  const author: CommitAuthor = gitAuthor ?? { name: '', email: '', date: '' };
  if (account !== undefined) {
    author.user = account;
  }
  return author;
}

/**
 * Reads `{ name, email, date }` from a Git author object.
 *
 * Any one of the three fields is enough to produce the block, because the two
 * mistakes here are not symmetric:
 *
 * - requiring a `name` drops an attribution the platform can still complete from
 *   the linked account (measured on AtomGit: commits shipping only
 *   `{ email, date }`), and with no block at all the email and date are lost;
 * - requiring a `date` (or a name) drops an email-only record, which is the one
 *   Git-side fact such a commit carries.
 *
 * A field the commit object did not state is left as an empty string rather than
 * filled with another field's value: `author.email` is the commit's own record,
 * and the account's email is a different fact that is not published on the model.
 * An empty `email` is therefore "not stated", never a claim.
 *
 * `undefined` is returned only when the object states none of the three.
 */
export function readGitAuthor(raw: Record<string, unknown>): CommitAuthor | undefined {
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined;
  const date = typeof raw.date === 'string' && raw.date.length > 0 ? raw.date : undefined;
  const email = typeof raw.email === 'string' && raw.email.length > 0 ? raw.email : undefined;
  if (name === undefined && date === undefined && email === undefined) {
    return undefined;
  }
  return {
    name: name ?? '',
    email: email ?? '',
    date: date ?? '',
  };
}
