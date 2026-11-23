import { describe, expect, it } from 'vitest';

import { GitForgeError } from '../../src/core/errors.js';
import { MAX_PAGES_LIMIT } from '../../src/core/paginate.js';
import {
  CAPABILITY_IDS,
  PARAM_CAPABILITY_IDS,
  PROVIDERS,
  type CapabilityId,
  type ParamCapabilityId,
} from '../../src/core/types.js';
import {
  WRITE_CAPABILITIES,
  assertCapabilityTableKeys,
  assertFilePath,
  assertMaxPages,
  assertNativeId,
  assertNonEmpty,
  assertNonEmptyStringArray,
  assertOneOf,
  assertOptionalNonEmpty,
  assertOptionalPositiveInt,
  assertParamsObject,
  assertPathSegment,
  assertPositiveInt,
  assertProvider,
  assertRepoRef,
  assertStringArray,
  isWriteCapability,
} from '../../src/core/validate.js';

/** Runs a validator and returns the thrown error, failing if none was thrown. */
function capture(fn: () => void): GitForgeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GitForgeError);
    return error as GitForgeError;
  }
  throw new Error('expected the validator to throw');
}

describe('CAPABILITY_IDS', () => {
  it('has exactly 24 entries', () => {
    expect(CAPABILITY_IDS).toHaveLength(24);
  });

  it('contains no duplicates', () => {
    expect(new Set(CAPABILITY_IDS).size).toBe(24);
  });

  it('is grouped as Issue 6 / PR 6 / Repo 4 / Files 4 / Branch 2 / Commit 2', () => {
    const count = (prefix: string): number =>
      CAPABILITY_IDS.filter((id) => id.startsWith(prefix)).length;
    expect(count('issues.')).toBe(6);
    expect(count('pulls.')).toBe(6);
    expect(count('repos.')).toBe(4);
    expect(count('files.')).toBe(4);
    expect(count('branches.')).toBe(2);
    expect(count('commits.')).toBe(2);
    expect(6 + 6 + 4 + 4 + 2 + 2).toBe(24);
  });

  it('lists the exact expected identifiers', () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(
      [
        'issues.list',
        'issues.get',
        'issues.create',
        'issues.update',
        'issues.listComments',
        'issues.createComment',
        'pulls.list',
        'pulls.get',
        'pulls.create',
        'pulls.merge',
        'pulls.listComments',
        'pulls.createComment',
        'repos.list',
        'repos.get',
        'repos.create',
        'repos.getFileContents',
        'files.create',
        'files.update',
        'files.delete',
        'files.pushFiles',
        'branches.list',
        'branches.create',
        'commits.list',
        'commits.get',
      ].sort(),
    );
  });

  it('has a compile-time type matching the runtime list', () => {
    // If CAPABILITY_IDS drifted from CapabilityId this would stop compiling.
    const ids: CapabilityId[] = [...CAPABILITY_IDS];
    expect(ids).toHaveLength(CAPABILITY_IDS.length);
  });
});

describe('WRITE_CAPABILITIES', () => {
  it('holds exactly 12 capabilities', () => {
    expect(WRITE_CAPABILITIES.size).toBe(12);
  });

  it('lists the exact write operations', () => {
    expect([...WRITE_CAPABILITIES].sort()).toEqual(
      [
        'issues.create',
        'issues.update',
        'issues.createComment',
        'pulls.create',
        'pulls.merge',
        'pulls.createComment',
        'repos.create',
        'files.create',
        'files.update',
        'files.delete',
        'files.pushFiles',
        'branches.create',
      ].sort(),
    );
  });

  it('contains only real capability ids', () => {
    for (const capability of WRITE_CAPABILITIES) {
      expect(CAPABILITY_IDS).toContain(capability);
    }
  });

  it('excludes every read capability', () => {
    const reads = CAPABILITY_IDS.filter((id) => !WRITE_CAPABILITIES.has(id));
    expect(reads).toHaveLength(12);
    expect(reads).toContain('issues.list');
    expect(reads).toContain('repos.getFileContents');
    expect(reads).toContain('commits.get');
  });

  it('answers isWriteCapability consistently', () => {
    expect(isWriteCapability('files.pushFiles')).toBe(true);
    expect(isWriteCapability('files.create')).toBe(true);
    expect(isWriteCapability('pulls.list')).toBe(false);
    expect(isWriteCapability('branches.list')).toBe(false);
  });
});

