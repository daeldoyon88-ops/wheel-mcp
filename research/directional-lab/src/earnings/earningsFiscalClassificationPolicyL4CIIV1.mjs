/**
 * L4C-I2 closed EarningsFiscalClassificationPolicy/1: build and verify the
 * pinned V1 singleton. The policy keeps its own lifecycle, separate from the
 * as-of policy, so that changing one never invalidates bindings that only
 * depend on the other.
 *
 * No fiscal calendar authority exists and none may be inferred: every fiscal
 * fact must come from the DEI metadata of the filing's own pinned bytes.
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
  EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
  EARNINGS_FISCAL_CLASSIFICATION_POLICY_VALUES,
  normalizeEarningsFiscalClassificationPolicyV1,
} from '../contracts/earningsContractsL4CIIV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  assertExplicitPinnedEarningsIdV1,
} from './earningsIngestionPolicyL4CIV1.mjs';

export function officialEarningsFiscalClassificationPolicyV1() {
  return normalizeEarningsFiscalClassificationPolicyV1({
    schemaVersion: EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
    ...structuredClone(EARNINGS_FISCAL_CLASSIFICATION_POLICY_VALUES),
  });
}

export function buildEarningsFiscalClassificationPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const stored = putCanonicalL3(api.store, EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
    officialEarningsFiscalClassificationPolicyV1());
  return {
    earningsFiscalClassificationPolicyId: stored.objectId,
    earningsFiscalClassificationPolicy: stored.value,
  };
}

export function verifyEarningsFiscalClassificationPolicy(input) {
  const api = assertApiInput(input, ['earningsFiscalClassificationPolicyId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsFiscalClassificationPolicyId,
    'earningsFiscalClassificationPolicyId');
  let policy;
  try {
    policy = normalizeEarningsFiscalClassificationPolicyV1(readTypedReference(api.store,
      api.earningsFiscalClassificationPolicyId,
      EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
      'earnings fiscal classification policy'));
  } catch (cause) {
    if (cause instanceof MarketDataL3Error && cause.code === 'EARNINGS_FISCAL_POLICY_INVALID') {
      throw cause;
    }
    throw new MarketDataL3Error('EARNINGS_FISCAL_POLICY_MISSING',
      'earnings fiscal classification policy is missing or corrupt', { cause });
  }
  if (!canonicalValuesEqual(policy, officialEarningsFiscalClassificationPolicyV1())) {
    throw new MarketDataL3Error('EARNINGS_FISCAL_POLICY_INVALID',
      'stored fiscal classification policy diverges from the closed V1 singleton');
  }
  return {
    earningsFiscalClassificationPolicyId: api.earningsFiscalClassificationPolicyId,
    earningsFiscalClassificationPolicy: policy,
  };
}
