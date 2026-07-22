/** L4B-I1 closed ingestion policy: build and verify the pinned V1 singleton. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_INGESTION_POLICY_SCHEMA_VERSION,
  MACRO_INGESTION_POLICY_VALUES,
  normalizeMacroIngestionPolicyV1,
} from '../contracts/macroIngestionContractsL4BV1.mjs';

export const MACRO_STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

/**
 * Explicitly pinned CAS references only: any symbolic "latest" marker is a
 * deterministic failure, never a resolution.
 */
export function assertExplicitPinnedMacroId(value, label) {
  if (typeof value === 'string' && /^latest$/i.test(value.trim())) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_LATEST_FORBIDDEN',
      `${label} must be an explicit pinned CAS reference, not a latest marker`);
  }
}

export function buildMacroIngestionPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, MACRO_STORE_METHODS);
  const policy = normalizeMacroIngestionPolicyV1({
    schemaVersion: MACRO_INGESTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_INGESTION_POLICY_VALUES),
  });
  const stored = putCanonicalL3(api.store, MACRO_INGESTION_POLICY_SCHEMA_VERSION, policy);
  return { macroIngestionPolicyId: stored.objectId, macroIngestionPolicy: stored.value };
}

export function verifyMacroIngestionPolicy(input) {
  const api = assertApiInput(input, ['macroIngestionPolicyId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroIngestionPolicyId, 'macroIngestionPolicyId');
  const raw = readTypedReference(api.store, api.macroIngestionPolicyId,
    MACRO_INGESTION_POLICY_SCHEMA_VERSION, 'macro ingestion policy');
  const policy = normalizeMacroIngestionPolicyV1(raw);
  const expected = normalizeMacroIngestionPolicyV1({
    schemaVersion: MACRO_INGESTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_INGESTION_POLICY_VALUES),
  });
  if (!canonicalValuesEqual(policy, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_POLICY_INVALID',
      'stored macro ingestion policy diverges from the closed V1 singleton');
  }
  return { macroIngestionPolicyId: api.macroIngestionPolicyId, macroIngestionPolicy: policy };
}
