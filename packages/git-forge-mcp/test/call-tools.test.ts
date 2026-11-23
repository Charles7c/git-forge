import { afterEach, describe, expect, it } from 'vitest';

import { readConfig } from '../src/config.js';
import {
  connect,
  isErrorResult,
  resultJson,
  resultText,
  BRANCH,
  ISSUE,
  REPOSITORY,
} from './helpers/mcpHarness.js';
import type { McpHarness } from './helpers/mcpHarness.js';

/**
 * `tools/call` round trips.
 *
 * The claim under test is structural: a tool result carries the SDK's own model,
 * not a reshaped copy. So each case asserts the fields the SDK documents
 * (`provider`/`owner`/`repo`, `number`, `commit_sha`, ...) on the parsed payload.
 */
describe('tools/call', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('lists issues through git_list_issues', async () => {
    harness = await connect({ tokens: { gitee: 'x' }, readonly: false, configured: ['gitee'] }, [
      {
        match: (call: { url: string }) => new URL(call.url).pathname.endsWith('/issues'),
        responses: [{ body: [{ ...ISSUE, number: '00101' }] }],
      },
    ]);

    const result = await harness.client.callTool({
      name: 'git_list_issues',
      arguments: { provider: 'gitee', owner: 'example-org', repo: 'demo-kit' },
    });

    expect(isErrorResult(result)).toBe(false);
    const issues = resultJson<Record<string, unknown>[]>(result);
    // Both Gitee state queries return the same issue; its native number survives the merge.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      provider: 'gitee',
      owner: 'example-org',
      repo: 'demo-kit',
      number: '00101',
      number_as_number: 101,
      title: 'an issue',
    });
    expect(harness.mock.calls).toHaveLength(2);
  });

  it('reads a repository through git_get_repository', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      { match: /.*/, responses: [{ body: REPOSITORY }] },
    ]);

    const result = await harness.client.callTool({
      name: 'git_get_repository',
      arguments: { provider: 'github', owner: 'example-org', repo: 'demo-kit' },
    });

    expect(isErrorResult(result)).toBe(false);
    const repo = resultJson<Record<string, unknown>>(result);
    expect(repo).toMatchObject({
      provider: 'github',
      name: 'demo-kit',
      html_url: 'https://example.com/example-org/demo-kit',
      default_branch: 'dev',
    });
  });

  it('lists branches through git_list_branches with a derived html_url', async () => {
    harness = await connect(
      { tokens: { atomgit: 'x' }, readonly: false, configured: ['atomgit'] },
      [
        {
          match: (call: { url: string }) => new URL(call.url).pathname.endsWith('/branches'),
          responses: [{ body: [BRANCH] }],
        },
      ],
    );

    const result = await harness.client.callTool({
      name: 'git_list_branches',
      arguments: { provider: 'atomgit', owner: 'example-org', repo: 'demo-kit' },
    });

    expect(isErrorResult(result)).toBe(false);
    const branches = resultJson<Record<string, unknown>[]>(result);
    expect(branches[0]).toMatchObject({
      provider: 'atomgit',
      name: 'dev',
      commit_sha: 'a'.repeat(40),
      html_url: 'https://atomgit.com/example-org/demo-kit/tree/dev',
    });
  });

  it('accepts one push entry but refuses an empty batch before HTTP', async () => {
    const sha = 'c'.repeat(40);
    harness = await connect(
      readConfig({ GITEE_TOKEN: 'x', GITKIT_READONLY: '0', GIT_FORGE_READONLY: '0' }),
      [{ match: /\/commits$/, responses: [{ status: 201, body: { sha } }] }],
    );
    const args = {
      provider: 'gitee',
      owner: 'example-org',
      repo: 'demo-kit',
      branch: 'dev',
      message: 'Add sample',
    };
    const empty = await harness.client.callTool({
      name: 'git_push_files',
      arguments: { ...args, files: [] },
    });
    expect(isErrorResult(empty)).toBe(true);
    expect(resultText(empty)).toContain('files');
    expect(harness.mock.calls).toHaveLength(0);

    const single = await harness.client.callTool({
      name: 'git_push_files',
      arguments: { ...args, files: [{ path: 'sample.txt', action: 'create', content: 'sample' }] },
    });
    expect(isErrorResult(single)).toBe(false);
    expect(resultJson(single)).toMatchObject({ paths: ['sample.txt'], commit_sha: sha });
    expect(harness.mock.calls).toHaveLength(1);
    expect(harness.mock.calls[0]?.method).toBe('POST');
  });

  it('passes filters through to the SDK, including the AtomGit head gap', async () => {
    harness = await connect(
      { tokens: { atomgit: 'x' }, readonly: false, configured: ['atomgit'] },
      [{ match: /.*/, responses: [{ body: [] }] }],
    );

    const result = await harness.client.callTool({
      name: 'git_list_pull_requests',
      arguments: {
        provider: 'atomgit',
        owner: 'example-org',
        repo: 'demo-kit',
        head: 'dev',
      },
    });

    // The gap is the SDK's decision; the tool just reports it.
    expect(isErrorResult(result)).toBe(true);
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('refuses an unknown provider at the schema boundary', async () => {
    harness = await connect();

    // The SDK validates arguments before the handler runs and reports the
    // violation as an error result carrying the -32602 text, so no request is
    // issued and the model still sees what went wrong.
    const result = await harness.client.callTool({
      name: 'git_get_repository',
      arguments: { provider: 'gitlab', owner: 'a', repo: 'b' },
    });

    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('-32602');
    expect(resultText(result)).toContain('provider');
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('refuses a missing required argument at the schema boundary', async () => {
    harness = await connect();
    const result = await harness.client.callTool({
      name: 'git_get_repository',
      arguments: { provider: 'github', owner: 'example-org' },
    });

    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('repo');
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('accepts a string issue id (Gitee codes are not numerals)', async () => {
    harness = await connect({ tokens: { gitee: 'x' }, readonly: false, configured: ['gitee'] }, [
      { match: /.*/, responses: [{ body: { ...ISSUE, number: 'IEXA01' } }] },
    ]);

    const result = await harness.client.callTool({
      name: 'git_get_issue',
      arguments: {
        provider: 'gitee',
        owner: 'example-org',
        repo: 'demo-kit',
        number: 'IEXA01',
      },
    });

    expect(isErrorResult(result)).toBe(false);
    const issue = resultJson<Record<string, unknown>>(result);
    expect(issue.number).toBe('IEXA01');
    expect(issue).not.toHaveProperty('number_as_number');
    expect(issue).not.toHaveProperty('key');
    expect(harness.mock.calls[0]?.url).toContain('IEXA01');
  });

  it('accepts a numeric issue id', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      { match: /.*/, responses: [{ body: ISSUE }] },
    ]);

    const result = await harness.client.callTool({
      name: 'git_get_issue',
      arguments: { provider: 'github', owner: 'example-org', repo: 'demo-kit', number: 101 },
    });

    expect(isErrorResult(result)).toBe(false);
    expect(harness.mock.calls[0]?.url).toContain('101');
  });
});
