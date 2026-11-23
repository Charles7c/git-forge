/**
 * Core data models and the adapter-facing type vocabulary.
 *
 * Two rules govern these models:
 *
 * 1. Field names keep GitHub's `snake_case` shape verbatim. No camelCase
 *    rewriting, so a caller's existing GitHub code keeps working.
 * 2. Every model carries `provider` / `owner` / `repo` so a value can be traced
 *    back to the platform and repository it came from without extra context.
 *
 * Capability identifiers also live here (rather than in `adapters/types.ts`)
 * because the error model references them and `core` must never import
 * `adapters`. `adapters/types.ts` re-exports them for adapter authors.
 */

/** Hosting platforms supported by v0.1.0. */
export type Provider = 'github' | 'gitee' | 'atomgit';

/** Runtime list of {@link Provider}, in the order used by documentation. */
export const PROVIDERS = ['github', 'gitee', 'atomgit'] as const satisfies readonly Provider[];

/**
 * Platform-native issue identifier.
 *
 * GitHub uses a number, AtomGit a numeric string (`"205"`), and Gitee a base32
 * code (`"IEXA01"`) that cannot be parsed as a number at all. Accepting both
 * lets a caller pass through whatever the platform reports.
 */
export type NativeId = string | number;

/** Normalized issue state. Platform-specific states are folded into these two. */
export type IssueState = 'open' | 'closed';

/**
 * Normalized pull-request state.
 *
 * AtomGit reports a third value, `merged`; adapters fold it into `closed` and
 * set `merged: true` so the contract stays binary.
 */
export type PullRequestState = 'open' | 'closed';

/** Merge strategies offered by all three platforms. */
export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** How file content is encoded in a `createOrUpdateFile` / `pushFiles` call. */
export type ContentEncoding = 'base64' | 'utf8';

/** Minimal repository reference used by every domain method. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** Provenance fields present on every returned model. */
export interface ModelIdentity {
  provider: Provider;
  owner: string;
  repo: string;
}

/** A platform account as far as the unified models need it. */
export interface UserRef {
  login: string;
  name?: string;
  avatar_url?: string;
}

/** An issue, normalized across the three platforms. */
export interface Issue extends ModelIdentity {
  /** Platform-native issue number as text, including codes and leading zeroes. */
  number: string;
  /** Available only for decimal digit strings representable as a safe integer. */
  number_as_number?: number;
  title: string;
  state: IssueState;
  body?: string;
  html_url: string;
  labels: string[];
  user?: UserRef;
  assignees?: UserRef[];
  comments_count?: number;
  closed_at?: string;
  /** ISO 8601 string, kept exactly as the platform sent it (offset preserved). */
  created_at: string;
  /** ISO 8601 string, kept exactly as the platform sent it (offset preserved). */
  updated_at: string;
}

/** Source/target branch reference on a pull request. */
export interface PullRequestRef {
  ref: string;
  sha: string;
}

/** A pull request, normalized across the three platforms. */
export interface PullRequest extends ModelIdentity {
  /** Pull-request numbers are integers on all three platforms. */
  number: number;
  title: string;
  state: PullRequestState;
  /**
   * Whether the pull request was merged.
   *
   * GitHub reads `merged`, Gitee derives it from `merged_at`, AtomGit from
   * `state === 'merged'`.
   */
  merged: boolean;
  merged_at?: string;
  html_url: string;
  /** Absent if the provider does not return the source branch reference. */
  head?: PullRequestRef;
  base: PullRequestRef;
  body?: string;
  draft?: boolean;
  mergeable?: boolean;
  user?: UserRef;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at: string;
  updated_at: string;
}

/** A repository, normalized across the three platforms. */
export interface Repository extends ModelIdentity {
  /** Repository name; identical to {@link Repository.repo}. */
  name: string;
  /**
   * Human-facing repository URL.
   *
   * Gitee's raw value is a clone URL ending in `.git` and is stripped; AtomGit
   * leaves `html_url` null and exposes `web_url` instead, which is used as-is.
   */
  html_url: string;
  private: boolean;
  default_branch: string;
  full_name?: string;
  description?: string;
  fork?: boolean;
  language?: string;
  created_at?: string;
  updated_at?: string;
}

/** A single file's content as returned by the contents API. */
export interface FileContent extends ModelIdentity {
  path: string;
  /** Payload encoded per {@link FileContent.encoding}. */
  content: string;
  /**
   * Encoding of {@link FileContent.content}. All three platforms currently
   * report `base64`; the field stays a plain string so an unusual value is
   * reported rather than rejected.
   */
  encoding: string;
  sha?: string;
  size?: number;
  html_url?: string;
  type?: string;
}

