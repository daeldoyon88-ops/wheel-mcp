/** Build and verify the closed L4C-I1 XBRL metric-extraction policy. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
  EARNINGS_METRIC_EXTRACTION_POLICY_VALUES,
  normalizeEarningsMetricExtractionPolicyV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  assertExplicitPinnedEarningsIdV1,
} from './earningsIngestionPolicyL4CIV1.mjs';

export function officialEarningsMetricExtractionPolicyV1() {
  return normalizeEarningsMetricExtractionPolicyV1({
    schemaVersion: EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(EARNINGS_METRIC_EXTRACTION_POLICY_VALUES),
  });
}

export function buildEarningsMetricExtractionPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const stored = putCanonicalL3(api.store, EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
    officialEarningsMetricExtractionPolicyV1());
  return {
    earningsMetricExtractionPolicyId: stored.objectId,
    earningsMetricExtractionPolicy: stored.value,
  };
}

export function verifyEarningsMetricExtractionPolicy(input) {
  const api = assertApiInput(input, ['earningsMetricExtractionPolicyId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsMetricExtractionPolicyId,
    'earningsMetricExtractionPolicyId');
  let policy;
  try {
    policy = normalizeEarningsMetricExtractionPolicyV1(readTypedReference(api.store,
      api.earningsMetricExtractionPolicyId, EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
      'earnings metric extraction policy'));
  } catch (cause) {
    if (cause instanceof MarketDataL3Error && cause.code.startsWith('EARNINGS_')) throw cause;
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_POLICY_ID_MISMATCH',
      'extraction policy is missing or corrupt', { cause });
  }
  if (!canonicalValuesEqual(policy, officialEarningsMetricExtractionPolicyV1())) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_POLICY_INVALID',
      'stored extraction policy diverges from the closed singleton');
  }
  return {
    earningsMetricExtractionPolicyId: api.earningsMetricExtractionPolicyId,
    earningsMetricExtractionPolicy: policy,
  };
}
