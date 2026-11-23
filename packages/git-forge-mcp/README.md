# @charles7c/git-forge-mcp

A local stdio MCP server exposing 23 Git tools for GitHub, Gitee and AtomGit. Pre-release: install the local SDK and MCP tarballs together. Node 20+ required.

Point the MCP client's `command` at the absolute path to Node and pass the absolute path to this package's `dist/index.js` as its only argument. From your application, `node -p "require.resolve('@charles7c/git-forge-mcp/package.json')"` locates the installed package. Do not use `npx` to fetch an unconfirmed release.

Set `GITKIT_READONLY=1` or `GIT_FORGE_READONLY=1` on the server process to block writes. Configure only the required platform tokens (`GITHUB_TOKEN`, `GITEE_TOKEN`, `ATOMGIT_TOKEN`) through private client settings. Tool discovery needs no token; API reads do. Stdout carries the protocol, stderr the startup banner.

[Claude Desktop, Cursor and ZCode setup](https://github.com/Charles7c/git-forge#mcp-client-setup) · [简体中文](https://github.com/Charles7c/git-forge/blob/main/README.zh-CN.md) · [MIT](./LICENSE).
