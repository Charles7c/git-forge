/**
 * The single error type thrown by this library.
 *
 * Two invariants keep the public surface safe and predictable:
 *
 * - Only `GitForgeError` escapes a public method; a raw `Error` from an adapter
 *   or from `fetch` must be wrapped first.
 * - `message` is assembled from fixed templates plus allow-listed values and is
 *   scrubbed of secrets on construction. Upstream response bodies are never
 *   copied into it wholesale.
 */
import { scrubSecrets } from './redact.js';
import type { CapabilityId, ParamCapabilityId, Provider } from './types.js';

/** The nine error categories delivered by v0.1.0. */
export type ErrorCode =
  /** The provider does not implement the capability at all. */
  | 'UNSUPPORTED_ON_PROVIDER'
  /** No token is configured for this provider; nothing was sent. */
  | 'AUTH_MISSING'
  /** The token was rejected, or a 403 that is not rate limiting. */
  | 'AUTH_INVALID'
  /** The resource does not exist or is not visible to this token. */
  | 'NOT_FOUND'
  /** A quota was exhausted, including 403 with zero remaining. */
  | 'RATE_LIMITED'
  /** Any upstream failure that maps to no narrower category. */
  | 'PROVIDER_ERROR'
  /** The call was rejected locally, or the upstream rejected its content. */
  | 'INVALID_ARGUMENT'
  /** Transport failed: DNS, TLS, connection reset, timeout. */
  | 'NETWORK_ERROR'
  /** A write call was blocked because the client is in read-only mode. */
  | 'READONLY_BLOCKED';

/** Runtime list of every error code, in documentation order. */
export const ERROR_CODES = [
  'UNSUPPORTED_ON_PROVIDER',
  'AUTH_MISSING',
  'AUTH_INVALID',
  'NOT_FOUND',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'INVALID_ARGUMENT',
  'NETWORK_ERROR',
  'READONLY_BLOCKED',
] as const satisfies readonly ErrorCode[];

/** Serialized form produced by {@link GitForgeError.toJSON}. */
export interface GitForgeErrorJson {
  code: ErrorCode;
  message: string;
  provider?: Provider;
  status?: number;
  requestId?: string;
  capability?: CapabilityId | ParamCapabilityId;
  retryable: boolean;
}

/** Constructor input for {@link GitForgeError}. */
export interface GitForgeErrorInit {
  code: ErrorCode;
  message: string;
  provider?: Provider;
  status?: number;
  requestId?: string;
  capability?: CapabilityId | ParamCapabilityId;
  /** Defaults to {@link DEFAULT_RETRYABLE} for the code. */
  retryable?: boolean;
  cause?: unknown;
  /** Known token values to strip from the message. */
  secrets?: readonly string[];
}

/**
 * Default retryability per code.
 *
 * Read calls may retry transport failures, rate limits and 5xx; everything else
 * describes a permanent condition, so retrying only burns quota.
 */
const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  UNSUPPORTED_ON_PROVIDER: false,
  AUTH_MISSING: false,
  AUTH_INVALID: false,
  NOT_FOUND: false,
  RATE_LIMITED: true,
  PROVIDER_ERROR: false,
  INVALID_ARGUMENT: false,
  NETWORK_ERROR: true,
  READONLY_BLOCKED: false,
};

/**
 * Returns the default retryability of a code.
 *
 * Used by callers that must decide whether to retry before an error exists,
 * and by {@link GitForgeError} when `retryable` is not supplied.
 */
export function defaultRetryable(code: ErrorCode): boolean {
  return DEFAULT_RETRYABLE[code];
}

/**
 * A normalized failure from any layer of the library.
 *
 * Never construct a plain `Error` for an expected failure: callers branch on
 * `code`, and `toJSON()` is the only sanctioned serialization path (notably for
 * `bulk()` partial results and MCP tool errors).
 */
export class GitForgeError extends Error {
  readonly code: ErrorCode;
  readonly provider?: Provider;
  readonly status?: number;
  readonly requestId?: string;
  readonly capability?: CapabilityId | ParamCapabilityId;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(init: GitForgeErrorInit) {
    // Scrub before calling super so the message is clean even if the receiver
    // captures `error.message` synchronously during construction.
    super(scrubSecrets(init.message, init.secrets ?? []));

    this.name = 'GitForgeError';
    this.code = init.code;
    this.provider = init.provider;
    this.status = init.status;
    this.requestId = init.requestId;
    this.capability = init.capability;
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[init.code];
    this.cause = init.cause;

    // Keep `instanceof` working after transpilation to ES5-era targets.
    Object.setPrototypeOf(this, GitForgeError.prototype);
  }

