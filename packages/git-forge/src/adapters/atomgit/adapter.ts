/**
 * AtomGit adapter: endpoint assembly plus AtomGit-specific semantics.
 *
 * Four AtomGit facts shape this file:
 *
 * - Missing pull-request heads may be recovered from one list page, matched by number.
 * - pull-request lists have no `head` filter; passing one raises
 *   `UNSUPPORTED_ON_PROVIDER` instead of silently returning everything.
 * - issue writes are owner-scoped with `repo` in the body, and the
 *   update body requires `title`, so a state-only update reads the issue first.
 * - response `url` fields point at `atomgit.com/api/v5/...`; every
 *   request is built from the configured base URL instead.
 */
import { selectIssueRows } from '../issues.js';
import { collectPullRequests, pullFromResponse, requirePullNumber } from '../pulls.js';
import { confirmedSha, contentsBase64 } from '../../core/file-write.js';
import { invalidArgumentError } from '../../core/errors.js';
import { collectPages } from '../../core/paginate.js';
import type {
  AdapterCtx,
  BranchCommitDomain,
  FilesDomain,
  IssueDomain,
  ProviderAdapter,
  PullRequestDomain,
  RepositoryDomain,
  WithProvider,
} from '../types.js';
import { unsupported } from '../types.js';
import {
  asArray,
  asRecord,
  deriveBranchHtmlUrl,
  deriveParentHtmlUrl,
  headFilterUnsupported,
  joinLabels,
  listKey,
  mapBranch,
  mapComment,
  mapCommit,
  mapFileContent,
  mapIssue,
  mapPullRequest,
  mapRepository,
  mapRef,
  str,
  toAtomGitState,
} from './map.js';
import { capabilities, paramCapabilities } from './capabilities.js';
import type {
  Branch,
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
  PullRequest,
  Repository,
  UpdateIssueParams,
} from '../../core/types.js';

/** Base path segment repeated by nearly every endpoint. */
const REPO_PATH = '/repos/{owner}/{repo}';

/** Page size used by the bounded backfill list call. */
const HEAD_BACKFILL_PER_PAGE = 100;

/** Builds the path-parameter bag for a repository-scoped request. */
function repoParams(owner: string, repo: string): Record<string, string> {
  return { owner, repo };
}

/** Rejects a create call that carries an update's blob sha. */
function assertCreation(params: CreateOrUpdateFileParams): void {
  if (params.sha !== undefined) {
    throw invalidArgumentError(
      'Invalid `sha`: createFile creates a new file and must not receive a blob sha; use updateFile to replace an existing file.',
      'atomgit',
    );
  }
}

/** Rejects an update call without the blob sha AtomGit requires. */
function assertUpdate(params: CreateOrUpdateFileParams): void {
  if (params.sha === undefined || params.sha.length === 0) {
    throw invalidArgumentError(
      'Invalid `sha`: updateFile requires the current blob sha of the file being replaced.',
      'atomgit',
    );
  }
}

