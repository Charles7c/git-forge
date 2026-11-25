/**
 * Local parameter validation and the write-capability set.
 *
 * Validation runs before any network access, so a bad call costs zero quota and
 * produces an `INVALID_ARGUMENT` that names the offending field.
 */
import { invalidArgumentError } from './errors.js';
import { MAX_PAGES_LIMIT } from './paginate.js';
import { CAPABILITY_IDS, PROVIDERS } from './types.js';
import type { CapabilityId, Provider } from './types.js';

/**
 * Capabilities that mutate remote state: 13 of the 29.
 *
 * Declared as a static set rather than inferred from the HTTP verb because the
 * facade's read-only gate must be decidable before dispatch. A test asserts that
 * every entry is a real capability and that the count is exactly 13, so adding a
 * write method without registering it here fails CI.
 */
export const WRITE_CAPABILITIES: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
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
  'labels.create',
]);

/** Returns `true` when a capability mutates remote state. */
export function isWriteCapability(capability: CapabilityId): boolean {
  return WRITE_CAPABILITIES.has(capability);
}

/** Thrown-value factory shared by every validator below. */
function invalid(field: string, reason: string, provider?: Provider): never {
  throw invalidArgumentError(`Invalid \`${field}\`: ${reason}`, provider);
}

/** Asserts a value is one of {@link PROVIDERS}. */
export function assertProvider(value: unknown): asserts value is Provider {
  if (typeof value !== 'string' || !(PROVIDERS as readonly string[]).includes(value)) {
    invalid('provider', `expected one of ${PROVIDERS.join(' | ')}, received ${describe(value)}`);
  }
}

/** Asserts a value is a non-empty trimmed string. */
export function assertNonEmpty(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    invalid(field, `expected a string, received ${describe(value)}`);
  }
  if (value.trim().length === 0) {
    invalid(field, 'must not be empty');
  }
}

/** Asserts a value is an optional non-empty string, when present. */
export function assertOptionalNonEmpty(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  assertNonEmpty(field, value);
}

/** Asserts a value is one of a fixed set of allowed strings. */
export function assertOneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(field, `expected one of ${allowed.join(' | ')}, received ${describe(value)}`);
  }
}

/** Asserts a value is either a string or a number, as issue identifiers may be. */
export function assertNativeId(field: string, value: unknown): void {
  if (typeof value === 'string') {
    assertPathSegment(field, value);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(field, `expected a string or a finite number, received ${describe(value)}`);
  }
}

/** Asserts a value is a positive integer. */
export function assertPositiveInt(field: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(field, `expected a positive integer, received ${describe(value)}`);
  }
}

/** Asserts a value is a non-negative integer. */
export function assertNonNegativeInt(field: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid(field, `expected a non-negative integer, received ${describe(value)}`);
  }
}

/** Asserts a value is an optional positive integer, when present. */
export function assertOptionalPositiveInt(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  assertPositiveInt(field, value);
}

/** Asserts a value is a non-empty `{ owner, repo }` reference. */
export function assertRepoRef(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    invalid('owner/repo', `expected an object with owner and repo, received ${describe(value)}`);
  }
  const ref = value as { owner?: unknown; repo?: unknown };
  assertPathSegment('owner', ref.owner);
  assertPathSegment('repo', ref.repo);
}

/** Asserts a value is an optional array of non-empty strings. */
export function assertStringArray(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    invalid(field, `expected an array of strings, received ${describe(value)}`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      invalid(field, `entry ${index} must be a string, received ${describe(entry)}`);
    }
    if (entry.trim().length === 0) {
      invalid(field, `entry ${index} must not be empty`);
    }
  });
}

/** Asserts a value is an optional string, without a non-empty requirement. */
export function assertOptionalString(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string') {
    invalid(field, `expected a string, received ${describe(value)}`);
  }
}

/** Asserts a value is an optional boolean. */
export function assertOptionalBoolean(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'boolean') {
    invalid(field, `expected a boolean, received ${describe(value)}`);
  }
}

/** Asserts a value is an optional string constrained to a fixed set. */
export function assertOptionalOneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): void {
  if (value === undefined) {
    return;
  }
  assertOneOf(field, value, allowed);
}

