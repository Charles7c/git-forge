import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { connect, fullConfig, ISSUE, resultJson } from './helpers/mcpHarness.js';

/** Run the documented request, rather than maintaining a second copy in the test. */
describe.each(['README.md', 'README.zh-CN.md'])('%s', (file) => {
  it('runs the read-only tools/call from the quickstart', async () => {
    const text = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    const requests = Array.from(
      text.matchAll(/```json\n([\s\S]*?)\n```/g),
      (match) =>
        JSON.parse(match[1]!) as {
          method?: string;
          params?: { name: string; arguments: Record<string, unknown> };
        },
    ).filter((value) => value.method === 'tools/call');
    expect(requests).toHaveLength(1);
    const params = requests[0]!.params!;
    expect(params.name).toBe('git_list_issues');
    const harness = await connect(fullConfig({ readonly: true }), [
      {
        match: '/issues',
        responses: [{ body: [{ ...ISSUE, number: '001', labels: [{ name: 'docs' }] }] }],
      },
    ]);
    try {
      const result = await harness.client.callTool(params);
      expect(result.isError).not.toBe(true);
      expect(resultJson(result)).toMatchObject([{ number: '001', labels: ['docs'] }]);
      expect(harness.mock.calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    } finally {
      await harness.close();
    }
  });
});
