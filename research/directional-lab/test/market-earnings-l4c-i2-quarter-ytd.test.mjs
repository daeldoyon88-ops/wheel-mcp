/**
 * L4C-I2 quarter versus year-to-date role assignment.
 *
 * Q1 with one duration carries both roles; Q2/Q3 with exactly two durations are
 * ordered by span; every other cardinality is diagnosed and omitted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFinancialPeriodIdentityCore } from '../src/earnings/earningsFinancialPeriodL4CIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  withClassifiedSingleFiling,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const byClass = (classifications, fiscalPeriodClass) =>
  classifications.filter((core) => core.fiscalPeriodClass === fiscalPeriodClass);

/** Build a one-document filing definition with an explicit duration list. */
const quarterly = (accessionNumber, focus, documentPeriodEndDate, durations) => ({
  accessionNumber, formType: '10-Q', acceptanceDatetimeRaw: '20260807160000',
  documents: [{
    documentPeriodEndDate, documentFiscalPeriodFocus: focus,
    documentFiscalYearFocus: '2026', documentType: '10-Q', durations,
  }],
});

test('I2-Q001 Q1 single duration emits a QUARTER classification', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK, ({ classifications }) => {
    const quarters = byClass(classifications, 'QUARTER');
    assert.equal(quarters.length, 1);
    assert.equal(quarters[0].fiscalPeriodFocus, 'Q1');
    assert.equal(quarters[0].classificationBasis, 'SOURCE_ATTESTED');
  });
});

test('I2-Q002 Q1 single duration also emits a YEAR_TO_DATE classification', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK, ({ classifications }) => {
    const ytd = byClass(classifications, 'YEAR_TO_DATE');
    assert.equal(ytd.length, 1);
    assert.equal(ytd[0].classificationMethod, 'Q1_DUAL_ROLE');
    assert.equal(ytd[0].classificationBasis, 'POLICY_INFERRED');
  });
});

test('I2-Q003 Q1 dual role produces two distinct classification ids on the same rawPeriodId', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK,
    ({ classifications, classified }) => {
      assert.equal(classified.orderedFiscalPeriodClassificationIds.length, 2);
      assert.equal(new Set(classified.orderedFiscalPeriodClassificationIds).size, 2);
      assert.equal(new Set(classifications.map((core) => core.financialPeriodIdentityId)).size, 1);
    });
});

test('I2-Q004 Q1 dual role increments dualRoleRawPeriodCount by one', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK, ({ classified }) => {
    assert.equal(classified.dualRoleRawPeriodCount, 1);
  });
});

test('I2-Q005 Q2 two durations assign the shorter span to QUARTER', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q2TenQ,
    ({ classifications, store }) => {
      const [quarter] = byClass(classifications, 'QUARTER');
      const period = verifyFinancialPeriodIdentityCore({
        store, financialPeriodIdentityId: quarter.financialPeriodIdentityId,
      }).financialPeriodIdentityCore;
      assert.equal(period.periodStart, '2026-04-01');
      assert.equal(period.periodEnd, '2026-06-30');
    });
});

test('I2-Q006 Q2 two durations assign the longer span to YEAR_TO_DATE', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q2TenQ,
    ({ classifications, store }) => {
      const [ytd] = byClass(classifications, 'YEAR_TO_DATE');
      const period = verifyFinancialPeriodIdentityCore({
        store, financialPeriodIdentityId: ytd.financialPeriodIdentityId,
      }).financialPeriodIdentityCore;
      assert.equal(period.periodStart, '2026-01-01');
      assert.equal(period.periodEnd, '2026-06-30');
    });
});

