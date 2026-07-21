import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKET_SEASONALITY_CONFIGURED_HORIZON_WINDOW_PAIR_COUNT,
  MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  normalizeMarketSeasonalityFeatureComputationReportV1,
} from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  buildMarketSeasonalityFeatureComputationPolicy,
  buildMarketSeasonalityFeatureSourceBundle,
  computeMarketSeasonalityFeatures,
  verifyMarketSeasonalityFeatureComputation,
} from '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs';
import {
  computeSeasonalityOrderedRowIdentityDigestV1,
  deriveMarketSeasonalityFeatureComputationReportValueV1,
} from '../src/features/marketSeasonalityFeatureReportL4V1.mjs';
import {
  oracleOrderedRowIdentityDigest,
  oracleReportCountersFromRows,
} from './helpers/independentSeasonalityReportOracleL4V1.mjs';
import { withOfficialVolumeStructureBinding } from './marketVolumeStructureL4SyntheticFixture.mjs';

const ID = `sha256:${'a'.repeat(64)}`;
const HASH = `sha256:${'f'.repeat(64)}`;

function emptyUnions() {
  return {
    distinctOccurrenceCount: 0,
    distinctHistoricalYearCount: 0,
    distinctOccurrenceCountByHorizon: { 3: 0, 5: 0, 10: 0, 15: 0 },
    distinctOccurrenceCountByForwardSessionCount: { 5: 0, 10: 0, 20: 0, 40: 0, 60: 0 },
  };
}

function emptySourceBundle() {
  return {
    subjectBindingId: ID,
    instrumentIdentityId: ID,
    normalizedMarketDataObjectId: ID,
    knowledgeCutoff: '2026-01-02T22:00:00.000Z',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    implementationManifestId: ID,
  };
}

function putImplementationManifestC2(store) {
  return store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: 'TransformImplementationManifest/2',
    value: {
      schemaVersion: 'TransformImplementationManifest/2',
      runtimeContractVersion: 'L4A-C2/1',
      moduleHashPolicyVersion: 'TransformSourceText/1',
      modules: [
        'src/contracts/marketSeasonalityFeatureComputationL4V1.mjs',
        'src/contracts/marketSeasonalityFeaturePolicyValuesL4V1.mjs',
        'src/features/marketSeasonalityOccurrenceEngineL4V1.mjs',
        'src/features/marketSeasonalityRuntimePolicyL4V1.mjs',
        'src/features/marketSeasonalityStatisticsL4V1.mjs',
        'src/features/marketSeasonalityFeatureReportL4V1.mjs',
        'src/features/computeMarketSeasonalityFeaturesL4V1.mjs',
      ].map((logicalPath) => ({ logicalPath, canonicalContentSha256: HASH })),
    },
  });
}

