import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider } from '@charles7c/git-forge';

export const owner = 'sample-owner';
export const repo = 'sample-repo';
export const repoPath = `/repos/${owner}/${repo}`;

/** Use built workspace packages by default; optionally exercise an actual tarball installation. */
export function manifestPath(name: 'git-forge' | 'git-forge-mcp'): string {
  const consumer = process.env.GIT_FORGE_SMOKE_CONSUMER;
  return consumer
    ? join(consumer, 'node_modules', '@charles7c', name, 'package.json')
    : fileURLToPath(new URL(`../../${name}/package.json`, import.meta.url));
}

export function repositoryFixture(provider: Provider, origin: string): Record<string, unknown> {
  const web = `${origin}/${owner}/${repo}`;
  return {
    name: repo,
    full_name: `${owner}/${repo}`,
    owner: { login: owner },
    namespace: { path: owner },
    html_url: provider === 'atomgit' ? null : provider === 'gitee' ? `${web}.git` : web,
    web_url: web,
    default_branch: 'main',
    private: true,
  };
}

interface Reply {
  path: string;
  query?: Record<string, string>;
  body: unknown;
}

/** Serve an ordered, exact GET transcript. An unexpected or missing request fails the test. */
export async function withLoopback(
  provider: Provider,
  transcript: (origin: string) => Reply[],
  run: (origin: string, requests: () => number) => Promise<void>,
): Promise<void> {
  let origin = '';
  let replies: Reply[] = [];
  let requests = 0;
  const faults: unknown[] = [];
  const server = createServer((req, res) => {
    try {
      const reply = replies[requests++];
      assert.ok(reply, 'unexpected extra request');
      assert.equal(req.method, 'GET');
      const url = new URL(req.url ?? '', origin);
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, reply.path);
      assert.deepEqual([...url.searchParams].sort(), Object.entries(reply.query ?? {}).sort());
      assert.equal(req.headers.authorization, `Bearer loopback-only-${provider}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
    } catch (error) {
      faults.push(error);
      res.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    replies = transcript(origin);
    await run(origin, () => requests);
    assert.equal(requests, replies.length, 'missing expected request');
  } catch (error) {
    faults.push(error);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  if (faults.length) throw new AggregateError(faults, 'loopback transcript mismatch');
}
