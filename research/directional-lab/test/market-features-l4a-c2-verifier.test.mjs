import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  buildMarketSeasonalityFeatureComputationPolicy,
  buildMarketSeasonalityFeatureSourceBundle,
  computeMarketSeasonalityFeatureRows,
  computeMarketSeasonalityFeatures,
  verifyMarketSeasonalityFeatureComputation,
} from '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs';
import { readFileSync } from 'node:fs';
import { withOfficialL4Binding } from './marketFeaturesL4SyntheticPipeline.mjs';

const HASH = `sha256:${'f'.repeat(64)}`;

const GOLDEN = Object.freeze({
  sourceBundleId: 'sha256:ce5cd6558127b55932e9db90cc0c4827c35ef2bf1e80a93909175abe8ec09ca1',
  policyId: 'sha256:91b0486256b7c2364a9e2a62e7d53c283a41320714115f25daa429da930933c5',
  rowsId: 'sha256:344d82d727842dfb532783bd99bc6b144e270b7ef60904de93086865a0ebe457',
  rowCount: 2,
});

function putImplementationManifestC1(store) {
  return store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: 'TransformImplementationManifest/2',
    value: {
      schemaVersion: 'TransformImplementationManifest/2',
      runtimeContractVersion: 'L4A-C1/1',
      moduleHashPolicyVersion: 'TransformSourceText/1',
      modules: [
        'src/contracts/marketSeasonalityFeatureComputationL4V1.mjs',
        'src/contracts/marketSeasonalityFeaturePolicyValuesL4V1.mjs',
        'src/features/marketSeasonalityOccurrenceEngineL4V1.mjs',
        'src/features/marketSeasonalityRuntimePolicyL4V1.mjs',
        'src/features/marketSeasonalityStatisticsL4V1.mjs',
      ].map((logicalPath) => ({ logicalPath, canonicalContentSha256: HASH })),
    },
  });
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

function computeOfficialC2({ store, published, manifestPut = putImplementationManifestC2 }) {
  const implementation = manifestPut(store);
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
  return { implementation, source, policy, computed };
}

function captureC2Bytes() {
  return withOfficialL4Binding(({ store, published }) => {
    const { source, policy, computed } = computeOfficialC2({ store, published });
    const ids = {
      sourceBundleId: source.seasonalityFeatureSourceBundleId,
      policyId: policy.seasonalityFeatureComputationPolicyId,
      rowsId: computed.seasonalityFeatureRowsId,
      reportId: computed.seasonalityFeatureComputationReportId,
    };
    const bytes = Object.fromEntries(Object.entries(ids).map(([name, objectId]) => {
      const namespace = name === 'rowsId' ? 'normalized' : 'snapshots';
      return [name, store.readObject({
        uri: store.uriForObject({ namespace, objectId }), expectedObjectId: objectId,
      }).bytes.toString('base64')];
    }));
    return { ids, bytes };
  });
}

test('L4A-C2 verifier passes on official computeMarketSeasonalityFeatures', () => (
  withOfficialL4Binding(({ store, published }) => {
    const { computed } = computeOfficialC2({ store, published });
    const verified = verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: computed.seasonalityFeatureComputationReportId,
    });
    assert.equal(verified.seasonalityFeatureComputationReportId, computed.seasonalityFeatureComputationReportId);
    assert.equal(verified.seasonalityFeatureRowsId, computed.seasonalityFeatureRowsId);
    assert.equal(verified.seasonalityFeatureRows.rows.length, 2);
  })
));

test('L4A-C2 multi-store: identical rows+report bytes and ids under same C2 manifest inputs', () => {
  const first = captureC2Bytes();
  const second = captureC2Bytes();
  assert.deepEqual(first.ids, second.ids);
  assert.deepEqual(first.bytes, second.bytes);
});

test('L4A-C2 replay: compute twice in the same store yields the same ids', () => (
  withOfficialL4Binding(({ store, published }) => {
    const first = computeOfficialC2({ store, published });
    const second = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: first.source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: first.policy.seasonalityFeatureComputationPolicyId,
    });
    assert.deepEqual(second, first.computed);
    verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: second.seasonalityFeatureComputationReportId,
    });
  })
));

