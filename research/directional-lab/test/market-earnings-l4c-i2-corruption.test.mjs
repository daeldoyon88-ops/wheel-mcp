/**
 * L4C-I2 corruption fail-closed behaviour.
 *
 * Every reader distinguishes absence, corruption and a valid object of the
 * wrong shape, and never degrades a corrupt input into a soft warning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyEarningsFiscalPeriodClassificationCore } from '../src/earnings/earningsFiscalClassificationL4CIIV1.mjs';
import { verifyEarningsFiscalClassificationReport } from '../src/earnings/earningsFiscalClassificationReportL4CIIV1.mjs';
import { verifyEarningsDatasetBinding } from '../src/earnings/earningsDatasetBindingL4CIIV1.mjs';
import { verifyEarningsAsOfMaterializationReport } from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import { readEarningsFiscalMetadataFromPinnedBytesV1 } from '../src/earnings/earningsFiscalMetadataL4CIIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  code,
  materializeL4CI2Dataset,
  overlayL4CI2Store,
  withL4CI2SingleFilingFixture,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const readSnapshotValue = (store, objectId, schemaVersion) => store.readCanonicalObject({
  uri: store.uriForObject({ namespace: 'snapshots', objectId }),
  expectedObjectId: objectId,
  schemaVersion,
}).value;

test('I2-D001 a corrupted classification core object fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const [id] = materialization.earningsAsOfMaterializationReport.orderedFiscalClassificationIds;
    const value = readSnapshotValue(ctx.store, id, 'EarningsFiscalPeriodClassificationCore/1');
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[id, { ...value, fiscalPeriodClass: 'NOT_A_CLASS' }]]));
    assert.throws(() => verifyEarningsFiscalPeriodClassificationCore({
      store: overlay, earningsFiscalPeriodClassificationId: id,
    }), code('EARNINGS_FISCAL_CLASSIFICATION_INVALID'));
  });
});

test('I2-D002 a corrupted classification report fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const [id] = materialization.earningsAsOfMaterializationReport
      .orderedFiscalClassificationReportIds;
    const value = readSnapshotValue(ctx.store, id, 'EarningsFiscalClassificationReport/1');
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[id, { ...value, orderedDiagnosticDigest: 'not-a-digest' }]]));
    assert.throws(() => verifyEarningsFiscalClassificationReport({
      store: overlay, earningsFiscalClassificationReportId: id, diagnostics: undefined,
    }), code('EARNINGS_FISCAL_REPORT_INVALID'));
  });
});

test('I2-D003 a corrupted binding fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { binding } = materializeL4CI2Dataset(ctx.store, ctx);
    const overlay = overlayL4CI2Store(ctx.store, new Map([[binding.earningsDatasetBindingId,
      { ...binding.earningsDatasetBinding, currencyCode: 'EUR' }]]));
    assert.throws(() => verifyEarningsDatasetBinding({
      store: overlay, earningsDatasetBindingId: binding.earningsDatasetBindingId,
    }), code('EARNINGS_BINDING_INVALID'));
  });
});

test('I2-D004 a corrupted materialization report fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const id = materialization.earningsAsOfMaterializationReportId;
    const overlay = overlayL4CI2Store(ctx.store, new Map([[id,
      { ...materialization.earningsAsOfMaterializationReport, jurisdictionCode: 'CA' }]]));
    assert.throws(() => verifyEarningsAsOfMaterializationReport({
      store: overlay, earningsAsOfMaterializationReportId: id,
    }), code('EARNINGS_MATERIALIZATION_INVALID'));
  });
});

test('I2-D005 a truncated pinned document byte stream fails closed', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q1EightK, (ctx) => {
    const filing = ctx.filings[0].secFilingSourceDocument;
    const secDocumentBytesId = filing.orderedDocuments[0].secDocumentBytesId;
    const bytesCore = readSnapshotValue(ctx.store, secDocumentBytesId, 'SecDocumentBytesCore/1');
    const uri = ctx.store.uriForObject({
      namespace: 'source', objectId: bytesCore.documentObjectId,
    });
    writeFileSync(join(ctx.root, ...uri.split('/')), Buffer.from('<xbrl'));
    assert.throws(() => readEarningsFiscalMetadataFromPinnedBytesV1({
      store: ctx.store, secDocumentBytesId,
    }), (error) => typeof error.code === 'string' && error.code !== 'ERR_ASSERTION');
  });
});

test('I2-D006 a classification whose documentPeriodEndDate was edited fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const [reportId] = report.orderedFiscalClassificationReportIds;
    const k4 = readSnapshotValue(ctx.store, reportId, 'EarningsFiscalClassificationReport/1');
    const [classificationId] = k4.orderedFiscalPeriodClassificationIds;
    const k3 = readSnapshotValue(ctx.store, classificationId,
      'EarningsFiscalPeriodClassificationCore/1');
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[classificationId, { ...k3, documentPeriodEndDate: '1999-12-31' }]]));
    assert.throws(() => verifyEarningsFiscalClassificationReport({
      store: overlay, earningsFiscalClassificationReportId: reportId, diagnostics: undefined,
    }), code('EARNINGS_FISCAL_PERIOD_END_MISMATCH'));
  });
});

test('I2-D007 a classification whose fiscalPeriodClass was edited fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const id = materialization.earningsAsOfMaterializationReport
      .orderedFiscalClassificationIds[0];
    const k3 = readSnapshotValue(ctx.store, id, 'EarningsFiscalPeriodClassificationCore/1');
    const flipped = k3.fiscalPeriodClass === 'QUARTER' ? 'FISCAL_YEAR' : 'QUARTER';
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[id, { ...k3, fiscalPeriodClass: flipped }]]));
    assert.throws(() => verifyEarningsAsOfMaterializationReport({
      store: overlay,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    }), (error) => typeof error.code === 'string' && error.code.startsWith('EARNINGS_'));
  });
});

test('I2-D008 a report whose orderedFiscalPeriodClassificationIds was reordered fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    // Pick a report that actually carries two classifications: the dual-role Q1
    // reports do, the single-duration FY report does not.
    const candidates = materialization.earningsAsOfMaterializationReport
      .orderedFiscalClassificationReportIds
      .map((id) => ({ id, value: readSnapshotValue(ctx.store, id,
        'EarningsFiscalClassificationReport/1') }));
    const chosen = candidates.find(
      (entry) => entry.value.orderedFiscalPeriodClassificationIds.length >= 2);
    assert.ok(chosen !== undefined);
    const reportId = chosen.id;
    const k4 = chosen.value;
    const overlay = overlayL4CI2Store(ctx.store, new Map([[reportId, {
      ...k4,
      orderedFiscalPeriodClassificationIds:
        [...k4.orderedFiscalPeriodClassificationIds].reverse(),
    }]]));
    assert.throws(() => verifyEarningsFiscalClassificationReport({
      store: overlay, earningsFiscalClassificationReportId: reportId, diagnostics: undefined,
    }), code('EARNINGS_FISCAL_CLASSIFICATION_ORDER_INVALID'));
  });
});

test('I2-D009 a duplicated (revision, rawPeriod, class) triple fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const [reportId] = materialization.earningsAsOfMaterializationReport
      .orderedFiscalClassificationReportIds;
    const k4 = readSnapshotValue(ctx.store, reportId, 'EarningsFiscalClassificationReport/1');
    const duplicated = [k4.orderedFiscalPeriodClassificationIds[0],
      k4.orderedFiscalPeriodClassificationIds[0]];
    const overlay = overlayL4CI2Store(ctx.store, new Map([[reportId, {
      ...k4, orderedFiscalPeriodClassificationIds: duplicated,
    }]]));
    assert.throws(() => verifyEarningsFiscalClassificationReport({
      store: overlay, earningsFiscalClassificationReportId: reportId, diagnostics: undefined,
    }), code('EARNINGS_FISCAL_CLASSIFICATION_ORDER_INVALID'));
  });
});

test('I2-D010 an orphan classification not referenced by any report fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[materialization.earningsAsOfMaterializationReportId, {
        ...report,
        orderedVisibleRevisionIdentityIds: [report.orderedVisibleRevisionIdentityIds[0]],
      }]]));
    assert.throws(() => verifyEarningsAsOfMaterializationReport({
      store: overlay,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    }), (error) => typeof error.code === 'string' && error.code.startsWith('EARNINGS_'));
  });
});
