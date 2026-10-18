/** L4C-I2 form/focus compatibility over the closed six-row table. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EARNINGS_FORM_FOCUS_COMPATIBILITY,
  allowedFocusValuesForFormType,
} from '../src/contracts/earningsContractsL4CIIV1.mjs';
import { EARNINGS_ALLOWED_FORM_TYPES } from '../src/contracts/earningsContractsL4CIV1.mjs';
import { admitSecFilingForEarningsV1 } from '../src/earnings/earningsSecFilingSourceDocumentL4CIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  pinFiscalFiling,
  withClassifiedSingleFiling,
  withEarningsStore,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

test('I2-F001 10-K accepts only FY focus', () => {
  assert.deepEqual(allowedFocusValuesForFormType('10-K'), ['FY']);
});

test('I2-F002 10-K/A accepts only FY focus', () => {
  assert.deepEqual(allowedFocusValuesForFormType('10-K/A'), ['FY']);
});

test('I2-F003 10-Q accepts only Q1, Q2 or Q3', () => {
  assert.deepEqual(allowedFocusValuesForFormType('10-Q'), ['Q1', 'Q2', 'Q3']);
});

test('I2-F004 10-Q/A accepts only Q1, Q2 or Q3', () => {
  assert.deepEqual(allowedFocusValuesForFormType('10-Q/A'), ['Q1', 'Q2', 'Q3']);
});

test('I2-F005 8-K accepts Q1, Q2, Q3, Q4 and FY', () => {
  assert.deepEqual(allowedFocusValuesForFormType('8-K'), ['Q1', 'Q2', 'Q3', 'Q4', 'FY']);
});

test('I2-F006 8-K/A accepts the same focus set as 8-K', () => {
  assert.deepEqual(allowedFocusValuesForFormType('8-K/A'),
    allowedFocusValuesForFormType('8-K'));
});

test('I2-F007 8-K without Item 2.02 never reaches classification (rejected upstream by L4C-I1)',
  () => {
    withEarningsStore((store) => {
      const filing = pinFiscalFiling(store, {
        ...L4C_I2_FILING_DEFINITIONS.q1EightK,
        accessionNumber: '1234567890-26-000401',
        items: ['5.02'],
      });
      assert.throws(() => admitSecFilingForEarningsV1({
        store, sourceFilingDocumentId: filing.sourceFilingDocumentId,
      }), (error) => typeof error.code === 'string' && error.code.startsWith('EARNINGS_'));
    });
  });

test('I2-F008 sourceFormType on the classification equals the pinned filing formType', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK, ({ classifications, filings }) => {
    assert.ok(classifications.length > 0);
    for (const core of classifications) {
      assert.equal(core.sourceFormType, filings[0].secFilingSourceDocument.formType);
      assert.equal(core.sourceFormType, '8-K');
    }
  });
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyTenKA, ({ classifications }) => {
    for (const core of classifications) assert.equal(core.sourceFormType, '10-K/A');
  });
});

test('I2-F009 10-K with Q2 focus is diagnosed EARNINGS_FISCAL_FOCUS_FORM_INCOMPATIBLE and emits nothing',
  () => {
    withClassifiedSingleFiling({
      accessionNumber: '1234567890-26-000402', formType: '10-K',
      acceptanceDatetimeRaw: '20260807160000',
      documents: [{
        documentPeriodEndDate: '2026-06-30', documentFiscalPeriodFocus: 'Q2',
        documentFiscalYearFocus: '2026', documentType: '10-K',
        durations: [{ start: '2026-04-01', end: '2026-06-30' }],
      }],
    }, ({ classifications, classified }) => {
      assert.equal(classifications.length, 0);
      assert.equal(classified.diagnostics.some((entry) =>
        entry.code === 'EARNINGS_FISCAL_FOCUS_FORM_INCOMPATIBLE'), true);
    });
  });

test('I2-F010 10-Q with FY focus is diagnosed incompatible and emits nothing', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.focusFormIncompatible,
    ({ classifications, classified }) => {
      assert.equal(classifications.length, 0);
      assert.equal(classified.diagnostics.some((entry) =>
        entry.code === 'EARNINGS_FISCAL_FOCUS_FORM_INCOMPATIBLE'), true);
    });
});

test('I2-F011 an unknown formType can never appear (closed L4C-I1 admission set)', () => {
  assert.deepEqual([...EARNINGS_ALLOWED_FORM_TYPES],
    ['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A']);
  assert.deepEqual(EARNINGS_FORM_FOCUS_COMPATIBILITY.map((row) => row.formType).sort(),
    [...EARNINGS_ALLOWED_FORM_TYPES].sort());
  for (const unknown of ['S-1', '20-F', '6-K', '']) {
    assert.equal(allowedFocusValuesForFormType(unknown), null, unknown);
    assert.equal(EARNINGS_ALLOWED_FORM_TYPES.includes(unknown), false, unknown);
  }
});
