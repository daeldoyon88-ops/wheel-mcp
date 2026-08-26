/**
 * GATE24 RegimeHorizonSpec, mirroring GATE23_FeatureWindowSpec/1 exactly.
 *
 * G24-BUILD-05: the payload is exactly
 *   { schemaVersion, sessionCount, unit, calendarWindowBindingId }
 * and regimeHorizonSpecId = sha256Canonical(payload). A 21-session horizon
 * anchored at T observes 22 canonical sessions.
 *
 * G24-BUILD-06: GATE24 creates no calendar concept and constructs no
 * CalendarWindowBinding. The calendarWindowBindingId is resolved BY REFERENCE
 * from the GATE23 FeatureSet bound by the record's FeatureVectorBindingId.
 * No literal calendar-binding id appears anywhere in this module, and a binding
 * whose calendarNamespaceVersion denotes a fixture namespace is refused.
 *
 * CORE_V1 activates exactly one horizon, sessionCount 21, selected by the
 * PROJECT_OWNER. No horizon is ever implied by a code default, by ordering, by
 * recency or by file position: every consumer binds its horizon explicitly even
 * while only one is active.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  FEATURE_WINDOW_LADDER_V1,
  TRADING_SESSION_UNIT_V1,
} from '../../GATE23/implementation/feature-window-v1.mjs';

export const REGIME_HORIZON_SPEC_VERSION = 'GATE24_RegimeHorizonSpec/1';
export const REGIME_HORIZON_UNIT_V1 = TRADING_SESSION_UNIT_V1;

/**
 * Owner-frozen CORE_V1 horizon policy. 21 is a member of the upstream GATE23
 * admissible ladder and its feature window is present in the GATE23 core feature
 * set. GATE24 neither widens, narrows nor redefines that ladder.
 */
export const CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS = Object.freeze([21]);
export const CORE_V1_ACTIVE_HORIZON_COUNT = CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS.length;
export const DEFERRED_HORIZON_SESSION_COUNTS = Object.freeze(
  FEATURE_WINDOW_LADDER_V1.filter((count) => !CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS.includes(count)),
);
export const MULTI_HORIZON_ACTIVATION = 'DEFERRED_TO_FUTURE_VERSION';

/**
 * Fixture-namespace detector. A calendar namespace carrying any of these tokens
 * is a test/synthetic namespace and is inadmissible as production provenance.
 */
export const FIXTURE_NAMESPACE_TOKENS_V1 = Object.freeze([
  'FIXTURE', 'SYNTHETIC', 'MOCK', 'STUB', 'SAMPLE', 'DEMO', 'ADVERSARIAL', 'TEST', 'EXAMPLE', 'DUMMY',
]);

export const HORIZON_REFUSAL_CODES_V1 = Object.freeze({
  notSingleValued: 'CALENDAR_WINDOW_BINDING_NOT_SINGLE_VALUED',
  fixtureNamespace: 'FIXTURE_CALENDAR_NAMESPACE_FORBIDDEN',
  bindingAbsent: 'CALENDAR_WINDOW_BINDING_ABSENT',
  notAdmitted: 'REGIME_HORIZON_NOT_ADMITTED',
  notActive: 'REGIME_HORIZON_NOT_ACTIVE_IN_CORE_V1',
  implicitHorizon: 'IMPLICIT_HORIZON_BINDING_FORBIDDEN',
  crossHorizon: 'CROSS_HORIZON_COMPARISON_FORBIDDEN',
});

export function isFixtureCalendarNamespace(calendarNamespaceVersion) {
  if (typeof calendarNamespaceVersion !== 'string' || calendarNamespaceVersion.length === 0) return true;
  const flat = calendarNamespaceVersion.toUpperCase();
  return FIXTURE_NAMESPACE_TOKENS_V1.some((token) => flat.includes(token));
}

/**
 * G24-BUILD-06 production admission. A fixture-scoped binding never becomes a
 * production identifier, whatever else is true about it.
 */
export function admitProductionCalendarWindowBinding(calendarWindowBinding) {
  if (!calendarWindowBinding?.calendarWindowBindingId) {
    return { status: 'FAIL_CLOSED', code: HORIZON_REFUSAL_CODES_V1.bindingAbsent, calendarWindowBindingId: null };
  }
  if (isFixtureCalendarNamespace(calendarWindowBinding.calendarNamespaceVersion)) {
    return { status: 'BLOCKED', code: HORIZON_REFUSAL_CODES_V1.fixtureNamespace, calendarWindowBindingId: null };
  }
  return {
    status: 'ADMITTED',
    code: null,
    calendarWindowBindingId: calendarWindowBinding.calendarWindowBindingId,
    calendarNamespaceVersion: calendarWindowBinding.calendarNamespaceVersion,
  };
}

/**
 * Resolve the calendarWindowBindingId carried by the bound GATE23 FeatureSet.
 *
 * Single-valuedness is verified, never assumed: every FeatureWindowSpec of the
 * FeatureSet must carry the same calendarWindowBindingId, otherwise BUILD fails
 * closed with CALENDAR_WINDOW_BINDING_NOT_SINGLE_VALUED.
 */
export function resolveCalendarWindowBindingIdFromFeatureSet(featureSet) {
  const records = featureSet?.records;
  if (!Array.isArray(records) || records.length === 0) {
    return { status: 'FAIL_CLOSED', code: HORIZON_REFUSAL_CODES_V1.bindingAbsent, calendarWindowBindingId: null, observedCount: 0 };
  }
  const observed = [...new Set(records.map((record) => record.identity?.CalendarWindowBindingId))];
  if (observed.some((value) => typeof value !== 'string' || value.length === 0)) {
    return { status: 'FAIL_CLOSED', code: HORIZON_REFUSAL_CODES_V1.bindingAbsent, calendarWindowBindingId: null, observedCount: observed.length };
  }
  if (observed.length !== 1) {
    return {
      status: 'FAIL_CLOSED',
      code: HORIZON_REFUSAL_CODES_V1.notSingleValued,
      calendarWindowBindingId: null,
      observedCount: observed.length,
    };
  }
  return { status: 'RESOLVED', code: null, calendarWindowBindingId: observed[0], observedCount: 1 };
}

