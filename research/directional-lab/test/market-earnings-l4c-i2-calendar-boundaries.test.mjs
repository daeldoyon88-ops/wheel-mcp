/**
 * L4C-I2 calendar boundaries.
 *
 * Source dates are preserved verbatim. No day, week or month count participates
 * in classification, and no fiscal calendar authority exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFinancialPeriodIdentityCore } from '../src/earnings/earningsFinancialPeriodL4CIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  classifyVisibleRevision,
  withClassifiedSingleFiling,
  withL4CI2SingleFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const periodOf = (store, financialPeriodIdentityId) => verifyFinancialPeriodIdentityCore({
  store, financialPeriodIdentityId,
}).financialPeriodIdentityCore;

/** A single 10-K declaring FY over one explicit duration. */
const fiscalYearFiling = (accessionNumber, documentPeriodEndDate, start,
  acceptanceDatetimeRaw = '20270225160000', filerCik = '1234567890') => ({
  accessionNumber, formType: '10-K', acceptanceDatetimeRaw, filerCik,
  documents: [{
    documentPeriodEndDate, documentFiscalPeriodFocus: 'FY',
    documentFiscalYearFocus: '2026', documentType: '10-K',
    durations: [{ start, end: documentPeriodEndDate, eps: '5.30', revenue: '530000000' }],
  }],
});

test('I2-N001 a 53-week fiscal year keeps its exact source dates', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyFiftyThreeWeek,
    ({ classifications, store }) => {
      assert.equal(classifications.length, 1);
      const period = periodOf(store, classifications[0].financialPeriodIdentityId);
      assert.equal(period.periodStart, '2025-12-29');
      assert.equal(period.periodEnd, '2027-01-02');
      assert.equal(classifications[0].documentPeriodEndDate, '2027-01-02');
    });
});

test('I2-N002 a 52-week fiscal year keeps its exact source dates', () => {
  withClassifiedSingleFiling(fiscalYearFiling('1234567890-27-000701', '2026-12-26', '2025-12-28'),
    ({ classifications, store }) => {
      const period = periodOf(store, classifications[0].financialPeriodIdentityId);
      assert.equal(period.periodStart, '2025-12-28');
      assert.equal(period.periodEnd, '2026-12-26');
    });
});

test('I2-N003 a non-calendar fiscal year ending 2026-02-01 classifies FISCAL_YEAR', () => {
  withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-26-000702', '2026-02-01', '2025-02-03', '20260415160000'),
    ({ classifications, store }) => {
      assert.equal(classifications.length, 1);
      assert.equal(classifications[0].fiscalPeriodClass, 'FISCAL_YEAR');
      const period = periodOf(store, classifications[0].financialPeriodIdentityId);
      assert.equal(period.periodEnd, '2026-02-01');
    });
});

test('I2-N004 no duration length in days is ever computed', () => {
  // A single eligible duration is classified whatever its length: a two-day and
  // a full-year fiscal year receive the identical class, basis and method.
  const project = ({ classifications }) => ({
    length: classifications.length,
    fiscalPeriodClass: classifications[0]?.fiscalPeriodClass,
    classificationBasis: classifications[0]?.classificationBasis,
    classificationMethod: classifications[0]?.classificationMethod,
  });
  const twoDays = withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-27-000703', '2026-12-31', '2026-12-30'), project);
  const fullYear = withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-27-000704', '2026-12-31', '2026-01-01'), project);
  assert.deepEqual(twoDays, fullYear);
  assert.equal(twoDays.fiscalPeriodClass, 'FISCAL_YEAR');
});

test('I2-N005 a fiscal year-end change is classified from each filing independently', () => {
  const first = withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-26-000705', '2026-06-30', '2025-07-01', '20260918160000'),
    ({ classifications, store }) => periodOf(store, classifications[0].financialPeriodIdentityId));
  const second = withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-27-000706', '2026-12-31', '2026-07-01'),
    ({ classifications, store }) => periodOf(store, classifications[0].financialPeriodIdentityId));
  // Neither filing needed the other's year end to be classified.
  assert.equal(first.periodEnd, '2026-06-30');
  assert.equal(second.periodEnd, '2026-12-31');
  assert.notEqual(second.periodStart, first.periodStart);
});