describe('PARAM_CAPABILITY_IDS', () => {
  it('has exactly the four documented entries', () => {
    expect([...PARAM_CAPABILITY_IDS].sort()).toEqual(
      [
        'pulls.list.headFilter',
        'pulls.list.milestoneFilter',
        'issues.list.milestoneFilter',
        'files.pushFiles.atomic',
      ].sort(),
    );
  });

  it('does not overlap the method-level list', () => {
    const methodIds = new Set<string>(CAPABILITY_IDS);
    for (const id of PARAM_CAPABILITY_IDS) {
      expect(methodIds.has(id)).toBe(false);
    }
  });

  it('has a compile-time type matching the runtime list', () => {
    const ids: ParamCapabilityId[] = [...PARAM_CAPABILITY_IDS];
    expect(ids).toHaveLength(4);
  });
});

describe('PROVIDERS', () => {
  it('lists the three supported platforms', () => {
    expect([...PROVIDERS]).toEqual(['github', 'gitee', 'atomgit']);
  });
});

describe('assertCapabilityTableKeys', () => {
  /** Builds a table with every key set to `supported`. */
  const fullTable = (): Record<string, string> =>
    Object.fromEntries(CAPABILITY_IDS.map((id) => [id, 'supported']));

  it('accepts a table whose keys equal CAPABILITY_IDS', () => {
    expect(() => assertCapabilityTableKeys(fullTable())).not.toThrow();
  });

  it('rejects a table missing a key and names it', () => {
    const table = fullTable();
    delete table['commits.get'];
    const error = capture(() => assertCapabilityTableKeys(table));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('commits.get');
  });

  it('rejects a table with an unexpected key and names it', () => {
    const error = capture(() =>
      assertCapabilityTableKeys({ ...fullTable(), 'issues.search': 'supported' }),
    );
    expect(error.message).toContain('issues.search');
  });
});

