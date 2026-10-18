/**
 * L4C-I2 EarningsFiscalClassificationPolicy/1 closed singleton, plus the
 * source-attested / policy-inferred doctrine the policy governs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEarningsFiscalClassificationPolicy,
  officialEarningsFiscalClassificationPolicyV1,
  verifyEarningsFiscalClassificationPolicy,
} from '../src/earnings/earningsFiscalClassificationPolicyL4CIIV1.mjs';
import {
  EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
  EARNINGS_FISCAL_PERIOD_CLASSES,
  EARNINGS_FISCAL_PERIOD_FOCUS_VALUES,
  EARNINGS_FORM_FOCUS_COMPATIBILITY,
  normalizeEarningsFiscalClassificationReportV1,
} from '../src/contracts/earningsContractsL4CIIV1.mjs';
import { verifyEarningsFiscalClassificationReport } from '../src/earnings/earningsFiscalClassificationReportL4CIIV1.mjs';
import { earningsAsOfMaterializationFunctionalFingerprintV1 } from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  code,
  materializeL4CI2Dataset,
  overlayL4CI2Store,
  withClassifiedSingleFiling,
  withEarningsStore,
  withL4CI2SingleFilingFixture,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

function withMutatedFiscalPolicy(store, patch, callback) {
  const built = buildEarningsFiscalClassificationPolicy({ store });
  const mutated = { ...structuredClone(built.earningsFiscalClassificationPolicy), ...patch };
  return callback(
    overlayL4CI2Store(store, new Map([[built.earningsFiscalClassificationPolicyId, mutated]])),
    built.earningsFiscalClassificationPolicyId);
}

const byClass = (classifications, fiscalPeriodClass) =>
  classifications.filter((core) => core.fiscalPeriodClass === fiscalPeriodClass);

/* --- the closed singleton ------------------------------------------------- */

