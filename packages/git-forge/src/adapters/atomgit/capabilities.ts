/**
 * AtomGit capability table.
 *
 * One capability is genuinely missing: `files.pushFiles`. AtomGit has no batch
 * commit endpoint, so the method is declared `unsupported` and backed by an
 * explicit error. Declaring it `unsupported` rather than splitting the batch into
 * N single-file commits is deliberate: the contract promises one commit, and a
 * partial multi-commit write cannot be rolled back.
 *
 * Everything else is served, including the stargazer listing — AtomGit is the one
 * platform whose stargazer payload carries `starred_at` unconditionally, so
 * `repos.listStargazers.timestamps` is supported without a special request header.
 *
 * The parameter tables record two parameter-level gaps: the pull-request list has
 * no `head` filter, and `files.pushFiles.atomic` is unavailable because the
 * method itself is.
 */
import type { CapabilityTable, ParamCapabilityTable } from '../../core/types.js';

/** Method-level capabilities: 28 of 29; `files.pushFiles` is absent by design. */
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
  'files.pushFiles': 'unsupported',
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
 * `pulls.list.headFilter` is `unsupported` and `files.pushFiles.atomic` is
 * `unsupported` because the method it qualifies does not exist.
 */
export const paramCapabilities: ParamCapabilityTable = {
  'pulls.list.headFilter': 'unsupported',
  'pulls.list.milestoneFilter': 'supported',
  'issues.list.milestoneFilter': 'supported',
  'files.pushFiles.atomic': 'unsupported',
  'repos.listStargazers.timestamps': 'supported',
};
