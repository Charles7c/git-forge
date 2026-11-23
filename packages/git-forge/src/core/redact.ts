/**
 * Secret redaction.
 *
 * Three defenses share this module:
 *
 * 1. Tokens never reach a log line or an error message in the first place.
 * 2. {@link redactUrl} is the only supported way to turn a token-bearing URL
 *    into something displayable.
 * 3. {@link scrubSecrets} is the last line of defense, applied to every
 *    `GitForgeError` message as it is constructed.
 *
 * v0.1.0 authenticates with `Authorization: Bearer`, so tokens normally stay out
 * of URLs entirely. The query-style path is still supported for compatibility,
 * which is why this module cannot be dropped.
 */

/** Placeholder substituted for every redacted value. */
export const REDACTED = '***';

/**
 * Query parameters treated as secret.
 *
 * Matched case-insensitively; `access_token` is the Gitee/AtomGit name and
 * `token` covers the generic fallback.
 */
const SENSITIVE_QUERY_KEYS = ['access_token', 'token'];

/**
 * Matches `key=value` / `key: value` pairs for sensitive keys anywhere in a
 * string.
 *
 * Deliberately not URL-aware: it also has to catch secrets that leaked into a
 * free-form message or a stack trace. The value class stops at whitespace, `&`
 * and quotes so it cannot swallow surrounding prose, and an optional scheme
 * keyword (`Bearer`) is consumed so the token itself is covered rather than just
 * the scheme name.
 */
const SECRET_ASSIGNMENT =
  /\b(access_token|token|authorization)(\s*[:=]\s*)(bearer\s+)?([^\s&"',;]+)/gi;

/**
 * Rebuilds a matched secret assignment, keeping the key and any scheme keyword
 * while masking the value.
 */
function maskAssignment(
  _match: string,
  key: string,
  separator: string,
  scheme: string | undefined,
): string {
  return `${key}${separator}${scheme ?? ''}${REDACTED}`;
}

/**
 * Replaces every sensitive query-parameter value in a URL with `***`.
 *
 * Non-URL strings pass through with the same substitution applied, so this is
 * safe to call on anything.
 *
 * @example
 * redactUrl('https://gitee.com/api/v5/repos?access_token=abc123&page=1');
 * // 'https://gitee.com/api/v5/repos?access_token=***&page=1'
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) {
    return url;
  }

  let redacted = url.replace(
    /([?&](?:access_token|token)=)([^&#\s]*)/gi,
    (_match: string, prefix: string) => `${prefix}${REDACTED}`,
  );

  // A token embedded as `key: value` or `key=value` outside a query string, e.g.
  // an Authorization header echoed into a message.
  redacted = redacted.replace(SECRET_ASSIGNMENT, maskAssignment);

  return redacted;
}

/**
 * Removes known token values and any `key=value` secret pattern from free text.
 *
 * @param text     Text to sanitize; non-strings are returned unchanged.
 * @param secrets  Literal token values to strip. Only non-empty strings are
 *                 used, so an unset token cannot blank out the text.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  let scrubbed = text;

  // Longest first: if one token is a prefix of another, replacing the shorter
  // one first would leave a fragment of the longer token behind.
  const known = secrets
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const secret of known) {
    scrubbed = scrubbed.split(secret).join(REDACTED);
  }

  scrubbed = scrubbed.replace(SECRET_ASSIGNMENT, maskAssignment);

  return scrubbed;
}

/** Returns `true` when a query key is treated as secret. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_QUERY_KEYS.includes(key.toLowerCase());
}
