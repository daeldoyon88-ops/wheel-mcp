/**
 * GATE23 OD-1 / OD-5: FeatureWindowSpec ladder, canonical DAILY trading-session
 * units, CalendarWindowBinding and K(T) = PinnedCanonicalSession(T).closeUtc.
 *
 * The ladder is admissible, never cartesian. TradingSessionUnit(T) is a distinct
 * concept from KnowledgeCutoffBoundary(K): the first counts sessions, the second
 * is the canonical closeUtc of the unique pinned canonical session.
 *
 * marketSession.mjs::sessionCloseUtc and wall-clock cutoff constants are forbidden
 * here by OD-5; the cutoff is read from the pinned canonical session record only.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { isStrictUtcIsoInstant } from '../../../../research/directional-lab/src/contracts/dailyBarV1.mjs';
import { isValidCivilDate } from '../../../../research/directional-lab/src/time/civilDate.mjs';
import { MARKET_CALENDAR_SESSION_KINDS } from '../../../../research/directional-lab/src/contracts/marketCalendarL3V1.mjs';

export const FEATURE_WINDOW_SPEC_VERSION = 'GATE23_FeatureWindowSpec/1';
export const CALENDAR_WINDOW_BINDING_VERSION = 'GATE23_CalendarWindowBinding/1';

/** OD-1: admissible ladder, exactly these five session counts. */
export const FEATURE_WINDOW_LADDER_V1 = Object.freeze([5, 21, 63, 126, 252]);
export const FEATURE_WINDOW_LADDER_IS_CARTESIAN = false;

/** OD-1: window units are canonical DAILY trading sessions, not calendar days. */
export const TRADING_SESSION_UNIT_V1 = 'CANONICAL_DAILY_TRADING_SESSION';
export const KNOWLEDGE_CUTOFF_BOUNDARY_V1 = 'PINNED_CANONICAL_SESSION_CLOSE_UTC';

/**
 * OD-5: forbidden primitive and forbidden wall-clock cutoff derivations.
 *
 * The prohibition is on the derivation, not on the value: a canonical session may
 * legitimately close at 21:00Z. What is forbidden is deriving K(T) from a
 * wall-clock convention or from marketSession.mjs::sessionCloseUtc instead of
 * reading closeUtc off the unique pinned canonical session record.
 */
export const FORBIDDEN_CUTOFF_PRIMITIVE = 'marketSession.mjs::sessionCloseUtc';
export const FORBIDDEN_WALL_CLOCK_CONSTANTS = Object.freeze(['16:00', '09:30', '20:00', '21:00']);
export const ADMISSIBLE_CUTOFF_DERIVATION = KNOWLEDGE_CUTOFF_BOUNDARY_V1;
export const OPTION_B_SETTLING_AT = Object.freeze({
  option: 'INITIAL_ROOT settlingAt(T)',
  status: 'NOT_EXECUTABLE_WITH_CURRENT_PRIMITIVES',
  disposition: 'FUTURE_ADDITIVE_OPTION',
});

export function createCalendarWindowBinding({
  calendarAuthorityPolicyId,
  calendarRegistryManifestId,
  allowedSessionKinds,
  calendarNamespaceVersion,
  cutoffDerivation = ADMISSIBLE_CUTOFF_DERIVATION,
}) {
  if (typeof calendarAuthorityPolicyId !== 'string' || calendarAuthorityPolicyId.length === 0
    || typeof calendarRegistryManifestId !== 'string' || calendarRegistryManifestId.length === 0
    || typeof calendarNamespaceVersion !== 'string' || calendarNamespaceVersion.length === 0) {
    throw new Error('CALENDAR_WINDOW_BINDING_INVALID');
  }
  if (refuseWallClockCutoff(cutoffDerivation).status === 'BLOCKED') throw new Error('WALL_CLOCK_CUTOFF_DERIVATION_FORBIDDEN');
  if (!Array.isArray(allowedSessionKinds) || allowedSessionKinds.length === 0
    || allowedSessionKinds.some((kind) => !MARKET_CALENDAR_SESSION_KINDS.includes(kind))
    || new Set(allowedSessionKinds).size !== allowedSessionKinds.length) {
    throw new Error('ALLOWED_SESSION_KINDS_INVALID');
  }
  const sorted = Object.freeze([...allowedSessionKinds].sort());
  const payload = {
    schemaVersion: CALENDAR_WINDOW_BINDING_VERSION,
    calendarAuthorityPolicyId,
    calendarRegistryManifestId,
    allowedSessionKinds: [...sorted],
    calendarNamespaceVersion,
    unit: TRADING_SESSION_UNIT_V1,
    knowledgeCutoffBoundary: KNOWLEDGE_CUTOFF_BOUNDARY_V1,
    cutoffDerivation,
  };
  return Object.freeze({
    ...payload,
    allowedSessionKinds: sorted,
    calendarWindowBindingId: sha256Canonical(payload),
  });
}

