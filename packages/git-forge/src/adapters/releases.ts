/**
 * Release ordering shared by the three adapters.
 *
 * The contract promises newest-first, but only GitHub actually sends releases in
 * that order. Gitee and AtomGit need an explicit `direction=desc`, and even then
 * a caller cannot rely on it: measured pages from a live repository came back
 * with a November release *after* a February one once pagination was merged.
 *
 * So the adapters sort the entries they actually retrieved. That is a bounded,
 * honest promise — it does not claim the full set was fetched, only that what was
 * returned is ordered — and it costs no extra request.
 */
import type { Release } from '../core/types.js';

/**
 * Sorts releases newest-first by their reported time.
 *
 * Entries with no timestamp go last, in their original relative order: they
 * cannot be placed on the timeline, and dropping them would hide a release. The
 * sort is stable, so equal timestamps keep platform order.
 *
 * @param releases Entries as mapped, in whatever order the platform sent them.
 * @returns A new array; the input is not mutated.
 */
export function sortReleasesNewestFirst(releases: readonly Release[]): Release[] {
  return [...releases].sort((left, right) => {
    const leftTime = releaseTime(left);
    const rightTime = releaseTime(right);
    if (leftTime === undefined && rightTime === undefined) {
      return 0;
    }
    if (leftTime === undefined) {
      return 1;
    }
    if (rightTime === undefined) {
      return -1;
    }
    return rightTime - leftTime;
  });
}

/**
 * Reads a release's sortable time in milliseconds.
 *
 * `published_at` is already the platform's best available timestamp: GitHub
 * sends a real publication time, while Gitee and AtomGit only send a creation
 * time, which the mapper stores in the same field.
 */
function releaseTime(release: Release): number | undefined {
  if (release.published_at === undefined) {
    return undefined;
  }
  const parsed = Date.parse(release.published_at);
  return Number.isNaN(parsed) ? undefined : parsed;
}
