import { describe, expect, expectTypeOf, it } from 'vitest';

import { PROVIDERS, type PullRequestRef } from '../../src/index.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';
import { expectError } from '../helpers/expectError.js';
import { contractRoutes, loadFixtures } from './contractContext.js';

/**
 * Pull-request contract.
 *
 * `merged` must be a boolean on all three platforms even though AtomGit reports
 * a third state, and supplied `head`/`base` must be preserved. The `head` *filter* is a
 * parameter-level capability and is covered by `client/param-caps.test.ts`; here
 * only the model shape is asserted.
 */
describe.each(PROVIDERS)('pull-request contract (%s)', (provider) => {
  const data = loadFixtures(provider);
  const routes = contractRoutes(data);
  // The fixture pull's own number: platforms disagree on numbering, and the
  // contract does not require them to.
  const fixtureNumber = (data.pull as { number: number }).number;

  it('rejects a list row without a required base and retains response context', async () => {
    const { client } = buildClient({}, [
      {
        match: '/pulls',
        responses: [{ body: [{ number: 1 }], headers: { 'x-request-id': 'base-id' } }],
      },
    ]);
    await expect(client.listPullRequests({ provider, ...REPO })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      provider,
      status: 200,
      requestId: 'base-id',
    });
  });

  it('lists pull requests as normalized models', async () => {
    const { client } = buildClient({}, routes);
    const pulls = await client.listPullRequests({ provider, ...REPO });

    expect(pulls.length).toBeGreaterThan(0);
    for (const pull of pulls) {
      expect(typeof pull.number).toBe('number');
      expect(Number.isInteger(pull.number)).toBe(true);
      expect(['open', 'closed']).toContain(pull.state);
      expect(typeof pull.merged).toBe('boolean');
      expect(pull.provider).toBe(provider);
      expect(pull.owner).toBe(REPO.owner);
      expect(pull.repo).toBe(REPO.repo);
      expect(pull.html_url.startsWith('https://')).toBe(true);
      expect(typeof pull.head?.ref).toBe('string');
      expect(typeof pull.base.ref).toBe('string');
    }
  });

  it('folds a merged third state into closed + merged:true', async () => {
    const { client } = buildClient({}, routes);
    const pulls = await client.listPullRequests({ provider, ...REPO });

    for (const pull of pulls) {
      // Nothing but the two contract states may escape, and a closed pull with a
      // merge timestamp must report `merged`.
      expect(['open', 'closed']).toContain(pull.state);
      if (pull.merged_at !== undefined) {
        expect(pull.merged).toBe(true);
      }
    }
  });

  it('reads one pull request', async () => {
    const { client } = buildClient({}, routes);
    const pull = await client.getPullRequest({
      provider,
      ...REPO,
      number: fixtureNumber,
    });

    expect(pull.provider).toBe(provider);
    expectTypeOf(pull.number).toEqualTypeOf<number>();
    expectTypeOf(pull.head).toEqualTypeOf<PullRequestRef | undefined>();
    expect(pull.number).toBe(fixtureNumber);
    expect(typeof pull.head?.ref).toBe('string');
  });

  it('creates a pull request', async () => {
    const { client } = buildClient({}, routes);
    const pull = await client.createPullRequest({
      provider,
      ...REPO,
      title: 'contract: pull',
      head: 'feat/contract',
      base: 'dev',
    });
    expect(pull.provider).toBe(provider);
    expect(pull.number).toBeGreaterThan(0);
  });

  it('merges a pull request and returns its post-merge state', async () => {
    const { client, mock } = buildClient({}, routes);
    const pull = await client.mergePullRequest({
      provider,
      ...REPO,
      number: fixtureNumber,
      merge_method: 'squash',
    });

    expect(pull.provider).toBe(provider);
    // The merge itself plus the read-back of the pull request.
    expect(mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mock.calls[0]?.method).toBe('PUT');
  });

  it('lists pull-request comments', async () => {
    const { client } = buildClient({}, routes);
    const comments = await client.listPullRequestComments({
      provider,
      ...REPO,
      number: fixtureNumber,
    });
    expect(comments.length).toBeGreaterThan(0);
    for (const comment of comments) {
      expect(comment.provider).toBe(provider);
      expect(typeof comment.id).toBe('number');
    }
  });

  it('creates a pull-request comment', async () => {
    const { client } = buildClient({}, routes);
    const comment = await client.createPullRequestComment({
      provider,
      ...REPO,
      number: fixtureNumber,
      body: 'contract: comment',
    });
    expect(comment.provider).toBe(provider);
  });

  it('surfaces a 422 on create as INVALID_ARGUMENT', async () => {
    const { client } = buildClient({}, [
      {
        match: /.*/,
        responses: [{ status: 422, body: { message: 'Validation Failed' } }],
      },
    ]);
    await expectError(
      client.createPullRequest({
        provider,
        ...REPO,
        title: 'contract: pull',
        head: 'nope',
        base: 'dev',
      }),
      { code: 'INVALID_ARGUMENT', provider, status: 422 },
    );
  });

  it('surfaces a 404 on merge as NOT_FOUND', async () => {
    const { client } = buildClient({}, [
      { match: /.*/, responses: [{ status: 404, body: { message: 'Not Found' } }] },
    ]);
    await expectError(client.mergePullRequest({ provider, ...REPO, number: 999999 }), {
      code: 'NOT_FOUND',
      provider,
      status: 404,
    });
  });
});

describe.each(['gitee', 'atomgit'] as const)('native PR states (%s)', (provider) => {
  it.each([
    ['open', [1], ['open']],
    ['closed', [2, 3], ['closed', 'merged']],
    ['all', [1, 2, 3], ['all']],
  ] as const)(
    'normalizes and deduplicates %s within per-stream page limits',
    async (state, numbers, streams) => {
      const row = (number: number, native: string) => ({
        number,
        state: native,
        base: { ref: 'main', sha: 'tip' },
      });
      const open = row(1, 'open'),
        closed = row(2, 'closed'),
        merged = row(3, 'merged');
      const { client, mock } = buildClient(
        {},
        Object.entries({
          open: [open],
          closed: [closed, row(3, 'closed')],
          merged: [merged, merged],
          all: [open, closed, merged],
        }).map(([key, body]) => ({
          match: `state=${key}`,
          responses: [{ body, headers: { total_page: '2' } }],
        })),
      );
      const result = await client.listPullRequests({ provider, ...REPO, state, maxPages: 1 });
      expect(result.map((p) => p.number)).toEqual(numbers);
      expect(result.filter((p) => p.merged).map((p) => [p.number, p.state])).toEqual(
        state === 'open' ? [] : [[3, 'closed']],
      );
      expect(mock.calls.map((call) => new URL(call.url).searchParams.get('state'))).toEqual(
        streams,
      );
    },
  );
});
