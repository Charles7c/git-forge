# @charles7c/git-forge-mcp

A local stdio MCP server exposing 29 Git tools for GitHub, Gitee and AtomGit. Node 20+ required.

For Magpie or Cursor, add this entry to your MCP client configuration:

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

Fill in only the tokens for the providers you use, in private client settings. If the client injects a secret separately, omit its empty entry here. Restart the server after changing tokens. Listing 29 tools confirms startup, not authentication; use `git_get_repository` on a repository you may read to check access. The example blocks writes locally; remove `GIT_FORGE_READONLY` only if you intend to allow writes.

This release pairs with `@charles7c/git-forge@0.2.0`, which it declares as a dependency. `git_ensure_label` accepts an omitted `color` (needed only when the label has to be created), `git_create_label` still requires one, and `git_list_issue_events` reports `type: "unknown"` for a platform label change whose direction could not be read.

For an offline installation, install the local SDK and MCP tarballs together and use the absolute paths to Node and the installed `dist/index.js`. The setup guide covers this and Windows `npx` troubleshooting. Stdout carries the protocol; stderr carries the startup banner.

[Magpie, Claude Desktop, Cursor and ZCode setup](https://github.com/Charles7c/git-forge#mcp-client-setup) · [简体中文](https://github.com/Charles7c/git-forge/blob/main/README.zh-CN.md) · [MIT](./LICENSE).
