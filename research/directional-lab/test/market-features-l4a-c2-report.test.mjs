import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import {
  MARKET_SEASONALITY_CONFIGURED_HORIZON_WINDOW_PAIR_COUNT,
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
  MARKET_SEASONALITY_FEATURE_L4_SCHEMA_VERSIONS,
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
import { deriveMarketSeasonalityFeatureComputationArtifactsV1 } from '../src/features/marketSeasonalityOccurrenceEngineL4V1.mjs';
import { MARKET_SEASONALITY_RUNTIME_POLICY_V1 as RUNTIME } from '../src/features/marketSeasonalityRuntimePolicyL4V1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import { withOfficialL4Binding } from './marketFeaturesL4SyntheticPipeline.mjs';
import { makeSeasonalityCausalFixture } from './marketSeasonalityL4SyntheticFixture.mjs';

const ID = `sha256:${'a'.repeat(64)}`;
const HASH = `sha256:${'f'.repeat(64)}`;

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

function validEmptyReport() {
  return deriveMarketSeasonalityFeatureComputationReportValueV1({
    seasonalityFeatureSourceBundleId: ID,
    seasonalityFeatureComputationPolicyId: ID,
    seasonalityFeatureRowsId: ID,
    sourceBundle: emptySourceBundle(),
    document: { schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION, rows: [] },
    occurrenceUnions: emptyUnions(),
  });
}

test('L4A-C2 report normalize accepts a closed empty report', () => {
  const report = validEmptyReport();
  assert.deepEqual(normalizeMarketSeasonalityFeatureComputationReportV1(report), report);
  assert.equal(report.schemaVersion, MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION);
  assert.equal(report.configuredHorizonWindowPairCount, 20);
  assert.equal(report.configuredHorizonWindowPairCount, MARKET_SEASONALITY_CONFIGURED_HORIZON_WINDOW_PAIR_COUNT);
  assert.equal(report.emptySnapshot, true);
  assert.equal(report.rowCount, 0);
});

test('L4A-C2 report refuses unknown enumerable key', () => {
  assert.throws(
    () => normalizeMarketSeasonalityFeatureComputationReportV1({ ...validEmptyReport(), alien: true }),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
  );
});

test('L4A-C2 report refuses non-enumerable own key', () => {
  const report = validEmptyReport();
  Object.defineProperty(report, 'hidden', { value: true, enumerable: false });
  assert.throws(
    () => normalizeMarketSeasonalityFeatureComputationReportV1(report),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
  );
});

test('L4A-C2 report refuses accessor own key', () => {
  const report = validEmptyReport();
  Object.defineProperty(report, 'rowCount', { get: () => 0, enumerable: true });
  assert.throws(
    () => normalizeMarketSeasonalityFeatureComputationReportV1(report),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
  );
});

test('L4A-C2 report refuses Symbol own key', () => {
  const report = validEmptyReport();
  report[Symbol('alien')] = true;
  assert.throws(
    () => normalizeMarketSeasonalityFeatureComputationReportV1(report),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
  );
});

test('L4A-C2 report refuses bad schemaVersion', () => {
  assert.throws(
    () => normalizeMarketSeasonalityFeatureComputationReportV1({
      ...validEmptyReport(),
      schemaVersion: 'MarketSeasonalityFeatureComputationReport/0',
    }),
    (error) => error?.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED'
      || error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
  );
});

for (const [name, mutate] of [
  ['emptySnapshot true with rowCount 1', (r) => {
    r.rowCount = 1;
    r.emptySnapshot = true;
    r.firstSessionDate = '2024-01-02';
    r.lastSessionDate = '2024-01-02';
  }],
  ['emptySnapshot false with rowCount 0', (r) => {
    r.emptySnapshot = false;
  }],
  ['rowCount 0 with dates', (r) => {
    r.firstSessionDate = '2024-01-02';
    r.lastSessionDate = '2024-01-02';
  }],
  ['rowCount 1 with null dates', (r) => {
    r.rowCount = 1;
    r.emptySnapshot = false;
    r.firstSessionDate = null;
    r.lastSessionDate = null;
  }],
]) {
  test(`L4A-C2 report refuses inconsistent ${name}`, () => {
    const report = validEmptyReport();
    mutate(report);
    assert.throws(
      () => normalizeMarketSeasonalityFeatureComputationReportV1(report),
      (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
    );
  });
}

for (const digest of ['sha256:abc', 'md5:ff', 'sha256:' + 'g'.repeat(64), '', 'sha256:' + 'a'.repeat(63)]) {
  test(`L4A-C2 report refuses bad digest format ${digest.slice(0, 24)}`, () => {
    assert.throws(
      () => normalizeMarketSeasonalityFeatureComputationReportV1({
        ...validEmptyReport(),
        orderedRowIdentityDigest: digest,
      }),
      (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
    );
  });
}

test('L4A-C2 report requires configuredHorizonWindowPairCount=20', () => {
  assert.throws(
    () => normalizeMarketSeasonalityFeatureComputationReportV1({
      ...validEmptyReport(),
      configuredHorizonWindowPairCount: 19,
    }),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
  );
});

test('L4A-C2 ordered identity digest is stable for empty rows', () => {
  assert.equal(
    computeSeasonalityOrderedRowIdentityDigestV1([]),
    computeSeasonalityOrderedRowIdentityDigestV1([]),
  );
  assert.match(computeSeasonalityOrderedRowIdentityDigestV1([]), /^sha256:[0-9a-f]{64}$/);
});

test('L4A-C2 ordered identity digest changes with one vs two rows', () => {
  const one = [{ sessionDate: '2024-01-02', subjectBarIdentityId: ID }];
  const two = [
    { sessionDate: '2024-01-02', subjectBarIdentityId: ID },
    { sessionDate: '2024-01-03', subjectBarIdentityId: `sha256:${'b'.repeat(64)}` },
  ];
  assert.notEqual(
    computeSeasonalityOrderedRowIdentityDigestV1(one),
    computeSeasonalityOrderedRowIdentityDigestV1(two),
  );
});

test('L4A-C2 ordered identity digest changes when row order swaps', () => {
  const a = { sessionDate: '2024-01-02', subjectBarIdentityId: `sha256:${'1'.repeat(64)}` };
  const b = { sessionDate: '2024-01-03', subjectBarIdentityId: `sha256:${'2'.repeat(64)}` };
  assert.notEqual(
    computeSeasonalityOrderedRowIdentityDigestV1([a, b]),
    computeSeasonalityOrderedRowIdentityDigestV1([b, a]),
  );
});

test('L4A-C2 ordered identity digest ignores non-identity field changes', () => {
  const base = {
    sessionDate: '2024-01-02',
    subjectBarIdentityId: ID,
    occurrenceCount: 0,
    meanReturn: { atoms: '0', scale: 12 },
  };
  const mutated = { ...base, occurrenceCount: 99, meanReturn: { atoms: '1', scale: 12 } };
  assert.equal(
    computeSeasonalityOrderedRowIdentityDigestV1([base]),
    computeSeasonalityOrderedRowIdentityDigestV1([mutated]),
  );
});

test('L4A-C2 official compute builds report with closed counters and family version', () => (
  withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifestC2(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const policy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    const computed = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    const verified = verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: computed.seasonalityFeatureComputationReportId,
    });
    const report = verified.seasonalityFeatureComputationReport;
    assert.equal(report.rowCount, 2);
    assert.equal(report.emptySnapshot, false);
    assert.match(report.orderedRowIdentityDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.featureFamilyVersion, MARKET_SEASONALITY_FEATURE_FAMILY_VERSION);
    assert.equal(report.configuredHorizonWindowPairCount, 20);
    assert.equal(
      report.orderedRowIdentityDigest,
      computeSeasonalityOrderedRowIdentityDigestV1(verified.seasonalityFeatureRows.rows),
    );
  })
));

