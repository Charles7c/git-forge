/**
 * AtomGit response and parameter mapping.
 *
 * AtomGit is a Gitee-compatible API (`/api/v5`) with a few differences that all
 * land in this file:
 *
 * - `Repository.html_url` is `null`; `web_url` holds the web address and is used
 *   verbatim — no string building.
 * - `human_name` is a display name with spaces (`Example Organization / demo-kit`);
 *   `namespace.path` and `full_name` are the path-safe forms.
 * - Pull requests have a third state, `merged`, folded into `closed` + `merged`.
 * - Pull-request web URLs live under `/merge_requests/`; the raw value is kept
 *   because rewriting it to `/pulls/` would 404.
 * - Issue state updates use `close` / `reopen`, not `closed` / `open`.
 * - `labels` travel as a comma-joined string; issue filters use `milestone`
 *   while pull-request filters use `milestone_number`.
 * - Pull-request lists have no `head` filter at all.
 */
import { issueNumberFields } from '../../core/issue-number.js';
import { unsupportedCapabilityError } from '../../core/errors.js';
import type {
  Branch,
  Comment,
  Commit,
  CommitAuthor,
  FileContent,
  Issue,
  IssueState,
  Provider,
  PullRequest,
  PullRequestRef,
  PullRequestState,
  Repository,
  UserRef,
} from '../../core/types.js';

/** Provider label stamped on every mapped model. */
const PROVIDER: Provider = 'atomgit';

/* -------------------------------------------------------------------------- */
/* Raw-value narrowing                                                        */
/* -------------------------------------------------------------------------- */

/** Narrows an unknown value to a plain object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Narrows an unknown value to an array, or an empty array. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Reads a non-empty string, or `undefined`. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads a finite number, or `undefined`. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Renders a list key from an unknown field.
 *
 * Only strings and numbers have a meaningful string form; anything else
 * collapses to the empty string instead of the `[object Object]` that
 * `String()` would produce, which would merge unrelated rows in a dedupe map.
 */
export function listKey(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

/** Reads a boolean, or `undefined`. */
export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Shared field normalizations                                               */
/* -------------------------------------------------------------------------- */

/** Flattens AtomGit's `{name}[]` label objects into `string[]`. */
export function normalizeLabels(raw: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(raw)) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry);
      continue;
    }
    const name = str(asRecord(entry).name);
    if (name !== undefined) {
      out.push(name);
    }
  }
  return out;
}

/** Maps an AtomGit user object to the unified shape. */
export function mapUser(raw: unknown): UserRef | undefined {
  const record = asRecord(raw);
  const login = str(record.login);
  const name = str(record.name);
  if (login === undefined && name === undefined) {
    return undefined;
  }
  const user: UserRef = { login: login ?? (name as string) };
  if (name !== undefined) {
    user.name = name;
  }
  const avatar = str(record.avatar_url);
  if (avatar !== undefined) {
    user.avatar_url = avatar;
  }
  return user;
}

/** Maps a list of AtomGit users, dropping entries without a login. */
export function mapUsers(raw: unknown): UserRef[] | undefined {
  const users = asArray(raw)
    .map((entry) => mapUser(entry))
    .filter((entry): entry is UserRef => entry !== undefined);
  return users.length > 0 ? users : undefined;
}

/**
 * Folds an AtomGit issue state into the binary contract.
 *
 * AtomGit reports `open` / `closed`; an unknown value is treated as
 * closed so it cannot masquerade as active.
 */
export function mapIssueState(raw: unknown): IssueState {
  return raw === 'open' ? 'open' : 'closed';
}

/**
 * Folds AtomGit's three pull-request states into the binary contract.
 *
 * `merged` becomes `closed`; the caller reads `merged: true` for the distinction.
 */
export function mapPullRequestState(raw: unknown): PullRequestState {
  return raw === 'open' ? 'open' : 'closed';
}

/**
 * Translates a contract issue state into an AtomGit update value.
 *
 * The platform enum is `reopen` / `close`; forwarding `open` / `closed` is
 * either ignored or rejected.
 */
export function toAtomGitState(state: IssueState): 'reopen' | 'close' {
  return state === 'closed' ? 'close' : 'reopen';
}

/** Joins labels for an AtomGit write or list filter. */
export function joinLabels(labels: readonly string[] | undefined): string | undefined {
  return labels === undefined || labels.length === 0 ? undefined : labels.join(',');
}

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

/** Maps one AtomGit issue (or list entry) to the unified model. */
export function mapIssue(owner: string, repo: string, raw: unknown): Issue {
  const record = asRecord(raw);
  // AtomGit sends the issue number as a string; `iid` is the numeric echo.
  const issue: Issue = {
    provider: PROVIDER,
    owner,
    repo,
    ...issueNumberFields(listKey(record.number)),
    title: str(record.title) ?? '',
    state: mapIssueState(record.state),
    html_url: str(record.html_url) ?? '',
    labels: normalizeLabels(record.labels),
    created_at: str(record.created_at) ?? '',
    updated_at: str(record.updated_at) ?? '',
  };

  const body = str(record.body);
  if (body !== undefined) {
    issue.body = body;
  }
  const user = mapUser(record.user);
  if (user !== undefined) {
    issue.user = user;
  }
  const assignees = mapUsers(record.assignees);
  if (assignees !== undefined) {
    issue.assignees = assignees;
  }
  const comments = num(record.comments);
  if (comments !== undefined) {
    issue.comments_count = comments;
  }
  const closedAt = str(record.finished_at) ?? str(record.closed_at);
  if (closedAt !== undefined) {
    issue.closed_at = closedAt;
  }
  return issue;
}

