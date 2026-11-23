import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../../src/index.js';
import { expectError, expectNoHttp } from '../helpers/expectError.js';
import { REPO, buildClient } from '../helpers/clientHarness.js';

/**
 * Parameter validation, including the `pushFiles` contract boundary.
 *
 * Every case here must be refused locally: an invalid payload that reached a
 * platform could create an empty commit (Gitee `actions: []`) or a
 * corrupt tree (GitHub, where `sha` and `content` are mutually exclusive). The
 * zero-HTTP claim is therefore asserted for every rejection, on every provider.
 */
describe.each(PROVIDERS)('parameter validation (%s)', (provider) => {
  it('refuses an empty issue title', async () => {
    const { client, mock } = buildClient();
    await expectError(client.createIssue({ provider, ...REPO, title: '' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['title'],
    });
    expectNoHttp(mock);
  });

  it('refuses a whitespace-only issue title', async () => {
    const { client, mock } = buildClient();
    await expectError(client.createIssue({ provider, ...REPO, title: '   ' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['title'],
    });
    expectNoHttp(mock);
  });

  it('refuses a missing owner', async () => {
    const { client, mock } = buildClient();
    await expectError(client.getRepository({ provider, owner: '', repo: 'demo-kit' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['owner'],
    });
    expectNoHttp(mock);
  });

  it('refuses a path traversal in a file path', async () => {
    const { client, mock } = buildClient();
    await expectError(client.getFileContents({ provider, ...REPO, path: '../secrets.env' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['path'],
    });
    expectNoHttp(mock);
  });

  it('refuses an absolute file path', async () => {
    const { client, mock } = buildClient();
    await expectError(client.getFileContents({ provider, ...REPO, path: '/etc/passwd' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['path'],
    });
    expectNoHttp(mock);
  });

  it('refuses an out-of-range maxPages', async () => {
    const { client, mock } = buildClient();
    await expectError(client.listIssues({ provider, ...REPO, maxPages: 1000 }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['maxPages'],
    });
    expectNoHttp(mock);
  });

  it('refuses an unknown issue state', async () => {
    const { client, mock } = buildClient();
    await expectError(client.listIssues({ provider, ...REPO, state: 'merged' as 'open' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['state'],
    });
    expectNoHttp(mock);
  });

  it('refuses both org and user on a repository list', async () => {
    const { client, mock } = buildClient();
    await expectError(client.listRepositories({ provider, org: 'acme', user: 'charles' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['org'],
    });
    expectNoHttp(mock);
  });

  it('refuses a path segment containing a slash', async () => {
    const { client, mock } = buildClient();
    await expectError(client.listRepositories({ provider, org: 'acme/sub' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['org'],
    });
    expectNoHttp(mock);
  });

  it('refuses a non-integer pull-request number', async () => {
    const { client, mock } = buildClient();
    await expectError(client.getPullRequest({ provider, ...REPO, number: 1.5 }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['number'],
    });
    expectNoHttp(mock);
  });

  it('refuses a pull-request creation without a head branch', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.createPullRequest({ provider, ...REPO, title: 't', head: '', base: 'dev' }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['head'] },
    );
    expectNoHttp(mock);
  });

  it('refuses a delete without the blob sha', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.deleteFile({ provider, ...REPO, path: 'a.txt', message: 'm', sha: '' }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['sha'] },
    );
    expectNoHttp(mock);
  });

  it('refuses a file write whose content is not a string', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.createOrUpdateFile({
        provider,
        ...REPO,
        path: 'a.txt',
        content: 123 as unknown as string,
        message: 'm',
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['content'] },
    );
    expectNoHttp(mock);
  });

  it('refuses a branch creation without a source', async () => {
    const { client, mock } = buildClient();
    await expectError(client.createBranch({ provider, ...REPO, name: 'feat/x', from: '' }), {
      code: 'INVALID_ARGUMENT',
      provider,
      messageIncludes: ['from'],
    });
    expectNoHttp(mock);
  });
});

describe.each(PROVIDERS)('pushFiles contract boundary (%s)', (provider) => {
  it('refuses an empty batch', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({ provider, ...REPO, branch: 'dev', message: 'm', files: [] }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['files'] },
    );
    expectNoHttp(mock);
  });

  it('refuses a delete carrying content', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'delete', content: 'hi' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['delete'] },
    );
    expectNoHttp(mock);
  });

  it('refuses a create without content', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['content'] },
    );
    expectNoHttp(mock);
  });

  it('refuses an update without content', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'update' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['content'] },
    );
    expectNoHttp(mock);
  });

  it('refuses invalid base64 content', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create', content: 'not base64!', encoding: 'base64' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['base64'] },
    );
    expectNoHttp(mock);
  });

  it('refuses an unknown action, including upsert', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'upsert' as 'create', content: 'hi' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['action'] },
    );
    expectNoHttp(mock);
  });

  it('refuses an unknown encoding', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create', content: 'hi', encoding: 'hex' as 'utf8' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['encoding'] },
    );
    expectNoHttp(mock);
  });

  it('refuses an entry without a path', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [{ path: '', action: 'create', content: 'hi' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['path'] },
    );
    expectNoHttp(mock);
  });

  it('refuses a missing branch name', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: '',
        message: 'm',
        files: [{ path: 'a.txt', action: 'create', content: 'hi' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['branch'] },
    );
    expectNoHttp(mock);
  });

  it('refuses a missing commit message', async () => {
    const { client, mock } = buildClient();
    await expectError(
      client.pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: '  ',
        files: [{ path: 'a.txt', action: 'create', content: 'hi' }],
      }),
      { code: 'INVALID_ARGUMENT', provider, messageIncludes: ['message'] },
    );
    expectNoHttp(mock);
  });

  it('accepts base64 with embedded newlines', async () => {
    // Rejected only when genuinely undecodable; newline-wrapped base64 is valid.
    const { client } = buildClient();
    const error = await client
      .pushFiles({
        provider,
        ...REPO,
        branch: 'dev',
        message: 'm',
        files: [
          {
            path: 'a.txt',
            action: 'create',
            content: 'aGVsbG8gZ2l0\nLWZvcmdlCg==\n',
            encoding: 'base64',
          },
        ],
      })
      .catch((caught: unknown) => caught);

    // The payload is valid, so any failure must come from dispatch/transport,
    // never from the base64 gate.
    if (error !== undefined && error !== null && typeof error === 'object' && 'code' in error) {
      expect((error as { code: string }).code).not.toBe('INVALID_ARGUMENT');
    }
  });
});
