import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { test } from 'node:test';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_L4_SCHEMA_VERSIONS,
  MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
  normalizeMarketVolumeStructureFeatureRowsV1,
} from '../src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import {
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketTechnicalFeatureComputationL4V1.mjs';
import { MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION } from '../src/contracts/marketDataSnapshotMaterializationL3V1.mjs';
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
import { listFiles, withStore } from './l2aSyntheticPipeline.mjs';

let emptyBaseline = null;
let nonEmptyBaseline = null;

function bytesForIds(store, ids) {
  const bytes = {};
  for (const [name, objectId] of Object.entries(ids)) {
    const namespace = name === 'rowsId' ? 'normalized' : 'snapshots';
    bytes[name] = store.readObject({
      uri: store.uriForObject({ namespace, objectId }), expectedObjectId: objectId,
    }).bytes.toString('base64');
  }
  return bytes;
}

function recomputeInReplicatedStore(sourceRoot, technicalFeatureComputationReportId, excludedIds) {
  return withStore((store, root) => {
    const reverseMap = new Map([['z', 3], ['y', 2], ['x', 1]]);
    const reverseSet = new Set(['z', 'y', 'x']);
    store.putSourceBytes(Buffer.from(JSON.stringify([
      [...reverseMap.entries()], [...reverseSet.values()], 'orphan-replicated-store',
    ])));
    const excluded = new Set(Object.values(excludedIds));
    for (const path of listFiles(sourceRoot).reverse()) {
      const relativePath = relative(sourceRoot, path).replaceAll('\\', '/');
      const hex = basename(path).replace(/\.json$/, '');
      if (excluded.has(`sha256:${hex}`)) continue;
      const bytes = readFileSync(path);
      if (relativePath.startsWith('objects/source/')) {
        store.putSourceBytes(bytes);
        continue;
      }
      const namespace = relativePath.startsWith('objects/normalized/') ? 'normalized' : 'snapshots';
      const value = JSON.parse(bytes.toString('utf8'));
      store.putCanonicalObject({ namespace, schemaVersion: value.schemaVersion, value });
    }
    const policy = buildMarketVolumeStructureFeatureComputationPolicy({ store });
    const source = buildMarketVolumeStructureFeatureSourceBundle({
      store, technicalFeatureComputationReportId,
    });
    const computed = computeMarketVolumeStructureFeatures({
      store,
      volumeStructureFeatureSourceBundleId: source.volumeStructureFeatureSourceBundleId,
      volumeStructureFeatureComputationPolicyId: policy.volumeStructureFeatureComputationPolicyId,
    });
    const ids = {
      sourceBundleId: source.volumeStructureFeatureSourceBundleId,
      policyId: policy.volumeStructureFeatureComputationPolicyId,
      rowsId: computed.volumeStructureFeatureRowsId,
      reportId: computed.volumeStructureFeatureComputationReportId,
    };
    return { root, ids, bytes: bytesForIds(store, ids) };
  });
}

function captureOfficialL4AB(sessions, options = {}) {
  return withOfficialL4AReport(sessions, ({ store, root, materialization, technical }) => {
    const policy = buildMarketVolumeStructureFeatureComputationPolicy({ store });
    const source = buildMarketVolumeStructureFeatureSourceBundle({
      store,
      technicalFeatureComputationReportId: technical.technicalFeatureComputationReportId,
    });
    const input = {
      store,
      volumeStructureFeatureSourceBundleId: source.volumeStructureFeatureSourceBundleId,
      volumeStructureFeatureComputationPolicyId: policy.volumeStructureFeatureComputationPolicyId,
    };
    const first = computeMarketVolumeStructureFeatures(input);
    const replay = options.replay === true ? computeMarketVolumeStructureFeatures(input) : null;
    const verified = options.explicitVerify === true
      ? verifyMarketVolumeStructureFeatureComputation({
        store,
        volumeStructureFeatureComputationReportId: first.volumeStructureFeatureComputationReportId,
      })
      : null;
    const ids = {
      sourceBundleId: source.volumeStructureFeatureSourceBundleId,
      policyId: policy.volumeStructureFeatureComputationPolicyId,
      rowsId: first.volumeStructureFeatureRowsId,
      reportId: first.volumeStructureFeatureComputationReportId,
    };
    const bytes = bytesForIds(store, ids);
    const replicated = options.replicate === true
      ? recomputeInReplicatedStore(root, technical.technicalFeatureComputationReportId, ids)
      : null;
    const materializationReport = store.readCanonicalObject({
      uri: store.uriForObject({
        namespace: 'snapshots', objectId: materialization.materializationReportId,
      }),
      expectedObjectId: materialization.materializationReportId,
      schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    }).value;
    let lyingPolicyRejected = null;
    if (options.lyingPolicy === true) {
      const forgedReport = store.putCanonicalObject({
        namespace: 'snapshots',
        schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
        value: {
          ...verified.volumeStructureFeatureComputationReport,
          volumeStructureFeatureComputationPolicyId: source.volumeStructureFeatureSourceBundleId,
        },
      });
      lyingPolicyRejected = false;
      try {
        verifyMarketVolumeStructureFeatureComputation({
          store, volumeStructureFeatureComputationReportId: forgedReport.objectId,
        });
      } catch {
        lyingPolicyRejected = true;
      }
    }
    return {
      root, ids, bytes, replay, verified, materializationReport, lyingPolicyRejected, replicated,
    };
  }, options);
}

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
  withOfficialL4AReport(defaultFixtureSessions(3), ({ store, root, technical }) => {
    const beforeRows = store.readCanonicalObject({
      uri: store.uriForObject({
        namespace: 'normalized', objectId: technical.technicalFeatureRowsId,
      }),
      expectedObjectId: technical.technicalFeatureRowsId,
      schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    }).value;
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
    const afterRows = store.readCanonicalObject({
      uri: store.uriForObject({
        namespace: 'normalized', objectId: technical.technicalFeatureRowsId,
      }),
      expectedObjectId: technical.technicalFeatureRowsId,
      schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    }).value;
    assert.deepEqual(afterRows, beforeRows);
    const ids = {
      sourceBundleId: source.volumeStructureFeatureSourceBundleId,
      policyId: policyA.volumeStructureFeatureComputationPolicyId,
      rowsId: first.volumeStructureFeatureRowsId,
      reportId: first.volumeStructureFeatureComputationReportId,
    };
    nonEmptyBaseline = {
      root,
      ids,
      bytes: bytesForIds(store, ids),
      l4AAUnchanged: true,
      replicated: recomputeInReplicatedStore(root, technical.technicalFeatureComputationReportId, ids),
    };
  })
));

