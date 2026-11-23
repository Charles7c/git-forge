/**
 * HTTP request layer: the single exit point for every network call.
 *
 * Adapters never call `fetch` directly. Concentrating transport here is what
 * makes auth injection, timeouts, retries and redaction impossible to bypass,
 * and it gives tests one seam to substitute.
 */
import { errorFromNetwork, errorFromResponse, type GitForgeError } from './errors.js';
import { redactUrl } from './redact.js';
import {
  computeDelay,
  parseRetryAfter,
  resolveRetryPolicy,
  retryAfterFromHeaders,
  shouldRetry,
} from './retry.js';
import type { RetryPolicy } from './retry.js';
import type { Provider } from './types.js';

/** How a provider authenticates a request. */
export type AuthStyle = 'bearer' | 'query';

/** Authentication descriptor supplied by an adapter. */
export interface AuthConfig {
  /**
   * `bearer` sets `Authorization: Bearer <token>`; `query` appends
   * `access_token=<token>`.
   *
   * v0.1.0 defaults to `bearer` on all three platforms. `query` exists only for
   * compatibility with older Gitee/AtomGit integrations and forces redaction of
   * every URL that leaves this layer.
   */
  style: AuthStyle;
  /** Query parameter name used when `style === 'query'`. Defaults to `access_token`. */
  param?: string;
}

/**
 * Where the body payload goes on the wire.
 *
 * - `json` — JSON request body (default when a body is present).
 * - `form` — `application/x-www-form-urlencoded`.
 * - `query` — body fields are moved into the query string. Gitee's
 *   `DELETE /repos/{o}/{r}/contents/{path}` takes `sha`/`message` this way.
 */
export type ParamsIn = 'query' | 'json' | 'form';

/** HTTP methods this layer issues. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A single request description produced by an adapter. */
export interface HttpRequestSpec {
  method: HttpMethod;
  /**
   * Path template appended to the provider base URL, e.g.
   * `/repos/{owner}/{repo}/issues`.
   *
   * Kept as a template so it can appear in error messages verbatim — a concrete
   * URL might carry a token.
   */
  path: string;
  /** Values substituted into `{placeholder}` segments of `path`. */
  pathParams?: Readonly<Record<string, string>>;
  /** Query parameters; `undefined` values are dropped. */
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Payload for `POST`/`PATCH`/`PUT`/`DELETE`. */
  body?: unknown;
  /** How `body` is encoded. Defaults to `json` when a body is present. */
  paramsIn?: ParamsIn;
  /** Extra headers merged over the provider defaults. */
  headers?: Readonly<Record<string, string>>;
}

/** A response, already parsed. */
export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  json: T;
}

/** Options accepted by {@link HttpClient}. */
export interface HttpClientOptions {
  /** Platform base URL, without a trailing slash. */
  baseUrl: string;
  /** Platform this client speaks to; used for error context. */
  provider: Provider;
  /** Authentication descriptor; omit for unauthenticated calls. */
  auth?: AuthConfig;
  /** Token value. Never placed in a URL unless `auth.style === 'query'`. */
  token?: string;
  /** Headers sent with every request from this client. */
  defaultHeaders?: Readonly<Record<string, string>>;
  /** Injected transport. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Injected delay, so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected randomness for jitter, so tests are deterministic. */
  random?: () => number;
  /** Per-request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /** Retry policy overrides. */
  retry?: Partial<RetryPolicy>;
  /** `User-Agent` sent with every request. */
  userAgent?: string;
}

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default `User-Agent` sent when the caller supplies none. */
export const DEFAULT_USER_AGENT = 'git-forge/0.1.0';

/**
 * The request layer.
 *
 * One instance per provider per client: the token, provider and base URL are
 * fixed at construction, so an adapter cannot accidentally send one platform's
 * token to another.
 */
