import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import {
  manifestPath,
  owner,
  repo,
  repoPath,
  repositoryFixture,
  withLoopback,
} from './loopback.js';

interface Result {
  protocolVersion?: string;
  serverInfo?: { name: string };
  tools?: { name: string }[];
  content?: { type: string; text: string }[];
  isError?: boolean;
}

it.each(['GITKIT_READONLY', 'GIT_FORGE_READONLY'])(
  'negotiates stdio and enforces %s',
  async (flag) => {
    await withLoopback(
      'github',
      (origin) => [{ path: repoPath, body: repositoryFixture('github', origin) }],
      async (origin, requests) => {
        const manifest = manifestPath('git-forge-mcp');
        const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as {
          bin: Record<string, string>;
        };
        const entry = resolve(dirname(manifest), bin['git-forge-mcp']!);
        const env: NodeJS.ProcessEnv = { [flag]: '1', FORGE_TEST_PORT: new URL(origin).port };
        // Keep host-imposed Node restrictions, but never forward platform credentials to the CLI.
        for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'NODE_OPTIONS']) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        const child = spawn(
          process.execPath,
          ['--import', new URL('./route-stdio.mjs', import.meta.url).href, entry],
          {
            env,
            stdio: 'pipe',
            timeout: 15_000,
            windowsHide: true,
          },
        );
        const closed = once(child, 'close');
        const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        let id = 0;
        const send = (message: object): void => {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
        };
        const call = async (method: string, params: object): Promise<Result> => {
          send({ id: ++id, method, params });
          const line = await lines.next();
          assert.ok(!line.done, `MCP closed before answering ${method}`);
          expect(line.value).not.toContain('loopback-only-');
          const response = JSON.parse(line.value) as {
            result?: Result;
            id?: number;
            jsonrpc?: string;
          };
          expect(response).toMatchObject({ jsonrpc: '2.0', id });
          assert.ok(response.result, `expected a successful JSON-RPC response to ${method}`);
          return response.result;
        };
        const tool = (name: string, args: object): Promise<Result> =>
          call('tools/call', { name, arguments: args });
        try {
          expect(
            await call('initialize', {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'loopback-reader', version: '1' },
            }),
          ).toMatchObject({
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'git-forge-mcp' },
          });
          send({ method: 'notifications/initialized' });
          const names = (await call('tools/list', {})).tools?.map(({ name }) => name);
          expect(names).toHaveLength(23);
          expect(new Set(names).size).toBe(23);
          expect(names?.every((name) => name.startsWith('git_'))).toBe(true);
          const write = await tool('git_create_repository', { provider: 'github', name: repo });
          expect(write.isError).toBe(true);
          expect(write.content?.[0]?.text).toContain('[READONLY_BLOCKED]');
          const missing = await tool('git_get_repository', { provider: 'gitee', owner, repo });
          expect(missing.isError).toBe(true);
          expect(missing.content?.[0]?.text).toContain('Set GITEE_TOKEN and restart the server');
          expect(requests()).toBe(0);
          const success = await tool('git_get_repository', { provider: 'github', owner, repo });
          expect(success.isError).not.toBe(true);
          const block = success.content?.[0];
          assert.ok(block?.type === 'text');
          expect(JSON.parse(block.text)).toMatchObject({
            provider: 'github',
            owner,
            repo,
            html_url: `${origin}/${owner}/${repo}`,
          });
        } finally {
          child.stdin.end();
          await closed;
        }
        expect(child.exitCode).toBe(0);
        expect(stderr).toContain('providers configured: github | readonly: on');
        expect(stderr).not.toContain('loopback-only-');
      },
    );
  },
);
