/**
 * L4C-I2 PARTIAL materialization.
 *
 * When the pinned facts do not prove a role, the classifier diagnoses and omits.
 * The report stays fully verifiable and never invents a classification.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEarningsAsOfMaterializationReport } from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import { verifyEarningsMaterializationTraversalV1 } from '../src/earnings/earningsMaterializationTraversalL4CIIV1.mjs';
import { independentDiagnosticDigestV1 } from './helpers/independentEarningsAsOfOracleL4CIIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  classifyVisibleRevision,
  materializeL4CI2Dataset,
  pinL4CI2Dataset,
  withClassifiedSingleFiling,
  withEarningsStore,
  withL4CI2SingleFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

test('I2-PA01 a visible revision with no DEI focus yields zero classifications and one diagnostic',
  () => {
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.focusAbsent,
      ({ classifications, classified }) => {
        assert.equal(classifications.length, 0);
        assert.equal(classified.status, 'PARTIAL');
        assert.deepEqual(classified.diagnostics.map((entry) => entry.code),
          ['EARNINGS_FISCAL_METADATA_ABSENT']);
      });
  });

test('I2-PA02 a visible revision with no metric observation yields zero raw periods', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.noMetricObservation,
    ({ entry, classified, resolution }) => {
      // GATE-06 CASE-NO-METRIC: focus present, revision visible, zero observations
      // ⇒ zero raw periods. Distinct from focusAbsent (which still has durations).
      assert.equal(resolution.visibleMetricObservationCount, 0);
      assert.equal(resolution.visibleRawPeriodCount, 0);
      assert.equal(entry.orderedRawPeriodIds.length, 0);
      assert.equal(entry.orderedMetricObservationIds.length, 0);
      assert.equal(classified.orderedFiscalPeriodClassificationIds.length, 0);
    });
});

test('I2-PA03 a snapshot mixing classifiable and unclassifiable revisions materializes both', () => {
  withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.q1EightK,
      L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration,
    ]);
    const { materialization } = materializeL4CI2Dataset(store, dataset);
    const report = materialization.earningsAsOfMaterializationReport;
    assert.equal(report.visibleRevisionCount, 2);
    assert.ok(report.fiscalClassificationCount > 0);
    assert.ok(report.classificationDiagnosticCount > 0);
    assert.ok(report.unclassifiedRawPeriodCount > 0);
  });
});

test('I2-PA04 unclassifiedRawPeriodCount counts exactly the omitted raw periods', () => {
  withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.q1EightK,
      L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration,
    ]);
    const { materialization } = materializeL4CI2Dataset(store, dataset);
    const report = materialization.earningsAsOfMaterializationReport;
    // The Q4 filing contributes two eligible durations, neither classified.
    assert.equal(report.unclassifiedRawPeriodCount, 2);
    assert.equal(report.classifiedRawPeriodCount + report.unclassifiedRawPeriodCount,
      report.visibleRawPeriodCount);
  });
});

test('I2-PA05 the diagnostic digest covers every omitted raw period', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, (ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const diagnostics = materialization.classificationDiagnostics;
    assert.equal(diagnostics.length, report.classificationDiagnosticCount);
    assert.equal(report.orderedClassificationDiagnosticDigest,
      independentDiagnosticDigestV1(diagnostics));
    const tokens = new Set(diagnostics.map((entry) => entry.rawPeriodIdToken));
    for (const rawPeriodId of report.orderedVisibleRawPeriodIds) {
      assert.equal(tokens.has(rawPeriodId), true, rawPeriodId);
    }
  });
});

test('I2-PA06 a partial materialization is still fully verifiable', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, (ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const verified = verifyEarningsAsOfMaterializationReport({
      store: ctx.store,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    });
    assert.deepEqual(verified.earningsAsOfMaterializationReport,
      materialization.earningsAsOfMaterializationReport);
    const traversal = verifyEarningsMaterializationTraversalV1({
      store: ctx.store,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    });
    assert.equal(traversal.verified, true);
  });
});

test('I2-PA07 a partial materialization never invents a classification', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, (ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    assert.equal(report.fiscalClassificationCount, 0);
    assert.deepEqual(report.orderedFiscalClassificationIds, []);
    assert.equal(report.classifiedRawPeriodCount, 0);
    for (const bucket of Object.values(report.countsByFiscalPeriodClass)) {
      assert.equal(bucket, 0);
    }
  });
});

test('I2-PA08 the ambiguous case emits a diagnostic rather than an arbitrary role', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, (ctx) => {
    const { classified } = classifyVisibleRevision(ctx.store, ctx);
    assert.equal(classified.orderedFiscalPeriodClassificationIds.length, 0);
    assert.equal(classified.status, 'PARTIAL');
    assert.deepEqual(new Set(classified.diagnostics.map((entry) => entry.code)),
      new Set(['EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS']));
    // The longer span is not silently promoted to FISCAL_YEAR nor the shorter to
    // QUARTER: both raw periods are named by an exact diagnostic.
    assert.equal(classified.diagnostics.length, 2);
  });
});
