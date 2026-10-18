/**
 * L4C-I2 prefix invariance.
 *
 * F1 is cutoff-free and snapshot-free: two materializations with the same
 * visible closure share it, whatever the binding, the cutoff, the store root,
 * the insertion order or the foreign objects lying around.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEarningsFiscalPeriodsForRevisionV1 } from '../src/earnings/earningsFiscalClassificationL4CIIV1.mjs';
import {
  L4C_I2_CUTOFF_AFTER_ALL,
  L4C_I2_FILING_DEFINITIONS,
  L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT,
  classifyVisibleRevision,
  materializeL4CI2Dataset,
  pinL4CI2Dataset,
  withEarningsStore,
  withL4CI2SingleFilingFixture,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const THREE = [
  L4C_I2_FILING_DEFINITIONS.q1EightK,
  L4C_I2_FILING_DEFINITIONS.q1TenQ,
  L4C_I2_FILING_DEFINITIONS.fyTenKA,
];

/** Materialize a filing list at a cutoff, in its own store. */
const materialize = (definitions, knowledgeCutoff, mutate = () => {}) =>
  withEarningsStore((store, root) => {
    mutate(store);
    const dataset = pinL4CI2Dataset(store, definitions);
    const { binding, materialization } = materializeL4CI2Dataset(store, dataset, knowledgeCutoff);
    return {
      root,
      bindingId: binding.earningsDatasetBindingId,
      reportId: materialization.earningsAsOfMaterializationReportId,
      report: materialization.earningsAsOfMaterializationReport,
    };
  });

/** Case 1: the same prefix, once alone and once followed by a future filing. */
const CASE_1_CUTOFF = L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1EightK;
const caseOneA = () => materialize(
  [L4C_I2_FILING_DEFINITIONS.q1EightK, L4C_I2_FILING_DEFINITIONS.fyTenKA], CASE_1_CUTOFF);
const caseOneAPlusFuture = () => materialize(THREE, CASE_1_CUTOFF);

test('I2-X001 case 1: A and A+future produce the identical visible id set', () => {
  const a = caseOneA();
  const b = caseOneAPlusFuture();
  for (const field of ['orderedVisibleEventIdentityIds', 'orderedVisibleRevisionIdentityIds',
    'orderedVisibleExtractionReportIds', 'orderedVisibleMetricObservationIds',
    'orderedVisibleRawPeriodIds']) {
    assert.deepEqual(b.report[field], a.report[field], field);
  }
});

test('I2-X002 case 1: A and A+future produce identical classification ids', () => {
  const a = caseOneA();
  const b = caseOneAPlusFuture();
  assert.ok(a.report.orderedFiscalClassificationIds.length > 0);
  assert.deepEqual(b.report.orderedFiscalClassificationIds,
    a.report.orderedFiscalClassificationIds);
  assert.deepEqual(b.report.orderedFiscalClassificationReportIds,
    a.report.orderedFiscalClassificationReportIds);
});

test('I2-X003 case 1: A and A+future produce the identical functional fingerprint', () => {
  assert.equal(caseOneAPlusFuture().report.materializationFunctionalFingerprint,
    caseOneA().report.materializationFunctionalFingerprint);
});

test('I2-X004 case 1: A and A+future produce different binding ids', () => {
  // The snapshot differs, so the binding - which pins the snapshot - differs.
  assert.notEqual(caseOneAPlusFuture().bindingId, caseOneA().bindingId);
});

test('I2-X005 case 1: A and A+future produce different materialization report ids', () => {
  assert.notEqual(caseOneAPlusFuture().reportId, caseOneA().reportId);
});

test('I2-X006 case 2: foreign CAS noise leaves every id unchanged', () => {
  const clean = materialize(THREE, L4C_I2_CUTOFF_AFTER_ALL);
  const noisy = materialize(THREE, L4C_I2_CUTOFF_AFTER_ALL, (store) => {
    store.putSourceBytes(Buffer.from('foreign noise 1'));
    store.putSourceBytes(Buffer.from('foreign noise 2'));
  });
  assert.equal(noisy.reportId, clean.reportId);
  assert.equal(noisy.bindingId, clean.bindingId);
  assert.equal(noisy.report.materializationFunctionalFingerprint,
    clean.report.materializationFunctionalFingerprint);
});

test('I2-X007 case 3: different insertion order leaves every id unchanged', () => {
  const forward = materialize(THREE, L4C_I2_CUTOFF_AFTER_ALL);
  const reversed = materialize([...THREE].reverse(), L4C_I2_CUTOFF_AFTER_ALL);
  assert.equal(reversed.reportId, forward.reportId);
  assert.equal(reversed.bindingId, forward.bindingId);
  assert.deepEqual(reversed.report, forward.report);
});

test('I2-X008 case 4: different store paths leave every id unchanged', () => {
  const first = materialize(THREE, L4C_I2_CUTOFF_AFTER_ALL);
  const second = materialize(THREE, L4C_I2_CUTOFF_AFTER_ALL);
  assert.notEqual(second.root, first.root);
  assert.equal(second.reportId, first.reportId);
  assert.equal(second.report.materializationFunctionalFingerprint,
    first.report.materializationFunctionalFingerprint);
});

