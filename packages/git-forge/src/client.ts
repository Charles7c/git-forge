/**
 * `GitClient`: the single public entry of the SDK.
 *
 * Every call passes five gates **before** a request is issued, in this fixed
 * order:
 *
 * 1. Parameter validation — `INVALID_ARGUMENT` for a malformed call.
 * 2. Read-only gate — `READONLY_BLOCKED` for any of the 12 write capabilities.
 * 3. Token gate — `AUTH_MISSING` when the provider has no token configured.
 * 4. Method capability gate — `UNSUPPORTED_ON_PROVIDER` when the provider does
 *    not implement the method at all (AtomGit `files.pushFiles`).
 * 5. Parameter capability gate — `UNSUPPORTED_ON_PROVIDER` when the method
 *    exists but the filter does not (AtomGit `pulls.list.headFilter`).
 *
 * The order is load-bearing, not cosmetic:
 *
 * - Validation first means a bad payload can never be described as an
 *   authorization or capability problem.
 * - Read-only before token means enabling `readonly` blocks a write even on a
 *   provider with no credentials, so "read-only" is decidable offline.
 * - Capability last among the refusals means a caller learns about a
 *   *fixable* problem (missing token) before an *unfixable* one (gap).
 *
 * Because all five gates run here and the adapter is only reached afterwards,
 * every gate failure is a hard zero-HTTP guarantee, which is what the tests
 * assert.
 */
import { getAdapter } from './adapters/index.js';
import {
  GitForgeError,
  authMissingError,
  invalidArgumentError,
  readonlyBlockedError,
  unsupportedCapabilityError,
} from './core/errors.js';
import { bulk as runBulk } from './core/bulk.js';
import type { BulkItemResult, BulkOptions } from './core/bulk.js';
import { HttpClient, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from './core/http.js';
import type { RetryPolicy } from './core/retry.js';
import {
  assertFilePath,
  assertMaxPages,
  assertNativeId,
  assertNonEmpty,
  assertOptionalBoolean,
  assertOptionalNonEmpty,
  assertOptionalOneOf,
  assertOptionalPathSegment,
  assertOptionalPositiveInt,
  assertOptionalString,
  assertParamsObject,
  assertProvider,
  assertPushFilesParams,
  assertRepoRef,
  assertStringArray,
  isWriteCapability,
} from './core/validate.js';
import type {
  Branch,
  CapabilityId,
  Comment,
  Commit,
  CreateBranchParams,
  CreateCommentParams,
  CreateIssueParams,
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
  ListBranchesParams,
  ListCommitsParams,
  ListCommentsParams,
  ListIssuesParams,
  ListPullRequestsParams,
  ListRepositoriesParams,
  MergePullRequestParams,
  ParamCapabilityId,
  Provider,
  PullRequest,
  PushFilesParams,
  Repository,
  UpdateIssueParams,
} from './core/types.js';
import type { AdapterCtx, ProviderAdapter } from './adapters/types.js';

/** Parameters of a facade method: the call shape plus the target provider. */
export type ProviderParams<T> = T & { provider: Provider };

/**
 * Credentials and endpoint overrides for one provider.
 *
 * `token` is optional: a client may be built before credentials exist, and the
 * missing token surfaces as `AUTH_MISSING` at call time rather than at
 * construction. That keeps a partially configured MCP server usable for the
 * providers it does have.
 */
export interface ProviderCredentials {
  /** Platform token, sent as `Authorization: Bearer`. Never logged. */
  token?: string;
  /** API base URL override, e.g. a GitHub Enterprise host. Must be `https:`. */
  baseUrl?: string;
  /** Web base URL used to derive `Branch.html_url`. Must be `https:`. */
  webBaseUrl?: string;
}

/** Options accepted by {@link GitClient}. */
export interface GitClientOptions {
  github?: ProviderCredentials;
  gitee?: ProviderCredentials;
  atomgit?: ProviderCredentials;
  /**
   * Refuse every write capability with `READONLY_BLOCKED`.
   *
   * The check happens before dispatch, so a blocked write issues no request at
   * all — the guarantee the MCP server relies on.
   */
  readonly?: boolean;
  /** Injected transport. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Injected delay, so tests never wait on backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected randomness for jitter. */
  random?: () => number;
  /** Per-request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /** Retry policy overrides applied to every provider. */
  retry?: Partial<RetryPolicy>;
  /** `User-Agent` sent with every request. */
  userAgent?: string;
}

/** Default API and web endpoints per provider. */
const DEFAULT_ENDPOINTS: Readonly<Record<Provider, { api: string; web: string }>> = {
  github: { api: 'https://api.github.com', web: 'https://github.com' },
  gitee: { api: 'https://gitee.com/api/v5', web: 'https://gitee.com' },
  atomgit: { api: 'https://api.atomgit.com/api/v5', web: 'https://atomgit.com' },
};

/** Environment variable that supplies each provider's token. */
const TOKEN_ENV_VARS: Readonly<Record<Provider, string>> = {
  github: 'GITHUB_TOKEN',
  gitee: 'GITEE_TOKEN',
  atomgit: 'ATOMGIT_TOKEN',
};

/** Everything the facade needs to serve one provider. */
interface ResolvedProvider {
  provider: Provider;
  adapter: ProviderAdapter;
  ctx: AdapterCtx;
  /** Env var consulted for the token, used in the `AUTH_MISSING` message. */
  tokenEnvVar: string;
  /** Whether a token was configured; mirrors {@link HttpClient.hasToken}. */
  hasToken: boolean;
}

/**
 * Validates an endpoint override.
 *
 * Plain `http:` is refused because a downgraded base URL would send the
 * `Authorization` header in cleartext. Loopback hosts are exempt so a test or a
 * local proxy can be pointed at without weakening the rule for real hosts.
 */
function assertEndpoint(
  provider: Provider,
  field: 'baseUrl' | 'webBaseUrl',
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string')
    throw invalidArgumentError(`Invalid ${provider}.${field}: expected a URL string`, provider);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidArgumentError(
      `Invalid \`${provider}.${field}\`: expected an absolute URL`,
      provider,
    );
  }
  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw invalidArgumentError(
      `Invalid \`${provider}.${field}\`: must use https: (http: is allowed for localhost only)`,
      provider,
    );
  }
}

