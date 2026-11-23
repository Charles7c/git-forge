import { invalidArgumentError } from '../../core/errors.js';
import type { HttpClient, HttpResponse } from '../../core/http.js';
import { asRecord, type PushPlanEntry } from './map.js';

type FileMode = '100644' | '100755';

/** Resolves each action against the pinned parent tree before any objects are written. */
export function resolveFileModes(
  http: HttpClient,
  response: HttpResponse,
  entries: readonly PushPlanEntry[],
): FileMode[] {
  const tree = asRecord(response.json);
  if (tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw http.invalidResponse(response, 'Cannot plan file changes without a complete Git tree');
  }
  const index = new Map<string, Record<string, unknown>>();
  for (const raw of tree.tree) {
    const item = asRecord(raw);
    if (typeof item.path !== 'string' || !item.path || index.has(item.path)) {
      throw http.invalidResponse(response, 'Ambiguous entries in the parent Git tree');
    }
    index.set(item.path, item);
  }
  const planned = new Set(entries.map(({ path }) => path));
  if (planned.size !== entries.length)
    throw invalidArgumentError('Duplicate paths in file batch', 'github');
  return entries.map(({ path, action }) => {
    let ancestor = path;
    while (ancestor.includes('/')) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
      const item = index.get(ancestor);
      if (planned.has(ancestor) || (item && item.type !== 'tree')) {
        throw invalidArgumentError('A parent path conflicts with a file change', 'github');
      }
    }
    const old = index.get(path);
    if (action === 'create' && !old) return '100644';
    if (!old || action === 'create')
      throw invalidArgumentError('File existence does not match the requested action', 'github');
    if (old.type !== 'blob' || (old.mode !== '100644' && old.mode !== '100755')) {
      throw invalidArgumentError('Only regular files can be updated or deleted', 'github');
    }
    return old.mode;
  });
}
