import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
} from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  buildMarketSeasonalityFeatureComputationPolicy,
  buildMarketSeasonalityFeatureSourceBundle,
  computeMarketSeasonalityFeatureRows,
  verifyMarketSeasonalityFeatureSourceBundle,
} from '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs';
import { withOfficialL4Binding } from './marketFeaturesL4SyntheticPipeline.mjs';
import { withStore } from './l2aSyntheticPipeline.mjs';

const HASH = `sha256:${'f'.repeat(64)}`;

function putImplementationManifest(store) {
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

function captureOfficial() {
  return withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifest(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const policy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    const computed = computeMarketSeasonalityFeatureRows({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    const ids = {
      sourceBundleId: source.seasonalityFeatureSourceBundleId,
      policyId: policy.seasonalityFeatureComputationPolicyId,
      rowsId: computed.seasonalityFeatureRowsId,
    };
    const bytes = Object.fromEntries(Object.entries(ids).map(([name, objectId]) => {
      const namespace = name === 'rowsId' ? 'normalized' : 'snapshots';
      return [name, store.readObject({
        uri: store.uriForObject({ namespace, objectId }), expectedObjectId: objectId,
      }).bytes.toString('base64')];
    }));
    return { ids, bytes, rowCount: computed.seasonalityFeatureRows.rows.length };
  });
}

test('L4A-C1 official L3-I6 binding builds bundle, policy and deterministic rows', () => {
  const first = captureOfficial();
  const second = captureOfficial();
  assert.equal(first.rowCount, 2);
  assert.equal(first.ids.sourceBundleId, 'sha256:ce5cd6558127b55932e9db90cc0c4827c35ef2bf1e80a93909175abe8ec09ca1');
  assert.equal(first.ids.policyId, 'sha256:91b0486256b7c2364a9e2a62e7d53c283a41320714115f25daa429da930933c5');
  assert.equal(first.ids.rowsId, 'sha256:344d82d727842dfb532783bd99bc6b144e270b7ef60904de93086865a0ebe457');
  assert.deepEqual(first.ids, second.ids);
  assert.deepEqual(first.bytes, second.bytes);
});

test('L4A-C1 bundle pins binding, snapshot, identity, calendar and implementation manifest', () => (
  withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifest(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const verified = verifyMarketSeasonalityFeatureSourceBundle({
      store, seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
    });
    const bundle = verified.seasonalityFeatureSourceBundle;
    assert.equal(bundle.schemaVersion, MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION);
    assert.equal(bundle.subjectBindingId, published.bindingId);
    assert.equal(bundle.implementationManifestId, implementation.objectId);
    assert.equal(bundle.priceBasis, 'RAW');
    assert.equal(bundle.corporateActionTreatment, 'RAW_SOURCE_UNTRANSFORMED');
    assert.equal(verified.sourceRows.length, 2);
    assert.equal(verified.calendarSessions.some((session) => session.sessionKind === 'REGULAR_SESSION'), true);
  })
));

test('L4A-C1 verifier refuses a forged bundle price basis against its pinned binding', () => (
  withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifest(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const original = store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'snapshots', objectId: source.seasonalityFeatureSourceBundleId }),
      expectedObjectId: source.seasonalityFeatureSourceBundleId,
      schemaVersion: MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    }).value;
    const forged = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
      value: {
        ...original,
        priceBasis: 'SPLIT_ADJUSTED',
        corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
      },
    });
    assert.throws(() => verifyMarketSeasonalityFeatureSourceBundle({
      store, seasonalityFeatureSourceBundleId: forged.objectId,
    }), (error) => error?.code === 'MARKET_DATA_SEASONALITY_PRICE_BASIS_MISMATCH');
  })
));

test('L4A-C1 empty normalized rows are byte-identical across stores and creation order', () => {
  const capture = (noise) => withStore((store) => {
    if (noise) store.putSourceBytes(Buffer.from('unrelated-order-noise'));
    const policy = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
      value: {
        schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
        priceBasisPolicy: 'USE_BINDING_PIN_ONLY', horizons: [3, 5, 10, 15],
        forwardSessionCounts: [5, 10, 20, 40, 60], minimumOccurrenceCount: 3,
        calendarAlignment: 'CIVIL_MONTH_DAY_ON_OR_AFTER_START',
        returnFormula: 'CLOSE_END_OVER_CLOSE_START_MINUS_ONE',
        flatThreshold: 'EXACT_ZERO_AT_RATIO_SCALE', numericRepresentation: 'FIXED_POINT_ATOMS_SCALE',
        internalScale: 24, ratioScale: 12, roundingMode: 'HALF_EVEN',
        leapDayPolicy: 'LEAP_DAY_PREVIOUS_CIVIL_DAY', week53Policy: 'UNSUPPORTED',
        crossYearPolicy: 'ALLOWED_IF_CAUSAL',
        currentYearPolicy: 'EXCLUDE_FROM_HISTORICAL_UNTIL_COMPLETE',
        quantileDefinition: 'LINEAR_INCLUSIVE_N_MINUS_ONE_V1',
        missingHistoryPolicy: 'NULL_WITH_REASON', futureDataPolicy: 'FORBIDDEN',
        rowOrdering: 'SESSION_DATE_THEN_BAR_IDENTITY',
      },
    });
    const rows = store.putCanonicalObject({
      namespace: 'normalized',
      schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
      value: { schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION, rows: [] },
    });
    return {
      policyId: policy.objectId,
      rowsId: rows.objectId,
      bytes: store.readObject({ uri: rows.uri, expectedObjectId: rows.objectId }).bytes.toString('base64'),
    };
  });
  assert.deepEqual(capture(false), capture(true));
});

test('L4A-C1 production path has no network, wall-clock, latest, A/B compute or legacy seasonality coupling', () => {
  const files = [
    '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs',
    '../src/contracts/marketSeasonalityFeaturePolicyValuesL4V1.mjs',
    '../src/features/marketSeasonalityRuntimePolicyL4V1.mjs',
    '../src/features/marketSeasonalityStatisticsL4V1.mjs',
    '../src/features/marketSeasonalityOccurrenceEngineL4V1.mjs',
    '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs',
  ];
  const source = files.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  for (const forbidden of [
    'fetch(', 'Yahoo', 'IBKR', 'Date.now', 'new Date(', 'Math.random', 'parseFloat',
    'toFixed', 'app/seasonality', 'computeMarketTechnicalFeatures',
    'computeMarketVolumeStructureFeatures', 'latest',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
