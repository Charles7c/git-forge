# Changelog

## 0.2.0 — 2026-11-25

Version 0.2.0 rather than 0.1.1: several results change meaning for existing
callers, which a patch version would misrepresent. The affected surfaces are
listed under **Changed** with what to re-check.

### Added

- TypeScript SDK for GitHub, Gitee and AtomGit: issues, pull requests, repositories, files, branches, commits, releases and labels. Both ESM and CommonJS entries include type declarations.
- Normalized models and errors, bounded list pagination and retries, read-only guards and ordered partial results for bulk calls.
- A local stdio MCP server with 29 tools backed by the SDK and provider-specific capability descriptions.
- Bilingual setup instructions, offline adapter contracts and loopback transport checks.
- Issue models keep the platform's own workflow state: `native_state` (Gitee `progressing` / `rejected`), `state_label` (Gitee `issue_state_detail.title`, AtomGit `issue_state`) and GitHub's `state_reason`, omitted rather than guessed when GitHub sends `null`.
- `Issue.restricted`, set from Gitee `security_hole` and AtomGit `visibility_reason`.
- `listIssueEvents` for label mutations, backed by GitHub's timeline and by the Gitee/AtomGit operation log, returned oldest-first.
- `listReleases` on all three platforms, sorted newest-first by the adapter.
- `listLabels`, `createLabel` and `ensureLabel`. `color` is normalized to `#rrggbb` and translated per platform on write.
- `Repository.visibility` as a four-way answer (`public` / `private` / `internal` / `unknown`), plus `Repository.stargazers_count` and `listStargazers` (GitHub and AtomGit; Gitee declared unsupported).
- `Commit.author.user` from the author-side account only, never the committer.
- `ListCommitsParams.since` / `until`, forwarded to the server-side filter all three platforms implement.
- `ListLabelsParams.requireComplete`, matching `ListIssuesParams`. In strict mode it validates the page shape as well as the page budget: a non-array body, or a row without a usable `name`, raises `PROVIDER_ERROR`.

### Changed

- **`Repository.visibility` no longer derives `public` from `private: false`.** Only `visibility: 'public'` or `public: true` yields `public`; a bare `private: false` now answers `unknown`. GitHub Enterprise `internal` repositories also report `private: false`, so the previous mapping could certify a repository as anonymously readable when it was not. Callers that treated `private === false` as "public" must read `visibility` instead.
- **`IssueEventType` gained `unknown`.** An AtomGit label mutation whose sentence cannot be parsed is no longer recorded as `labeled`; it reports `type: 'unknown'` with no `label`. A caller that assumed every event is an addition or a removal should handle the third value.
- **`EnsureLabelParams.color` is optional.** A pure existence check no longer has to supply a colour; it becomes required only when the label actually has to be created.
- **`ensureLabel` refuses rather than guesses on a truncated listing.** It reads with `requireComplete`, so a page-budget truncation raises `PAGINATION_LIMIT` instead of being read as "the name is absent". A malformed catalog — a non-array body, or a row with no usable `name` — raises `PROVIDER_ERROR` for the same reason. Neither case issues a write. Name matching is case-insensitive.
- **Releases are sorted newest-first after retrieval.** Upstream order is not reliable once pages are merged, and Gitee/AtomGit default to ascending. Entries without a timestamp sort last, preserving their relative order.
- **`listCommits` validates the window more strictly.** A calendar-invalid date (`2026-02-30`), an inverted window and an impossible UTC offset (`+00:60`) are all refused. Previously the first rolled over into a different month and the second could compare equal under millisecond truncation. The ordering compare now uses the nine fractional digits ISO 8601 allows (was six), and the offset is checked as an hour **and** a minute field rather than a combined total.
- **`Commit.author` survives a Git payload without a name.** When the linked account is known, the author block is still produced; a display name is never promoted to a `login`, and an account object with no `login` yields no `user`. An email-only Git author now keeps that email: the block is produced from any one of name, email or date, an unstated field stays an empty string, and the platform account's email never overwrites the commit's own record.
- **`IssueEvent` order is a guarantee, not an accident.** All three adapters sort the retrieved events oldest-first and stably, comparing parsed instants so `+08:00` and `Z` spellings of one moment compare equal. Previously the order was whatever the platform sent.
- `IssueState` remains binary, so a caller that only reads `state` sees no change; every new field is additive and optional.
- Gitee issues now populate `assignees` from the platform's singular `assignee` field. The previous mapping read a non-existent `assignees` array, so the value was always dropped.
- The capability table grows from 24 to 29 method-level entries and from 4 to 5 parameter-level entries; the MCP server exposes 29 tools.

### Fixed

- GitHub timeline entries are deduplicated **only** by their native `id`. Keying on `(event, time, label)` collapsed a labeled → unlabeled → labeled sequence that landed in the same second and inverted the resulting state. An entry with no id is never merged with another, because two of them cannot be proven to be the same event.
- `Date.UTC`'s two-digit-year rule no longer applies to instant bounds: `0099-01-01` is the first century rather than 1999, so the calendar check and the ordering compare are correct below year 100.
- AtomGit `release_status: 'latest'` (spelled `lasted` in one schema) maps to `pre_release: false` instead of leaving the flag absent on a stable release.
- Repository visibility is no longer defaulted to `false` when the payload omits the field, so "not stated" is distinguishable from "public".
- Issue lists reject malformed pages or invalid Issue numbers and states rather than returning misleading results.

Both packages are released together at 0.2.0. The MCP server exposes 29 tools; `git_ensure_label` accepts an omitted `color` (required only when a create is actually needed), `git_create_label` still requires it, and the tool descriptions of both — plus `git_list_issue_events` — state the behaviour above, including the `unknown` event direction.
