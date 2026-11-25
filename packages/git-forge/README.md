# @charles7c/git-forge

TypeScript SDK for issues, pull requests, repositories, files, branches and commits on GitHub, Gitee and AtomGit. Node 20+, ESM and CommonJS with declarations; no third-party runtime dependencies. This is version `0.2.0`.

Run `npm install @charles7c/git-forge` for the published version. For an offline installation, build the source and install the local SDK tarball (`pnpm --dir packages/git-forge pack`).

```js
import { GitClient } from '@charles7c/git-forge';
const git = new GitClient({ readonly: true });
console.log(git.capabilities('gitee')['files.pushFiles']); // supported, no HTTP
```

The 0.2.0 surface adds releases, labels (`listLabels`, `createLabel`, `ensureLabel`), issue label events, stargazers, a four-way `Repository.visibility`, and `since`/`until` commit bounds. Three results changed meaning for 0.1.0 callers — `visibility`, `IssueEventType` gaining `unknown`, and `EnsureLabelParams.color` becoming optional — so read the [changelog](https://github.com/Charles7c/git-forge/blob/main/CHANGELOG.md) before upgrading.

Configure each provider explicitly (`github.token`, `gitee.token`, `atomgit.token`) before reading from your own repository. For installation and platform differences, see the [English guide](https://github.com/Charles7c/git-forge#readme) or [简体中文](https://github.com/Charles7c/git-forge/blob/main/README.zh-CN.md). [MIT](./LICENSE).