test('I2-Q007 Q3 two durations follow the same span order rule', () => {
  withClassifiedSingleFiling(
    quarterly('1234567890-26-000501', 'Q3', '2026-09-30', [
      { start: '2026-07-01', end: '2026-09-30', eps: '1.35', revenue: '135000000' },
      { start: '2026-01-01', end: '2026-09-30', eps: '3.90', revenue: '390000000' },
    ]),
    ({ classifications, store }) => {
      assert.equal(classifications.length, 2);
      const [quarter] = byClass(classifications, 'QUARTER');
      const [ytd] = byClass(classifications, 'YEAR_TO_DATE');
      const quarterPeriod = verifyFinancialPeriodIdentityCore({
        store, financialPeriodIdentityId: quarter.financialPeriodIdentityId,
      }).financialPeriodIdentityCore;
      const ytdPeriod = verifyFinancialPeriodIdentityCore({
        store, financialPeriodIdentityId: ytd.financialPeriodIdentityId,
      }).financialPeriodIdentityCore;
      assert.equal(quarterPeriod.periodStart, '2026-07-01');
      assert.equal(ytdPeriod.periodStart, '2026-01-01');
      for (const core of classifications) {
        assert.equal(core.classificationMethod, 'RELATIONAL_SPAN_ORDER');
      }
    });
});

test('I2-Q008 Q2 with a single duration is diagnosed EARNINGS_FISCAL_ROLE_UNDETERMINED and emits nothing',
  () => {
    withClassifiedSingleFiling(
      quarterly('1234567890-26-000502', 'Q2', '2026-06-30', [
        { start: '2026-04-01', end: '2026-06-30', eps: '1.30', revenue: '130000000' },
      ]),
      ({ classifications, classified }) => {
        assert.equal(classifications.length, 0);
        assert.deepEqual(classified.diagnostics.map((entry) => entry.code),
          ['EARNINGS_FISCAL_ROLE_UNDETERMINED']);
      });
  });

test('I2-Q009 Q1 with two durations is diagnosed EARNINGS_FISCAL_CLASSIFICATION_AMBIGUOUS and emits nothing',
  () => {
    withClassifiedSingleFiling(
      quarterly('1234567890-26-000503', 'Q1', '2026-03-31', [
        { start: '2026-01-01', end: '2026-03-31', eps: '1.25', revenue: '125000000' },
        { start: '2026-02-01', end: '2026-03-31', eps: '0.80', revenue: '80000000' },
      ]),
      ({ classifications, classified }) => {
        assert.equal(classifications.length, 0);
        assert.deepEqual(new Set(classified.diagnostics.map((entry) => entry.code)),
          new Set(['EARNINGS_FISCAL_CLASSIFICATION_AMBIGUOUS']));
        assert.equal(classified.diagnostics.length, 2);
      });
  });

test('I2-Q010 three or more durations under any quarterly focus emit nothing', () => {
  withClassifiedSingleFiling(
    quarterly('1234567890-26-000504', 'Q3', '2026-09-30', [
      { start: '2026-07-01', end: '2026-09-30', eps: '1.35', revenue: '135000000' },
      { start: '2026-01-01', end: '2026-09-30', eps: '3.90', revenue: '390000000' },
      { start: '2026-04-01', end: '2026-09-30', eps: '2.65', revenue: '265000000' },
    ]),
    ({ classifications, classified }) => {
      assert.equal(classifications.length, 0);
      assert.deepEqual(new Set(classified.diagnostics.map((entry) => entry.code)),
        new Set(['EARNINGS_FISCAL_ROLE_UNDETERMINED']));
      assert.equal(classified.diagnostics.length, 3);
    });
});

test('I2-Q011 quarter and YTD share the same documentPeriodEndDate', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q2TenQ, ({ classifications }) => {
    assert.equal(new Set(classifications.map((core) => core.documentPeriodEndDate)).size, 1);
    assert.equal(classifications[0].documentPeriodEndDate, '2026-06-30');
  });
});

test('I2-Q012 quarter and YTD carry the same fiscalPeriodFocus and fiscalYearFocus', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q2TenQ, ({ classifications }) => {
    assert.equal(new Set(classifications.map((core) => core.fiscalPeriodFocus)).size, 1);
    assert.equal(new Set(classifications.map((core) => core.fiscalYearFocus)).size, 1);
    assert.equal(classifications[0].fiscalPeriodFocus, 'Q2');
    assert.equal(classifications[0].fiscalYearFocus, '2026');
  });
});
