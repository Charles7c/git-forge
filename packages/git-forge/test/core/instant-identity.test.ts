import { describe, expect, it } from 'vitest';

import { buildCommitAuthor, readGitAuthor } from '../../src/adapters/commit-author.js';
import { GitForgeError } from '../../src/core/errors.js';
import {
  assertOptionalIsoInstant,
  instantNanos,
  tryInstantNanos,
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

describe('assertOptionalIsoInstant · UTC offsets', () => {
  it('accepts every offset a zone can actually have', () => {
    for (const value of [
      '2026-11-01T00:00:00Z',
      '2026-11-01T00:00:00+00:00',
      '2026-11-01T00:00:00-00:00',
      '2026-11-01T00:00:00+14:00',
      '2026-11-01T00:00:00-12:00',
      '2026-11-01T00:00:00+23:59',
    ]) {
      expect(() => assertOptionalIsoInstant('since', value), value).not.toThrow();
    }
  });

  it('rejects an out-of-range hour and an out-of-range minute separately', () => {
    // `+00:60` is 60 minutes, so a combined-total check would let it through.
    const minute = capture(() => assertOptionalIsoInstant('since', '2026-11-01T00:00:00+00:60'));
    expect(minute.code).toBe('INVALID_ARGUMENT');
    expect(minute.message).toContain('minute');

    const hour = capture(() => assertOptionalIsoInstant('since', '2026-11-01T00:00:00+24:00'));
    expect(hour.code).toBe('INVALID_ARGUMENT');
    expect(hour.message).toContain('hour');
  });

  it('rejects a zone-less or bare-date value', () => {
    for (const value of ['2026-11-01T00:00:00', '2026-11-01', 'yesterday', '']) {
      expect(capture(() => assertOptionalIsoInstant('since', value)).code, value).toBe(
        'INVALID_ARGUMENT',
      );
    }
  });
});

describe('assertOptionalIsoInstant · calendar', () => {
  it('accepts real leap days and rejects fake ones', () => {
    expect(() => assertOptionalIsoInstant('since', '2028-02-29T00:00:00Z')).not.toThrow();
    expect(() => assertOptionalIsoInstant('since', '2000-02-29T00:00:00Z')).not.toThrow();
    expect(capture(() => assertOptionalIsoInstant('since', '1900-02-29T00:00:00Z')).code).toBe(
      'INVALID_ARGUMENT',
    );
    expect(capture(() => assertOptionalIsoInstant('since', '2026-02-29T00:00:00Z')).code).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('bounds the day by the month length', () => {
    for (const value of ['2026-04-31T00:00:00Z', '2026-06-31T00:00:00Z', '2026-01-00T00:00:00Z']) {
      expect(capture(() => assertOptionalIsoInstant('since', value)).code, value).toBe(
        'INVALID_ARGUMENT',
      );
    }
    expect(() => assertOptionalIsoInstant('since', '2026-01-31T00:00:00Z')).not.toThrow();
  });

  it('rejects an out-of-range clock field', () => {
    for (const value of ['2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z']) {
      expect(capture(() => assertOptionalIsoInstant('since', value)).code, value).toBe(
        'INVALID_ARGUMENT',
      );
    }
  });
});

describe('instantNanos · four-digit years', () => {
  it('treats 0099 as the first century, not 1999', () => {
    // `Date.UTC(99, 0, 1)` is 1999-01-01; the ordering compare must not inherit
    // that. One century is ~36524 days, so the gap is unmistakable.
    const day = 86_400n * 1_000_000_000n;
    const gap = (instantNanos('0100-01-01T00:00:00Z') - instantNanos('0099-01-01T00:00:00Z')) / day;
    expect(gap).toBe(365n);
    expect(instantNanos('0001-01-01T00:00:00Z')).toBeLessThan(instantNanos('0099-01-01T00:00:00Z'));
  });

  it('matches Date for years where the two-digit rule does not apply', () => {
    for (const value of ['1900-01-01T00:00:00Z', '2026-11-25T02:54:10Z', '2999-12-31T23:59:59Z']) {
      const expected = BigInt(Date.parse(value)) * 1_000_000n;
      // Date.parse truncates the sub-millisecond digits these values do not have.
      expect(instantNanos(value), value).toBe(expected);
    }
  });

  it('keeps all nine fractional digits', () => {
    const base = instantNanos('2026-11-01T00:00:00Z');
    expect(instantNanos('2026-11-01T00:00:00.000000001Z') - base).toBe(1n);
    expect(instantNanos('2026-11-01T00:00:00.999999999Z') - base).toBe(999_999_999n);
  });

  it('applies the offset in the correct direction', () => {
    expect(instantNanos('2026-11-01T08:00:00+08:00')).toBe(instantNanos('2026-11-01T00:00:00Z'));
    expect(instantNanos('2026-10-31T16:00:00-08:00')).toBe(instantNanos('2026-11-01T00:00:00Z'));
  });

  it('throws rather than guessing for a value it cannot parse', () => {
    expect(capture(() => instantNanos('not a timestamp')).code).toBe('INVALID_ARGUMENT');
  });

  it('answers undefined through the non-throwing variant', () => {
    expect(tryInstantNanos('not a timestamp')).toBeUndefined();
    expect(tryInstantNanos('2026-11-01T00:00:00Z')).toBe(instantNanos('2026-11-01T00:00:00Z'));
  });
});

describe('readGitAuthor · any one field is enough', () => {
  it('keeps an email that arrives without a name or date', () => {
    expect(readGitAuthor({ email: 'a@example.com' })).toEqual({
      name: '',
      email: 'a@example.com',
      date: '',
    });
  });

  it('keeps a date that arrives without a name', () => {
    expect(readGitAuthor({ date: '2026-01-01T00:00:00Z' })).toEqual({
      name: '',
      email: '',
      date: '2026-01-01T00:00:00Z',
    });
  });

  it('answers undefined only when the object states nothing', () => {
    expect(readGitAuthor({})).toBeUndefined();
    expect(readGitAuthor({ name: '', email: '', date: '' })).toBeUndefined();
    expect(readGitAuthor({ name: 7, email: null, date: false })).toBeUndefined();
  });
});

describe('buildCommitAuthor', () => {
  it('answers undefined when neither half says anything', () => {
    expect(buildCommitAuthor(undefined, undefined)).toBeUndefined();
  });

  it('produces a block from the account alone, with an empty name', () => {
    // The name must not be filled with the login: they are different facts.
    expect(buildCommitAuthor(undefined, { login: 'real' })).toEqual({
      name: '',
      email: '',
      date: '',
      user: { login: 'real' },
    });
  });

  it('keeps the git-side date when that is all the commit object stated', () => {
    // The date reaches the block through `readGitAuthor`, so an object carrying
    // only a date still produces one rather than being dropped.
    const gitAuthor = readGitAuthor({ date: '2026-01-01T00:00:00Z' });
    expect(buildCommitAuthor(gitAuthor, undefined)).toEqual({
      name: '',
      email: '',
      date: '2026-01-01T00:00:00Z',
    });
  });

  it('attaches the account to an existing git author block', () => {
    const gitAuthor = { name: 'A', email: 'a@example.com', date: '2026-01-01T00:00:00Z' };
    expect(buildCommitAuthor(gitAuthor, { login: 'real' })).toEqual({
      ...gitAuthor,
      user: { login: 'real' },
    });
  });
});
