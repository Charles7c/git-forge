/**
 * GitHub adapter: endpoint assembly plus GitHub-specific semantics.
 *
 * Deliberately thin. It builds a request, hands it to {@link HttpClient}, then
 * maps the payload through `map.ts`. All retry, auth, timeout and redaction live
 * in `core`, so nothing here can bypass them.
 *
 * Two GitHub-only behaviours worth knowing:
 *
 * - `/issues` returns pull requests as well; list entries carrying a
 *   `pull_request` key are dropped so `listIssues` means issues.
 * - `pushFiles` has no batch endpoint, so it runs the Git data
 *   read tip, commit and tree; create tree and commit; update the ref
 *   chain, which yields exactly one commit.
 */
import { collectPullRequests, pullFromResponse } from '../pulls.js';
import type { HttpResponse } from '../../core/http.js';
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
  PushFilesInput,
  WithProvider,
} from '../types.js';
import {
  asArray,
  asRecord,
  buildFileWriteResult,
  deriveBranchHtmlUrl,
  isPullRequestEntry,
  isShaLike,
  listKey,
  mapBranch,
  mapComment,
  mapCommit,
  mapFileContent,
  mapIssue,
  mapPullRequest,
  mapRepository,
  normalizeLabels,
  readPushEntries,
  str,
} from './map.js';
import { resolveFileModes } from './tree.js';
import type { PushPlanEntry } from './map.js';
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

/** Headers GitHub asks every v3 REST client to send. */
const GITHUB_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
};

/** Base path segment repeated by nearly every endpoint. */
const REPO_PATH = '/repos/{owner}/{repo}';

/** Builds the request context shared by the list/count helpers. */
function base(owner: string, repo: string) {
  return { pathParams: { owner, repo } as Record<string, string>, headers: GITHUB_HEADERS };
}

/** Joins labels the way GitHub's filter accepts them. */
function joinLabels(labels: readonly string[] | undefined): string | undefined {
  return labels === undefined || labels.length === 0 ? undefined : labels.join(',');
}

/** Rejects a create call that carries an update's blob sha. */
function assertCreation(params: CreateOrUpdateFileParams): void {
  if (params.sha !== undefined) {
    throw invalidArgumentError(
      'Invalid `sha`: createFile creates a new file and must not receive a blob sha; use updateFile to replace an existing file.',
      'github',
    );
  }
}

/** Rejects an update call without the blob sha GitHub requires. */
function assertUpdate(params: CreateOrUpdateFileParams): void {
  if (params.sha === undefined || params.sha.length === 0) {
    throw invalidArgumentError(
      'Invalid `sha`: updateFile requires the current blob sha of the file being replaced.',
      'github',
    );
  }
}

/** Builds a `FileWriteResult` from a `contents` write response. */
function writeResultFromContents(
  ctx: AdapterCtx,
  owner: string,
  repo: string,
  branch: string | undefined,
  path: string,
  response: HttpResponse,
  keepFileUrl: boolean,
): FileWriteResult {
  const record = asRecord(response.json);
  const commit = asRecord(record.commit);
  const contentUrl = keepFileUrl ? str(asRecord(record.content).html_url) : undefined;
  const result = buildFileWriteResult({
    owner,
    repo,
    branch,
    paths: [path],
    commitSha: confirmedSha(ctx.http, response, commit.sha),
    commitHtmlUrl: str(commit.html_url) ?? '',
  });
  if (keepFileUrl) {
    result.file_html_urls = [contentUrl];
  }
  return result;
}

