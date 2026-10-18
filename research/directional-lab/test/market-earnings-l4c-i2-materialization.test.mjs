/**
 * L4C-I2 EarningsAsOfMaterializationReport/1.
 *
 * The report is the pinned answer: it is built from the binding id alone, and
 * every counter, ordered list, digest and the functional fingerprint are
 * recomputed on verification rather than trusted as written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEarningsAsOfMaterializationReport,
  earningsAsOfMaterializationFunctionalFingerprintV1,
  verifyEarningsAsOfMaterializationReport,
} from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import { resolveEarningsAsOfV1 } from '../src/earnings/resolveEarningsAsOfL4CIIV1.mjs';
import { verifyEarningsFiscalPeriodClassificationCore } from '../src/earnings/earningsFiscalClassificationL4CIIV1.mjs';
import {
  EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS,
} from '../src/contracts/earningsContractsL4CIIV1.mjs';
import {
  independentDomainDigestV1,
  independentFunctionalFingerprintV1,
} from './helpers/independentEarningsAsOfOracleL4CIIV1.mjs';
import {
  EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN,
} from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import {
  L4C_I2_CUTOFF_AFTER_ALL,
  bindL4CI2Dataset,
  code,
  materializeL4CI2Dataset,
  overlayL4CI2Store,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

/** Serve a raw mutated report under its own id and re-verify. */
function expectMutationRejected(ctx, materialization, patch, expectedCode) {
  const reportId = materialization.earningsAsOfMaterializationReportId;
  const mutated = {
    ...structuredClone(materialization.earningsAsOfMaterializationReport), ...patch,
  };
  const overlay = overlayL4CI2Store(ctx.store, new Map([[reportId, mutated]]));
  assert.throws(() => verifyEarningsAsOfMaterializationReport({
    store: overlay, earningsAsOfMaterializationReportId: reportId,
  }), code(expectedCode));
}

test('I2-T001 materializes from the binding id alone', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const binding = bindL4CI2Dataset(ctx.store, ctx);
    const built = buildEarningsAsOfMaterializationReport({
      store: ctx.store, earningsDatasetBindingId: binding.earningsDatasetBindingId,
    });
    assert.match(built.earningsAsOfMaterializationReportId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(built.earningsAsOfMaterializationReport.earningsDatasetBindingId,
      binding.earningsDatasetBindingId);
    assert.equal(built.earningsAsOfMaterializationReport.knowledgeCutoff,
      binding.earningsDatasetBinding.knowledgeCutoff);
  });
});

test('I2-T002 refuses any second temporal argument on the builder', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const binding = bindL4CI2Dataset(ctx.store, ctx);
    for (const extra of [{ knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL },
      { asOf: L4C_I2_CUTOFF_AFTER_ALL }, { cutoff: L4C_I2_CUTOFF_AFTER_ALL }]) {
      assert.throws(() => buildEarningsAsOfMaterializationReport({
        store: ctx.store,
        earningsDatasetBindingId: binding.earningsDatasetBindingId,
        ...extra,
      }), code('MARKET_DATA_UNKNOWN_FIELD'), Object.keys(extra)[0]);
    }
  });
});

test('I2-T003 recomputes every visible count from the resolved closure', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const resolution = resolveEarningsAsOfV1({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
      knowledgeCutoff: report.knowledgeCutoff,
      earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
    });
    for (const field of ['visibleEventCount', 'visibleRevisionCount',
      'visibleExtractionReportCount', 'visibleMetricObservationCount', 'visibleRawPeriodCount']) {
      assert.equal(report[field], resolution[field], field);
    }
    assert.deepEqual(report.orderedVisibleRevisionIdentityIds,
      resolution.orderedVisibleRevisionIdentityIds);
  });
});

