/**
 * Gitee capability table.
 *
 * Gitee serves all 24 capabilities. `files.pushFiles` is backed by the
 * `POST /repos/{owner}/{repo}/commits` endpoint, which
 * accepts every action in one request and produces a single commit.
 *
 * `issues.list.milestoneFilter` is declared `supported` at the method/parameter
 * level because the endpoint does have a `milestone` filter; what it cannot do is
 * accept a *number*. That mismatch is a value-level rejection inside the adapter
 * (`INVALID_ARGUMENT`), not a missing capability — the parameter exists and is
 * forwarded, so declaring it unsupported would misreport the platform.
 */
import type { CapabilityTable, ParamCapabilityTable } from '../../core/types.js';

/** Method-level capabilities: all 24 are served by this adapter. */
export const capabilities: CapabilityTable = {
  'issues.list': 'supported',
  'issues.get': 'supported',
  'issues.create': 'supported',
  'issues.update': 'supported',
  'issues.listComments': 'supported',
  'issues.createComment': 'supported',
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
  'files.create': 'supported',
  'files.update': 'supported',
  'files.delete': 'supported',
  'files.pushFiles': 'supported',
  'branches.list': 'supported',
  'branches.create': 'supported',
  'commits.list': 'supported',
  'commits.get': 'supported',
};

/**
 * Parameter-level capabilities.
 *
 * Single-request `POST /commits` means the batch is atomic, and both milestone
 * filters exist on Gitee's list endpoints.
 */
export const paramCapabilities: ParamCapabilityTable = {
  'pulls.list.headFilter': 'supported',
  'pulls.list.milestoneFilter': 'supported',
  'issues.list.milestoneFilter': 'supported',
  'files.pushFiles.atomic': 'supported',
};