/** Domain implementation backed by api.atomgit.com/api/v5. */
class AtomGitAdapter
  implements IssueDomain, PullRequestDomain, RepositoryDomain, FilesDomain, BranchCommitDomain
{
  readonly provider = 'atomgit' as const;
  readonly capabilities = capabilities;
  readonly paramCapabilities = paramCapabilities;

  /* ---------------------------------------------------------------------- */
  /* Issue                                                                  */
  /* ---------------------------------------------------------------------- */

  async listIssues(ctx: AdapterCtx, params: WithProvider<ListIssuesParams>): Promise<Issue[]> {
    const entries = await collectPages<unknown>(
      ctx.http,
      {
        method: 'GET',
        path: `${REPO_PATH}/issues`,
        pathParams: repoParams(params.owner, params.repo),
      },
      {
        maxPages: params.maxPages,
        requireComplete: params.requireComplete,
        query: {
          state: params.state,
          labels: joinLabels(params.labels),
          // AtomGit's issue filter takes the milestone ordinal.
          milestone: params.milestone,
        },
        selectItems: (_raw, { response }) => selectIssueRows(ctx.http, response),
        keyOf: (raw) => listKey(asRecord(raw).number),
      },
    );
    return entries.map((entry) => mapIssue(params.owner, params.repo, entry));
  }

  async getIssue(ctx: AdapterCtx, params: WithProvider<GetIssueParams>): Promise<Issue> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/issues/{number}`,
      pathParams: { ...repoParams(params.owner, params.repo), number: String(params.number) },
    });
    return mapIssue(params.owner, params.repo, response.json);
  }

  async createIssue(ctx: AdapterCtx, params: WithProvider<CreateIssueParams>): Promise<Issue> {
    // Owner-scoped path: the repository-scoped path serves GET only.
    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path: '/repos/{owner}/issues',
      pathParams: { owner: params.owner },
      body: {
        repo: params.repo,
        title: params.title,
        body: params.body,
        labels: joinLabels(params.labels),
        milestone: params.milestone,
      },
    });
    return mapIssue(params.owner, params.repo, response.json);
  }

  /**
   * Updates an issue.
   *
   * AtomGit requires both `repo` and `title` on this endpoint, so a caller that
   * omits `title` costs one extra read to fill it in. That is the documented
   * trade-off: sending the update without a title is a 422.
   */
  async updateIssue(ctx: AdapterCtx, params: WithProvider<UpdateIssueParams>): Promise<Issue> {
    const title =
      params.title ?? (await this.getIssue(ctx, { ...params, number: params.number })).title;

    const body: Record<string, unknown> = {
      repo: params.repo,
      title,
      body: params.body,
      labels: joinLabels(params.labels),
      milestone: params.milestone,
    };
    if (params.state !== undefined) {
      body.state = toAtomGitState(params.state);
    }

    const response = await ctx.http.request<unknown>({
      method: 'PATCH',
      path: '/repos/{owner}/issues/{number}',
      pathParams: { owner: params.owner, number: String(params.number) },
      body,
    });
    return mapIssue(params.owner, params.repo, response.json);
  }

  async listIssueComments(
    ctx: AdapterCtx,
    params: WithProvider<ListCommentsParams>,
  ): Promise<Comment[]> {
    const parentUrl = deriveParentHtmlUrl(
      ctx.webBaseUrl,
      params.owner,
      params.repo,
      'issues',
      params.number,
    );
    return this.listComments(ctx, params, `${REPO_PATH}/issues/{number}/comments`, parentUrl);
  }

  async createIssueComment(
    ctx: AdapterCtx,
    params: WithProvider<CreateCommentParams>,
  ): Promise<Comment> {
    const parentUrl = deriveParentHtmlUrl(
      ctx.webBaseUrl,
      params.owner,
      params.repo,
      'issues',
      params.number,
    );
    return this.createComment(ctx, params, `${REPO_PATH}/issues/{number}/comments`, parentUrl);
  }

  /* ---------------------------------------------------------------------- */
  /* Pull request                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists pull requests.
   *
   * `head` is rejected before any request: AtomGit has no such filter, and
   * returning an unfiltered list would let a caller believe it was filtered.
   */
  async listPullRequests(
    ctx: AdapterCtx,
    params: WithProvider<ListPullRequestsParams>,
  ): Promise<PullRequest[]> {
    if (params.head !== undefined) {
      headFilterUnsupported();
    }

    return collectPullRequests(ctx, params, mapPullRequest, {
      states: params.state === 'closed' ? ['closed', 'merged', 'locked'] : [params.state],
      query: {
        base: params.base,
        labels: joinLabels(params.labels),
        milestone_number: params.milestone,
      },
    });
  }

  /**
   * Reads one pull request. When detail omits the head, try one list page;
   * if neither response contains it, leave it absent.
   */
  async getPullRequest(
    ctx: AdapterCtx,
    params: WithProvider<GetPullRequestParams>,
  ): Promise<PullRequest> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/pulls/{number}`,
      pathParams: { ...repoParams(params.owner, params.repo), number: String(params.number) },
    });
    requirePullNumber(ctx.http, response, response.json, params.number);
    const detail = asRecord(response.json);
    if (mapRef(detail.head) && mapRef(detail.base)) {
      return pullFromResponse(mapPullRequest, ctx, params, response);
    }
    // Only the same PR may supply a missing ref. Do not invent either ref if
    // the bounded list page does not include it.
    const other = await this.findPullRefs(ctx, params);
    return pullFromResponse(mapPullRequest, ctx, params, response, {
      raw: {
        ...detail,
        head: mapRef(detail.head) ?? other?.head,
        base: mapRef(detail.base) ?? other?.base,
      },
    });
  }

  async createPullRequest(
    ctx: AdapterCtx,
    params: WithProvider<CreatePullRequestParams>,
  ): Promise<PullRequest> {
    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/pulls`,
      pathParams: repoParams(params.owner, params.repo),
      body: {
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
        draft: params.draft,
      },
    });
    return pullFromResponse(mapPullRequest, ctx, params, response);
  }

  async mergePullRequest(
    ctx: AdapterCtx,
    params: WithProvider<MergePullRequestParams>,
  ): Promise<PullRequest> {
    await ctx.http.request<unknown>({
      method: 'PUT',
      path: `${REPO_PATH}/pulls/{number}/merge`,
      pathParams: { ...repoParams(params.owner, params.repo), number: String(params.number) },
      body: {
        merge_method: params.merge_method,
        title: params.commit_title,
        description: params.commit_message,
      },
    });

    // The contract returns a PullRequest, so the merged state is read back.
    return this.getPullRequest(ctx, params);
  }

  async listPullRequestComments(
    ctx: AdapterCtx,
    params: WithProvider<ListCommentsParams>,
  ): Promise<Comment[]> {
    const parentUrl = deriveParentHtmlUrl(
      ctx.webBaseUrl,
      params.owner,
      params.repo,
      'merge_requests',
      params.number,
    );
    // AtomGit's PR comments live under `/merge_requests/{n}/notes` in the UI but
    // the API keeps the Gitee-compatible `/pulls/{n}/comments` path.
    return this.listComments(ctx, params, `${REPO_PATH}/pulls/{number}/comments`, parentUrl);
  }

  async createPullRequestComment(
    ctx: AdapterCtx,
    params: WithProvider<CreateCommentParams>,
  ): Promise<Comment> {
    const parentUrl = deriveParentHtmlUrl(
      ctx.webBaseUrl,
      params.owner,
      params.repo,
      'merge_requests',
      params.number,
    );
    return this.createComment(ctx, params, `${REPO_PATH}/pulls/{number}/comments`, parentUrl);
  }

  /* ---------------------------------------------------------------------- */
  /* Repository                                                             */
  /* ---------------------------------------------------------------------- */

  async listRepositories(
    ctx: AdapterCtx,
    params: WithProvider<ListRepositoriesParams>,
  ): Promise<Repository[]> {
    const path =
      params.org !== undefined
        ? '/orgs/{org}/repos'
        : params.user !== undefined
          ? '/users/{user}/repos'
          : '/user/repos';
    const pathParams: Record<string, string> =
      params.org !== undefined
        ? { org: params.org }
        : params.user !== undefined
          ? { user: params.user }
          : {};

    const entries = await collectPages<unknown>(
      ctx.http,
      { method: 'GET', path, pathParams },
      {
        maxPages: params.maxPages,
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).id ?? asRecord(raw).full_name),
      },
    );

    return entries.map((entry) => {
      const record = asRecord(entry);
      const owner = str(asRecord(record.namespace).path) ?? params.org ?? params.user ?? '';
      const repo = str(record.name) ?? str(record.path) ?? '';
      return mapRepository(owner, repo, record);
    });
  }

  async getRepository(
    ctx: AdapterCtx,
    params: WithProvider<GetRepositoryParams>,
  ): Promise<Repository> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: REPO_PATH,
      pathParams: repoParams(params.owner, params.repo),
    });
    return mapRepository(params.owner, params.repo, response.json);
  }

  async createRepository(
    ctx: AdapterCtx,
    params: WithProvider<CreateRepositoryParams>,
  ): Promise<Repository> {
    const path = params.org !== undefined ? '/orgs/{org}/repos' : '/user/repos';
    const pathParams: Record<string, string> = params.org !== undefined ? { org: params.org } : {};

    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path,
      pathParams,
      body: {
        name: params.name,
        description: params.description,
        private: params.private,
        auto_init: params.auto_init,
      },
    });

    const record = asRecord(response.json);
    const owner = str(asRecord(record.namespace).path) ?? params.org ?? '';
    const repo = str(record.name) ?? params.name;
    return mapRepository(owner, repo, record);
  }

  async getFileContents(
    ctx: AdapterCtx,
    params: WithProvider<GetFileContentsParams>,
  ): Promise<FileContent> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/contents/{path}`,
      pathParams: { owner: params.owner, repo: params.repo, path: params.path },
      query: { ref: params.ref },
    });

    // A missing path is a 404 `{error_code:404,...}` on AtomGit (unlike Gitee's
    // `200 + []`), which `core` already maps to NOT_FOUND. An array still means
    // "directory", which v0.1.0 cannot represent.
    if (Array.isArray(response.json)) {
      throw invalidArgumentError(
        `Invalid \`path\`: "${params.path}" is a directory. v0.1.0 getFileContents reads a single file only.`,
        'atomgit',
      );
    }
    return mapFileContent(params.owner, params.repo, response.json);
  }

  /* ---------------------------------------------------------------------- */
  /* Files                                                                  */
  /* ---------------------------------------------------------------------- */

  async createFile(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams>,
  ): Promise<FileWriteResult> {
    assertCreation(params);
    return this.writeContents(ctx, params, 'POST');
  }

  async updateFile(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams>,
  ): Promise<FileWriteResult> {
    assertUpdate(params);
    return this.writeContents(ctx, params, 'PUT');
  }

  async deleteFile(
    ctx: AdapterCtx,
    params: WithProvider<DeleteFileParams>,
  ): Promise<FileWriteResult> {
    // AtomGit takes `sha` and `message` in the JSON body (Gitee puts them in the
    // query string — the one asymmetric spot between the two APIs).
    const response = await ctx.http.request<unknown>({
      method: 'DELETE',
      path: `${REPO_PATH}/contents/{path}`,
      pathParams: { owner: params.owner, repo: params.repo, path: params.path },
      body: { sha: params.sha, message: params.message, branch: params.branch },
    });

    const record = asRecord(response.json);
    const commit = asRecord(record.commit);
    return {
      provider: 'atomgit',
      owner: params.owner,
      repo: params.repo,
      commit_sha: confirmedSha(ctx.http, response, commit.sha),
      commit_html_url: str(commit.html_url) ?? '',
      paths: [params.path],
      branch: params.branch ?? '',
    };
  }

  /**
   * AtomGit has no batch commit endpoint, so this capability is not implemented.
   *
   * Splitting the batch into N single-file commits would break the contract's
   * "one commit" promise and could leave a partial, unrecoverable write.
   */
  pushFiles = unsupported('files.pushFiles', 'atomgit');

  /* ---------------------------------------------------------------------- */
  /* Branch / Commit                                                        */
  /* ---------------------------------------------------------------------- */

  async listBranches(ctx: AdapterCtx, params: WithProvider<ListBranchesParams>): Promise<Branch[]> {
    const entries = await collectPages<unknown>(
      ctx.http,
      {
        method: 'GET',
        path: `${REPO_PATH}/branches`,
        pathParams: repoParams(params.owner, params.repo),
      },
      {
        maxPages: params.maxPages,
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).name),
      },
    );
    return entries.map((entry) => mapBranch(params.owner, params.repo, entry, ctx.webBaseUrl));
  }

  async createBranch(ctx: AdapterCtx, params: WithProvider<CreateBranchParams>): Promise<Branch> {
    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/branches`,
      pathParams: repoParams(params.owner, params.repo),
      body: { refs: params.from, branch_name: params.name },
    });

    const record = asRecord(response.json);
    const name = str(record.name) ?? params.name;
    const branch: Branch = {
      provider: 'atomgit',
      owner: params.owner,
      repo: params.repo,
      name,
      commit_sha: confirmedSha(ctx.http, response, asRecord(record.commit).sha),
    };
    const isProtected = record.protected;
    if (typeof isProtected === 'boolean') {
      branch.protected = isProtected;
    }
    const htmlUrl = deriveBranchHtmlUrl(ctx.webBaseUrl, params.owner, params.repo, name);
    if (htmlUrl !== undefined) {
      branch.html_url = htmlUrl;
    }
    return branch;
  }

  async listCommits(ctx: AdapterCtx, params: WithProvider<ListCommitsParams>): Promise<Commit[]> {
    const entries = await collectPages<unknown>(
      ctx.http,
      {
        method: 'GET',
        path: `${REPO_PATH}/commits`,
        pathParams: repoParams(params.owner, params.repo),
      },
      {
        maxPages: params.maxPages,
        query: { sha: params.branch },
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).sha),
      },
    );
    return entries.map((entry) => mapCommit(params.owner, params.repo, entry));
  }

  async getCommit(ctx: AdapterCtx, params: WithProvider<GetCommitParams>): Promise<Commit> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/commits/{sha}`,
      pathParams: { ...repoParams(params.owner, params.repo), sha: params.sha },
    });
    return mapCommit(params.owner, params.repo, response.json);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** Look for refs on one bounded list page; only a verified native identity may supply them. */
  private async findPullRefs(
    ctx: AdapterCtx,
    params: WithProvider<GetPullRequestParams>,
  ): Promise<Partial<Pick<PullRequest, 'head' | 'base'>> | undefined> {
    const response = await ctx.http.request({
      method: 'GET',
      path: `${REPO_PATH}/pulls`,
      pathParams: repoParams(params.owner, params.repo),
      query: { state: 'all', per_page: HEAD_BACKFILL_PER_PAGE, page: 1 },
    });
    if (!Array.isArray(response.json))
      throw ctx.http.invalidResponse(response, 'Expected a pull request list');
    for (const raw of response.json) {
      if (requirePullNumber(ctx.http, response, raw) === params.number) {
        const row = asRecord(raw);
        return { head: mapRef(row.head), base: mapRef(row.base) };
      }
    }
    return undefined;
  }

  /** Shared comment listing used by both issue and pull-request domains. */
  private async listComments(
    ctx: AdapterCtx,
    params: WithProvider<ListCommentsParams>,
    path: string,
    parentUrl: string | undefined,
  ): Promise<Comment[]> {
    const entries = await collectPages<unknown>(
      ctx.http,
      {
        method: 'GET',
        path,
        pathParams: {
          ...repoParams(params.owner, params.repo),
          number: String(params.number),
        },
      },
      {
        maxPages: params.maxPages,
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).id),
      },
    );
    return entries.map((entry) => mapComment(params.owner, params.repo, entry, parentUrl));
  }

  /** Shared comment creation used by both comment domains. */
  private async createComment(
    ctx: AdapterCtx,
    params: WithProvider<CreateCommentParams>,
    path: string,
    parentUrl: string | undefined,
  ): Promise<Comment> {
    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path,
      pathParams: {
        ...repoParams(params.owner, params.repo),
        number: String(params.number),
      },
      body: { body: params.body },
    });
    return mapComment(params.owner, params.repo, response.json, parentUrl);
  }

  /** Creates or replaces one file through the `contents` endpoints. */
  private async writeContents(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams>,
    method: 'POST' | 'PUT',
  ): Promise<FileWriteResult> {
    const response = await ctx.http.request<unknown>({
      method,
      path: `${REPO_PATH}/contents/{path}`,
      pathParams: { owner: params.owner, repo: params.repo, path: params.path },
      body: {
        content: contentsBase64(params.content, params.encoding, 'atomgit'),
        message: params.message,
        branch: params.branch,
        sha: params.sha,
      },
    });

    const record = asRecord(response.json);
    const commit = asRecord(record.commit);
    const result: FileWriteResult = {
      provider: 'atomgit',
      owner: params.owner,
      repo: params.repo,
      commit_sha: confirmedSha(ctx.http, response, commit.sha),
      // AtomGit's commit objects do carry `html_url`.
      commit_html_url: str(commit.html_url) ?? '',
      paths: [params.path],
      branch: params.branch ?? '',
    };
    const fileUrl = str(asRecord(record.content).html_url);
    result.file_html_urls = [fileUrl];
    return result;
  }
}

/** The AtomGit adapter singleton registered by `adapters/index.ts`. */
export const atomgitAdapter: ProviderAdapter = new AtomGitAdapter();
