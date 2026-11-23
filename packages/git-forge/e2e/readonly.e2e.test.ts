import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type * as SDK from '@charles7c/git-forge';
import {
  manifestPath,
  owner,
  repo,
  repoPath,
  repositoryFixture,
  withLoopback,
} from './loopback.js';

// No Vitest source alias: exercise the exported build (or the installed tarball).
const { GitClient } = createRequire(manifestPath('git-forge'))(
  '@charles7c/git-forge',
) as typeof SDK;
const providers = ['github', 'gitee', 'atomgit'] as const;
const numbers = { github: 12, gitee: 'IX12A', atomgit: '0012' } as const;
const sha = 'a1'.repeat(20);
const paging = { page: '1', per_page: '100' };

it.each(providers)(
  'reads a repository, issues, branches and commits over HTTP: %s',
  async (provider) => {
    const prefix = provider === 'github' ? '' : '/api/v5';
    const path = prefix + repoPath;
    const ref = { provider, owner, repo };
    await withLoopback(
      provider,
      (origin) => {
        const web = `${origin}/${owner}/${repo}`;
        return [
          { path, body: repositoryFixture(provider, origin) },
          {
            path: `${path}/issues`,
            query: { ...paging, state: 'all' },
            body: [
              {
                number: numbers[provider],
                title: 'Sample',
                labels: [{ name: 'docs' }],
                state: provider === 'gitee' ? 'progressing' : 'open',
                html_url: `${web}/issues/${numbers[provider]}`,
              },
            ],
          },
          { path: `${path}/branches`, query: paging, body: [{ name: 'main', commit: { sha } }] },
          {
            path: `${path}/commits`,
            query: { ...paging, sha: 'main' },
            body: [
              {
                sha,
                commit: { message: 'Sample commit' },
                html_url: `${web}/commit/${sha}`,
              },
            ],
          },
        ];
      },
      async (origin) => {
        const client = new GitClient({
          [provider]: {
            token: `loopback-only-${provider}`,
            baseUrl: origin + prefix,
            webBaseUrl: origin,
          },
          readonly: true,
          retry: { maxRetries: 0 },
          fetch: (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            expect(url.origin).toBe(origin);
            return fetch(url, { ...init, redirect: 'error' });
          },
        });
        const web = `${origin}/${owner}/${repo}`;
        expect(await client.getRepository(ref)).toMatchObject({
          ...ref,
          default_branch: 'main',
          html_url: web,
        });
        const issues = await client.listIssues({ ...ref, state: 'all', maxPages: 1 });
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
          ...ref,
          number: String(numbers[provider]),
          state: 'open',
          labels: ['docs'],
          html_url: `${web}/issues/${numbers[provider]}`,
        });
        if (provider === 'gitee') expect(issues[0]).not.toHaveProperty('number_as_number');
        else expect(issues[0]?.number_as_number).toBe(12);
        expect(await client.listBranches({ ...ref, maxPages: 1 })).toMatchObject([
          { ...ref, name: 'main', commit_sha: sha, html_url: `${web}/tree/main` },
        ]);
        expect(await client.listCommits({ ...ref, branch: 'main', maxPages: 1 })).toMatchObject([
          { ...ref, sha, message: 'Sample commit', html_url: `${web}/commit/${sha}` },
        ]);
      },
    );
  },
);
