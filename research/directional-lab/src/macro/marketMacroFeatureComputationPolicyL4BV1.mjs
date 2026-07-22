/**
 * L4B-F1 closed MarketMacroFeatureComputationPolicy/1 singleton builder/verifier.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES,
  normalizeMarketMacroFeatureComputationPolicyV1,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';

export function buildMarketMacroFeatureComputationPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, MACRO_STORE_METHODS);
  const policy = normalizeMarketMacroFeatureComputationPolicyV1({
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
  });
  const stored = putCanonicalL3(api.store, MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    policy);
  return {
    featureComputationPolicyId: stored.objectId,
    featureComputationPolicy: stored.value,
  };
}

export function verifyMarketMacroFeatureComputationPolicy(input) {
  const api = assertApiInput(input, ['featureComputationPolicyId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.featureComputationPolicyId, 'featureComputationPolicyId');
  const raw = readTypedReference(api.store, api.featureComputationPolicyId,
    MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, 'macro feature computation policy');
  const policy = normalizeMarketMacroFeatureComputationPolicyV1(raw);
  const expected = normalizeMarketMacroFeatureComputationPolicyV1({
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
  });
  if (!canonicalValuesEqual(policy, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_POLICY_MISMATCH',
      'stored macro feature computation policy diverges from the closed V1 singleton');
  }
  return {
    featureComputationPolicyId: api.featureComputationPolicyId,
    featureComputationPolicy: policy,
  };
}
