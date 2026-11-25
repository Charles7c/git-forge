import { afterEach, describe, expect, it } from 'vitest';

import { connect, isErrorResult, resultJson, resultText } from './helpers/mcpHarness.js';
import type { McpHarness } from './helpers/mcpHarness.js';

/**
 * Release-blocking MCP counter-examples for 0.2.0.
 *
 * Driven through a real `tools/call` over `InMemoryTransport`, so what is
 * asserted here is what a remote client observes: the same schema, the same
 * handler, the same JSON payload.
 *
 * Two claims:
 *
 * 1. `git_ensure_label` accepts a call with no `color` and answers with the
 *    existing label — after *paging* to the page the label is on, and with zero
 *    POST. A schema that demanded `color` made the tool unusable for the
 *    existence-check case the SDK explicitly supports.
 * 2. `git_create_label` still requires it: the SDK cannot create without a
 *    colour, so the schema must not accept a call that cannot succeed.
 */
describe('git_ensure_label', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** 100 labels per page, none of them the wanted one. */
  function filler(offset: number): { name: string; color: string }[] {
    return Array.from({ length: 100 }, (_, index) => ({
      name: `filler-${String(offset + index)}`,
      color: 'ededed',
    }));
  }

  const WANTED = { name: '5.0.0', color: '1f883d', description: 'version label' };

  it('finds a label on page 3 with no color given and makes no write', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      {
        match: (call: { url: string }) => new URL(call.url).pathname.endsWith('/labels'),
        responses: [
          // Upstream signals two more pages by total_page, which is what makes
          // this a *paging* case rather than a single-page one.
          { body: filler(0), headers: { total_page: '3' } },
          { body: filler(100), headers: { total_page: '3' } },
          { body: [...filler(200), WANTED], headers: { total_page: '3' } },
        ],
      },
    ]);

    const result = await harness.client.callTool({
      name: 'git_ensure_label',
      arguments: { provider: 'github', owner: 'example-org', repo: 'demo-kit', name: '5.0.0' },
    });

    expect(isErrorResult(result)).toBe(false);
    const label = resultJson<Record<string, unknown>>(result);
    expect(label).toMatchObject({
      provider: 'github',
      owner: 'example-org',
      repo: 'demo-kit',
      name: '5.0.0',
      color: '#1f883d',
      description: 'version label',
    });

    // Three GETs, all on /labels, and the URL page parameter actually advanced.
    const pages = harness.mock.calls.map((call) => new URL(call.url).searchParams.get('page'));
    expect(pages).toEqual(['1', '2', '3']);
    expect(harness.mock.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(harness.mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('creates when absent, using the color the caller supplied', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      {
        match: (call: { url: string }) => new URL(call.url).pathname.endsWith('/labels'),
        responses: [{ body: [] }, { body: WANTED }],
      },
    ]);

    const result = await harness.client.callTool({
      name: 'git_ensure_label',
      arguments: {
        provider: 'github',
        owner: 'example-org',
        repo: 'demo-kit',
        name: '5.0.0',
        color: '#1f883d',
      },
    });

    expect(isErrorResult(result)).toBe(false);
    expect(resultJson<Record<string, unknown>>(result)).toMatchObject({ name: '5.0.0' });
    const writes = harness.mock.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.json).toMatchObject({ name: '5.0.0', color: '1f883d' });
  });

  it('refuses to create without a color, with the SDK error and zero writes', async () => {
    harness = await connect({ tokens: { github: 'x' }, readonly: false, configured: ['github'] }, [
      {
        match: (call: { url: string }) => new URL(call.url).pathname.endsWith('/labels'),
        responses: [{ body: [] }],
      },
    ]);

    const result = await harness.client.callTool({
      name: 'git_ensure_label',
      arguments: { provider: 'github', owner: 'example-org', repo: 'demo-kit', name: '5.0.0' },
    });

    // The tool is callable; the failure is the SDK's, and it names `color`.
    expect(isErrorResult(result)).toBe(true);
    expect(resultText(result)).toContain('INVALID_ARGUMENT');
    expect(resultText(result)).toContain('color');
    expect(harness.mock.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('declares color optional in its published schema', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const ensure = tools.find((tool) => tool.name === 'git_ensure_label');
    const schema = ensure?.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(schema.required).toContain('name');
    expect(schema.required).not.toContain('color');
    expect(schema.properties?.color).toBeDefined();
  });

  it('still requires color on git_create_label', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const create = tools.find((tool) => tool.name === 'git_create_label');
    const schema = create?.inputSchema as { required?: string[] };

    expect(schema.required).toContain('color');
  });
});

/**
 * Tool descriptions, checked for the two 0.2.0 corrections: the request count
 * of `ensure_label` and the AtomGit description field of `create_label`.
 */
describe('corrected tool descriptions', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('no longer claims git_ensure_label sends at most two requests', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const ensure = tools.find((tool) => tool.name === 'git_ensure_label');
    const description = ensure?.description ?? '';

    // A complete listing may need up to `maxPages` reads, so "two requests at
    // most" was false the moment a repository had more than one page of labels.
    expect(description).not.toContain('Two requests at most');
    expect(description).toMatch(/list|page/i);
    expect(description).toContain('color');
    expect(description).toMatch(/only .*creat/i);
  });

  it('does not claim AtomGit can write a label description', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const create = tools.find((tool) => tool.name === 'git_create_label');
    const description = create?.description ?? '';

    // AtomGit's create-label body accepts `name` + `color` only, exactly like
    // Gitee. The old description named Gitee alone and implied AtomGit stored it.
    expect(description).not.toMatch(/Gitee has no label description field/i);
    expect(description).toMatch(/Gitee and AtomGit/i);
  });

  it('lists unknown among the event types a caller may receive', async () => {
    harness = await connect();
    const { tools } = await harness.client.listTools();
    const events = tools.find((tool) => tool.name === 'git_list_issue_events');
    const description = events?.description ?? '';

    // The SDK can answer `type: 'unknown'`; a description naming only
    // labeled/unlabeled leaves the model unprepared for a third value.
    expect(description).toContain('unknown');
    expect(description).toMatch(/labeled/);
    expect(description).toMatch(/unlabeled/);
  });
});
