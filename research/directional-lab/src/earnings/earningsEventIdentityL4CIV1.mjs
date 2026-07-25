/** One SEC accession maps to exactly one minimal earnings EventIdentity. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
  normalizeEarningsEventIdentityCoreV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';

export function buildEarningsEventIdentityCore(input) {
  const api = assertApiInput(input, ['filerCik', 'accessionNumber']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const identity = normalizeEarningsEventIdentityCoreV1({
    schemaVersion: EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
    filerCik: api.filerCik,
    accessionNumber: api.accessionNumber,
  });
  const stored = putCanonicalL3(api.store, EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION, identity);
  return { eventIdentityId: stored.objectId, earningsEventIdentityCore: stored.value };
}

export function verifyEarningsEventIdentityCore(input) {
  const api = assertApiInput(input, ['eventIdentityId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let identity;
  try {
    identity = normalizeEarningsEventIdentityCoreV1(readTypedReference(api.store,
      api.eventIdentityId, EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
      'earnings event identity'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_EVENT_IDENTITY_MISSING',
      'earnings event identity is missing or corrupt', { cause });
  }
  return { eventIdentityId: api.eventIdentityId, earningsEventIdentityCore: identity };
}