test('L4A-C2 note: official binding has no empty-session override for full empty verify', () => {
  // withOfficialL4Binding always materializes two OHLCV sessions. Full empty-pipeline verify
  // requires an empty OHLCV binding; empty digest/report live in l4a-c2-empty.test.mjs.
  const pipeline = readFileSync(
    new URL('./marketFeaturesL4SyntheticPipeline.mjs', import.meta.url), 'utf8',
  );
  assert.equal(/export function withOfficialL4Binding\([^)]*sessions/.test(pipeline), false);
  assert.match(pipeline, /export function withOfficialL4Binding\(callback\)/);
});

test('L4A-C2 verifier refuses a missing report id', () => (
  withOfficialL4Binding(({ store, published }) => {
    computeOfficialC2({ store, published });
    assert.throws(
      () => verifyMarketSeasonalityFeatureComputation({
        store,
        seasonalityFeatureComputationReportId: `sha256:${'0'.repeat(64)}`,
      }),
      (error) => error?.code === 'MARKET_DATA_REFERENCE_MISSING'
        || error?.code === 'MARKET_DATA_REFERENCE_CORRUPT'
        || error?.code === 'MARKET_DATA_WRONG_REFERENCE_TYPE',
    );
  })
));

test('L4A-C2 verifier refuses forged report pointing at wrong rowsId', () => (
  withOfficialL4Binding(({ store, published }) => {
    const { computed } = computeOfficialC2({ store, published });
    const verified = verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: computed.seasonalityFeatureComputationReportId,
    });
    const emptyRows = store.putCanonicalObject({
      namespace: 'normalized',
      schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
      value: { schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION, rows: [] },
    });
    const forged = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
      value: {
        ...verified.seasonalityFeatureComputationReport,
        seasonalityFeatureRowsId: emptyRows.objectId,
        rowCount: 0,
        emptySnapshot: true,
        firstSessionDate: null,
        lastSessionDate: null,
      },
    });
    assert.throws(
      () => verifyMarketSeasonalityFeatureComputation({
        store, seasonalityFeatureComputationReportId: forged.objectId,
      }),
      (error) => error?.code === 'MARKET_DATA_SEASONALITY_ROWS_MISMATCH'
        || error?.code === 'MARKET_DATA_SEASONALITY_REPORT_MISMATCH',
    );
  })
));

test('L4A-C2 verifier refuses wrong implementationManifestId on report', () => (
  withOfficialL4Binding(({ store, published }) => {
    const { computed } = computeOfficialC2({ store, published });
    const verified = verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: computed.seasonalityFeatureComputationReportId,
    });
    const foreignManifest = putImplementationManifestC2(store);
    // Same module list but different object only if content differs — force distinct id via noise field
    // by putting a C1-shaped manifest instead.
    const other = putImplementationManifestC1(store);
    assert.notEqual(other.objectId, foreignManifest.objectId);
    const forged = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
      value: {
        ...verified.seasonalityFeatureComputationReport,
        implementationManifestId: other.objectId,
      },
    });
    assert.throws(
      () => verifyMarketSeasonalityFeatureComputation({
        store, seasonalityFeatureComputationReportId: forged.objectId,
      }),
      (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_MISMATCH',
    );
  })
));

test('L4A-C2 golden C1 rows-only path keeps official IDs', () => (
  withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifestC1(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const policy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    const rowsOnly = computeMarketSeasonalityFeatureRows({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    assert.equal(source.seasonalityFeatureSourceBundleId, GOLDEN.sourceBundleId);
    assert.equal(policy.seasonalityFeatureComputationPolicyId, GOLDEN.policyId);
    assert.equal(rowsOnly.seasonalityFeatureRowsId, GOLDEN.rowsId);
    assert.equal(rowsOnly.seasonalityFeatureRows.rows.length, GOLDEN.rowCount);
  })
));

test('L4A-C2 path with C1 manifest keeps golden rowsId and produces a reportId', () => (
  withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifestC1(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const policy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    assert.equal(source.seasonalityFeatureSourceBundleId, GOLDEN.sourceBundleId);
    assert.equal(policy.seasonalityFeatureComputationPolicyId, GOLDEN.policyId);
    const full = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    assert.equal(full.seasonalityFeatureRowsId, GOLDEN.rowsId);
    assert.match(full.seasonalityFeatureComputationReportId, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(full.seasonalityFeatureComputationReportId, full.seasonalityFeatureRowsId);
    verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: full.seasonalityFeatureComputationReportId,
    });
  })
));
