/**
 * Civil market dates (YYYY-MM-DD) with pure UTC arithmetic.
 * No implicit local timezone, no implicit "now".
 */

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86400000;

/**
 * @param {string} s
 * @returns {boolean}
 */
export function isValidCivilDate(s) {
  if (typeof s !== 'string') return false;
  const m = CIVIL_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * @param {string} s
 * @returns {string} the same date, validated
 */
export function assertCivilDate(s) {
  if (!isValidCivilDate(s)) {
    throw new Error(`Invalid civil date: ${JSON.stringify(s)} (expected YYYY-MM-DD)`);
  }
  return s;
}

/**
 * Days since 1970-01-01 (UTC).
 * @param {string} s civil date
 * @returns {number}
 */
export function toEpochDay(s) {
  assertCivilDate(s);
  const m = CIVIL_RE.exec(s);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY);
}

/**
 * @param {number} epochDay
 * @returns {string} civil date
 */
export function fromEpochDay(epochDay) {
  if (!Number.isInteger(epochDay)) throw new Error(`epochDay must be an integer, got ${epochDay}`);
  const dt = new Date(epochDay * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * Lexical-safe comparator (both dates validated).
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero or positive
 */
export function compareCivilDate(a, b) {
  assertCivilDate(a);
  assertCivilDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {string} s civil date
 * @param {number} n days to add (may be negative)
 * @returns {string}
 */
export function addDays(s, n) {
  return fromEpochDay(toEpochDay(s) + n);
}

/**
 * Day of week, 0 = Sunday ... 6 = Saturday. Pure UTC arithmetic.
 * @param {string} s civil date
 * @returns {number}
 */
export function dayOfWeek(s) {
  // 1970-01-01 was a Thursday (4).
  return ((toEpochDay(s) % 7) + 7 + 4) % 7;
}

/**
 * ISO-8601 week key, zero padded so string comparison equals chronological
 * comparison, e.g. "2026-W05".
 * @param {string} s civil date
 * @returns {string}
 */
export function isoWeekKey(s) {
  const epoch = toEpochDay(s);
  const dow = dayOfWeek(s); // 0=Sun..6=Sat
  // ISO: Monday=1..Sunday=7
  const isoDow = dow === 0 ? 7 : dow;
  // Thursday of the same ISO week decides the ISO year.
  const thursday = epoch + (4 - isoDow);
  const thuDate = new Date(thursday * MS_PER_DAY);
  const isoYear = thuDate.getUTCFullYear();
  const jan1 = Math.round(Date.UTC(isoYear, 0, 1) / MS_PER_DAY);
  const week = Math.floor((thursday - jan1) / 7) + 1;
  return `${String(isoYear).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/**
 * True when a is strictly before b.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isBefore(a, b) {
  return compareCivilDate(a, b) < 0;
}

/**
 * Whole days between two civil dates (b - a).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  return toEpochDay(b) - toEpochDay(a);
}
