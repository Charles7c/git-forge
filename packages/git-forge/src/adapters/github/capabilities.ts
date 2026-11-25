/**
 * GitHub capability table.
 *
 * GitHub implements every capability in v0.2.0, including the atomic batch
 * commit (`files.pushFiles`) and its `files.pushFiles.atomic` parameter-level
 * counterpart: the `git/trees` + `git/commits` + `git/refs` chain produces one
 * commit containing every entry.
 *
 * `repos.listStargazers.timestamps` is supported because the
 * `application/vnd.github.star+json` media type makes GitHub report
 * `starred_at`. The endpoint requires authentication, which the token gate
 * already enforces for every call.
 */
import type { CapabilityTable, ParamCapabilityTable } from '../../core/types.js';

/** Method-level capabilities: all 29 are served by this adapter. */
export const capabilities: CapabilityTable = {
  'issues.list': 'supported',
  'issues.get': 'supported',
  'issues.create': 'supported',
  'issues.update': 'supported',
  'issues.listComments': 'supported',
  'issues.createComment': 'supported',
  'issues.listEvents': 'supported',
  'pulls.list': 'supported',
  'pulls.get': 'supported',
  'pulls.create': 'supported',
  'pulls.merge': 'supported',
  'pulls.listComments': 'supported',
  'pulls.createComment': 'supported',
  'repos.list': 'supported',
  'repos.get': 'supported',
  'repos.create': 'supported',
  'repos.getFileContents': 'supported',
  'repos.listStargazers': 'supported',
  'files.create': 'supported',
  'files.update': 'supported',
  'files.delete': 'supported',
  'files.pushFiles': 'supported',
  'branches.list': 'supported',
  'branches.create': 'supported',
  'commits.list': 'supported',
  'commits.get': 'supported',
  'releases.list': 'supported',
  'labels.list': 'supported',
  'labels.create': 'supported',
};

/**
 * Parameter-level capabilities.
 *
 * `pulls.list.headFilter` is native (`head=owner:branch`); `files.pushFiles.atomic`
 * holds because the tree/commit/ref chain yields a single commit.
 */
export const paramCapabilities: ParamCapabilityTable = {
  'pulls.list.headFilter': 'supported',
  'pulls.list.milestoneFilter': 'supported',
  'issues.list.milestoneFilter': 'supported',
  'files.pushFiles.atomic': 'supported',
  'repos.listStargazers.timestamps': 'supported',
};