/**
 * Full production resolution: single-valuedness by reference, then the fixture
 * prohibition. The bound CalendarWindowBinding payload is read, never rebuilt.
 */
export function resolveProductionCalendarWindowBinding({ featureSet, calendarWindowBinding }) {
  const byReference = resolveCalendarWindowBindingIdFromFeatureSet(featureSet);
  if (byReference.status !== 'RESOLVED') return byReference;
  if (calendarWindowBinding?.calendarWindowBindingId !== byReference.calendarWindowBindingId) {
    return { status: 'FAIL_CLOSED', code: HORIZON_REFUSAL_CODES_V1.bindingAbsent, calendarWindowBindingId: null };
  }
  const admitted = admitProductionCalendarWindowBinding(calendarWindowBinding);
  if (admitted.status !== 'ADMITTED') return { status: admitted.status, code: admitted.code, calendarWindowBindingId: null };
  return { status: 'RESOLVED', code: null, calendarWindowBindingId: byReference.calendarWindowBindingId };
}

/**
 * G24-BUILD-05 identity. The payload is exactly four members; the observed
 * session count is disclosure, not identity.
 */
export function createRegimeHorizonSpec({ sessionCount, calendarWindowBindingId }) {
  if (!FEATURE_WINDOW_LADDER_V1.includes(sessionCount)) throw new Error(HORIZON_REFUSAL_CODES_V1.notAdmitted);
  if (typeof calendarWindowBindingId !== 'string' || !/^[0-9a-f]{64}$/.test(calendarWindowBindingId)) {
    throw new Error(HORIZON_REFUSAL_CODES_V1.bindingAbsent);
  }
  const payload = {
    schemaVersion: REGIME_HORIZON_SPEC_VERSION,
    sessionCount,
    unit: REGIME_HORIZON_UNIT_V1,
    calendarWindowBindingId,
  };
  return Object.freeze({
    ...payload,
    /** A W-session horizon is anchored at T and observes W + 1 canonical sessions. */
    observedSessionCount: sessionCount + 1,
    activeInCoreV1: CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS.includes(sessionCount),
    regimeHorizonSpecId: sha256Canonical(payload),
  });
}

/** The CORE_V1 active horizon, materialized against a resolved calendar binding. */
export function createActiveRegimeHorizonSpec({ calendarWindowBindingId }) {
  return createRegimeHorizonSpec({
    sessionCount: CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS[0],
    calendarWindowBindingId,
  });
}

/**
 * Consumer horizon binding. There is no default, no "first available", no
 * "the only one active" and no inference from ordering, recency or file position.
 */
export function bindConsumerHorizon({ consumerId, regimeHorizonSpecId, activeRegimeHorizonSpecIds }) {
  if (typeof consumerId !== 'string' || consumerId.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'CONSUMER_ID_REQUIRED', regimeHorizonSpecId: null };
  }
  if (typeof regimeHorizonSpecId !== 'string' || regimeHorizonSpecId.length === 0) {
    return { status: 'BLOCKED', code: HORIZON_REFUSAL_CODES_V1.implicitHorizon, regimeHorizonSpecId: null };
  }
  if (!Array.isArray(activeRegimeHorizonSpecIds) || !activeRegimeHorizonSpecIds.includes(regimeHorizonSpecId)) {
    return { status: 'BLOCKED', code: HORIZON_REFUSAL_CODES_V1.notActive, regimeHorizonSpecId: null };
  }
  return Object.freeze({ status: 'BOUND', code: null, consumerId, regimeHorizonSpecId });
}

/** Any consumption record without an explicit horizon binding is invalid. */
export function refuseImplicitHorizon(consumptionRecord) {
  const bound = consumptionRecord?.regimeHorizonSpecId;
  return typeof bound === 'string' && bound.length > 0
    ? { status: 'ALLOWED', code: null }
    : { status: 'BLOCKED', code: HORIZON_REFUSAL_CODES_V1.implicitHorizon };
}

export function describeRegimeHorizonArchitecture() {
  return Object.freeze({
    schemaVersion: REGIME_HORIZON_SPEC_VERSION,
    identityForm: 'regimeHorizonSpecId = sha256Canonical({ schemaVersion, sessionCount, unit, calendarWindowBindingId })',
    patternSource: 'governance/gates/GATE23/implementation/feature-window-v1.mjs',
    unit: REGIME_HORIZON_UNIT_V1,
    admissibleLadder: FEATURE_WINDOW_LADDER_V1,
    ladderModifiedByGate24: false,
    activeHorizonSessionCounts: CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS,
    activeHorizonCount: CORE_V1_ACTIVE_HORIZON_COUNT,
    deferredHorizonSessionCounts: DEFERRED_HORIZON_SESSION_COUNTS,
    multiHorizonActivation: MULTI_HORIZON_ACTIVATION,
    createsNewCalendarConcept: false,
    calendarWindowBindingResolution: 'BY_REFERENCE_FROM_BOUND_GATE23_FEATURE_SET',
    literalCalendarBindingIdPresent: false,
    codeDefaultHorizon: null,
    refusalCodes: HORIZON_REFUSAL_CODES_V1,
  });
}
