import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMarketMacroFeatureSourceBundle } from '../src/macro/marketMacroFeatureSourceBundleL4BV1.mjs';
import { verifyMacroStateBySessionRows } from '../src/macro/macroStateBySessionRowsL4BV1.mjs';
import { verifyMarketMacroFeatureComputationReport } from '../src/macro/marketMacroFeatureComputationReportL4BV1.mjs';
import { withEmptyMacroL4BF1Fixture } from './macroFeaturesL4BSyntheticFixture.mjs';

test('empty fixture reports zero sessions', () => withEmptyMacroL4BF1Fixture((ctx) => {
  const report = ctx.report.featureComputationReport;
  assert.equal(report.emptyComputation, true);
  assert.equal(report.sessionCount, 0);
  assert.equal(report.firstSessionId, null);
  assert.equal(report.lastSessionId, null);
}));

test('empty fixture rows container is empty', () => withEmptyMacroL4BF1Fixture((ctx) => {
  assert.equal(ctx.rows.macroStateBySessionRows.rows.length, 0);
}));

test('empty source bundle verifies and has zero sessions in range', () => withEmptyMacroL4BF1Fixture((ctx) => {
  const verified = verifyMarketMacroFeatureSourceBundle({
    store: ctx.store, sourceBundleId: ctx.sourceBundle.sourceBundleId,
  });
  assert.equal(verified.orderedSessionsInRange.length, 0);
}));

test('empty rows verify against pins', () => withEmptyMacroL4BF1Fixture((ctx) => {
  const verified = verifyMacroStateBySessionRows({
    store: ctx.store,
    macroStateBySessionRowsId: ctx.rows.macroStateBySessionRowsId,
    sourceBundleId: ctx.sourceBundle.sourceBundleId,
    featureComputationPolicyId: ctx.featurePolicy.featureComputationPolicyId,
  });
  assert.equal(verified.macroStateBySessionRows.rows.length, 0);
}));

test('empty report verifies and counts are zero', () => withEmptyMacroL4BF1Fixture((ctx) => {
  const verified = verifyMarketMacroFeatureComputationReport({
    store: ctx.store,
    macroFeatureComputationReportId: ctx.report.macroFeatureComputationReportId,
  });
  assert.equal(verified.featureComputationReport.completeSessionCount, 0);
  assert.equal(verified.featureComputationReport.unavailableSessionCount, 0);
}));