  /**
   * Serializes the error without headers, token values or the cause chain.
   *
   * Optional fields are omitted rather than set to `undefined`, so a JSON
   * round-trip cannot reintroduce a key that was never known.
   */
  toJSON(): GitForgeErrorJson {
    const json: GitForgeErrorJson = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.provider !== undefined) {
      json.provider = this.provider;
    }
    if (this.status !== undefined) {
      json.status = this.status;
    }
    if (this.requestId !== undefined) {
      json.requestId = this.requestId;
    }
    if (this.capability !== undefined) {
      json.capability = this.capability;
    }
    return json;
  }
}

/** Returns `true` when a value is a {@link GitForgeError}. */
export function isGitForgeError(value: unknown): value is GitForgeError {
  return value instanceof GitForgeError;
}

/** Response headers that may carry a request id, in priority order. */
const REQUEST_ID_HEADER_KEYS = ['x-github-request-id', 'x-request-id'] as const;

/**
 * Extracts a request id from response headers, then from the AtomGit error body.
 *
 * The body fallback is limited to exactly one key (`trace_id`): the whole body
 * is never retained on the error object, which keeps upstream payloads (and any
 * credentials they might contain) out of the public error surface.
 *
 * @returns The id, or `undefined` when no source has one. Never `''` and never
 *          a placeholder such as `'unknown'`, so callers can test truthiness.
 */
export function extractRequestId(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
  body?: unknown,
): string | undefined {
  if (headers !== undefined) {
    for (const key of REQUEST_ID_HEADER_KEYS) {
      const value = readHeader(headers, key);
      if (value !== undefined && value.length > 0) {
        return value;
      }
    }
  }

  if (body !== null && typeof body === 'object' && 'trace_id' in body) {
    const traceId = (body as { trace_id?: unknown }).trace_id;
    if (typeof traceId === 'string' && traceId.length > 0) {
      return traceId;
    }
  }

  return undefined;
}

/** Reads a header from either a `Headers` instance or a plain record. */
function readHeader(
  headers: Headers | Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(key);
    return value === null ? undefined : value;
  }
  const record = headers as Readonly<Record<string, string | undefined>>;
  return record[key] ?? record[key.toLowerCase()];
}

/**
 * Pulls a short, safe diagnostic out of an upstream error body.
 *
 * Only the message-like fields of the three platforms are considered, and the
 * result is truncated. This is the *only* body content allowed into an error
 * message; the rest of the payload stays out.
 */
export function extractUpstreamMessage(body: unknown, maxLength = 200): string | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  for (const key of ['message', 'error_message', 'error', 'errors']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return truncate(value, maxLength);
    }
  }
  return undefined;
}

/** Shortens a string, marking elision with an ellipsis. */
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

/**
 * Whether an upstream 403 means "quota exhausted" rather than "forbidden".
 *
 * GitHub reports rate limiting this way instead of with 429; Gitee and AtomGit
 * use 429. Detecting it keeps a retryable condition from being reported as a
 * permanent authorization failure.
 */
export function isRateLimitResponse(
  status: number,
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  if (status === 429) {
    return true;
  }
  if (status !== 403 || headers === undefined) {
    return false;
  }
  const remaining = readHeader(headers, 'x-ratelimit-remaining');
  return remaining !== undefined && remaining.trim() === '0';
}

/** Human-readable platform label used in messages. */
function describeProvider(provider: Provider | undefined): string {
  return provider === undefined ? 'the provider' : `provider=${provider}`;
}

/**
 * Maps an HTTP response to a {@link GitForgeError}.
 *
 * @param provider  Platform that produced the response.
 * @param status    HTTP status code.
 * @param headers   Response headers, for rate-limit and request-id detection.
 * @param body      Parsed response body, if any.
 * @param context   Short description of the attempt, e.g.
 *                  `GET /repos/{owner}/{repo}/issues`. Templates only — never a
 *                  concrete URL, which could carry a token.
 * @param secrets   Known token values to scrub from the message.
 */