/** Asserts a value is an optional non-empty array of non-empty strings. */
export function assertNonEmptyStringArray(field: string, value: unknown): void {
  if (!Array.isArray(value)) {
    invalid(field, `expected a non-empty array, received ${describe(value)}`);
  }
  if (value.length === 0) {
    invalid(field, 'must contain at least one entry');
  }
  assertStringArray(field, value);
}

/** Asserts a value is an organization/user login usable as a path segment. */
export function assertPathSegment(field: string, value: unknown): void {
  assertNonEmpty(field, value);
  if (unsafeSegment(value) || /[/\\?#]/.test(value)) {
    invalid(field, 'must not contain path separators or query characters');
  }
}

/** Asserts a value is an optional path-segment-safe login. */
export function assertOptionalPathSegment(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  assertPathSegment(field, value);
}

/**
 * Matches an ISO 8601 date-time with an explicit zone, capturing every part.
 *
 * A trailing `Z` or a `±hh:mm` offset is required: the three platforms compare
 * the bound against their own stored timestamps, and a zone-less string would be
 * read as local time by one and as UTC by another. The parts are captured
 * because both the calendar check and the precision-preserving ordering compare
 * need them individually.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Asserts a value is an ISO 8601 instant usable as a server-side bound.
 *
 * Only absolute instants are accepted, and the calendar date must exist: a bare
 * date or a relative phrase would be interpreted differently by each platform,
 * and an impossible date such as `2026-02-30` or `2026-13-01` would otherwise be
 * silently rolled over into a window the caller never asked for.
 *
 * The UTC offset is checked as an hour **and** a minute field. Testing the total
 * (`|hh*60+mm| <= 23:59`) accepts `+00:60`, which is not a valid offset: RFC 3339
 * bounds the minute field by 59, and a platform that parses it as an hour-and-a-
 * half of drift would compare the bound against a different instant than the
 * caller wrote.
 */
export function assertOptionalIsoInstant(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string') {
    invalid(field, `expected an ISO 8601 string, received ${describe(value)}`);
  }
  const parts = parseInstant(value);
  if (parts === undefined) {
    invalid(field, 'expected an ISO 8601 date-time such as 2026-01-31T00:00:00Z');
  }
  if (!existsOnCalendar(parts)) {
    invalid(field, 'is not a real calendar date-time');
  }
  if (parts.offsetHour !== undefined && parts.offsetHour > 23) {
    invalid(field, 'has an out-of-range UTC offset hour');
  }
  if (parts.offsetMinute !== undefined && parts.offsetMinute > 59) {
    invalid(field, 'has an out-of-range UTC offset minute');
  }
}

/** An instant decomposed into the parts the validator and ordering compare need. */
interface InstantParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fractional digits exactly as written, without the leading dot. */
  fraction: string;
  /** Offset in minutes east of UTC; `undefined` for a `Z` suffix. */
  offsetMinutes?: number;
  /** Offset hour field as written, kept apart so `+00:60` can be rejected. */
  offsetHour?: number;
  /** Offset minute field as written. */
  offsetMinute?: number;
}

/** Decomposes an ISO 8601 instant, or returns `undefined` when it does not match. */
function parseInstant(value: string): InstantParts | undefined {
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, fraction, sign, offHour, offMinute] = match;
  const parts: InstantParts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? '0'),
    fraction: fraction ?? '',
  };
  if (sign !== undefined) {
    const offsetHour = Number(offHour);
    const offsetMinute = Number(offMinute);
    parts.offsetHour = offsetHour;
    parts.offsetMinute = offsetMinute;
    const offset = offsetHour * 60 + offsetMinute;
    parts.offsetMinutes = sign === '-' ? -offset : offset;
  }
  return parts;
}

/**
 * Whether the parts name a date that exists.
 *
 * `Date` is deliberately not used: besides normalizing an impossible date (Feb 30
 * becomes Mar 2), `Date.UTC` applies the two-digit-year rule, so year `0099`
 * becomes 1999 and the ordering compare would place a first-century bound after a
 * twentieth-century one. The day count is bounded by the month's own length.
 */
