/**
 * Public entry of `@charles7c/git-forge`.
 *
 * Only the stable surface is exported from here: the {@link GitClient} facade,
 * models, the error type, the request layer and its helpers. Internal adapters
 * stay unexported so the public API cannot drift from the documented contract.
 */

/** Semantic version of this build. Kept in sync with `package.json`. */
export const VERSION = '0.1.0';

/* The facade: the only way to talk to a platform. */
export { GitClient } from './client.js';
export type { GitClientOptions, ProviderCredentials, ProviderParams } from './client.js';

/* Models and their input shapes. */
export {
  CAPABILITY_IDS,
  PARAM_CAPABILITY_IDS,
  PROVIDERS,
  type Branch,
  type CapabilityId,
  type CapabilityState,
  type CapabilityTable,
  type Comment,
  type Commit,
  type CommitAuthor,
  type ContentEncoding,
  type CreateBranchParams,
  type CreateCommentParams,
  type CreateIssueParams,
  type CreateOrUpdateFileParams,
  type CreatePullRequestParams,
  type CreateRepositoryParams,
  type DeleteFileParams,
  type FileContent,
  type FileWriteResult,
  type GetCommitParams,
  type GetFileContentsParams,
  type GetIssueParams,
  type GetPullRequestParams,
  type GetRepositoryParams,
  type Issue,
  type IssueState,
  type ListBranchesParams,
  type ListCommitsParams,
  type ListCommentsParams,
  type ListIssuesParams,
  type ListOptions,
  type ListPullRequestsParams,
  type ListRepositoriesParams,
  type MergeMethod,
  type MergePullRequestParams,
  type ModelIdentity,
  type NativeId,
  type ParamCapabilityId,
  type ParamCapabilityTable,
  type Provider,
  type PullRequest,
  type PullRequestRef,
  type PullRequestState,
  type PushFileAction,
  type PushFileEntry,
  type PushFilesParams,
  type RepoRef,
  type Repository,
  type UpdateIssueParams,
  type UserRef,
} from './core/types.js';

/* The single error type plus the helpers needed to build and inspect it. */
export {
  ERROR_CODES,
  GitForgeError,
  authMissingError,
  defaultRetryable,
  errorFromNetwork,
  errorFromResponse,
  extractRequestId,
  extractUpstreamMessage,
  invalidArgumentError,
  isGitForgeError,
  isRateLimitResponse,
  mapStatusToCode,
  readonlyBlockedError,
  retryableForStatus,
  unsupportedCapabilityError,
  type ErrorCode,
  type GitForgeErrorInit,
  type GitForgeErrorJson,
} from './core/errors.js';

/* Redaction: the only supported way to render a token-bearing value. */
export { REDACTED, isSensitiveKey, redactUrl, scrubSecrets } from './core/redact.js';

/* Request layer. */
export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  HttpClient,
  type AuthConfig,
  type AuthStyle,
  type HttpClientOptions,
  type HttpMethod,
  type HttpRequestSpec,
  type HttpResponse,
  type ParamsIn,
} from './core/http.js';

/* Retry policy. */
export {
  DEFAULT_RETRY_POLICY,
  computeDelay,
  isIdempotentMethod,
  isRetryableStatus,
  parseRetryAfter,
  resolveRetryPolicy,
  retryAfterFromHeaders,
  shouldRetry,
  type RetryDecisionInput,
} from './core/retry.js';
export type { RetryPolicy } from './core/retry.js';

/* Pagination. */
export {
  DEFAULT_MAX_PAGES,
  DEFAULT_PER_PAGE,
  MAX_PAGES_LIMIT,
  MAX_PER_PAGE,
  collectPages,
  dedupeBy,
  normalizeMaxPages,
  normalizePerPage,
  parseLinkHeader,
  readTotalCount,
  readTotalPage,
  resolveNextPage,
  type CollectOptions,
  type PageResult,
  type PageSignals,
} from './core/paginate.js';

/* Bulk partial-failure isolation. */
export {
  DEFAULT_BULK_CONCURRENCY,
  allSucceeded,
  bulk,
  partitionBulk,
  type BulkItemResult,
  type BulkOptions,
} from './core/bulk.js';

/* Validation helpers, including the write-capability set. */
export {
  WRITE_CAPABILITIES,
  assertCapabilityTableKeys,
  assertFilePath,
  assertMaxPages,
  assertNativeId,
  assertNonEmpty,
  assertNonEmptyStringArray,
  assertOneOf,
  assertOptionalFilePath,
  assertOptionalNonEmpty,
  assertOptionalPositiveInt,
  assertParamsObject,
  assertPathSegment,
  assertPositiveInt,
  assertProvider,
  assertRepoRef,
  assertStringArray,
  isWriteCapability,
} from './core/validate.js';
