import type { Issue } from './types.js';

/** Keeps the native text intact and adds a numeric alias only for safely representable digits. */
export function issueNumberFields(number: string): Pick<Issue, 'number' | 'number_as_number'> {
  if (/^\d+$/.test(number)) {
    const numeric = Number(number);
    if (Number.isSafeInteger(numeric)) {
      return { number, number_as_number: numeric };
    }
  }
  return { number };
}
