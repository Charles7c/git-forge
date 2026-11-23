# git-forge

[English](./README.md) | 简体中文

面向 **GitHub、Gitee 和 AtomGit** 的 TypeScript SDK 与 stdio MCP 服务。应用与 AI 客户端共享平台适配器。0.1.0 是**预发布版本**；下面从本地源码打包安装，不依赖这两个包已在 npm 发布。[能力矩阵](#能力矩阵) · [平台差异](./docs/providers.md)

## 安装与快速开始

在源码根目录使用 Node 20 或 22（最新补丁版本）与 pnpm 12.9.1：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:e2e
```

最后一条命令运行本地 HTTP 与 stdio 测试，不需要令牌。要在另一个项目使用，先建一个空目录存放归档，将 `/path/to/archives` 替换为它的绝对路径，然后在源码根目录执行：

```sh
pnpm --dir packages/git-forge pack --out /path/to/archives/sdk.tgz
pnpm --dir packages/git-forge-mcp pack --out /path/to/archives/mcp.tgz
```

在已有 `package.json` 的应用目录运行 `npm install /path/to/archives/sdk.tgz /path/to/archives/mcp.tgz`。只使用 SDK 时仅安装 `sdk.tgz` 即可。SDK 无第三方运行时依赖；MCP 仍需要它声明的第三方依赖，离线安装须预先备好包管理器缓存。Windows 可使用 `C:/archives/sdk.tgz` 这类绝对路径。

在应用目录保存 `quickstart.mjs`，运行 `node quickstart.mjs`。这个示例完全不需要联网：

```js
import { GitClient } from '@charles7c/git-forge';
const git = new GitClient({ readonly: true, gitee: { token: process.env.GITEE_TOKEN } });
console.log(git.capabilities('gitee')['files.pushFiles']); // supported
console.log(git.capabilities('atomgit')['files.pushFiles']); // unsupported
```

如需真实读取，请配置令牌，将 `FORGE_OWNER` 和 `FORGE_REPO` 设置为有权读取的仓库，再追加：

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

## 配置

| `provider` | SDK 选项        | MCP 进程环境变量 | 默认 API 基址                    |
| ---------- | --------------- | ---------------- | -------------------------------- |
| `github`   | `github.token`  | `GITHUB_TOKEN`   | `https://api.github.com`         |
| `gitee`    | `gitee.token`   | `GITEE_TOKEN`    | `https://gitee.com/api/v5`       |
| `atomgit`  | `atomgit.token` | `ATOMGIT_TOKEN`  | `https://api.atomgit.com/api/v5` |

三平台均通过 `Authorization: Bearer` 发送令牌，不放入 URL。只配置所需平台，使用最小权限。SDK 接收显式配置，MCP 启动时读取环境。MCP 设置 `GITKIT_READONLY=1` **或** `GIT_FORGE_READONLY=1` 即开启只读；SDK 传 `readonly: true`。默认允许写，实际取决于平台权限。缺少某个平台的令牌不影响工具发现及其他平台。SDK 可覆盖 `baseUrl`、`webBaseUrl`，除回环地址外必须使用 HTTPS。

## 能力矩阵

| 能力域与操作                                       | GitHub     | Gitee      | AtomGit    |
| -------------------------------------------------- | ---------- | ---------- | ---------- |
| Issue：列表、详情、创建、修改、列出/新增评论       | 支持       | 支持       | 支持       |
| PR：列表、详情、创建、合并、列出/新增对话评论      | 支持       | 支持       | 支持       |
| PR 列表按 `head` 过滤                              | 支持       | 支持       | 不支持 (P) |
| 仓库：列表、详情、创建、读取文件内容               | 支持       | 支持       | 支持       |
| 文件：创建/更新、删除单个文件                      | 支持       | 支持       | 支持       |
| `pushFiles`：一个或多个文件合为单个提交            | 支持       | 支持       | 不支持 (P) |
| 分支：列出/创建；提交：列出/详情                   | 支持       | 支持       | 支持       |
| 搜索、标签/发行版、审查、通知、Actions、讨论、Gist | 未实现 (S) | 未实现 (S) | 未实现 (S) |

「支持」指已实现，并非线上账号的成功保证。P 表示适配器没有对应的平台操作，发请求前即拒绝，不会忽略过滤条件或将一次提交拆成多次。S 表示超出本 SDK 范围，没有对应方法或工具。可用 `capabilities(provider)` 与 `paramCapabilities(provider)` 检查后**显式选择**替代方案。例如 AtomGit 可逐文件写入，但多个这样的调用不具备原子性。

**返回值差异。** `Issue.number` 始终为保留前导零的原始编号字符串，仅在纯十进制且数值安全时附带 `number_as_number`；PR 编号为数值。标签为字符串数组。Gitee `progressing` 归入 `open`、`rejected` 归入 `closed`；GitHub 的 Issue 列表排除 PR。已合并 PR 为 `closed` 且 `merged: true`。评论链接可能指向父条目，也可能没有 `html_url`；AtomGit PR 的 `head` 可缺失。`getFileContents` 只读文件，不列目录。文件写入返回 `commit_sha` 与路径；`pushFiles` 接受非空的 `create`/`update`/`delete` 操作列表，而非 upsert。

### 23 个工具与 GitHub 官方 MCP 的对应关系

中列省略本库工具统一的 `git_` 前缀，右列顺序与中列相同。对照依据为[固定版本的官方 GitHub MCP README](https://github.com/github/github-mcp-server/blob/9a72d8d38fec18c207cd924b33aa0eb3e186252c/README.md)。有对应操作不代表参数相同，也不代表两套工具完全等价。

| 能力域         | git-forge 工具                                                                                                                                     | 官方对应入口                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue（6）     | `list_issues`、`get_issue`、`create_issue`、`update_issue`、`list_issue_comments`、`create_issue_comment`                                          | `list_issues`、`issue_read:get`、`issue_write:create`、`issue_write:update`、`issue_read:get_comments`、`add_issue_comment`                                                |
| PR（6）        | `list_pull_requests`、`get_pull_request`、`create_pull_request`、`merge_pull_request`、`list_pull_request_comments`、`create_pull_request_comment` | `list_pull_requests`、`pull_request_read:get`、`create_pull_request`、`merge_pull_request`、`pull_request_read:get_comments`、`add_issue_comment`（PR 对话，不是代码审查） |
| 仓库（4）      | `list_repositories`、`get_repository`、`create_repository`、`get_file_contents`                                                                    | 前两项是**本库新增入口**，官方该版本未单列；后两项为 `create_repository`、`get_file_contents`                                                                              |
| 文件（3）      | `create_or_update_file`、`delete_file`、`push_files`                                                                                               | `create_or_update_file`、`delete_file`、`push_files`                                                                                                                       |
| 分支/提交（4） | `list_branches`、`create_branch`、`list_commits`、`get_commit`                                                                                     | `list_branches`、`create_branch`、`list_commits`、`get_commit`                                                                                                             |

`工具:方法` 指同一官方工具内的 method 选择器，不是两个工具名。SDK 的 `bulk` 和能力查询是库函数，不占用 MCP 工具数。

## MCP 客户端接入

使用 Node 和**已安装的** MCP 入口的绝对路径。在应用目录运行 `node -p "process.execPath"`、`node -p "require.resolve('@charles7c/git-forge-mcp/package.json')"`，将第二个结果末尾的 `package.json` 换成 `dist/index.js`。用这两个实际路径替换示例。Windows 可写成 `C:/Program Files/nodejs/node.exe` 与 `C:/apps/forge/node_modules/@charles7c/git-forge-mcp/dist/index.js`。无需 shell、全局安装或 `npx` 查找。

**Claude Desktop**（Settings → Developer → Edit Config，即 `claude_desktop_config.json`）和 **Cursor**（用户 `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`）使用：

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

**ZCode**（设置 → MCP，用户配置 `~/.zcode/cli/config.json`）使用 `mcp.servers`：

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

与现有配置合并后重启客户端；即使没有令牌也应能列出 23 个工具。需要读取时，通过客户端私有环境/密钥设置或可信本地启动器，将所需令牌传给**服务进程**。不要假设 GUI 会继承终端环境，也不要在 JSON 中假设 `$GITHUB_TOKEN` 或 `${GITHUB_TOKEN}` 会自动展开，否则传入的可能只是字面字符串。不要提交令牌。看不到工具时检查两个绝对路径及 stderr，stdout 仅承载 MCP 协议。

## 分页、重试与错误

列表按页序合并并去重，默认 `maxPages` 为 10（每页请求 100 条），可调小以控制读取量。Gitee 的 open/closed Issue 查询分别对两个原生状态分页。读取遇限流、传输错误或可重试服务端错误时，首次请求后最多重试三次。没有服务端提示时，读取使用带全抖动的指数退避。有效的 `Retry-After`（秒数或 HTTP 日期）指定下次请求的最早时间；所需等待超过 `retry.maxRetryAfterMs`（默认 60 秒）时，SDK 直接返回原错误，不再重试。仅当 GitHub 返回限流响应且剩余配额为零时，才用配额重置时间作为后备提示。默认不重试写请求。用 `git.bulk(items, run, { concurrency: 4 })` 执行多项独立调用，结果保留输入顺序与下标；逐项检查 `{ ok, value }` 或 `{ ok, error }`，成功项不回滚。

| `GitForgeError.code`      | 处理建议                                                 |
| ------------------------- | -------------------------------------------------------- |
| `INVALID_ARGUMENT`        | 检查必填字段、编号、文件操作与过滤条件。                 |
| `READONLY_BLOCKED`        | 写操作已被本地拒绝；确有写入需求时再调整只读设置。       |
| `AUTH_MISSING`            | 配置对应平台的令牌，重启 MCP 进程。                      |
| `AUTH_INVALID`            | 检查令牌有效期、授权范围及仓库权限。                     |
| `UNSUPPORTED_ON_PROVIDER` | 查看 `capability`；不要假设过滤或操作已执行。            |
| `NOT_FOUND`               | 检查资源、ref 及令牌是否可见。                           |
| `RATE_LIMITED`            | 降低并发，等待配额恢复。                                 |
| `NETWORK_ERROR`           | 检查网络、DNS、TLS 与超时设置。                          |
| `PROVIDER_ERROR`          | 如有 `status` 或 `requestId`，据此定位后再决定是否重试。 |

SDK 的 `error.toJSON()` 提供 `code`、`message`、`retryable`，并在可知时附 `provider`、`status`、`requestId`、`capability`。MCP 的 SDK 错误返回 `isError: true`。离线契约测试覆盖平台适配逻辑；本地 HTTP/stdio 测试覆盖传输，**不能证明当前托管平台行为或账号权限**。

[平台差异与规范来源](./docs/providers.md) · [架构](./docs/architecture.md) · [贡献与开发检查](./CONTRIBUTING.md) · [变更记录](./CHANGELOG.md) · [MIT 许可证](./LICENSE)
