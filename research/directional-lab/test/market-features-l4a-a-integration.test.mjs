import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import {
  MARKET_TECHNICAL_FEATURE_L4_SCHEMA_VERSIONS,
  MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_POLICY_VALUES,
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
  normalizeMarketTechnicalFeatureRowsV1,
} from '../src/contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  buildMarketDataDatasetSnapshotBindingRegistryManifest,
  verifyMarketDataDatasetSnapshotBindingRegistry,
} from '../src/contracts/marketDataDatasetSnapshotBindingL3V1.mjs';
import {
  buildMarketTechnicalFeatureComputationPolicy,
  buildMarketTechnicalFeatureSourceBundle,
  computeMarketTechnicalFeatures,
  verifyMarketTechnicalFeatureComputation,
} from '../src/features/computeMarketTechnicalFeaturesL4V1.mjs';
import { withOfficialL4Binding } from './marketFeaturesL4SyntheticPipeline.mjs';

test('L4A foundation keeps its three additive schemas registered (132 total after L4C-I1)', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 132);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 132);
  assert.deepEqual(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-52, -49),
    [...MARKET_TECHNICAL_FEATURE_L4_SCHEMA_VERSIONS],
  );
});

test('L4A MarketTechnicalFeatureRows/1 is normalized content, not an 81st snapshot schema', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION), false);
  assert.throws(() => normalizeCanonicalValue(MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION, {}));
});

test('L4A source bundle normalizer rejects unknown and duplicate benchmark roles', async () => {
  const module = await import('../src/contracts/marketTechnicalFeatureComputationL4V1.mjs');
  const id = `sha256:${'a'.repeat(64)}`;
  const base = {
    schemaVersion: module.MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    subject: { bindingRegistryManifestId: id, bindingId: id },
  };
  assert.throws(() => module.normalizeMarketTechnicalFeatureSourceBundleV1({
    ...base,
    benchmarks: [{ role: 'FREE', bindingRegistryManifestId: id, bindingId: id }],
  }));
  assert.throws(() => module.normalizeMarketTechnicalFeatureSourceBundleV1({
    ...base,
    benchmarks: [
      { role: 'MARKET', bindingRegistryManifestId: id, bindingId: id },
      { role: 'MARKET', bindingRegistryManifestId: id, bindingId: id },
    ],
  }));
});

