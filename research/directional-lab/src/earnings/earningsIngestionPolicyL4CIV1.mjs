/** Build and verify the closed L4C-I1 SEC earnings-ingestion policy. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
  EARNINGS_INGESTION_POLICY_VALUES,
  normalizeEarningsIngestionPolicyV1,
} from '../contracts/earningsContractsL4CIV1.mjs';

export const EARNINGS_STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

export function assertExplicitPinnedEarningsIdV1(value, label) {
  if (typeof value === 'string' && /^latest$/i.test(value.trim())) {
    throw new MarketDataL3Error('EARNINGS_POLICY_LATEST_FORBIDDEN',
      `${label} must be an explicit CAS id`);
  }
}

export function officialEarningsIngestionPolicyV1() {
  return normalizeEarningsIngestionPolicyV1({
    schemaVersion: EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(EARNINGS_INGESTION_POLICY_VALUES),
  });
}

export function buildEarningsIngestionPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const stored = putCanonicalL3(api.store, EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
    officialEarningsIngestionPolicyV1());
  return { earningsIngestionPolicyId: stored.objectId, earningsIngestionPolicy: stored.value };
}

export function verifyEarningsIngestionPolicy(input) {
  const api = assertApiInput(input, ['earningsIngestionPolicyId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsIngestionPolicyId, 'earningsIngestionPolicyId');
  let policy;
  try {
    policy = normalizeEarningsIngestionPolicyV1(readTypedReference(api.store,
      api.earningsIngestionPolicyId, EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
      'earnings ingestion policy'));
  } catch (cause) {
    if (cause instanceof MarketDataL3Error && cause.code.startsWith('EARNINGS_')) throw cause;
    throw new MarketDataL3Error('EARNINGS_POLICY_MISSING',
      'earnings ingestion policy is missing or corrupt', { cause });
  }
  if (!canonicalValuesEqual(policy, officialEarningsIngestionPolicyV1())) {
    throw new MarketDataL3Error('EARNINGS_POLICY_INVALID',
      'stored ingestion policy diverges from the closed singleton');
  }
  return { earningsIngestionPolicyId: api.earningsIngestionPolicyId,
    earningsIngestionPolicy: policy };
}
