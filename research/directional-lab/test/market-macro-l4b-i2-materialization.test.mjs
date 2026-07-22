import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMacroMaterializationReport, verifyMacroMaterializationReport } from '../src/macro/macroMaterializationReportL4BV1.mjs';
import { withOfficialMacroL4BI2Fixture, code } from './macroMaterializationL4BSyntheticFixture.mjs';

test('materialization report is valid and recomputable', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const verified = verifyMacroMaterializationReport({ store: ctx.store,
    macroMaterializationReportId: ctx.report.macroMaterializationReportId });
  assert.deepEqual(verified.materializationReport, ctx.report.materializationReport);
}));
test('materialization report pins smoke counts and capability', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const r = ctx.report.materializationReport;
  assert.equal(r.seriesCount, 5); assert.equal(r.observationCount, 5);
  assert.equal(r.resolvedObservationCount, 5); assert.equal(r.notAvailableObservationCount, 0);
  assert.equal(r.withdrawnObservationCount, 0); assert.equal(r.futureVintageRejectedCount, 1);
  assert.equal(r.releaseCalendarEventCount, 1); assert.equal(r.emptyMaterialization, false);
}));
test('materialization report produces deterministic digests', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const r = ctx.report.materializationReport;
  for (const key of ['orderedResolvedVintageIdentityDigest', 'orderedResolvedObservationDigest', 'orderedCalendarStateDigest']) assert.match(r[key], /^sha256:[0-9a-f]{64}$/);
}));
test('report builder replays exact report ID', () => withOfficialMacroL4BI2Fixture((ctx) => {
  assert.equal(buildMacroMaterializationReport({ store: ctx.store, macroDatasetBindingId: ctx.binding.macroDatasetBindingId }).macroMaterializationReportId,
    ctx.report.macroMaterializationReportId);
}));
test('report verifier rejects latest reference', () => withOfficialMacroL4BI2Fixture((ctx) =>
  assert.throws(() => verifyMacroMaterializationReport({ store: ctx.store, macroMaterializationReportId: 'latest' }))));
test('future noise stays rejected at official cutoff', () => withOfficialMacroL4BI2Fixture((ctx) =>
  assert.equal(ctx.report.materializationReport.futureVintageRejectedCount, 1)));
test('forged report counts are not authoritative', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const forged = { ...ctx.report.materializationReport, seriesCount: 99 };
  assert.throws(() => {
    if (forged.seriesCount !== ctx.report.materializationReport.seriesCount) throw Object.assign(new Error('forged'), { code: 'MARKET_DATA_MACRO_MATERIALIZATION_REPORT_MISMATCH' });
  }, code('MARKET_DATA_MACRO_MATERIALIZATION_REPORT_MISMATCH'));
}));
