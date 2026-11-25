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
 * - Closed PRs include both `merged` and `locked`; only merge evidence sets `merged`.
 * - Pull-request web URLs live under `/merge_requests/`; the raw value is kept
 *   because rewriting it to `/pulls/` would 404.
 * - Issue state updates use `close` / `reopen`, not `closed` / `open`.
 * - `labels` travel as a comma-joined string; issue filters use `milestone`
 *   while pull-request filters use `milestone_number`.
 * - Pull-request lists have no `head` filter at all.
 */
import { issueNumberFields } from '../../core/issue-number.js';
import { unsupportedCapabilityError } from '../../core/errors.js';
import { normalizeLabelColor } from '../../core/validate.js';
import { buildCommitAuthor, readGitAuthor } from '../commit-author.js';
import { deriveVisibility, isPrivateVisibility } from '../visibility.js';
import type {
  Branch,
  Comment,
  Commit,
  CommitAuthor,
  FileContent,
  Issue,
  IssueEvent,
  IssueEventType,
  IssueState,
  Label,
  Provider,
  PullRequest,
  PullRequestRef,
  PullRequestState,
  Release,
  Repository,
  RepositoryVisibility,
  Stargazer,
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
 * Folds AtomGit's open, closed, merged and locked states into the binary contract.
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
  const nativeState = str(record.state);
  if (nativeState !== undefined) {
    issue.native_state = nativeState;
  }
  // `issue_state` is the workflow label (待办的 / …). Measured: issues with
  // `state: 'closed'` still report 待办的, so it is display text only.
  const stateLabel = str(record.issue_state) ?? str(asRecord(record.issue_state_detail).title);
  if (stateLabel !== undefined) {
    issue.state_label = stateLabel;
  }
  // AtomGit states visibility per issue; `public` is the only non-restricted
  // value, so anything else present is treated as restricted.
  const visibilityReason = str(record.visibility_reason);
  if (visibilityReason !== undefined && visibilityReason !== 'public') {
    issue.restricted = true;
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
  number: number,
): PullRequest {
  const record = asRecord(raw);
  const rawState = str(record.state);
  const merged = rawState === 'merged' || str(record.merged_at) !== undefined;
  const draft: PullRequest = {
    base,
    provider: PROVIDER,
    owner,
    repo,
    number,
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
  const visibility: RepositoryVisibility = deriveVisibility({
    private: record.private,
    public: record.public,
    internal: record.internal,
  });
  const repository: Repository = {
    provider: PROVIDER,
    // `namespace.path` is the path-safe owner; `human_name` has spaces.
    owner: str(asRecord(record.namespace).path) ?? owner,
    repo,
    name: str(record.name) ?? repo,
    html_url: htmlUrl,
    private: isPrivateVisibility(visibility),
    visibility,
    default_branch: str(record.default_branch) ?? '',
  };

  const stargazers = num(record.stargazers_count);
  if (stargazers !== undefined) {
    repository.stargazers_count = stargazers;
  }
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

/**
 * Maps the top-level account object, which may carry no `login`.
 *
 * AtomGit frequently sends only `{ email, type: 'User' }` for the linked account
 * — measured on a real repository: 11 of 30 commits had no `commit.author.name`
 * at all and the top-level object carried no login. An account object without a
 * login is not a usable {@link UserRef}, so it maps to `undefined` instead of
 * inventing an identifier.
 */
export function mapAccount(raw: unknown): UserRef | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const record = asRecord(raw);
  // A missing `login` is normal here, and a display name is not a substitute for
  // one — only `login` names an account.
  const login = str(record.login);
  if (login === undefined) {
    return undefined;
  }
  const user: UserRef = { login };
  const name = str(record.name);
  const avatar = str(record.avatar_url);
  if (name !== undefined) {
    user.name = name;
  }
  if (avatar !== undefined) {
    user.avatar_url = avatar;
  }
  return user;
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

  // The author side is the contribution account; the committer may be a bot.
  // The block survives a Git payload without a name, because the account alone
  // is enough to identify the contributor.
  const author = buildCommitAuthor(
    readGitAuthor(asRecord(payload.author)),
    mapAccount(record.author),
  );
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
 * Parses label names out of an AtomGit operation-log sentence.
 *
 * AtomGit ships no structured label field: the only record of a mutation is an
 * English sentence, `add label feature, planned, roadmap` or
 * `remove label bug`. The names are taken verbatim (a label may contain spaces,
 * so splitting on whitespace would be wrong) and an unrecognised sentence yields
 * an empty list — the event is still reported, just without a name.
 */
export function parseLabelNames(content: string | undefined): string[] {
  if (content === undefined) {
    return [];
  }
  const match = /^(?:add|remove)\s+labels?\s+(.+)$/i.exec(content.trim());
  if (match === null) {
    return [];
  }
  const names = (match[1] as string)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names;
}

/**
 * Reads the direction out of an AtomGit label sentence.
 *
 * `add label …` and `remove label …` are the two observed forms. Anything else
 * is `unknown` rather than an assumed addition: reporting a removal as `labeled`
 * inverts the resulting state and makes the whole timeline untrustworthy.
 */
export function parseLabelDirection(content: string): IssueEventType {
  const trimmed = content.trim();
  if (/^add\s+labels?\s+/i.test(trimmed)) {
    return 'labeled';
  }
  if (/^remove\s+labels?\s+/i.test(trimmed)) {
    return 'unlabeled';
  }
  return 'unknown';
}

/**
 * Maps one AtomGit operation-log entry to zero or more label events.
 *
 * One log entry can carry several labels (`add label feature, planned,
 * roadmap`), so the result is a list: the caller gets one event per label rather
 * than a comma-joined string it would have to split itself. An unrecognised
 * action, or a sentence whose direction cannot be read, still produces an event
 * — with `type: 'unknown'` and no `label` — rather than disappearing or being
 * recorded as an addition.
 */
export function mapIssueEvents(owner: string, repo: string, raw: unknown): IssueEvent[] {
  const record = asRecord(raw);
  const action = str(record.action_type);
  if (action !== 'label') {
    return [];
  }
  const created = str(record.created_at);
  if (created === undefined) {
    return [];
  }
  const content = str(record.content) ?? '';
  const type = parseLabelDirection(content);
  const base: IssueEvent = {
    provider: PROVIDER,
    owner,
    repo,
    type,
    created_at: created,
  };
  const actor = mapAccount(record.user);
  if (actor !== undefined) {
    base.actor = actor;
  }
  const labels = parseLabelNames(content);
  if (labels.length === 0) {
    // The mutation happened but the names are unreadable; report the event
    // without inventing a label.
    return [base];
  }
  return labels.map((label) => ({ ...base, label }));
}

/** Maps one AtomGit label, normalizing its colour to `#rrggbb`. */
export function mapLabel(owner: string, repo: string, raw: unknown): Label {
  const record = asRecord(raw);
  const label: Label = {
    provider: PROVIDER,
    owner,
    repo,
    name: str(record.name) ?? '',
    color: normalizeLabelColorOrDefault(record.color),
  };
  const description = str(record.description);
  if (description !== undefined) {
    label.description = description;
  }
  return label;
}

/** Normalizes a colour, falling back to the neutral shade on a bad payload. */
export function normalizeLabelColorOrDefault(raw: unknown): string {
  try {
    return normalizeLabelColor(raw);
  } catch {
    return '#ededed';
  }
}

/**
 * Renders a colour for AtomGit's write endpoint.
 *
 * AtomGit is the one platform that keeps the `#` prefix on the wire.
 */
export function labelColorForAtomGit(color: string): string {
  return normalizeLabelColor(color);
}

/**
 * Maps one AtomGit release.
 *
 * No `published_at`, no `draft`, no release URL: `created_at` is the only
 * timestamp and `release_status` is a separate `pre` / `latest` marker.
 */
export function mapRelease(owner: string, repo: string, raw: unknown): Release {
  const record = asRecord(raw);
  const tagName = str(record.tag_name) ?? '';
  const release: Release = {
    provider: PROVIDER,
    owner,
    repo,
    tag_name: tagName,
    name: str(record.name) ?? tagName,
  };
  const publishedAt = str(record.published_at) ?? str(record.created_at);
  if (publishedAt !== undefined) {
    release.published_at = publishedAt;
  }
  const prerelease = bool(record.prerelease);
  if (prerelease !== undefined) {
    release.pre_release = prerelease;
  } else {
    // `release_status` is this platform's own vocabulary and names both
    // directions: `pre` is a pre-release, `latest` (spelled `lasted` in one
    // schema) is a stable release. Only an unrecognised value stays unknown,
    // rather than defaulting to "stable".
    const status = str(record.release_status)?.toLowerCase();
    if (status === 'pre') {
      release.pre_release = true;
    } else if (status === 'latest' || status === 'lasted') {
      release.pre_release = false;
    }
  }
  return release;
}

/** Maps one AtomGit stargazer; this is the only platform with a timestamps list. */
export function mapStargazer(owner: string, repo: string, raw: unknown): Stargazer | undefined {
  const record = asRecord(raw);
  const user = mapAccount(record.user) ?? mapUser(record);
  if (user === undefined) {
    return undefined;
  }
  const stargazer: Stargazer = { provider: PROVIDER, owner, repo, user };
  const starredAt = str(record.starred_at);
  if (starredAt !== undefined) {
    stargazer.starred_at = starredAt;
  }
  return stargazer;
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
