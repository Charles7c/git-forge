/**
 * Error assertions shared by the facade and contract suites.
 *
 * Every gate the facade implements is proven with the same two claims: the error
 * carries the documented fields, and it leaked no token. Both are checked here
 * so an assertion cannot accidentally cover only one of them.
 */
import { expect } from 'vitest';

import { GitForgeError } from '../../src/core/errors.js';
import type { ErrorCode } from '../../src/core/errors.js';
import type { CapabilityId, ParamCapabilityId, Provider } from '../../src/core/types.js';
import type { MockFetch } from './mockFetch.js';

/** Fixture token, assembled at runtime so no literal looks like a credential. */
export const TEST_TOKEN = ['facade', 'fixture', 'token'].join('-');

/** What a test expects an error to carry. */
export interface ExpectedError {
  code: ErrorCode;
  provider?: Provider;
  status?: number;
  capability?: CapabilityId | ParamCapabilityId;
  /** Substrings the message must contain. */
  messageIncludes?: string[];
}

/**
 * Awaits a promise and asserts it rejects with the expected `GitForgeError`.
 *
 * Fails the test if the promise resolves, if anything but a `GitForgeError`
 * escapes, or if a documented field does not match. Returns the error so a
 * caller can make further assertions.
 *
 * @param promise  Call under test.
 * @param expected Fields the error must carry.
 * @param secrets  Token values that must not appear in the message or JSON.
 */
export async function expectError<T>(
  promise: Promise<T>,
  expected: ExpectedError,
  secrets: readonly string[] = [TEST_TOKEN],
): Promise<GitForgeError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught, `expected ${expected.code} but the call resolved`).toBeInstanceOf(GitForgeError);
  const error = caught as GitForgeError;

  expect(error.code).toBe(expected.code);
  if (expected.provider !== undefined) {
    expect(error.provider).toBe(expected.provider);
  }
  if (expected.status !== undefined) {
    expect(error.status).toBe(expected.status);
  }
  if (expected.capability !== undefined) {
    expect(error.capability).toBe(expected.capability);
  }
  for (const fragment of expected.messageIncludes ?? []) {
    expect(error.message).toContain(fragment);
  }
  expectNoSecretLeak(error, secrets);
  return error;
}

/**
 * Asserts an error text carries no known secret.
 *
 * `access_token=` is included because a query-style leak would show up as that
 * literal rather than as the bare token value.
 */
export function expectNoSecretLeak(
  error: GitForgeError,
  secrets: readonly string[] = [TEST_TOKEN],
): void {
  const serialized = `${error.message}${JSON.stringify(error.toJSON())}${error.stack ?? ''}`;
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized).not.toContain('access_token=');
}

/**
 * Asserts a code path issued no HTTP at all.
 *
 * Centralized so every gate test states the zero-request claim identically; a
 * count mismatch then always points at the gate, never at the assertion.
 */
export function expectNoHttp(mock: MockFetch): void {
  expect(mock.calls).toHaveLength(0);
}
