/**
 * L4C-I2 EMPTY materialization.
 *
 * Two distinct causes - an empty pinned snapshot and a cutoff before the first
 * filing - both materialize without raising. sourceSnapshotEmpty distinguishes
 * them; F1 does not, because the visible closure is the same in both cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EARNINGS_AS_OF_VISIBLE_EVENT_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_EXTRACTION_REPORT_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_OBSERVATION_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_RAW_PERIOD_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_REVISION_DIGEST_DOMAIN,
  EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN,
} from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import {
  independentDiagnosticDigestV1,
  independentDomainDigestV1,
  independentFunctionalFingerprintV1,
} from './helpers/independentEarningsAsOfOracleL4CIIV1.mjs';
import {
  L4C_I2_CUTOFF_AFTER_ALL,
  L4C_I2_CUTOFF_BEFORE_ALL,
  materializeL4CI2Dataset,
  withL4CI2EmptyFixture,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

/** Materialize the empty snapshot; its cutoff is irrelevant. */
const emptySnapshotReport = (callback) => withL4CI2EmptyFixture((ctx) =>
  callback(materializeL4CI2Dataset(ctx.store, ctx, L4C_I2_CUTOFF_AFTER_ALL)
    .materialization.earningsAsOfMaterializationReport, ctx));

/** Materialize the populated snapshot before its first filing. */
const earlyCutoffReport = (callback) => withL4CI2ThreeFilingFixture((ctx) =>
  callback(materializeL4CI2Dataset(ctx.store, ctx, L4C_I2_CUTOFF_BEFORE_ALL)
    .materialization.earningsAsOfMaterializationReport, ctx));

const ORDERED_LIST_FIELDS = [
  'orderedVisibleEventIdentityIds', 'orderedVisibleRevisionIdentityIds',
  'orderedVisibleExtractionReportIds', 'orderedVisibleMetricObservationIds',
  'orderedVisibleRawPeriodIds', 'orderedFiscalClassificationIds',
  'orderedFiscalClassificationReportIds',
];

const COUNT_FIELDS = [
  'visibleEventCount', 'visibleRevisionCount', 'visibleExtractionReportCount',
  'visibleMetricObservationCount', 'visibleRawPeriodCount', 'fiscalClassificationCount',
  'classifiedRawPeriodCount', 'unclassifiedRawPeriodCount', 'dualRoleRawPeriodCount',
  'classificationDiagnosticCount', 'sourceAttestedClassificationCount',
  'policyInferredClassificationCount',
];

test('I2-E001 an empty source snapshot materializes an EMPTY report without raising', () => {
  emptySnapshotReport((report) => {
    assert.equal(report.emptyMaterialization, true);
    assert.equal(report.sourceSnapshotEmpty, true);
    assert.equal(report.schemaVersion, 'EarningsAsOfMaterializationReport/1');
  });
});

test('I2-E002 a cutoff before the first filing materializes an EMPTY report', () => {
  earlyCutoffReport((report) => {
    assert.equal(report.emptyMaterialization, true);
    assert.equal(report.visibleRevisionCount, 0);
  });
});

test('I2-E003 an entirely future snapshot materializes an EMPTY report', () => {
  // A snapshot whose every filing is published after the cutoff is exactly the
  // early-cutoff case seen from the snapshot's side.
  earlyCutoffReport((report) => {
    assert.equal(report.emptyMaterialization, true);
    assert.equal(report.sourceSnapshotEmpty, false);
    assert.deepEqual(report.orderedVisibleRevisionIdentityIds, []);
  });
});

test('I2-E004 emptyMaterialization is true and sourceSnapshotEmpty distinguishes the two causes',
  () => {
    const fromEmptySnapshot = emptySnapshotReport((report) => report);
    const fromEarlyCutoff = earlyCutoffReport((report) => report);
    assert.equal(fromEmptySnapshot.emptyMaterialization, true);
    assert.equal(fromEarlyCutoff.emptyMaterialization, true);
    assert.equal(fromEmptySnapshot.sourceSnapshotEmpty, true);
    assert.equal(fromEarlyCutoff.sourceSnapshotEmpty, false);
  });