export function errorFromResponse(params: {
  provider: Provider;
  status: number;
  headers?: Headers | Readonly<Record<string, string | undefined>>;
  body?: unknown;
  context: string;
  secrets?: readonly string[];
}): GitForgeError {
  const { provider, status, headers, body, context, secrets } = params;
  const code = mapStatusToCode(status, headers);
  const requestId = extractRequestId(headers, body);
  const upstream = extractUpstreamMessage(body);

  const detail = upstream === undefined ? '' : `: ${upstream}`;
  const message = `${context} failed with HTTP ${status} (${describeProvider(provider)})${detail}`;

  return new GitForgeError({
    code,
    message,
    provider,
    status,
    requestId,
    retryable: retryableForStatus(code, status),
    secrets,
  });
}

/**
 * Maps an HTTP status to an error code.
 *
 * Ordering matters: 403 is checked for rate limiting before being treated as an
 * authorization failure, because GitHub signals quota exhaustion with 403.
 */
export function mapStatusToCode(
  status: number,
  headers?: Headers | Readonly<Record<string, string | undefined>>,
): ErrorCode {
  if (status === 401) {
    return 'AUTH_INVALID';
  }
  if (isRateLimitResponse(status, headers)) {
    return 'RATE_LIMITED';
  }
  if (status === 403) {
    return 'AUTH_INVALID';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 400 || status === 422) {
    return 'INVALID_ARGUMENT';
  }
  return 'PROVIDER_ERROR';
}

/**
 * Retryability for a response-derived error.
 *
 * 5xx is retryable; any other `PROVIDER_ERROR` (405/409/…) is a permanent
 * upstream complaint and must not be retried.
 */
export function retryableForStatus(code: ErrorCode, status: number): boolean {
  if (code === 'RATE_LIMITED') {
    return true;
  }
  if (code === 'PROVIDER_ERROR') {
    return status >= 500;
  }
  if (code === 'NETWORK_ERROR') {
    return true;
  }
  return DEFAULT_RETRYABLE[code];
}

/**
 * Wraps a transport failure (fetch rejection, abort, timeout).
 *
 * The original is kept as `cause` so a caller can inspect it, but it is not
 * serialized: it may hold request details.
 */
export function errorFromNetwork(params: {
  provider: Provider;
  context: string;
  cause: unknown;
  secrets?: readonly string[];
  timeoutMs?: number;
}): GitForgeError {
  const { provider, context, cause, secrets, timeoutMs } = params;
  const reason = describeNetworkCause(cause, timeoutMs);
  return new GitForgeError({
    code: 'NETWORK_ERROR',
    message: `${context} failed: ${reason} (${describeProvider(provider)})`,
    provider,
    retryable: true,
    cause,
    secrets,
  });
}

/** Turns an unknown rejection into a short, non-leaking phrase. */
function describeNetworkCause(cause: unknown, timeoutMs: number | undefined): string {
  if (timeoutMs !== undefined) {
    const name = cause instanceof Error ? cause.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return `request timed out after ${timeoutMs}ms`;
    }
  }
  if (cause instanceof Error && cause.message.length > 0) {
    return `network error (${cause.name})`;
  }
  return 'network error';
}

/** Builds the `UNSUPPORTED_ON_PROVIDER` error for a method-level capability. */
export function unsupportedCapabilityError(
  provider: Provider,
  capability: CapabilityId | ParamCapabilityId,
): GitForgeError {
  return new GitForgeError({
    code: 'UNSUPPORTED_ON_PROVIDER',
    message: `${String(capability)} is not supported on provider=${provider}`,
    provider,
    capability,
  });
}

/** Builds the `AUTH_MISSING` error for a provider without a token. */
export function authMissingError(provider: Provider, envVar: string): GitForgeError {
  return new GitForgeError({
    code: 'AUTH_MISSING',
    message: `No token configured for provider=${provider}. Set ${envVar} and retry.`,
    provider,
  });
}

/** Builds the `READONLY_BLOCKED` error for a write capability. */
export function readonlyBlockedError(
  provider: Provider,
  capability: CapabilityId,
  method: string,
): GitForgeError {
  return new GitForgeError({
    code: 'READONLY_BLOCKED',
    message:
      `${method} is a write operation (${capability}) and was blocked because the client is read-only. ` +
      'Construct the client without `readonly` to allow writes.',
    provider,
    capability,
  });
}

/** Builds the `INVALID_ARGUMENT` error for local parameter validation. */
export function invalidArgumentError(
  message: string,
  provider?: Provider,
  capability?: CapabilityId | ParamCapabilityId,
): GitForgeError {
  return new GitForgeError({ code: 'INVALID_ARGUMENT', message, provider, capability });
}
