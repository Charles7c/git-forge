import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';

// The production CLI deliberately has no environment switch for arbitrary API hosts.
// This test-only preload maps exactly one expected SDK request to a local socket.
const port = Number(process.env.FORGE_TEST_PORT);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
process.env.GITHUB_TOKEN = 'loopback-only-github';
const request = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  assert.equal(url.href, 'https://api.github.com/repos/sample-owner/sample-repo');
  assert.equal(init?.method, 'GET');
  return request(`http://127.0.0.1:${port}${url.pathname}`, { ...init, redirect: 'error' });
};