test('I2-E005 every ordered id list is empty', () => {
  for (const load of [emptySnapshotReport, earlyCutoffReport]) {
    load((report) => {
      for (const field of ORDERED_LIST_FIELDS) assert.deepEqual(report[field], [], field);
    });
  }
});

test('I2-E006 every count is zero', () => {
  for (const load of [emptySnapshotReport, earlyCutoffReport]) {
    load((report) => {
      for (const field of COUNT_FIELDS) assert.equal(report[field], 0, field);
      for (const bucket of Object.values(report.countsByFiscalPeriodClass)) {
        assert.equal(bucket, 0);
      }
      for (const bucket of Object.values(report.countsByFiscalPeriodFocus)) {
        assert.equal(bucket, 0);
      }
    });
  }
});

test('I2-E007 both temporal bounds are null', () => {
  for (const load of [emptySnapshotReport, earlyCutoffReport]) {
    load((report) => {
      assert.equal(report.earliestVisiblePublicAvailableAt, null);
      assert.equal(report.latestVisiblePublicAvailableAt, null);
    });
  }
});

test('I2-E008 the seven digests equal the canonical empty-domain digests', () => {
  const expected = {
    orderedVisibleEventIdentityDigest:
      independentDomainDigestV1(EARNINGS_AS_OF_VISIBLE_EVENT_DIGEST_DOMAIN, []),
    orderedVisibleRevisionIdentityDigest:
      independentDomainDigestV1(EARNINGS_AS_OF_VISIBLE_REVISION_DIGEST_DOMAIN, []),
    orderedVisibleExtractionReportDigest:
      independentDomainDigestV1(EARNINGS_AS_OF_VISIBLE_EXTRACTION_REPORT_DIGEST_DOMAIN, []),
    orderedVisibleMetricObservationDigest:
      independentDomainDigestV1(EARNINGS_AS_OF_VISIBLE_OBSERVATION_DIGEST_DOMAIN, []),
    orderedVisibleRawPeriodDigest:
      independentDomainDigestV1(EARNINGS_AS_OF_VISIBLE_RAW_PERIOD_DIGEST_DOMAIN, []),
    orderedFiscalClassificationDigest:
      independentDomainDigestV1(EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN, []),
    orderedClassificationDiagnosticDigest: independentDiagnosticDigestV1([]),
  };
  for (const load of [emptySnapshotReport, earlyCutoffReport]) {
    load((report) => {
      for (const [field, digest] of Object.entries(expected)) {
        assert.equal(report[field], digest, field);
      }
    });
  }
});

test('I2-E009 the functional fingerprint of an empty materialization is stable', () => {
  const first = emptySnapshotReport((report) => report.materializationFunctionalFingerprint);
  const second = emptySnapshotReport((report) => report.materializationFunctionalFingerprint);
  assert.equal(second, first);
  emptySnapshotReport((report) => {
    assert.equal(report.materializationFunctionalFingerprint,
      independentFunctionalFingerprintV1(report));
  });
});

test('I2-E010 two different empty causes differ by sourceSnapshotEmpty in F1', () => {
  const fromEmptySnapshot = emptySnapshotReport((report) => report);
  const fromEarlyCutoff = earlyCutoffReport((report) => report);
  // F1 authority includes sourceSnapshotEmpty among the 42 functional fields
  // (l4c_i2_fingerprint_fields.tsv row 14 / I2-T014). The two empty causes
  // therefore MUST NOT share a fingerprint. The superseded matrix wording
  // "share the same functional fingerprint" loses to F1.
  assert.notEqual(fromEmptySnapshot.materializationFunctionalFingerprint,
    fromEarlyCutoff.materializationFunctionalFingerprint);
  assert.equal(fromEmptySnapshot.sourceSnapshotEmpty, true);
  assert.equal(fromEarlyCutoff.sourceSnapshotEmpty, false);
  assert.equal(
    independentFunctionalFingerprintV1({ ...fromEarlyCutoff, sourceSnapshotEmpty: true }),
    fromEmptySnapshot.materializationFunctionalFingerprint);
});
