import { afterEach, describe, expect, it } from 'vitest';

import { WRITE_CAPABILITIES } from '@charles7c/git-forge';
import { readConfig } from '../src/config.js';
import { connect } from './helpers/mcpHarness.js';
import type { McpHarness } from './helpers/mcpHarness.js';
import { isErrorResult, resultText } from './helpers/mcpHarness.js';

/**
 * Read-only enforcement, exercised end to end over MCP.
 *
 * The block lives in the SDK, so this suite does not test a second
 * implementation — it proves the wiring: either environment switch sets the
 * client's `readonly` flag, and the resulting tool error carries
 * `READONLY_BLOCKED` with **zero** HTTP calls.
 *
 * Every write tool is driven, so a tool added later without passing the flag
 * through would fail here.
 */
describe('read-only mode', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** A route table that would answer any write successfully, if it were reached. */
  const WOULD_SUCCEED = [
    {
      match: /.*/,
      responses: [{ body: { sha: 'a'.repeat(40), html_url: 'https://example.com/c' } }],
    },
  ];

  it.each([
    { GIT_FORGE_READONLY: '1' },
    { GITKIT_READONLY: '1' },
    { GIT_FORGE_READONLY: '1', GITKIT_READONLY: '0' },
    { GIT_FORGE_READONLY: '0', GITKIT_READONLY: '1' },
  ])('blocks all 11 write tools with zero HTTP for %o', async (env) => {
    harness = await connect(
      readConfig({
        ...env,
        GITHUB_TOKEN: 'test-gh',
        GITEE_TOKEN: 'test-ge',
        ATOMGIT_TOKEN: 'test-ag',
      }),
      WOULD_SUCCEED,
    );

    expect(WRITE_CAPABILITIES.size).toBe(12);

    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      {
        name: 'git_create_issue',
        arguments: { provider: 'github', owner: 'o', repo: 'r', title: 't' },
      },
      {
        name: 'git_update_issue',
        arguments: { provider: 'github', owner: 'o', repo: 'r', number: 1, title: 't' },
      },
      {
        name: 'git_create_issue_comment',
        arguments: { provider: 'github', owner: 'o', repo: 'r', number: 1, body: 'b' },
      },
      {
        name: 'git_create_pull_request',
        arguments: { provider: 'github', owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' },
      },
      {
        name: 'git_merge_pull_request',
        arguments: { provider: 'github', owner: 'o', repo: 'r', number: 1 },
      },
      {
        name: 'git_create_pull_request_comment',
        arguments: { provider: 'github', owner: 'o', repo: 'r', number: 1, body: 'b' },
      },
      { name: 'git_create_repository', arguments: { provider: 'github', name: 'n' } },
      {
        name: 'git_create_or_update_file',
        arguments: {
          provider: 'github',
          owner: 'o',
          repo: 'r',
          path: 'a.txt',
          content: 'hi',
          message: 'm',
        },
      },
      {
        name: 'git_delete_file',
        arguments: {
          provider: 'github',
          owner: 'o',
          repo: 'r',
          path: 'a.txt',
          message: 'm',
          sha: 'a'.repeat(40),
        },
      },
      {
        name: 'git_push_files',
        arguments: {
          provider: 'gitee',
          owner: 'o',
          repo: 'r',
          branch: 'dev',
          message: 'm',
          files: [
            { path: 'a.txt', action: 'create', content: 'hi' },
            { path: 'b.txt', action: 'create', content: 'hi' },
          ],
        },
      },
      {
        name: 'git_create_branch',
        arguments: { provider: 'github', owner: 'o', repo: 'r', name: 'n', from: 'dev' },
      },
    ];

    // 11 tools cover the 12 write capabilities: create_or_update_file serves
    // both files.create and files.update.
    expect(calls).toHaveLength(11);

    for (const call of calls) {
      const result = await harness.client.callTool(call);
      expect(isErrorResult(result), `${call.name} was not blocked`).toBe(true);
      expect(resultText(result), `${call.name} did not report READONLY_BLOCKED`).toContain(
        'READONLY_BLOCKED',
      );
    }

    expect(harness.mock.calls).toHaveLength(0);
  });

  it('blocks a write on a provider with no token too, reporting the read-only cause', async () => {
    // Both gates would refuse. The read-only one wins because it is decidable
    // offline, which is what makes an MCP switch predictable.
    harness = await connect({ tokens: {}, readonly: true, configured: [] }, WOULD_SUCCEED);

    const result = await harness.client.callTool({
      name: 'git_create_issue',
      arguments: { provider: 'atomgit', owner: 'o', repo: 'r', title: 't' },
    });

    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('READONLY_BLOCKED');
    expect(resultText(result)).not.toContain('AUTH_MISSING');
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('still serves reads while read-only', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: true, configured: ['github'] }, [
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

    const result = await harness.client.callTool({
      name: 'git_get_repository',
      arguments: { provider: 'github', owner: 'o', repo: 'r' },
    });

    expect(isErrorResult(result)).toBe(false);
    expect(harness.mock.calls).toHaveLength(1);
  });

  it('reports the read-only block with the capability name', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: true, configured: ['github'] });
    const result = await harness.client.callTool({
      name: 'git_create_issue',
      arguments: { provider: 'github', owner: 'o', repo: 'r', title: 't' },
    });

    const text = resultText(result);
    expect(text).toContain('issues.create');
    expect(text).toContain('provider=github');
  });
});
