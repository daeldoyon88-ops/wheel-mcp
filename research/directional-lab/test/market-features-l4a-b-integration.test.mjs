import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_L4_SCHEMA_VERSIONS,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
  normalizeMarketVolumeStructureFeatureRowsV1,
} from '../src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import {
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  buildMarketVolumeStructureFeatureComputationPolicy,
  buildMarketVolumeStructureFeatureSourceBundle,
  computeMarketVolumeStructureFeatures,
  verifyMarketVolumeStructureFeatureComputation,
} from '../src/features/computeMarketVolumeStructureFeaturesL4V1.mjs';
import {
  defaultFixtureSessions,
  withOfficialL4AReport,
} from './marketVolumeStructureL4SyntheticFixture.mjs';

test('L4A-B registers exactly three additive schemas for a total of 83', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 83);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 83);
  assert.deepEqual(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-3),
    [...MARKET_VOLUME_STRUCTURE_FEATURE_L4_SCHEMA_VERSIONS],
  );
  assert.equal(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION),
    false,
  );
  assert.throws(() => normalizeCanonicalValue(MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION, {}));
});

test('L4A-B rows remain a normalized-namespace content schema, not a 84th snapshot schema', () => {
  assert.equal(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION),
    false,
  );
});

test('L4A-B policy closes every baseline, pivot, tolerance and Fibonacci rule', () => {
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.numericRepresentation, 'FIXED_POINT_BIGINT_V1');
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.internalScale, 24);
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.ratioScale, 12);
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.priceScale, 12);
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.roundingMode, 'HALF_EVEN');
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.futureDataPolicy, 'FORBIDDEN');
  assert.equal(
    MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.volumeBaseline20,
    'PREVIOUS_SESSIONS_EXCLUDING_CURRENT',
  );
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.pivotRadius, 3);
  assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.pivotConfirmationDelay, 3);
  assert.deepEqual(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.rollingEodVwapPeriods, [20, 60]);
  assert.deepEqual(
    MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.fibonacciRatios.map((ratio) => ratio.atoms),
    ['236', '382', '500', '618', '786'],
  );
  assert.equal(
    MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.eodVwapBasis,
    'EOD_APPROXIMATION_FROM_DAILY_OHLCV_NOT_EXCHANGE_INTRADAY_VWAP',
  );
});

test('L4A-B official I6 + verified L4A-A report computes, replays and full-verifies', () => (
  withOfficialL4AReport(defaultFixtureSessions(3), ({ store, technical }) => {
    const policyA = buildMarketVolumeStructureFeatureComputationPolicy({ store });
    const policyB = buildMarketVolumeStructureFeatureComputationPolicy({ store });
    assert.equal(
      policyA.volumeStructureFeatureComputationPolicyId,
      policyB.volumeStructureFeatureComputationPolicyId,
    );

    const source = buildMarketVolumeStructureFeatureSourceBundle({
      store,
      technicalFeatureComputationReportId: technical.technicalFeatureComputationReportId,
    });
    const first = computeMarketVolumeStructureFeatures({
      store,
      volumeStructureFeatureSourceBundleId: source.volumeStructureFeatureSourceBundleId,
      volumeStructureFeatureComputationPolicyId: policyA.volumeStructureFeatureComputationPolicyId,
    });
    const second = computeMarketVolumeStructureFeatures({
      store,
      volumeStructureFeatureSourceBundleId: source.volumeStructureFeatureSourceBundleId,
      volumeStructureFeatureComputationPolicyId: policyA.volumeStructureFeatureComputationPolicyId,
    });
    assert.deepEqual(first, second);

    const verified = verifyMarketVolumeStructureFeatureComputation({
      store,
      volumeStructureFeatureComputationReportId: first.volumeStructureFeatureComputationReportId,
    });
    assert.equal(verified.volumeStructureFeatureComputationReport.rowCount, 3);
    assert.equal(
      verified.volumeStructureFeatureComputationReport.technicalFeatureComputationReportId,
      technical.technicalFeatureComputationReportId,
    );
    assert.equal(
      verified.volumeStructureFeatureComputationReport.featureSchemaVersion,
      MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    );
    assert.ok(verified.volumeStructureFeatureComputationReport.availabilityCounts.AVAILABLE > 0);
    assert.equal(verified.volumeStructureFeatureRows.rows[0].features.volumeParticipation.obv.atoms, '0');
    assert.equal(
      verified.volumeStructureFeatureRows.rows[0].availability.volumeParticipation.volumeMean20Previous,
      'INSUFFICIENT_HISTORY',
    );
    assert.ok(
      verified.volumeStructureFeatureRows.rows.every((row) => (
        row.technicalFeatureRowsId === technical.technicalFeatureRowsId
      )),
    );
    assert.throws(() => normalizeMarketVolumeStructureFeatureRowsV1({
      schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
      rows: [
        verified.volumeStructureFeatureRows.rows[0],
        verified.volumeStructureFeatureRows.rows[0],
      ],
    }));

    const forgedReport = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
      value: {
        ...verified.volumeStructureFeatureComputationReport,
        availabilityCounts: {
          ...verified.volumeStructureFeatureComputationReport.availabilityCounts,
          AVAILABLE: verified.volumeStructureFeatureComputationReport.availabilityCounts.AVAILABLE + 1,
        },
      },
    });
    assert.throws(() => verifyMarketVolumeStructureFeatureComputation({
      store,
      volumeStructureFeatureComputationReportId: forgedReport.objectId,
    }), (error) => error?.code === 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  })
));