test('I2-P011 builds the closed fiscal singleton', () => {
  withEarningsStore((store) => {
    const built = buildEarningsFiscalClassificationPolicy({ store });
    assert.match(built.earningsFiscalClassificationPolicyId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(built.earningsFiscalClassificationPolicy.schemaVersion,
      EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION);
    assert.equal(buildEarningsFiscalClassificationPolicy({ store })
      .earningsFiscalClassificationPolicyId, built.earningsFiscalClassificationPolicyId);
  });
});

test('I2-P012 verifies a correctly stored fiscal policy', () => {
  withEarningsStore((store) => {
    const built = buildEarningsFiscalClassificationPolicy({ store });
    const verified = verifyEarningsFiscalClassificationPolicy({
      store, earningsFiscalClassificationPolicyId: built.earningsFiscalClassificationPolicyId,
    });
    assert.deepEqual(verified.earningsFiscalClassificationPolicy,
      officialEarningsFiscalClassificationPolicyV1());
  });
});

test('I2-P013 rejects a missing fiscal policy reference', () => {
  withEarningsStore((store) => {
    assert.throws(() => verifyEarningsFiscalClassificationPolicy({
      store, earningsFiscalClassificationPolicyId: `sha256:${'1'.repeat(64)}`,
    }), code('EARNINGS_FISCAL_POLICY_MISSING'));
  });
});

test('I2-P014 pins fiscalMetadataAuthority = PINNED_SEC_DOCUMENT_BYTES_DEI_V1', () => {
  assert.equal(officialEarningsFiscalClassificationPolicyV1().fiscalMetadataAuthority,
    'PINNED_SEC_DOCUMENT_BYTES_DEI_V1');
});

test('I2-P015 pins the four fiscal period classes in order', () => {
  assert.deepEqual(officialEarningsFiscalClassificationPolicyV1().fiscalPeriodClasses,
    ['INSTANT', 'QUARTER', 'YEAR_TO_DATE', 'FISCAL_YEAR']);
  assert.deepEqual([...EARNINGS_FISCAL_PERIOD_CLASSES],
    ['INSTANT', 'QUARTER', 'YEAR_TO_DATE', 'FISCAL_YEAR']);
});

test('I2-P016 pins the five focus values in order', () => {
  assert.deepEqual(officialEarningsFiscalClassificationPolicyV1().fiscalPeriodFocusValues,
    ['Q1', 'Q2', 'Q3', 'Q4', 'FY']);
  assert.deepEqual([...EARNINGS_FISCAL_PERIOD_FOCUS_VALUES], ['Q1', 'Q2', 'Q3', 'Q4', 'FY']);
});

test('I2-P017 pins derivedPeriodPolicy = FORBIDDEN', () => {
  assert.equal(officialEarningsFiscalClassificationPolicyV1().derivedPeriodPolicy, 'FORBIDDEN');
});

test('I2-P018 pins dayTolerancePolicy = FORBIDDEN_EXACT_DATES_ONLY', () => {
  assert.equal(officialEarningsFiscalClassificationPolicyV1().dayTolerancePolicy,
    'FORBIDDEN_EXACT_DATES_ONLY');
});

test('I2-P019 pins calendarInferencePolicy = FORBIDDEN_NO_FISCAL_CALENDAR_AUTHORITY', () => {
  assert.equal(officialEarningsFiscalClassificationPolicyV1().calendarInferencePolicy,
    'FORBIDDEN_NO_FISCAL_CALENDAR_AUTHORITY');
});

test('I2-P020 pins terminalQuarterPolicy = SOURCE_CONTEXT_ONLY', () => {
  const policy = officialEarningsFiscalClassificationPolicyV1();
  assert.equal(policy.terminalQuarterPolicy, 'SOURCE_CONTEXT_ONLY');
  assert.equal(policy.terminalQuarterProvabilityPolicy, 'FAIL_CLOSED_UNPROVABLE');
});

test('I2-P021 pins q1DualRolePolicy = EMIT_QUARTER_AND_YEAR_TO_DATE', () => {
  assert.equal(officialEarningsFiscalClassificationPolicyV1().q1DualRolePolicy,
    'EMIT_QUARTER_AND_YEAR_TO_DATE');
});

test('I2-P022 pins multiDocumentPeriodEndPolicy = REQUIRE_IDENTICAL', () => {
  const policy = officialEarningsFiscalClassificationPolicyV1();
  assert.equal(policy.multiDocumentPeriodEndPolicy, 'REQUIRE_IDENTICAL');
  assert.equal(policy.comparativePeriodPolicy, 'EXCLUDED_BY_DOCUMENT_PERIOD_END_MATCH');
});

test('I2-P023 pins the six form/focus compatibility rows in order', () => {
  const rows = officialEarningsFiscalClassificationPolicyV1().orderedFormFocusCompatibility;
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.formType),
    ['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A']);
  assert.deepEqual(rows.map((row) => row.orderedAllowedFocusValues),
    EARNINGS_FORM_FOCUS_COMPATIBILITY.map((row) => [...row.orderedAllowedFocusValues]));
});

test('I2-P024 rejects an extra focus value added to the enum', () => {
  withEarningsStore((store) => {
    withMutatedFiscalPolicy(store,
      { fiscalPeriodFocusValues: ['Q1', 'Q2', 'Q3', 'Q4', 'FY', 'H1'] }, (overlay, id) => {
        assert.throws(() => verifyEarningsFiscalClassificationPolicy({
          store: overlay, earningsFiscalClassificationPolicyId: id,
        }), code('EARNINGS_FISCAL_POLICY_INVALID'));
      });
  });
});

/* --- the doctrine the policy governs -------------------------------------- */

test('I2-F324 Q1 single duration: QUARTER/Q1 is SOURCE_ATTESTED, YEAR_TO_DATE/Q1 is POLICY_INFERRED',
  () => {
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK, ({ classifications }) => {
      assert.equal(classifications.length, 2);
      const [quarter] = byClass(classifications, 'QUARTER');
      const [ytd] = byClass(classifications, 'YEAR_TO_DATE');
      assert.equal(quarter.classificationBasis, 'SOURCE_ATTESTED');
      assert.equal(quarter.classificationMethod, 'DECLARED_FOCUS');
      assert.equal(quarter.fiscalPeriodFocus, 'Q1');
      assert.equal(ytd.classificationBasis, 'POLICY_INFERRED');
      assert.equal(ytd.classificationMethod, 'Q1_DUAL_ROLE');
      assert.equal(ytd.fiscalPeriodFocus, 'Q1');
      assert.equal(quarter.financialPeriodIdentityId, ytd.financialPeriodIdentityId);
    });
  });

