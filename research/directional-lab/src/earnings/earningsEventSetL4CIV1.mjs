/** Canonical exhaustive set of earnings event identities. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
  earningsOrderedEventIdentityDigestV1,
  normalizeEarningsEventSetManifestV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsEventIdentityCore } from './earningsEventIdentityL4CIV1.mjs';

function expected(ids) {
  const ordered = [...ids].sort();
  return normalizeEarningsEventSetManifestV1({
    schemaVersion: EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
    orderedEventEntries: ordered.map((eventIdentityId) => ({ eventIdentityId })),
    eventCount: ordered.length,
    orderedEventIdentityDigest: earningsOrderedEventIdentityDigestV1(ordered),
  });
}

export function buildEarningsEventSetManifest(input) {
  const api = assertApiInput(input, ['eventIdentityIds']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  if (!Array.isArray(api.eventIdentityIds)
      || new Set(api.eventIdentityIds).size !== api.eventIdentityIds.length) {
    throw new MarketDataL3Error('EARNINGS_EVENT_SET_INVALID',
      'eventIdentityIds must be a unique array');
  }
  for (const id of api.eventIdentityIds) {
    verifyEarningsEventIdentityCore({ store: api.store, eventIdentityId: id });
  }
  const stored = putCanonicalL3(api.store, EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
    expected(api.eventIdentityIds));
  return { earningsEventSetManifestId: stored.objectId, earningsEventSetManifest: stored.value };
}

export function verifyEarningsEventSetManifest(input) {
  const api = assertApiInput(input, ['earningsEventSetManifestId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let manifest;
  try {
    manifest = normalizeEarningsEventSetManifestV1(readTypedReference(api.store,
      api.earningsEventSetManifestId, EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
      'earnings event set'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_EVENT_SET_MISSING',
      'earnings event set is missing or corrupt', { cause });
  }
  for (const entry of manifest.orderedEventEntries) {
    verifyEarningsEventIdentityCore({ store: api.store, eventIdentityId: entry.eventIdentityId });
  }
  if (!canonicalValuesEqual(manifest,
    expected(manifest.orderedEventEntries.map((entry) => entry.eventIdentityId)))) {
    throw new MarketDataL3Error('EARNINGS_EVENT_SET_INVALID',
      'event set diverges from recomputed canonical content');
  }
  return { earningsEventSetManifestId: api.earningsEventSetManifestId,
    earningsEventSetManifest: manifest };
}
