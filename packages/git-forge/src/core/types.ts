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

/** Hosting platforms this SDK speaks to. */
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

/**
 * Repository visibility as the platform states it.
 *
 * `unknown` is a real answer, not a placeholder: several payloads omit the
 * field entirely, and a missing field is not evidence of a public repository.
 * Callers that need an anonymous-readable source must reject `unknown` and
 * `internal` rather than treating them as public.
 */
export type RepositoryVisibility = 'public' | 'private' | 'internal' | 'unknown';

/** An issue, normalized across the three platforms. */
export interface Issue extends ModelIdentity {
  /** Platform-native issue number as text, including codes and leading zeroes. */
  number: string;
  /** Available only for decimal digit strings representable as a safe integer. */
  number_as_number?: number;
  title: string;
  state: IssueState;
  /**
   * The platform's own state string, unmodified.
   *
   * Gitee reports four values (`open`, `progressing`, `closed`, `rejected`) and
   * folds two of them into each normalized state; `progressing` is active work,
   * `rejected` is abandoned work. AtomGit reports `open` / `closed`. GitHub has
   * no separate native state, so the field is omitted there rather than echoing
   * {@link Issue.state}.
   */
  native_state?: string;
  /**
   * Human-readable state name from the platform's workflow model.
   *
   * Gitee's `issue_state_detail.title` (`进行中`, `已完成`, …) and AtomGit's
   * `issue_state` are both verbatim platform text, not translations. AtomGit's
   * value is a workflow label only: measured issues with `state: 'closed'` still
   * report `待办的`, so it must not be read as an open/closed signal.
   */
  state_label?: string;
  /**
   * GitHub's `state_reason` (`completed`, `not_planned`, `duplicate`, `reopened`).
   *
   * Optional because GitHub omits it on issues closed before the field existed;
   * it is absent, not defaulted to a guess.
   */
  state_reason?: string;
  /**
   * Whether the platform marks the issue as not publicly visible.
   *
   * Gitee's `security_hole` and AtomGit's `visibility_reason` (`confidential` /
   * `other`) are the two sources. GitHub exposes no per-issue visibility marker,
   * so the field is omitted there — absent means "no signal", never "public".
   */
  restricted?: boolean;
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
  /**
   * Whether the platform declared the repository private.
   *
   * `false` means "not private as far as the payload says", which is *not* a
   * proof of anonymous readability: a payload that omits the field also lands
   * here. Read {@link Repository.visibility} for a three-way answer.
   */
  private: boolean;
  /**
   * Visibility as the platform reported it.
   *
   * GitHub answers from its `visibility` field (`internal` included). Gitee and
   * AtomGit only send booleans, so the value is derived from `private` /
   * `public` / `internal` and is `unknown` when none of them is present.
   * Never treat `unknown` as public.
   */
  visibility: RepositoryVisibility;
  default_branch: string;
  /**
   * Current stargazer count.
   *
   * Present on all three platforms. Omitted rather than set to `0` when the
   * payload has no count, so a caller can tell "no stars" from "not reported".
   */
  stargazers_count?: number;
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
  /**
   * The hosting account the platform linked to this commit, when it linked one.
   *
   * Only GitHub, Gitee and AtomGit's *author* side is consulted — never the
   * committer, which is a web-flow or bot account on rebase/squash merges. The
   * link is frequently absent (an unmerged email, an unresolvable identity), so
   * a missing value is normal and must not be inferred from `name` or `email`.
   */
  user?: UserRef;
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

/**
 * One entry of an issue's label timeline.
 *
 * Deliberately minimal: the three platforms disagree on the shape of these
 * events, so only the fields a caller can rely on are modelled.
 */
export interface IssueEvent extends ModelIdentity {
  /** Which label mutation this event records. */
  type: IssueEventType;
  /**
   * Label name, when it could be read from a structured field.
   *
   * GitHub always provides it. Gitee exposes it as `after_change_value` for
   * additions and `before_change_value` for removals. AtomGit only carries it
   * inside a human-readable sentence (`add label a, b`), which is parsed on a
   * best-effort basis: an unparseable sentence leaves this `undefined` rather
   * than guessing.
   */
  label?: string;
  /** Account that performed the change, when the platform reports one. */
  actor?: UserRef;
  /** ISO 8601 string, kept as the platform sent it. */
  created_at: string;
}

/**
 * Label mutations the three platforms can report.
 *
 * `unknown` is a real answer, not a placeholder. AtomGit records a label edit as
 * a free-text sentence, so a mutation whose sentence cannot be parsed still
 * happened — reporting it as `labeled` would invert the resulting state and make
 * the event unusable for audit, so it is reported with its direction unknown.
 */
export type IssueEventType = 'labeled' | 'unlabeled' | 'unknown';

/** A repository label. */
export interface Label extends ModelIdentity {
  name: string;
  /**
   * Six-digit hex colour with a leading `#`, normalized across platforms.
   *
   * The platforms disagree on the wire: GitHub and Gitee send `d73a4a`, AtomGit
   * sends `#d73a4a`. The SDK always answers `#d73a4a` and strips the prefix on
   * write where the platform requires it, so a caller never has to branch.
   */
  color: string;
  /** Gitee's label payload has no description field, so this is often absent. */
  description?: string;
}

/** A release, normalized across the three platforms. */
export interface Release extends ModelIdentity {
  tag_name: string;
  /** Release title; falls back to `tag_name` where the platform has none. */
  name: string;
  /**
   * Publication timestamp.
   *
   * Only GitHub reports a real `published_at`. Gitee and AtomGit send
   * `created_at` and nothing else, so that value is used and documented as a
   * creation time — the SDK does not invent a publication time.
   */
  published_at?: string;
  /**
   * Web URL of the release.
   *
   * GitHub returns one. Gitee and AtomGit do not, and their release pages are
   * not addressable by a derived URL (Gitee answers a 302 to a source archive
   * for a non-browser client), so the field is omitted rather than fabricated.
   */
  html_url?: string;
  /**
   * Whether the release is a GitHub draft.
   *
   * Only GitHub has drafts; the field is omitted on the other two platforms so
   * a caller cannot mistake "no drafts" for "reported as not a draft".
   */
  draft?: boolean;
  pre_release?: boolean;
}

/** One stargazer, optionally with the time the star was added. */
export interface Stargazer extends ModelIdentity {
  user: UserRef;
  /** When the star was added; only providers that report it populate this. */
  starred_at?: string;
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
  // Issue (7)
  'issues.list',
  'issues.get',
  'issues.create',
  'issues.update',
  'issues.listComments',
  'issues.createComment',
  'issues.listEvents',
  // Pull request (6)
  'pulls.list',
  'pulls.get',
  'pulls.create',
  'pulls.merge',
  'pulls.listComments',
  'pulls.createComment',
  // Repository (5)
  'repos.list',
  'repos.get',
  'repos.create',
  'repos.getFileContents',
  'repos.listStargazers',
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
  // Release (1)
  'releases.list',
  // Label (2)
  'labels.list',
  'labels.create',
] as const;

/**
 * The 29 method-level capabilities delivered by v0.2.0.
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
  'repos.listStargazers.timestamps',
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
  /** Reject with `PAGINATION_LIMIT` if the page budget may truncate the list. Defaults to false. */
  requireComplete?: boolean;
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

/**
 * Parameters of `listIssueEvents`.
 *
 * `maxPages` only bounds GitHub, whose timeline endpoint is paged with a `Link`
 * header. Gitee's and AtomGit's operation-log endpoints accept no page
 * parameter at all, so they are read in a single request and the budget does
 * not apply — a documented limit beats a pagination parameter that would be
 * silently ignored.
 */
export interface ListIssueEventsParams extends RepoRef, ListOptions {
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

/** Parameters of `listRepositories`. */
export interface ListRepositoriesParams extends ListOptions {
  org?: string;
  user?: string;
}

/**
 * Parameters of `listStargazers`.
 *
 * `timestamps` asks for the "starred at" time. Only AtomGit and GitHub report
 * one, so the parameter goes through the `repos.listStargazers.timestamps`
 * capability gate instead of being ignored where it cannot be honoured.
 */
export interface ListStargazersParams extends RepoRef, ListOptions {
  timestamps?: boolean;
}

/** Parameters of `listReleases`. */
export type ListReleasesParams = RepoRef & ListOptions;

/**
 * Parameters of `listLabels`.
 *
 * `requireComplete` mirrors `listIssues`: a caller that intends to act on the
 * result (for example "this label is absent, therefore create it") must be able
 * to tell a genuinely short list from a truncated one. Without it, a listing cut
 * short by `maxPages` looks exactly like a complete listing that lacks the name.
 */
export interface ListLabelsParams extends RepoRef, ListOptions {
  /** Reject with `PAGINATION_LIMIT` if the page budget may truncate the list. */
  requireComplete?: boolean;
}

/** Parameters of `createLabel`. */
export interface CreateLabelParams extends RepoRef {
  name: string;
  /** Hex colour with or without `#`; normalized to `#rrggbb` on the result. */
  color: string;
  description?: string;
}

/**
 * Parameters of `ensureLabel`.
 *
 * `color` is optional here, unlike {@link CreateLabelParams}: a caller checking
 * whether a version label already exists should not have to invent a colour. It
 * becomes required at call time, but only once the label turns out to be
 * missing and a create is actually issued.
 *
 * The call lists labels first and only creates the one that is missing, so a
 * repeated call is a no-op beyond the read. It is not a promise that two
 * concurrent callers cannot race — the platforms expose no conditional create.
 */
export interface EnsureLabelParams extends RepoRef {
  name: string;
  /** Needed only if the label has to be created. */
  color?: string;
  description?: string;
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
  /**
   * Only commits at or after this instant (ISO 8601).
   *
   * All three platforms filter server-side. The comparison and the accepted
   * precision belong to the platform: GitHub truncates to seconds, Gitee and
   * AtomGit compare against their own stored timestamps.
   */
  since?: string;
  /** Only commits at or before this instant (ISO 8601). */
  until?: string;
}

/** Parameters of `getCommit`. */
export interface GetCommitParams extends RepoRef {
  sha: string;
}