/** Strips a trailing slash so path concatenation cannot double up. */
function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/* -------------------------------------------------------------------------- */
/* Per-method parameter validators                                            */
/* -------------------------------------------------------------------------- */

/** Validates list filters shared by issue and pull-request listing. */
function validateListFilters(params: { labels?: unknown; maxPages?: unknown }): void {
  assertStringArray('labels', params.labels);
  assertMaxPages(params.maxPages);
}

function validateListIssues(params: ListIssuesParams): void {
  assertRepoRef(params);
  assertOptionalOneOf('state', params.state, ['open', 'closed', 'all']);
  assertOptionalPositiveInt('milestone', params.milestone);
  validateListFilters(params);
}

function validateGetIssue(params: GetIssueParams): void {
  assertRepoRef(params);
  assertNativeId('number', params.number);
}

function validateCreateIssue(params: CreateIssueParams): void {
  assertRepoRef(params);
  assertNonEmpty('title', params.title);
  assertOptionalString('body', params.body);
  assertOptionalPositiveInt('milestone', params.milestone);
  assertStringArray('labels', params.labels);
}

function validateUpdateIssue(params: UpdateIssueParams): void {
  assertRepoRef(params);
  assertNativeId('number', params.number);
  assertOptionalNonEmpty('title', params.title);
  assertOptionalString('body', params.body);
  assertOptionalOneOf('state', params.state, ['open', 'closed']);
  assertOptionalPositiveInt('milestone', params.milestone);
  assertStringArray('labels', params.labels);
}

function validateListComments(params: ListCommentsParams): void {
  assertRepoRef(params);
  assertNativeId('number', params.number);
  assertMaxPages(params.maxPages);
}

function validateGetPullRequest(params: GetPullRequestParams): void {
  assertRepoRef(params);
  if (!Number.isSafeInteger(params.number) || params.number <= 0) {
    throw invalidArgumentError('Invalid `number`: expected a positive safe integer');
  }
}

function validateListPullRequests(params: ListPullRequestsParams): void {
  assertRepoRef(params);
  assertOptionalOneOf('state', params.state, ['open', 'closed', 'all']);
  assertOptionalNonEmpty('head', params.head);
  assertOptionalNonEmpty('base', params.base);
  assertOptionalPositiveInt('milestone', params.milestone);
  validateListFilters(params);
}

function validateCreatePullRequest(params: CreatePullRequestParams): void {
  assertRepoRef(params);
  assertNonEmpty('title', params.title);
  assertNonEmpty('head', params.head);
  assertNonEmpty('base', params.base);
  assertOptionalString('body', params.body);
  assertOptionalBoolean('draft', params.draft);
}