test('I2-F325 Q2 two durations: both roles are POLICY_INFERRED / RELATIONAL_SPAN_ORDER', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q2TenQ, ({ classifications }) => {
    assert.equal(classifications.length, 2);
    for (const core of classifications) {
      assert.equal(core.classificationBasis, 'POLICY_INFERRED');
      assert.equal(core.classificationMethod, 'RELATIONAL_SPAN_ORDER');
      assert.equal(core.fiscalPeriodFocus, 'Q2');
    }
    assert.equal(byClass(classifications, 'QUARTER').length, 1);
    assert.equal(byClass(classifications, 'YEAR_TO_DATE').length, 1);
  });
});

test('I2-F326 Q3 stub short duration: still POLICY_INFERRED, never SOURCE_ATTESTED', () => {
  withClassifiedSingleFiling({
    ...L4C_I2_FILING_DEFINITIONS.q2TenQ,
    accessionNumber: '1234567890-26-000205',
    documents: [{
      ...L4C_I2_FILING_DEFINITIONS.q2TenQ.documents[0],
      documentPeriodEndDate: '2026-09-30', documentFiscalPeriodFocus: 'Q3',
      durations: [
        { start: '2026-09-01', end: '2026-09-30', eps: '0.45', revenue: '45000000' },
        { start: '2026-01-01', end: '2026-09-30', eps: '3.90', revenue: '390000000' },
      ],
    }],
  }, ({ classifications }) => {
    assert.equal(classifications.length, 2);
    assert.equal(classifications.every((core) =>
      core.classificationBasis === 'POLICY_INFERRED'), true);
    assert.equal(classifications.some((core) =>
      core.classificationBasis === 'SOURCE_ATTESTED'), false);
  });
});

test('I2-F327 fiscal-year-change filing: relative order alone never yields SOURCE_ATTESTED', () => {
  withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyNonCalendar,
    ({ classifications, classified }) => {
      // A single attested duration is SOURCE_ATTESTED by declared focus, never by
      // its position relative to any calendar.
      assert.equal(classifications.length, 1);
      assert.equal(classifications[0].fiscalPeriodClass, 'FISCAL_YEAR');
      assert.equal(classifications[0].classificationMethod, 'DECLARED_FOCUS');
      assert.equal(classified.diagnostics.length, 0);
      assert.equal(classifications[0].documentPeriodEndDate, '2026-06-30');
    });
});

test('I2-F328 FY with a second duration: EARNINGS_FISCAL_TERMINAL_QUARTER_UNPROVABLE, no Q4 emitted',
  () => {
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations,
      ({ classifications, classified }) => {
        assert.equal(classifications.length, 1);
        assert.equal(classifications[0].fiscalPeriodClass, 'FISCAL_YEAR');
        assert.equal(classifications[0].classificationBasis, 'POLICY_INFERRED');
        assert.equal(classifications[0].classificationMethod, 'RELATIONAL_SPAN_ORDER');
        assert.equal(byClass(classifications, 'QUARTER').length, 0);
        assert.deepEqual(classified.diagnostics.map((entry) => entry.code),
          ['EARNINGS_FISCAL_TERMINAL_QUARTER_UNPROVABLE']);
      });
  });

test('I2-F329 a relational role may never carry classificationBasis=SOURCE_ATTESTED', () => {
  for (const definition of [L4C_I2_FILING_DEFINITIONS.q2TenQ,
    L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations]) {
    withClassifiedSingleFiling(definition, ({ classifications }) => {
      for (const core of classifications) {
        if (core.classificationMethod === 'RELATIONAL_SPAN_ORDER') {
          assert.equal(core.classificationBasis, 'POLICY_INFERRED');
        }
      }
    });
  }
});

test('I2-F330 FY plus an acquisition stub is indistinguishable from FY plus a real Q4: both emit no Q4',
  () => {
    const stub = withClassifiedSingleFiling({
      ...L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations,
      accessionNumber: '1234567890-26-000208',
      documents: [{
        ...L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations.documents[0],
        durations: [
          { start: '2026-01-01', end: '2026-12-31', eps: '5.30', revenue: '530000000' },
          { start: '2026-11-15', end: '2026-12-31', eps: '0.60', revenue: '60000000' },
        ],
      }],
    }, ({ classifications, classified }) => ({
      classes: classifications.map((core) => core.fiscalPeriodClass),
      diagnostics: classified.diagnostics.map((entry) => entry.code),
    }));
    const terminalQuarter = withClassifiedSingleFiling(
      L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations,
      ({ classifications, classified }) => ({
        classes: classifications.map((core) => core.fiscalPeriodClass),
        diagnostics: classified.diagnostics.map((entry) => entry.code),
      }));
    assert.deepEqual(stub.classes, ['FISCAL_YEAR']);
    assert.deepEqual(terminalQuarter.classes, ['FISCAL_YEAR']);
    assert.deepEqual(stub.diagnostics, terminalQuarter.diagnostics);
  });

