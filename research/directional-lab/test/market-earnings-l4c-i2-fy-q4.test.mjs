/**
 * L4C-I2 fiscal-year and terminal-quarter doctrine.
 *
 * A terminal quarter is only ever emitted when the source attests it. Nothing
 * is derived by subtraction, and a second duration under FY focus is diagnosed
 * rather than promoted to Q4.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyFinancialPeriodIdentityCore } from '../src/earnings/earningsFinancialPeriodL4CIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  classifyVisibleRevision,
  materializeL4CI2Dataset,
  withClassifiedSingleFiling,
  withL4CI2SingleFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';
import { classifyEarningsFiscalPeriodsForRevisionV1 } from '../src/earnings/earningsFiscalClassificationL4CIIV1.mjs';

const CLASSIFIER_SOURCE = readFileSync(fileURLToPath(
  new URL('../src/earnings/earningsFiscalClassificationL4CIIV1.mjs', import.meta.url)), 'utf8');

const byClass = (classifications, fiscalPeriodClass) =>
  classifications.filter((core) => core.fiscalPeriodClass === fiscalPeriodClass);

test('I2-Y001 10-K with FY focus and one duration classifies FISCAL_YEAR', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyTenKA, ({ classifications }) => {
    assert.equal(classifications.length, 1);
    assert.equal(classifications[0].fiscalPeriodClass, 'FISCAL_YEAR');
    assert.equal(classifications[0].fiscalPeriodFocus, 'FY');
    assert.equal(classifications[0].classificationBasis, 'SOURCE_ATTESTED');
    assert.equal(classifications[0].classificationMethod, 'DECLARED_FOCUS');
  });
});

test('I2-Y002 10-K with FY focus and two durations classifies the longer as FISCAL_YEAR/FY with POLICY_INFERRED and RELATIONAL_SPAN_ORDER',
  () => {
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations,
      ({ classifications, store }) => {
        assert.equal(classifications.length, 1);
        const [fiscalYear] = classifications;
        assert.equal(fiscalYear.fiscalPeriodClass, 'FISCAL_YEAR');
        assert.equal(fiscalYear.classificationBasis, 'POLICY_INFERRED');
        assert.equal(fiscalYear.classificationMethod, 'RELATIONAL_SPAN_ORDER');
        const period = verifyFinancialPeriodIdentityCore({
          store, financialPeriodIdentityId: fiscalYear.financialPeriodIdentityId,
        }).financialPeriodIdentityCore;
        assert.equal(period.periodStart, '2026-01-01');
        assert.equal(period.periodEnd, '2026-12-31');
      });
  });

test('I2-Y003 under FY focus with two raw periods, the shorter rawPeriodId receives no classification; its diagnostic references the exact financialPeriodIdentityId; no QUARTER/Q4 is emitted',
  () => {
    withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations, (ctx) => {
      const { classifications, classified, entry } = classifyVisibleRevision(ctx.store, ctx);
      assert.equal(byClass(classifications, 'QUARTER').length, 0);
      assert.equal(classified.diagnostics.length, 1);
      const [diagnostic] = classified.diagnostics;
      assert.equal(diagnostic.code, 'EARNINGS_FISCAL_TERMINAL_QUARTER_UNPROVABLE');
      // The diagnostic names the exact shorter raw period, not a label.
      assert.equal(entry.orderedRawPeriodIds.includes(diagnostic.rawPeriodIdToken), true);
      assert.notEqual(diagnostic.rawPeriodIdToken,
        classifications[0].financialPeriodIdentityId);
      const shorter = verifyFinancialPeriodIdentityCore({
        store: ctx.store, financialPeriodIdentityId: diagnostic.rawPeriodIdToken,
      }).financialPeriodIdentityCore;
      assert.equal(shorter.periodStart, '2026-10-01');
      assert.equal(shorter.periodEnd, '2026-12-31');
    });
  });

test('I2-Y004 10-K with FY focus and one duration emits no Q4 classification at all', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyTenKA, ({ classifications }) => {
    assert.equal(byClass(classifications, 'QUARTER').length, 0);
    assert.equal(classifications.some((core) => core.fiscalPeriodFocus === 'Q4'), false);
  });
});

test('I2-Y005 no Q4 is ever produced by subtracting nine months from the fiscal year', () => {
  // The classifier owns no arithmetic on months: a derived nine-month span is
  // impossible by construction.
  assert.equal(/nineMonth|NINE_MONTH|setMonth|getMonth|- *9\b/u.test(CLASSIFIER_SOURCE), false);
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations,
    ({ classifications, entry }) => {
      // Only raw periods that were actually pinned may appear.
      for (const core of classifications) {
        assert.equal(entry.orderedRawPeriodIds.includes(core.financialPeriodIdentityId), true);
      }
    });
});

test('I2-Y006 Q4-A: 8-K with Q4 focus and one eligible duration classifies QUARTER/Q4 as SOURCE_ATTESTED using DECLARED_FOCUS',
  () => {
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q4EightK, ({ classifications }) => {
      assert.equal(classifications.length, 1);
      const [quarter] = classifications;
      assert.equal(quarter.fiscalPeriodClass, 'QUARTER');
      assert.equal(quarter.fiscalPeriodFocus, 'Q4');
      assert.equal(quarter.classificationBasis, 'SOURCE_ATTESTED');
      assert.equal(quarter.classificationMethod, 'DECLARED_FOCUS');
    });
  });

test('I2-Y007 Q4-B: Q4 focus with two normal durations emits zero classifications and one stable ambiguity diagnostic per rawPeriodId',
  () => {
    withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, (ctx) => {
      const { classifications, classified, entry } = classifyVisibleRevision(ctx.store, ctx);
      assert.equal(classifications.length, 0);
      assert.equal(classified.diagnostics.length, 2);
      assert.deepEqual(new Set(classified.diagnostics.map((d) => d.code)),
        new Set(['EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS']));
      assert.deepEqual(new Set(classified.diagnostics.map((d) => d.rawPeriodIdToken)),
        new Set(entry.orderedRawPeriodIds));
    });
  });

test('I2-Y008 Q4-C: a possible YEAR_TO_DATE long duration plus a short duration remains ambiguous; neither duration is classified',
  () => {
    withClassifiedSingleFiling({
      ...L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration,
      accessionNumber: '1234567890-27-000601',
      documents: [{
        ...L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration.documents[0],
        durations: [
          { start: '2026-01-01', end: '2026-12-31', eps: '5.30', revenue: '530000000' },
          { start: '2026-12-01', end: '2026-12-31', eps: '0.50', revenue: '50000000' },
        ],
      }],
    }, ({ classifications, classified }) => {
      assert.equal(classifications.length, 0);
      assert.equal(classified.diagnostics.length, 2);
      assert.equal(classified.status, 'PARTIAL');
    });
  });

test('I2-Y009 Q4-D: a Q4 acquisition stub and a plausible quarter are indistinguishable; both raw periods are omitted',
  () => {
    const project = ({ classifications, classified }) => ({
      count: classifications.length,
      codes: [...new Set(classified.diagnostics.map((d) => d.code))].sort(),
      diagnostics: classified.diagnostics.length,
    });
    const stub = withClassifiedSingleFiling({
      ...L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration,
      accessionNumber: '1234567890-27-000602',
      documents: [{
        ...L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration.documents[0],
        durations: [
          { start: '2026-10-01', end: '2026-12-31', eps: '1.40', revenue: '140000000' },
          { start: '2026-11-20', end: '2026-12-31', eps: '0.30', revenue: '30000000' },
        ],
      }],
    }, project);
    const plausible = withClassifiedSingleFiling(
      L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, project);
    assert.deepEqual(stub, plausible);
    assert.equal(stub.count, 0);
  });

test('I2-Y010 Q4-E: reversing insertion order preserves diagnostics, zero classifications, ids and functional fingerprint',
  () => {
    withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, (ctx) => {
      const { entry } = classifyVisibleRevision(ctx.store, ctx);
      const classifyWith = (orderedRawPeriodIds) => classifyEarningsFiscalPeriodsForRevisionV1({
        store: ctx.store,
        earningsRevisionIdentityId: entry.earningsRevisionIdentityId,
        sourceFilingDocumentId: entry.sourceFilingDocumentId,
        orderedRawPeriodIds,
        earningsFiscalClassificationPolicyId: ctx.earningsFiscalClassificationPolicyId,
        transformImplementationManifestId: ctx.transformImplementationManifestId,
      });
      const forward = classifyWith([...entry.orderedRawPeriodIds]);
      const reversed = classifyWith([...entry.orderedRawPeriodIds].reverse());
      assert.equal(forward.orderedFiscalPeriodClassificationIds.length, 0);
      assert.equal(reversed.orderedFiscalPeriodClassificationIds.length, 0);
      assert.equal(reversed.earningsFiscalClassificationReportId,
        forward.earningsFiscalClassificationReportId);
      const fingerprint = materializeL4CI2Dataset(ctx.store, ctx)
        .materialization.earningsAsOfMaterializationReport.materializationFunctionalFingerprint;
      assert.equal(materializeL4CI2Dataset(ctx.store, ctx)
        .materialization.earningsAsOfMaterializationReport.materializationFunctionalFingerprint,
      fingerprint);
    });
  });