function validateCreateComment(params: CreateCommentParams): void {
  assertRepoRef(params);
  assertNativeId('number', params.number);
  assertNonEmpty('body', params.body);
}

function validateMergePullRequest(params: MergePullRequestParams): void {
  validateGetPullRequest(params);
  assertOptionalOneOf('merge_method', params.merge_method, ['merge', 'squash', 'rebase']);
  assertOptionalString('commit_title', params.commit_title);
  assertOptionalString('commit_message', params.commit_message);
}

function validateListRepositories(params: ListRepositoriesParams): void {
  if (params.org !== undefined && params.user !== undefined) {
    throw invalidArgumentError('Invalid `org`/`user`: provide at most one of them');
  }
  assertOptionalPathSegment('org', params.org);
  assertOptionalPathSegment('user', params.user);
  assertMaxPages(params.maxPages);
}

function validateCreateRepository(params: CreateRepositoryParams): void {
  assertNonEmpty('name', params.name);
  assertOptionalString('description', params.description);
  assertOptionalBoolean('private', params.private);
  assertOptionalBoolean('auto_init', params.auto_init);
  assertOptionalPathSegment('org', params.org);
}

function validateGetFileContents(params: GetFileContentsParams): void {
  assertRepoRef(params);
  assertFilePath('path', params.path);
  assertOptionalNonEmpty('ref', params.ref);
}

function validateCreateOrUpdateFile(params: CreateOrUpdateFileParams): void {
  assertRepoRef(params);
  assertFilePath('path', params.path);
  if (typeof params.content !== 'string') {
    throw invalidArgumentError('Invalid `content`: expected a string');
  }
  assertNonEmpty('message', params.message);
  assertOptionalNonEmpty('branch', params.branch);
  assertOptionalNonEmpty('sha', params.sha);
  assertOptionalOneOf('encoding', params.encoding, ['base64', 'utf8']);
}

function validateDeleteFile(params: DeleteFileParams): void {
  assertRepoRef(params);
  assertFilePath('path', params.path);
  assertNonEmpty('message', params.message);
  assertNonEmpty('sha', params.sha);
  assertOptionalNonEmpty('branch', params.branch);
}

function validatePushFiles(params: PushFilesParams): void {
  assertRepoRef(params);
  assertPushFilesParams(params);
}

function validateCreateBranch(params: CreateBranchParams): void {
  assertRepoRef(params);
  assertNonEmpty('name', params.name);
  assertNonEmpty('from', params.from);
}

function validateListCommits(params: ListCommitsParams): void {
  assertRepoRef(params);
  assertOptionalNonEmpty('branch', params.branch);
  assertMaxPages(params.maxPages);
}

function validateGetCommit(params: GetCommitParams): void {
  assertRepoRef(params);
  assertNonEmpty('sha', params.sha);
}

/**
 * The shared SDK client.
 *
 * One instance holds one {@link HttpClient} per provider, so a GitHub token can
 * never reach a Gitee request even if an adapter were to pass the wrong context.
 * Instances are safe to share: no method mutates client state.
 */
export class GitClient {
  /** Whether write capabilities are refused. */
  readonly readonly: boolean;

  private readonly providers: Readonly<Record<Provider, ResolvedProvider>>;

  constructor(options: GitClientOptions = {}) {
    this.readonly = options.readonly === true;
    this.providers = {
      github: this.resolve('github', options),
      gitee: this.resolve('gitee', options),
      atomgit: this.resolve('atomgit', options),
    };
  }

  /** Providers that have a token configured. Names only — never values. */
  configuredProviders(): Provider[] {
    return (['github', 'gitee', 'atomgit'] as const).filter(
      (provider) => this.providers[provider].hasToken,
    );
  }

  /** Capability table of one provider, for callers that render a matrix. */
  capabilities(provider: Provider): ProviderAdapter['capabilities'] {
    assertProvider(provider);
    return this.providers[provider].adapter.capabilities;
  }

  /** Parameter-level capability table of one provider. */
  paramCapabilities(provider: Provider): ProviderAdapter['paramCapabilities'] {
    assertProvider(provider);
    return this.providers[provider].adapter.paramCapabilities;
  }

  /* ---------------------------------------------------------------------- */
  /* Issue                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Lists issues, aggregating every page. */
  listIssues(params: ProviderParams<ListIssuesParams>): Promise<Issue[]> {
    return this.dispatch('listIssues', 'issues.list', params, validateListIssues, (p, ctx) =>
      ctx.adapter.listIssues(ctx.ctx, p),
    );
  }

