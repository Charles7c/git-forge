/**
 * Adapter contract.
 *
 * An adapter owns exactly two things: endpoint/parameter assembly and response
 * normalization. Retry, pagination, auth injection and error mapping all live in
 * `core`, so adapters stay thin and testable.
 *
 * A provider implements five domain interfaces plus a capability table. Methods
 * the provider does not support are filled with {@link unsupported} rather than
 * being left out, so a call that bypasses the facade still fails loudly instead
 * of returning fabricated data.
 */
import { unsupportedCapabilityError } from '../core/errors.js';
import type { HttpClient } from '../core/http.js';
import type {
  Branch,
  CapabilityId,
  CapabilityTable,
  Comment,
  Commit,
  CreateBranchParams,
  CreateCommentParams,
  CreateIssueParams,
  CreateLabelParams,
  CreateOrUpdateFileParams,
  CreatePullRequestParams,
  CreateRepositoryParams,
  DeleteFileParams,
  FileContent,
  FileWriteResult,
  GetCommitParams,
  GetFileContentsParams,
  GetIssueParams,
  GetPullRequestParams,
  GetRepositoryParams,
  Issue,
  IssueEvent,
  Label,
  ListBranchesParams,
  ListCommitsParams,
  ListCommentsParams,
  ListIssueEventsParams,
  ListIssuesParams,
  ListLabelsParams,
  ListPullRequestsParams,
  ListReleasesParams,
  ListRepositoriesParams,
  ListStargazersParams,
  MergePullRequestParams,
  ParamCapabilityId,
  ParamCapabilityTable,
  Provider,
  PullRequest,
  PushFilesParams,
  Release,
  Repository,
  Stargazer,
  UpdateIssueParams,
} from '../core/types.js';

export type {
  CapabilityId,
  CapabilityTable,
  ParamCapabilityId,
  ParamCapabilityTable,
  Provider,
} from '../core/types.js';
export { CAPABILITY_IDS, PARAM_CAPABILITY_IDS, PROVIDERS } from '../core/types.js';

/**
 * Per-call context handed to an adapter method.
 *
 * One context is built per client and shared, so an adapter must not stash
 * mutable state on it: concurrent calls would corrupt each other.
 */
export interface AdapterCtx {
  /** Shared request layer — the only object allowed to perform HTTP. */
  http: HttpClient;
  /** This provider's method-level capability table. */
  caps: CapabilityTable;
  /** This provider's parameter-level capability table. */
  paramCaps: ParamCapabilityTable;
  /** Web base URL used to derive `Branch.html_url` without an extra request. */
  webBaseUrl: string;
}

/** Parameters carrying the resolved provider, threaded through by the facade. */
export type WithProvider<T> = T & { provider: Provider };

/**
 * Action of one entry in a `pushFiles` batch: a closed three-value set.
 *
 * Declared in `core/types.ts` (the public surface) and re-exported here so
 * adapters and callers share exactly one definition.
 */
export type { PushFileAction } from '../core/types.js';

/**
 * `pushFiles` parameters, re-exported for adapter signatures.
 *
 * The shape is core's `PushFilesParams`, whose `files` entries already carry the
 * closed `action` set; there is no separate adapter-only widening any more.
 */
export type PushFilesInput = PushFilesParams;

/** Issue domain: list / get / create / update, their comments and label events. */
export interface IssueDomain {
  listIssues(ctx: AdapterCtx, params: WithProvider<ListIssuesParams>): Promise<Issue[]>;
  getIssue(ctx: AdapterCtx, params: WithProvider<GetIssueParams>): Promise<Issue>;
  createIssue(ctx: AdapterCtx, params: WithProvider<CreateIssueParams>): Promise<Issue>;
  updateIssue(ctx: AdapterCtx, params: WithProvider<UpdateIssueParams>): Promise<Issue>;
  listIssueComments(ctx: AdapterCtx, params: WithProvider<ListCommentsParams>): Promise<Comment[]>;
  createIssueComment(ctx: AdapterCtx, params: WithProvider<CreateCommentParams>): Promise<Comment>;
  /**
   * Lists an issue's label events.
   *
   * Returns label mutations only, oldest first where the platform can order
   * them. Every adapter answers the same shape; a platform that reports several
   * labels per log entry expands them into one event each.
   */
  listIssueEvents(
    ctx: AdapterCtx,
    params: WithProvider<ListIssueEventsParams>,
  ): Promise<IssueEvent[]>;
}

