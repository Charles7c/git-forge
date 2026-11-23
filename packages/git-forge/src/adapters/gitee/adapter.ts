/**
 * Gitee adapter: endpoint assembly plus Gitee-specific semantics.
 *
 * Three Gitee behaviours drive the shape of this file:
 *
 * - `state` is a single-value enum and `open` does *not* include
 *   `progressing`. A list call for `open` therefore fans out into two requests
 *   (`open` + `progressing`) and merges them; `closed` fans out into
 *   (`closed` + `rejected`). `all` is one request. Multi-value states are
 *   rejected outright by the platform (400), so this is the only way to get the
 *   full set.
 * - write endpoints parse `application/json`, so the shared JSON body
 *   encoding is used throughout; no form encoding is needed.
 * - issue writes are owner-scoped with `repo` in the body, and a
 *   missing file path answers `200 + []` rather than 404, so existence can never
 *   be decided from the status code.
 */
import { collectPullRequests, pullFromResponse } from '../pulls.js';
import type { HttpResponse } from '../../core/http.js';
import { confirmedSha, contentsBase64 } from '../../core/file-write.js';
import { invalidArgumentError } from '../../core/errors.js';
import { collectPages, dedupeBy } from '../../core/paginate.js';
import type {
  AdapterCtx,
  BranchCommitDomain,
  FilesDomain,
  IssueDomain,
  ProviderAdapter,
  PullRequestDomain,
  RepositoryDomain,
  PushFilesInput,
  WithProvider,
} from '../types.js';
import {
  asArray,
  asRecord,
  buildFileWriteResult,
  deriveBranchHtmlUrl,
  deriveParentHtmlUrl,
  joinLabels,
  listKey,
  mapBranch,
  mapComment,
  mapCommit,
  mapFileContent,
  mapIssue,
  mapPullRequest,
  mapRepository,
  readPushEntries,
  str,
  toGiteeEncoding,
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

/** The two platform states folded into the contract's `open`. */
const OPEN_STATES = ['open', 'progressing'] as const;

/** The two platform states folded into the contract's `closed`. */
const CLOSED_STATES = ['closed', 'rejected'] as const;

/** Base path segment repeated by nearly every endpoint. */
const REPO_PATH = '/repos/{owner}/{repo}';

/** Builds the path-parameter bag for a repository-scoped request. */
function repoParams(owner: string, repo: string): Record<string, string> {
  return { owner, repo };
}

/** Rejects a create call that carries an update's blob sha. */
function assertCreation(params: CreateOrUpdateFileParams): void {
  if (params.sha !== undefined) {
    throw invalidArgumentError(
      'Invalid `sha`: createFile creates a new file and must not receive a blob sha; use updateFile to replace an existing file.',
      'gitee',
    );
  }
}

/** Rejects an update call without the blob sha Gitee requires. */
function assertUpdate(params: CreateOrUpdateFileParams): void {
  if (params.sha === undefined || params.sha.length === 0) {
    throw invalidArgumentError(
      'Invalid `sha`: updateFile requires the current blob sha of the file being replaced.',
      'gitee',
    );
  }
}

/**
 * Rejects a numeric milestone on an issue list filter.
 *
 * Gitee's `state`-style list filter for milestones takes a *title*, not a
 * number. The contract accepts a number, so the call is refused rather than
 * sent with a value that would filter to nothing.
 */
function assertIssueMilestoneFilter(milestone: number | undefined): void {
  if (milestone !== undefined) {
    throw invalidArgumentError(
      'Invalid `milestone`: Gitee filters issues by milestone title, not by number. ' +
        'Use listPullRequests for a numeric milestone filter, or filter labels instead.',
      'gitee',
    );
  }
}

/** Domain implementation backed by gitee.com/api/v5. */
class GiteeAdapter
  implements IssueDomain, PullRequestDomain, RepositoryDomain, FilesDomain, BranchCommitDomain
{
  readonly provider = 'gitee' as const;
  readonly capabilities = capabilities;
  readonly paramCapabilities = paramCapabilities;

  /* ---------------------------------------------------------------------- */
  /* Issue                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists issues, fanning out across the platform's single-value states.
   *
   * Gitee's `open` excludes `progressing` and its `closed` excludes `rejected`,
   * so a single request would silently return a subset. An omitted state
   * follows GitHub's documented default (`open`) and therefore fans out too,
   * keeping "no state given" equivalent across providers.
   *
   * `maxPages` applies per platform state, so a fan-out can issue up to
   * `2 * maxPages` requests.
   */
  async listIssues(ctx: AdapterCtx, params: WithProvider<ListIssuesParams>): Promise<Issue[]> {
    assertIssueMilestoneFilter(params.milestone);

    const states = resolveIssueStates(params.state);
    const collected: unknown[] = [];

    for (const state of states) {
      const entries = await this.collectIssues(ctx, params, state);
      collected.push(...entries);
    }

    const merged = dedupeBy(collected, (raw) => listKey(asRecord(raw).number));
    return merged.map((raw) => mapIssue(params.owner, params.repo, raw));
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
    // Owner-scoped path with `repo` in the body: the repository-scoped path only
    // serves GET.
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

  async updateIssue(ctx: AdapterCtx, params: WithProvider<UpdateIssueParams>): Promise<Issue> {
    const response = await ctx.http.request<unknown>({
      method: 'PATCH',
      path: '/repos/{owner}/issues/{number}',
      pathParams: { owner: params.owner, number: String(params.number) },
      body: {
        repo: params.repo,
        title: params.title,
        body: params.body,
        state: params.state,
        labels: joinLabels(params.labels),
        milestone: params.milestone,
      },
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

  async listPullRequests(
    ctx: AdapterCtx,
    params: WithProvider<ListPullRequestsParams>,
  ): Promise<PullRequest[]> {
    return collectPullRequests(ctx, params, mapPullRequest, {
      states: params.state === 'closed' ? ['closed', 'merged'] : [params.state],
      query: {
        head: params.head,
        base: params.base,
        labels: joinLabels(params.labels),
        milestone_number: params.milestone,
      },
    });
  }

  async getPullRequest(
    ctx: AdapterCtx,
    params: WithProvider<GetPullRequestParams>,
  ): Promise<PullRequest> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/pulls/{number}`,
      pathParams: { ...repoParams(params.owner, params.repo), number: String(params.number) },
    });
    return pullFromResponse(mapPullRequest, ctx, params, response, {
      expectedNumber: params.number,
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

    // The merge response describes the merge, not the pull request; the contract
    // returns a PullRequest, so the merged state is read back.
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
      'pulls',
      params.number,
    );
    // Gitee serves pull-request discussions from their own endpoint.
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
      'pulls',
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

    // Gitee answers `200 + []` for a missing path (never 404) and an array for a
    // directory, so the payload shape — not the status — decides. v0.1.0 has no
    // directory listing, so both cases are a caller error.
    if (Array.isArray(response.json)) {
      throw invalidArgumentError(
        `Invalid \`path\`: "${params.path}" is a directory or does not exist (Gitee answers 200 with an array). ` +
          'v0.1.0 getFileContents reads a single file only.',
        'gitee',
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
    // Gitee takes `sha` and `message` in the query string, with an empty body.
    const response = await ctx.http.request<unknown>({
      method: 'DELETE',
      path: `${REPO_PATH}/contents/{path}`,
      pathParams: { owner: params.owner, repo: params.repo, path: params.path },
      paramsIn: 'query',
      body: { sha: params.sha, message: params.message, branch: params.branch },
    });
    return this.resultFromContents(ctx, params, response, false);
  }

  /**
   * Commits every entry in one request.
   *
   * A single `POST /commits` with `actions[]`
   * produces one commit, so no probe for existence is needed and no GET is
   * issued. An empty batch is rejected before the request because the platform
   * would create an empty commit.
   */
  async pushFiles(ctx: AdapterCtx, params: WithProvider<PushFilesInput>): Promise<FileWriteResult> {
    const entries = readPushEntries(params.files);

    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/commits`,
      pathParams: repoParams(params.owner, params.repo),
      body: {
        branch: params.branch,
        message: params.message,
        actions: entries.map((entry) => {
          const action: Record<string, unknown> = { action: entry.action, path: entry.path };
          if (entry.action !== 'delete') {
            action.content = entry.content;
            // Gitee accepts exactly `text` and `base64`; `utf8` is rejected.
            action.encoding = toGiteeEncoding(entry.encoding);
          }
          return action;
        }),
      },
    });

    const record = asRecord(response.json);
    // `paths` is rebuilt from the caller's order: the response `files[]` order
    // differs from `actions[]`.
    return buildFileWriteResult({
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      paths: entries.map((entry) => entry.path),
      commitSha: confirmedSha(ctx.http, response, record.sha),
      commitHtmlUrl: str(record.html_url) ?? '',
    });
  }

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
      provider: 'gitee',
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

  /** Collects one platform state's issues, one page at a time. */
  private async collectIssues(
    ctx: AdapterCtx,
    params: WithProvider<ListIssuesParams>,
    state: string,
  ): Promise<unknown[]> {
    return collectPages<unknown>(
      ctx.http,
      {
        method: 'GET',
        path: `${REPO_PATH}/issues`,
        pathParams: repoParams(params.owner, params.repo),
      },
      {
        maxPages: params.maxPages,
        query: { state, labels: joinLabels(params.labels) },
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).number),
      },
    );
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
        content: contentsBase64(params.content, params.encoding, 'gitee'),
        message: params.message,
        branch: params.branch,
        sha: params.sha,
      },
    });
    return this.resultFromContents(ctx, params, response, true);
  }

  /**
   * Builds a `FileWriteResult` from a single-file write response.
   *
   * Gitee's `commit` object has no `html_url` in these responses,
   * so the commit URL is derived from the web base. That derivation is the
   * main path here, not a fallback.
   */
  private resultFromContents(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams> | WithProvider<DeleteFileParams>,
    response: HttpResponse,
    keepFileUrl: boolean,
  ): FileWriteResult {
    const record = asRecord(response.json);
    const commit = asRecord(record.commit);
    const sha = confirmedSha(ctx.http, response, commit.sha);
    const webBase = ctx.webBaseUrl.endsWith('/') ? ctx.webBaseUrl.slice(0, -1) : ctx.webBaseUrl;
    const derivedUrl =
      webBase.length > 0 && sha.length > 0
        ? `${webBase}/${params.owner}/${params.repo}/commit/${sha}`
        : '';
    const fileUrl = keepFileUrl ? str(asRecord(record.content).html_url) : undefined;

    const result = buildFileWriteResult({
      owner: params.owner,
      repo: params.repo,
      branch: params.branch,
      paths: [params.path],
      commitSha: sha,
      commitHtmlUrl: str(commit.html_url) ?? derivedUrl,
    });
    if (keepFileUrl) {
      result.file_html_urls = [fileUrl];
    }
    return result;
  }
}

/**
 * Resolves the platform states a contract state maps to.
 *
 * An omitted state is treated as `open`, matching GitHub's documented default,
 * so "no state" never silently drops in-progress issues.
 */
function resolveIssueStates(state: ListIssuesParams['state']): readonly string[] {
  if (state === 'all') {
    return ['all'];
  }
  if (state === 'closed') {
    return CLOSED_STATES;
  }
  return OPEN_STATES;
}

/** The Gitee adapter singleton registered by `adapters/index.ts`. */
export const giteeAdapter: ProviderAdapter = new GiteeAdapter();