/** Result of a write that produced a commit. */
export interface FileWriteResult extends ModelIdentity {
  /** sha of the commit that contains the change. Always present. */
  commit_sha: string;
  /** Web URL of that commit; all three platforms expose one. */
  commit_html_url: string;
  /** Every path touched by this write, in the order given by the caller. */
  paths: string[];
  /** Web URL per path where obtainable; `undefined` where the platform omits it. */
  file_html_urls?: (string | undefined)[];
  branch: string;
}

/** A branch, normalized across the three platforms. */
export interface Branch extends ModelIdentity {
  name: string;
  commit_sha: string;
  protected?: boolean;
  /**
   * Derived by the adapter as `<webBase>/<owner>/<repo>/tree/<name>`.
   *
   * No platform returns this field (nor a `_links` object), so it is omitted
   * when no web base URL is configured rather than fabricated.
   */
  html_url?: string;
}

/** Commit authorship metadata. */
export interface CommitAuthor {
  name: string;
  email: string;
  /** ISO 8601 string, kept as the platform sent it. */
  date: string;
}

/** A commit, normalized across the three platforms. */
export interface Commit extends ModelIdentity {
  sha: string;
  message: string;
  html_url: string;
  author?: CommitAuthor;
  committer?: CommitAuthor;
  /** Parent commit shas, root-commit order preserved. */
  parents?: string[];
}

/** An issue or pull-request comment. */
export interface Comment extends ModelIdentity {
  /** Comment identifier, normalized to a number. */
  id: number;
  body: string;
  /**
   * Optional: Gitee and AtomGit comment objects do not carry `html_url`.
   * Adapters fall back to the parent issue/PR URL and never invent anchors.
   */
  html_url?: string;
  created_at: string;
  updated_at?: string;
  user?: UserRef;
}

/* -------------------------------------------------------------------------- */
/* Method-level capabilities                                                   */
/* -------------------------------------------------------------------------- */

/** Runtime list of every method-level capability, grouped by domain. */
export const CAPABILITY_IDS = [
  // Issue (6)
  'issues.list',
  'issues.get',
  'issues.create',
  'issues.update',
  'issues.listComments',
  'issues.createComment',
  // Pull request (6)
  'pulls.list',
  'pulls.get',
  'pulls.create',
  'pulls.merge',
  'pulls.listComments',
  'pulls.createComment',
  // Repository (4)
  'repos.list',
  'repos.get',
  'repos.create',
  'repos.getFileContents',
  // Files (4)
  'files.create',
  'files.update',
  'files.delete',
  'files.pushFiles',
  // Branch (2)
  'branches.list',
  'branches.create',
  // Commit (2)
  'commits.list',
  'commits.get',
] as const;

/**
 * The 24 method-level capabilities delivered by v0.1.0.
 *
 * Derived from {@link CAPABILITY_IDS}, so the type and the runtime list cannot
 * drift apart.
 */
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** Runtime list of every parameter-level capability. */
export const PARAM_CAPABILITY_IDS = [
  'pulls.list.headFilter',
  'pulls.list.milestoneFilter',
  'issues.list.milestoneFilter',
  'files.pushFiles.atomic',
] as const;

/**
 * Parameter-level capabilities.
 *
 * A method can exist while one of its filters is not supported — AtomGit has
 * pull-request listing but no `head` filter. Declaring those separately lets the
 * facade fail loudly instead of silently returning an unfiltered result.
 */
export type ParamCapabilityId = (typeof PARAM_CAPABILITY_IDS)[number];

/** Whether a provider implements a capability. */
export type CapabilityState = 'supported' | 'unsupported';

/** Per-provider support matrix for method-level capabilities. */
export type CapabilityTable = Readonly<Record<CapabilityId, CapabilityState>>;

/** Per-provider support matrix for parameter-level capabilities. */
export type ParamCapabilityTable = Readonly<Record<ParamCapabilityId, CapabilityState>>;

/* -------------------------------------------------------------------------- */
/* Method input shapes                                                        */
/* -------------------------------------------------------------------------- */

/** Options shared by every list method. */
export interface ListOptions {
  /**
   * Maximum pages to fetch. Defaults to 10 and is capped at 100 so a huge
   * repository cannot turn one call into unbounded traffic.
   */
  maxPages?: number;
}

/** Parameters of `listIssues`. */
export interface ListIssuesParams extends RepoRef, ListOptions {
  state?: IssueState | 'all';
  /** Comma-joined for both Gitee and AtomGit on the wire. */
  labels?: string[];
  /** Milestone number; Gitee's list filter only accepts a title, so it rejects this. */
  milestone?: number;
}

