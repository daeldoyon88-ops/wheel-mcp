/**
 * GATE23 T-CAUSAL admission.
 *
 * T-CAUSAL admits exactly two claims and no third:
 *   A. NO_OUTCOME_OR_FUTURE_PROVENANCE_DEPENDENCY
 *   B. NO_FUTURE_WINDOW_ACCESS
 *
 * GATE22 Outcome is forbidden as a GATE23 feature directly, lagged, renamed, or
 * through same-type laundering. TRUSTED_CANONICAL_PRODUCER_V1 is preserved: an
 * admitted input must originate from a trusted canonical producer as an
 * Observation, and must be visible at or before K(T).
 */

import { TAXONOMY_PRIMITIVES } from '../../GATE22/implementation/taxonomy-v1.mjs';
import { authorizeConsumption } from '../../GATE22/implementation/consumption-boundary-v1.mjs';
import { assertNoFutureWindowAccess } from './feature-window-v1.mjs';

export const CAUSAL_ADMISSION_VERSION = 'GATE23_CausalAdmission/1';

export const T_CAUSAL_CLAIMS_V1 = Object.freeze([
  'NO_OUTCOME_OR_FUTURE_PROVENANCE_DEPENDENCY',
  'NO_FUTURE_WINDOW_ACCESS',
]);
export const T_CAUSAL_CLAIM_COUNT = T_CAUSAL_CLAIMS_V1.length;

export const OUTCOME_PROHIBITION_MODES_V1 = Object.freeze(['direct', 'lagged', 'renamed', 'same-type laundering']);

export const TRUSTED_CANONICAL_PRODUCER_V1 = 'TRUSTED_CANONICAL_PRODUCER_V1';
export const TRUSTED_PRODUCER_GATE_IDS = Object.freeze(['GATE21', 'GATE23']);
export const ADMITTED_RECORD_TYPE = 'Observation';

/** Direct-name tokens that denote an Outcome or a future-provenance quantity. */
export const OUTCOME_NAME_TOKENS = Object.freeze([
  'outcome', 'outcomeid', 'outcomestatus', 'outcomemissingreason', 'outcomewindowcause',
  'horizon', 'horizonid', 'taxonomyversion', 'datasetidoutcome',
  'label', 'forwardreturn', 'futurereturn', 'forwardlooking', 'realizedoutcome', 'ytrue', 'target',
]);

const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const TAXONOMY_EXACT = new Set(TAXONOMY_PRIMITIVES.map(normalize));

function nameIsOutcome(name) {
  const flat = normalize(name);
  return TAXONOMY_EXACT.has(flat) || OUTCOME_NAME_TOKENS.some((token) => flat.includes(token));
}

function typeIsOutcome(value) {
  return typeof value === 'string' && normalize(value).includes('outcome');
}

function derivationCarriesOutcome(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 16) return false;
  if (typeIsOutcome(node.recordType) || typeIsOutcome(node.originRecordType)) return true;
  if (node.producerGateId === 'GATE22') return true;
  if (typeof node.name === 'string' && nameIsOutcome(node.name)) return true;
  const parents = Array.isArray(node.derivedFrom) ? node.derivedFrom : [];
  return parents.some((parent) => derivationCarriesOutcome(parent, depth + 1));
}

/**
 * T-CAUSAL-A, Outcome half. Returns ALLOWED, or BLOCKED with the prohibition mode
 * that fired. Mode precedence: direct, lagged, same-type laundering, renamed.
 */
