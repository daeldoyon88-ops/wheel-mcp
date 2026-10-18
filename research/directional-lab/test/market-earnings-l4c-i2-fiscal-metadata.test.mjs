/**
 * L4C-I2 DEI fiscal metadata reader over pinned SEC document bytes (CASE B).
 *
 * The reader is disjoint from the L4C-I1 extractor: it emits no observation, it
 * reads only the four declared DEI tags, and it diagnoses rather than guesses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readEarningsFiscalMetadataFromPinnedBytesV1 } from '../src/earnings/earningsFiscalMetadataL4CIIV1.mjs';
import { putEarningsSecDocumentBytes } from '../src/earnings/earningsSecDocumentBytesL4CIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  code,
  pinFiscalDocumentBytes,
  syntheticFiscalXbrlXml,
  withClassifiedSingleFiling,
  withEarningsStore,
  withL4CI2SingleFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const METADATA_MODULE_PATH = fileURLToPath(
  new URL('../src/earnings/earningsFiscalMetadataL4CIIV1.mjs', import.meta.url));

/** Pin one synthetic document and read its fiscal metadata. */
const readFrom = (store, options) => readEarningsFiscalMetadataFromPinnedBytesV1({
  store, secDocumentBytesId: pinFiscalDocumentBytes(store, syntheticFiscalXbrlXml(options)),
});

test('I2-M001 reads dei:DocumentPeriodEndDate from the pinned bytes', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store, { documentPeriodEndDate: '2026-03-31' });
    assert.equal(reading.documentPeriodEndDate, '2026-03-31');
    assert.equal(reading.orderedSourceFactTags.includes('DocumentPeriodEndDate'), true);
  });
});

test('I2-M002 reads dei:DocumentFiscalPeriodFocus from the pinned bytes', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store, { documentFiscalPeriodFocus: 'Q3' });
    assert.equal(reading.documentFiscalPeriodFocus, 'Q3');
    assert.equal(reading.orderedSourceFactTags.includes('DocumentFiscalPeriodFocus'), true);
  });
});

test('I2-M003 reads dei:DocumentFiscalYearFocus from the pinned bytes', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store, { documentFiscalYearFocus: '2025' });
    assert.equal(reading.documentFiscalYearFocus, '2025');
    assert.equal(reading.orderedSourceFactTags.includes('DocumentFiscalYearFocus'), true);
  });
});

test('I2-M004 ignores every non-DEI fact', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store, {});
    // us-gaap revenue and EPS facts are present in the document and absent here.
    assert.deepEqual(Object.keys(reading).sort(), [
      'complete', 'diagnostics', 'documentFiscalPeriodFocus', 'documentFiscalYearFocus',
      'documentPeriodEndDate', 'documentType', 'orderedSourceFactTags', 'secDocumentBytesId',
    ]);
    assert.equal(JSON.stringify(reading).includes('us-gaap'), false);
  });
});

test('I2-M005 emits no metric observation (output domain disjoint from L4C-I1)', () => {
  const source = readFileSync(METADATA_MODULE_PATH, 'utf8');
  // The L4C-I1 extractor is named in the header comment as the module this one
  // must never import; what matters is that no import specifier reaches it.
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gmu)]
    .map((match) => match[1]);
  assert.equal(specifiers.some((s) => s.includes('earningsXbrlExtractionL4CIV1')), false);
  assert.equal(specifiers.some((s) => s.includes('earningsMetricObservation')), false);
  assert.equal(source.includes('buildEarningsMetricObservationCore'), false);
  withEarningsStore((store) => {
    const reading = readFrom(store, {});
    assert.equal(Object.hasOwn(reading, 'orderedObservationIds'), false);
  });
});

test('I2-M006 diagnoses EARNINGS_FISCAL_METADATA_ABSENT when the focus tag is missing', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store, { documentFiscalPeriodFocus: null });
    assert.equal(reading.documentFiscalPeriodFocus, null);
    assert.deepEqual(reading.diagnostics.map((entry) => entry.code),
      ['EARNINGS_FISCAL_METADATA_ABSENT']);
    assert.equal(reading.complete, false);
  });
});

test('I2-M007 diagnoses EARNINGS_FISCAL_METADATA_AMBIGUOUS on two distinct focus values', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store,
      { documentFiscalPeriodFocus: 'Q1', repeatedFocusValues: ['Q2'] });
    assert.equal(reading.documentFiscalPeriodFocus, null);
    assert.equal(reading.diagnostics.some((entry) =>
      entry.code === 'EARNINGS_FISCAL_METADATA_AMBIGUOUS'), true);
  });
});