test('I2-F331 orderedSourceFactTags replays source evidence while RELATIONAL_SPAN_ORDER remains exclusively in classificationMethod',
  () => {
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q2TenQ, ({ classifications }) => {
      for (const core of classifications) {
        assert.deepEqual(core.orderedSourceFactTags,
          ['DocumentPeriodEndDate', 'DocumentFiscalPeriodFocus', 'DocumentFiscalYearFocus']);
        assert.equal(core.orderedSourceFactTags.includes('RELATIONAL_SPAN_ORDER'), false);
        assert.equal(core.classificationMethod, 'RELATIONAL_SPAN_ORDER');
      }
    });
  });

test('I2-F332 the report verifier recomputes both basis counters and rejects stored inflation or swapped values',
  () => {
    withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q1EightK, (ctx) => {
      const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
      const [reportId] = materialization.earningsAsOfMaterializationReport
        .orderedFiscalClassificationReportIds;
      const verified = verifyEarningsFiscalClassificationReport({
        store: ctx.store, earningsFiscalClassificationReportId: reportId, diagnostics: undefined,
      });
      const report = verified.earningsFiscalClassificationReport;
      assert.equal(report.sourceAttestedClassificationCount, 1);
      assert.equal(report.policyInferredClassificationCount, 1);

      for (const patch of [
        { sourceAttestedClassificationCount: 2 },
        {
          sourceAttestedClassificationCount: report.policyInferredClassificationCount,
          policyInferredClassificationCount: report.sourceAttestedClassificationCount + 1,
        },
      ]) {
        const overlay = overlayL4CI2Store(ctx.store, new Map([[reportId,
          normalizeEarningsFiscalClassificationReportV1({ ...structuredClone(report), ...patch })]]));
        assert.throws(() => verifyEarningsFiscalClassificationReport({
          store: overlay, earningsFiscalClassificationReportId: reportId, diagnostics: undefined,
        }), code('EARNINGS_FISCAL_REPORT_COUNT_MISMATCH'));
      }
    });
  });

test('I2-F333 the materialization report carries both basis counters and F1 includes both counters',
  () => {
    withL4CI2ThreeFilingFixture((ctx) => {
      const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
      const report = materialization.earningsAsOfMaterializationReport;
      assert.equal(report.sourceAttestedClassificationCount
        + report.policyInferredClassificationCount, report.fiscalClassificationCount);
      const swapped = {
        ...structuredClone(report),
        sourceAttestedClassificationCount: report.policyInferredClassificationCount,
        policyInferredClassificationCount: report.sourceAttestedClassificationCount,
      };
      assert.notEqual(report.sourceAttestedClassificationCount,
        report.policyInferredClassificationCount);
      assert.notEqual(earningsAsOfMaterializationFunctionalFingerprintV1(swapped),
        report.materializationFunctionalFingerprint);
    });
  });

test('I2-F336 multi-store normalization of orderedSourceFactTags produces the identical K3 id', () => {
  const idsFromStore = () => withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q1EightK,
    ({ classified }) => [...classified.orderedFiscalPeriodClassificationIds]);
  assert.deepEqual(idsFromStore(), idsFromStore());
});

test('I2-F340 Q4 focus with two durations emits zero classifications, two exact diagnostics and status PARTIAL',
  () => {
    withClassifiedSingleFiling(L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration,
      ({ classifications, classified }) => {
        assert.equal(classifications.length, 0);
        assert.equal(classified.status, 'PARTIAL');
        assert.equal(classified.diagnostics.length, 2);
        assert.deepEqual(new Set(classified.diagnostics.map((entry) => entry.code)),
          new Set(['EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS']));
        assert.equal(new Set(classified.diagnostics.map((entry) => entry.rawPeriodIdToken)).size, 2);
      });
  });
