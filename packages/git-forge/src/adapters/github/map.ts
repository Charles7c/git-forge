/**
 * GitHub response and parameter mapping.
 *
 * Everything platform-specific about GitHub lives here: field names, path
 * encoding, tree-entry construction for the five-step `pushFiles` chain, and
 * validation of the closed three-value push contract.
 *
 * Raw payloads are treated as `unknown` and narrowed field by field. A platform
 * adding a field must never break a call, and a platform *dropping* a field must
 * surface as a missing value rather than `undefined` leaking into a model.
 */
import { issueNumberFields } from '../../core/issue-number.js';
import { invalidArgumentError } from '../../core/errors.js';
import type {
  Branch,
  Comment,
  Commit,
  CommitAuthor,
  ContentEncoding,
  FileContent,
  FileWriteResult,
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
const PROVIDER: Provider = 'github';

/** Actions accepted by the closed three-value push contract. */
export type PushAction = 'create' | 'update' | 'delete';

const PUSH_ACTIONS: readonly PushAction[] = ['create', 'update', 'delete'];

/** A push entry after validation, with defaults applied. */
export interface PushPlanEntry {
  path: string;
  action: PushAction;
  content?: string;
  encoding: ContentEncoding;
}

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

/** Flattens `string[] | {name}[]` into `string[]`, dropping empty names. */
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

/** Maps a platform user object to the unified shape. */
export function mapUser(raw: unknown): UserRef | undefined {
  const record = asRecord(raw);
  const login = str(record.login) ?? str(record.name);
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

/** Maps a list of platform users, dropping entries without a login. */
export function mapUsers(raw: unknown): UserRef[] | undefined {
  const users = asArray(raw)
    .map((entry) => mapUser(entry))
    .filter((entry): entry is UserRef => entry !== undefined);
  return users.length > 0 ? users : undefined;
}

/**
 * Folds a GitHub issue state into the binary contract.
 *
 * GitHub has exactly two states; anything else is treated as `closed` so an
 * unexpected value cannot masquerade as an active issue.
 */
export function mapIssueState(raw: unknown): IssueState {
  return raw === 'open' ? 'open' : 'closed';
}

/**
 * Folds a GitHub pull-request state into the binary contract.
 *
 * GitHub reports merges through the separate `merged` boolean, so `state` is
 * already binary; a merged entry arrives as `closed`.
 */
export function mapPullRequestState(raw: unknown): PullRequestState {
  return raw === 'open' ? 'open' : 'closed';
}

/** Whether a raw issue-list entry is really a pull request. */
export function isPullRequestEntry(raw: unknown): boolean {
  return asRecord(raw).pull_request !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

/** Maps one GitHub issue (or list entry) to the unified model. */
export function mapIssue(owner: string, repo: string, raw: unknown): Issue {
  const record = asRecord(raw);
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
  const closedAt = str(record.closed_at);
  if (closedAt !== undefined) {
    issue.closed_at = closedAt;
  }
  return issue;
}

/** Maps a `{ref, sha}` branch reference, or `undefined` when either is absent. */
export function mapRef(raw: unknown): PullRequestRef | undefined {
  const record = asRecord(raw);
  const ref = str(record.ref);
  const sha = str(record.sha);
  return ref !== undefined && sha !== undefined ? { ref, sha } : undefined;
}

/**
 * Maps one GitHub pull request.
 *
 * Preserve branch references supplied by the provider; never invent a missing ref.
 */
export function mapPullRequest(owner: string, repo: string, raw: unknown): PullRequest {
  const record = asRecord(raw);
  const merged = bool(record.merged) === true;
  const draft: Omit<PullRequest, 'base'> & {
    base?: PullRequestRef;
  } = {
    provider: PROVIDER,
    owner,
    repo,
    number: num(record.number) ?? Number(str(record.number) ?? 0),
    title: str(record.title) ?? '',
    state: merged ? 'closed' : mapPullRequestState(record.state),
    merged,
    html_url: str(record.html_url) ?? '',
    created_at: str(record.created_at) ?? '',
    updated_at: str(record.updated_at) ?? '',
  };

  const head = mapRef(record.head);
  if (head !== undefined) {
    draft.head = head;
  }
  const base = mapRef(record.base);
  if (base !== undefined) {
    draft.base = base;
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
  for (const key of ['additions', 'deletions', 'changed_files'] as const) {
    const value = num(record[key]);
    if (value !== undefined) {
      draft[key] = value;
    }
  }
  return draft as PullRequest;
}

/** Maps one GitHub repository. */
export function mapRepository(owner: string, repo: string, raw: unknown): Repository {
  const record = asRecord(raw);
  const repository: Repository = {
    provider: PROVIDER,
    owner: str(asRecord(record.owner).login) ?? owner,
    repo,
    name: str(record.name) ?? repo,
    html_url: str(record.html_url) ?? '',
    private: bool(record.private) === true,
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

/** Maps one file-contents payload (a single object, never an array). */
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

/** Maps one GitHub branch entry. */
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

/** Maps one GitHub commit. */
export function mapCommit(owner: string, repo: string, raw: unknown): Commit {
  const record = asRecord(raw);
  const payload = asRecord(record.commit);
  const commit: Commit = {
    provider: PROVIDER,
    owner,
    repo,
    sha: str(record.sha) ?? '',
    message: str(payload.message) ?? '',
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
 * Maps one GitHub comment.
 *
 * GitHub always sends `html_url`; the parameter is accepted for symmetry with
 * the other two providers and used only if the payload omits it.
 */
export function mapComment(owner: string, repo: string, raw: unknown, parentUrl?: string): Comment {
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

/** Inputs of {@link buildFileWriteResult}. */
export interface FileWriteInputs {
  owner: string;
  repo: string;
  branch: string | undefined;
  paths: readonly string[];
  commitSha: string;
  commitHtmlUrl: string;
  fileHtmlUrls?: (string | undefined)[];
}

/**
 * Assembles a {@link FileWriteResult}.
 *
 * `branch` falls back to the empty string when the caller did not pin one: the
 * write then targeted the repository default branch, which was never fetched,
 * and inventing a name would be worse than reporting "not specified".
 */
export function buildFileWriteResult(inputs: FileWriteInputs): FileWriteResult {
  const result: FileWriteResult = {
    provider: PROVIDER,
    owner: inputs.owner,
    repo: inputs.repo,
    commit_sha: inputs.commitSha,
    commit_html_url: inputs.commitHtmlUrl,
    paths: [...inputs.paths],
    branch: inputs.branch ?? '',
  };
  if (inputs.fileHtmlUrls !== undefined) {
    result.file_html_urls = inputs.fileHtmlUrls;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Request assembly helpers                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Encodes a repository-relative path for a URL while keeping `/` as a segment
 * separator.
 *
 * The platforms treat `%2F` as part of a single file name,
 * so a whole-path `encodeURIComponent` would address the wrong resource.
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Whether a string looks like an abbreviated or full commit sha. */
export function isShaLike(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/**
 * The 64 base64 digits, as a lookup string.
 *
 * Kept as a literal rather than a regex character class so the alphabet is
 * obvious at a glance and cannot be misread as a range expression.
 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Validates a base64 payload, tolerating embedded whitespace.
 *
 * Wrapped base64 and compact base64 denote the same bytes.
 */
export function isValidBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  // Padding is permitted only as a trailing run of at most two characters.
  const body = compact.replace(/={0,2}$/, '');
  if (body.length === 0) {
    return false;
  }
  // A remainder of 1 is impossible in base64, padded or not; 2 and 3 are the
  // unpadded forms of 1 and 2 padding characters.
  if (body.length % 4 === 1) {
    return false;
  }
  for (const char of body) {
    if (!BASE64_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates the closed three-value push contract and applies encoding defaults.
 *
 * Rejects four invalid inputs before a single
 * request is issued: an empty batch, a `delete` carrying content, a
 * create/update without content, and an unusable base64 payload. The tree API
 * silently accepts some of these and produces a corrupt tree, so the check must
 * happen locally.
 */
export function readPushEntries(files: readonly unknown[]): PushPlanEntry[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw invalidArgumentError(
      'Invalid `files`: pushFiles requires at least one entry (an empty batch would create an empty commit).',
      PROVIDER,
      'files.pushFiles',
    );
  }

  return files.map((raw, index) => {
    // Narrowed through `asRecord`, not trusted from the static type: these values
    // arrive from a caller and a wrong action or a non-string path must be a
    // typed error, not an `undefined` that reaches the platform.
    const file = asRecord(raw);
    const path = file.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw invalidArgumentError(
        `Invalid \`files[${index}].path\`: expected a non-empty string.`,
        PROVIDER,
        'files.pushFiles',
      );
    }
    const rawAction = file.action;
    if (typeof rawAction !== 'string' || !PUSH_ACTIONS.includes(rawAction as PushAction)) {
      throw invalidArgumentError(
        `Invalid \`files[${index}].action\`: expected one of ${PUSH_ACTIONS.join(' | ')}, ` +
          `received ${describe(rawAction)}. pushFiles does not provide upsert.`,
        PROVIDER,
        'files.pushFiles',
      );
    }
    const action = rawAction as PushAction;
    const rawEncoding = file.encoding ?? 'utf8';
    if (rawEncoding !== 'utf8' && rawEncoding !== 'base64') {
      throw invalidArgumentError(
        `Invalid \`files[${index}].encoding\`: expected utf8 | base64, received ${describe(rawEncoding)}.`,
        PROVIDER,
        'files.pushFiles',
      );
    }
    const encoding: ContentEncoding = rawEncoding;

    if (action === 'delete') {
      if (file.content !== undefined) {
        throw invalidArgumentError(
          `Invalid \`files[${index}]\`: action 'delete' must not carry content.`,
          PROVIDER,
          'files.pushFiles',
        );
      }
      return { path, action, encoding };
    }

    const content = file.content;
    if (typeof content !== 'string') {
      throw invalidArgumentError(
        `Invalid \`files[${index}].content\`: action '${action}' requires content.`,
        PROVIDER,
        'files.pushFiles',
      );
    }
    if (encoding === 'base64' && !isValidBase64(content)) {
      throw invalidArgumentError(
        `Invalid \`files[${index}].content\`: not a valid base64 payload.`,
        PROVIDER,
        'files.pushFiles',
      );
    }
    return { path, action, content, encoding };
  });
}

/** Renders a value for an error message without echoing a payload. */
function describe(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value.length === 0 ? 'an empty string' : `"${value}"`;
  }
  return typeof value;
}
