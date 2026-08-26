/**
 * GATE24 T-causal admission.
 *
 * K(T) = PinnedCanonicalSession(T).closeUtc, resolved through the referenced
 * CalendarWindowBinding. GATE24 creates no calendar concept: the pinned-session
 * resolution is the GATE23 primitive, consumed read-only.
 *
 * Every consumed input, market or macro, must carry its own proof that
 * availableAt <= K(T). marketSession.mjs::sessionCloseUtc and wall-clock cutoff
 * constants are forbidden derivations, per G24-BUILD-07.
 *
 * GATE22 Outcome remains forbidden directly, lagged, renamed or same-type
 * laundered. The GATE23 detector is reused verbatim rather than re-implemented.
 */

import {
  refuseOutcomeAsFeature,
  TRUSTED_CANONICAL_PRODUCER_V1,
} from '../../GATE23/implementation/causal-admission-v1.mjs';
import {
  resolvePinnedCanonicalSession,
  refuseWallClockCutoff,
  FORBIDDEN_CUTOFF_PRIMITIVE,
  FORBIDDEN_WALL_CLOCK_CONSTANTS,
  KNOWLEDGE_CUTOFF_BOUNDARY_V1,
} from '../../GATE23/implementation/feature-window-v1.mjs';

export const CAUSAL_ADMISSION_VERSION = 'GATE24_CausalAdmission/1';

export const T_CAUSAL_CLAIMS_V1 = Object.freeze([
  'NO_OUTCOME_OR_FUTURE_PROVENANCE_DEPENDENCY',
  'NO_FUTURE_WINDOW_ACCESS',
]);
export const T_CAUSAL_CLAIM_COUNT = T_CAUSAL_CLAIMS_V1.length;

export const CAUSAL_ADMISSION_CLAIM = T_CAUSAL_CLAIMS_V1[0];

export { FORBIDDEN_CUTOFF_PRIMITIVE, FORBIDDEN_WALL_CLOCK_CONSTANTS, KNOWLEDGE_CUTOFF_BOUNDARY_V1 };

/**
 * Substitution modes that would manufacture a value the world did not know at
 * K(T). Each is refused explicitly rather than silently tolerated.
 */
export const FORBIDDEN_SUBSTITUTION_MODES_V1 = Object.freeze([
  'LATEST_VALUE_SUBSTITUTION',
  'FUTURE_VINTAGE_LEAKAGE',
  'FUTURE_BACKFILL',
  'SILENT_INTERPOLATION',
  'UNAUTHORIZED_PROXY_SUBSTITUTION',
  'FORWARD_FILL_ACROSS_UNKNOWN_PUBLICATION',
]);

/** Outcome-bearing dataset and record members GATE24 may never read. */
export const FORBIDDEN_OUTCOME_SURFACES_V1 = Object.freeze([
  'DatasetId_outcome', 'OutcomeId', 'OutcomeStatus', 'OutcomeMissingReason', 'OutcomeWindowCause', 'HorizonId',
]);

/**
 * K(T). The cutoff is read off the unique pinned canonical session record; the
 * derivation is validated, never assumed.
 */
export function resolveKnowledgeCutoff({ sessionDate, calendarWindowBinding, sessions }) {
  const pinned = resolvePinnedCanonicalSession({ sessionDate, calendarWindowBinding, sessions });
  if (pinned.status !== 'RESOLVED') {
    return { status: 'FAIL_CLOSED', code: pinned.code, knowledgeCutoff: null, knowledgeCutoffBoundary: null, sessionKind: null };
  }
  return Object.freeze({
    status: 'RESOLVED',
    code: null,
    knowledgeCutoff: pinned.knowledgeCutoff,
    knowledgeCutoffBoundary: pinned.knowledgeCutoffBoundary,
    sessionKind: pinned.sessionKind,
    calendarWindowBindingId: pinned.calendarWindowBindingId,
  });
}

/** A cutoff produced by a wall-clock convention or the forbidden primitive is refused. */
export function assertAdmissibleCutoffDerivation(derivation) {
  return refuseWallClockCutoff(derivation);
}

/**
 * T-CAUSAL-A for a single GATE24 input, market or macro.
 *
 * containsFutureData is never trusted as a boolean: the availableAt bound is
 * enforced independently, so a mislabelled input is still refused.
 */
export function admitInputAtCutoff({ input, knowledgeCutoff }) {
  if (!input || typeof input !== 'object') return { status: 'BLOCKED', code: 'REGIME_INPUT_INVALID', mode: null };
  const outcome = refuseOutcomeAsFeature(input);
  if (outcome.status !== 'ALLOWED') return outcome;
  if (FORBIDDEN_OUTCOME_SURFACES_V1.some((member) => Object.hasOwn(input, member))) {
    return { status: 'BLOCKED', code: 'OUTCOME_SURFACE_FORBIDDEN', mode: 'direct' };
  }
  if (typeof knowledgeCutoff !== 'string' || knowledgeCutoff.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'KNOWLEDGE_CUTOFF_REQUIRED', mode: null };
  }
  const availableAt = input.availableAt ?? input.provenance?.availableAt;
  if (typeof availableAt !== 'string' || availableAt.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'AVAILABLE_AT_REQUIRED', mode: null };
  }
  if (input.substitutionMode !== undefined && input.substitutionMode !== null) {
    return { status: 'BLOCKED', code: 'SUBSTITUTED_INPUT_FORBIDDEN', mode: String(input.substitutionMode) };
  }
  if (availableAt > knowledgeCutoff) {
    return { status: 'BLOCKED', code: 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN', mode: null };
  }
  return { status: 'ALLOWED', code: null, mode: null, preserved: TRUSTED_CANONICAL_PRODUCER_V1 };
}

