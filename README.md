# git-forge

English | [简体中文](./README.zh-CN.md)

A TypeScript SDK and a stdio MCP server for **GitHub, Gitee and AtomGit**. Applications and AI clients use the same provider adapters. The instructions below cover both published versions and installation from source. [Capability matrix](#capabilities) · [Provider notes](./docs/providers.md)

## Install and try it

From a source checkout, with Node 20 or 22 (latest patch) and pnpm 12.9.1:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:e2e
```

The last command runs local HTTP and stdio smoke tests without a token. For a published version, use `npm install @charles7c/git-forge` for the SDK or the `npx` example in [MCP client setup](#mcp-client-setup) for the server.

For an unpublished checkout or an offline install, create an empty directory for archives and replace `/path/to/archives` with its absolute path. From the checkout:

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

| Domain and operation                                                 | GitHub | Gitee  | AtomGit |
| -------------------------------------------------------------------- | ------ | ------ | ------- |
| Issues: list, get, create, update, list/add comments                 | Yes    | Yes    | Yes     |
| Issue label events (labeled / unlabeled / unknown)                   | Yes    | Yes    | Yes     |
| Pull requests: list, get, create, merge, list/add conversation notes | Yes    | Yes    | Yes     |
| PR list with `head` filter                                           | Yes    | Yes    | No (P)  |
| Repositories: list, get, create, read file contents                  | Yes    | Yes    | Yes     |
| Commit author account (`author.user`)                                | Yes    | Yes    | Yes     |
| Commits: `since` / `until` server-side window                        | Yes    | Yes    | Yes     |
| Stargazers: current count (`stargazers_count`)                       | Yes    | Yes    | Yes     |
| Stargazers: list users, and `starred_at` when asked                  | Yes    | No (P) | Yes     |
| Files: create/update, delete a single file                           | Yes    | Yes    | Yes     |
| `pushFiles`: one commit, one or more files                           | Yes    | Yes    | No (P)  |
| Branches: list/create; commits: list/get                             | Yes    | Yes    | Yes     |
| Releases: list                                                       | Yes    | Yes    | Yes     |
| Labels: list, create, ensure-exists                                  | Yes    | Yes    | Yes     |
| Search, tags, reviews, notifications, Actions, discussions, gists    | No (S) | No (S) | No (S)  |

Yes = implemented, not a guarantee about a live account. P = this adapter has no corresponding provider operation: it rejects before HTTP rather than dropping a filter or splitting a commit. S = outside this SDK's scope; there is no such method/tool. Use `capabilities(provider)` and `paramCapabilities(provider)` to choose an alternative **explicitly**. For example, single-file changes are available on AtomGit, but several such calls are not atomic.

Gitee's stargazer listing is the one **P** that is not a missing endpoint: `/stargazers` is routable but answers `[]` for every repository measured, including large ones, so declaring it unsupported is more honest than returning an empty list.

**Result details.** `Issue.number` is always the original identifier as a string, including leading zeros. `number_as_number` is present only for safe decimal digits; PR numbers are numeric. Labels are strings. Gitee `progressing` maps to `open` and `rejected` to `closed`, while `native_state` and `state_label` keep the platform's own words. `state_reason` is GitHub-only and may be absent on issues closed before the field existed. `restricted` is set only where the platform says so (Gitee `security_hole`, AtomGit `visibility_reason`). GitHub issues exclude PRs. A merged PR is `closed` with `merged: true`. A comment may link to its parent or have no `html_url`; an AtomGit PR may lack `head`. `getFileContents` reads a file, not a directory. File writes return `commit_sha` and paths. `pushFiles` accepts nonempty `create`/`update`/`delete` actions, not upsert.

**Visibility and stars.** `Repository.visibility` is a four-way answer (`public` / `private` / `internal` / `unknown`), and only a field that names the fact — `visibility: 'public'` or `public: true` — yields `public`. A bare `private: false` answers `unknown`, because GitHub Enterprise `internal` repositories report it too. `stargazers_count` is omitted rather than `0` when the payload carries no count. `Commit.author.user` is the author account only: it requires a real `login` and is never synthesised from a display name or an email, while the committer (frequently `web-flow` or a bot after a squash merge) is never substituted for it. The author block is produced from any one of the Git-side name, email or date, so an email-only commit keeps its email instead of losing it.

**Releases.** Entries are sorted newest-first locally after being retrieved, because upstream order is not reliable once pages are merged; entries without a timestamp sort last. Only GitHub reports a publication time, a release URL and a draft flag. Gitee and AtomGit report a creation time and no URL: their release pages are not addressable by a derived link (Gitee answers a 302 to a source archive for a non-browser client), so the SDK omits the field instead of fabricating one.

**Labels.** `color` is always normalized to `#rrggbb`; the `#` is stripped for GitHub and Gitee on write and kept for AtomGit. `ensureLabel` lists with `requireComplete` and refuses rather than guessing when the catalog cannot be trusted: `PAGINATION_LIMIT` if the page budget truncated the listing, `PROVIDER_ERROR` if a page is not an array or a row has no usable `name`. Neither case issues a write. It then creates only when the name really is absent, matching case-insensitively; `color` is optional and required only once a create is issued. It is not a conditional create — two concurrent callers can still race, and the loser re-reads once before reporting the upstream error. Descriptions are stored by GitHub only; Gitee and AtomGit accept and drop them, since their create body is `name` + `color`. `git_list_issue_events` reads Gitee's and AtomGit's operation log, which has no page parameter, so those two answer in a single request; all three return events oldest-first, and `type: 'unknown'` means a label change was reported whose direction could not be read.

### How the 29 tools compare to GitHub MCP

Names in the middle column are our tools **without** their `git_` prefix. The right column lists counterparts in the [official GitHub MCP README at a fixed revision](https://github.com/github/github-mcp-server/blob/9a72d8d38fec18c207cd924b33aa0eb3e186252c/README.md). A counterpart is not a promise of identical parameters or full toolset parity.

| Domain            | git-forge tools                                                                                                                                    | Official counterpart(s), in the same order                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue (7)         | `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_issue_comments`, `create_issue_comment`, `list_issue_events`                     | `list_issues`, `issue_read:get`, `issue_write:create`, `issue_write:update`, `issue_read:get_comments`, `add_issue_comment`                                                       |
| PR (6)            | `list_pull_requests`, `get_pull_request`, `create_pull_request`, `merge_pull_request`, `list_pull_request_comments`, `create_pull_request_comment` | `list_pull_requests`, `pull_request_read:get`, `create_pull_request`, `merge_pull_request`, `pull_request_read:get_comments`, `add_issue_comment` (PR conversation; not a review) |
| Repository (5)    | `list_repositories`, `get_repository`, `create_repository`, `list_stargazers`, `get_file_contents`                                                 | First four are **git-forge additions**, not independent tools in that README; `create_repository`, `get_file_contents`                                                            |
| Files (3)         | `create_or_update_file`, `delete_file`, `push_files`                                                                                               | `create_or_update_file`, `delete_file`, `push_files`                                                                                                                              |
| Branch/commit (4) | `list_branches`, `create_branch`, `list_commits`, `get_commit`                                                                                     | `list_branches`, `create_branch`, `list_commits`, `get_commit`                                                                                                                    |
| Release (1)       | `list_releases`                                                                                                                                    | `list_releases`                                                                                                                                                                   |
| Label (3)         | `list_labels`, `create_label`, `ensure_label`                                                                                                      | Not in that README: git-forge additions for version and status labels                                                                                                             |

`tool:method` means selecting a method on one upstream tool, not two upstream tool names. The SDK's `bulk` and capability queries are library helpers, not MCP tools.

## MCP client setup

The commands below pin `0.2.0` so a client keeps starting the version you chose rather than whatever `latest` resolves to. Use `npx` from Node 20 or newer. `--yes` skips the install prompt so a GUI client can start the server unattended. Both examples start it in read-only mode.

**Magpie** (Library → MCP Servers → Add Server) and **Cursor** (user `~/.cursor/mcp.json` or project `.cursor/mcp.json`) use `mcpServers`. For **Claude Desktop** (Settings → Developer → Edit Config, `claude_desktop_config.json`), use the same entry without `type`; `command` selects stdio.

```json
{
  "mcpServers": {
    "git-forge": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@charles7c/git-forge-mcp@0.2.0"],
      "env": {
        "GITHUB_TOKEN": "",
        "GITEE_TOKEN": "",
        "ATOMGIT_TOKEN": "",
        "GIT_FORGE_READONLY": "1"
      }
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
        "command": "npx",
        "args": ["--yes", "@charles7c/git-forge-mcp@0.2.0"],
        "env": {
          "GITHUB_TOKEN": "",
          "GITEE_TOKEN": "",
          "ATOMGIT_TOKEN": "",
          "GIT_FORGE_READONLY": "1"
        }
      }
    }
  }
}
```

Fill in only the tokens you need in your client's **private** settings. An empty string means “not configured”. If the client injects a token from its environment or secret store, omit the corresponding empty key so it does not override the secret. Do not commit tokens or assume JSON expands `$GITHUB_TOKEN` or `${GITHUB_TOKEN}`. Keep `GIT_FORGE_READONLY` set to `"1"` unless you intend to allow writes.

Merge the entry into your settings and restart the server. Seeing 29 tools confirms the server started, **not** that a token is valid. To check repository access, run `git_get_repository` with that `provider` and the `owner` and `repo` of a repository you may read. `AUTH_MISSING` means the server did not receive a token for that provider.

**If no tools appear**, check the startup command and stderr (stdout carries the MCP protocol):

- If a Windows GUI cannot launch `npx` directly, use `"command": "cmd.exe"` and `"args": ["/d", "/c", "npx", "--yes", "@charles7c/git-forge-mcp@0.2.0"]`. If Node and npm are not on the client's `PATH`, use the absolute-path setup below.
- If Magpie reports exit `4294963238` (`ENOENT` on Windows), check the npm debug log. If it names a missing `_npx/.../package.json`, `npx` **did** launch, but its cached installation is incomplete. Keep the command and tokens unchanged; set `npm_config_cache` in this server's `env` to a new, empty, writable directory (absolute path), then reconnect to let `npx` install the package there. There is no need to clear the shared npm cache.
- If your npm mirror has not synced the release, optionally add `"npm_config_registry": "https://registry.npmjs.org/"` to the server's `env` object.
- For offline use, install the local tarballs as described above. Set `command` to the absolute Node path from `node -p "process.execPath"`. Run `node -p "require.resolve('@charles7c/git-forge-mcp/package.json')"` from that installation, replace the trailing `package.json` with `dist/index.js`, and use that absolute path as the only `args` entry.

After initializing an MCP session, send this read-only JSON-RPC request from the client. The names below are fictional; replace them with a repository you are authorized to read.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "git_list_issues",
    "arguments": {
      "provider": "gitee",
      "owner": "sample-team",
      "repo": "example-project",
      "state": "open",
      "maxPages": 1
    }
  }
}
```

On success, parse `result.content[0].text` as a JSON array of issues. Each `number` is a string; `labels` contains names. If `result.isError` is true, read the text as an error instead.

## Paging, retries and errors

List methods aggregate in page order and deduplicate. Default `maxPages` is 10 (100 items requested per page); use a smaller limit to bound work. Gitee open/closed issue queries page two native states separately. An AtomGit closed PR query pages `closed`, `merged` and `locked` separately, up to `maxPages` each, then deduplicates by PR number. Reads retry rate limits, transport failures and retryable server errors up to three times after the first attempt. Without a server hint, reads use exponential backoff with full jitter. A valid `Retry-After` (seconds or HTTP-date) sets the earliest next attempt. If the required wait exceeds `retry.maxRetryAfterMs` (60 s by default), the SDK returns the original error without retrying. A GitHub quota reset is a fallback only for a rate-limited response with zero remaining quota. Writes do not retry by default. For multiple independent calls, `git.bulk(items, run, { concurrency: 4 })` retains input order and index: inspect each `{ ok, value }` or `{ ok, error }`. Successful items are not rolled back.

When called with `requireComplete: true`, the SDK's `git.listIssues` still returns an array on success, but rejects with non-retryable `PAGINATION_LIMIT` when another page is indicated at the `maxPages` cap. For a split Gitee query, neither native stream may be truncated. A recognized final-page header is honored; a full page with no usable hint is probed while budget remains. This detects budget truncation, not concurrent changes or pagination hints missing upstream. Without the flag, capped calls still return the items read; MCP keeps this default. In either mode, an invalid Issue list response rejects with `PROVIDER_ERROR` instead of returning an empty or partial array.

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
| `PAGINATION_LIMIT`        | Increase `maxPages` or narrow the Issue query.                                  |

Use `error.toJSON()` for a structured SDK error (`code`, `message`, `retryable`; provider/status/requestId/capability when known). MCP reports SDK failures with `isError: true`. Offline contract tests cover the adapters; local HTTP/stdio tests cover transport, **not current hosted service behavior or permissions**.

[Provider details and API sources](./docs/providers.md) · [Architecture](./docs/architecture.md) · [Contributing and checks](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md) · [MIT license](./LICENSE)
