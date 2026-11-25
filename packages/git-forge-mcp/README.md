# @charles7c/git-forge-mcp

A local stdio MCP server exposing 29 Git tools for GitHub, Gitee and AtomGit. Node 20+ required.

This is version `0.2.0` (29 tools). Set the MCP client's `command` to `npx` and `args` to `["--yes", "@charles7c/git-forge-mcp@0.2.0"]`. For an offline installation, build the source, install the local SDK and MCP tarballs together, and use the absolute paths to Node and the installed `dist/index.js` as described in the setup guide below.

This release pairs with `@charles7c/git-forge@0.2.0`, which it declares as a dependency. `git_ensure_label` accepts an omitted `color` (needed only when the label has to be created), `git_create_label` still requires one, and `git_list_issue_events` reports `type: "unknown"` for a platform label change whose direction could not be read.

Set `GITKIT_READONLY=1` or `GIT_FORGE_READONLY=1` on the server process to block writes. Configure only the required platform tokens (`GITHUB_TOKEN`, `GITEE_TOKEN`, `ATOMGIT_TOKEN`) through private client settings. Tool discovery needs no token; API reads do. Stdout carries the protocol, stderr the startup banner.

[Claude Desktop, Cursor and ZCode setup](https://github.com/Charles7c/git-forge#mcp-client-setup) · [简体中文](https://github.com/Charles7c/git-forge/blob/main/README.zh-CN.md) · [MIT](./LICENSE).
