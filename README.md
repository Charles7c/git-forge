# git-forge

> Platform-agnostic Git toolchain: a TypeScript SDK and an MCP server that speak the same
> dialect for **GitHub**, **Gitee** and **AtomGit**.

**English** | [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

> **Status: pre-release.** `v0.1.0` is under active development. The API surface described
> below is being implemented and may change before the first tagged release.

## Why

Most Git hosting platforms expose their own API shape. If you operate across GitHub, Gitee
and AtomGit — from application code or from an AI agent — you end up maintaining one client
per platform, plus a pile of field-mapping glue.

`git-forge` provides one API surface modelled on GitHub's field names, and does the
platform-specific translation inside adapters. Capabilities that a platform genuinely does
not support fail loudly with `UNSUPPORTED_ON_PROVIDER` instead of silently returning
something wrong.

## Planned packages

| Package | Purpose |
|---|---|
| `@charles7c/git-forge` | TypeScript SDK for programmatic use |
| `@charles7c/git-forge-mcp` | MCP server (`stdio`) for AI tooling |

Both packages share a single implementation of the platform logic, so the SDK and the MCP
server always report the same data.

## Scope of v0.1.0

Five capability domains, implemented against all three platforms:

- **Issues** — list, get, create, update, comment
- **Pull requests** — list, get, create, merge, comment
- **Repositories** — list, get, create, read file contents
- **Files** — create, update, delete, multi-file push
- **Branches & commits** — list/create branches, list/get commits

Plus the shared machinery: automatic pagination, exponential backoff on `429`/`5xx`,
partial-failure isolation for bulk operations, a single error model, and capability probing.

Search, releases, reviews, notifications and GitHub-only features (Actions, Discussions,
Gists, …) are **not** part of v0.1.0. They are tracked as roadmap items and are reported as
unsupported rather than faked.

## Documentation

Full documentation — installation, platform configuration, the capability matrix, per-platform
differences, and MCP client setup — lands with the `v0.1.0` release.

## License

[MIT](./LICENSE) © 2026 Charles7c