/** Maps an AtomGit `{ref, sha}` branch reference, or `undefined`. */
export function mapRef(raw: unknown): PullRequestRef | undefined {
  const record = asRecord(raw);
  const ref = str(record.ref);
  const sha = str(record.sha);
  return ref !== undefined && sha !== undefined ? { ref, sha } : undefined;
}

/**
 * Maps one AtomGit pull request.
 *
 * `html_url` is kept verbatim: AtomGit serves pull requests at
 * `/merge_requests/<n>`, and rewriting that path would produce a 404.
 */
export function mapPullRequest(
  owner: string,
  repo: string,
  raw: unknown,
  base: PullRequestRef,
): PullRequest {
  const record = asRecord(raw);
  const rawState = str(record.state);
  const merged = rawState === 'merged' || str(record.merged_at) !== undefined;
  const draft: PullRequest = {
    base,
    provider: PROVIDER,
    owner,
    repo,
    number: num(record.number) ?? num(record.iid) ?? Number(str(record.number) ?? 0),
    title: str(record.title) ?? '',
    state: merged ? 'closed' : mapPullRequestState(rawState),
    merged,
    html_url: str(record.html_url) ?? '',
    created_at: str(record.created_at) ?? '',
    updated_at: str(record.updated_at) ?? '',
  };

  const head = mapRef(record.head);
  if (head !== undefined) {
    draft.head = head;
  }
  const mergedAt = str(record.merged_at);
  if (mergedAt !== undefined) {
    draft.merged_at = mergedAt;
  }
  const body = str(record.body);
  if (body !== undefined) {
    draft.body = body;
  }
  const isDraft = bool(record.draft);
  if (isDraft !== undefined) {
    draft.draft = isDraft;
  }
  const mergeable = bool(record.mergeable);
  if (mergeable !== undefined) {
    draft.mergeable = mergeable;
  }
  const user = mapUser(record.user);
  if (user !== undefined) {
    draft.user = user;
  }
  // AtomGit names the diff counters `added_lines` / `removed_lines`.
  const additions = num(record.additions) ?? num(record.added_lines);
  if (additions !== undefined) {
    draft.additions = additions;
  }
  const deletions = num(record.deletions) ?? num(record.removed_lines);
  if (deletions !== undefined) {
    draft.deletions = deletions;
  }
  const changedFiles = num(record.changed_files);
  if (changedFiles !== undefined) {
    draft.changed_files = changedFiles;
  }
  return draft;
}

/**
 * Maps one AtomGit repository.
 *
 * `html_url` is `null` on this platform, so `web_url` is used as-is. `web_url` is
 * a real web address, not something assembled here, which keeps the field honest
 * for forks and organizations alike.
 */
export function mapRepository(owner: string, repo: string, raw: unknown): Repository {
  const record = asRecord(raw);
  const htmlUrl = str(record.html_url) ?? str(record.web_url) ?? '';
  const repository: Repository = {
    provider: PROVIDER,
    // `namespace.path` is the path-safe owner; `human_name` has spaces.
    owner: str(asRecord(record.namespace).path) ?? owner,
    repo,
    name: str(record.name) ?? repo,
    html_url: htmlUrl,
    private: bool(record.private) === true || bool(record.public) === false,
    default_branch: str(record.default_branch) ?? '',
  };

  const fullName = str(record.full_name);
  if (fullName !== undefined) {
    repository.full_name = fullName;
  }
  const description = str(record.description);
  if (description !== undefined) {
    repository.description = description;
  }
  const fork = bool(record.fork);
  if (fork !== undefined) {
    repository.fork = fork;
  }
  const language = str(record.language);
  if (language !== undefined) {
    repository.language = language;
  }
  const createdAt = str(record.created_at);
  if (createdAt !== undefined) {
    repository.created_at = createdAt;
  }
  const updatedAt = str(record.updated_at);
  if (updatedAt !== undefined) {
    repository.updated_at = updatedAt;
  }
  return repository;
}

/** Maps one file-contents payload (always a single object). */
export function mapFileContent(owner: string, repo: string, raw: unknown): FileContent {
  const record = asRecord(raw);
  const content: FileContent = {
    provider: PROVIDER,
    owner,
    repo,
    path: str(record.path) ?? '',
    content: typeof record.content === 'string' ? record.content : '',
    encoding: str(record.encoding) ?? 'base64',
  };

  const sha = str(record.sha);
  if (sha !== undefined) {
    content.sha = sha;
  }
  const size = num(record.size);
  if (size !== undefined) {
    content.size = size;
  }
  const htmlUrl = str(record.html_url);
  if (htmlUrl !== undefined) {
    content.html_url = htmlUrl;
  }
  const type = str(record.type);
  if (type !== undefined) {
    content.type = type;
  }
  return content;
}

