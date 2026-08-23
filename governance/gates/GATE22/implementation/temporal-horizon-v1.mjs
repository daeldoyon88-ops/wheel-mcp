export const HORIZONS_V1 = Object.freeze([30, 90, 180, 252]);
export const SESSION_KINDS_V1 = Object.freeze(['REGULAR_SESSION', 'HALF_DAY_SESSION']);

export function createHorizon({ sessionCount, calendarRegistryManifestId }) {
  if (!HORIZONS_V1.includes(sessionCount) || !calendarRegistryManifestId) throw new Error('HORIZON_NOT_ADMITTED');
  return Object.freeze({ sessionCount, calendarRegistryManifestId, horizonId: `${sessionCount}:${calendarRegistryManifestId}` });
}

export function resolveOutcomeWindow({ sessionDate, horizon, calendarSessions }) {
  const start = calendarSessions.findIndex((session) => session.sessionDate === sessionDate);
  if (start < 0 || !horizon?.horizonId) return { status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW', sessions: [] };
  const sessions = calendarSessions.slice(start + 1, start + 1 + horizon.sessionCount);
  if (sessions.length !== horizon.sessionCount || sessions.some((s) => !SESSION_KINDS_V1.includes(s.sessionKind))) {
    return { status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW', sessions: [] };
  }
  return { status: 'RESOLVED', sessions };
}

export function observationIsAdmissible({ AvailableAt, KnowledgeCutoff }) {
  return typeof AvailableAt === 'string' && typeof KnowledgeCutoff === 'string' && AvailableAt <= KnowledgeCutoff;
}
