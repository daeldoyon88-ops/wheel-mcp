/**
 * L4B-F2 closed MarketMacroInstrumentProjectionPolicy/1 singleton builder and
 * verifier. The policy forbids latest, network, score, ranking and
 * recommendation and pins the CPI/UNRATE/claims thresholds.
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
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
  normalizeMarketMacroInstrumentProjectionPolicyV1,
} from '../contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';

export function buildMarketMacroInstrumentProjectionPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, MACRO_STORE_METHODS);
  const policy = normalizeMarketMacroInstrumentProjectionPolicyV1({
    schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
  });
  const stored = putCanonicalL3(api.store, MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
    policy);
  return {
    instrumentProjectionPolicyId: stored.objectId,
    instrumentProjectionPolicy: stored.value,
  };
}

export function verifyMarketMacroInstrumentProjectionPolicy(input) {
  const api = assertApiInput(input, ['instrumentProjectionPolicyId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.instrumentProjectionPolicyId, 'instrumentProjectionPolicyId');
  const raw = readTypedReference(api.store, api.instrumentProjectionPolicyId,
    MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION, 'macro instrument projection policy');
  const policy = normalizeMarketMacroInstrumentProjectionPolicyV1(raw);
  const expected = normalizeMarketMacroInstrumentProjectionPolicyV1({
    schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
  });
  if (!canonicalValuesEqual(policy, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_INSTRUMENT_POLICY_MISMATCH',
      'stored macro instrument projection policy diverges from the closed V1 singleton');
  }
  return {
    instrumentProjectionPolicyId: api.instrumentProjectionPolicyId,
    instrumentProjectionPolicy: policy,
  };
}
