const SESSION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STRICT_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const PINNED_SESSION_TIMESTAMPS_VERSION = 'pinnedSessionTimestampsR1/1';

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function isStrictUtc(value) {
  return typeof value === 'string'
    && STRICT_UTC_PATTERN.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

/**
 * Rebind normalized Jarvise bar timestamps to the close of the canonical
 * session that owns the bar. All non-temporal fields and the input order are
 * preserved. No wall-clock or timezone-derived close is accepted.
 */
export function applyPinnedSessionTimestampsR1(bars, sessions) {
  if (!Array.isArray(bars)) fail('PINNED_SESSION_BARS_INVALID', 'bars must be an array');
  if (!Array.isArray(sessions)) fail('PINNED_SESSION_CALENDAR_INVALID', 'sessions must be an array');

  const closeBySessionDate = new Map();
  for (const session of sessions) {
    if (!SESSION_DATE_PATTERN.test(session?.sessionDate ?? '') || !isStrictUtc(session?.closeUtc)) {
      fail('PINNED_SESSION_CALENDAR_INVALID', 'sessionDate and closeUtc must be canonical');
    }
    if (closeBySessionDate.has(session.sessionDate)) {
      fail('PINNED_SESSION_CALENDAR_INVALID', `duplicate session ${session.sessionDate}`);
    }
    closeBySessionDate.set(session.sessionDate, session.closeUtc);
  }

  return bars.map((bar) => {
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) {
      fail('PINNED_SESSION_BAR_INVALID', 'bar must be an object');
    }
    const sessionDate = bar.sessionDate;
    if (!SESSION_DATE_PATTERN.test(sessionDate ?? '')) {
      fail('PINNED_SESSION_BAR_INVALID', 'bar.sessionDate must be a civil date');
    }
    const closeUtc = closeBySessionDate.get(sessionDate);
    if (!closeUtc) fail('PINNED_SESSION_NOT_FOUND', sessionDate);
    return { ...bar, eventTime: closeUtc, availableAt: closeUtc };
  });
}