function existsOnCalendar(parts: InstantParts): boolean {
  if (parts.year < 0) return false;
  if (parts.month < 1 || parts.month > 12) return false;
  if (parts.day < 1 || parts.day > daysInMonth(parts.year, parts.month)) return false;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return false;
  return true;
}

/** Days in a month, by the Gregorian leap-year rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Whether a Gregorian year has a leap day. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Days since 1970-01-01 for a Gregorian civil date.
 *
 * Howard Hinnant's `days_from_civil`, which is exact for every year and — unlike
 * `Date.UTC` — does not reinterpret years below 100. Only the day count is
 * needed; the time of day is added by the caller.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Nanoseconds since the epoch, at the precision the caller wrote.
 *
 * Comparing with `Date.parse` truncates to milliseconds, so two bounds that
 * differ only in the seventh, eighth or ninth fractional digit compare equal and
 * an inverted window slips past the ordering check. ISO 8601 allows up to nine
 * fractional digits, so the value is built as a `BigInt` from the matched parts
 * and every digit is kept; only its ordering is used.
 *
 * @param value An instant the validator already accepted.
 */
export function instantNanos(value: string): bigint {
  const nanos = tryInstantNanos(value);
  if (nanos === undefined) {
    // Unreachable after validation; a caller error rather than a platform one.
    throw invalidArgumentError(`Invalid instant: ${JSON.stringify(value)}`);
  }
  return nanos;
}

/**
 * Nanoseconds since the epoch, or `undefined` when the value is not a strict
 * ISO 8601 instant.
 *
 * Used where the value comes from upstream rather than from a caller (event
 * timestamps), so an unparseable one is reported instead of thrown.
 */
export function tryInstantNanos(value: string): bigint | undefined {
  const parts = parseInstant(value);
  if (parts === undefined) {
    return undefined;
  }
  const days = BigInt(daysFromCivil(parts.year, parts.month, parts.day));
  const secondsOfDay = BigInt(parts.hour * 3600 + parts.minute * 60 + parts.second);
  const nanos = BigInt(parts.fraction.padEnd(9, '0').slice(0, 9));
  const offset = BigInt(parts.offsetMinutes ?? 0) * 60n * 1_000_000_000n;
  return (days * 86_400n + secondsOfDay) * 1_000_000_000n + nanos - offset;
}

/** A segment must survive URL normalization without acquiring path syntax. */
function unsafeSegment(value: string): boolean {
  return (
    value === '' ||
    value === '.' ||
    value === '..' ||
    /%(?:2e|2f|5c|25)/i.test(value) ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}

/** Asserts a file path is a relative path without traversal segments. */
export function assertFilePath(field: string, value: unknown): asserts value is string {
  assertNonEmpty(field, value);
  const segments = value.split('/');
  if (segments.some(unsafeSegment) || value.includes('\\')) {
    invalid(field, 'must be a relative path and must not contain ".." segments');
  }
}

/** Asserts a value is an optional file path. */
export function assertOptionalFilePath(field: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  assertFilePath(field, value);
}

/** Asserts `maxPages` is within the documented hard cap. */
export function assertMaxPages(value: unknown): void {
  if (value === undefined) {
    return;
  }
  assertPositiveInt('maxPages', value);
  if (value > MAX_PAGES_LIMIT) {
    invalid('maxPages', `must be <= ${MAX_PAGES_LIMIT}`);
  }
}

/** Asserts a value is a plain object (used for the whole parameter bag). */
export function assertParamsObject(value: unknown, method: string): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${method} parameters`, `expected an object, received ${describe(value)}`);
  }
}

/** Asserts every key of {@link CAPABILITY_IDS} is present in a candidate table. */
export function assertCapabilityTableKeys(table: Readonly<Record<string, unknown>>): void {
  const expected = new Set<string>(CAPABILITY_IDS);
  const actual = Object.keys(table);
  const missing = [...expected].filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw invalidArgumentError(
      `Capability table must match CAPABILITY_IDS exactly (missing: [${missing.join(', ')}], ` +
        `unexpected: [${extra.join(', ')}])`,
    );
  }
}

/** The closed three-value action set of a `pushFiles` entry. */
export const PUSH_FILE_ACTIONS = ['create', 'update', 'delete'] as const;

/**
 * Asserts a label name.
 *
 * The platforms disagree about punctuation but agree that a name is non-empty
 * and carries no control characters; a leading `#` would also be read as a
 * colour by some clients, so it is refused.
 */
export function assertLabelName(field: string, value: unknown): asserts value is string {
  assertNonEmpty(field, value);
  if (value.startsWith('#')) {
    invalid(field, 'must not start with "#"');
  }
  if (Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    invalid(field, 'must not contain control characters');
  }
}

/**
 * Normalizes a label colour to `#rrggbb`.
 *
 * A 3-digit shorthand is expanded and any hex case is accepted; the result is
 * the form every model field uses, so a caller can compare colours without
 * knowing which platform answered.
 */
export function normalizeLabelColor(value: unknown): string {
  if (typeof value !== 'string') {
    invalid('color', `expected a hex colour such as #d73a4a, received ${describe(value)}`);
  }
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) {
    invalid('color', 'expected a 3- or 6-digit hex colour such as #d73a4a');
  }
  const hex = match[1] as string;
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : hex;
  return `#${expanded.toLowerCase()}`;
}
/** The encodings a `pushFiles` entry may declare. */
export const PUSH_FILE_ENCODINGS = ['utf8', 'base64'] as const;