test('I2-X009 case 5: cutoff T then T+1 with no newly visible revision keeps the fingerprint equal',
  () => {
    withL4CI2ThreeFilingFixture((ctx) => {
      const atT = materializeL4CI2Dataset(ctx.store, ctx, CASE_1_CUTOFF)
        .materialization.earningsAsOfMaterializationReport;
      const atTPlusOne = materializeL4CI2Dataset(ctx.store, ctx, '2026-04-23T20:05:30.001Z')
        .materialization.earningsAsOfMaterializationReport;
      assert.equal(atTPlusOne.visibleRevisionCount, atT.visibleRevisionCount);
      assert.equal(atTPlusOne.materializationFunctionalFingerprint,
        atT.materializationFunctionalFingerprint);
    });
  });

test('I2-X010 case 5: cutoff T then T+1 always produces different binding ids', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const atT = materializeL4CI2Dataset(ctx.store, ctx, CASE_1_CUTOFF);
    const atTPlusOne = materializeL4CI2Dataset(ctx.store, ctx, '2026-04-23T20:05:30.001Z');
    assert.notEqual(atTPlusOne.binding.earningsDatasetBindingId,
      atT.binding.earningsDatasetBindingId);
  });
});

test('I2-X011 case 5: a newly visible revision changes the fingerprint', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const before = materializeL4CI2Dataset(ctx.store, ctx, CASE_1_CUTOFF)
      .materialization.earningsAsOfMaterializationReport;
    const after = materializeL4CI2Dataset(ctx.store, ctx, L4C_I2_CUTOFF_AFTER_ALL)
      .materialization.earningsAsOfMaterializationReport;
    assert.equal(after.visibleRevisionCount, before.visibleRevisionCount + 1);
    assert.notEqual(after.materializationFunctionalFingerprint,
      before.materializationFunctionalFingerprint);
  });
});

test('I2-X012 case 5: classifications visible at T keep their ids at T+1', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const before = materializeL4CI2Dataset(ctx.store, ctx, CASE_1_CUTOFF)
      .materialization.earningsAsOfMaterializationReport;
    const after = materializeL4CI2Dataset(ctx.store, ctx, L4C_I2_CUTOFF_AFTER_ALL)
      .materialization.earningsAsOfMaterializationReport;
    assert.ok(before.orderedFiscalClassificationIds.length > 0);
    for (const id of before.orderedFiscalClassificationIds) {
      assert.equal(after.orderedFiscalClassificationIds.includes(id), true, id);
    }
  });
});

test('I2-X013 case 6: two snapshots with the same visible closure share the fingerprint', () => {
  // Snapshot A holds three filings and hides the last by cutoff; snapshot B
  // holds only the first two. The visible closure is the same set of objects.
  const fromThree = materialize(THREE, CASE_1_CUTOFF);
  const fromTwo = materialize(
    [L4C_I2_FILING_DEFINITIONS.q1EightK, L4C_I2_FILING_DEFINITIONS.fyTenKA],
    L4C_I2_CUTOFF_AFTER_ALL);
  assert.deepEqual(fromTwo.report.orderedVisibleRevisionIdentityIds,
    fromThree.report.orderedVisibleRevisionIdentityIds);
  assert.equal(fromTwo.report.materializationFunctionalFingerprint,
    fromThree.report.materializationFunctionalFingerprint);
});

test('I2-X014 case 6: two snapshots with the same visible closure have different binding ids', () => {
  const fromThree = materialize(THREE, CASE_1_CUTOFF);
  const fromTwo = materialize(
    [L4C_I2_FILING_DEFINITIONS.q1EightK, L4C_I2_FILING_DEFINITIONS.fyTenKA],
    L4C_I2_CUTOFF_AFTER_ALL);
  assert.notEqual(fromTwo.bindingId, fromThree.bindingId);
  assert.notEqual(fromTwo.reportId, fromThree.reportId);
});

test('I2-F341 Q4 two-duration insertion reversal preserves zero classifications, diagnostics, ids and F1',
  () => {
    // Insertion order here is the order the two eligible raw periods are handed
    // to the classifier. The pinned bytes are identical in both runs, so any
    // difference would come from the classifier honouring insertion order -
    // which the closed policy forbids.
    withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration, (ctx) => {
      const { entry } = classifyVisibleRevision(ctx.store, ctx);
      assert.equal(entry.orderedRawPeriodIds.length, 2);
      const classifyWith = (orderedRawPeriodIds) =>
        classifyEarningsFiscalPeriodsForRevisionV1({
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
      assert.equal(forward.status, 'PARTIAL');
      assert.equal(reversed.status, 'PARTIAL');
      assert.equal(reversed.earningsFiscalClassificationReportId,
        forward.earningsFiscalClassificationReportId);
      assert.equal(
        reversed.earningsFiscalClassificationReport.orderedDiagnosticDigest,
        forward.earningsFiscalClassificationReport.orderedDiagnosticDigest);
      assert.deepEqual(new Set(reversed.diagnostics.map((entryValue) => entryValue.rawPeriodIdToken)),
        new Set(forward.diagnostics.map((entryValue) => entryValue.rawPeriodIdToken)));
    });
  });
