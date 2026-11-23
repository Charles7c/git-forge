import { describe, expect, it } from 'vitest';

import { REPO, buildClient } from '../helpers/clientHarness.js';
import { jsonResponse } from '../helpers/mockFetch.js';

/**
 * Concrete SDK input/output pairs for provider-specific field and encoding conversions.
 */
describe('provider normalization examples', () => {
  it('keeps a numeric platform id as Issue.number and derives its numeric alias', async () => {
    const { client } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            number: 101,
            title: 't',
            state: 'open',
            html_url: 'https://example.com/issues/101',
            labels: [],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ],
      },
    ]);
    const issue = await client.getIssue({ provider: 'github', ...REPO, number: 101 });

    // `String(101)` → `"101"`, and the parsed integer fills `number_as_number`.
    expect(issue.number).toBe('101');
    expect(issue.number_as_number).toBe(101);
    expect(`number=${issue.number}`).toBe('number=101');
  });

  it('keeps a Gitee code as Issue.number and omits the numeric alias entirely', async () => {
    const { client } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            number: 'IEXA01',
            title: 't',
            state: 'open',
            html_url: 'https://gitee.com/o/r/issues/IEXA01',
            labels: [],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ],
      },
    ]);
    const issue = await client.getIssue({ provider: 'gitee', ...REPO, number: 'IEXA01' });

    // `Number("IEXA01")` is `NaN`, and `NaN` would serialize to `null`, so the
    // field must be absent rather than set.
    expect(issue.number).toBe('IEXA01');
    expect('number_as_number' in issue).toBe(false);
    expect(JSON.stringify({ n: Number.NaN })).toBe('{"n":null}');
  });

  it('keeps an AtomGit numeric string as text with a numeric alias', async () => {
    const { client } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            number: '205',
            title: 't',
            state: 'open',
            html_url: 'https://atomgit.com/o/r/issues/205',
            labels: [],
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ],
      },
    ]);
    const issue = await client.getIssue({ provider: 'atomgit', ...REPO, number: '205' });

    expect(issue.number).toBe('205');
    expect(issue.number_as_number).toBe(205);
    expect(Number.isInteger(issue.number_as_number)).toBe(true);
  });

  it('strips the clone suffix from a Gitee repository html_url', async () => {
    const { client } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            id: 1,
            name: 'demo-kit',
            full_name: 'example-org/demo-kit',
            html_url: 'https://gitee.com/example-org/demo-kit.git',
            default_branch: 'dev',
            private: false,
          }),
        ],
      },
    ]);
    const repo = await client.getRepository({ provider: 'gitee', ...REPO });

    expect(repo.html_url).toBe('https://gitee.com/example-org/demo-kit');
    expect('https://gitee.com/example-org/demo-kit.git'.replace(/\.git$/, '')).toBe(repo.html_url);
  });

  it('takes AtomGit web_url verbatim instead of composing a URL', async () => {
    const { client } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            id: 1,
            name: 'demo-kit',
            full_name: 'example-org/demo-kit',
            html_url: null,
            web_url: 'https://atomgit.com/example-org/demo-kit',
            namespace: { path: 'example-org' },
            default_branch: 'dev',
            private: false,
          }),
        ],
      },
    ]);
    const repo = await client.getRepository({ provider: 'atomgit', ...REPO });

    expect(repo.html_url).toBe('https://atomgit.com/example-org/demo-kit');
  });

  it('joins labels with a comma for the platforms that require it', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            number: '205',
            title: 't',
            state: 'open',
            html_url: 'https://e/1',
            labels: [],
            created_at: 'x',
            updated_at: 'x',
          }),
        ],
      },
    ]);
    await client.createIssue({
      provider: 'atomgit',
      ...REPO,
      title: 't',
      labels: ['bug', 'docs'],
    });

    // `["bug","docs"].join(",")` → `"bug,docs"`.
    expect(['bug', 'docs'].join(',')).toBe('bug,docs');
    expect((mock.calls[0]?.json as { labels: string }).labels).toBe('bug,docs');
  });

  it('translates a contract state to the AtomGit vocabulary', async () => {
    const responses = [
      jsonResponse({
        number: '205',
        title: 't',
        state: 'closed',
        html_url: 'https://e/1',
        labels: [],
        created_at: 'x',
        updated_at: 'x',
      }),
      jsonResponse({
        number: '205',
        title: 't',
        state: 'open',
        html_url: 'https://e/1',
        labels: [],
        created_at: 'x',
        updated_at: 'x',
      }),
    ];
    const { client, mock } = buildClient({}, [{ match: /.*/, responses }]);

    await client.updateIssue({
      provider: 'atomgit',
      ...REPO,
      number: 205,
      title: 't',
      state: 'closed',
    });
    await client.updateIssue({
      provider: 'atomgit',
      ...REPO,
      number: 205,
      title: 't',
      state: 'open',
    });

    // `closed` → `close`; `open` → `reopen`.
    expect((mock.calls[0]?.json as { state: string }).state).toBe('close');
    expect((mock.calls[1]?.json as { state: string }).state).toBe('reopen');
  });

  it('derives branch html_url identically on all three platforms', async () => {
    const expected = {
      github: 'https://github.com/example-org/demo-kit/tree/dev',
      gitee: 'https://gitee.com/example-org/demo-kit/tree/dev',
      atomgit: 'https://atomgit.com/example-org/demo-kit/tree/dev',
    };

    for (const [provider, url] of Object.entries(expected)) {
      const { client } = buildClient({}, [
        {
          match: /.*/,
          responses: [jsonResponse([{ name: 'dev', commit: { sha: 'a'.repeat(40) } }])],
        },
      ]);
      const branches = await client.listBranches({
        provider: provider as 'github',
        ...REPO,
      });
      expect(branches[0]?.html_url).toBe(url);
    }
  });

  it('encodes and decodes the documented base64 vectors', () => {
    expect(Buffer.from('hello git-forge\n', 'utf8').toString('base64')).toBe(
      'aGVsbG8gZ2l0LWZvcmdlCg==',
    );
    expect(Buffer.from('hi', 'utf8').toString('base64')).toBe('aGk=');
    expect(Buffer.from('aGk=', 'base64').toString('utf8')).toBe('hi');

    // Embedded newlines are ignored by the decoder, which is why the payload
    // validator strips whitespace instead of rejecting it.
    expect(Buffer.from('aGVsbG8gZ2l0\nLWZvcmdlCg==\n', 'base64').toString('utf8')).toBe(
      'hello git-forge\n',
    );
  });

  it('translates utf8 to text for Gitee, the only encoding it accepts', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            sha: 'c'.repeat(40),
            html_url: 'https://gitee.com/o/r/commit/c',
          }),
        ],
      },
    ]);
    await client.pushFiles({
      provider: 'gitee',
      ...REPO,
      branch: 'dev',
      message: 'm',
      files: [
        { path: 'a.txt', action: 'create', content: 'hi' },
        { path: 'b.txt', action: 'create', content: 'aGk=', encoding: 'base64' },
      ],
    });

    const actions = (mock.calls[0]?.json as { actions: { encoding: string }[] }).actions;
    // `'utf8' → 'text'`, `'base64' → 'base64'`; sending `utf8` is rejected with HTTP 400.
    expect(actions[0]?.encoding).toBe('text');
    expect(actions[1]?.encoding).toBe('base64');
  });

  it('derives the Gitee single-file commit URL, which the response omits', async () => {
    const sha = 'ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05';
    const { client } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({
            content: { html_url: 'https://gitee.com/o/r/blob/dev/README.md' },
            commit: { sha },
          }),
        ],
      },
    ]);
    const result = await client.createOrUpdateFile({
      provider: 'gitee',
      ...REPO,
      path: 'README.md',
      content: 'aGk=',
      message: 'm',
    });

    expect(result.commit_sha).toBe(sha);
    expect(result.commit_html_url).toBe(
      'https://gitee.com/example-org/demo-kit/commit/ab05ab05ab05ab05ab05ab05ab05ab05ab05ab05',
    );
  });

  it('issues 5 + K requests for a GitHub batch (K = base64 entries)', async () => {
    const routes = [
      { match: /\/git\/blobs$/, responses: [jsonResponse({ sha: 'd'.repeat(40) })] },
      { match: /\/git\/trees$/, responses: [jsonResponse({ sha: 'b'.repeat(40) })] },
      {
        match: (call: { url: string; method: string }) =>
          call.method === 'POST' && new URL(call.url).pathname.endsWith('/git/commits'),
        responses: [jsonResponse({ sha: 'c'.repeat(40), html_url: 'https://e/c' })],
      },
      {
        match: /\/git\/commits\/[0-9a-f]+$/,
        responses: [jsonResponse({ sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } })],
      },
      {
        match: /\/git\/ref\/heads\//,
        responses: [jsonResponse({ object: { sha: 'a'.repeat(40) } })],
      },
      { match: /\/git\/refs\/heads\//, responses: [jsonResponse({ ref: 'refs/heads/dev' })] },
    ];

    // K = 0 → 5 requests.
    const zero = buildClient({}, routes);
    await zero.client.pushFiles({
      provider: 'github',
      ...REPO,
      branch: 'dev',
      message: 'm',
      files: [{ path: 'a.txt', action: 'create', content: 'hi' }],
    });
    expect(zero.mock.calls).toHaveLength(5);

    // K = 1 → 6 requests.
    const one = buildClient({}, routes);
    await one.client.pushFiles({
      provider: 'github',
      ...REPO,
      branch: 'dev',
      message: 'm',
      files: [{ path: 'a.txt', action: 'create', content: 'aGk=', encoding: 'base64' }],
    });
    expect(one.mock.calls).toHaveLength(6);

    // K = 3 → 8 requests.
    const three = buildClient({}, routes);
    await three.client.pushFiles({
      provider: 'github',
      ...REPO,
      branch: 'dev',
      message: 'm',
      files: [
        { path: 'a.txt', action: 'create', content: 'aGk=', encoding: 'base64' },
        { path: 'b.txt', action: 'create', content: 'aGk=', encoding: 'base64' },
        { path: 'c.txt', action: 'create', content: 'aGk=', encoding: 'base64' },
      ],
    });
    expect(three.mock.calls).toHaveLength(8);
  });

  it('issues exactly one request for a Gitee batch, with no existence probe', async () => {
    const { client, mock } = buildClient({}, [
      {
        match: /.*/,
        responses: [
          jsonResponse({ sha: 'c'.repeat(40), html_url: 'https://gitee.com/o/r/commit/c' }),
        ],
      },
    ]);
    await client.pushFiles({
      provider: 'gitee',
      ...REPO,
      branch: 'dev',
      message: 'm',
      files: [
        { path: 'a.txt', action: 'create', content: 'hi' },
        { path: 'b.txt', action: 'update', content: 'aGk=', encoding: 'base64' },
        { path: 'c.txt', action: 'delete' },
      ],
    });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe('POST');
    // A delete entry must not carry content.
    const actions = (mock.calls[0]?.json as { actions: Record<string, unknown>[] }).actions;
    expect(actions[2]).toEqual({ action: 'delete', path: 'c.txt' });
  });
});
