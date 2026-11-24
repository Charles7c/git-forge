import type { HttpClient, HttpResponse } from '../core/http.js';

/** Validates every Issue before deduplication or mapping can hide a malformed row. */
export function selectIssueRows(
  http: HttpClient,
  response: HttpResponse,
  isPullRequest?: (row: unknown) => boolean,
): unknown[] {
  const raw: unknown = response.json;
  if (!Array.isArray(raw)) {
    throw http.invalidResponse(response, 'The provider Issue list response must be an array.');
  }

  const rows: unknown[] = raw;
  const states = http.provider === 'gitee' ? GITEE_ISSUE_STATES : DEFAULT_ISSUE_STATES;
  for (const row of rows) {
    // Count GitHub PR rows for pagination, but do not interpret them as Issues.
    if (isPullRequest?.(row)) continue;
    const record = row as Record<string, unknown> | null | undefined;
    const number = record?.number;
    if (
      !(typeof number === 'string' && number.trim().length > 0) &&
      !(typeof number === 'number' && Number.isSafeInteger(number) && number > 0)
    ) {
      throw http.invalidResponse(response, 'A provider Issue list entry has no valid number.');
    }
    if (typeof record?.state !== 'string' || !states.includes(record.state)) {
      throw http.invalidResponse(response, 'A provider Issue list entry has an unknown state.');
    }
  }
  return rows;
}

const DEFAULT_ISSUE_STATES: readonly string[] = ['open', 'closed'];
const GITEE_ISSUE_STATES: readonly string[] = [...DEFAULT_ISSUE_STATES, 'progressing', 'rejected'];
