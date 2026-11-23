import { Buffer } from 'node:buffer';

import { invalidArgumentError } from './errors.js';
import type { HttpClient, HttpResponse } from './http.js';
import type { ContentEncoding, Provider } from './types.js';

/** Converts user content to the canonical base64 required by contents endpoints. */
export function contentsBase64(
  content: string,
  encoding: ContentEncoding = 'utf8',
  provider: Provider,
): string {
  if (encoding === 'utf8') return Buffer.from(content, 'utf8').toString('base64');
  // Buffer's decoder silently ignores invalid characters. Compare the canonical
  // representation before accepting pre-encoded input, including its padding.
  const compact = content.replace(/\s+/g, '');
  const canonical = Buffer.from(compact, 'base64').toString('base64');
  if (
    encoding !== 'base64' ||
    (compact !== canonical && compact !== canonical.replace(/=+$/, ''))
  ) {
    throw invalidArgumentError('Invalid `content`: expected base64', provider);
  }
  return canonical;
}

/** A success status alone does not confirm which commit or object was written. */
export function confirmedSha(http: HttpClient, response: HttpResponse, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw http.invalidResponse(response, 'The provider response did not confirm a Git object SHA');
  }
  return value;
}