/** Parameters of `getIssue`. */
export interface GetIssueParams extends RepoRef {
  number: NativeId;
}

/** Parameters of `createIssue`. */
export interface CreateIssueParams extends RepoRef {
  title: string;
  body?: string;
  labels?: string[];
  milestone?: number;
}

/** Parameters of `updateIssue`. Omitted fields are left untouched. */
export interface UpdateIssueParams extends RepoRef {
  number: NativeId;
  title?: string;
  body?: string;
  state?: IssueState;
  labels?: string[];
  milestone?: number;
}

/** Parameters of `listIssueComments` and `listPullRequestComments`. */
export interface ListCommentsParams extends RepoRef, ListOptions {
  number: NativeId;
}

/** Parameters of `createIssueComment` and `createPullRequestComment`. */
export interface CreateCommentParams extends RepoRef {
  number: NativeId;
  body: string;
}

/** Parameters of `listPullRequests`. */
export interface ListPullRequestsParams extends RepoRef, ListOptions {
  state?: PullRequestState | 'all';
  /**
   * Source-branch filter. Supported by GitHub and Gitee; AtomGit has no such
   * filter and rejects the call rather than ignoring it.
   */
  head?: string;
  base?: string;
  labels?: string[];
  milestone?: number;
}

/** Parameters of `getPullRequest`. */
export interface GetPullRequestParams extends RepoRef {
  number: number;
}

/** Parameters of `createPullRequest`. */
export interface CreatePullRequestParams extends RepoRef {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

/** Parameters of `mergePullRequest`. */
export interface MergePullRequestParams extends RepoRef {
  number: number;
  merge_method?: MergeMethod;
  commit_title?: string;
  commit_message?: string;
}

/**
 * Parameters of `listRepositories`.
 *
 * `org` and `user` are mutually exclusive; omitting both lists the
 * authenticated user's repositories.
 */
export interface ListRepositoriesParams extends ListOptions {
  org?: string;
  user?: string;
}

/** Parameters of `getRepository`. */
export type GetRepositoryParams = RepoRef;

/** Parameters of `createRepository`. */
export interface CreateRepositoryParams {
  name: string;
  description?: string;
  private?: boolean;
  /** Create inside this organization instead of the authenticated user's account. */
  org?: string;
  auto_init?: boolean;
}

/** Parameters of `getFileContents`. */
export interface GetFileContentsParams extends RepoRef {
  path: string;
  /** Branch name, tag or commit sha. */
  ref?: string;
}

/** Parameters of `createOrUpdateFile`. */
export interface CreateOrUpdateFileParams extends RepoRef {
  path: string;
  content: string;
  message: string;
  branch?: string;
  /** Existing blob sha; required by all three platforms when updating. */
  sha?: string;
  /** Encoding of `content`. Defaults to `utf8`; use `base64` for pre-encoded bytes. */
  encoding?: ContentEncoding;
}

/** Parameters of `deleteFile`. */
export interface DeleteFileParams extends RepoRef {
  path: string;
  message: string;
  /** Blob sha of the file being deleted. */
  sha: string;
  branch?: string;
}

/**
 * Action of one entry in a `pushFiles` batch: a closed three-value set.
 *
 * There is deliberately no `upsert`. Gitee distinguishes `create` from `update`
 * and answers 400 for the wrong one, while GitHub treats both as "write this
 * content", so an explicit action is the only formulation correct on both
 * without a per-file existence probe.
 */
export type PushFileAction = 'create' | 'update' | 'delete';

/** One file in a `pushFiles` batch. */
export interface PushFileEntry {
  /** Repository-relative path, without a leading slash. */
  path: string;
  /** Which of the three mutations this entry performs. */
  action: PushFileAction;
  /** Required for `create`/`update`; must be absent for `delete`. */
  content?: string;
  /** Encoding of {@link PushFileEntry.content}; defaults to `utf8`. */
  encoding?: ContentEncoding;
}

/** Parameters of `pushFiles`. */
export interface PushFilesParams extends RepoRef {
  branch: string;
  message: string;
  files: PushFileEntry[];
}

/** Parameters of `listBranches`. */
export type ListBranchesParams = RepoRef & ListOptions;

/** Parameters of `createBranch`. */
export interface CreateBranchParams extends RepoRef {
  /** New branch name. */
  name: string;
  /** Source branch name or commit sha. */
  from: string;
}

/** Parameters of `listCommits`. */
export interface ListCommitsParams extends RepoRef, ListOptions {
  /** Branch name, tag or commit sha to start from. */
  branch?: string;
}

/** Parameters of `getCommit`. */
export interface GetCommitParams extends RepoRef {
  sha: string;
}