/** Derives `<webBase>/<owner>/<repo>/tree/<branch>` without any extra request. */
export function deriveBranchHtmlUrl(
  webBaseUrl: string,
  owner: string,
  repo: string,
  name: string,
): string | undefined {
  const base = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (base.length === 0) {
    return undefined;
  }
  return `${base}/${owner}/${repo}/tree/${name}`;
}

/** Maps one AtomGit branch entry. */
export function mapBranch(owner: string, repo: string, raw: unknown, webBaseUrl: string): Branch {
  const record = asRecord(raw);
  const name = str(record.name) ?? '';
  const branch: Branch = {
    provider: PROVIDER,
    owner,
    repo,
    name,
    commit_sha: str(asRecord(record.commit).sha) ?? '',
  };

  const isProtected = bool(record.protected);
  if (isProtected !== undefined) {
    branch.protected = isProtected;
  }
  const htmlUrl = deriveBranchHtmlUrl(webBaseUrl, owner, repo, name);
  if (htmlUrl !== undefined) {
    branch.html_url = htmlUrl;
  }
  return branch;
}

/** Maps commit authorship metadata. */
export function mapCommitAuthor(raw: unknown): CommitAuthor | undefined {
  const record = asRecord(raw);
  const name = str(record.name);
  if (name === undefined) {
    return undefined;
  }
  return {
    name,
    email: str(record.email) ?? '',
    date: str(record.date) ?? '',
  };
}

/** Maps one AtomGit commit. */
export function mapCommit(owner: string, repo: string, raw: unknown): Commit {
  const record = asRecord(raw);
  const payload = asRecord(record.commit);
  const commit: Commit = {
    provider: PROVIDER,
    owner,
    repo,
    sha: str(record.sha) ?? '',
    message: str(payload.message) ?? '',
    // AtomGit uses `/commits/detail/<sha>`; kept verbatim.
    html_url: str(record.html_url) ?? '',
  };

  const author = mapCommitAuthor(payload.author);
  if (author !== undefined) {
    commit.author = author;
  }
  const committer = mapCommitAuthor(payload.committer);
  if (committer !== undefined) {
    commit.committer = committer;
  }
  const parents = asArray(record.parents)
    .map((entry) => str(asRecord(entry).sha))
    .filter((entry): entry is string => entry !== undefined);
  if (parents.length > 0) {
    commit.parents = parents;
  }
  return commit;
}

/**
 * Maps one AtomGit comment.
 *
 * AtomGit comment payloads carry no `html_url`, so the
 * parent resource URL is used instead. No anchor is appended: the anchor scheme
 * for an individual comment is undocumented and a guess would 404.
 *
 * @param parentUrl Parent issue or pull-request web URL, already resolved.
 */
export function mapComment(
  owner: string,
  repo: string,
  raw: unknown,
  parentUrl: string | undefined,
): Comment {
  const record = asRecord(raw);
  const comment: Comment = {
    provider: PROVIDER,
    owner,
    repo,
    id: num(record.id) ?? Number(str(record.id) ?? 0),
    body: typeof record.body === 'string' ? record.body : '',
    created_at: str(record.created_at) ?? '',
  };

  const htmlUrl = str(record.html_url) ?? parentUrl;
  if (htmlUrl !== undefined && htmlUrl.length > 0) {
    comment.html_url = htmlUrl;
  }
  const updatedAt = str(record.updated_at);
  if (updatedAt !== undefined) {
    comment.updated_at = updatedAt;
  }
  const user = mapUser(record.user);
  if (user !== undefined) {
    comment.user = user;
  }
  return comment;
}

/** Derives the web URL of an issue or pull request for the comment fallback. */
export function deriveParentHtmlUrl(
  webBaseUrl: string,
  owner: string,
  repo: string,
  kind: 'issues' | 'merge_requests',
  number: string | number,
): string | undefined {
  const base = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (base.length === 0) {
    return undefined;
  }
  return `${base}/${owner}/${repo}/${kind}/${String(number)}`;
}

/**
 * Encodes a repository-relative path for a URL while keeping `/` as a segment
 * separator.
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Renders a value for an error message without echoing a payload. */
export function describeValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value.length === 0 ? 'an empty string' : `"${value}"`;
  }
  return typeof value;
}

/**
 * Raises `UNSUPPORTED_ON_PROVIDER` for AtomGit `head` filtering.
 *
 * Kept next to the mapping code because it encodes a platform fact: the
 * pull-request list endpoint has no `head` parameter, and substituting `base`
 * would answer a different question. The error is the capability error rather
 * than an argument error because the gap is the platform's, not the caller's.
 */
export function headFilterUnsupported(): never {
  throw unsupportedCapabilityError(PROVIDER, 'pulls.list.headFilter');
}
