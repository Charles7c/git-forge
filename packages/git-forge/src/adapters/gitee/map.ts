/**
 * Gitee response and parameter mapping.
 *
 * Gitee is the most platform-specific of the three:
 *
 * - Issue identifiers can be alphanumeric (`IEXA01`); keep them verbatim and
 *   omit `number_as_number` for non-decimal codes.
 * - Of the four issue states, `progressing` is active and `rejected` is closed.
 * - Issue writes use owner-scoped paths with `repo` in the body.
 * - `labels` travel as a comma-joined string, `milestone` in list filters is a
 *   *title* (so a numeric filter cannot be translated and is rejected).
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
const PROVIDER: Provider = 'gitee';

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

/** Flattens Gitee's `{name}[]` label objects into `string[]`. */
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

/** Maps a Gitee user object to the unified shape. */
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

/** Maps a list of Gitee users, dropping empty entries. */
export function mapUsers(raw: unknown): UserRef[] | undefined {
  const users = asArray(raw)
    .map((entry) => mapUser(entry))
    .filter((entry): entry is UserRef => entry !== undefined);
  return users.length > 0 ? users : undefined;
}

/**
 * Folds Gitee's four issue states into the binary contract.
 *
 * `progressing` stays `open`: `finished_at` is null for those issues, so
 * treating them as closed would tell a caller that in-flight work is done.
 * `rejected` is `closed`: the issue will not be worked on. Any unknown value is
 * folded to `closed` so it cannot masquerade as active.
 */
export function mapIssueState(raw: unknown): IssueState {
  return raw === 'open' || raw === 'progressing' ? 'open' : 'closed';
}

/**
 * Folds a Gitee pull-request state into the binary contract.
 *
 * Gitee can report `merged` in list payloads; the merge flag is derived from
 * `merged_at` and the state becomes `closed`.
 */
export function mapPullRequestState(raw: unknown): PullRequestState {
  return raw === 'open' ? 'open' : 'closed';
}

/** Joins labels for a Gitee write or list filter; no trimming or deduplication. */
export function joinLabels(labels: readonly string[] | undefined): string | undefined {
  return labels === undefined || labels.length === 0 ? undefined : labels.join(',');
}

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

/** Maps one Gitee issue (or list entry) to the unified model. */
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
  const closedAt = str(record.finished_at) ?? str(record.closed_at);
  if (closedAt !== undefined) {
    issue.closed_at = closedAt;
  }
  return issue;
}

/** Maps a Gitee `{ref, sha}` branch reference. */
export function mapRef(raw: unknown): PullRequestRef | undefined {
  const record = asRecord(raw);
  const ref = str(record.ref);
  const sha = str(record.sha);
  return ref !== undefined && sha !== undefined ? { ref, sha } : undefined;
}

/**
 * Maps one Gitee pull request.
 *
 * `merged` comes from `merged_at`: Gitee does not send a boolean. A merged pull
 * request is reported as `closed` so the contract stays binary.
 */
export function mapPullRequest(owner: string, repo: string, raw: unknown): PullRequest {
  const record = asRecord(raw);
  const mergedAt = str(record.merged_at);
  const state = str(record.state);
  const merged = mergedAt !== undefined || state === 'merged';
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

/** Strips the `.git` suffix Gitee puts on `html_url` (it is a clone URL). */
export function stripGitSuffix(url: string): string {
  return url.replace(/\.git$/, '');
}

/** Maps one Gitee repository. */
export function mapRepository(owner: string, repo: string, raw: unknown): Repository {
  const record = asRecord(raw);
  const rawHtmlUrl = str(record.html_url);
  const repository: Repository = {
    provider: PROVIDER,
    owner: str(asRecord(record.namespace).path) ?? owner,
    repo,
    name: str(record.name) ?? repo,
    html_url: rawHtmlUrl === undefined ? '' : stripGitSuffix(rawHtmlUrl),
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

/** Maps one Gitee branch entry. */
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

/** Maps one Gitee commit. */
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
 * Maps one Gitee comment.
 *
 * Gitee comment payloads carry no `html_url`, so the parent resource URL is used
 * instead. It is built from the platform's own path template — no anchor is
 * appended, because the anchor scheme for a single comment is not documented and
 * a guessed anchor would 404.
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

/** Assembles a {@link FileWriteResult}. */
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
 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Derives the web URL of an issue or pull request from its number.
 *
 * Used only as the comment `html_url` fallback, where the parent resource is the
 * documented anchor target. Returns `undefined` when no web base is configured.
 */
export function deriveParentHtmlUrl(
  webBaseUrl: string,
  owner: string,
  repo: string,
  kind: 'issues' | 'pulls',
  number: string | number,
): string | undefined {
  const base = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  if (base.length === 0) {
    return undefined;
  }
  return `${base}/${owner}/${repo}/${kind}/${String(number)}`;
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
 * Validates a base64 payload.
 *
 * Whitespace is stripped first: Gitee accepts base64 with
 * embedded newlines and returns the compacted value.
 */
export function isValidBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  const body = compact.replace(/={0,2}$/, '');
  if (body.length === 0 || body.length % 4 === 1) {
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
 * An empty batch must be rejected locally: Gitee accepts `actions: []` and creates
 * an empty commit.
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

/**
 * Translates a contract encoding into a Gitee encoding.
 *
 * Gitee accepts exactly `text` and `base64`; `utf8` is rejected with a 400
 * (`does not have a valid value`).
 */
export function toGiteeEncoding(encoding: ContentEncoding): 'text' | 'base64' {
  return encoding === 'base64' ? 'base64' : 'text';
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
