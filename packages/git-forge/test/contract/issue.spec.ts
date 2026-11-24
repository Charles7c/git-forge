import { describe, expect, expectTypeOf, it } from 'vitest';

import { PROVIDERS } from '../../src/index.js';
import { buildClient } from '../helpers/clientHarness.js';
import { expectError, expectNoHttp } from '../helpers/expectError.js';
import { REPO } from '../helpers/clientHarness.js';
import { contractRoutes, loadFixtures } from './contractContext.js';

/**
 * Issue domain contract.
 *
 * The same assertions run for all three providers: an issue has a string `number`,
 * a numeric alias only when the platform id is decimal, flattened labels, a
 * non-empty `html_url`, and provenance fields. Platform-specific paths and
 * payload quirks are not asserted here.
 */
describe.each(PROVIDERS)('issue contract (%s)', (provider) => {
  const data = loadFixtures(provider);
  const routes = contractRoutes(data);

  it('lists issues as normalized models', async () => {
    const { client } = buildClient({}, routes);
    const issues = await client.listIssues({ provider, ...REPO });

    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.number).toBe('string');
      expect(issue.number.length).toBeGreaterThan(0);
      expect(issue.provider).toBe(provider);
      expect(issue.owner).toBe(REPO.owner);
      expect(issue.repo).toBe(REPO.repo);
      expect(['open', 'closed']).toContain(issue.state);
      expect(typeof issue.title).toBe('string');
      expect(issue.html_url.startsWith('https://')).toBe(true);
      expect(Array.isArray(issue.labels)).toBe(true);
      for (const label of issue.labels) {
        expect(typeof label).toBe('string');
      }
      expect(typeof issue.created_at).toBe('string');
      expect(typeof issue.updated_at).toBe('string');
    }
  });

  it('omits the numeric alias when the platform id is not decimal', async () => {
    const { client } = buildClient({}, routes);
    const issues = await client.listIssues({ provider, ...REPO });

    for (const issue of issues) {
      const parsed = Number(issue.number);
      if (/^\d+$/.test(issue.number) && Number.isSafeInteger(parsed)) {
        expect(issue.number_as_number).toBe(parsed);
      } else {
        // Omitted, not `undefined` and not `NaN`.
        expect('number_as_number' in issue).toBe(false);
      }
    }
  });

  it('deduplicates by the original number, not its numeric alias', async () => {
    const ids = [
      '0007',
      '7',
      '0007',
      'X7',
      '9007199254740991',
      '9007199254740992',
      '1e3',
      '1.5',
      '-1',
    ];
    const { client } = buildClient({}, [
      {
        match: /\/issues\?/,
        responses: [{ body: ids.map((number) => ({ number, state: 'open' })) }],
      },
    ]);
    const issues = await client.listIssues({ provider, ...REPO, state: 'all' });
    expect(issues.map((issue) => issue.number)).toEqual([
      '0007',
      '7',
      'X7',
      '9007199254740991',
      '9007199254740992',
      '1e3',
      '1.5',
      '-1',
    ]);
    expect(issues.map((issue) => issue.number_as_number)).toEqual([
      7,
      7,
      undefined,
      Number.MAX_SAFE_INTEGER,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    for (const issue of issues) {
      expectTypeOf(issue.number).toEqualTypeOf<string>();
      expectTypeOf(issue.number_as_number).toEqualTypeOf<number | undefined>();
      expect(issue).not.toHaveProperty('key');
      if (issue.number_as_number === undefined)
        expect(issue).not.toHaveProperty('number_as_number');
    }
  });

  it('reads one issue by its native id', async () => {
    const { client } = buildClient({}, routes);
    const source = (data.issues as { number?: string | number }[])[0];
    const native = source?.number ?? 1;

    const issue = await client.getIssue({ provider, ...REPO, number: native });
    expect(issue.provider).toBe(provider);
    expect(typeof issue.number).toBe('string');
    expect(issue.html_url.length).toBeGreaterThan(0);
  });

  it('creates an issue and maps the response', async () => {
    const { client } = buildClient({}, routes);
    const issue = await client.createIssue({
      provider,
      ...REPO,
      title: 'contract: create',
      body: 'body',
      labels: ['bug'],
    });
    expect(issue.provider).toBe(provider);
    expect(typeof issue.number).toBe('string');
  });

  it('updates an issue and maps the response', async () => {
    const { client } = buildClient({}, routes);
    const source = (data.issues as { number?: string | number }[])[0];
    const issue = await client.updateIssue({
      provider,
      ...REPO,
      number: source?.number ?? 1,
      title: 'contract: update',
    });
    expect(issue.provider).toBe(provider);
  });

  it('lists issue comments', async () => {
    const { client } = buildClient({}, routes);
    const comments = await client.listIssueComments({ provider, ...REPO, number: 1 });

    expect(comments.length).toBeGreaterThan(0);
    for (const comment of comments) {
      expect(typeof comment.id).toBe('number');
      expect(typeof comment.body).toBe('string');
      expect(comment.provider).toBe(provider);
      // Never an empty string: an absent URL is omitted, not blanked.
      if (comment.html_url !== undefined) {
        expect(comment.html_url.length).toBeGreaterThan(0);
      }
    }
  });

  it('creates an issue comment', async () => {
    const { client } = buildClient({}, routes);
    const comment = await client.createIssueComment({
      provider,
      ...REPO,
      number: 1,
      body: 'contract: comment',
    });
    expect(comment.provider).toBe(provider);
    expect(typeof comment.id).toBe('number');
  });

  it('surfaces a 404 as NOT_FOUND with the provider attached', async () => {
    const { client, mock } = buildClient({}, [
      { match: /.*/, responses: [{ status: 404, body: { message: 'Not Found' } }] },
    ]);
    await expectError(client.getIssue({ provider, ...REPO, number: 999999 }), {
      code: 'NOT_FOUND',
      provider,
      status: 404,
    });
    expect(mock.calls).toHaveLength(1);
  });

  it('surfaces a 401 as AUTH_INVALID', async () => {
    const { client } = buildClient({}, [
      { match: /.*/, responses: [{ status: 401, body: { message: 'Bad credentials' } }] },
    ]);
    await expectError(client.getIssue({ provider, ...REPO, number: 1 }), {
      code: 'AUTH_INVALID',
      provider,
      status: 401,
    });
  });

  it('refuses an empty title before any request', async () => {
    const { client, mock } = buildClient({}, routes);
    await expectError(client.createIssue({ provider, ...REPO, title: '' }), {
      code: 'INVALID_ARGUMENT',
      provider,
    });
    expectNoHttp(mock);
  });
});
