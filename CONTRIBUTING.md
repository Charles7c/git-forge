# Contributing

1. **Environment.** Use a current patch of Node 20 or 22 and the pnpm version pinned in the root `package.json`.
2. **Install and build.** From the checkout run `pnpm install --frozen-lockfile` and `pnpm build`. The SDK and MCP server are versioned together.
3. **Checks.** Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:coverage` and `pnpm test:e2e`. The SDK line coverage gate is 80%; the last command only needs loopback and stdio. To repeat that smoke test against installed tarballs instead of workspace builds, set `GIT_FORGE_SMOKE_CONSUMER` to the absolute path of the consumer directory containing both packages.
4. **Adapter changes.** Add synthetic fixtures and offline contract tests for success, errors and unsupported operations; assert refused calls send no request. Document provider-specific behavior in [providers.md](./docs/providers.md).
5. **Pull requests.** Use Conventional Commits, explain the change and include the commands you ran. Do not test against public repositories, use real tokens in tests, or include private data in fixtures.
