# @charles7c/git-forge-mcp

A local stdio MCP server exposing 23 Git tools for GitHub, Gitee and AtomGit. Node 20+ required.

Once version `0.1.0` is available on npm, set the MCP client's `command` to `npx` and `args` to `["--yes", "@charles7c/git-forge-mcp@0.1.0"]`. For an unpublished checkout or offline installation, build the source, install the local SDK and MCP tarballs together, and use the absolute paths to Node and the installed `dist/index.js` as described in the setup guide below.

Set `GITKIT_READONLY=1` or `GIT_FORGE_READONLY=1` on the server process to block writes. Configure only the required platform tokens (`GITHUB_TOKEN`, `GITEE_TOKEN`, `ATOMGIT_TOKEN`) through private client settings. Tool discovery needs no token; API reads do. Stdout carries the protocol, stderr the startup banner.

[Claude Desktop, Cursor and ZCode setup](https://github.com/Charles7c/git-forge#mcp-client-setup) · [简体中文](https://github.com/Charles7c/git-forge/blob/main/README.zh-CN.md) · [MIT](./LICENSE).
