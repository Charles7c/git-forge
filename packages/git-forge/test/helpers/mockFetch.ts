/**
 * Fetch doubles for tests.
 *
 * Every test substitutes this for `globalThis.fetch`, which is how the suite
 * stays offline. The double records each call so tests can assert on the URL,
 * method, headers and body the library actually produced.
 */

/** One recorded invocation. */
export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Raw body as passed to `fetch`, or `undefined`. */
  body: string | undefined;
  /** Parsed JSON body, when the body was JSON. */
  json: unknown;
  /** Parsed `URLSearchParams` body, when the body was form-encoded. */
  form: Record<string, string> | undefined;
  /** Signal passed by the caller, so tests can assert timeout wiring. */
  signal: AbortSignal | undefined;
}

/** A canned response for a matched route. */
export interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw text body, overriding `body`. */
  text?: string;
  /** When set, the fetch call rejects with this error instead of responding. */
  throws?: Error;
}

/** Matches a call: either a substring of the URL or a predicate. */
export type RouteMatcher = string | RegExp | ((call: MockCall) => boolean);

/** One route in the mock's routing table. */
export interface MockRoute {
  match: RouteMatcher;
  /** Responses are consumed in order; the last one repeats once exhausted. */
  responses: MockResponseInit[];
  /** Restricts the route to specific HTTP methods. */
  method?: string;
  /** Times this route may match before it stops being considered. */
  times?: number;
}

/** The mocked fetch plus introspection helpers. */
export interface MockFetch {
  /** Drop-in replacement for `globalThis.fetch`. */
  fetch: typeof fetch;
  /** Every call, in order. */
  calls: MockCall[];
  /** Calls whose URL matches a pattern. */
  callsMatching(pattern: RouteMatcher): MockCall[];
  /** Clears recorded calls, keeping the routing table. */
  reset(): void;
  /** Replaces the routing table. */
  setRoutes(routes: MockRoute[]): void;
}

/** Reads a header bag from the shapes fetch accepts. */
function normalizeHeaders(init: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (init === undefined) {
    return out;
  }
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const pair of init) {
      const [key, value] = pair;
      if (key === undefined || value === undefined) {
        continue;
      }
      out[key.toLowerCase()] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(init)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/** Parses a recorded body into JSON and/or form views. */
function parseBody(body: unknown): Pick<MockCall, 'body' | 'json' | 'form'> {
  if (body === null || body === undefined) {
    return { body: undefined, json: undefined, form: undefined };
  }
  if (typeof body !== 'string') {
    // Only string bodies are produced by the library; anything else is recorded
    // as an opaque marker so an unexpected shape shows up in the assertion diff
    // without stringifying an object.
    return { body: `[non-string body: ${typeof body}]`, json: undefined, form: undefined };
  }
  let json: unknown;
  let form: Record<string, string> | undefined;
  try {
    json = JSON.parse(body);
  } catch {
    if (body.includes('=')) {
      const params = new URLSearchParams(body);
      const record: Record<string, string> = {};
      params.forEach((value, key) => {
        record[key] = value;
      });
      form = record;
    }
  }
  return { body, json, form };
}

/** Tests whether a recorded call matches a matcher. */
function matches(matcher: RouteMatcher, call: MockCall): boolean {
  if (typeof matcher === 'string') {
    return call.url.includes(matcher);
  }
  if (matcher instanceof RegExp) {
    return matcher.test(call.url);
  }
  return matcher(call);
}

/**
 * Builds a mock fetch.
 *
 * Routes are consulted in declaration order; the first that matches and still
 * has responses left wins. A call matching no route rejects, so an unexpected
 * request fails the test loudly instead of returning a silent `undefined`.
 */
export function createMockFetch(routes: MockRoute[] = []): MockFetch {
  let table = routes;
  const calls: MockCall[] = [];
  const consumed = new Map<MockRoute, number>();

  // Not `async`: the double resolves or rejects synchronously, which matches
  // `fetch`'s contract without tripping `require-await`.
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsed = parseBody(init?.body);

    const call: MockCall = {
      url,
      method,
      headers: normalizeHeaders(init?.headers),
      signal: init?.signal ?? undefined,
      ...parsed,
    };
    calls.push(call);

    for (const route of table) {
      if (route.method !== undefined && route.method.toUpperCase() !== method) {
        continue;
      }
      if (!matches(route.match, call)) {
        continue;
      }
      const used = consumed.get(route) ?? 0;
      if (route.times !== undefined && used >= route.times) {
        continue;
      }
      const index = Math.min(used, route.responses.length - 1);
      const response = route.responses[index];
      if (response === undefined) {
        continue;
      }
      consumed.set(route, used + 1);

      if (response.throws !== undefined) {
        return Promise.reject(response.throws);
      }

      const headers = new Headers(response.headers ?? {});
      if (response.text !== undefined) {
        return Promise.resolve(
          new Response(response.text, { status: response.status ?? 200, headers }),
        );
      }
      const payload = response.body === undefined ? null : JSON.stringify(response.body);
      if (payload !== null && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return Promise.resolve(new Response(payload, { status: response.status ?? 200, headers }));
    }

    return Promise.reject(new Error(`mock fetch: no route matched ${method} ${url}`));
  };

  return {
    fetch: fetchImpl,
    calls,
    callsMatching(pattern: RouteMatcher): MockCall[] {
      return calls.filter((call) => matches(pattern, call));
    },
    reset(): void {
      calls.length = 0;
      consumed.clear();
    },
    setRoutes(next: MockRoute[]): void {
      table = next;
      consumed.clear();
    },
  };
}

/** A `sleep` replacement that records requested delays instead of waiting. */
export function createRecordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

/** A `random` stub that yields a fixed sequence, cycling at the end. */
export function createSequenceRandom(values: readonly number[]): () => number {
  if (values.length === 0) {
    throw new Error('createSequenceRandom requires at least one value');
  }
  let index = 0;
  return (): number => {
    const value = values[index % values.length];
    index += 1;
    return value ?? 0;
  };
}

/** Builds a JSON response body record for fixtures. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): MockResponseInit {
  return { body, status: init.status ?? 200, headers: init.headers };
}