describe('parameter validators', () => {
  it('accepts each provider and rejects an unknown one', () => {
    for (const provider of PROVIDERS) {
      expect(() => assertProvider(provider)).not.toThrow();
    }
    const error = capture(() => assertProvider('gitlab'));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('provider');
  });

  it('rejects a non-string provider', () => {
    expect(capture(() => assertProvider(42)).message).toContain('provider');
  });

  it('rejects an empty or blank required string', () => {
    expect(() => assertNonEmpty('title', 'ok')).not.toThrow();
    expect(capture(() => assertNonEmpty('title', '')).message).toContain('title');
    expect(capture(() => assertNonEmpty('title', '   ')).message).toContain('title');
    expect(capture(() => assertNonEmpty('title', 5)).message).toContain('title');
  });

  it('allows an absent optional string but rejects a blank one', () => {
    expect(() => assertOptionalNonEmpty('body', undefined)).not.toThrow();
    expect(() => assertOptionalNonEmpty('body', 'text')).not.toThrow();
    expect(capture(() => assertOptionalNonEmpty('body', '')).message).toContain('body');
  });

  it('enforces the allowed set in assertOneOf', () => {
    expect(() => assertOneOf('state', 'open', ['open', 'closed'] as const)).not.toThrow();
    const error = capture(() => assertOneOf('state', 'merged', ['open', 'closed'] as const));
    expect(error.message).toContain('merged');
  });

  it('accepts string and number native ids', () => {
    expect(() => assertNativeId('number', 'IEXA01')).not.toThrow();
    expect(() => assertNativeId('number', 205)).not.toThrow();
    expect(() => assertNativeId('number', '205')).not.toThrow();
  });

  it('rejects invalid native ids', () => {
    expect(capture(() => assertNativeId('number', '')).message).toContain('number');
    expect(capture(() => assertNativeId('number', Number.NaN)).message).toContain('number');
    expect(capture(() => assertNativeId('number', null)).message).toContain('number');
  });

  it('requires a positive integer where one is expected', () => {
    expect(() => assertPositiveInt('number', 1)).not.toThrow();
    expect(capture(() => assertPositiveInt('number', 0)).message).toContain('positive');
    expect(capture(() => assertPositiveInt('number', 1.5)).message).toContain('positive');
    expect(capture(() => assertPositiveInt('number', '1')).message).toContain('positive');
  });

  it('allows an absent optional positive integer', () => {
    expect(() => assertOptionalPositiveInt('milestone', undefined)).not.toThrow();
    expect(() => assertOptionalPositiveInt('milestone', 3)).not.toThrow();
    expect(capture(() => assertOptionalPositiveInt('milestone', 0)).message).toContain('milestone');
  });

  it('requires owner and repo in a repo reference', () => {
    expect(() => assertRepoRef({ owner: 'o', repo: 'r' })).not.toThrow();
    expect(capture(() => assertRepoRef({ owner: '', repo: 'r' })).message).toContain('owner');
    expect(capture(() => assertRepoRef({ owner: 'o' })).message).toContain('repo');
    expect(capture(() => assertRepoRef(null)).message).toContain('owner/repo');
  });

  it('validates optional string arrays element-wise', () => {
    expect(() => assertStringArray('labels', undefined)).not.toThrow();
    expect(() => assertStringArray('labels', ['bug', 'docs'])).not.toThrow();
    expect(capture(() => assertStringArray('labels', 'bug')).message).toContain('labels');
    expect(capture(() => assertStringArray('labels', ['bug', 2])).message).toContain('entry 1');
    expect(capture(() => assertStringArray('labels', [''])).message).toContain('entry 0');
  });

  it('requires at least one entry where a non-empty array is required', () => {
    expect(() => assertNonEmptyStringArray('files', ['a'])).not.toThrow();
    expect(capture(() => assertNonEmptyStringArray('files', [])).message).toContain('at least one');
    expect(capture(() => assertNonEmptyStringArray('files', 'a')).message).toContain('files');
  });

  it('rejects path separators in an owner or org name', () => {
    expect(() => assertPathSegment('owner', 'example-org')).not.toThrow();
    expect(capture(() => assertPathSegment('owner', 'a/b')).message).toContain('owner');
    expect(capture(() => assertPathSegment('owner', 'a?b')).message).toContain('owner');
  });

  it('accepts relative file paths and rejects traversal', () => {
    expect(() => assertFilePath('path', 'src/index.ts')).not.toThrow();
    expect(() => assertFilePath('path', '.github/workflows/ci.yml')).not.toThrow();
    expect(capture(() => assertFilePath('path', '../secret')).message).toContain('..');
    expect(capture(() => assertFilePath('path', '/etc/passwd')).message).toContain('path');
    expect(capture(() => assertFilePath('path', '')).message).toContain('path');
  });

  it('caps maxPages at the documented limit', () => {
    expect(MAX_PAGES_LIMIT).toBe(100);
    expect(() => assertMaxPages(undefined)).not.toThrow();
    expect(() => assertMaxPages(MAX_PAGES_LIMIT)).not.toThrow();
    expect(capture(() => assertMaxPages(MAX_PAGES_LIMIT + 1)).message).toContain('maxPages');
    expect(capture(() => assertMaxPages(0)).message).toContain('maxPages');
  });

  it('requires a plain object for a parameter bag', () => {
    expect(() => assertParamsObject({}, 'listIssues')).not.toThrow();
    const error = capture(() => assertParamsObject([], 'listIssues'));
    expect(error.message).toContain('listIssues');
  });
});

describe('validator messages stay bounded', () => {
  it('truncates a long offending value instead of echoing it whole', () => {
    const long = 'x'.repeat(500);
    const error = capture(() => assertPathSegment('owner', `${long}?q`));
    expect(error.message).toContain('owner');
    expect(error.message.length).toBeLessThan(200);
  });
});
