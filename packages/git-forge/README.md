# @charles7c/git-forge

TypeScript SDK for issues, pull requests, repositories, files, branches and commits on GitHub, Gitee and AtomGit. Node 20+, ESM and CommonJS with declarations; no third-party runtime dependencies.

For a published version, run `npm install @charles7c/git-forge`. For an unpublished checkout or offline installation, build the source and install the local SDK tarball.

```js
import { GitClient } from '@charles7c/git-forge';
const git = new GitClient({ readonly: true });
console.log(git.capabilities('gitee')['files.pushFiles']); // supported, no HTTP
```

Configure each provider explicitly (`github.token`, `gitee.token`, `atomgit.token`) before reading from your own repository. For installation and platform differences, see the [English guide](https://github.com/Charles7c/git-forge#readme) or [简体中文](https://github.com/Charles7c/git-forge/blob/main/README.zh-CN.md). [MIT](./LICENSE).
