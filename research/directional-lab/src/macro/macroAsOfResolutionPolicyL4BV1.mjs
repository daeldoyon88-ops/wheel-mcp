/**
 * L4B-I2 closed MacroAsOfResolutionPolicy/1: build and verify the pinned V1
 * singleton. Latest, permissive cutoffs and unpinned registry scans are
 * forbidden by construction.
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
  MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  MACRO_AS_OF_RESOLUTION_POLICY_VALUES,
  normalizeMacroAsOfResolutionPolicyV1,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';

export function buildMacroAsOfResolutionPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, MACRO_STORE_METHODS);
  const policy = normalizeMacroAsOfResolutionPolicyV1({
    schemaVersion: MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_AS_OF_RESOLUTION_POLICY_VALUES),
  });
  const stored = putCanonicalL3(api.store, MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION, policy);
  return {
    macroAsOfResolutionPolicyId: stored.objectId,
    macroAsOfResolutionPolicy: stored.value,
  };
}

export function verifyMacroAsOfResolutionPolicy(input) {
  const api = assertApiInput(input, ['macroAsOfResolutionPolicyId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroAsOfResolutionPolicyId, 'macroAsOfResolutionPolicyId');
  const raw = readTypedReference(api.store, api.macroAsOfResolutionPolicyId,
    MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION, 'macro as-of resolution policy');
  const policy = normalizeMacroAsOfResolutionPolicyV1(raw);
  const expected = normalizeMacroAsOfResolutionPolicyV1({
    schemaVersion: MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_AS_OF_RESOLUTION_POLICY_VALUES),
  });
  if (!canonicalValuesEqual(policy, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_POLICY_INVALID',
      'stored macro as-of resolution policy diverges from the closed V1 singleton');
  }
  return {
    macroAsOfResolutionPolicyId: api.macroAsOfResolutionPolicyId,
    macroAsOfResolutionPolicy: policy,
  };
}