export function refuseOutcomeAsFeature(candidate) {
  if (!candidate || typeof candidate !== 'object') return { status: 'BLOCKED', code: 'FEATURE_INPUT_INVALID', mode: null };
  const names = [candidate.name, candidate.featureDefinitionId, candidate.fieldName].filter((value) => typeof value === 'string');
  if (names.some(nameIsOutcome)) return { status: 'BLOCKED', code: 'OUTCOME_DIRECT_FORBIDDEN', mode: 'direct' };
  const provenance = candidate.provenance ?? {};
  const laundered = candidate.recordType === ADMITTED_RECORD_TYPE && typeIsOutcome(provenance.originRecordType);
  const carries = derivationCarriesOutcome(provenance) || typeIsOutcome(candidate.recordType);
  if ((candidate.lag !== undefined && candidate.lag !== null) && (carries || laundered)) {
    return { status: 'BLOCKED', code: 'OUTCOME_LAGGED_FORBIDDEN', mode: 'lagged' };
  }
  if (laundered) return { status: 'BLOCKED', code: 'OUTCOME_SAME_TYPE_LAUNDERING_FORBIDDEN', mode: 'same-type laundering' };
  if (carries) return { status: 'BLOCKED', code: 'OUTCOME_RENAMED_FORBIDDEN', mode: 'renamed' };
  return { status: 'ALLOWED', code: null, mode: null };
}

/**
 * T-CAUSAL-A, provenance half. An input is admissible only if a trusted canonical
 * producer emitted it as an Observation visible at or before K(T).
 */
export function admitObservationInput({ input, knowledgeCutoff }) {
  const outcome = refuseOutcomeAsFeature(input);
  if (outcome.status !== 'ALLOWED') return outcome;
  const provenance = input.provenance ?? {};
  if (!TRUSTED_PRODUCER_GATE_IDS.includes(provenance.producerGateId)) {
    return { status: 'BLOCKED', code: 'UNTRUSTED_PRODUCER_FORBIDDEN', mode: null };
  }
  if (input.recordType !== ADMITTED_RECORD_TYPE || provenance.originRecordType !== ADMITTED_RECORD_TYPE) {
    return { status: 'BLOCKED', code: 'NON_OBSERVATION_RECORD_TYPE_FORBIDDEN', mode: null };
  }
  if (typeof knowledgeCutoff !== 'string' || knowledgeCutoff.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'KNOWLEDGE_CUTOFF_REQUIRED', mode: null };
  }
  if (typeof provenance.availableAt !== 'string' || provenance.availableAt.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'AVAILABLE_AT_REQUIRED', mode: null };
  }
  if (provenance.availableAt > knowledgeCutoff) {
    return { status: 'BLOCKED', code: 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN', mode: null };
  }
  return { status: 'ALLOWED', code: null, mode: null, preserved: TRUSTED_CANONICAL_PRODUCER_V1 };
}

/** Admits a whole observation window under both T-CAUSAL claims. */
export function admitObservationWindow({ sessionDate, window, inputs, knowledgeCutoff }) {
  const causalB = assertNoFutureWindowAccess({ sessionDate, window });
  if (causalB.status !== 'ALLOWED') return { status: 'BLOCKED', code: causalB.code, claim: T_CAUSAL_CLAIMS_V1[1] };
  for (const input of inputs) {
    const admitted = admitObservationInput({ input, knowledgeCutoff });
    if (admitted.status !== 'ALLOWED') return { ...admitted, claim: T_CAUSAL_CLAIMS_V1[0] };
  }
  return { status: 'ALLOWED', code: null, claims: T_CAUSAL_CLAIMS_V1, preserved: TRUSTED_CANONICAL_PRODUCER_V1 };
}

/**
 * GATE23 side of the GATE22 consumption boundary. The GATE22 decision is reused
 * verbatim and the GATE23 detector is applied on top of it.
 */
export function authorizeGate23FeatureConsumption(features) {
  const upstream = authorizeConsumption({ gateId: 'GATE23', features });
  if (upstream.status !== 'ALLOWED') return upstream;
  const offender = features.find((feature) => nameIsOutcome(feature));
  return offender === undefined
    ? { status: 'ALLOWED', code: null }
    : { status: 'BLOCKED', code: 'GATE23_OUTCOME_FEATURE_FORBIDDEN', feature: offender };
}

export function describeCausalAdmission() {
  return Object.freeze({
    schemaVersion: CAUSAL_ADMISSION_VERSION,
    claims: T_CAUSAL_CLAIMS_V1,
    claimCount: T_CAUSAL_CLAIM_COUNT,
    outcomeProhibition: OUTCOME_PROHIBITION_MODES_V1,
    preserved: TRUSTED_CANONICAL_PRODUCER_V1,
  });
}
