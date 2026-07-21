import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildMarketSeasonalityFeatureComputationPolicy,
  buildMarketSeasonalityFeatureSourceBundle,
  computeMarketSeasonalityFeatures,
  verifyMarketSeasonalityFeatureComputation,
} from '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs';
import { findIndependentOracleSourcePolicyViolations } from './helpers/independentOracleSourcePolicyL4V1.mjs';
import {
  REPORT_ORACLE_VECTORS,
  oracleOrderedRowIdentityDigest,
  oracleReportCountersFromRows,
} from './helpers/independentSeasonalityReportOracleL4V1.mjs';
import { withOfficialL4Binding } from './marketFeaturesL4SyntheticPipeline.mjs';

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

test('L4A-C2 report oracle helper is statically isolated from builder/verifier/engine', () => {
  const source = readFileSync(
    new URL('./helpers/independentSeasonalityReportOracleL4V1.mjs', import.meta.url), 'utf8',
  );
  const violations = findIndependentOracleSourcePolicyViolations(source, {
    allowlist: [
      'node:crypto',
      '../../src/canonical/canonicalJsonV1.mjs',
    ],
  });
  assert.deepEqual(violations, []);
  for (const forbidden of [
    'marketSeasonalityFeatureReportL4V1',
    'computeMarketSeasonalityFeaturesL4V1',
    'marketSeasonalityOccurrenceEngineL4V1',
    'verifyMarketSeasonalityFeatureComputation',
    'deriveMarketSeasonalityFeatureComputationReportValueV1',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test('L4A-C2 report oracle exposes at least 20 named vectors', () => {
  assert.ok(REPORT_ORACLE_VECTORS.length >= 20);
});

for (const vector of REPORT_ORACLE_VECTORS) {
  test(`L4A-C2 report oracle vector: ${vector.name}`, () => {
    const actual = oracleReportCountersFromRows(
      { rows: vector.rows },
      vector.unions,
    );
    if (vector.compare === 'identity-subset') {
      assert.equal(actual.orderedRowIdentityDigest, vector.expected.orderedRowIdentityDigest);
      assert.equal(actual.rowCount, vector.expected.rowCount);
      assert.equal(actual.emptySnapshot, vector.expected.emptySnapshot);
      assert.equal(actual.firstSessionDate, vector.expected.firstSessionDate);
      assert.equal(actual.lastSessionDate, vector.expected.lastSessionDate);
      return;
    }
    if (vector.compare === 'digest-diff') {
      assert.equal(vector.expected.digestDiffersFromSibling, true);
      assert.match(oracleOrderedRowIdentityDigest(vector.rows), /^sha256:[0-9a-f]{64}$/);
      return;
    }
    if (vector.compare === 'horizon-presence') {
      for (const [key, expected] of Object.entries(vector.expected.countsByHorizon)) {
        assert.equal(actual.countsByHorizon[key].rowPresenceCount, expected.rowPresenceCount);
      }
      return;
    }
    if (vector.name === 'two-rows-inverted-order-digest-differs') {
      assert.equal(vector.expected._digestDiffersFromCanonical, true);
      assert.equal(actual.rowCount, 2);
      assert.equal(actual.orderedRowIdentityDigest, vector.expected.orderedRowIdentityDigest);
      return;
    }
    for (const field of [
      'rowCount', 'firstSessionDate', 'lastSessionDate', 'emptySnapshot', 'orderedRowIdentityDigest',
      'partialCurrentWindowCount', 'completedCurrentWindowCount',
    ]) {
      if (Object.hasOwn(vector.expected, field)) {
        assert.equal(actual[field], vector.expected[field], field);
      }
    }
    for (const field of [
      'countsByHorizon', 'countsByForwardSessionCount', 'availabilityCounts',
      'primaryAvailabilityReasonCounts', 'rejectedOccurrenceCounts', 'currentWindowStatusCounts',
    ]) {
      if (Object.hasOwn(vector.expected, field)) {
        assert.deepEqual(actual[field], vector.expected[field], field);
      }
    }
    if (Object.hasOwn(vector.expected, 'distinctOccurrenceCount')) {
      assert.equal(actual.distinctOccurrenceCount, vector.expected.distinctOccurrenceCount);
    }
  });
}

test('L4A-C2 oracle counters match production report on official fixture for row-derivable fields', () => (
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
    const oracle = oracleReportCountersFromRows(verified.seasonalityFeatureRows);
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
    for (const key of Object.keys(report.countsByHorizon)) {
      assert.equal(
        oracle.countsByHorizon[key].rowPresenceCount,
        report.countsByHorizon[key].rowPresenceCount,
      );
      assert.equal(
        oracle.countsByHorizon[key].occurrenceCountSum,
        report.countsByHorizon[key].occurrenceCountSum,
      );
    }
  })
));
