/**
 * Shared scaffolding for the five contract suites.
 *
 * A contract suite states what *every* provider must do for a domain. It is
 * written once and parameterized over `PROVIDERS`, so a platform cannot quietly
 * drift: the same assertions run three times, through the same facade.
 *
 * Only contract facts belong here — never a platform-specific path or payload;
 * those live in the per-adapter suites.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Provider } from '../../src/index.js';
import type { MockRoute } from '../helpers/mockFetch.js';

/** The fixtures a contract suite draws on, already parsed. */
export interface ContractFixtures {
  issues: unknown;
  issue: unknown;
  pulls: unknown;
  pull: unknown;
  repos: unknown;
  repo: unknown;
  contents: unknown;
  branches: unknown;
  commits: unknown;
  commit: unknown;
  comments: unknown;
}

/** Reads one fixture file for a provider. */
function read(provider: Provider, name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${provider}/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Loads a provider's fixture set.
 *
 * The shared pull-request contract exercises populated refs. The adapter suite
 * covers the AtomGit detail variant where the source ref is absent.
 */
export function loadFixtures(provider: Provider): ContractFixtures {
  const pullList: unknown = read(provider, 'pulls');
  const firstPull: unknown = Array.isArray(pullList) ? pullList[0] : pullList;
  const issuesList = provider === 'github' ? read(provider, 'issues-page-1') : undefined;

  return {
    issues: issuesList ?? readFallback(provider, 'issues', 'issues-page-1'),
    issue: read(provider, 'issue'),
    pulls: pullList,
    pull: firstPull,
    repos: read(provider, 'repos'),
    repo: read(provider, 'repo'),
    contents: read(provider, 'contents'),
    branches: read(provider, 'branches'),
    commits: read(provider, 'commits'),
    commit: read(provider, 'commit'),
    comments: read(provider, 'comments'),
  };
}

/**
 * Falls back to the per-provider issue list fixture name.
 *
 * GitHub keeps two pages (`issues-page-1/2`), Gitee splits by state
 * (`issues-open`, `issues-progressing`), and AtomGit has no list fixture — so
 * each provider's single-issue `issue.json` doubles as a one-entry list.
 */
function readFallback(provider: Provider, preferred: string, fallback: string): unknown {
  try {
    return read(provider, preferred);
  } catch {
    try {
      return read(provider, fallback);
    } catch {
      return [read(provider, 'issue')];
    }
  }
}

/**
 * A route table every contract suite can start from.
 *
 * Every matcher is a predicate over `pathname`, for two reasons:
 *
 * - List calls append `per_page`/`page`, so a `$`-anchored regex would be tested
 *   against the full URL (query included) and silently stop matching, leaving a
 *   suite to assert against an empty list.
 * - A write endpoint and its read sibling often share a path
 *   (`POST /issues` vs `GET /issues`), so the HTTP method must participate.
 *
 * Order is most-specific first: `/issues/{n}/comments` before `/issues/{n}`
 * before `/issues`, and `POST /commits` before `GET /commits`.
 */
export function contractRoutes(data: ContractFixtures): MockRoute[] {
  const path = (call: { url: string }): string => new URL(call.url).pathname;
  const on =
    (method: string, suffix: RegExp) =>
    (call: MockCallShape): boolean =>
      call.method === method && suffix.test(path(call));
  const at =
    (suffix: RegExp) =>
    (call: MockCallShape): boolean =>
      suffix.test(path(call));

  /** A write response shaped like a single-file contents write. */
  const writeBody = {
    content: { html_url: 'https://example.com/blob/dev/a.txt' },
    commit: { sha: 'c'.repeat(40), html_url: 'https://example.com/commit/c' },
  };

  return [
    {
      match: on('GET', /\/git\/trees\/[0-9a-f]+$/),
      responses: [
        {
          body: {
            truncated: false,
            tree: ['b.txt', 'c.txt'].map((path) => ({ path, mode: '100644', type: 'blob' })),
          },
        },
      ],
    },
    /* GitHub `pushFiles`: six-step chain plus one blob per base64 entry. */
    { match: at(/\/git\/blobs$/), responses: [{ body: { sha: 'd'.repeat(40) } }] },
    { match: at(/\/git\/trees$/), responses: [{ body: { sha: 'b'.repeat(40) } }] },
    {
      match: on('POST', /\/git\/commits$/),
      responses: [{ body: { sha: 'c'.repeat(40), html_url: 'https://example.com/commit/c' } }],
    },
    {
      match: at(/\/git\/commits\/[0-9a-f]+$/),
      responses: [{ body: { sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } } }],
    },
    {
      match: at(/\/git\/ref\/heads\/.+$/),
      responses: [{ body: { object: { sha: 'a'.repeat(40) } } }],
    },
    {
      match: at(/\/git\/refs\/heads\/.+$/),
      responses: [{ body: { ref: 'refs/heads/dev', object: { sha: 'c'.repeat(40) } } }],
    },

    /* File writes, before any read route that could shadow them. */
    { match: on('POST', /\/contents\/.+$/), responses: [{ body: writeBody }] },
    { match: on('PUT', /\/contents\/.+$/), responses: [{ body: writeBody }] },
    { match: on('DELETE', /\/contents\/.+$/), responses: [{ body: writeBody }] },

    /* Comments hang off both domains and must precede their parents. */
    { match: on('POST', /\/issues\/[^/]+\/comments$/), responses: [{ body: data.comments }] },
    { match: at(/\/issues\/[^/]+\/comments$/), responses: [{ body: data.comments }] },
    { match: on('POST', /\/pulls\/[^/]+\/comments$/), responses: [{ body: data.comments }] },
    { match: at(/\/pulls\/[^/]+\/comments$/), responses: [{ body: data.comments }] },

    /* Issues: write, then detail, then list. */
    { match: on('POST', /\/issues$/), responses: [{ body: data.issue }] },
    { match: on('PATCH', /\/issues\/[^/]+$/), responses: [{ body: data.issue }] },
    { match: at(/\/issues\/[^/]+$/), responses: [{ body: data.issue }] },
    { match: at(/\/issues$/), responses: [{ body: data.issues }] },

    /* Pull requests: merge, create, detail, list. */
    { match: on('PUT', /\/merge$/), responses: [{ body: { merged: true } }] },
    { match: on('POST', /\/pulls$/), responses: [{ body: data.pull }] },
    { match: at(/\/pulls\/[^/]+$/), responses: [{ body: data.pull }] },
    { match: at(/\/pulls$/), responses: [{ body: data.pulls }] },

    /* Repositories: create, then read, then list. */
    {
      match: (call) =>
        call.method === 'POST' && /(^|\/)(user|orgs\/[^/]+)\/repos$/.test(path(call)),
      responses: [{ body: data.repo }],
    },
    { match: at(/\/repos\/[^/]+\/[^/]+$/), responses: [{ body: data.repo }] },
    { match: at(/\/repos$/), responses: [{ body: data.repos }] },

    {
      match: on('POST', /\/git\/refs$/),
      responses: [{ body: { object: { sha: 'a'.repeat(40) } } }],
    },
    /* File reads, branches and commits. */
    { match: at(/\/contents\/.+$/), responses: [{ body: data.contents }] },
    { match: on('POST', /\/branches$/), responses: [{ body: firstEntry(data.branches) }] },
    { match: at(/\/branches$/), responses: [{ body: data.branches }] },
    {
      match: on('POST', /\/commits$/),
      responses: [{ body: { sha: 'c'.repeat(40), html_url: 'https://example.com/commit/c' } }],
    },
    { match: at(/\/commits\/[0-9a-f]+$/), responses: [{ body: data.commit }] },
    { match: at(/\/commits$/), responses: [{ body: data.commits }] },

    { match: () => true, responses: [{ body: data.repo }] },
  ];
}

/** The shape a route predicate receives. */
interface MockCallShape {
  url: string;
  method: string;
}

/** Reads the first entry of a fixture array, for a create-style response. */
function firstEntry(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}
