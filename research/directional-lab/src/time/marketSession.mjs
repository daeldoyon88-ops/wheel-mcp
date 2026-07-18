/**
 * US equity session times computed deterministically (no local timezone).
 * Regular close is 16:00 America/New_York. The UTC offset is derived from the
 * post-2007 US DST rule (second Sunday of March -> first Sunday of November),
 * computed with pure UTC arithmetic. Early closes (half days) are NOT modeled;
 * this is documented as a V1 limitation.
 */

import { assertCivilDate, toEpochDay, fromEpochDay, dayOfWeek, compareCivilDate } from './civilDate.mjs';

/**
 * Nth given weekday of a month, as a civil date.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} weekday 0=Sun..6=Sat
 * @param {number} nth 1-based
 * @returns {string}
 */
function nthWeekdayOfMonth(year, month, weekday, nth) {
  const first = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const firstDow = dayOfWeek(first);
  const offset = ((weekday - firstDow) + 7) % 7 + (nth - 1) * 7;
  return fromEpochDay(toEpochDay(first) + offset);
}

/**
 * True when the civil date falls inside US daylight saving time (post-2007 rule).
 * @param {string} civil
 * @returns {boolean}
 */
export function isUsDst(civil) {
  assertCivilDate(civil);
  const year = Number(civil.slice(0, 4));
  const dstStart = nthWeekdayOfMonth(year, 3, 0, 2); // second Sunday of March
  const dstEnd = nthWeekdayOfMonth(year, 11, 0, 1); // first Sunday of November
  return compareCivilDate(civil, dstStart) >= 0 && compareCivilDate(civil, dstEnd) < 0;
}

/**
 * UTC instant of the regular session close (16:00 ET) for a civil session date.
 * @param {string} sessionDate
 * @returns {string} ISO-8601 UTC timestamp
 */
export function sessionCloseUtc(sessionDate) {
  assertCivilDate(sessionDate);
  const hourUtc = isUsDst(sessionDate) ? 20 : 21; // EDT=UTC-4, EST=UTC-5
  return `${sessionDate}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`;
}

/**
 * UTC instant of the regular session open (09:30 ET) for a civil session date.
 * @param {string} sessionDate
 * @returns {string} ISO-8601 UTC timestamp
 */
export function sessionOpenUtc(sessionDate) {
  assertCivilDate(sessionDate);
  const hourUtc = isUsDst(sessionDate) ? 13 : 14;
  return `${sessionDate}T${String(hourUtc).padStart(2, '0')}:30:00.000Z`;
}

/**
 * True for Monday-Friday. Holidays are not modeled (V1 limitation): actual
 * trading calendars come from the observed bars themselves.
 * @param {string} civil
 * @returns {boolean}
 */
export function isWeekday(civil) {
  const dow = dayOfWeek(civil);
  return dow >= 1 && dow <= 5;
}
