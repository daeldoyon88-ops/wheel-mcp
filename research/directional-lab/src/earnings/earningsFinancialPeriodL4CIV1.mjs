/** Raw INSTANT/DURATION financial-period identities. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
  normalizeFinancialPeriodIdentityCoreV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';

export function assertNoDerivedFinancialPeriodV1(value) {
  if (value?.derived === true || value?.derivation || value?.periodType === 'Q4') {
    throw new MarketDataL3Error('EARNINGS_DERIVED_PERIOD_FORBIDDEN',
      'derived fiscal periods are forbidden in L4C-I1');
  }
}

export function buildFinancialPeriodIdentityCore(input) {
  const api = assertApiInput(input, ['periodType', 'periodStart', 'periodEnd']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const period = normalizeFinancialPeriodIdentityCoreV1({
    schemaVersion: FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
    periodType: api.periodType,
    periodStart: api.periodStart,
    periodEnd: api.periodEnd,
  });
  const stored = putCanonicalL3(api.store, FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION, period);
  return { financialPeriodIdentityId: stored.objectId, financialPeriodIdentityCore: stored.value };
}

export function verifyFinancialPeriodIdentityCore(input) {
  const api = assertApiInput(input, ['financialPeriodIdentityId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let period;
  try {
    period = normalizeFinancialPeriodIdentityCoreV1(readTypedReference(api.store,
      api.financialPeriodIdentityId, FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
      'financial period identity'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_PERIOD_MISSING',
      'financial period identity is missing or corrupt', { cause });
  }
  return { financialPeriodIdentityId: api.financialPeriodIdentityId,
    financialPeriodIdentityCore: period };
}
