/**
 * GATE23 feature families.
 *
 * OD-3: CROSS_SECTIONAL is DEFER. There is no cross-sectional implementation in V1.
 * OD-4: CORE_FEATURE_SET is exactly (F1 simple-return, W5) and (F1 simple-return, W21).
 *       vectorStatus RESOLVED means the core is resolved, not that every non-core
 *       member is usable. A declared non-core member may be INSUFFICIENT_DATA or
 *       FAIL_CLOSED while vectorStatus stays RESOLVED. A missing declared member is
 *       fail-closed.
 */

import { defineFeature } from './feature-registry-v1.mjs';
import { FEATURE_WINDOW_LADDER_V1, refuseCartesianExpansion } from './feature-window-v1.mjs';

export const FEATURE_FAMILY_VERSION = 'GATE23_FeatureFamily/1';
export const MEMBER_STATUSES = Object.freeze(['RESOLVED', 'INSUFFICIENT_DATA', 'FAIL_CLOSED']);

/** OD-3. */
export const CROSS_SECTIONAL_V1 = 'DEFER';
export function requestCrossSectional() {
  return { status: 'BLOCKED', code: 'CROSS_SECTIONAL_DEFERRED_V1', disposition: CROSS_SECTIONAL_V1 };
}

export const FAMILY_F1 = 'F1_SIMPLE_RETURN';
export const F1_FEATURE_DEFINITION_ID = 'F1_SIMPLE_RETURN';
export const F1_FORMULA_VERSION = '1';
export const F1_FORMULA_ID = 'GATE23_SIMPLE_RETURN/1';

/**
 * Simple return over a W-session trailing window anchored at T:
 *   r = close(T) / close(T - W) - 1
 * The window supplies W + 1 canonical session closes, all at or before T.
 */
export function simpleReturn(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return { status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW', value: null };
  if (closes.some((close) => close === null || close === undefined)) return { status: 'FAIL_CLOSED', code: 'INPUT_MISSING', value: null };
  if (closes.some((close) => typeof close !== 'number' || !Number.isFinite(close) || close <= 0)) {
    return { status: 'FAIL_CLOSED', code: 'INVALID_INPUT', value: null };
  }
  const base = closes[0];
  const last = closes[closes.length - 1];
  return { status: 'RESOLVED', code: null, value: last / base - 1 };
}

export const F1_DEFINITION = defineFeature({
  featureDefinitionId: F1_FEATURE_DEFINITION_ID,
  familyId: FAMILY_F1,
  formulaId: F1_FORMULA_ID,
  formulaVersion: F1_FORMULA_VERSION,
  requiredObservedFields: ['close'],
  compute: ({ closes }) => simpleReturn(closes),
});

/** OD-4: the core is exactly these two declared members. */
export const CORE_FEATURE_SET_V1 = Object.freeze([
  Object.freeze({ featureDefinitionId: F1_FEATURE_DEFINITION_ID, sessionCount: 5 }),
  Object.freeze({ featureDefinitionId: F1_FEATURE_DEFINITION_ID, sessionCount: 21 }),
]);

export const memberKey = (member) => `${member.featureDefinitionId}@W${member.sessionCount}`;
const CORE_KEYS = Object.freeze(CORE_FEATURE_SET_V1.map(memberKey));

export function isCoreMember(member) {
  return CORE_KEYS.includes(memberKey(member));
}

/**
 * A vector is a list of explicitly declared (featureDefinitionId, window) members.
 * The ladder is admissible, not cartesian: a families-by-windows product request
 * is refused rather than expanded.
 */
export function declareFeatureVector(members) {
  if (refuseCartesianExpansion(members).status === 'BLOCKED') throw new Error('CARTESIAN_EXPANSION_FORBIDDEN');
  if (!Array.isArray(members) || members.length === 0) throw new Error('FEATURE_VECTOR_EMPTY');
  if (members.some((member) => typeof member?.featureDefinitionId !== 'string'
    || !FEATURE_WINDOW_LADDER_V1.includes(member?.sessionCount))) {
    throw new Error('FEATURE_WINDOW_NOT_ADMITTED');
  }
  const keys = members.map(memberKey);
  if (new Set(keys).size !== keys.length) throw new Error('FEATURE_VECTOR_DUPLICATE_MEMBER');
  if (CORE_KEYS.some((key) => !keys.includes(key))) throw new Error('CORE_FEATURE_SET_INCOMPLETE');
  return Object.freeze({
    schemaVersion: FEATURE_FAMILY_VERSION,
    members: Object.freeze(members.map((member) => Object.freeze({
      featureDefinitionId: member.featureDefinitionId,
      sessionCount: member.sessionCount,
      core: isCoreMember(member),
    }))),
    coreFeatureSet: CORE_FEATURE_SET_V1,
    crossSectional: CROSS_SECTIONAL_V1,
  });
}

/**
 * OD-4 resolution rule. RESOLVED means exactly that the core is resolved; declared
 * non-core members stay individually inspectable at whatever status they reached.
 */
export function resolveVectorStatus({ vector, memberResults }) {
  const byKey = new Map(memberResults.map((result) => [memberKey(result), result]));
  for (const member of vector.members) {
    const result = byKey.get(memberKey(member));
    if (!result || !MEMBER_STATUSES.includes(result.status)) {
      return { vectorStatus: 'FAIL_CLOSED', code: 'DECLARED_MEMBER_MISSING', member: memberKey(member) };
    }
  }
  const core = CORE_FEATURE_SET_V1.map((member) => byKey.get(memberKey(member)));
  if (core.some((result) => result.status === 'FAIL_CLOSED')) {
    return { vectorStatus: 'FAIL_CLOSED', code: 'CORE_FEATURE_FAIL_CLOSED', member: null };
  }
  if (core.some((result) => result.status === 'INSUFFICIENT_DATA')) {
    return { vectorStatus: 'INSUFFICIENT_DATA', code: 'CORE_FEATURE_INSUFFICIENT_DATA', member: null };
  }
  return { vectorStatus: 'RESOLVED', code: null, member: null, meaning: 'CORE_RESOLVED_ONLY' };
}
