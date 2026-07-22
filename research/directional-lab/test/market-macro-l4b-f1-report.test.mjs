import test from 'node:test';
import assert from 'node:assert/strict';
import { putCanonicalL3 } from '../src/contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  normalizeMarketMacroFeatureComputationReportV1,
} from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import {
  buildMarketMacroFeatureComputationReport,
  verifyMarketMacroFeatureComputationReport,
} from '../src/macro/marketMacroFeatureComputationReportL4BV1.mjs';
import { openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

const FAKE = (ch = 'a') => `sha256:${ch.repeat(64)}`;

test('official report verifies via full recompute', () => {
  const verified = verifyMarketMacroFeatureComputationReport({
    store: live.store,
    macroFeatureComputationReportId: live.report.macroFeatureComputationReportId,
  });
  assert.equal(verified.featureComputationReport.sessionCount, 6);
});

test('report counts match official row aggregates', () => {
  const report = live.report.featureComputationReport;
  assert.equal(report.countsByPolicyDirection.TIGHTENING, 2);
  assert.equal(report.countsByPolicyDirection.EASING, 1);
  assert.equal(report.countsByCurveShape.FLAT, 2);
  assert.equal(report.countsByCurveShape.INVERTED, 2);
  assert.equal(report.countsByCurveShape.NORMAL, 1);
  assert.equal(report.sessionWithFomcDecisionCount, 3);
});

test('report replay is identity-identical', () => {
  const built = buildMarketMacroFeatureComputationReport({
    store: live.store,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
    macroStateBySessionRowsId: live.rows.macroStateBySessionRowsId,
  });
  assert.equal(built.macroFeatureComputationReportId, live.report.macroFeatureComputationReportId);
});

test('forged sessionCount refuses verify', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.sessionCount += 1;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureComputationReport({
    store: live.store, macroFeatureComputationReportId: stored.objectId,
  }));
});

test('forged orderedSessionIdentityDigest refuses verify', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.orderedSessionIdentityDigest = FAKE('b');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureComputationReport({
    store: live.store, macroFeatureComputationReportId: stored.objectId,
  }));
});

test('forged easingSessionCount refuses verify', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.easingSessionCount = 99;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureComputationReport({
    store: live.store, macroFeatureComputationReportId: stored.objectId,
  }));
});

test('forged firstSessionDate refuses normalization', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.firstSessionDate = '2026/03/02';
  assert.throws(() => normalizeMarketMacroFeatureComputationReportV1(forged));
});

test('report build refuses latest rows id', () => {
  assert.throws(() => buildMarketMacroFeatureComputationReport({
    store: live.store,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
    macroStateBySessionRowsId: 'latest',
  }));
});

test('report field is featureComputationReport not computationReport', () => {
  assert.equal(Object.hasOwn(live.report, 'featureComputationReport'), true);
  assert.equal(Object.hasOwn(live.report, 'computationReport'), false);
});

test('report emptyComputation is false for official fixture', () => {
  assert.equal(live.report.featureComputationReport.emptyComputation, false);
});

test('report first and last session bounds match rows', () => {
  const report = live.report.featureComputationReport;
  const rows = live.rows.macroStateBySessionRows.rows;
  assert.equal(report.firstSessionDate, rows[0].sessionDate);
  assert.equal(report.lastSessionDate, rows.at(-1).sessionDate);
});

test('report future rejection counters are non-negative', () => {
  const report = live.report.featureComputationReport;
  assert.ok(report.futureVintageRejectedCount >= 0);
  assert.ok(report.futureCalendarUpdateRejectedCount >= 0);
});
