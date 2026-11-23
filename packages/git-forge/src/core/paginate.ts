/**
 * Pagination primitives.
 *
 * Three signals decide whether another page exists, and the order matters:
 *
 * 1. `Link: rel="next"` — GitHub uses double quotes, Gitee single quotes.
 *    AtomGit sends no `Link` header at all.
 * 2. `total_page` — Gitee and AtomGit.
 * 3. A full page — the fallback when neither header is present.
 *
 * Relying on `Link` alone would stall on AtomGit after page one *without
 * raising an error*, which is the worst possible failure: the caller gets a
 * short list and believes it is complete. Hence the ordered fallbacks.
 */
import type { HttpClient, HttpRequestSpec } from './http.js';
import type { ListOptions } from './types.js';

/** Default page size. Hard-capped at the platforms' documented maximum. */
export const DEFAULT_PER_PAGE = 100;

/** Upper bound accepted for `per_page`; platforms may silently truncate above it. */
export const MAX_PER_PAGE = 100;

/** Default page limit for a single list call. */
export const DEFAULT_MAX_PAGES = 10;

/** Hard cap on `maxPages`, so one call cannot page indefinitely. */
export const MAX_PAGES_LIMIT = 100;

/**
 * Matches one `Link` entry: a bracketed URL followed by its `rel` value.
 *
 * The quote class `['"]?` and the exclusion of `';,` from the rel body are the
 * load-bearing parts. Gitee emits `rel='next'` while GitHub emits `rel="next"`;
 * a regex pinned to double quotes reads Gitee as "no next page" and silently
 * returns only the first page.
 */
const LINK_ENTRY = /<([^>]+)>\s*;\s*rel\s*=\s*['"]?([^'";,]+?)['"]?\s*(?:,|$)/g;

/**
 * Parses a `Link` header into a `rel -> url` map.
 *
 * @param header Raw header value, or `null` when absent.
 * @returns An empty object for a missing or empty header. Never throws: a
 *          malformed header degrades to "no pagination hints", which the other
 *          two signals cover.
 */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (header === null || header === undefined) {
    return result;
  }

  // Reset `lastIndex` so a shared global regex cannot skip an entry when the
  // same function is called repeatedly.
  LINK_ENTRY.lastIndex = 0;

  let match: RegExpExecArray | null = LINK_ENTRY.exec(header);
  while (match !== null) {
    const url = match[1];
    const rel = match[2];
    if (url !== undefined && rel !== undefined) {
      // A rel can carry several space-separated tokens; index by each so
      // `rel="next last"` still answers `next`.
      for (const token of rel.toLowerCase().split(/\s+/)) {
        if (token.length > 0 && result[token] === undefined) {
          result[token] = url;
        }
      }
    }
    match = LINK_ENTRY.exec(header);
  }

  return result;
}

/** Inputs for a single next-page decision. */
export interface PageSignals {
  /** Raw `Link` header, or `null` when the provider sent none. */
  link: string | null;
  /** `total_page` header as a number, or `null` when absent/unparseable. */
  totalPage: number | null;
  /** Page number just fetched, 1-based. */
  page: number;
  /** Number of items the just-fetched page contained. */
  itemCount: number;
  /** Page size that was requested. */
  perPage: number;
}

/**
 * Decides whether a following page exists.
 *
 * Evaluation short-circuits in signal order, so a `Link` header wins over a
 * short page: platforms may cap `per_page` below what was asked for, and the
 * short page alone would then be a false negative.
 */
export function resolveNextPage(signals: PageSignals): boolean {
  const { link, totalPage, page, itemCount, perPage } = signals;

  const parsed = parseLinkHeader(link);
  if (parsed.next !== undefined) {
    return true;
  }

  if (totalPage !== null && Number.isFinite(totalPage)) {
    return page < totalPage;
  }

  // No header hints: a full page implies more may follow. An empty or short
  // page means we are done.
  return itemCount >= perPage && itemCount > 0;
}

/**
 * Reads `total_page` from response headers.
 *
 * @returns The page count, or `null` when the header is missing or not a
 *          positive integer.
 */
export function readTotalPage(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
): number | null {
  const raw = readHeader(headers, 'total_page') ?? readHeader(headers, 'x-total-pages');
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Reads `total_count` from response headers, when a provider sends it. */
export function readTotalCount(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
): number | null {
  const raw = readHeader(headers, 'total_count') ?? readHeader(headers, 'x-total-count');
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Reads a header from a `Headers` instance, a plain record, or nothing. */
function readHeader(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
  key: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(key);
    return value === null ? undefined : value;
  }
  const record = headers as Readonly<Record<string, string | undefined>>;
  return record[key] ?? record[key.toLowerCase()];
}

/**
 * Removes duplicates by identity key, keeping the first occurrence.
 *
 * Order is preserved and nothing is re-sorted: duplicated entries across pages
 * come from unstable platform ordering or items created mid-pagination, and
 * reordering would make the result non-reproducible.
 */
export function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Clamps a requested page size into the supported range. */
export function normalizePerPage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PER_PAGE;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PER_PAGE);
}

/** Clamps a requested page limit into the supported range. */
export function normalizeMaxPages(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PAGES_LIMIT);
}

/** A page as returned by one request, plus what pagination needs to continue. */
export interface PageResult<T> {
  items: T[];
  headers: Headers;
  status: number;
  /** Parsed body, untyped; callers narrow it to `T[]`. */
  raw: T[];
}

/** Options for {@link collectPages}. */
export interface CollectOptions<T> extends ListOptions {
  /** Page size; clamped to `[1, 100]`. */
  perPage?: number;
  /** Extracts the array of items from a page body. */
  selectItems: (raw: unknown, ctx: { page: number }) => T[];
  /** Identity used for cross-page deduplication. */
  keyOf: (item: T) => string;
  /** Query parameters merged into every page request. */
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
}

/**
 * Fetches every page of a list endpoint and returns the merged, deduplicated
 * result in page order.
 *
 * Stops at whichever comes first: an empty page, a short page with no pagination
 * headers, the last `total_page`, or `maxPages`. The `maxPages` cap is a
 * truncation, not an error — the caller asked for a bounded result.
 */
export async function collectPages<T>(
  http: HttpClient,
  spec: Omit<HttpRequestSpec, 'query'> & {
    /** Filters merged into every page request alongside `page`/`per_page`. */
    query?: HttpRequestSpec['query'];
  },
  options: CollectOptions<T>,
): Promise<T[]> {
  const perPage = normalizePerPage(options.perPage);
  const maxPages = normalizeMaxPages(options.maxPages);
  const collected: T[] = [];
  const baseQuery = { ...spec.query, ...options.query };

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await http.request<unknown>({
      ...spec,
      query: {
        ...baseQuery,
        per_page: perPage,
        page,
      },
    });

    const items = options.selectItems(response.json, { page });
    collected.push(...items);

    const hasNext = resolveNextPage({
      link: readHeader(response.headers, 'link') ?? null,
      totalPage: readTotalPage(response.headers),
      page,
      itemCount: items.length,
      perPage,
    });

    if (!hasNext) {
      break;
    }
  }

  return dedupeBy(collected, options.keyOf);
}
