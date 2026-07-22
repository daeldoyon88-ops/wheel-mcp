/**
 * L4B-I1 pinned macro dataset snapshot: an explicit logical state of ingested
 * macro data (policy + series registry + vintage set) with fully recomputed
 * counters and digests. No feature is derived here; no clock, no network and
 * no latest reference is ever consulted.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  macroOrderedObservationIdentityDigestV1,
  macroOrderedSeriesIdentityDigestV1,
  normalizeMacroDatasetSnapshotManifestV1,
} from '../contracts/macroIngestionContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroVintageSetManifest } from './macroVintageSetL4BV1.mjs';

function expectedSnapshotValue(references, policy, registry, vintageSet) {
  return normalizeMacroDatasetSnapshotManifestV1({
    schemaVersion: MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    macroIngestionPolicyId: references.macroIngestionPolicyId,
    macroSeriesRegistryManifestId: references.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: references.macroVintageSetManifestId,
    jurisdictionCode: policy.jurisdictionCode,
    currencyCode: policy.currencyCode,
    seriesCount: registry.orderedSeriesEntries.length,
    observationCount: vintageSet.observationCount,
    vintageCount: vintageSet.vintageCount,
    firstAvailableAt: vintageSet.firstAvailableAt,
    lastAvailableAt: vintageSet.lastAvailableAt,
    emptySnapshot: vintageSet.vintageCount === 0,
    orderedSeriesIdentityDigest:
      macroOrderedSeriesIdentityDigestV1(registry.orderedSeriesEntries),
    orderedObservationIdentityDigest:
      macroOrderedObservationIdentityDigestV1(vintageSet.orderedObservationEntries),
    orderedVintageIdentityDigest: vintageSet.orderedVintageIdentityDigest,
  });
}

function verifyPinnedComposition(store, references) {
  const verifiedSet = verifyMacroVintageSetManifest({
    store, macroVintageSetManifestId: references.macroVintageSetManifestId,
  });
  if (verifiedSet.vintageSet.macroIngestionPolicyId !== references.macroIngestionPolicyId
      || verifiedSet.vintageSet.macroSeriesRegistryManifestId
      !== references.macroSeriesRegistryManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_REFERENCE_MISMATCH',
      'snapshot references diverge from the pinned vintage set composition');
  }
  return verifiedSet;
}

/**
 * Deterministic snapshot builder: every counter, bound, flag and digest is
 * derived from the verified pinned composition — never accepted from input.
 */
export function buildMacroDatasetSnapshotManifest(input) {
  const api = assertApiInput(input, ['macroIngestionPolicyId',
    'macroSeriesRegistryManifestId', 'macroVintageSetManifestId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  for (const field of ['macroIngestionPolicyId', 'macroSeriesRegistryManifestId',
    'macroVintageSetManifestId']) {
    assertExplicitPinnedMacroId(api[field], field);
    assertCasId(api[field], field);
  }
  const verifiedSet = verifyPinnedComposition(api.store, api);
  const snapshot = expectedSnapshotValue(api, verifiedSet.macroIngestionPolicy,
    verifiedSet.seriesRegistry, verifiedSet.vintageSet);
  const stored = putCanonicalL3(api.store,
    MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION, snapshot);
  verifyMacroDatasetSnapshotManifest({
    store: api.store, macroDatasetSnapshotManifestId: stored.objectId,
  });
  return { macroDatasetSnapshotManifestId: stored.objectId, datasetSnapshot: stored.value };
}

/**
 * Authoritative snapshot verifier: loads the policy, the series registry and
 * the vintage set through their own authoritative verifiers, recomputes every
 * derived field and compares the pinned manifest in CanonicalJSON
 * byte-for-byte.
 */
export function verifyMacroDatasetSnapshotManifest(input) {
  const api = assertApiInput(input, ['macroDatasetSnapshotManifestId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroDatasetSnapshotManifestId, 'macroDatasetSnapshotManifestId');
  assertCasId(api.macroDatasetSnapshotManifestId, 'macroDatasetSnapshotManifestId');
  const raw = readTypedReference(api.store, api.macroDatasetSnapshotManifestId,
    MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION, 'macro dataset snapshot');
  const snapshot = normalizeMacroDatasetSnapshotManifestV1(raw);
  const verifiedSet = verifyPinnedComposition(api.store, snapshot);
  const expected = expectedSnapshotValue(snapshot, verifiedSet.macroIngestionPolicy,
    verifiedSet.seriesRegistry, verifiedSet.vintageSet);
  if (!canonicalValuesEqual(snapshot, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SNAPSHOT_INVALID',
      'snapshot manifest diverges from its recomputed canonical value');
  }
  return {
    macroDatasetSnapshotManifestId: api.macroDatasetSnapshotManifestId,
    datasetSnapshot: snapshot,
    macroIngestionPolicy: verifiedSet.macroIngestionPolicy,
    seriesRegistry: verifiedSet.seriesRegistry,
    vintageSet: verifiedSet.vintageSet,
  };
}