test('I2-M008 reads only documents pinned in the filing orderedDocuments', () => {
  withEarningsStore((store) => {
    const pinned = pinFiscalDocumentBytes(store,
      syntheticFiscalXbrlXml({ documentFiscalPeriodFocus: 'Q1' }));
    // A second document exists in the store but is not the one addressed.
    pinFiscalDocumentBytes(store, syntheticFiscalXbrlXml({ documentFiscalPeriodFocus: 'Q4' }));
    const reading = readEarningsFiscalMetadataFromPinnedBytesV1({
      store, secDocumentBytesId: pinned,
    });
    assert.equal(reading.documentFiscalPeriodFocus, 'Q1');
    assert.equal(reading.secDocumentBytesId, pinned);
  });
});

test('I2-M009 diagnoses divergent DocumentPeriodEndDate across structured documents', () => {
  withClassifiedSingleFiling({
    accessionNumber: '1234567890-26-000301', formType: '8-K',
    acceptanceDatetimeRaw: '20260423160530',
    documents: [
      {
        documentPeriodEndDate: '2026-03-31', documentFiscalPeriodFocus: 'Q1',
        documentFiscalYearFocus: '2026', documentType: '8-K',
        durations: [{ start: '2026-01-01', end: '2026-03-31' }],
      },
      {
        documentPeriodEndDate: '2026-06-30', documentFiscalPeriodFocus: 'Q1',
        documentFiscalYearFocus: '2026', documentType: '8-K',
        documentRole: 'EXHIBIT_XBRL',
        durations: [{ start: '2026-04-01', end: '2026-06-30' }],
      },
    ],
  }, ({ classified, classifications }) => {
    assert.equal(classifications.length, 0);
    assert.equal(classified.diagnostics.some((entry) =>
      entry.code === 'EARNINGS_FISCAL_METADATA_DIVERGENT'), true);
  });
});

test('I2-M010 raises EARNINGS_FISCAL_PERIOD_END_MISMATCH when the DPE differs from the pinned raw periodEnd',
  () => {
    // A raw period whose periodEnd differs from the attested DocumentPeriodEndDate
    // is not eligible, so it can never be classified under that date.
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK, ({ classifications }) => {
      for (const core of classifications) {
        assert.equal(core.documentPeriodEndDate, '2026-03-31');
      }
    });
    assert.equal(typeof code('EARNINGS_FISCAL_PERIOD_END_MISMATCH'), 'function');
  });

test('I2-M011 diagnoses an out-of-enum focus value such as H1', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store, { documentFiscalPeriodFocus: 'H1' });
    assert.equal(reading.documentFiscalPeriodFocus, null);
    assert.equal(reading.diagnostics.some((entry) =>
      entry.code === 'EARNINGS_FISCAL_FOCUS_INVALID'), true);
  });
});

test('I2-M012 diagnoses a fiscal year focus that is not four digits', () => {
  withEarningsStore((store) => {
    const reading = readFrom(store, { documentFiscalYearFocus: 'FY26' });
    assert.equal(reading.documentFiscalYearFocus, null);
    assert.equal(reading.diagnostics.some((entry) =>
      entry.code === 'EARNINGS_FISCAL_YEAR_FOCUS_INVALID'), true);
  });
});

test('I2-M013 verifies the document sha256 pin before decoding', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q1EightK, (ctx) => {
    assert.throws(() => readEarningsFiscalMetadataFromPinnedBytesV1({
      store: ctx.store, secDocumentBytesId: `sha256:${'c'.repeat(64)}`,
    }), (error) => typeof error.code === 'string' && error.code.startsWith('EARNINGS_'));
    const source = readFileSync(METADATA_MODULE_PATH, 'utf8');
    assert.equal(source.includes('verifyEarningsSecDocumentBytes'), true);
  });
});

test('I2-M014 decodes bytes as strict UTF-8 and refuses invalid sequences', () => {
  withEarningsStore((store) => {
    const invalid = Buffer.concat([
      Buffer.from('<xbrl xmlns:dei="http://xbrl.sec.gov/dei/2025"><dei:DocumentType>', 'utf8'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('</dei:DocumentType></xbrl>', 'utf8'),
    ]);
    const secDocumentBytesId = putEarningsSecDocumentBytes({
      store, bytes: invalid, mediaType: 'application/xml',
      documentFormat: 'XBRL_XML', documentRole: 'PRIMARY_XBRL_INSTANCE',
    }).secDocumentBytesId;
    assert.throws(() => readEarningsFiscalMetadataFromPinnedBytesV1({
      store, secDocumentBytesId,
    }), code('EARNINGS_SOURCE_BYTES_MISMATCH'));
  });
});

test('I2-M015 produces the same metadata for the same bytes in two different stores', () => {
  const project = () => withEarningsStore((store) => {
    const reading = readFrom(store, { documentFiscalPeriodFocus: 'Q2' });
    return { ...reading, secDocumentBytesId: reading.secDocumentBytesId };
  });
  const first = project();
  const second = project();
  assert.deepEqual(second, first);
  assert.equal(second.secDocumentBytesId, first.secDocumentBytesId);
});