/**
 * A macro observation is admitted at its own vintage. A later revision of the same
 * observation is a different vintage and may not be substituted backwards.
 */
export function admitMacroVintage({ observation, knowledgeCutoff }) {
  const admitted = admitInputAtCutoff({ input: observation, knowledgeCutoff });
  if (admitted.status !== 'ALLOWED') return admitted;
  const vintageAvailableAt = observation.vintageAvailableAt ?? observation.availableAt;
  if (typeof vintageAvailableAt !== 'string' || vintageAvailableAt.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'VINTAGE_AVAILABLE_AT_REQUIRED', mode: null };
  }
  if (vintageAvailableAt > knowledgeCutoff) {
    return { status: 'BLOCKED', code: 'FUTURE_VINTAGE_LEAKAGE_FORBIDDEN', mode: null };
  }
  return { status: 'ALLOWED', code: null, mode: null, preserved: TRUSTED_CANONICAL_PRODUCER_V1 };
}

/**
 * Selects the admissible vintage of a series as of K(T): the latest observation
 * whose vintage was published at or before the cutoff. Selecting the newest
 * revision regardless of cutoff is the LATEST_VALUE_SUBSTITUTION defect.
 */
export function selectVintageAsOf({ observations, knowledgeCutoff }) {
  if (!Array.isArray(observations)) return { status: 'FAIL_CLOSED', code: 'MACRO_OBSERVATIONS_REQUIRED', observation: null };
  if (typeof knowledgeCutoff !== 'string' || knowledgeCutoff.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'KNOWLEDGE_CUTOFF_REQUIRED', observation: null };
  }
  const admissible = observations.filter((observation) => admitMacroVintage({ observation, knowledgeCutoff }).status === 'ALLOWED');
  if (admissible.length === 0) return { status: 'INSUFFICIENT_DATA', code: 'NO_ADMISSIBLE_VINTAGE_AT_CUTOFF', observation: null };
  const ordered = [...admissible].sort((left, right) => {
    const vintage = (item) => item.vintageAvailableAt ?? item.availableAt;
    return vintage(left) === vintage(right)
      ? String(left.sequenceId ?? '').localeCompare(String(right.sequenceId ?? ''))
      : vintage(left).localeCompare(vintage(right));
  });
  return { status: 'RESOLVED', code: null, observation: Object.freeze({ ...ordered[ordered.length - 1] }) };
}

/** Refuses any explicitly requested substitution mode. */
export function refuseSubstitution(mode) {
  return FORBIDDEN_SUBSTITUTION_MODES_V1.includes(mode)
    ? { status: 'BLOCKED', code: `${mode}_FORBIDDEN` }
    : { status: 'ALLOWED', code: null };
}

/** Admits a whole GATE24 input bundle under both T-CAUSAL claims. */
export function admitRegimeInputs({ inputs, knowledgeCutoff }) {
  if (!Array.isArray(inputs)) return { status: 'FAIL_CLOSED', code: 'REGIME_INPUTS_REQUIRED', claim: CAUSAL_ADMISSION_CLAIM };
  for (const input of inputs) {
    const admitted = admitInputAtCutoff({ input, knowledgeCutoff });
    if (admitted.status !== 'ALLOWED') return { ...admitted, claim: CAUSAL_ADMISSION_CLAIM };
  }
  return { status: 'ALLOWED', code: null, claims: T_CAUSAL_CLAIMS_V1, preserved: TRUSTED_CANONICAL_PRODUCER_V1 };
}

export function describeCausalAdmission() {
  return Object.freeze({
    schemaVersion: CAUSAL_ADMISSION_VERSION,
    knowledgeCutoffFormula: 'K(T) = PinnedCanonicalSession(T).closeUtc',
    knowledgeCutoffBoundary: KNOWLEDGE_CUTOFF_BOUNDARY_V1,
    claims: T_CAUSAL_CLAIMS_V1,
    claimCount: T_CAUSAL_CLAIM_COUNT,
    forbiddenSubstitutionModes: FORBIDDEN_SUBSTITUTION_MODES_V1,
    forbiddenOutcomeSurfaces: FORBIDDEN_OUTCOME_SURFACES_V1,
    forbiddenCutoffPrimitive: FORBIDDEN_CUTOFF_PRIMITIVE,
    forbiddenWallClockConstants: FORBIDDEN_WALL_CLOCK_CONSTANTS,
    preserved: TRUSTED_CANONICAL_PRODUCER_V1,
    outcomeDetectorReusedFrom: 'governance/gates/GATE23/implementation/causal-admission-v1.mjs',
  });
}