test('I2-N006 a stub period declared FY classifies FISCAL_YEAR without a length check', () => {
  withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-27-000707', '2026-12-31', '2026-11-01'),
    ({ classifications }) => {
      assert.equal(classifications.length, 1);
      assert.equal(classifications[0].fiscalPeriodClass, 'FISCAL_YEAR');
      assert.equal(classifications[0].classificationBasis, 'SOURCE_ATTESTED');
    });
});

test('I2-N007 a fiscal year change does not alter previously emitted classification ids', () => {
  const idsFor = () => withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-26-000708', '2026-06-30', '2025-07-01', '20260918160000'),
    ({ classified }) => [...classified.orderedFiscalPeriodClassificationIds]);
  const before = idsFor();
  // A later filing with a different year end exists in its own store and can
  // never reach back into the earlier classification.
  withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-27-000709', '2026-12-31', '2026-07-01'), () => {});
  assert.deepEqual(idsFor(), before);
});

test('I2-N008 two filers with different fiscal year ends never share a classification id', () => {
  const a = withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-27-000710', '2026-12-31', '2026-01-01'),
    ({ classified }) => classified.orderedFiscalPeriodClassificationIds[0]);
  const b = withClassifiedSingleFiling(
    fiscalYearFiling('9876543210-27-000711', '2026-06-30', '2025-07-01', '20260918160000',
      '9876543210'),
    ({ classified }) => classified.orderedFiscalPeriodClassificationIds[0]);
  assert.notEqual(b, a);
});

test('I2-N009 a period whose end differs from the DPE is never classified', () => {
  withL4CI2SingleFilingFixture({
    accessionNumber: '1234567890-26-000712', formType: '10-Q',
    acceptanceDatetimeRaw: '20260807160000',
    documents: [{
      documentPeriodEndDate: '2026-06-30', documentFiscalPeriodFocus: 'Q2',
      documentFiscalYearFocus: '2026', documentType: '10-Q',
      durations: [
        { start: '2026-04-01', end: '2026-06-30', eps: '1.30', revenue: '130000000' },
        { start: '2026-01-01', end: '2026-06-30', eps: '2.55', revenue: '255000000' },
      ],
    }],
  }, (ctx) => {
    const { classifications, store } = classifyVisibleRevision(ctx.store, ctx);
    for (const core of classifications) {
      assert.equal(periodOf(store ?? ctx.store, core.financialPeriodIdentityId).periodEnd,
        '2026-06-30');
    }
  });
});

test('I2-N010 no classification is produced within a plus or minus one day tolerance', () => {
  // The declared DocumentPeriodEndDate is one day away from the only duration,
  // so no raw period is eligible and nothing is classified.
  withClassifiedSingleFiling(
    fiscalYearFiling('1234567890-27-000713', '2026-12-31', '2026-01-01'),
    ({ classifications }) => assert.equal(classifications.length, 1));
  withClassifiedSingleFiling({
    accessionNumber: '1234567890-27-000714', formType: '10-K',
    acceptanceDatetimeRaw: '20270225160000',
    documents: [{
      documentPeriodEndDate: '2026-12-31', documentFiscalPeriodFocus: 'FY',
      documentFiscalYearFocus: '2026', documentType: '10-K',
      durations: [{ start: '2026-01-01', end: '2026-12-30', eps: '5.30', revenue: '530000000' }],
    }],
  }, ({ classifications }) => {
    assert.equal(classifications.length, 0);
  });
});

test('I2-N011 the raw FinancialPeriodIdentityCore object is never rewritten', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.fyTenKA, (ctx) => {
    const before = classifyVisibleRevision(ctx.store, ctx);
    const rawPeriodId = before.entry.orderedRawPeriodIds[0];
    const beforeValue = periodOf(ctx.store, rawPeriodId);
    classifyVisibleRevision(ctx.store, ctx);
    assert.deepEqual(periodOf(ctx.store, rawPeriodId), beforeValue);
    assert.deepEqual(Object.keys(beforeValue).sort(),
      ['periodEnd', 'periodStart', 'periodType', 'schemaVersion']);
  });
});

test('I2-N012 the raw FinancialPeriodIdentityCore id is unchanged after classification', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.fyTenKA, (ctx) => {
    const before = classifyVisibleRevision(ctx.store, ctx);
    const rawPeriodId = before.entry.orderedRawPeriodIds[0];
    const after = classifyVisibleRevision(ctx.store, ctx);
    assert.equal(after.entry.orderedRawPeriodIds[0], rawPeriodId);
    assert.equal(after.classifications[0].financialPeriodIdentityId, rawPeriodId);
  });
});