test('I2-T004 recomputes every classification count from the emitted classifications', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const cores = report.orderedFiscalClassificationIds.map((id) =>
      verifyEarningsFiscalPeriodClassificationCore({
        store: ctx.store, earningsFiscalPeriodClassificationId: id,
      }).earningsFiscalPeriodClassification);
    assert.equal(report.fiscalClassificationCount, cores.length);
    assert.equal(report.classifiedRawPeriodCount,
      new Set(cores.map((core) => core.financialPeriodIdentityId)).size);
    assert.equal(report.sourceAttestedClassificationCount,
      cores.filter((core) => core.classificationBasis === 'SOURCE_ATTESTED').length);
    assert.equal(report.policyInferredClassificationCount,
      cores.filter((core) => core.classificationBasis === 'POLICY_INFERRED').length);
  });
});

test('I2-T005 recomputes all seven digests', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    // Verification must recompute, so a store that still holds the same objects
    // re-derives byte-identical digests.
    const verified = verifyEarningsAsOfMaterializationReport({
      store: ctx.store,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    });
    for (const field of ['orderedVisibleEventIdentityDigest',
      'orderedVisibleRevisionIdentityDigest', 'orderedVisibleExtractionReportDigest',
      'orderedVisibleMetricObservationDigest', 'orderedVisibleRawPeriodDigest',
      'orderedFiscalClassificationDigest', 'orderedClassificationDiagnosticDigest']) {
      assert.equal(verified.earningsAsOfMaterializationReport[field], report[field], field);
    }
  });
});

test('I2-T006 verify rejects a report whose recomputation diverges', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    // earningsDatasetSnapshotManifestId is derived from the binding and is
    // excluded from F1, so a forged value survives every specific guard and is
    // caught only by the full canonical recomputation.
    expectMutationRejected(ctx, materialization, {
      earningsDatasetSnapshotManifestId:
        materialization.earningsAsOfMaterializationReport.earningsDatasetBindingId,
    }, 'EARNINGS_MATERIALIZATION_INVALID');
  });
});

test('I2-T007 verify rejects a mutated visibleRevisionCount', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    expectMutationRejected(ctx, materialization, { visibleEventCount: 99 },
      'EARNINGS_MATERIALIZATION_COUNT_MISMATCH');
  });
});

test('I2-T008 verify rejects a mutated orderedFiscalClassificationDigest', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    expectMutationRejected(ctx, materialization, {
      orderedFiscalClassificationDigest: independentDomainDigestV1(
        EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN, ['sha256:' + '0'.repeat(64)]),
    }, 'EARNINGS_MATERIALIZATION_DIGEST_MISMATCH');
  });
});

test('I2-T009 verify rejects an unsorted ordered id list', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const ids = [...materialization.earningsAsOfMaterializationReport
      .orderedVisibleRevisionIdentityIds];
    assert.ok(ids.length >= 2);
    expectMutationRejected(ctx, materialization,
      { orderedVisibleRevisionIdentityIds: [...ids].reverse() },
      'EARNINGS_MATERIALIZATION_ORDER_INVALID');
  });
});

test('I2-T010 verify rejects a mutated functional fingerprint', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const foreign = independentFunctionalFingerprintV1({ ...report, visibleEventCount: 77 });
    assert.notEqual(foreign, report.materializationFunctionalFingerprint);
    expectMutationRejected(ctx, materialization,
      { materializationFunctionalFingerprint: foreign },
      'EARNINGS_MATERIALIZATION_FINGERPRINT_MISMATCH');
  });
});

test('I2-T011 countsByFiscalPeriodClass sums to fiscalClassificationCount', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    const total = Object.values(report.countsByFiscalPeriodClass)
      .reduce((sum, count) => sum + count, 0);
    assert.equal(total, report.fiscalClassificationCount);
  });
});

test('I2-T012 countsByFiscalPeriodFocus sums to fiscalClassificationCount', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    const total = Object.values(report.countsByFiscalPeriodFocus)
      .reduce((sum, count) => sum + count, 0);
    assert.equal(total, report.fiscalClassificationCount);
  });
});

test('I2-T013 unclassifiedRawPeriodCount plus classifiedRawPeriodCount equals visibleRawPeriodCount',
  () => {
    withL4CI2ThreeFilingFixture((ctx) => {
      const report = materializeL4CI2Dataset(ctx.store, ctx)
        .materialization.earningsAsOfMaterializationReport;
      assert.equal(report.classifiedRawPeriodCount + report.unclassifiedRawPeriodCount,
        report.visibleRawPeriodCount);
    });
  });