  /** Reads one issue. */
  getIssue(params: ProviderParams<GetIssueParams>): Promise<Issue> {
    return this.dispatch('getIssue', 'issues.get', params, validateGetIssue, (p, ctx) =>
      ctx.adapter.getIssue(ctx.ctx, p),
    );
  }

  /** Creates an issue. */
  createIssue(params: ProviderParams<CreateIssueParams>): Promise<Issue> {
    return this.dispatch('createIssue', 'issues.create', params, validateCreateIssue, (p, ctx) =>
      ctx.adapter.createIssue(ctx.ctx, p),
    );
  }

  /** Updates an issue, leaving omitted fields untouched. */
  updateIssue(params: ProviderParams<UpdateIssueParams>): Promise<Issue> {
    return this.dispatch('updateIssue', 'issues.update', params, validateUpdateIssue, (p, ctx) =>
      ctx.adapter.updateIssue(ctx.ctx, p),
    );
  }

  /** Lists an issue's comments. */
  listIssueComments(params: ProviderParams<ListCommentsParams>): Promise<Comment[]> {
    return this.dispatch(
      'listIssueComments',
      'issues.listComments',
      params,
      validateListComments,
      (p, ctx) => ctx.adapter.listIssueComments(ctx.ctx, p),
    );
  }

