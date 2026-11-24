# Changelog

## Unreleased — 0.1.0 pre-release

### Added

- TypeScript SDK for GitHub, Gitee and AtomGit: issues, pull requests, repositories, files, branches and commits. Both ESM and CommonJS entries include type declarations.
- Normalized models and errors, bounded list pagination and retries, read-only guards and ordered partial results for bulk calls.
- A local stdio MCP server with 23 tools backed by the SDK and provider-specific capability descriptions.
- Bilingual setup instructions, offline adapter contracts and loopback transport checks.

### Fixed

- Issue lists reject malformed pages or invalid Issue numbers and states rather than returning misleading results. SDK callers can opt into `requireComplete` to reject budget truncation without changing the default array behavior.

No registry publication or tagged release is implied by this entry.