test('L4A official I6 binding computes, replays and ignores a non-contributive descendant pin', () => (
  withOfficialL4Binding(({ store, bindingRoot, published }) => {
    const policyA = buildMarketTechnicalFeatureComputationPolicy({ store });
    const policyB = buildMarketTechnicalFeatureComputationPolicy({ store });
    assert.equal(policyA.technicalFeatureComputationPolicyId, policyB.technicalFeatureComputationPolicyId);

    const sourceA = buildMarketTechnicalFeatureSourceBundle({
      store,
      subject: {
        bindingRegistryManifestId: published.bindingRegistryManifestId,
        bindingId: published.bindingId,
      },
      benchmarks: [],
    });
    assert.throws(() => buildMarketTechnicalFeatureSourceBundle({
      store,
      subject: {
        bindingRegistryManifestId: bindingRoot.bindingRegistryManifestId,
        bindingId: published.bindingId,
      },
      benchmarks: [],
    }), (error) => error?.code === 'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT');

    const verifiedRegistry = verifyMarketDataDatasetSnapshotBindingRegistry({
      store,
      bindingRegistryManifestId: published.bindingRegistryManifestId,
    }).bindingRegistryManifest;
    const descendant = buildMarketDataDatasetSnapshotBindingRegistryManifest({
      store,
      registry: {
        ...verifiedRegistry,
        supersedesBindingRegistryManifestId: published.bindingRegistryManifestId,
      },
    });
    const sourceFromDescendant = buildMarketTechnicalFeatureSourceBundle({
      store,
      subject: {
        bindingRegistryManifestId: descendant.bindingRegistryManifestId,
        bindingId: published.bindingId,
      },
      benchmarks: [],
    });
    assert.equal(sourceFromDescendant.technicalFeatureSourceBundleId, sourceA.technicalFeatureSourceBundleId);

    const first = computeMarketTechnicalFeatures({
      store,
      technicalFeatureSourceBundleId: sourceA.technicalFeatureSourceBundleId,
      technicalFeatureComputationPolicyId: policyA.technicalFeatureComputationPolicyId,
    });
    const second = computeMarketTechnicalFeatures({
      store,
      technicalFeatureSourceBundleId: sourceA.technicalFeatureSourceBundleId,
      technicalFeatureComputationPolicyId: policyA.technicalFeatureComputationPolicyId,
    });
    assert.deepEqual(first, second);
    const verified = verifyMarketTechnicalFeatureComputation({
      store,
      technicalFeatureComputationReportId: first.technicalFeatureComputationReportId,
    });
    assert.equal(verified.technicalFeatureComputationReport.rowCount, 2);
    assert.equal(verified.technicalFeatureRows.rows[0].features.returnsDrawdowns.return1, null);
    assert.equal(
      verified.technicalFeatureRows.rows[0].availability.returnsDrawdowns.return1,
      'INSUFFICIENT_HISTORY',
    );
    assert.equal(verified.technicalFeatureRows.rows[1].availability.returnsDrawdowns.return1, 'AVAILABLE');
    assert.equal(verified.technicalFeatureComputationReport.benchmarkBindingIds.MARKET, null);
    assert.equal(
      verified.technicalFeatureComputationReport.featureSchemaVersion,
      MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    );
    assert.ok(verified.technicalFeatureComputationReport.availabilityCounts.AVAILABLE > 0);
    assert.throws(() => normalizeMarketTechnicalFeatureRowsV1({
      schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
      rows: [verified.technicalFeatureRows.rows[0], verified.technicalFeatureRows.rows[0]],
    }));

    const forgedReport = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
      value: {
        ...verified.technicalFeatureComputationReport,
        availabilityCounts: {
          ...verified.technicalFeatureComputationReport.availabilityCounts,
          AVAILABLE: verified.technicalFeatureComputationReport.availabilityCounts.AVAILABLE + 1,
        },
      },
    });
    assert.throws(() => verifyMarketTechnicalFeatureComputation({
      store,
      technicalFeatureComputationReportId: forgedReport.objectId,
    }), (error) => error?.code === 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  })
));

test('L4A policy closes every period, scale, rounding and future-data rule', () => {
  assert.equal(MARKET_TECHNICAL_FEATURE_POLICY_VALUES.numericRepresentation, 'FIXED_POINT_BIGINT_V1');
  assert.equal(MARKET_TECHNICAL_FEATURE_POLICY_VALUES.ratioScale, 12);
  assert.equal(MARKET_TECHNICAL_FEATURE_POLICY_VALUES.priceFeatureScale, 12);
  assert.equal(MARKET_TECHNICAL_FEATURE_POLICY_VALUES.roundingMode, 'HALF_EVEN');
  assert.equal(MARKET_TECHNICAL_FEATURE_POLICY_VALUES.futureDataPolicy, 'FORBIDDEN');
  assert.deepEqual(MARKET_TECHNICAL_FEATURE_POLICY_VALUES.emaPeriods, [8, 34, 50, 200]);
});

test('L4A implementation stays isolated from production, network and recommendation code', () => {
  const files = [
    'fixedPointFeatureMathL4V1.mjs',
    'returnsDrawdownFeaturesL4V1.mjs',
    'volatilityFeaturesL4V1.mjs',
    'momentumFeaturesL4V1.mjs',
    'trendRelativeStrengthFeaturesL4V1.mjs',
    'computeMarketTechnicalFeaturesL4V1.mjs',
  ];
  const source = files.map((file) => readFileSync(
    new URL(`../src/features/${file}`, import.meta.url), 'utf8',
  )).join('\n');
  for (const forbidden of [
    'fetch(', 'Yahoo', 'IBKR', 'wheel-dashboard', 'server.js',
    'Date.now', 'Math.random', 'parseFloat', 'toFixed', 'Math.sqrt',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(/from ['"](?:\.\.\/){2,}(?:app|scripts)\//.test(source), false);
  assert.equal(/\b(?:buildRecommendation|computePredictionScore|rankScannerCandidates)\b/.test(source), false);
});