test('L4A-B never mutates L4A-A rows or report IDs during its own computation', () => (
  withOfficialL4AReport(defaultFixtureSessions(2), ({ store, technical }) => {
    const beforeRows = store.readCanonicalObject({
      uri: store.uriForObject({
        namespace: 'normalized',
        objectId: technical.technicalFeatureRowsId,
      }),
      expectedObjectId: technical.technicalFeatureRowsId,
      schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    }).value;
    const policy = buildMarketVolumeStructureFeatureComputationPolicy({ store });
    const source = buildMarketVolumeStructureFeatureSourceBundle({
      store,
      technicalFeatureComputationReportId: technical.technicalFeatureComputationReportId,
    });
    computeMarketVolumeStructureFeatures({
      store,
      volumeStructureFeatureSourceBundleId: source.volumeStructureFeatureSourceBundleId,
      volumeStructureFeatureComputationPolicyId: policy.volumeStructureFeatureComputationPolicyId,
    });
    const afterRows = store.readCanonicalObject({
      uri: store.uriForObject({
        namespace: 'normalized',
        objectId: technical.technicalFeatureRowsId,
      }),
      expectedObjectId: technical.technicalFeatureRowsId,
      schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    }).value;
    assert.deepEqual(afterRows, beforeRows);
    // Content-addressed identity is unchanged: same objectId still resolves.
    assert.equal(
      store.readCanonicalObject({
        uri: store.uriForObject({
          namespace: 'normalized',
          objectId: technical.technicalFeatureRowsId,
        }),
        expectedObjectId: technical.technicalFeatureRowsId,
        schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
      }).value.schemaVersion,
      MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    );
  })
));

test('L4A-B implementation stays isolated from production, network and recommendation code', () => {
  const files = [
    'volumeStructureBarInputsL4V1.mjs',
    'volumeParticipationFeaturesL4V1.mjs',
    'eodVolumeWeightedPriceFeaturesL4V1.mjs',
    'confirmedPivotFeaturesL4V1.mjs',
    'supportResistanceFeaturesL4V1.mjs',
    'gapBreakoutFeaturesL4V1.mjs',
    'congestionFeaturesL4V1.mjs',
    'fibonacciStructureFeaturesL4V1.mjs',
    'computeMarketVolumeStructureFeaturesL4V1.mjs',
  ];
  const source = [
    readFileSync(new URL('../src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs', import.meta.url), 'utf8'),
    ...files.map((file) => readFileSync(new URL(`../src/features/${file}`, import.meta.url), 'utf8')),
  ].join('\n');
  for (const forbidden of [
    'fetch(', 'Yahoo', 'IBKR', 'wheel-dashboard', 'server.js',
    'Date.now', 'Math.random', 'parseFloat', 'toFixed', 'Math.round', 'Math.sqrt',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes('new Date('), false, 'new Date(');
  assert.equal(/from ['"](?:\.\.\/){2,}(?:app|scripts)\//.test(source), false);
  assert.equal(/\b(?:buildRecommendation|computePredictionScore|rankScannerCandidates)\b/.test(source), false);
});
