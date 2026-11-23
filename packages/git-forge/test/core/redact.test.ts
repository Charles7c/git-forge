import { describe, expect, it } from 'vitest';

import { REDACTED, isSensitiveKey, redactUrl, scrubSecrets } from '../../src/core/redact.js';

const TOKEN = ['fixture', 'token', 'not', 'a', 'credential'].join('-');

describe('redactUrl', () => {
  it('masks an access_token query value', () => {
    expect(redactUrl(`https://gitee.com/api/v5/repos?access_token=${TOKEN}`)).toBe(
      'https://gitee.com/api/v5/repos?access_token=***',
    );
  });

  it('masks access_token while preserving other parameters', () => {
    expect(
      redactUrl(`https://gitee.com/api/v5/repos?page=2&access_token=${TOKEN}&per_page=100`),
    ).toBe('https://gitee.com/api/v5/repos?page=2&access_token=***&per_page=100');
  });

  it('masks the bare token parameter', () => {
    expect(redactUrl(`https://example.test/path?token=${TOKEN}`)).toBe(
      'https://example.test/path?token=***',
    );
  });

  it('is case-insensitive on the parameter name', () => {
    expect(redactUrl(`https://example.test/p?Access_Token=${TOKEN}`)).toBe(
      'https://example.test/p?Access_Token=***',
    );
  });

  it('leaves URLs without secrets untouched', () => {
    const url = 'https://api.github.com/repos/owner/repo/issues?state=all&page=1';
    expect(redactUrl(url)).toBe(url);
  });

  it('does not treat an unrelated token-like word as a secret parameter', () => {
    const url = 'https://example.test/p?tokenizer=abc';
    expect(redactUrl(url)).toContain('tokenizer=abc');
  });

  it('returns empty and non-URL input unchanged', () => {
    expect(redactUrl('')).toBe('');
    expect(redactUrl('not a url')).toBe('not a url');
  });

  it('masks a non-query token assignment in free text', () => {
    expect(redactUrl(`x-access-token: ${TOKEN}`)).not.toContain(TOKEN);
  });
});

describe('scrubSecrets', () => {
  it('removes a known literal token wherever it appears', () => {
    const text = `before ${TOKEN} after ${TOKEN}`;
    const result = scrubSecrets(text, [TOKEN]);
    expect(result).not.toContain(TOKEN);
    expect(result.match(/\*\*\*/g)).toHaveLength(2);
  });

  it('removes an access_token assignment without needing the literal', () => {
    const result = scrubSecrets(`https://gitee.com/api/v5/repos?access_token=${TOKEN}&x=1`);
    expect(result).not.toContain(TOKEN);
    expect(result).toContain('access_token=***');
  });

  it('replaces the longer token first when one is a prefix of another', () => {
    const short = 'abcdef';
    const long = 'abcdef123456';
    const result = scrubSecrets(`value ${long}`, [short, long]);
    expect(result).not.toContain('123456');
  });

  it('ignores empty and non-string secrets so an unset token cannot blank text', () => {
    expect(scrubSecrets('keep this', ['', '   '])).toBe('keep this');
    expect(scrubSecrets('keep this', [])).toBe('keep this');
  });

  it('is a no-op for empty input', () => {
    expect(scrubSecrets('', [TOKEN])).toBe('');
  });

  it('scrubs an Authorization header echoed into a message', () => {
    const result = scrubSecrets(`Authorization: Bearer ${TOKEN}`);
    expect(result).not.toContain(TOKEN);
  });

  it('uses the documented placeholder', () => {
    expect(REDACTED).toBe('***');
  });
});

describe('isSensitiveKey', () => {
  it('recognizes the two secret query keys case-insensitively', () => {
    expect(isSensitiveKey('access_token')).toBe(true);
    expect(isSensitiveKey('ACCESS_TOKEN')).toBe(true);
    expect(isSensitiveKey('token')).toBe(true);
  });

  it('does not flag ordinary keys', () => {
    expect(isSensitiveKey('page')).toBe(false);
    expect(isSensitiveKey('per_page')).toBe(false);
    expect(isSensitiveKey('tokenizer')).toBe(false);
  });
});
