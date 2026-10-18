/**
 * L4C-I2 closed EarningsAsOfResolutionPolicy/1: build and verify the pinned V1
 * singleton. "Latest", wall-clock reads, global CAS scans, network access and
 * unpinned snapshot selection are forbidden by construction.
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
  EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  EARNINGS_AS_OF_RESOLUTION_POLICY_VALUES,
  normalizeEarningsAsOfResolutionPolicyV1,
} from '../contracts/earningsContractsL4CIIV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  assertExplicitPinnedEarningsIdV1,
} from './earningsIngestionPolicyL4CIV1.mjs';

export function officialEarningsAsOfResolutionPolicyV1() {
  return normalizeEarningsAsOfResolutionPolicyV1({
    schemaVersion: EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(EARNINGS_AS_OF_RESOLUTION_POLICY_VALUES),
  });
}

export function buildEarningsAsOfResolutionPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const stored = putCanonicalL3(api.store, EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    officialEarningsAsOfResolutionPolicyV1());
  return {
    earningsAsOfResolutionPolicyId: stored.objectId,
    earningsAsOfResolutionPolicy: stored.value,
  };
}

export function verifyEarningsAsOfResolutionPolicy(input) {
  const api = assertApiInput(input, ['earningsAsOfResolutionPolicyId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsAsOfResolutionPolicyId,
    'earningsAsOfResolutionPolicyId');
  let policy;
  try {
    policy = normalizeEarningsAsOfResolutionPolicyV1(readTypedReference(api.store,
      api.earningsAsOfResolutionPolicyId, EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
      'earnings as-of resolution policy'));
  } catch (cause) {
    if (cause instanceof MarketDataL3Error && cause.code === 'EARNINGS_AS_OF_POLICY_INVALID') {
      throw cause;
    }
    throw new MarketDataL3Error('EARNINGS_AS_OF_POLICY_MISSING',
      'earnings as-of resolution policy is missing or corrupt', { cause });
  }
  if (!canonicalValuesEqual(policy, officialEarningsAsOfResolutionPolicyV1())) {
    throw new MarketDataL3Error('EARNINGS_AS_OF_POLICY_INVALID',
      'stored as-of resolution policy diverges from the closed V1 singleton');
  }
  return {
    earningsAsOfResolutionPolicyId: api.earningsAsOfResolutionPolicyId,
    earningsAsOfResolutionPolicy: policy,
  };
}
