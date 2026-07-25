/** Pinned earnings dataset snapshot, functional no-op and snapshot-only lineage. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_DATASET_SERIES_IDENTITY,
  EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  earningsDatasetIdentityKeyV1,
  earningsFunctionalSnapshotFingerprintV1,
  earningsOrderedMetricObservationIdentityDigestV1,
  normalizeEarningsDatasetSnapshotManifestV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION } from '../data/transformImplementationManifestV2.mjs';
import { verifyEarningsEventSetManifest } from './earningsEventSetL4CIV1.mjs';
import { verifyEarningsExtractionSetManifest } from './earningsExtractionSetL4CIV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  verifyEarningsIngestionPolicy,
} from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsMetricExtractionPolicy } from './earningsMetricExtractionPolicyL4CIV1.mjs';
import { verifyEarningsRevisionIdentityCore } from './earningsRevisionL4CIV1.mjs';
import { verifyEarningsRevisionSetManifest } from './earningsRevisionSetL4CIV1.mjs';
import { verifyEarningsTaxonomyBundleManifest } from './earningsTaxonomyBundleL4CIV1.mjs';

function loadComposition(store, refs) {
  const policy = verifyEarningsIngestionPolicy({
    store, earningsIngestionPolicyId: refs.earningsIngestionPolicyId,
  }).earningsIngestionPolicy;
  const extractionPolicy = verifyEarningsMetricExtractionPolicy({
    store, earningsMetricExtractionPolicyId: refs.earningsMetricExtractionPolicyId,
  }).earningsMetricExtractionPolicy;
  const eventSet = verifyEarningsEventSetManifest({
    store, earningsEventSetManifestId: refs.earningsEventSetManifestId,
  }).earningsEventSetManifest;
  const revisionSet = verifyEarningsRevisionSetManifest({
    store, earningsRevisionSetManifestId: refs.earningsRevisionSetManifestId,
  }).earningsRevisionSetManifest;
  const extractionSet = verifyEarningsExtractionSetManifest({
    store, earningsExtractionSetManifestId: refs.earningsExtractionSetManifestId,
  }).earningsExtractionSetManifest;
  const taxonomy = verifyEarningsTaxonomyBundleManifest({
    store, earningsTaxonomyBundleManifestId: refs.earningsTaxonomyBundleManifestId,
  }).earningsTaxonomyBundleManifest;
  try {
    readTypedReference(store, refs.transformImplementationManifestId,
      TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, 'transform implementation manifest');
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH',
      'snapshot transform manifest is missing or invalid', { cause });
  }
  if (extractionSet.earningsRevisionSetManifestId !== refs.earningsRevisionSetManifestId) {
    throw new MarketDataL3Error('EARNINGS_REVISION_SET_ID_MISMATCH',
      'snapshot and extraction set revision pins differ');
  }
  if (extractionSet.transformImplementationManifestId
      !== refs.transformImplementationManifestId) {
    throw new MarketDataL3Error('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH',
      'snapshot and extraction set transform pins differ');
  }
  if (extractionSet.earningsMetricExtractionPolicyId
      !== refs.earningsMetricExtractionPolicyId) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_POLICY_ID_MISMATCH',
      'snapshot and extraction set policy pins differ');
  }
  if (extractionSet.earningsTaxonomyBundleManifestId
      !== refs.earningsTaxonomyBundleManifestId) {
    throw new MarketDataL3Error('EARNINGS_TAXONOMY_BUNDLE_ID_MISMATCH',
      'snapshot and extraction set taxonomy pins differ');
  }
  const eventIds = eventSet.orderedEventEntries.map((entry) => entry.eventIdentityId);
  const revisionEventIds = revisionSet.orderedEventChains.map((chain) => chain.eventIdentityId);
  if (eventIds.length !== revisionEventIds.length
      || eventIds.some((id, index) => id !== revisionEventIds[index])) {
    throw new MarketDataL3Error('EARNINGS_REVISION_SET_ID_MISMATCH',
      'EventSet and RevisionSet event identities differ');
  }
  return { policy, extractionPolicy, eventSet, revisionSet, extractionSet, taxonomy };
}

function expectedSnapshot(store, refs, composition, supersedes) {
  const revisionIdentityIds = composition.revisionSet.orderedEventChains
    .map((chain) => chain.orderedRevisions[0].earningsRevisionIdentityId);
  const publicTimes = revisionIdentityIds.map((id) =>
    verifyEarningsRevisionIdentityCore({
      store, earningsRevisionIdentityId: id,
    }).earningsRevisionIdentityCore.publicAvailableAt).sort();
  const observationIds = composition.extractionSet.orderedRevisionExtractionEntries
    .flatMap((entry) => entry.orderedMetricObservationIds);
  return normalizeEarningsDatasetSnapshotManifestV1({
    schemaVersion: EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
    earningsIngestionPolicyId: refs.earningsIngestionPolicyId,
    earningsMetricExtractionPolicyId: refs.earningsMetricExtractionPolicyId,
    earningsEventSetManifestId: refs.earningsEventSetManifestId,
    earningsRevisionSetManifestId: refs.earningsRevisionSetManifestId,
    earningsExtractionSetManifestId: refs.earningsExtractionSetManifestId,
    transformImplementationManifestId: refs.transformImplementationManifestId,
    earningsTaxonomyBundleManifestId: refs.earningsTaxonomyBundleManifestId,
    jurisdictionCode: composition.policy.jurisdictionCode,
    currencyCode: composition.policy.currencyCode,
    eventCount: composition.eventSet.eventCount,
    revisionCount: composition.revisionSet.revisionCount,
    extractionReportCount: composition.extractionSet.extractionReportCount,
    metricObservationCount: composition.extractionSet.metricObservationCount,
    firstPublicAvailableAt: publicTimes[0] ?? null,
    lastPublicAvailableAt: publicTimes.at(-1) ?? null,
    emptySnapshot: composition.eventSet.eventCount === 0,
    orderedEventIdentityDigest: composition.eventSet.orderedEventIdentityDigest,
    orderedRevisionIdentityDigest: composition.revisionSet.orderedRevisionIdentityDigest,
    orderedExtractionReportDigest: composition.extractionSet.orderedExtractionReportDigest,
    orderedMetricObservationDigest: composition.extractionSet.orderedMetricObservationDigest,
    orderedMetricObservationIdentityDigest:
      earningsOrderedMetricObservationIdentityDigestV1(observationIds),
    supersedesEarningsDatasetSnapshotManifestId: supersedes,
  });
}

function snapshotDatasetKey(snapshot, policy) {
  return earningsDatasetIdentityKeyV1({
    datasetSeriesIdentity: snapshot.datasetSeriesIdentity,
    jurisdictionCode: snapshot.jurisdictionCode,
    currencyCode: snapshot.currencyCode,
    allowedSourceAuthority: policy.allowedSourceAuthority,
  });
}

function readSnapshot(store, id, missingCode = 'EARNINGS_SNAPSHOT_PARENT_MISSING') {
  try {
    return normalizeEarningsDatasetSnapshotManifestV1(readTypedReference(store, id,
      EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION, 'earnings dataset snapshot'));
  } catch (cause) {
    if (missingCode === 'EARNINGS_SNAPSHOT_PARENT_MISSING'
        && ['EARNINGS_DATASET_SERIES_IDENTITY_INVALID',
          'EARNINGS_JURISDICTION_REJECTED',
          'EARNINGS_CURRENCY_REJECTED_V1'].includes(cause?.code)) {
      throw new MarketDataL3Error('EARNINGS_SNAPSHOT_SUPERSESSION_FOREIGN_DATASET',
        'snapshot parent belongs to another dataset identity', { cause });
    }
    if (missingCode === 'EARNINGS_SNAPSHOT_INVALID'
        && cause?.code === 'EARNINGS_DATASET_SERIES_IDENTITY_INVALID') {
      throw new MarketDataL3Error('EARNINGS_DATASET_SERIES_IDENTITY_MISMATCH',
        'snapshot series diverges from the ingestion policy', { cause });
    }
    throw new MarketDataL3Error(missingCode, 'earnings snapshot is missing or corrupt', { cause });
  }
}

export function buildEarningsDatasetSnapshotManifest(input) {
  const api = assertApiInput(input, [
    'earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
    'earningsEventSetManifestId', 'earningsRevisionSetManifestId',
    'earningsExtractionSetManifestId', 'transformImplementationManifestId',
    'earningsTaxonomyBundleManifestId', 'previousSnapshotId',
  ]);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const composition = loadComposition(api.store, api);
  const candidate = expectedSnapshot(api.store, api, composition, null);
  const fingerprint = earningsFunctionalSnapshotFingerprintV1(candidate);
  if (api.previousSnapshotId !== null) {
    const parent = readSnapshot(api.store, api.previousSnapshotId);
    let parentPolicy;
    try {
      parentPolicy = verifyEarningsIngestionPolicy({
        store: api.store, earningsIngestionPolicyId: parent.earningsIngestionPolicyId,
      }).earningsIngestionPolicy;
    } catch (cause) {
      if (cause?.code === 'EARNINGS_SOURCE_AUTHORITY_REJECTED') {
        throw new MarketDataL3Error('EARNINGS_SNAPSHOT_SUPERSESSION_FOREIGN_DATASET',
          'snapshot parent belongs to another source-authority dataset', { cause });
      }
      throw cause;
    }
    if (snapshotDatasetKey(candidate, composition.policy)
        !== snapshotDatasetKey(parent, parentPolicy)) {
      throw new MarketDataL3Error('EARNINGS_SNAPSHOT_SUPERSESSION_FOREIGN_DATASET',
        'snapshot parent belongs to another dataset identity');
    }
    const parentComposition = loadComposition(api.store, parent);
    const recomputedParent = expectedSnapshot(api.store, parent, parentComposition,
      parent.supersedesEarningsDatasetSnapshotManifestId);
    if (!canonicalValuesEqual(parent, recomputedParent)) {
      throw new MarketDataL3Error('EARNINGS_SNAPSHOT_INVALID',
        'snapshot parent diverges from its recomputed composition');
    }
    if (earningsFunctionalSnapshotFingerprintV1(parent) === fingerprint) {
      return {
        earningsDatasetSnapshotManifestId: api.previousSnapshotId,
        earningsDatasetSnapshotManifest: parent,
        functionalSnapshotFingerprint: fingerprint,
        created: false,
      };
    }
  }
  const snapshot = expectedSnapshot(api.store, api, composition, api.previousSnapshotId);
  const stored = putCanonicalL3(api.store, EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    snapshot);
  return {
    earningsDatasetSnapshotManifestId: stored.objectId,
    earningsDatasetSnapshotManifest: stored.value,
    functionalSnapshotFingerprint: fingerprint,
    created: true,
  };
}

export function verifyEarningsDatasetSnapshotManifest(input) {
  const api = assertApiInput(input, ['earningsDatasetSnapshotManifestId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const seen = new Set();
  let cursorId = api.earningsDatasetSnapshotManifestId;
  let tip;
  let tipComposition;
  let datasetKey;
  while (cursorId !== null) {
    if (seen.has(cursorId)) {
      throw new MarketDataL3Error('EARNINGS_SNAPSHOT_SUPERSESSION_CYCLE',
        'snapshot supersession chain contains a cycle');
    }
    seen.add(cursorId);
    const snapshot = readSnapshot(api.store, cursorId,
      cursorId === api.earningsDatasetSnapshotManifestId
        ? 'EARNINGS_SNAPSHOT_INVALID' : 'EARNINGS_SNAPSHOT_PARENT_MISSING');
    if (snapshot.supersedesEarningsDatasetSnapshotManifestId === cursorId) {
      throw new MarketDataL3Error('EARNINGS_SNAPSHOT_SUPERSESSION_CYCLE',
        'snapshot cannot supersede itself');
    }
    const composition = loadComposition(api.store, snapshot);
    const expected = expectedSnapshot(api.store, snapshot, composition,
      snapshot.supersedesEarningsDatasetSnapshotManifestId);
    if (!canonicalValuesEqual(snapshot, expected)) {
      throw new MarketDataL3Error('EARNINGS_SNAPSHOT_INVALID',
        'snapshot diverges from its recomputed composition');
    }
    const key = snapshotDatasetKey(snapshot, composition.policy);
    if (datasetKey !== undefined && key !== datasetKey) {
      throw new MarketDataL3Error('EARNINGS_SNAPSHOT_SUPERSESSION_FOREIGN_DATASET',
        'snapshot chain crosses dataset identities');
    }
    datasetKey = key;
    if (!tip) { tip = snapshot; tipComposition = composition; }
    cursorId = snapshot.supersedesEarningsDatasetSnapshotManifestId;
  }
  return {
    earningsDatasetSnapshotManifestId: api.earningsDatasetSnapshotManifestId,
    earningsDatasetSnapshotManifest: tip,
    functionalSnapshotFingerprint: earningsFunctionalSnapshotFingerprintV1(tip),
    datasetIdentityKey: datasetKey,
    composition: tipComposition,
  };
}
