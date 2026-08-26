/**
 * GATE24 regime transitions.
 *
 * A transition is evaluated session-over-session between consecutive canonical
 * trading sessions of the same instrument, WITHIN one RegimeHorizonSpecId:
 *   (RegimeRecord(T_prev), RegimeRecord(T))
 *
 * Comparing records across different horizons is not a transition and is never
 * emitted as one.
 *
 * PERSIST when primaryMarketRegime is identical between consecutive sessions,
 * CHANGE when it differs. An overlay dimension change is recorded in
 * changedDimensions and is never automatically promoted into a primary CHANGE.
 *
 * Hysteresis and minimum dwell are DEFERRED. No arbitrary dwell value is invented.
 */

import {
  ACTIVE_DIMENSION_NAMES_V1,
  INACTIVE_DIMENSION_NAMES_V1,
} from './regime-taxonomy-v1.mjs';
import { HORIZON_REFUSAL_CODES_V1 } from './regime-horizon-v1.mjs';

export const TRANSITION_SEMANTICS_VERSION = 'GATE24_TransitionSemantics/1';
export const PRIMARY_TRANSITION_TYPES_V1 = Object.freeze(['PERSIST', 'CHANGE']);
export const HYSTERESIS_V1 = 'DEFERRED';
export const MINIMUM_DWELL_V1 = 'DEFERRED';
export const TRANSITION_SCOPE_KEY = 'InstrumentIdentityId';

export const TRANSITION_REFUSAL_CODES_V1 = Object.freeze({
  crossHorizon: HORIZON_REFUSAL_CODES_V1.crossHorizon,
  crossInstrument: 'CROSS_INSTRUMENT_COMPARISON_FORBIDDEN',
  notConsecutive: 'NON_CONSECUTIVE_SESSION_PAIR',
  ordering: 'TRANSITION_PAIR_NOT_ORDERED',
  smoothing: 'FORWARD_SMOOTHING_FORBIDDEN',
  backfill: 'TRANSITION_BACKFILL_FORBIDDEN',
  dwellInvented: 'MINIMUM_DWELL_NOT_DECLARED',
});

/** The declared, non-gap absence: the first classified session has no predecessor. */
export const FIRST_SESSION_DISPOSITION = Object.freeze({
  emitsTransition: false,
  disposition: 'DECLARED_ABSENCE_NOT_A_COVERAGE_GAP',
});

const allDimensionNames = Object.freeze([...ACTIVE_DIMENSION_NAMES_V1, ...INACTIVE_DIMENSION_NAMES_V1]);

/** Dimensions whose value differs from the immediately prior classified session. */
export function changedDimensions(previousVector, currentVector) {
  return Object.freeze(allDimensionNames.filter((name) => previousVector[name] !== currentVector[name]));
}

function assertComparable(previous, current) {
  if (previous.RegimeHorizonSpecId !== current.RegimeHorizonSpecId) {
    return { status: 'BLOCKED', code: TRANSITION_REFUSAL_CODES_V1.crossHorizon };
  }
  if (previous.InstrumentIdentityId !== current.InstrumentIdentityId) {
    return { status: 'BLOCKED', code: TRANSITION_REFUSAL_CODES_V1.crossInstrument };
  }
  if (!(previous.SessionDate < current.SessionDate)) {
    return { status: 'BLOCKED', code: TRANSITION_REFUSAL_CODES_V1.ordering };
  }
  return { status: 'ALLOWED', code: null };
}

/**
 * Evaluates exactly one transition for one consecutive pair.
 *
 * regimeAgeSessions counts consecutive causal canonical sessions since entry into
 * the current primaryMarketRegime, computed from contemporaneous and prior records
 * only. lastTransitionSession is the canonical session of the most recent primary
 * CHANGE. Neither uses future information.
 */
export function evaluateTransition({ previous, current, priorAge = 0, priorLastTransitionSession = null }) {
  const comparable = assertComparable(previous, current);
  if (comparable.status !== 'ALLOWED') return { ...comparable, transition: null };

  const changed = changedDimensions(previous.regimeVector, current.regimeVector);
  const primaryChanged = previous.regimeVector.primaryMarketRegime !== current.regimeVector.primaryMarketRegime;
  const transitionType = primaryChanged ? 'CHANGE' : 'PERSIST';

  return Object.freeze({
    status: 'RESOLVED',
    code: null,
    transition: Object.freeze({
      schemaVersion: TRANSITION_SEMANTICS_VERSION,
      regimeHorizonSpecId: current.RegimeHorizonSpecId,
      instrumentIdentityId: current.InstrumentIdentityId,
      fromSessionDate: previous.SessionDate,
      toSessionDate: current.SessionDate,
      fromPrimaryMarketRegime: previous.regimeVector.primaryMarketRegime,
      toPrimaryMarketRegime: current.regimeVector.primaryMarketRegime,
      transitionType,
      changedDimensions: changed,
      /* A fast regime change is emitted at the session it occurs: no confirmation
         delay, no forward smoothing, no retroactive revision. */
      regimeAgeSessions: primaryChanged ? 1 : priorAge + 1,
      lastTransitionSession: primaryChanged ? current.SessionDate : priorLastTransitionSession,
      hysteresis: HYSTERESIS_V1,
      minimumDwell: MINIMUM_DWELL_V1,
    }),
  });
}

