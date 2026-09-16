/**
 * GATE26 combination policy V1: inspectable, weightless, fail-closed abstention.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { failClosed, assertClosedKeys } from './ensemble-identity-v1.mjs';

export const COMBINATION_POLICY_SCHEMA_V1 = 'GATE26_COMBINATION_POLICY_V1';
export const FAMILIES_V1 = Object.freeze([
  'ANALOGUE_OUTCOME_FAMILY',
  'ANALOGUE_SUPPORT_FAMILY',
  'REGIME_BINDING_FAMILY',
]);
export const ABSTAIN_REASONS_V1 = Object.freeze([
  'QUERY_NOT_COMPARABLE',
  'INSUFFICIENT_SUPPORT',
  'ANALOGUE_ABSTAIN',
  'PREDICTIVE_FAMILY_MISSING',
  'STALE_OR_WRONG_VERSION',
  'HORIZON_NOT_ADMISSIBLE',
  'LEAKAGE_ATTEMPT',
  'PROVENANCE_OR_IDENTITY_MISMATCH',
  'REGISTERED_DISAGREEMENT',
  'INSUFFICIENT_EVIDENCE',
  'CONSUMER_VERSION_MISMATCH',
]);
export const COMBINATION_POLICY_FIELDS_V1 = Object.freeze([
  'schema', 'policyId', 'weights', 'winnerTakeAll', 'missingFamily', 'insufficientSupport',
  'disagreementWhenSecondFamilyRegistered', 'degradedInput', 'familiesV1', 'abstainReasons',
]);

export function createCombinationPolicy(binding) {
  assertClosedKeys(binding, COMBINATION_POLICY_FIELDS_V1, 'COMBINATION_POLICY_NOT_CLOSED');
  if (binding.schema !== COMBINATION_POLICY_SCHEMA_V1) failClosed('COMBINATION_POLICY_SCHEMA_INVALID');
  if (binding.weights !== 'FORBIDDEN_IN_V1_NO_CALIBRATION_EVIDENCE') failClosed('COMBINATION_WEIGHTS_FORBIDDEN');
  if (binding.winnerTakeAll !== 'FORBIDDEN') failClosed('WINNER_TAKE_ALL_FORBIDDEN');
  if (binding.missingFamily !== 'ABSTAIN' || binding.insufficientSupport !== 'ABSTAIN') failClosed('COMBINATION_ABSTAIN_RULE_INVALID');
  if (binding.disagreementWhenSecondFamilyRegistered !== 'ABSTAIN') failClosed('COMBINATION_DISAGREEMENT_RULE_INVALID');
  if (binding.degradedInput !== 'FAIL_CLOSED') failClosed('COMBINATION_DEGRADED_INPUT_RULE_INVALID');
  if (!Array.isArray(binding.familiesV1) || binding.familiesV1.length !== FAMILIES_V1.length
    || FAMILIES_V1.some((family, index) => binding.familiesV1[index] !== family)) {
    failClosed('COMBINATION_FAMILIES_V1_INVALID');
  }
  return Object.freeze({
    ...binding,
    combinationPolicyVersionId: sha256Canonical(binding),
  });
}

export function refusePermissiveFallback() {
  failClosed('PERMISSIVE_FALLBACK_FORBIDDEN');
}

export function refuseForcedNonAbstention() {
  failClosed('FORCED_NON_ABSTENTION_FORBIDDEN');
}

export function refuseProbabilityClaim(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 32) return true;
  if (Array.isArray(node)) return node.every((item) => refuseProbabilityClaim(item, depth + 1));
  for (const key of Object.keys(node)) {
    if (['probability', 'probabilities', 'calibratedProbability', 'confidenceScalar', 'pValue', 'score'].includes(key)
      && node[key] !== null) {
      failClosed('PROBABILITY_CLAIM_FORBIDDEN', { key });
    }
    refuseProbabilityClaim(node[key], depth + 1);
  }
  return true;
}
