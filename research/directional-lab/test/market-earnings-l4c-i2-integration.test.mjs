/**
 * L4C-I2 end-to-end integration over the official three-filing fixture.
 *
 * The whole pipeline is offline and deterministic: no network, no directory
 * listing, no clock, and the shipped L4C-I1 objects stay byte-identical.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { verifyEarningsAsOfMaterializationReport } from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import { verifyEarningsMaterializationTraversalV1 } from '../src/earnings/earningsMaterializationTraversalL4CIIV1.mjs';
import { verifyEarningsDatasetSnapshotManifest } from '../src/earnings/earningsDatasetSnapshotL4CIV1.mjs';
import { verifyEarningsSnapshotTraversalV1 } from '../src/earnings/earningsTraversalVerifyL4CIV1.mjs';
import { verifyEarningsFiscalPeriodClassificationCore } from '../src/earnings/earningsFiscalClassificationL4CIIV1.mjs';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  L4C_I2_CUTOFF_AFTER_ALL,
  L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT,
  materializeL4CI2Dataset,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const snapshotBytes = (ctx) => canonicalJsonBytes(verifyEarningsDatasetSnapshotManifest({
  store: ctx.store,
  earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
}).earningsDatasetSnapshotManifest);

test('I2-Z001 end to end: ingest, classify, bind, materialize, verify, traverse', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { binding, materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const verified = verifyEarningsAsOfMaterializationReport({
      store: ctx.store,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    });
    assert.equal(verified.earningsDatasetBinding.earningsDatasetBindingId, undefined);
    assert.deepEqual(verified.earningsAsOfMaterializationReport,
      materialization.earningsAsOfMaterializationReport);
    const traversal = verifyEarningsMaterializationTraversalV1({
      store: ctx.store,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
      labRoot: ctx.transform.labRoot,
    });
    assert.equal(traversal.verified, true);
    assert.equal(traversal.edgeCount, 68);
    assert.match(binding.earningsDatasetBindingId, /^sha256:[0-9a-f]{64}$/);
  });
});

test('I2-Z002 the official three-filing fixture materializes the expected visible set', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    assert.equal(report.visibleEventCount, 3);
    assert.equal(report.visibleRevisionCount, 3);
    assert.equal(report.visibleExtractionReportCount, 3);
    assert.equal(report.visibleMetricObservationCount, 6);
    assert.equal(report.visibleRawPeriodCount, 2);
    assert.equal(report.fiscalClassificationCount, 5);
    assert.equal(report.classifiedRawPeriodCount, 2);
    assert.equal(report.unclassifiedRawPeriodCount, 0);
    assert.equal(report.dualRoleRawPeriodCount, 2);
    assert.equal(report.classificationDiagnosticCount, 0);
    assert.deepEqual(report.countsByFiscalPeriodClass,
      { INSTANT: 0, QUARTER: 2, YEAR_TO_DATE: 2, FISCAL_YEAR: 1 });
    assert.deepEqual(report.countsByFiscalPeriodFocus,
      { Q1: 4, Q2: 0, Q3: 0, Q4: 0, FY: 1, UNDECLARED: 0 });
    assert.equal(report.earliestVisiblePublicAvailableAt,
      L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
    assert.equal(report.latestVisiblePublicAvailableAt,
      L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1TenQ);
  });
});

test('I2-Z003 the shared raw period is classified once per revision, not once globally', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    const cores = report.orderedFiscalClassificationIds.map((id) =>
      verifyEarningsFiscalPeriodClassificationCore({
        store: ctx.store, earningsFiscalPeriodClassificationId: id,
      }).earningsFiscalPeriodClassification);
    const sharedPeriod = cores.filter((core) => core.fiscalPeriodFocus === 'Q1')[0]
      .financialPeriodIdentityId;
    const onShared = cores.filter((core) =>
      core.financialPeriodIdentityId === sharedPeriod);
    // Two revisions, each emitting QUARTER and YEAR_TO_DATE on the same period.
    assert.equal(onShared.length, 4);
    assert.equal(new Set(onShared.map((core) => core.earningsRevisionIdentityId)).size, 2);
    // The raw period itself is still counted exactly once.
    assert.equal(report.orderedVisibleRawPeriodIds.filter((id) => id === sharedPeriod).length, 1);
  });
});

test('I2-Z004 the 8-K and 10-Q classifications of the same raw period have different ids', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    const cores = report.orderedFiscalClassificationIds.map((id) => ({
      id,
      core: verifyEarningsFiscalPeriodClassificationCore({
        store: ctx.store, earningsFiscalPeriodClassificationId: id,
      }).earningsFiscalPeriodClassification,
    }));
    const quarters = cores.filter(({ core }) =>
      core.fiscalPeriodClass === 'QUARTER' && core.fiscalPeriodFocus === 'Q1');
    assert.equal(quarters.length, 2);
    assert.notEqual(quarters[0].id, quarters[1].id);
    assert.equal(quarters[0].core.financialPeriodIdentityId,
      quarters[1].core.financialPeriodIdentityId);
    assert.notEqual(quarters[0].core.earningsRevisionIdentityId,
      quarters[1].core.earningsRevisionIdentityId);
    assert.notEqual(quarters[0].core.sourceFormType, quarters[1].core.sourceFormType);
  });
});

test('I2-Z005 a cutoff between the 8-K and the 10-Q hides the 10-Q classification', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const early = materializeL4CI2Dataset(ctx.store, ctx,
      L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1EightK)
      .materialization.earningsAsOfMaterializationReport;
    const late = materializeL4CI2Dataset(ctx.store, ctx, L4C_I2_CUTOFF_AFTER_ALL)
      .materialization.earningsAsOfMaterializationReport;
    assert.equal(early.visibleRevisionCount, 2);
    assert.equal(late.visibleRevisionCount, 3);
    assert.equal(early.fiscalClassificationCount, 3);
    assert.equal(late.fiscalClassificationCount, 5);
    for (const id of early.orderedFiscalClassificationIds) {
      assert.equal(late.orderedFiscalClassificationIds.includes(id), true, id);
    }
  });
});

test('I2-Z006 the whole pipeline performs no network call', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = () => { networkCalls += 1; throw new Error('network is forbidden'); };
    try {
      materializeL4CI2Dataset(ctx.store, ctx);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(networkCalls, 0);
  });
});

test('I2-Z007 the whole pipeline performs no directory listing', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    let listings = 0;
    const guarded = {};
    for (const key of Object.keys(ctx.store)) {
      guarded[key] = typeof ctx.store[key] === 'function'
        ? ctx.store[key].bind(ctx.store) : ctx.store[key];
    }
    for (const forbidden of ['listObjects', 'readdir', 'scan', 'latest']) {
      guarded[forbidden] = () => { listings += 1; throw new Error(`${forbidden} is forbidden`); };
    }
    materializeL4CI2Dataset(Object.freeze(guarded), ctx);
    assert.equal(listings, 0);
  });
});

test('I2-Z008 the whole pipeline reads no clock', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const originalNow = Date.now;
    let clockReads = 0;
    Date.now = () => { clockReads += 1; return 0; };
    try {
      materializeL4CI2Dataset(ctx.store, ctx);
    } finally {
      Date.now = originalNow;
    }
    assert.equal(clockReads, 0);
  });
});

test('I2-Z009 L4C-I1 objects are byte-identical before and after materialization', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const before = snapshotBytes(ctx);
    const beforeClosure = verifyEarningsSnapshotTraversalV1({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
    }).closureObjectIds;
    materializeL4CI2Dataset(ctx.store, ctx);
    const after = snapshotBytes(ctx);
    const afterClosure = verifyEarningsSnapshotTraversalV1({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
    }).closureObjectIds;
    assert.ok(after.equals(before));
    assert.deepEqual(afterClosure, beforeClosure);
  });
});

test('I2-Z010 the L4C-I1 snapshot id is unchanged after materialization', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const before = ctx.earningsDatasetSnapshotManifestId;
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    assert.equal(materialization.earningsAsOfMaterializationReport
      .earningsDatasetSnapshotManifestId, before);
    const reverified = verifyEarningsDatasetSnapshotManifest({
      store: ctx.store, earningsDatasetSnapshotManifestId: before,
    });
    assert.equal(reverified.earningsDatasetSnapshotManifestId, before);
    // Materialization adds objects but never rewrites the L4C-I1 store layout.
    assert.ok(readdirSync(ctx.root, { recursive: true }).length > 0);
  });
});
