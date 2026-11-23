import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatError, toErrorResult, wrap } from '../src/errors.js';
import { GitForgeError } from '@charles7c/git-forge';
import { connect, isErrorResult, resultText } from './helpers/mcpHarness.js';
import type { McpHarness } from './helpers/mcpHarness.js';

/**
 * Error rendering and resilience.
 *
 * Two properties matter to an MCP client: the failure text names the cause in a
 * way the model can act on, and a failing tool never takes the connection down
 * with it.
 */
describe('error formatting', () => {
  it('renders a code, provider and message for a GitForgeError', () => {
    const error = new GitForgeError({
      code: 'AUTH_MISSING',
      message: 'No token configured for provider=gitee. Set GITEE_TOKEN and retry.',
      provider: 'gitee',
    });

    const text = formatError(error);
    expect(text).toContain('[AUTH_MISSING]');
    expect(text).toContain('provider=gitee');
    expect(text).toContain('GITEE_TOKEN');
  });

  it('includes status, requestId and capability when known', () => {
    const error = new GitForgeError({
      code: 'RATE_LIMITED',
      message: 'rate limited',
      provider: 'github',
      status: 429,
      requestId: 'req-1',
      capability: 'issues.list',
    });

    const text = formatError(error);
    expect(text).toContain('status=429');
    expect(text).toContain('requestId=req-1');
    expect(text).toContain('capability=issues.list');
    expect(text).toContain('retryable=true');
  });

  it('omits absent fields rather than printing placeholders', () => {
    const error = new GitForgeError({ code: 'PROVIDER_ERROR', message: 'boom' });
    const text = formatError(error);

    expect(text).not.toContain('provider=');
    expect(text).not.toContain('status=');
    expect(text).toContain('[PROVIDER_ERROR]');
  });

  it('wraps a non-GitForgeError as INTERNAL without leaking a stack', () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const result = toErrorResult(new TypeError('synthetic diagnostic value'));
    try {
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(resultText(result)).not.toContain('synthetic diagnostic value');

    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain('[INTERNAL]');
    expect(text).toContain('TypeError');
    expect(text).not.toContain('at ');
  });

  it('never rejects from wrap', async () => {
    const result = await wrap(() => Promise.reject(new Error('async failure')));
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('[INTERNAL]');
  });

  it('returns the value on success', async () => {
    const result = await wrap(() => Promise.resolve({ ok: true }));
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('"ok": true');
  });
});

describe('tool-level errors over MCP', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('reports AUTH_MISSING and names the environment variable', async () => {
    // No gitee token: the call must fail with an actionable message.
    harness = await connect({ tokens: {}, readonly: false, configured: [] });

    const result = await harness.client.callTool({
      name: 'git_get_repository',
      arguments: { provider: 'gitee', owner: 'o', repo: 'r' },
    });

    expect(isErrorResult(result)).toBe(true);
    const text = resultText(result);
    expect(text).toContain('AUTH_MISSING');
    expect(text).toContain('provider=gitee');
    expect(text).toContain('Set GITEE_TOKEN and restart the server');
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('reports UNSUPPORTED_ON_PROVIDER for AtomGit pushFiles without crashing', async () => {
    harness = await connect({ tokens: { atomgit: 'x' }, readonly: false, configured: ['atomgit'] });

    const result = await harness.client.callTool({
      name: 'git_push_files',
      arguments: {
        provider: 'atomgit',
        owner: 'o',
        repo: 'r',
        branch: 'dev',
        message: 'm',
        files: [
          { path: 'a.txt', action: 'create', content: 'hi' },
          { path: 'b.txt', action: 'create', content: 'hi' },
        ],
      },
    });

    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('UNSUPPORTED_ON_PROVIDER');
    expect(resultText(result)).toContain('files.pushFiles');
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('reports an upstream 404 as NOT_FOUND', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      { match: /.*/, responses: [{ status: 404, body: { message: 'Not Found' } }] },
    ]);

    const result = await harness.client.callTool({
      name: 'git_get_issue',
      arguments: { provider: 'github', owner: 'o', repo: 'r', number: 999999 },
    });

    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('NOT_FOUND');
    expect(resultText(result)).toContain('status=404');
  });

  it('keeps the session alive after a failed call', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      { match: /\/issues\/999/, responses: [{ status: 404, body: { message: 'Not Found' } }] },
      {
        match: /.*/,
        responses: [
          {
            body: {
              id: 1,
              name: 'r',
              full_name: 'o/r',
              owner: { login: 'o' },
              html_url: 'https://example.com/o/r',
              web_url: 'https://example.com/o/r',
              default_branch: 'dev',
              private: false,
            },
          },
        ],
      },
    ]);

    const failed = await harness.client.callTool({
      name: 'git_get_issue',
      arguments: { provider: 'github', owner: 'o', repo: 'r', number: 999 },
    });
    expect(isErrorResult(failed)).toBe(true);

    // The same connection still answers.
    const ok = await harness.client.callTool({
      name: 'git_get_repository',
      arguments: { provider: 'github', owner: 'o', repo: 'r' },
    });
    expect(isErrorResult(ok)).toBe(false);
  });

  it('reports a connection failure as NETWORK_ERROR', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      { match: /.*/, responses: [{ throws: new TypeError('fetch failed') }] },
    ]);

    const result = await harness.client.callTool({
      name: 'git_get_repository',
      arguments: { provider: 'github', owner: 'o', repo: 'r' },
    });

    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('NETWORK_ERROR');
  });
});