/** Pull-request domain: list / get / create / merge and their comments. */
export interface PullRequestDomain {
  listPullRequests(
    ctx: AdapterCtx,
    params: WithProvider<ListPullRequestsParams>,
  ): Promise<PullRequest[]>;
  getPullRequest(ctx: AdapterCtx, params: WithProvider<GetPullRequestParams>): Promise<PullRequest>;
  createPullRequest(
    ctx: AdapterCtx,
    params: WithProvider<CreatePullRequestParams>,
  ): Promise<PullRequest>;
  mergePullRequest(
    ctx: AdapterCtx,
    params: WithProvider<MergePullRequestParams>,
  ): Promise<PullRequest>;
  listPullRequestComments(
    ctx: AdapterCtx,
    params: WithProvider<ListCommentsParams>,
  ): Promise<Comment[]>;
  createPullRequestComment(
    ctx: AdapterCtx,
    params: WithProvider<CreateCommentParams>,
  ): Promise<Comment>;
}

/** Repository domain: list / get / create, read file contents, read stargazers. */
export interface RepositoryDomain {
  listRepositories(
    ctx: AdapterCtx,
    params: WithProvider<ListRepositoriesParams>,
  ): Promise<Repository[]>;
  getRepository(ctx: AdapterCtx, params: WithProvider<GetRepositoryParams>): Promise<Repository>;
  createRepository(
    ctx: AdapterCtx,
    params: WithProvider<CreateRepositoryParams>,
  ): Promise<Repository>;
  getFileContents(
    ctx: AdapterCtx,
    params: WithProvider<GetFileContentsParams>,
  ): Promise<FileContent>;
  /**
   * Lists stargazers, newest first where the platform orders them.
   *
   * Gitee's endpoint answers an empty array for every repository, so this
   * adapter declares the capability unsupported rather than returning a
   * misleading empty list.
   */
  listStargazers(ctx: AdapterCtx, params: WithProvider<ListStargazersParams>): Promise<Stargazer[]>;
}

/** Files domain: single-file create/update/delete plus batch push. */
export interface FilesDomain {
  createFile(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams>,
  ): Promise<FileWriteResult>;
  updateFile(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams>,
  ): Promise<FileWriteResult>;
  deleteFile(ctx: AdapterCtx, params: WithProvider<DeleteFileParams>): Promise<FileWriteResult>;
  /**
   * Commits every file in a single commit.
   *
   * A provider with no such endpoint must throw `UNSUPPORTED_ON_PROVIDER`
   * instead of splitting the batch: the contract promises one commit, and a
   * partial multi-commit write cannot be rolled back.
   */
  pushFiles(ctx: AdapterCtx, params: WithProvider<PushFilesInput>): Promise<FileWriteResult>;
}

/** Branch and commit domain. */
export interface BranchCommitDomain {
  listBranches(ctx: AdapterCtx, params: WithProvider<ListBranchesParams>): Promise<Branch[]>;
  createBranch(ctx: AdapterCtx, params: WithProvider<CreateBranchParams>): Promise<Branch>;
  listCommits(ctx: AdapterCtx, params: WithProvider<ListCommitsParams>): Promise<Commit[]>;
  getCommit(ctx: AdapterCtx, params: WithProvider<GetCommitParams>): Promise<Commit>;
}

/**
 * Release domain: list releases.
 *
 * All three platforms expose a read endpoint; what differs is which fields come
 * back, and that difference is documented on {@link Release} rather than
 * papered over with fabricated values.
 */
export interface ReleaseDomain {
  listReleases(ctx: AdapterCtx, params: WithProvider<ListReleasesParams>): Promise<Release[]>;
}

/** Label domain: list and create repository labels. */
export interface LabelDomain {
  listLabels(ctx: AdapterCtx, params: WithProvider<ListLabelsParams>): Promise<Label[]>;
  createLabel(ctx: AdapterCtx, params: WithProvider<CreateLabelParams>): Promise<Label>;
}

/** Everything a provider must implement. */
export interface ProviderAdapter
  extends
    IssueDomain,
    PullRequestDomain,
    RepositoryDomain,
    FilesDomain,
    BranchCommitDomain,
    ReleaseDomain,
    LabelDomain {
  readonly provider: Provider;
  readonly capabilities: CapabilityTable;
  readonly paramCapabilities: ParamCapabilityTable;
}

/**
 * Builds a stand-in for a method the provider cannot serve.
 *
 * Assigning the result keeps the adapter object structurally complete, so a
 * direct call that bypasses the facade throws the same typed error the facade
 * would have produced — never `undefined`, never fabricated data.
 *
 * @param provider   Provider declaring the gap; surfaced on the error so a
 *                   caller knows where the limitation lives.
 * @param capability Capability that is unavailable.
 */
export function unsupported(capability: CapabilityId | ParamCapabilityId, provider: Provider) {
  return (..._args: never[]): never => {
    throw unsupportedCapabilityError(provider, capability);
  };
}