/** Domain implementation backed by api.github.com. */
class GitHubAdapter
  implements IssueDomain, PullRequestDomain, RepositoryDomain, FilesDomain, BranchCommitDomain
{
  readonly provider = 'github' as const;
  readonly capabilities = capabilities;
  readonly paramCapabilities = paramCapabilities;

  /* ---------------------------------------------------------------------- */
  /* Issue                                                                  */
  /* ---------------------------------------------------------------------- */

  async listIssues(ctx: AdapterCtx, params: WithProvider<ListIssuesParams>): Promise<Issue[]> {
    const { owner, repo } = params;
    const entries = await collectPages<unknown>(
      ctx.http,
      { method: 'GET', path: `${REPO_PATH}/issues`, ...base(owner, repo) },
      {
        maxPages: params.maxPages,
        query: {
          state: params.state,
          labels: joinLabels(params.labels),
          milestone: params.milestone,
        },
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).number),
      },
    );

    // GitHub serves issues and pull requests from one endpoint; a pull request
    // entry is marked by a `pull_request` key.
    return entries
      .filter((entry) => !isPullRequestEntry(entry))
      .map((entry) => mapIssue(owner, repo, entry));
  }

  async getIssue(ctx: AdapterCtx, params: WithProvider<GetIssueParams>): Promise<Issue> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/issues/{number}`,
      pathParams: { owner: params.owner, repo: params.repo, number: String(params.number) },
      headers: GITHUB_HEADERS,
    });
    return mapIssue(params.owner, params.repo, response.json);
  }

  async createIssue(ctx: AdapterCtx, params: WithProvider<CreateIssueParams>): Promise<Issue> {
    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/issues`,
      ...base(params.owner, params.repo),
      body: {
        title: params.title,
        body: params.body,
        labels: params.labels,
        milestone: params.milestone,
      },
    });
    return mapIssue(params.owner, params.repo, response.json);
  }

  async updateIssue(ctx: AdapterCtx, params: WithProvider<UpdateIssueParams>): Promise<Issue> {
    const response = await ctx.http.request<unknown>({
      method: 'PATCH',
      path: `${REPO_PATH}/issues/{number}`,
      pathParams: { owner: params.owner, repo: params.repo, number: String(params.number) },
      headers: GITHUB_HEADERS,
      body: {
        title: params.title,
        body: params.body,
        state: params.state,
        labels: params.labels,
        milestone: params.milestone,
      },
    });
    return mapIssue(params.owner, params.repo, response.json);
  }

  async listIssueComments(
    ctx: AdapterCtx,
    params: WithProvider<ListCommentsParams>,
  ): Promise<Comment[]> {
    return this.listComments(ctx, params, `${REPO_PATH}/issues/{number}/comments`);
  }

  async createIssueComment(
    ctx: AdapterCtx,
    params: WithProvider<CreateCommentParams>,
  ): Promise<Comment> {
    return this.createComment(ctx, params, `${REPO_PATH}/issues/{number}/comments`);
  }

  /* ---------------------------------------------------------------------- */
  /* Pull request                                                           */
  /* ---------------------------------------------------------------------- */

  async listPullRequests(
    ctx: AdapterCtx,
    params: WithProvider<ListPullRequestsParams>,
  ): Promise<PullRequest[]> {
    return collectPullRequests(ctx, params, mapPullRequest, {
      states: [params.state],
      headers: GITHUB_HEADERS,
      query: { head: params.head, base: params.base },
      matches: (entry) => {
        const record = asRecord(entry);
        const labels = normalizeLabels(record.labels).map((label) => label.toLowerCase());
        return (
          (params.milestone === undefined ||
            asRecord(record.milestone).number === params.milestone) &&
          (params.labels ?? []).every((label) => labels.includes(label.toLowerCase()))
        );
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
      pathParams: { owner: params.owner, repo: params.repo, number: String(params.number) },
      headers: GITHUB_HEADERS,
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
      ...base(params.owner, params.repo),
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
      pathParams: { owner: params.owner, repo: params.repo, number: String(params.number) },
      headers: GITHUB_HEADERS,
      body: {
        merge_method: params.merge_method,
        commit_title: params.commit_title,
        commit_message: params.commit_message,
      },
    });

    // The merge response carries `sha`/`merged`/`message` only; the contract
    // returns a PullRequest, so the merged state is read back rather than
    // assembled from partial data.
    return this.getPullRequest(ctx, params);
  }

  async listPullRequestComments(
    ctx: AdapterCtx,
    params: WithProvider<ListCommentsParams>,
  ): Promise<Comment[]> {
    // GitHub reviews pull requests through the issue-comment endpoint.
    return this.listComments(ctx, params, `${REPO_PATH}/issues/{number}/comments`);
  }

  async createPullRequestComment(
    ctx: AdapterCtx,
    params: WithProvider<CreateCommentParams>,
  ): Promise<Comment> {
    return this.createComment(ctx, params, `${REPO_PATH}/issues/{number}/comments`);
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
      { method: 'GET', path, pathParams, headers: GITHUB_HEADERS },
      {
        maxPages: params.maxPages,
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).id ?? asRecord(raw).full_name),
      },
    );

    return entries.map((entry) => {
      const record = asRecord(entry);
      const fullName = str(record.full_name) ?? '';
      const [ownerFromPayload, repoFromPayload] = fullName.split('/');
      const owner = str(asRecord(record.owner).login) ?? ownerFromPayload ?? '';
      const repo = str(record.name) ?? repoFromPayload ?? '';
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
      ...base(params.owner, params.repo),
    });
    const record = asRecord(response.json);
    const owner = str(asRecord(record.owner).login) ?? params.owner;
    return mapRepository(owner, params.repo, record);
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
      headers: GITHUB_HEADERS,
      body: {
        name: params.name,
        description: params.description,
        private: params.private,
        auto_init: params.auto_init,
      },
    });

    const record = asRecord(response.json);
    const owner = str(asRecord(record.owner).login) ?? params.org ?? '';
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
      headers: GITHUB_HEADERS,
    });

    // GitHub returns an array for a directory path; v0.1.0 has no directory
    // listing in the contract, so the call is rejected instead of guessed at.
    if (Array.isArray(response.json)) {
      throw invalidArgumentError(
        `Invalid \`path\`: "${params.path}" is a directory. v0.1.0 getFileContents reads a single file only.`,
        'github',
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
    return this.putContents(ctx, params);
  }

  async updateFile(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams>,
  ): Promise<FileWriteResult> {
    assertUpdate(params);
    return this.putContents(ctx, params);
  }

  async deleteFile(
    ctx: AdapterCtx,
    params: WithProvider<DeleteFileParams>,
  ): Promise<FileWriteResult> {
    const response = await ctx.http.request<unknown>({
      method: 'DELETE',
      path: `${REPO_PATH}/contents/{path}`,
      pathParams: { owner: params.owner, repo: params.repo, path: params.path },
      headers: GITHUB_HEADERS,
      body: { message: params.message, sha: params.sha, branch: params.branch },
    });
    return writeResultFromContents(
      ctx,
      params.owner,
      params.repo,
      params.branch,
      params.path,
      response,
      false,
    );
  }

  async pushFiles(ctx: AdapterCtx, params: WithProvider<PushFilesInput>): Promise<FileWriteResult> {
    const entries = readPushEntries(params.files);
    const { owner, repo } = params;

    // 1. Current branch tip: the parent of the new commit and the ref to move.
    const refResponse = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/git/ref/heads/{branch}`,
      pathParams: { owner, repo, branch: params.branch },
      headers: GITHUB_HEADERS,
    });
    const commitSha = confirmedSha(
      ctx.http,
      refResponse,
      asRecord(asRecord(refResponse.json).object).sha,
    );

    // 2. Tree of that commit: `base_tree` keeps every file not mentioned below.
    const commitResponse = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/git/commits/{sha}`,
      pathParams: { owner, repo, sha: commitSha },
      headers: GITHUB_HEADERS,
    });
    const baseTree = confirmedSha(
      ctx.http,
      commitResponse,
      asRecord(asRecord(commitResponse.json).tree).sha,
    );

    const parentTree = await ctx.http.request({
      method: 'GET',
      path: `${REPO_PATH}/git/trees/{sha}`,
      pathParams: { owner, repo, sha: baseTree },
      headers: GITHUB_HEADERS,
      query: { recursive: '1' },
    });
    const modes = resolveFileModes(ctx.http, parentTree, entries);
    // Base64 entries need a blob first; a tree entry accepts `sha` or `content`
    // but never both.
    const tree: Record<string, unknown>[] = [];
    for (const [index, entry] of entries.entries()) {
      tree.push(await this.treeEntry(ctx, owner, repo, entry, modes[index]!));
    }

    // 3. New tree rooted at the old one.
    const treeResponse = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/git/trees`,
      ...base(owner, repo),
      body: { base_tree: baseTree, tree },
    });
    const newTree = confirmedSha(ctx.http, treeResponse, asRecord(treeResponse.json).sha);

    // 4. The single commit holding every change.
    const newCommitResponse = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/git/commits`,
      ...base(owner, repo),
      body: { message: params.message, tree: newTree, parents: [commitSha] },
    });
    const newCommit = asRecord(newCommitResponse.json);
    const newCommitSha = confirmedSha(ctx.http, newCommitResponse, newCommit.sha);

    // 5. Fast-forward the branch to the new commit.
    const updated = await ctx.http.request<unknown>({
      method: 'PATCH',
      path: `${REPO_PATH}/git/refs/heads/{branch}`,
      pathParams: { owner, repo, branch: params.branch },
      headers: GITHUB_HEADERS,
      body: { sha: newCommitSha, force: false },
    });

    if (asRecord(asRecord(updated.json).object).sha !== newCommitSha) {
      throw ctx.http.invalidResponse(
        updated,
        'The provider did not confirm the updated branch tip',
      );
    }
    return buildFileWriteResult({
      owner,
      repo,
      branch: params.branch,
      paths: entries.map((entry) => entry.path),
      commitSha: newCommitSha,
      commitHtmlUrl: str(newCommit.html_url) ?? '',
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Branch / Commit                                                        */
  /* ---------------------------------------------------------------------- */

  async listBranches(ctx: AdapterCtx, params: WithProvider<ListBranchesParams>): Promise<Branch[]> {
    const entries = await collectPages<unknown>(
      ctx.http,
      { method: 'GET', path: `${REPO_PATH}/branches`, ...base(params.owner, params.repo) },
      {
        maxPages: params.maxPages,
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).name),
      },
    );
    return entries.map((entry) => mapBranch(params.owner, params.repo, entry, ctx.webBaseUrl));
  }

  async createBranch(ctx: AdapterCtx, params: WithProvider<CreateBranchParams>): Promise<Branch> {
    // GitHub's refs endpoint takes a commit sha, not a branch name, so a branch
    // source is resolved first. A sha source needs no extra request.
    const sha = isShaLike(params.from)
      ? params.from
      : await this.resolveBranchSha(ctx, params.owner, params.repo, params.from);

    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/git/refs`,
      ...base(params.owner, params.repo),
      body: { ref: `refs/heads/${params.name}`, sha },
    });

    const objectSha = confirmedSha(
      ctx.http,
      response,
      asRecord(asRecord(response.json).object).sha,
    );
    const branch: Branch = {
      provider: 'github',
      owner: params.owner,
      repo: params.repo,
      name: params.name,
      commit_sha: objectSha,
    };
    const htmlUrl = deriveBranchHtmlUrl(ctx.webBaseUrl, params.owner, params.repo, params.name);
    if (htmlUrl !== undefined) {
      branch.html_url = htmlUrl;
    }
    return branch;
  }

  async listCommits(ctx: AdapterCtx, params: WithProvider<ListCommitsParams>): Promise<Commit[]> {
    const entries = await collectPages<unknown>(
      ctx.http,
      { method: 'GET', path: `${REPO_PATH}/commits`, ...base(params.owner, params.repo) },
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
      pathParams: { owner: params.owner, repo: params.repo, sha: params.sha },
      headers: GITHUB_HEADERS,
    });
    return mapCommit(params.owner, params.repo, response.json);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /** Shared comment listing used by both issue and pull-request domains. */
  private async listComments(
    ctx: AdapterCtx,
    params: WithProvider<ListCommentsParams>,
    path: string,
  ): Promise<Comment[]> {
    const entries = await collectPages<unknown>(
      ctx.http,
      {
        method: 'GET',
        path,
        pathParams: {
          owner: params.owner,
          repo: params.repo,
          number: String(params.number),
        },
        headers: GITHUB_HEADERS,
      },
      {
        maxPages: params.maxPages,
        selectItems: (raw) => asArray(raw),
        keyOf: (raw) => listKey(asRecord(raw).id),
      },
    );
    return entries.map((entry) => mapComment(params.owner, params.repo, entry));
  }

  /** Shared comment creation used by both comment domains. */
  private async createComment(
    ctx: AdapterCtx,
    params: WithProvider<CreateCommentParams>,
    path: string,
  ): Promise<Comment> {
    const response = await ctx.http.request<unknown>({
      method: 'POST',
      path,
      pathParams: {
        owner: params.owner,
        repo: params.repo,
        number: String(params.number),
      },
      headers: GITHUB_HEADERS,
      body: { body: params.body },
    });
    return mapComment(params.owner, params.repo, response.json);
  }

  /** PUTs a file through the `contents` upsert endpoint. */
  private async putContents(
    ctx: AdapterCtx,
    params: WithProvider<CreateOrUpdateFileParams>,
  ): Promise<FileWriteResult> {
    const response = await ctx.http.request<unknown>({
      method: 'PUT',
      path: `${REPO_PATH}/contents/{path}`,
      pathParams: { owner: params.owner, repo: params.repo, path: params.path },
      headers: GITHUB_HEADERS,
      body: {
        message: params.message,
        content: contentsBase64(params.content, params.encoding, 'github'),
        branch: params.branch,
        sha: params.sha,
      },
    });
    return writeResultFromContents(
      ctx,
      params.owner,
      params.repo,
      params.branch,
      params.path,
      response,
      true,
    );
  }

  /** Builds one tree entry, creating a blob first for base64 payloads. */
  private async treeEntry(
    ctx: AdapterCtx,
    owner: string,
    repo: string,
    entry: PushPlanEntry,
    mode: string,
  ): Promise<Record<string, unknown>> {
    if (entry.action === 'delete') {
      // `sha: null` is GitHub's delete marker; sending `content` alongside it
      // would be rejected.
      return { path: entry.path, mode, type: 'blob', sha: null };
    }
    if (entry.encoding === 'utf8') {
      return {
        path: entry.path,
        mode,
        type: 'blob',
        content: entry.content,
      };
    }

    const blobResponse = await ctx.http.request<unknown>({
      method: 'POST',
      path: `${REPO_PATH}/git/blobs`,
      ...base(owner, repo),
      body: { content: entry.content, encoding: 'base64' },
    });
    const blobSha = confirmedSha(ctx.http, blobResponse, asRecord(blobResponse.json).sha);
    // `sha` and `content` are mutually exclusive on a tree entry.
    return { path: entry.path, mode, type: 'blob', sha: blobSha };
  }

  /** Reads the commit sha a branch currently points at. */
  private async resolveBranchSha(
    ctx: AdapterCtx,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const response = await ctx.http.request<unknown>({
      method: 'GET',
      path: `${REPO_PATH}/git/ref/heads/{branch}`,
      pathParams: { owner, repo, branch },
      headers: GITHUB_HEADERS,
    });
    const sha = str(asRecord(asRecord(response.json).object).sha);
    if (sha === undefined) {
      throw invalidArgumentError(
        `Cannot resolve "${branch}": the ref response carried no commit sha.`,
        'github',
      );
    }
    return sha;
  }
}

/** The GitHub adapter singleton registered by `adapters/index.ts`. */
export const githubAdapter: ProviderAdapter = new GitHubAdapter();
