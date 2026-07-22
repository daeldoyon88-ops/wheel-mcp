import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketMacroFeatureComputationPolicy } from '../src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { buildMarketMacroFeatureSourceBundle } from '../src/macro/marketMacroFeatureSourceBundleL4BV1.mjs';
import { buildMacroStateBySessionRows } from '../src/macro/macroStateBySessionRowsL4BV1.mjs';
import { buildMarketMacroFeatureComputationReport } from '../src/macro/marketMacroFeatureComputationReportL4BV1.mjs';
import { openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';
import { GOLDEN_L4B_F1 } from './market-macro-l4b-f1-multi-store.test.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

test('policy replay is byte-identical by CAS identity', () => {
  const built = buildMarketMacroFeatureComputationPolicy({ store: live.store });
  assert.equal(built.featureComputationPolicyId, live.featurePolicy.featureComputationPolicyId);
  assert.equal(built.featureComputationPolicyId, GOLDEN_L4B_F1.featureComputationPolicyId);
});

test('source bundle replay is identity-identical', () => {
  const built = buildMarketMacroFeatureSourceBundle({
    store: live.store,
    macroDatasetBindingId: live.binding.macroDatasetBindingId,
    macroMaterializationReportId: live.materialization.macroMaterializationReportId,
    marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
    featureComputationStartSessionDate: '2026-03-02',
    featureComputationEndSessionDateInclusive: '2026-03-09',
  });
  assert.equal(built.sourceBundleId, live.sourceBundle.sourceBundleId);
  assert.equal(built.sourceBundleId, GOLDEN_L4B_F1.sourceBundleId);
});

test('rows replay is identity-identical', () => {
  const built = buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
  assert.equal(built.macroStateBySessionRowsId, live.rows.macroStateBySessionRowsId);
  assert.equal(built.macroStateBySessionRowsId, GOLDEN_L4B_F1.macroStateBySessionRowsId);
});

test('report replay is identity-identical', () => {
  const built = buildMarketMacroFeatureComputationReport({
    store: live.store,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
    macroStateBySessionRowsId: live.rows.macroStateBySessionRowsId,
  });
  assert.equal(built.macroFeatureComputationReportId, live.report.macroFeatureComputationReportId);
  assert.equal(built.macroFeatureComputationReportId, GOLDEN_L4B_F1.macroFeatureComputationReportId);
});

test('full F1 stack replay reproduces all four golden IDs', () => {
  const policy = buildMarketMacroFeatureComputationPolicy({ store: live.store });
  const bundle = buildMarketMacroFeatureSourceBundle({
    store: live.store,
    macroDatasetBindingId: live.binding.macroDatasetBindingId,
    macroMaterializationReportId: live.materialization.macroMaterializationReportId,
    marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
    featureComputationStartSessionDate: '2026-03-02',
    featureComputationEndSessionDateInclusive: '2026-03-09',
  });
  const rows = buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: bundle.sourceBundleId,
    featureComputationPolicyId: policy.featureComputationPolicyId,
  });
  const report = buildMarketMacroFeatureComputationReport({
    store: live.store,
    sourceBundleId: bundle.sourceBundleId,
    featureComputationPolicyId: policy.featureComputationPolicyId,
    macroStateBySessionRowsId: rows.macroStateBySessionRowsId,
  });
  assert.deepEqual({
    featureComputationPolicyId: policy.featureComputationPolicyId,
    sourceBundleId: bundle.sourceBundleId,
    macroStateBySessionRowsId: rows.macroStateBySessionRowsId,
    macroFeatureComputationReportId: report.macroFeatureComputationReportId,
  }, GOLDEN_L4B_F1);
});