export function createFeatureWindowSpec({ sessionCount, calendarWindowBinding }) {
  if (!FEATURE_WINDOW_LADDER_V1.includes(sessionCount)) throw new Error('FEATURE_WINDOW_NOT_ADMITTED');
  if (!calendarWindowBinding?.calendarWindowBindingId) throw new Error('CALENDAR_WINDOW_BINDING_REQUIRED');
  const payload = {
    schemaVersion: FEATURE_WINDOW_SPEC_VERSION,
    sessionCount,
    unit: TRADING_SESSION_UNIT_V1,
    calendarWindowBindingId: calendarWindowBinding.calendarWindowBindingId,
  };
  return Object.freeze({
    ...payload,
    /** A W-session window is anchored at T and observes W + 1 canonical sessions. */
    observedSessionCount: sessionCount + 1,
    featureWindowSpecId: sha256Canonical(payload),
  });
}

/**
 * OD-1: the ladder is admissible, not cartesian. A family list crossed with a
 * window list is an expansion request, never a declaration.
 */
export function refuseCartesianExpansion(request) {
  if (request && Array.isArray(request.featureDefinitionIds) && Array.isArray(request.sessionCounts)) {
    return { status: 'BLOCKED', code: 'CARTESIAN_EXPANSION_FORBIDDEN' };
  }
  return { status: 'ALLOWED' };
}

/**
 * OD-5: refuse any cutoff derivation that is a wall-clock convention or the
 * forbidden marketSession primitive rather than the pinned canonical session close.
 */
export function refuseWallClockCutoff(derivation) {
  if (derivation !== ADMISSIBLE_CUTOFF_DERIVATION) {
    return {
      status: 'BLOCKED',
      code: typeof derivation === 'string' && derivation.includes('sessionCloseUtc')
        ? 'FORBIDDEN_CUTOFF_PRIMITIVE'
        : 'WALL_CLOCK_CUTOFF_CONSTANT_FORBIDDEN',
    };
  }
  return { status: 'ALLOWED', code: null };
}

function sessionStructurallyValid(session) {
  return Boolean(session)
    && isValidCivilDate(session.sessionDate)
    && MARKET_CALENDAR_SESSION_KINDS.includes(session.sessionKind)
    && isStrictUtcIsoInstant(session.openUtc)
    && isStrictUtcIsoInstant(session.closeUtc)
    && session.openUtc < session.closeUtc
    && session.marketValidTime === session.closeUtc;
}

/**
 * OD-5: PinnedCanonicalSession(T) is the unique canonical session record under the
 * pinned calendar/session policy with sessionDate === T and an allowed sessionKind.
 * HALF_DAY_SESSION and REGULAR_SESSION each carry their own canonical closeUtc.
 */