function computeEmptyOfficial(options = {}) {
  return withOfficialVolumeStructureBinding([], ({ store, published }) => {
    if (options.noise === true) store.putSourceBytes(Buffer.from('empty-c2-noise'));
    const implementation = putImplementationManifestC2(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const policy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    const first = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    const verified = verifyMarketSeasonalityFeatureComputation({
      store,
      seasonalityFeatureComputationReportId: first.seasonalityFeatureComputationReportId,
    });
    const replay = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    const ids = {
      sourceBundleId: source.seasonalityFeatureSourceBundleId,
      policyId: policy.seasonalityFeatureComputationPolicyId,
      rowsId: first.seasonalityFeatureRowsId,
      reportId: first.seasonalityFeatureComputationReportId,
    };
    const bytes = Object.fromEntries(Object.entries(ids).map(([name, objectId]) => {
      const namespace = name === 'rowsId' ? 'normalized' : 'snapshots';
      return [name, store.readObject({
        uri: store.uriForObject({ namespace, objectId }), expectedObjectId: objectId,
      }).bytes.toString('base64')];
    }));
    return { ids, bytes, verified, replay };
  });
}

test('L4A-C2 empty digest of [] is stable across calls and matches oracle', () => {
  const first = computeSeasonalityOrderedRowIdentityDigestV1([]);
  const second = computeSeasonalityOrderedRowIdentityDigestV1([]);
  assert.equal(first, second);
  assert.equal(first, oracleOrderedRowIdentityDigest([]));
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test('L4A-C2 empty report counters are all zero / null dates / emptySnapshot true', () => {
  const report = deriveMarketSeasonalityFeatureComputationReportValueV1({
    seasonalityFeatureSourceBundleId: ID,
    seasonalityFeatureComputationPolicyId: ID,
    seasonalityFeatureRowsId: ID,
    sourceBundle: emptySourceBundle(),
    document: { schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION, rows: [] },
    occurrenceUnions: emptyUnions(),
  });
  const normalized = normalizeMarketSeasonalityFeatureComputationReportV1(report);
  assert.equal(normalized.emptySnapshot, true);
  assert.equal(normalized.rowCount, 0);
  assert.equal(normalized.firstSessionDate, null);
  assert.equal(normalized.lastSessionDate, null);
  assert.equal(normalized.partialCurrentWindowCount, 0);
  assert.equal(normalized.completedCurrentWindowCount, 0);
  assert.equal(normalized.distinctOccurrenceCount, 0);
  assert.equal(normalized.distinctHistoricalYearCount, 0);
  assert.equal(normalized.configuredHorizonWindowPairCount, MARKET_SEASONALITY_CONFIGURED_HORIZON_WINDOW_PAIR_COUNT);
  assert.equal(normalized.featureFamilyVersion, MARKET_SEASONALITY_FEATURE_FAMILY_VERSION);
  assert.deepEqual(normalized.availabilityCounts, {
    availableHorizonWindowCount: 0,
    unavailableHorizonWindowCount: 0,
  });
  for (const bucket of Object.values(normalized.countsByHorizon)) {
    assert.deepEqual(bucket, {
      rowPresenceCount: 0,
      occurrenceCountSum: 0,
      distinctOccurrenceCount: 0,
    });
  }
  for (const bucket of Object.values(normalized.countsByForwardSessionCount)) {
    assert.deepEqual(bucket, {
      rowPresenceCount: 0,
      occurrenceCountSum: 0,
      distinctOccurrenceCount: 0,
    });
  }
  for (const count of Object.values(normalized.primaryAvailabilityReasonCounts)) {
    assert.equal(count, 0);
  }
  for (const count of Object.values(normalized.rejectedOccurrenceCounts)) {
    assert.equal(count, 0);
  }
  for (const count of Object.values(normalized.currentWindowStatusCounts)) {
    assert.equal(count, 0);
  }
  assert.equal(normalized.orderedRowIdentityDigest, computeSeasonalityOrderedRowIdentityDigestV1([]));
});

test('L4A-C2 empty oracle counters match derived empty report row-derivable fields', () => {
  const report = deriveMarketSeasonalityFeatureComputationReportValueV1({
    seasonalityFeatureSourceBundleId: ID,
    seasonalityFeatureComputationPolicyId: ID,
    seasonalityFeatureRowsId: ID,
    sourceBundle: emptySourceBundle(),
    document: { schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION, rows: [] },
    occurrenceUnions: emptyUnions(),
  });
  const oracle = oracleReportCountersFromRows(
    { rows: [] },
    emptyUnions(),
  );
  assert.equal(oracle.rowCount, report.rowCount);
  assert.equal(oracle.emptySnapshot, report.emptySnapshot);
  assert.equal(oracle.firstSessionDate, report.firstSessionDate);
  assert.equal(oracle.lastSessionDate, report.lastSessionDate);
  assert.equal(oracle.orderedRowIdentityDigest, report.orderedRowIdentityDigest);
  assert.deepEqual(oracle.availabilityCounts, report.availabilityCounts);
  assert.deepEqual(oracle.primaryAvailabilityReasonCounts, report.primaryAvailabilityReasonCounts);
  assert.deepEqual(oracle.rejectedOccurrenceCounts, report.rejectedOccurrenceCounts);
  assert.deepEqual(oracle.currentWindowStatusCounts, report.currentWindowStatusCounts);
  assert.equal(oracle.partialCurrentWindowCount, report.partialCurrentWindowCount);
  assert.equal(oracle.completedCurrentWindowCount, report.completedCurrentWindowCount);
  assert.equal(oracle.distinctOccurrenceCount, report.distinctOccurrenceCount);
});

test('L4A-C2 empty OHLCV binding: full compute + verifier PASS + replay', () => {
  const captured = computeEmptyOfficial();
  assert.equal(captured.verified.seasonalityFeatureRows.rows.length, 0);
  assert.equal(captured.verified.seasonalityFeatureComputationReport.rowCount, 0);
  assert.equal(captured.verified.seasonalityFeatureComputationReport.emptySnapshot, true);
  assert.equal(captured.verified.seasonalityFeatureComputationReport.firstSessionDate, null);
  assert.equal(captured.verified.seasonalityFeatureComputationReport.lastSessionDate, null);
  assert.equal(
    captured.verified.seasonalityFeatureComputationReport.orderedRowIdentityDigest,
    computeSeasonalityOrderedRowIdentityDigestV1([]),
  );
  assert.equal(captured.replay.seasonalityFeatureRowsId, captured.ids.rowsId);
  assert.equal(captured.replay.seasonalityFeatureComputationReportId, captured.ids.reportId);
});

test('L4A-C2 empty multi-store: identical rows+report bytes and ids with insertion noise', () => {
  const first = computeEmptyOfficial({ noise: false });
  const second = computeEmptyOfficial({ noise: true });
  assert.deepEqual(first.ids, second.ids);
  assert.deepEqual(first.bytes, second.bytes);
});

test('L4A-C2 empty path remains independent of withStore orphan noise', () => {
  const baseline = computeEmptyOfficial({ noise: false });
  const noisy = computeEmptyOfficial({ noise: true });
  assert.deepEqual(baseline.ids, noisy.ids);
  assert.deepEqual(baseline.bytes, noisy.bytes);
});
