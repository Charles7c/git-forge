import type { HttpRequestSpec, HttpResponse } from '../core/http.js';
import { collectPages } from '../core/paginate.js';
import type {
  ListPullRequestsParams,
  PullRequest,
  PullRequestRef,
  RepoRef,
} from '../core/types.js';
import type { AdapterCtx } from './types.js';

type Mapper = (
  owner: string,
  repo: string,
  raw: unknown,
  base: PullRequestRef,
  invalidResponse: (message: string) => Error,
) => PullRequest;

/** Require an actual target ref on every public PR, including list and write results. */
export function pullFromResponse(
  map: Mapper,
  ctx: AdapterCtx,
  params: RepoRef,
  response: HttpResponse,
  raw: unknown = response.json,
): PullRequest {
  const base = (raw as { base?: Partial<PullRequestRef> } | null)?.base;
  if (
    typeof base?.ref !== 'string' ||
    !base.ref.trim() ||
    typeof base.sha !== 'string' ||
    !base.sha.trim()
  ) {
    throw ctx.http.invalidResponse(
      response,
      'Pull request response is missing its required base ref or SHA',
    );
  }
  return map(params.owner, params.repo, raw, { ref: base.ref, sha: base.sha }, (message) =>
    ctx.http.invalidResponse(response, message),
  );
}

/** Page each native state independently. A local filter must not shorten the raw page count. */
export async function collectPullRequests(
  ctx: AdapterCtx,
  params: ListPullRequestsParams,
  map: Mapper,
  options: {
    states: readonly (string | undefined)[];
    headers?: HttpRequestSpec['headers'];
    query?: HttpRequestSpec['query'];
    matches?: (raw: unknown) => boolean;
  },
): Promise<PullRequest[]> {
  const collected = new Map<number, PullRequest>();
  for (const state of options.states) {
    const rows = await collectPages(
      ctx.http,
      {
        method: 'GET',
        path: '/repos/{owner}/{repo}/pulls',
        pathParams: { owner: params.owner, repo: params.repo },
        headers: options.headers,
        query: { ...options.query, state },
      },
      {
        maxPages: params.maxPages,
        selectItems: (raw, { response }) => {
          if (!Array.isArray(raw))
            throw ctx.http.invalidResponse(response, 'Expected a pull request list');
          return raw.map((item: unknown) => ({
            pull: pullFromResponse(map, ctx, params, response, item),
            matches: options.matches?.(item) ?? true,
          }));
        },
        keyOf: (row) => String(row.pull.number),
      },
    );
    // A PR can transition between the two native queries. Keep its position
    // but prefer confirmed merge evidence over a stale closed representation.
    for (const { pull, matches } of rows) {
      if (matches && (!collected.has(pull.number) || pull.merged)) collected.set(pull.number, pull);
    }
  }
  return [...collected.values()];
}
