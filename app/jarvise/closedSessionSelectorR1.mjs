/** R2-local MP-1 closed-session selector. */

export const MP1_XNYS_CALENDAR_PATH = 'data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json';

function isStrictUtcIso(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

export function selectClosedMp1Sessions(calendar, knowledgeCutoff) {
  if (!isStrictUtcIso(knowledgeCutoff)) {
    return { status: 'FAIL_CLOSED', reasonCode: 'KNOWLEDGE_CUTOFF_INVALID', sessions: [], latestClosedSession: null };
  }
  if (!calendar || !Array.isArray(calendar.sessions)) {
    return { status: 'FAIL_CLOSED', reasonCode: 'MP1_CALENDAR_INVALID', sessions: [], latestClosedSession: null };
  }
  const cutoffMs = Date.parse(knowledgeCutoff);
  const validSessions = calendar.sessions.filter((session) => (
    session && typeof session.sessionDate === 'string' && isStrictUtcIso(session.closeUtc)
  ));
  const sessions = validSessions
    .filter((session) => Date.parse(session.closeUtc) <= cutoffMs)
    .sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
  const excludedCurrentSessionCount = validSessions.length - sessions.length;
  return {
    status: sessions.length > 0 ? 'AVAILABLE' : 'ABSENT',
    reasonCode: sessions.length > 0 ? null : 'NO_CLOSED_MP1_SESSION',
    sessions,
    latestClosedSession: sessions.at(-1) ?? null,
    excludedCurrentSessionCount,
  };
}