  /** Adds a comment to an issue. */
  createIssueComment(params: ProviderParams<CreateCommentParams>): Promise<Comment> {
    return this.dispatch(
      'createIssueComment',
      'issues.createComment',
      params,
      validateCreateComment,
      (p, ctx) => ctx.adapter.createIssueComment(ctx.ctx, p),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Pull request                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists pull requests.
   *
   * The `head` filter goes through the parameter capability gate: AtomGit has no
   * such filter, and returning an unfiltered list would be undetectable.
   */
  listPullRequests(params: ProviderParams<ListPullRequestsParams>): Promise<PullRequest[]> {
    return this.dispatch(
      'listPullRequests',
      'pulls.list',
      params,
      validateListPullRequests,
      (p, ctx) => ctx.adapter.listPullRequests(ctx.ctx, p),
      (p, ctx) => {
        if (p.head !== undefined) {
          this.assertParamCapability(ctx, 'pulls.list.headFilter');
        }
        if (p.milestone !== undefined) {
          this.assertParamCapability(ctx, 'pulls.list.milestoneFilter');
        }
      },
    );
  }

  /** Reads one pull request. */
  getPullRequest(params: ProviderParams<GetPullRequestParams>): Promise<PullRequest> {
    return this.dispatch('getPullRequest', 'pulls.get', params, validateGetPullRequest, (p, ctx) =>
      ctx.adapter.getPullRequest(ctx.ctx, p),
    );
  }

  /** Opens a pull request. */
  createPullRequest(params: ProviderParams<CreatePullRequestParams>): Promise<PullRequest> {
    return this.dispatch(
      'createPullRequest',
      'pulls.create',
      params,
      validateCreatePullRequest,
      (p, ctx) => ctx.adapter.createPullRequest(ctx.ctx, p),
    );
  }

  /** Merges a pull request and returns its post-merge state. */
  mergePullRequest(params: ProviderParams<MergePullRequestParams>): Promise<PullRequest> {
    return this.dispatch(
      'mergePullRequest',
      'pulls.merge',
      params,
      validateMergePullRequest,
      (p, ctx) => ctx.adapter.mergePullRequest(ctx.ctx, p),
    );
  }

  /** Lists a pull request's comments. */
  listPullRequestComments(params: ProviderParams<ListCommentsParams>): Promise<Comment[]> {
    return this.dispatch(
      'listPullRequestComments',
      'pulls.listComments',
      params,
      validateListComments,
      (p, ctx) => ctx.adapter.listPullRequestComments(ctx.ctx, p),
    );
  }

  /** Adds a comment to a pull request. */
  createPullRequestComment(params: ProviderParams<CreateCommentParams>): Promise<Comment> {
    return this.dispatch(
      'createPullRequestComment',
      'pulls.createComment',
      params,
      validateCreateComment,
      (p, ctx) => ctx.adapter.createPullRequestComment(ctx.ctx, p),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Repository                                                             */
  /* ---------------------------------------------------------------------- */

  /** Lists repositories of an org, a user, or the authenticated account. */
  listRepositories(params: ProviderParams<ListRepositoriesParams>): Promise<Repository[]> {
    return this.dispatch(
      'listRepositories',
      'repos.list',
      params,
      validateListRepositories,
      (p, ctx) => ctx.adapter.listRepositories(ctx.ctx, p),
    );
  }

  /** Reads one repository. */
  getRepository(params: ProviderParams<GetRepositoryParams>): Promise<Repository> {
    return this.dispatch('getRepository', 'repos.get', params, assertRepoRef, (p, ctx) =>
      ctx.adapter.getRepository(ctx.ctx, p),
    );
  }

  /** Creates a repository. */
  createRepository(params: ProviderParams<CreateRepositoryParams>): Promise<Repository> {
    return this.dispatch(
      'createRepository',
      'repos.create',
      params,
      validateCreateRepository,
      (p, ctx) => ctx.adapter.createRepository(ctx.ctx, p),
    );
  }

  /** Reads one file's content. Directory paths are rejected by the adapters. */
  getFileContents(params: ProviderParams<GetFileContentsParams>): Promise<FileContent> {
    return this.dispatch(
      'getFileContents',
      'repos.getFileContents',
      params,
      validateGetFileContents,
      (p, ctx) => ctx.adapter.getFileContents(ctx.ctx, p),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Files                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates or replaces one file.
   *
   * `sha` selects the endpoint: absent means create, present means update. The
   * capability gate follows that choice so a provider that served one but not
   * the other would still be blocked correctly.
   */
  createOrUpdateFile(params: ProviderParams<CreateOrUpdateFileParams>): Promise<FileWriteResult> {
    return this.dispatch(
      'createOrUpdateFile',
      (p) => (p.sha === undefined ? 'files.create' : 'files.update'),
      params,
      validateCreateOrUpdateFile,
      (p, ctx) =>
        p.sha === undefined
          ? ctx.adapter.createFile(ctx.ctx, p)
          : ctx.adapter.updateFile(ctx.ctx, p),
    );
  }

  /** Deletes one file. */
  deleteFile(params: ProviderParams<DeleteFileParams>): Promise<FileWriteResult> {
    return this.dispatch('deleteFile', 'files.delete', params, validateDeleteFile, (p, ctx) =>
      ctx.adapter.deleteFile(ctx.ctx, p),
    );
  }

  /**
   * Commits every entry of a batch in one commit.
   *
   * AtomGit cannot do this and is refused by the capability gate; the batch is
   * never split into N single-file commits.
   */
  pushFiles(params: ProviderParams<PushFilesParams>): Promise<FileWriteResult> {
    return this.dispatch('pushFiles', 'files.pushFiles', params, validatePushFiles, (p, ctx) =>
      ctx.adapter.pushFiles(ctx.ctx, p),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Branch / Commit                                                        */
  /* ---------------------------------------------------------------------- */

  /** Lists branches. */
  listBranches(params: ProviderParams<ListBranchesParams>): Promise<Branch[]> {
    return this.dispatch(
      'listBranches',
      'branches.list',
      params,
      (p) => {
        assertRepoRef(p);
        assertMaxPages(p.maxPages);
      },
      (p, ctx) => ctx.adapter.listBranches(ctx.ctx, p),
    );
  }

  /** Creates a branch from a branch name or commit sha. */
  createBranch(params: ProviderParams<CreateBranchParams>): Promise<Branch> {
    return this.dispatch(
      'createBranch',
      'branches.create',
      params,
      validateCreateBranch,
      (p, ctx) => ctx.adapter.createBranch(ctx.ctx, p),
    );
  }

  /** Lists commits. */
  listCommits(params: ProviderParams<ListCommitsParams>): Promise<Commit[]> {
    return this.dispatch('listCommits', 'commits.list', params, validateListCommits, (p, ctx) =>
      ctx.adapter.listCommits(ctx.ctx, p),
    );
  }

  /** Reads one commit. */
  getCommit(params: ProviderParams<GetCommitParams>): Promise<Commit> {
    return this.dispatch('getCommit', 'commits.get', params, validateGetCommit, (p, ctx) =>
      ctx.adapter.getCommit(ctx.ctx, p),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Bulk                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Runs a task per item with partial-failure isolation.
   *
   * Delegates to `core/bulk.ts` so the batching semantics (bounded concurrency,
   * `{ok, index}` results, never rejecting) are identical to the standalone
   * helper.
   */
  bulk<A, T>(
    items: readonly A[],
    run: (item: A, index: number) => Promise<T>,
    options?: BulkOptions,
  ): Promise<BulkItemResult<T>[]> {
    return runBulk(items, run, options);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** Builds the per-provider bundle consumed by every method. */
  private resolve(provider: Provider, options: GitClientOptions): ResolvedProvider {
    const credentials: ProviderCredentials = options[provider] ?? {};
    const defaults = DEFAULT_ENDPOINTS[provider];

    assertEndpoint(provider, 'baseUrl', credentials.baseUrl);
    assertEndpoint(provider, 'webBaseUrl', credentials.webBaseUrl);

    const baseUrl = trimSlash(credentials.baseUrl ?? defaults.api);
    const webBaseUrl = trimSlash(credentials.webBaseUrl ?? defaults.web);
    const token =
      credentials.token !== undefined && credentials.token.length > 0
        ? credentials.token
        : undefined;

    const http = new HttpClient({
      baseUrl,
      provider,
      // All provider tokens travel in the Authorization header.
      auth: { style: 'bearer' },
      token,
      fetch: options.fetch,
      sleep: options.sleep,
      random: options.random,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retry: options.retry,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    });

    const adapter = getAdapter(provider);
    return {
      provider,
      adapter,
      tokenEnvVar: TOKEN_ENV_VARS[provider],
      hasToken: http.hasToken,
      ctx: {
        http,
        caps: adapter.capabilities,
        paramCaps: adapter.paramCapabilities,
        webBaseUrl,
      },
    };
  }

  /** Throws unless a parameter-level capability is supported. */
  private assertParamCapability(ctx: ResolvedProvider, capability: ParamCapabilityId): void {
    if (ctx.ctx.paramCaps[capability] !== 'supported') {
      throw unsupportedCapabilityError(ctx.provider, capability);
    }
  }

  /**
   * Runs the five gates in order, then dispatches to the adapter.
   *
   * `async` on purpose: a gate failure must reject the returned promise rather
   * than throw synchronously, so `await`/`.catch()` behave identically for a
   * refused call and for a failed request.
   *
   * @param method      Method name, used in validation and read-only messages.
   * @param capabilityFor  Method-level capability, or a selector evaluated after validation.
   * @param params      Caller payload; `provider` is read from it.
   * @param validate    Parameter validator, run before any other gate.
   * @param run         Adapter call, reached only when every gate passes.
   * @param paramGate   Optional parameter-level capability check.
   */
  private async dispatch<TParams extends { provider: Provider }, TResult>(
    method: string,
    capabilityFor: CapabilityId | ((params: TParams) => CapabilityId),
    params: TParams,
    validate: (params: TParams) => void,
    run: (params: TParams, ctx: ResolvedProvider) => Promise<TResult>,
    paramGate?: (params: TParams, ctx: ResolvedProvider) => void,
  ): Promise<TResult> {
    // Gate 1: the payload itself. Runs first so a malformed call is never
    // misreported as an auth or capability failure.
    assertParamsObject(params, method);
    assertProvider(params.provider);
    try {
      validate(params);
    } catch (error) {
      throw withProvider(error, params.provider);
    }

    const capability = typeof capabilityFor === 'function' ? capabilityFor(params) : capabilityFor;
    const ctx = this.providers[params.provider];

    // Gate 2: read-only policy, decidable without credentials.
    if (this.readonly && isWriteCapability(capability)) {
      throw readonlyBlockedError(params.provider, capability, method);
    }

    // Gate 3: credentials.
    if (!ctx.hasToken) {
      throw authMissingError(params.provider, ctx.tokenEnvVar);
    }

    // Gate 4: is the method served by this provider at all?
    if (ctx.adapter.capabilities[capability] !== 'supported') {
      throw unsupportedCapabilityError(params.provider, capability);
    }

    // Gate 5: is the requested filter served?
    paramGate?.(params, ctx);

    return run(params, ctx);
  }
}

/**
 * Attaches the resolved provider to a validation error, if it lacks one.
 *
 * The `core` validators are provider-agnostic by design, so they build
 * `GitForgeError` without a `provider`. A caller reading a validation failure
 * still needs to know which platform the refused call targeted, so the facade —
 * the only layer that knows `params.provider` — stamps it on.
 */
function withProvider(error: unknown, provider: Provider): unknown {
  if (error instanceof GitForgeError && error.provider === undefined) {
    return new GitForgeError({
      code: error.code,
      message: error.message,
      provider,
      status: error.status,
      requestId: error.requestId,
      capability: error.capability,
      retryable: error.retryable,
      cause: error.cause,
    });
  }
  return error;
}