export function resolvePinnedCanonicalSession({ sessionDate, calendarWindowBinding, sessions }) {
  if (!calendarWindowBinding?.calendarWindowBindingId) throw new Error('CALENDAR_WINDOW_BINDING_REQUIRED');
  if (!isValidCivilDate(sessionDate)) return { status: 'FAIL_CLOSED', code: 'SESSION_DATE_INVALID', session: null, knowledgeCutoff: null };
  if (!Array.isArray(sessions)) return { status: 'FAIL_CLOSED', code: 'PINNED_CALENDAR_ABSENT', session: null, knowledgeCutoff: null };
  const dated = sessions.filter((session) => session?.sessionDate === sessionDate);
  if (dated.some((session) => !sessionStructurallyValid(session))) {
    return { status: 'FAIL_CLOSED', code: 'PINNED_CANONICAL_SESSION_INVALID', session: null, knowledgeCutoff: null };
  }
  const candidates = dated.filter((session) => calendarWindowBinding.allowedSessionKinds.includes(session.sessionKind));
  if (candidates.length === 0) return { status: 'FAIL_CLOSED', code: 'PINNED_CANONICAL_SESSION_ABSENT', session: null, knowledgeCutoff: null };
  if (candidates.length > 1) return { status: 'FAIL_CLOSED', code: 'PINNED_CANONICAL_SESSION_NOT_UNIQUE', session: null, knowledgeCutoff: null };
  const session = candidates[0];
  const derivation = refuseWallClockCutoff(calendarWindowBinding.cutoffDerivation);
  if (derivation.status === 'BLOCKED') {
    return { status: 'FAIL_CLOSED', code: derivation.code, session: null, knowledgeCutoff: null };
  }
  return {
    status: 'RESOLVED',
    code: null,
    session: Object.freeze({ ...session }),
    sessionKind: session.sessionKind,
    knowledgeCutoff: session.closeUtc,
    knowledgeCutoffBoundary: KNOWLEDGE_CUTOFF_BOUNDARY_V1,
    calendarWindowBindingId: calendarWindowBinding.calendarWindowBindingId,
  };
}

function orderedPinnedSessions(calendarWindowBinding, sessions) {
  const admitted = sessions.filter((session) => sessionStructurallyValid(session)
    && calendarWindowBinding.allowedSessionKinds.includes(session.sessionKind));
  const dates = admitted.map((session) => session.sessionDate);
  if (new Set(dates).size !== dates.length) return null;
  return [...admitted].sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
}

/**
 * Trailing window in canonical DAILY trading-session units, anchored at T and
 * strictly backward-looking. T-CAUSAL-B: no session after T is ever selected.
 */
export function resolveTrailingWindow({ sessionDate, featureWindowSpec, calendarWindowBinding, sessions }) {
  if (!featureWindowSpec?.featureWindowSpecId) throw new Error('FEATURE_WINDOW_SPEC_REQUIRED');
  if (!Array.isArray(sessions)) throw new Error('SESSIONS_REQUIRED');
  const ordered = orderedPinnedSessions(calendarWindowBinding, sessions);
  if (ordered === null) return { status: 'FAIL_CLOSED', code: 'PINNED_CANONICAL_SESSION_NOT_UNIQUE', sessions: [] };
  const anchor = ordered.findIndex((session) => session.sessionDate === sessionDate);
  if (anchor < 0) return { status: 'FAIL_CLOSED', code: 'PINNED_CANONICAL_SESSION_ABSENT', sessions: [] };
  const start = anchor - featureWindowSpec.sessionCount;
  if (start < 0) return { status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW', sessions: [] };
  const window = ordered.slice(start, anchor + 1);
  const guard = assertNoFutureWindowAccess({ sessionDate, window });
  if (guard.status !== 'ALLOWED') return { status: 'BLOCKED', code: guard.code, sessions: [] };
  return {
    status: 'RESOLVED',
    code: null,
    sessions: Object.freeze(window.map((session) => Object.freeze({ ...session }))),
    unit: TRADING_SESSION_UNIT_V1,
    windowSessionCount: featureWindowSpec.sessionCount,
    observedSessionCount: window.length,
  };
}

/** T-CAUSAL-B guard, applied to any window regardless of how it was produced. */
export function assertNoFutureWindowAccess({ sessionDate, window }) {
  if (!Array.isArray(window) || window.length === 0) return { status: 'BLOCKED', code: 'WINDOW_EMPTY' };
  if (window.some((session) => !session?.sessionDate || session.sessionDate > sessionDate)) {
    return { status: 'BLOCKED', code: 'FUTURE_WINDOW_ACCESS_FORBIDDEN' };
  }
  if (window[window.length - 1].sessionDate !== sessionDate) {
    return { status: 'BLOCKED', code: 'WINDOW_NOT_ANCHORED_AT_T' };
  }
  return { status: 'ALLOWED', code: null };
}

/** Window units are trading sessions; a calendar-day count is not a window count. */
export function calendarDaySpan(window) {
  if (!Array.isArray(window) || window.length === 0) return 0;
  const first = Date.parse(`${window[0].sessionDate}T00:00:00.000Z`);
  const last = Date.parse(`${window[window.length - 1].sessionDate}T00:00:00.000Z`);
  return Math.round((last - first) / 86400000) + 1;
}
