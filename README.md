# git-forge

English | [简体中文](./README.zh-CN.md)

A TypeScript SDK and a stdio MCP server for **GitHub, Gitee and AtomGit**. Applications and AI clients use the same provider adapters. Version 0.1.0 is a **pre-release**; the instructions below use local packages, not an assumed registry release. [Capability matrix](#capabilities) · [Provider notes](./docs/providers.md)

## Install and try it

From a source checkout, with Node 20 or 22 (latest patch) and pnpm 12.9.1:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:e2e
```

The last command runs local HTTP and stdio smoke tests without a token. To use the packages from a different project, create an empty directory for archives and replace `/path/to/archives` with its absolute path. From the checkout:

```sh
pnpm --dir packages/git-forge pack --out /path/to/archives/sdk.tgz
pnpm --dir packages/git-forge-mcp pack --out /path/to/archives/mcp.tgz
```

From your application directory (with a `package.json`), run `npm install /path/to/archives/sdk.tgz /path/to/archives/mcp.tgz`. Install only `sdk.tgz` if you do not need MCP. The SDK has no third-party runtime dependencies. MCP also needs its declared third-party dependencies; an offline install requires a populated package-manager cache. Windows accepts absolute paths such as `C:/archives/sdk.tgz`.

Save as `quickstart.mjs` in the application and run `node quickstart.mjs`. This first example works without network access:

```js
import { GitClient } from '@charles7c/git-forge';
const git = new GitClient({ readonly: true, gitee: { token: process.env.GITEE_TOKEN } });
console.log(git.capabilities('gitee')['files.pushFiles']); // supported
console.log(git.capabilities('atomgit')['files.pushFiles']); // unsupported
```

For a real read, supply a token and set `FORGE_OWNER` and `FORGE_REPO` to a repository you are authorized to read, then append:

```js
const issues = await git.listIssues({
  provider: 'gitee',
  owner: process.env.FORGE_OWNER,
  repo: process.env.FORGE_REPO,
  state: 'open',
  maxPages: 1,
});
console.log(issues.map(({ number, labels }) => ({ number, labels })));
```

## Configuration

| `provider` | SDK option      | MCP process variable | Default API base                 |
| ---------- | --------------- | -------------------- | -------------------------------- |
| `github`   | `github.token`  | `GITHUB_TOKEN`       | `https://api.github.com`         |
| `gitee`    | `gitee.token`   | `GITEE_TOKEN`        | `https://gitee.com/api/v5`       |
| `atomgit`  | `atomgit.token` | `ATOMGIT_TOKEN`      | `https://api.atomgit.com/api/v5` |

Tokens are sent in `Authorization: Bearer`, not query strings. Configure only the providers you use, with the least privilege needed. The SDK takes explicit options; MCP reads its environment at startup. Set **either** `GITKIT_READONLY=1` or `GIT_FORGE_READONLY=1` for MCP; use `readonly: true` for the SDK. Otherwise writes are enabled, subject to provider permissions. A missing token disables calls to that provider, not tool discovery or the other providers. SDK endpoint overrides (`baseUrl`, `webBaseUrl`) require HTTPS except on loopback.

## Capabilities

| Domain and operation                                                       | GitHub | Gitee  | AtomGit |
| -------------------------------------------------------------------------- | ------ | ------ | ------- |
| Issues: list, get, create, update, list/add comments                       | Yes    | Yes    | Yes     |
| Pull requests: list, get, create, merge, list/add conversation comments    | Yes    | Yes    | Yes     |
| PR list with `head` filter                                                 | Yes    | Yes    | No (P)  |
| Repositories: list, get, create, read file contents                        | Yes    | Yes    | Yes     |
| Files: create/update, delete a single file                                 | Yes    | Yes    | Yes     |
| `pushFiles`: one commit, one or more files                                 | Yes    | Yes    | No (P)  |
| Branches: list/create; commits: list/get                                   | Yes    | Yes    | Yes     |
| Search, tags/releases, reviews, notifications, Actions, discussions, gists | No (S) | No (S) | No (S)  |

Yes = implemented, not a guarantee about a live account. P = this adapter has no corresponding provider operation: it rejects before HTTP rather than dropping a filter or splitting a commit. S = outside this SDK's scope; there is no such method/tool. Use `capabilities(provider)` and `paramCapabilities(provider)` to choose an alternative **explicitly**. For example, single-file changes are available on AtomGit, but several such calls are not atomic.

**Result details.** `Issue.number` is always the original identifier as a string, including leading zeros. `number_as_number` is present only for safe decimal digits; PR numbers are numeric. Labels are strings. Gitee `progressing` maps to `open`, `rejected` to `closed`; GitHub issues exclude PRs. A merged PR is `closed` with `merged: true`. A comment may link to its parent or have no `html_url`; an AtomGit PR may lack `head`. `getFileContents` reads a file, not a directory. File writes return `commit_sha` and paths. `pushFiles` accepts nonempty `create`/`update`/`delete` actions, not upsert.

### How the 23 tools compare to GitHub MCP

Names in the middle column are our tools **without** their `git_` prefix. The right column lists counterparts in the [official GitHub MCP README at a fixed revision](https://github.com/github/github-mcp-server/blob/9a72d8d38fec18c207cd924b33aa0eb3e186252c/README.md). A counterpart is not a promise of identical parameters or full toolset parity.

| Domain            | git-forge tools                                                                                                                                    | Official counterpart(s), in the same order                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue (6)         | `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_issue_comments`, `create_issue_comment`                                          | `list_issues`, `issue_read:get`, `issue_write:create`, `issue_write:update`, `issue_read:get_comments`, `add_issue_comment`                                                       |
| PR (6)            | `list_pull_requests`, `get_pull_request`, `create_pull_request`, `merge_pull_request`, `list_pull_request_comments`, `create_pull_request_comment` | `list_pull_requests`, `pull_request_read:get`, `create_pull_request`, `merge_pull_request`, `pull_request_read:get_comments`, `add_issue_comment` (PR conversation; not a review) |
| Repository (4)    | `list_repositories`, `get_repository`, `create_repository`, `get_file_contents`                                                                    | First two are **git-forge additions**, not independent tools in that README; `create_repository`, `get_file_contents`                                                             |
| Files (3)         | `create_or_update_file`, `delete_file`, `push_files`                                                                                               | `create_or_update_file`, `delete_file`, `push_files`                                                                                                                              |
| Branch/commit (4) | `list_branches`, `create_branch`, `list_commits`, `get_commit`                                                                                     | `list_branches`, `create_branch`, `list_commits`, `get_commit`                                                                                                                    |

`tool:method` means selecting a method on one upstream tool, not two upstream tool names. The SDK's `bulk` and capability queries are library helpers, not MCP tools.

## MCP client setup

Use an absolute path to Node and the **installed** MCP entry. From your application run `node -p "process.execPath"` and `node -p "require.resolve('@charles7c/git-forge-mcp/package.json')"`; replace the latter path's `package.json` with `dist/index.js`. Replace both sample paths below. On Windows, for example, use `C:/Program Files/nodejs/node.exe` and `C:/apps/forge/node_modules/@charles7c/git-forge-mcp/dist/index.js`. No shell, global install or `npx` lookup is needed.

**Claude Desktop** (Settings → Developer → Edit Config, `claude_desktop_config.json`) and **Cursor** (user `~/.cursor/mcp.json` or project `.cursor/mcp.json`) use this JSON:

```json
{
  "mcpServers": {
    "git-forge": {
      "command": "/usr/local/bin/node",
      "args": ["/opt/forge/node_modules/@charles7c/git-forge-mcp/dist/index.js"],
      "env": { "GITKIT_READONLY": "1" }
    }
  }
}
```

**ZCode** (Settings → MCP; user `~/.zcode/cli/config.json`) uses `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "git-forge": {
        "type": "stdio",
        "command": "/usr/local/bin/node",
        "args": ["/opt/forge/node_modules/@charles7c/git-forge-mcp/dist/index.js"],
        "env": { "GIT_FORGE_READONLY": "1" }
      }
    }
  }
}
```

Merge the entry with existing settings and restart the client. Expect 23 tools even without credentials. For reads, pass the relevant token to the **server process** through your client's private environment/secret settings or a trusted local launcher. Do not assume a GUI inherits your shell environment or that JSON expands `$GITHUB_TOKEN`/`${GITHUB_TOKEN}`; those can be literal strings. Never commit credentials. If no tools appear, check the two paths and stderr; stdout is for MCP only.

## Paging, retries and errors

List methods aggregate in page order and deduplicate. Default `maxPages` is 10 (100 items requested per page); use a smaller limit to bound work. Gitee open/closed issue queries page two native states separately. Reads retry rate limits, transport failures and retryable server errors up to three times after the first attempt. Without a server hint, reads use exponential backoff with full jitter. A valid `Retry-After` (seconds or HTTP-date) sets the earliest next attempt. If the required wait exceeds `retry.maxRetryAfterMs` (60 s by default), the SDK returns the original error without retrying. A GitHub quota reset is a fallback only for a rate-limited response with zero remaining quota. Writes do not retry by default. For multiple independent calls, `git.bulk(items, run, { concurrency: 4 })` retains input order and index: inspect each `{ ok, value }` or `{ ok, error }`. Successful items are not rolled back.

| `GitForgeError.code`      | What to do                                                                      |
| ------------------------- | ------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`        | Check required fields, identifiers, file actions and filters.                   |
| `READONLY_BLOCKED`        | A write was refused locally; keep read-only enabled unless writes are intended. |
| `AUTH_MISSING`            | Configure the provider token and restart the MCP process.                       |
| `AUTH_INVALID`            | Check token validity, scopes and repository permissions.                        |
| `UNSUPPORTED_ON_PROVIDER` | Inspect `capability`; do not assume the filter/action was applied.              |
| `NOT_FOUND`               | Check the resource, ref and visibility to this token.                           |
| `RATE_LIMITED`            | Reduce concurrency; allow the quota to recover.                                 |
| `NETWORK_ERROR`           | Check connectivity, DNS, TLS and timeout.                                       |
| `PROVIDER_ERROR`          | Inspect `status` and `requestId` if present before retrying.                    |

Use `error.toJSON()` for a structured SDK error (`code`, `message`, `retryable`; provider/status/requestId/capability when known). MCP reports SDK failures with `isError: true`. Offline contract tests cover the adapters; local HTTP/stdio tests cover transport, **not current hosted service behavior or permissions**.

[Provider details and API sources](./docs/providers.md) · [Architecture](./docs/architecture.md) · [Contributing and checks](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