/** The 64 base64 digits, spelled out so the alphabet cannot be misread. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Whether a string is a decodable base64 payload.
 *
 * Embedded whitespace is tolerated because Git accepts newline-wrapped base64.
 * Padding is allowed only as a trailing run of at most two `=`.
 */
export function isValidBase64Payload(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  const body = compact.replace(/={0,2}$/, '');
  if (body.length === 0 || body.length % 4 === 1) {
    return false;
  }
  for (const char of body) {
    if (!BASE64_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Asserts a `pushFiles` batch satisfies the closed contract.
 *
 * This is the facade-side gate: it runs before dispatch so a malformed batch
 * costs zero requests. Adapters repeat the same checks for direct callers, but
 * only the facade can guarantee "no HTTP on a bad payload" for every provider at
 * once — which is exactly what the four rejection cases below need.
 *
 * Rejected, all as `INVALID_ARGUMENT`:
 * - an empty batch (Gitee would create an empty commit);
 * - `action: 'delete'` carrying `content`;
 * - `action: 'create' | 'update'` without `content`;
 * - `encoding: 'base64'` with content that is not valid base64.
 */
export function assertPushFilesParams(params: unknown): void {
  assertParamsObject(params, 'pushFiles');
  const bag = params as Record<string, unknown>;
  assertNonEmpty('branch', bag.branch);
  assertNonEmpty('message', bag.message);

  const files = bag.files;
  if (!Array.isArray(files)) {
    invalid('files', `expected an array of file entries, received ${describe(files)}`);
  }
  if (files.length === 0) {
    invalid(
      'files',
      'pushFiles requires at least one entry (an empty batch would create an empty commit)',
    );
  }

  files.forEach((raw, index) => {
    const field = `files[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid(field, `expected an object, received ${describe(raw)}`);
    }
    const entry = raw as Record<string, unknown>;
    assertFilePath(`${field}.path`, entry.path);
    assertOneOf(`${field}.action`, entry.action, PUSH_FILE_ACTIONS);
    const encoding = entry.encoding ?? 'utf8';
    assertOneOf(`${field}.encoding`, encoding, PUSH_FILE_ENCODINGS);

    if (entry.action === 'delete') {
      if (entry.content !== undefined) {
        invalid(field, `action 'delete' must not carry content`);
      }
      return;
    }

    if (typeof entry.content !== 'string') {
      invalid(`${field}.content`, `action '${entry.action}' requires content`);
    }
    if (encoding === 'base64' && !isValidBase64Payload(entry.content)) {
      invalid(`${field}.content`, 'not a valid base64 payload');
    }
  });
}

/** Renders a value for an error message without leaking large payloads. */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value.length === 0 ? 'an empty string' : `"${truncate(value)}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `an array of length ${value.length}`;
  }
  return typeof value;
}

/** Shortens quoted values in messages so a pasted blob cannot flood stderr. */
function truncate(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 60)}…`;
}