/**
 * Evaluates a whole session-ordered series for one instrument and one horizon.
 * Exactly one transition is emitted per consecutive pair in scope, and the first
 * session emits none.
 */
export function evaluateTransitionSeries({ records }) {
  if (!Array.isArray(records) || records.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'REGIME_RECORDS_REQUIRED', transitions: [] };
  }
  const horizons = new Set(records.map((record) => record.RegimeHorizonSpecId));
  if (horizons.size !== 1) return { status: 'BLOCKED', code: TRANSITION_REFUSAL_CODES_V1.crossHorizon, transitions: [] };
  const instruments = new Set(records.map((record) => record.InstrumentIdentityId));
  if (instruments.size !== 1) return { status: 'BLOCKED', code: TRANSITION_REFUSAL_CODES_V1.crossInstrument, transitions: [] };

  const ordered = [...records].sort((left, right) => left.SessionDate.localeCompare(right.SessionDate));
  const dates = ordered.map((record) => record.SessionDate);
  if (new Set(dates).size !== dates.length) return { status: 'FAIL_CLOSED', code: 'DUPLICATE_SESSION_IN_SERIES', transitions: [] };

  const transitions = [];
  let age = 1;
  let lastTransitionSession = null;
  for (let index = 1; index < ordered.length; index += 1) {
    const evaluated = evaluateTransition({
      previous: ordered[index - 1],
      current: ordered[index],
      priorAge: age,
      priorLastTransitionSession: lastTransitionSession,
    });
    if (evaluated.status !== 'RESOLVED') return { status: evaluated.status, code: evaluated.code, transitions: [] };
    age = evaluated.transition.regimeAgeSessions;
    lastTransitionSession = evaluated.transition.lastTransitionSession;
    transitions.push(evaluated.transition);
  }
  return Object.freeze({
    status: 'RESOLVED',
    code: null,
    sessionCount: ordered.length,
    /* Exactly one transition per consecutive pair; the first session emits none. */
    expectedTransitionCount: ordered.length - 1,
    firstSession: FIRST_SESSION_DISPOSITION,
    transitions: Object.freeze(transitions),
  });
}

/** A cross-horizon pair is refused explicitly rather than silently compared. */
export function refuseCrossHorizonComparison({ previous, current }) {
  return previous?.RegimeHorizonSpecId === current?.RegimeHorizonSpecId
    ? { status: 'ALLOWED', code: null }
    : { status: 'BLOCKED', code: TRANSITION_REFUSAL_CODES_V1.crossHorizon };
}

/** Hysteresis and minimum dwell are deferred; an invented dwell value is refused. */
export function requestMinimumDwell(value) {
  return value === undefined || value === null
    ? { status: 'DEFERRED', code: null, disposition: MINIMUM_DWELL_V1 }
    : { status: 'BLOCKED', code: TRANSITION_REFUSAL_CODES_V1.dwellInvented };
}

export function describeTransitionSemantics() {
  return Object.freeze({
    schemaVersion: TRANSITION_SEMANTICS_VERSION,
    unit: 'consecutive canonical trading sessions under the pinned calendar policy',
    scopeKey: TRANSITION_SCOPE_KEY,
    pair: '(RegimeRecord(T_prev), RegimeRecord(T))',
    primaryTransitionTypes: PRIMARY_TRANSITION_TYPES_V1,
    primaryTransitionRule: 'PERSIST when primaryMarketRegime is identical between consecutive sessions; CHANGE when it differs.',
    changedDimensionsRequired: true,
    overlayChangePromotesPrimary: false,
    regimeAgeSessionsRequired: true,
    lastTransitionSessionRequired: true,
    nonClassifyingTransitionsEmitted: true,
    suppressionAllowed: false,
    interpolationAllowed: false,
    backFillAllowed: false,
    forwardSmoothingAllowed: false,
    hysteresis: HYSTERESIS_V1,
    minimumDwell: MINIMUM_DWELL_V1,
    dwellArbitraryValueForbidden: true,
    firstSessionRule: FIRST_SESSION_DISPOSITION,
    horizonScope: 'Transitions are computed within one RegimeHorizonSpecId; cross-horizon comparison is not a transition.',
    refusalCodes: TRANSITION_REFUSAL_CODES_V1,
  });
}
