import type { HttpClient, HttpResponse } from '../core/http.js';

/**
 * Validates a label page before mapping or deduplication can hide a bad row.
 *
 * Two shapes make a label list unusable as *evidence of absence*, and both are
 * rejected when the caller asked for a complete catalog:
 *
 * - a body that is not an array (an error document, a single object);
 * - an entry with no usable `name` (missing, empty, or not a string).
 *
 * Without the check, `asArray` and the mappers turn both into a short list, and a
 * caller that reads "the name is not here" acts on a premise the platform never
 * stated — `ensureLabel` would create a duplicate.
 *
 * The strictness is opt-in through `requireComplete`: a caller that only displays
 * labels is not refused because one row is odd, and that lenient reading is
 * unchanged.
 *
 * @param http            Client that owns the provider label for the error.
 * @param response        The page just fetched.
 * @param requireComplete Whether the caller needs a trustworthy complete list.
 */
export function selectLabelRows(
  http: HttpClient,
  response: HttpResponse,
  requireComplete: boolean | undefined,
): unknown[] {
  const raw: unknown = response.json;
  if (requireComplete !== true) {
    return Array.isArray(raw) ? raw : [];
  }
  if (!Array.isArray(raw)) {
    throw http.invalidResponse(response, 'The provider label list response must be an array.');
  }
  for (const row of raw) {
    if (labelNameOf(row) === undefined) {
      throw http.invalidResponse(response, 'A provider label list entry has no valid name.');
    }
  }
  return raw;
}

/**
 * Deduplication key for a label row.
 *
 * A named row is keyed by its name, so the same label seen twice across pages is
 * merged. A row without a name gets a key of its own: two nameless rows cannot be
 * proven to be the same label, and collapsing them with a shared empty key would
 * drop one silently.
 */
export function labelKeyOf(): (row: unknown) => string {
  let unnamed = 0;
  return (row: unknown): string => {
    const name = labelNameOf(row);
    if (name !== undefined) {
      return `name:${name}`;
    }
    unnamed += 1;
    return `unnamed:${unnamed}`;
  };
}

/** Reads a label row's name, or `undefined` when it has none that is usable. */
function labelNameOf(row: unknown): string | undefined {
  const record = row as Record<string, unknown> | null | undefined;
  const name = record?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined;
}