export class HttpClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly provider: Provider;

  private readonly auth: AuthConfig | undefined;
  private readonly token: string | undefined;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly policy: RetryPolicy;
  private readonly userAgent: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.provider = options.provider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.auth = options.auth;
    this.token = options.token;
    this.defaultHeaders = options.defaultHeaders ?? {};
    const injectedFetch = options.fetch;
    this.fetchImpl = injectedFetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.policy = resolveRetryPolicy(options.retry);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** Whether a token was configured on this client. */
  get hasToken(): boolean {
    return this.token !== undefined && this.token.length > 0;
  }

  /**
   * Renders a request for diagnostics.
   *
   * Query parameters are shown, path parameters are *not* substituted: the
   * template is what belongs in a message, both because a concrete path can
   * carry identifying data and because a caller needs the template to find the
   * endpoint in the platform docs. The token is never included.
   */
  /**
   * Renders a request for diagnostics.
   *
   * Query parameters are shown, path parameters are *not* substituted: the
   * template is what belongs in a message, both because a concrete path can
   * carry identifying data and because a caller needs the template to find the
   * endpoint in the platform docs. Under query-style auth the parameter is
   * present but redacted.
   */
  describe(spec: HttpRequestSpec): string {
    const params = new URLSearchParams();
    if (spec.query !== undefined) {
      for (const [key, value] of Object.entries(spec.query)) {
        if (value !== undefined) {
          params.set(key, stringifyScalar(value));
        }
      }
    }
    if (spec.paramsIn === 'query' && spec.body !== undefined && typeof spec.body === 'object') {
      for (const [key, value] of Object.entries(spec.body as Record<string, unknown>)) {
        if (value !== undefined && value !== null) {
          params.set(key, stringifyScalar(value));
        }
      }
    }
    if (this.auth?.style === 'query' && this.token !== undefined && this.token.length > 0) {
      params.set(this.auth.param ?? 'access_token', this.token);
    }
    const query = params.toString();
    const suffix = query.length > 0 ? `?${query}` : '';
    // redactUrl masks the token before the string can be observed.
    return redactUrl(`${this.baseUrl}${spec.path}${suffix}`);
  }

  /**
   * Performs one logical request, retrying per policy.
   *
   * @throws GitForgeError always — a raw `Error` never escapes this method.
   */
  async request<T = unknown>(spec: HttpRequestSpec): Promise<HttpResponse<T>> {
    const maxAttempts = this.policy.maxRetries + 1;
    let lastError: GitForgeError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.attempt<T>(spec);

      if (outcome.kind === 'response') {
        return outcome.response;
      }

      const { error, retryAfterMs } = outcome;
      lastError = error;

      const retryable = shouldRetry({
        attempt,
        method: spec.method,
        code: error.code,
        status: error.status,
        policy: this.policy,
        retryAfterMs,
      });
      if (!retryable) {
        throw error;
      }

      const delay = computeDelay(attempt, this.policy, this.random, retryAfterMs);
      await this.sleep(delay);
    }

    // All attempts were made and the last one failed: surface that error.
    throw lastError ?? new Error('request failed without an error');
  }

  /** Performs exactly one attempt and reports its outcome without retrying. */
  private async attempt<T>(
    spec: HttpRequestSpec,
  ): Promise<
    | { kind: 'response'; response: HttpResponse<T> }
    | { kind: 'failure'; error: GitForgeError; retryAfterMs?: number }
  > {
    const url = this.buildUrl(spec);
    const headers = this.buildHeaders(spec);
    const body = this.buildBody(spec);
    const context = this.describe(spec);
    const secrets = this.secretValues();

    // AbortSignal.timeout covers the whole attempt, including a slow body read.
    const signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: body ?? null,
        signal,
      });
    } catch (cause) {
      return {
        kind: 'failure',
        error: errorFromNetwork({
          provider: this.provider,
          context,
          cause,
          secrets,
          timeoutMs: this.timeoutMs,
        }),
      };
    }

    if (!response.ok) {
      const error = errorFromResponse({
        provider: this.provider,
        status: response.status,
        headers: response.headers,
        body: await this.readJsonSafely(response),
        context,
        secrets,
      });
      // Reset headers accompany ordinary GitHub traffic too. Only a quota failure
      // can use that fallback; Retry-After itself applies across all providers.
      const retryAfterMs =
        this.provider === 'github' && error.code === 'RATE_LIMITED'
          ? retryAfterFromHeaders(response.headers)
          : parseRetryAfter(response.headers.get('retry-after'));
      return { kind: 'failure', error, retryAfterMs };
    }

    const json = (await this.readJsonSafely(response)) as T;
    return {
      kind: 'response',
      response: { status: response.status, headers: response.headers, json },
    };
  }

  /**
   * Builds the concrete URL, including the token when query-style auth is on.
   *
   * `describe()` redacts the result, so the token exists only inside this
   * function's return value and never reaches a message on its own.
   */
  private buildUrl(spec: HttpRequestSpec): string {
    const path = substitutePath(spec.path, spec.pathParams);
    const url = new URL(`${this.baseUrl}${path}`);

    const queryParams: Record<string, string | number | boolean | undefined> = {
      ...(spec.query ?? {}),
    };

    // `paramsIn: 'query'` moves body fields into the query string.
    if (spec.paramsIn === 'query' && spec.body !== undefined && typeof spec.body === 'object') {
      for (const [key, value] of Object.entries(spec.body as Record<string, unknown>)) {
        if (value !== undefined && value !== null) {
          queryParams[key] = value as string | number | boolean;
        }
      }
    }

    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    if (this.auth?.style === 'query' && this.token !== undefined && this.token.length > 0) {
      url.searchParams.set(this.auth.param ?? 'access_token', this.token);
    }

    return url.toString();
  }

  /** Assembles request headers, injecting auth when bearer-style. */
  private buildHeaders(spec: HttpRequestSpec): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      ...lowercaseKeys(this.defaultHeaders),
    };

    if (this.auth?.style !== 'query' && this.token !== undefined && this.token.length > 0) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const hasBody = spec.body !== undefined && spec.paramsIn !== 'query';
    if (hasBody && headers['content-type'] === undefined) {
      headers['content-type'] =
        spec.paramsIn === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
    }

    if (spec.headers !== undefined) {
      Object.assign(headers, lowercaseKeys(spec.headers));
    }

    return headers;
  }

  /** Encodes the body per `paramsIn`. */
  private buildBody(spec: HttpRequestSpec): string | undefined {
    if (spec.body === undefined || spec.paramsIn === 'query') {
      return undefined;
    }
    if (spec.paramsIn === 'form') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(spec.body as Record<string, unknown>)) {
        if (value === undefined || value === null) {
          continue;
        }
        params.set(key, encodeFormValue(value));
      }
      return params.toString();
    }
    return JSON.stringify(spec.body);
  }

  /** Reads a response body as JSON, tolerating empty and non-JSON payloads. */
  private async readJsonSafely(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      // A non-JSON body (proxy error page, HTML login redirect) is passed
      // through as text so the caller can still see something meaningful.
      return text;
    }
  }

  /** Known token values, for scrubbing error messages. */
  private secretValues(): readonly string[] {
    return this.token !== undefined && this.token.length > 0 ? [this.token] : [];
  }
}

/** Substitutes `{name}` placeholders and URL-encodes each value. */
function substitutePath(
  template: string,
  params: Readonly<Record<string, string>> | undefined,
): string {
  let path = template;
  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) {
      path = path.split(`{${key}}`).join(encodeURIComponent(value));
    }
  }
  return path;
}

/** Lowercases header names so merging cannot duplicate a header. */
function lowercaseKeys(record: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** Renders a form field, flattening arrays the way the platforms expect. */
function encodeFormValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => stringifyScalar(entry)).join(',');
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return stringifyScalar(value);
}

/**
 * Renders a query or form value.
 *
 * Explicit about scalar types so a non-scalar placed in a query string is
 * serialized predictably instead of hitting `Object.prototype.toString`.
 */
function stringifyScalar(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) {
    return '';
  }
  return JSON.stringify(value) ?? '';
}

/** Removes a trailing slash so path concatenation cannot double up. */
function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
