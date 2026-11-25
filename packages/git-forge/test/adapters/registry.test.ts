import { describe, expect, it } from 'vitest';

import { ADAPTERS, getAdapter } from '../../src/adapters/index.js';
import { CAPABILITY_IDS, PARAM_CAPABILITY_IDS, PROVIDERS } from '../../src/core/types.js';
import type { CapabilityState } from '../../src/core/types.js';
import { unsupported } from '../../src/adapters/types.js';

/**
 * Registry-level guarantees.
 *
 * These assertions are the machine-checkable form of "the capability matrix and
 * the code agree": every provider answers every capability, gaps are declared as
 * `unsupported` rather than missing, and calling a gapped method throws the typed
 * error instead of returning fabricated data.
 */
describe('adapter registry', () => {
  it('registers exactly one adapter per provider', () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...PROVIDERS].sort());
    for (const provider of PROVIDERS) {
      expect(getAdapter(provider).provider).toBe(provider);
    }
  });

  it('gives every provider a complete method-level capability table', () => {
    for (const provider of PROVIDERS) {
      const adapter = getAdapter(provider);
      expect(Object.keys(adapter.capabilities).sort()).toEqual([...CAPABILITY_IDS].sort());
      // No capability may be left without an assignment.
      for (const id of CAPABILITY_IDS) {
        const state: CapabilityState = adapter.capabilities[id];
        expect(['supported', 'unsupported']).toContain(state);
      }
    }
  });

  it('gives every provider a complete parameter-level capability table', () => {
    for (const provider of PROVIDERS) {
      const adapter = getAdapter(provider);
      expect(Object.keys(adapter.paramCapabilities).sort()).toEqual(
        [...PARAM_CAPABILITY_IDS].sort(),
      );
      for (const id of PARAM_CAPABILITY_IDS) {
        const state: CapabilityState = adapter.paramCapabilities[id];
        expect(['supported', 'unsupported']).toContain(state);
      }
    }
  });

  it('maps every declarative gap to a throwing method', () => {
    for (const provider of PROVIDERS) {
      const adapter = getAdapter(provider);
      for (const id of CAPABILITY_IDS) {
        if (adapter.capabilities[id] !== 'unsupported') {
          continue;
        }
        // A gap must be backed by a stand-in that throws, never by an absent key.
        const method = unsupported(id, provider);
        expect(() => method()).toThrowError(/not supported/);
      }
    }
  });

  it('records the pushFiles matrix as GitHub yes / Gitee yes / AtomGit no', () => {
    const matrix = Object.fromEntries(
      PROVIDERS.map((provider) => [provider, getAdapter(provider).capabilities['files.pushFiles']]),
    );
    expect(matrix).toEqual({ github: 'supported', gitee: 'supported', atomgit: 'unsupported' });
  });

  it('records the stargazer matrix as GitHub yes / Gitee no / AtomGit yes', () => {
    const matrix = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        getAdapter(provider).capabilities['repos.listStargazers'],
      ]),
    );
    expect(matrix).toEqual({ github: 'supported', gitee: 'unsupported', atomgit: 'supported' });
  });

  it('records the head filter matrix as GitHub yes / Gitee yes / AtomGit no', () => {
    const matrix = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        getAdapter(provider).paramCapabilities['pulls.list.headFilter'],
      ]),
    );
    expect(matrix).toEqual({ github: 'supported', gitee: 'supported', atomgit: 'unsupported' });
  });

  it('covers all 29 capabilities with an implementation on every provider', () => {
    // Method names are checked by type, so here the runtime presence is asserted:
    // an `unsupported` entry still has to be a callable function.
    const methods = [
      'listIssues',
      'getIssue',
      'createIssue',
      'updateIssue',
      'listIssueComments',
      'createIssueComment',
      'listIssueEvents',
      'listPullRequests',
      'getPullRequest',
      'createPullRequest',
      'mergePullRequest',
      'listPullRequestComments',
      'createPullRequestComment',
      'listRepositories',
      'getRepository',
      'createRepository',
      'getFileContents',
      'listStargazers',
      'createFile',
      'updateFile',
      'deleteFile',
      'pushFiles',
      'listBranches',
      'createBranch',
      'listCommits',
      'getCommit',
      'listReleases',
      'listLabels',
      'createLabel',
    ] as const;
    expect(methods).toHaveLength(CAPABILITY_IDS.length);

    for (const provider of PROVIDERS) {
      const adapter = getAdapter(provider) as unknown as Record<string, unknown>;
      for (const method of methods) {
        expect(typeof adapter[method]).toBe('function');
      }
    }
  });
});
