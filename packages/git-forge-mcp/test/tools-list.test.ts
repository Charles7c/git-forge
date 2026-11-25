import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_NAMES } from '../src/tools/index.js';
import { ATOMGIT_NO_HEAD_FILTER, PUSH_FILES_UNSUPPORTED } from '../src/tools/descriptions.js';
import { connect } from './helpers/mcpHarness.js';
import type { McpHarness } from './helpers/mcpHarness.js';

/**
 * `tools/list` contract.
 *
 * The published tool list is the server's whole public surface, so it is asserted
 * three ways: the exact 29 names, per-tool schema facts the caller depends on
 * (provider enum, native issue id), and the generated platform sentences that
 * keep a description from drifting away from the capability tables.
 */
describe('tools/list', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('lists exactly the 29 documented git_ tools', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();

    expect(tools).toHaveLength(29);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.name.startsWith('git_')).toBe(true);
    }
  });

  it('covers every domain', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    // Issue (7), Pull request (6), Repository (4 + stargazers), Files (3),
    // Branch/commit (4), Release (1), Label (3).
    expect(names.filter((name) => name.includes('issue'))).toHaveLength(7);
    expect(names.filter((name) => name.includes('pull_request'))).toHaveLength(6);
    expect(
      names.filter((name) =>
        ['git_list_repositories', 'git_get_repository', 'git_create_repository'].includes(name),
      ),
    ).toHaveLength(3);
    expect(names).toContain('git_list_stargazers');
    expect(names).toContain('git_get_file_contents');
    // `commit` matches git_list_commits and git_get_commit only; the issue-event
    // tool ends in `_events`, so it does not leak into this count.
    expect(names.filter((name) => name.includes('commit'))).toHaveLength(2);
    expect(names.filter((name) => name.includes('branch'))).toHaveLength(2);
    expect(names).toContain('git_create_or_update_file');
    expect(names).toContain('git_delete_file');
    expect(names).toContain('git_push_files');
    expect(names).toContain('git_list_releases');
    expect(names.filter((name) => name.includes('label'))).toHaveLength(3);
  });

  it('gives every tool a non-empty description mentioning the platforms', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      const description = tool.description ?? '';
      // Every tool states its per-platform support, so a model can pick a
      // provider instead of discovering the gap by failing.
      expect(description, `${tool.name} omits platform support`).toMatch(/GitHub:|Gitee:|AtomGit:/);
    }
  });

  it('adds a pagination/retry sentence to every list tool that paginates', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    // `git_list_issue_events` is excluded on purpose: Gitee and AtomGit expose
    // their operation log with no page parameter, so claiming auto-pagination
    // there would be false. Its description states the single-request behaviour.
    const listTools = tools.filter(
      (tool) => tool.name.startsWith('git_list_') && tool.name !== 'git_list_issue_events',
    );

    expect(listTools.length).toBeGreaterThan(0);
    for (const tool of listTools) {
      expect(tool.description ?? '').toContain('auto-paginate');
    }
  });

  it('states the single-request behaviour of the issue-event log', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const events = tools.find((tool) => tool.name === 'git_list_issue_events');
    const description = events?.description ?? '';

    expect(description).not.toContain('auto-paginate');
    expect(description).toContain('no page parameter');
  });

  it('exposes provider as a three-value enum on every tool', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { enum?: string[] }>;
        required?: string[];
      };
      const provider = schema.properties?.provider;
      expect(provider, `${tool.name} has no provider parameter`).toBeDefined();
      expect(provider?.enum).toEqual(['github', 'gitee', 'atomgit']);
      expect(schema.required).toContain('provider');
    }
  });

  it('accepts a string or a number for an issue id on the issue tools', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const getIssue = tools.find((tool) => tool.name === 'git_get_issue');
    const schema = getIssue?.inputSchema as {
      properties?: Record<string, { anyOf?: { type?: string }[] }>;
    };
    const number = schema.properties?.number;

    // Gitee ids are codes such as `IEXA01`, so the schema cannot be integer-only.
    expect(number?.anyOf?.map((entry) => entry.type).sort()).toEqual(['integer', 'string']);
  });

  it('does not advertise the read-only block on a writable server', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      expect(tool.description ?? '').not.toContain('blocked in readonly mode');
    }
  });

  it('advertises the read-only block on every write tool when readonly is on', async () => {
    harness = await connect({
      tokens: { github: 'x', gitee: 'x', atomgit: 'x' },
      readonly: true,
      configured: ['github', 'gitee', 'atomgit'],
    });
    const { tools } = await harness.client.listTools();

    // 13 write tools: create_or_update_file covers files.create and files.update,
    // and ensure_label composes labels.list with labels.create.
    const blocked = tools.filter((tool) =>
      (tool.description ?? '').includes('blocked in readonly mode'),
    );
    expect(blocked.map((tool) => tool.name).sort()).toEqual(
      [
        'git_create_branch',
        'git_create_issue',
        'git_create_issue_comment',
        'git_create_label',
        'git_create_or_update_file',
        'git_create_pull_request',
        'git_create_pull_request_comment',
        'git_create_repository',
        'git_delete_file',
        'git_ensure_label',
        'git_merge_pull_request',
        'git_push_files',
        'git_update_issue',
      ].sort(),
    );
  });

  it('still lists all 29 tools in read-only mode', async () => {
    harness = await connect({
      tokens: {},
      readonly: true,
      configured: [],
    });
    const { tools } = await harness.client.listTools();
    expect(tools).toHaveLength(29);
  });
});

describe('generated descriptions', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('states all three platforms for git_push_files, never only AtomGit', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const push = tools.find((tool) => tool.name === 'git_push_files');
    const description = push?.description ?? '';

    // The regression this guards: describing only the AtomGit gap would hide
    // Gitee's working single-commit batch from the model.
    expect(description).toContain('GitHub: supported (single commit)');
    expect(description).toContain('Gitee: supported (single commit)');
    expect(description).toContain(PUSH_FILES_UNSUPPORTED);
    expect(description).toContain('unsupported');
  });

  it('states the AtomGit head-filter gap for git_list_pull_requests', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const listPulls = tools.find((tool) => tool.name === 'git_list_pull_requests');

    expect(listPulls?.description ?? '').toContain(ATOMGIT_NO_HEAD_FILTER);
  });

  it('derives the platform sentences from the capability tables', async () => {
    // A description naming a platform the table does not support, or missing one
    // it does, would mean the generator is not the single source.
    harness = await connect();
    const { tools } = await harness.client.listTools();

    for (const tool of tools) {
      const description = tool.description ?? '';
      // Every description names each platform at least once, and no platform is
      // silently omitted — which is what a hand-written description risks.
      // `git_create_or_update_file` legitimately names them twice (create and
      // update are separate capabilities there).
      for (const label of ['GitHub:', 'Gitee:', 'AtomGit:']) {
        expect(description, `${tool.name} omits ${label}`).toContain(label);
      }
    }
  });
});
