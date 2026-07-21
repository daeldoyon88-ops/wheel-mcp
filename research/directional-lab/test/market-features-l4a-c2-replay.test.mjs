import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMarketSeasonalityFeatureComputationPolicy,
  buildMarketSeasonalityFeatureSourceBundle,
  computeMarketSeasonalityFeatures,
  verifyMarketSeasonalityFeatureComputation,
} from '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs';
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

function runCompute(store, published, noiseFirst = false) {
  if (noiseFirst) store.putSourceBytes(Buffer.from('l4a-c2-reverse-insertion-noise'));
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
  return { source, policy, computed, implementation };
}

function captureIdsAndBytes(noiseFirst = false) {
  return withOfficialL4Binding(({ store, published }) => {
    const { source, policy, computed } = runCompute(store, published, noiseFirst);
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

test('L4A-C2 replay same store yields identical ids', () => (
  withOfficialL4Binding(({ store, published }) => {
    const first = runCompute(store, published);
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

test('L4A-C2 replay with reverse insertion noise (putSourceBytes first) keeps ids', () => {
  const quiet = captureIdsAndBytes(false);
  const noisy = captureIdsAndBytes(true);
  assert.deepEqual(quiet.ids, noisy.ids);
  assert.deepEqual(quiet.bytes, noisy.bytes);
});

test('L4A-C2 multi-store byte equality for rows and report', () => {
  const first = captureIdsAndBytes(false);
  const second = captureIdsAndBytes(false);
  assert.deepEqual(first.ids, second.ids);
  assert.deepEqual(first.bytes, second.bytes);
});

test('L4A-C2 prefix invariance: future store noise does not change recomputed ids', () => (
  withOfficialL4Binding(({ store, published }) => {
    const first = runCompute(store, published);
    store.putSourceBytes(Buffer.from('post-compute-noise-bytes'));
    store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: 'TransformImplementationManifest/2',
      value: {
        schemaVersion: 'TransformImplementationManifest/2',
        runtimeContractVersion: 'UNRELATED/1',
        moduleHashPolicyVersion: 'TransformSourceText/1',
        modules: [
          {
            logicalPath: 'unrelated/module.mjs',
            canonicalContentSha256: `sha256:${'e'.repeat(64)}`,
          },
        ],
      },
    });
    const second = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: first.source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: first.policy.seasonalityFeatureComputationPolicyId,
    });
    assert.deepEqual(second, first.computed);
    verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: first.computed.seasonalityFeatureComputationReportId,
    });
  })
));

test('L4A-C2 anti-lookahead: foreign future objects in store do not change report', () => (
  withOfficialL4Binding(({ store, published }) => {
    const baseline = runCompute(store, published);
    store.putSourceBytes(Buffer.from(JSON.stringify({
      futureSessionDate: '2099-12-31',
      futureBars: [{ close: 999999 }],
    })));
    store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: 'TransformImplementationManifest/2',
      value: {
        schemaVersion: 'TransformImplementationManifest/2',
        runtimeContractVersion: 'FUTURE_LOOKAHEAD_BAIT/1',
        moduleHashPolicyVersion: 'TransformSourceText/1',
        modules: [
          {
            logicalPath: 'future/lookahead.mjs',
            canonicalContentSha256: `sha256:${'d'.repeat(64)}`,
          },
        ],
      },
    });
    const again = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: baseline.source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: baseline.policy.seasonalityFeatureComputationPolicyId,
    });
    assert.equal(again.seasonalityFeatureComputationReportId, baseline.computed.seasonalityFeatureComputationReportId);
    assert.equal(again.seasonalityFeatureRowsId, baseline.computed.seasonalityFeatureRowsId);
    const verified = verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: again.seasonalityFeatureComputationReportId,
    });
    assert.equal(verified.seasonalityFeatureComputationReport.rowCount, 2);
  })
));