test('L4A-C2 anti-double-count: distinctOccurrenceCount <= Σ occurrenceCountSum; forge refused', () => {
  const fixture = makeSeasonalityCausalFixture();
  const artifacts = deriveMarketSeasonalityFeatureComputationArtifactsV1({
    sourceBundleId: fixture.sourceBundleId,
    computationPolicyId: fixture.computationPolicyId,
    sourceBundle: fixture.sourceBundle,
    sourceRows: fixture.sourceRows,
    calendarSessions: fixture.calendarSessions,
    calendarCoverage: fixture.calendarCoverage,
  }, RUNTIME);
  const report = deriveMarketSeasonalityFeatureComputationReportValueV1({
    seasonalityFeatureSourceBundleId: ID,
    seasonalityFeatureComputationPolicyId: ID,
    seasonalityFeatureRowsId: ID,
    sourceBundle: {
      ...emptySourceBundle(),
      subjectBindingId: fixture.sourceBundle.subjectBindingId,
      instrumentIdentityId: fixture.sourceBundle.instrumentIdentityId,
    },
    document: artifacts.document,
    occurrenceUnions: artifacts.occurrenceUnions,
  });
  const sumOcc = Object.values(report.countsByHorizon)
    .reduce((sum, bucket) => sum + bucket.occurrenceCountSum, 0);
  assert.ok(report.distinctOccurrenceCount <= sumOcc);
  assert.ok(report.distinctOccurrenceCount < sumOcc, 'nested horizons must not equal raw Σ');

  return withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifestC2(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const policy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    const computed = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    const verified = verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: computed.seasonalityFeatureComputationReportId,
    });
    const official = verified.seasonalityFeatureComputationReport;
    const officialSum = Object.values(official.countsByHorizon)
      .reduce((sum, bucket) => sum + bucket.occurrenceCountSum, 0);
    assert.ok(official.distinctOccurrenceCount <= officialSum);
    const forgedDistinct = official.distinctOccurrenceCount === officialSum
      ? officialSum + 1
      : officialSum;
    const forged = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
      value: { ...official, distinctOccurrenceCount: forgedDistinct },
    });
    assert.throws(
      () => verifyMarketSeasonalityFeatureComputation({
        store, seasonalityFeatureComputationReportId: forged.objectId,
      }),
      (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_MISMATCH',
    );
  });
});

test('L4A-C2 report remains registered before the three C3 publication schemas, normalized=5', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 132);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 132);
  assert.equal(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION),
    true,
  );
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-46, -43), [
    ...MARKET_SEASONALITY_FEATURE_L4_SCHEMA_VERSIONS,
  ]);
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  assert.equal(
    NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION),
    true,
  );
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes('MarketFeaturePublicationManifest/1'), true);
  for (const absent of [
    'MarketSeasonalityFeaturePublicationManifest/1',
    'SeasonalityFeaturePublication/1',
  ]) {
    assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(absent), false, absent);
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(absent), false, absent);
  }
});
