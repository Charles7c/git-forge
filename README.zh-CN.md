# git-forge

> 平台无关的 Git 工具链：一套 TypeScript SDK 与一个 MCP server，用同一种口径说 **GitHub**、**Gitee**、**AtomGit** 三种方言。

[English](./README.md) | **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

> **状态：未发布。** `v0.1.0` 正在开发中。下文描述的 API 面正在实现，首个正式版本发布前可能调整。

## 为什么需要它

大多数代码托管平台都有自己的一套 API 形状。当你同时跨 GitHub、Gitee、AtomGit 工作——无论来自应用代码还是 AI Agent——结果往往是每个平台维护一个客户端，再堆一层字段映射胶水。

`git-forge` 提供一套以 GitHub 字段命名为基准的 API，把平台差异收在 adapter 内部。某个平台确实不支持的能力会以 `UNSUPPORTED_ON_PROVIDER` 明确报错，而不是悄悄返回一个错的东西。

## 计划中的包

| 包 | 用途 |
|---|---|
| `@charles7c/git-forge` | 供程序化调用的 TypeScript SDK |
| `@charles7c/git-forge-mcp` | 供 AI 工具调用的 MCP server（`stdio`） |

两个包共享同一份平台逻辑实现，因此 SDK 与 MCP server 的数据口径始终一致。

## v0.1.0 范围

五个能力域，三平台全部实现：

- **Issue** — list、get、create、update、comment
- **Pull Request** — list、get、create、merge、comment
- **Repository** — list、get、create、读取文件内容
- **文件** — create、update、delete、多文件批量提交（push_files）
- **分支与提交** — 分支 list/create，提交 list/get

此外还有共用机制：自动分页、`429`/`5xx` 指数退避、bulk 操作部分失败隔离、统一错误模型、能力探测。

搜索、Release、Review、Notification，以及 GitHub 专属能力（Actions、Discussions、Gists 等）**不属于** v0.1.0。它们作为 roadmap 跟踪，调用时明确报不支持，不做假实现。

## 文档

完整文档——安装、三平台配置、能力矩阵、平台差异、MCP 客户端接入方式——将随 `v0.1.0` 发布。

## 许可证

[MIT](./LICENSE) © 2026 Charles7c
