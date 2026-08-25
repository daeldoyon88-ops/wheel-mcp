/**
 * GATE23 calendar window fixture.
 *
 * Deterministic pinned canonical session universe under a pinned calendar/session
 * policy. Sessions are canonical DAILY trading sessions: weekends and holidays are
 * absent, so a W-session window always spans more calendar days than sessions.
 * REGULAR_SESSION and HALF_DAY_SESSION carry their own canonical closeUtc.
 */

import { createCalendarWindowBinding } from '../implementation/feature-window-v1.mjs';

export const CALENDAR_AUTHORITY_POLICY_ID = `sha256:${'1'.repeat(64)}`;
export const CALENDAR_REGISTRY_MANIFEST_ID = `sha256:${'2'.repeat(64)}`;
export const CALENDAR_NAMESPACE_VERSION = 'GATE23_FIXTURE_CALENDAR/1';

export const REGULAR_OPEN_UTC = 'T14:30:00.000Z';
export const REGULAR_CLOSE_UTC = 'T21:00:00.000Z';
export const HALF_DAY_CLOSE_UTC = 'T18:00:00.000Z';

/** Holidays removed from the trading-session universe. */
export const FIXTURE_HOLIDAYS = Object.freeze([
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  '2025-01-01', '2025-01-20', '2025-02-17',
]);
/** Sessions that close early and therefore carry their own canonical closeUtc. */
export const FIXTURE_HALF_DAYS = Object.freeze(['2024-07-03', '2024-11-29', '2024-12-24']);

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

export function buildSessionUniverse({ from = '2024-06-03', count = 200 } = {}) {
  const holidays = new Set(FIXTURE_HOLIDAYS);
  const halfDays = new Set(FIXTURE_HALF_DAYS);
  const sessions = [];
  let cursor = Date.parse(`${from}T00:00:00.000Z`);
  while (sessions.length < count) {
    const sessionDate = iso(cursor);
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(sessionDate)) {
      const half = halfDays.has(sessionDate);
      const closeUtc = `${sessionDate}${half ? HALF_DAY_CLOSE_UTC : REGULAR_CLOSE_UTC}`;
      sessions.push(Object.freeze({
        sessionDate,
        sessionKind: half ? 'HALF_DAY_SESSION' : 'REGULAR_SESSION',
        openUtc: `${sessionDate}${REGULAR_OPEN_UTC}`,
        closeUtc,
        marketValidTime: closeUtc,
      }));
    }
    cursor += DAY_MS;
  }
  return Object.freeze(sessions);
}

export const SESSION_UNIVERSE = buildSessionUniverse();
export const ANCHOR_SESSION_DATE = SESSION_UNIVERSE[SESSION_UNIVERSE.length - 1].sessionDate;
export const REGULAR_ANCHOR = SESSION_UNIVERSE.filter((session) => session.sessionKind === 'REGULAR_SESSION').at(-1);
export const HALF_DAY_ANCHOR = SESSION_UNIVERSE.filter((session) => session.sessionKind === 'HALF_DAY_SESSION').at(-1);

export const CALENDAR_WINDOW_BINDING = createCalendarWindowBinding({
  calendarAuthorityPolicyId: CALENDAR_AUTHORITY_POLICY_ID,
  calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
  allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'],
  calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
});

/** Binding admitting only regular sessions; a half-day anchor is then unpinnable. */
export const REGULAR_ONLY_BINDING = createCalendarWindowBinding({
  calendarAuthorityPolicyId: CALENDAR_AUTHORITY_POLICY_ID,
  calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
  allowedSessionKinds: ['REGULAR_SESSION'],
  calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
});

/** Hostile shapes: ambiguous, absent, structurally invalid and duplicated sessions. */
export function withDuplicateSession(sessionDate) {
  const original = SESSION_UNIVERSE.find((session) => session.sessionDate === sessionDate);
  return Object.freeze([...SESSION_UNIVERSE, Object.freeze({ ...original, sessionKind: 'HALF_DAY_SESSION' })]);
}

export function withoutSession(sessionDate) {
  return Object.freeze(SESSION_UNIVERSE.filter((session) => session.sessionDate !== sessionDate));
}

export function withCorruptedClose(sessionDate) {
  return Object.freeze(SESSION_UNIVERSE.map((session) => (session.sessionDate === sessionDate
    ? Object.freeze({ ...session, closeUtc: `${sessionDate} 21:00:00Z`, marketValidTime: `${sessionDate} 21:00:00Z` })
    : session)));
}

export function withMarketValidTimeDrift(sessionDate) {
  return Object.freeze(SESSION_UNIVERSE.map((session) => (session.sessionDate === sessionDate
    ? Object.freeze({ ...session, marketValidTime: `${sessionDate}T19:00:00.000Z` })
    : session)));
}
