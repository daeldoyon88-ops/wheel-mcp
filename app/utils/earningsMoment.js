/**
 * Classifies when earnings are published relative to regular session (NYSE-style boundaries),
 * using the listing exchange timezone. Used for scanner cards and quotes.
 *
 * @typedef {"morning"|"evening"|"unknown"} EarningsMoment
 */

const REGULAR_OPEN_MINS = 9 * 60 + 30;
const REGULAR_CLOSE_MINS = 16 * 60;

export const EARNINGS_MOMENT = {
  MORNING: "morning",
  EVENING: "evening",
  UNKNOWN: "unknown",
};

/** Minutes from midnight in `timeZone` for this instant (local exchange clock). */
function minutesSinceMidnightInZone(date, timeZone) {
  const tz = timeZone || "America/New_York";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "hour") hour = Number(p.value);
    if (p.type === "minute") minute = Number(p.value);
  }
  return hour * 60 + minute;
}

function parseInstant(raw) {
  if (raw == null) return null;
  const numeric = Number(raw);
  const instant =
    Number.isFinite(numeric) && numeric > 0
      ? new Date(numeric > 1e12 ? numeric : numeric * 1000)
      : new Date(raw);
  if (Number.isNaN(instant.getTime())) return null;
  return instant;
}

/**
 * Prefer explicit call window, then earnings window start, then legacy earnings timestamp
 * (aligned with isEarningsImminent in wheelScanner).
 *
 * @param {object} quote
 * @param {string|null|undefined} quote.exchangeTimezoneName
 * @param {number|string|null|undefined} quote.earningsCallTimestampStart
 * @param {number|string|null|undefined} quote.earningsTimestampStart
 * @param {number|string|null|undefined} quote.earningsTimestamp
 * @param {boolean|null|undefined} quote.isEarningsDateEstimate
 * @returns {EarningsMoment}
 */
export function deriveEarningsMoment(quote) {
  const tz =
    quote?.exchangeTimezoneName && String(quote.exchangeTimezoneName).trim()
      ? String(quote.exchangeTimezoneName).trim()
      : "America/New_York";
  const raw =
    quote?.earningsCallTimestampStart ??
    quote?.earningsTimestampStart ??
    quote?.earningsTimestamp ??
    null;
  const instant = parseInstant(raw);
  if (!instant) return EARNINGS_MOMENT.UNKNOWN;

  const mins = minutesSinceMidnightInZone(instant, tz);
  const isEstimate = quote?.isEarningsDateEstimate === true;

  // Yahoo date-only estimates often surface as local midnight — treat as unknown time-of-day.
  if (isEstimate && mins === 0) return EARNINGS_MOMENT.UNKNOWN;

  if (mins < REGULAR_OPEN_MINS) return EARNINGS_MOMENT.MORNING;
  if (mins >= REGULAR_CLOSE_MINS) return EARNINGS_MOMENT.EVENING;
  return EARNINGS_MOMENT.UNKNOWN;
}
