/** Canonical 1:1 Event→INITIAL Revision set. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
  earningsOrderedRevisionIdentityDigestV1,
  normalizeEarningsRevisionSetManifestV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsRevisionCore } from './earningsRevisionL4CIV1.mjs';

function expected(verified) {
  const ordered = [...verified].sort((left, right) =>
    left.earningsRevisionCore.eventIdentityId.localeCompare(right.earningsRevisionCore.eventIdentityId));
  const ids = ordered.map((item) => item.earningsRevisionCore.earningsRevisionIdentityId);
  return normalizeEarningsRevisionSetManifestV1({
    schemaVersion: EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
    orderedEventChains: ordered.map((item) => ({
      eventIdentityId: item.earningsRevisionCore.eventIdentityId,
      orderedRevisions: [{
        earningsRevisionIdentityId: item.earningsRevisionCore.earningsRevisionIdentityId,
        earningsRevisionId: item.earningsRevisionId,
        parentRevisionIdentityId: null,
      }],
    })),
    revisionCount: ordered.length,
    orderedRevisionIdentityDigest: earningsOrderedRevisionIdentityDigestV1(ids),
  });
}

export function buildEarningsRevisionSetManifest(input) {
  const api = assertApiInput(input, ['earningsRevisionIds']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  if (!Array.isArray(api.earningsRevisionIds)
      || new Set(api.earningsRevisionIds).size !== api.earningsRevisionIds.length) {
    throw new MarketDataL3Error('EARNINGS_REVISION_SET_INVALID',
      'earningsRevisionIds must be a unique array');
  }
  const verified = api.earningsRevisionIds.map((earningsRevisionId) =>
    verifyEarningsRevisionCore({ store: api.store, earningsRevisionId }));
  const eventIds = verified.map((item) => item.earningsRevisionCore.eventIdentityId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw new MarketDataL3Error('EARNINGS_REVISION_COUNT_PER_EVENT_INVALID',
      'each event must have exactly one INITIAL revision');
  }
  const stored = putCanonicalL3(api.store, EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
    expected(verified));
  return { earningsRevisionSetManifestId: stored.objectId,
    earningsRevisionSetManifest: stored.value };
}

export function verifyEarningsRevisionSetManifest(input) {
  const api = assertApiInput(input, ['earningsRevisionSetManifestId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let manifest;
  try {
    manifest = normalizeEarningsRevisionSetManifestV1(readTypedReference(api.store,
      api.earningsRevisionSetManifestId, EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
      'earnings revision set'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_REVISION_SET_ID_MISMATCH',
      'earnings revision set is missing or corrupt', { cause });
  }
  const verified = manifest.orderedEventChains.map((chain) => {
    const item = verifyEarningsRevisionCore({
      store: api.store, earningsRevisionId: chain.orderedRevisions[0].earningsRevisionId,
    });
    if (item.earningsRevisionCore.eventIdentityId !== chain.eventIdentityId
        || item.earningsRevisionCore.earningsRevisionIdentityId
          !== chain.orderedRevisions[0].earningsRevisionIdentityId
        || item.earningsRevisionCore.revisionKind !== 'INITIAL'
        || item.earningsRevisionCore.parentRevisionIdentityId !== null) {
      throw new MarketDataL3Error('EARNINGS_REVISION_CORE_MISSING',
        'revision set entry diverges from its INITIAL revision core');
    }
    return item;
  });
  if (!canonicalValuesEqual(manifest, expected(verified))) {
    throw new MarketDataL3Error('EARNINGS_REVISION_SET_INVALID',
      'revision set diverges from recomputed canonical content');
  }
  return { earningsRevisionSetManifestId: api.earningsRevisionSetManifestId,
    earningsRevisionSetManifest: manifest };
}

export function earningsRevisionSetTipV1(manifest, eventIdentityId) {
  const chain = manifest.orderedEventChains.find((item) => item.eventIdentityId === eventIdentityId);
  return chain?.orderedRevisions[0]?.earningsRevisionIdentityId ?? null;
}
