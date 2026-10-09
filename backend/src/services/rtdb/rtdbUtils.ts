/**
 * rtdbUtils.ts
 *
 * Small helpers for writing safely to Firebase Realtime Database. The first three are the
 * same helpers JobForm Automator uses (services/career-suggestion/CareerDataStore.ts and
 * lib/server/interview-sessions.ts):
 *
 *   - stripUndefined(): RTDB rejects `undefined` anywhere in a value (synchronously, before any
 *     promise exists, so a `.catch()` never sees it). Every write goes through this.
 *   - assertSafeUid(): a uid is interpolated into database paths, so it must be one safe segment.
 *   - isSafeKey():     RTDB keys can't contain . # $ [ ] / or control characters.
 *
 * Values that come from users or third parties (job ids, Razorpay ids, idempotency keys) are
 * never used as keys directly unless they pass isSafeKey(); otherwise they are hashed.
 */

import crypto from 'node:crypto';

const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_KEY_CHARS = /[.#$[\]/\u0000-\u001F\u007F]/;

/** Defence in depth: a uid is interpolated into database paths, so it must be a single safe segment. */
export function assertSafeUid(uid: unknown): asserts uid is string {
  if (typeof uid !== 'string' || !SAFE_UID.test(uid)) {
    throw new Error('Unsafe uid for database path');
  }
}

/** True when `value` can be used as an RTDB key as-is. */
export function isSafeKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !UNSAFE_KEY_CHARS.test(value);
}

/** Throws unless `value` is a safe single RTDB key segment. */
export function assertSafeKey(value: unknown, label = 'key'): asserts value is string {
  if (!isSafeKey(value)) {
    throw new Error(`Unsafe ${label} for database path`);
  }
}

/** RTDB rejects `undefined` anywhere in a value — drop those keys before writing (JSON round-trip, as in JobForm Automator). */
export function stripUndefined<T>(value: T): T {
  if (value === undefined) return null as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable, key-safe digest of an arbitrary string (used for idempotency keys, job ids, etc.). */
export function hashKey(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 40);
}

/** Uses an externally supplied id as a key when it is already safe, otherwise a hash of it. */
export function keyForExternalId(value: string): string {
  return isSafeKey(value) && value.length <= 128 ? value : `h_${hashKey(value)}`;
}

/** Time-ordered, key-safe identifier: `<prefix>_<base36 ms><12 hex>`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

/** Converts a Date, ISO string or millisecond number to milliseconds (null when absent/invalid). */
export function toMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Converts stored milliseconds back to the ISO-8601 strings the API has always returned. */
export function toIso(value: unknown): string | null {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * RTDB stores arrays as objects keyed by index and drops empty arrays entirely, so a stored
 * array can come back as an array (possibly with holes), an index-keyed object, or nothing.
 */
export function toArray<T>(value: unknown): T[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : typeof value === 'object' ? Object.values(value as object) : [];
  return items.filter(item => item !== null && item !== undefined) as T[];
}

/** UTC calendar day (YYYY-MM-DD) — same format the CareerBrain daily quota has always used. */
export function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