test('L4A-B never mutates L4A-A rows or report IDs during its own computation', () => {
  assert.equal(nonEmptyBaseline?.l4AAUnchanged, true);
});

test('L4A-B official empty L1 -> I6 -> L4A-A -> L4A-B chain replays and full-verifies', () => {
  const captured = captureOfficialL4AB([], {
    replay: true, explicitVerify: true, lyingPolicy: true, replicate: true,
  });
  emptyBaseline = captured;
  assert.equal(captured.materializationReport.status, 'MATERIALIZED_EMPTY');
  assert.deepEqual(captured.replay, {
    volumeStructureFeatureRowsId: captured.ids.rowsId,
    volumeStructureFeatureComputationReportId: captured.ids.reportId,
  });
  const { volumeStructureFeatureRows: rows, volumeStructureFeatureComputationReport: report } =
    captured.verified;
  assert.deepEqual(rows.rows, []);
  assert.equal(report.rowCount, 0);
  assert.equal(report.firstSessionDate, null);
  assert.equal(report.lastSessionDate, null);
  assert.equal(report.confirmedPivotCount, 0);
  assert.equal(report.confirmedSwingHighCount, 0);
  assert.equal(report.confirmedSwingLowCount, 0);
  assert.equal(report.detectedGapCount, 0);
  assert.equal(report.openGapCount, 0);
  assert.deepEqual(
    report.availabilityCounts,
    Object.fromEntries(MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES.map((code) => [code, 0])),
  );
  assert.equal(report.volumeStructureFeatureComputationPolicyId, captured.ids.policyId);
  for (const objectId of Object.values(captured.ids)) assert.match(objectId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(captured.lyingPolicyRejected, true);
});

test('L4A-B empty pipeline is byte-identical across two physical stores and insertion histories', () => {
  const first = emptyBaseline ?? captureOfficialL4AB([], {
    replay: true, explicitVerify: true, lyingPolicy: true, replicate: true,
  });
  const second = first.replicated;
  assert.notEqual(first.root, second.root);
  assert.deepEqual(first.ids, second.ids);
  assert.deepEqual(first.bytes, second.bytes);
});

test('L4A-B non-empty pipeline retains a69003b IDs and is byte-identical across physical stores', () => {
  const first = nonEmptyBaseline;
  const second = first.replicated;
  assert.notEqual(first.root, second.root);
  assert.deepEqual(first.ids, {
    sourceBundleId: 'sha256:0f76d5f9c54337a0b9b5932de0de27c4de3057802d554092df5a4fdb69186603',
    policyId: 'sha256:372fe3664a37ea29c73165ea405ae036518d7031d86ae738903dea868ba89556',
    rowsId: 'sha256:ca26772c3db1d25ee694202fd9fd9260dab04265ab2682a502fbae19884ac592',
    reportId: 'sha256:567adad8c4030394fc387d69d4c174336cbe69b5480c7c862f63e81ce13da0ba',
  });
  assert.deepEqual(first.ids, second.ids);
  assert.deepEqual(first.bytes, second.bytes);
});

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