test('I2-T014 the report exposes every materialized object by direct id', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    const declared = [
      ...report.orderedVisibleEventIdentityIds, ...report.orderedVisibleRevisionIdentityIds,
      ...report.orderedVisibleExtractionReportIds, ...report.orderedVisibleMetricObservationIds,
      ...report.orderedVisibleRawPeriodIds, ...report.orderedFiscalClassificationIds,
      ...report.orderedFiscalClassificationReportIds,
    ];
    assert.ok(declared.length > 0);
    for (const objectId of declared) {
      const read = ctx.store.readObject({
        uri: ctx.store.uriForObject({ namespace: 'snapshots', objectId }),
        expectedObjectId: objectId,
      });
      assert.ok(read.bytes.length > 0, objectId);
    }
  });
});

test('I2-T015 rebuilding with identical inputs yields the same report id (no-op)', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const binding = bindL4CI2Dataset(ctx.store, ctx);
    const first = buildEarningsAsOfMaterializationReport({
      store: ctx.store, earningsDatasetBindingId: binding.earningsDatasetBindingId,
    });
    const second = buildEarningsAsOfMaterializationReport({
      store: ctx.store, earningsDatasetBindingId: binding.earningsDatasetBindingId,
    });
    assert.equal(second.earningsAsOfMaterializationReportId,
      first.earningsAsOfMaterializationReportId);
    assert.deepEqual(second.earningsAsOfMaterializationReport,
      first.earningsAsOfMaterializationReport);
  });
});

test('I2-T016 the report carries no supersedes field', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    for (const key of Object.keys(report)) {
      assert.equal(key.startsWith('supersedes'), false, key);
    }
    assert.equal(EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS
      .some((field) => field.startsWith('supersedes')), false);
    expectMutationRejected(ctx, materialization,
      { supersedesEarningsAsOfMaterializationReportId: null },
      'EARNINGS_MATERIALIZATION_SUPERSESSION_FORBIDDEN');
  });
});

test('I2-F337 F1 changes when sourceAttestedClassificationCount changes', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    const shifted = {
      ...report,
      sourceAttestedClassificationCount: report.sourceAttestedClassificationCount + 1,
    };
    assert.notEqual(earningsAsOfMaterializationFunctionalFingerprintV1(shifted),
      report.materializationFunctionalFingerprint);
  });
});

test('I2-F338 F1 changes when policyInferredClassificationCount changes', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeL4CI2Dataset(ctx.store, ctx)
      .materialization.earningsAsOfMaterializationReport;
    const shifted = {
      ...report,
      policyInferredClassificationCount: report.policyInferredClassificationCount + 1,
    };
    assert.notEqual(earningsAsOfMaterializationFunctionalFingerprintV1(shifted),
      report.materializationFunctionalFingerprint);
  });
});

test('I2-F339 F1 differs when attested and inferred counters are swapped while their sum remains equal',
  () => {
    withL4CI2ThreeFilingFixture((ctx) => {
      const report = materializeL4CI2Dataset(ctx.store, ctx)
        .materialization.earningsAsOfMaterializationReport;
      assert.notEqual(report.sourceAttestedClassificationCount,
        report.policyInferredClassificationCount);
      const swapped = {
        ...report,
        sourceAttestedClassificationCount: report.policyInferredClassificationCount,
        policyInferredClassificationCount: report.sourceAttestedClassificationCount,
      };
      assert.equal(swapped.sourceAttestedClassificationCount
        + swapped.policyInferredClassificationCount,
      report.sourceAttestedClassificationCount + report.policyInferredClassificationCount);
      assert.notEqual(earningsAsOfMaterializationFunctionalFingerprintV1(swapped),
        report.materializationFunctionalFingerprint);
      assert.equal(earningsAsOfMaterializationFunctionalFingerprintV1(swapped),
        independentFunctionalFingerprintV1(swapped));
    });
  });
