import { tryInstantNanos } from '../core/validate.js';
import type { IssueEvent } from '../core/types.js';

/**
 * Identity key for a raw timeline entry, used for cross-page deduplication.
 *
 * Only a native `id` proves two entries are the same event, so only it is used.
 * An entry without one gets a unique key and is therefore never merged: the
 * timeline mixes dozens of event kinds, several omit the id, and a synthetic
 * `(event, time, label)` key cannot tell `labeled` → `unlabeled` → `labeled`
 * inside one second apart. Merging those drops a real mutation and inverts the
 * resulting label state, which is a worse outcome than reporting a duplicate the
 * platform itself sent twice.
 */
export function eventKeyOf(): (raw: unknown) => string {
  let anonymous = 0;
  return (raw: unknown): string => {
    const record = raw as Record<string, unknown> | null | undefined;
    const id = record?.id;
    if (typeof id === 'string' && id.length > 0) {
      return `id:${id}`;
    }
    if (typeof id === 'number' && Number.isFinite(id)) {
      return `id:${String(id)}`;
    }
    anonymous += 1;
    return `anonymous:${anonymous}`;
  };
}

/**
 * Sorts label events oldest-first, stably.
 *
 * Every platform serves these timestamps in an order this library cannot rely on:
 * GitHub's timeline is newest-first per page but the merge point between pages is
 * not guaranteed to stay ordered, and the Gitee/AtomGit operation log is requested
 * `desc` yet the endpoint's ordering is not contractual. A caller replaying the
 * timeline needs chronological order, so the retrieved set is sorted here.
 *
 * Two details matter:
 *
 * - the comparison parses the instant rather than the string, so `+08:00` and `Z`
 *   forms of the same moment compare equal instead of sorting by their spelling;
 * - the sort is stable and an unparseable timestamp sorts last in its original
 *   position, because inventing a time for it would reorder real events around it.
 */
export function sortEventsOldestFirst(events: readonly IssueEvent[]): IssueEvent[] {
  return events
    .map((event, index) => ({ event, index, at: tryInstantNanos(event.created_at) }))
    .sort((left, right) => {
      if (left.at === undefined && right.at === undefined) {
        return left.index - right.index;
      }
      if (left.at === undefined) {
        return 1;
      }
      if (right.at === undefined) {
        return -1;
      }
      if (left.at === right.at) {
        return left.index - right.index;
      }
      return left.at < right.at ? -1 : 1;
    })
    .map(({ event }) => event);
}
