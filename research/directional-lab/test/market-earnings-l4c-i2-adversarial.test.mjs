/**
 * L4C-I2 adversarial matrix: the thirty declared threats plus six static guards.
 *
 * Each threat is exercised against the real pipeline, and each static guard is
 * a source scan over the ten declared L4C-I2 production modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveEarningsAsOfV1 } from '../src/earnings/resolveEarningsAsOfL4CIIV1.mjs';
import {
  buildEarningsDatasetBinding,
  verifyEarningsDatasetBinding,
} from '../src/earnings/earningsDatasetBindingL4CIIV1.mjs';
import { verifyEarningsAsOfMaterializationReport } from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import { verifyEarningsSnapshotTraversalV1 } from '../src/earnings/earningsTraversalVerifyL4CIV1.mjs';
import { pinEarningsTransformImplementationManifestV2 } from './earningsIngestionL4CISyntheticFixture.mjs';
import {
  L4C_I2_CUTOFF_AFTER_ALL,
  L4C_I2_CUTOFF_BEFORE_ALL,
  L4C_I2_FILING_DEFINITIONS,
  L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT,
  L4C_I2_TRANSFORM_LOGICAL_PATHS,
  bindL4CI2Dataset,
  code,
  l4cI2LabRoot,
  materializeL4CI2Dataset,
  overlayL4CI2Store,
  pinL4CI2Dataset,
  withEarningsStore,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

/**
 * Comments name the forbidden constructs on purpose ("no wall clock, no mtime"),
 * so a static guard must scan executable code only.
 */
function strippedCode(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** The ten declared L4C-I2 production modules, read once for the static scans. */
const I2_MODULE_SOURCES = L4C_I2_TRANSFORM_LOGICAL_PATHS.map((logicalPath) => {
  const source = readFileSync(fileURLToPath(new URL(`../${logicalPath}`, import.meta.url)), 'utf8');
  return { logicalPath, source, code: strippedCode(source) };
});

/** The cutoff that hides the last of the three fixture filings. */
const HIDING_CUTOFF = L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1EightK;

const materializeAt = (ctx, knowledgeCutoff) =>
  materializeL4CI2Dataset(ctx.store, ctx, knowledgeCutoff)
    .materialization.earningsAsOfMaterializationReport;

/* --- T01..T10: nothing after the cutoff may enter the answer -------------- */

test('I2-A001 threat T01: future event present in the pinned snapshot', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeAt(ctx, HIDING_CUTOFF);
    const all = materializeAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.equal(report.visibleEventCount, 2);
    assert.equal(all.visibleEventCount, 3);
    for (const id of report.orderedVisibleEventIdentityIds) {
      assert.equal(all.orderedVisibleEventIdentityIds.includes(id), true);
    }
  });
});

test('I2-A002 threat T02: future metric observation', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const hidden = materializeAt(ctx, HIDING_CUTOFF);
    const all = materializeAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.ok(hidden.visibleMetricObservationCount < all.visibleMetricObservationCount);
    const visible = new Set(hidden.orderedVisibleMetricObservationIds);
    assert.equal(visible.size, hidden.visibleMetricObservationCount);
  });
});

test('I2-A003 threat T03: future extraction report', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const hidden = materializeAt(ctx, HIDING_CUTOFF);
    assert.equal(hidden.visibleExtractionReportCount, 2);
    assert.equal(hidden.orderedVisibleExtractionReportIds.length, 2);
  });
});

test('I2-A004 threat T04: future raw period', () => {
  withEarningsStore((store) => {
    // The Q4 filing is published in 2027; a 2026 cutoff must not surface its
    // raw periods even though they sit in the same pinned snapshot.
    const dataset = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.q1EightK, L4C_I2_FILING_DEFINITIONS.q4EightK,
    ]);
    const early = resolveEarningsAsOfV1({
      store,
      earningsDatasetSnapshotManifestId: dataset.earningsDatasetSnapshotManifestId,
      knowledgeCutoff: '2026-12-31T00:00:00.000Z',
      earningsAsOfResolutionPolicyId: dataset.earningsAsOfResolutionPolicyId,
    });
    const late = resolveEarningsAsOfV1({
      store,
      earningsDatasetSnapshotManifestId: dataset.earningsDatasetSnapshotManifestId,
      knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
      earningsAsOfResolutionPolicyId: dataset.earningsAsOfResolutionPolicyId,
    });
    assert.equal(early.visibleRawPeriodCount, 1);
    assert.equal(late.visibleRawPeriodCount, 2);
  });
});

test('I2-A005 threat T05: classification derived from a future filing', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const hidden = materializeAt(ctx, HIDING_CUTOFF);
    const all = materializeAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.ok(hidden.fiscalClassificationCount < all.fiscalClassificationCount);
    const hiddenSet = new Set(hidden.orderedFiscalClassificationIds);
    const extra = all.orderedFiscalClassificationIds.filter((id) => !hiddenSet.has(id));
    assert.ok(extra.length > 0);
  });
});

test('I2-A006 threat T06: fiscal year-end learned from a later filing', () => {
  withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.q1EightK, L4C_I2_FILING_DEFINITIONS.fyNonCalendar,
    ]);
    const early = materializeL4CI2Dataset(store, dataset, HIDING_CUTOFF)
      .materialization.earningsAsOfMaterializationReport;
    // The later filing declares a June fiscal year end; the earlier answer must
    // classify Q1 exactly as it did before that filing existed.
    assert.equal(early.countsByFiscalPeriodFocus.FY, 0);
    assert.equal(early.countsByFiscalPeriodFocus.Q1, 2);
  });
});

test('I2-A007 threat T07: source snapshot enriched after the cutoff', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const before = materializeAt(ctx, HIDING_CUTOFF).materializationFunctionalFingerprint;
    ctx.store.putSourceBytes(Buffer.from('post-cutoff enrichment'));
    assert.equal(materializeAt(ctx, HIDING_CUTOFF).materializationFunctionalFingerprint, before);
  });
});

test('I2-A008 threat T08: future policy substituted', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const binding = bindL4CI2Dataset(ctx.store, ctx);
    const overlay = overlayL4CI2Store(ctx.store, new Map([[
      binding.earningsDatasetBinding.earningsAsOfResolutionPolicyId,
      { schemaVersion: 'EarningsAsOfResolutionPolicy/1', futurePolicy: true },
    ]]));
    assert.throws(() => verifyEarningsDatasetBinding({
      store: overlay, earningsDatasetBindingId: binding.earningsDatasetBindingId,
    }), (error) => error.code.startsWith('EARNINGS_AS_OF_POLICY'));
  });
});

test('I2-A009 threat T09: future implementation manifest', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const foreign = pinEarningsTransformImplementationManifestV2(ctx.store);
    assert.throws(() => buildEarningsDatasetBinding({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
      earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
      earningsFiscalClassificationPolicyId: ctx.earningsFiscalClassificationPolicyId,
      transformImplementationManifestId: foreign.transformImplementationManifestId,
      knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
    }), code('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH'));
  });
});

test('I2-A010 threat T10: calendar registry consulted', () => {
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    assert.equal(/ReleaseCalendar|calendarRegistry|macroReleaseCalendar/u.test(code), false,
      logicalPath);
  }
});

/* --- T11..T18: no ambient authority -------------------------------------- */

test('I2-A011 threat T11: latest snapshot selection', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => resolveEarningsAsOfV1({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: 'latest',
      knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
      earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
    }), code('EARNINGS_POLICY_LATEST_FORBIDDEN'));
  });
});

test('I2-A012 threat T12: latest policy selection', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => resolveEarningsAsOfV1({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
      knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
      earningsAsOfResolutionPolicyId: 'LATEST',
    }), code('EARNINGS_POLICY_LATEST_FORBIDDEN'));
  });
});

test('I2-A013 threat T13: global CAS scan', () => {
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    assert.equal(/readdirSync|readdir\(|globSync|listObjects/u.test(code), false, logicalPath);
  }
});

test('I2-A014 threat T14: Date.now()', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => { calls += 1; return 0; };
    try {
      materializeL4CI2Dataset(ctx.store, ctx);
    } finally {
      Date.now = originalNow;
    }
    assert.equal(calls, 0);
  });
});

test('I2-A015 threat T15: machine timezone influences a civil date', () => {
  const originalTz = process.env.TZ;
  const project = () => withL4CI2ThreeFilingFixture((ctx) =>
    materializeAt(ctx, L4C_I2_CUTOFF_AFTER_ALL).materializationFunctionalFingerprint);
  try {
    process.env.TZ = 'UTC';
    const utc = project();
    process.env.TZ = 'Pacific/Kiritimati';
    assert.equal(project(), utc);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('I2-A016 threat T16: file mtime used as a timestamp', () => {
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    assert.equal(/mtime|statSync|birthtime/u.test(code), false, logicalPath);
  }
});

test('I2-A017 threat T17: insertion order affects output', () => {
  const project = (definitions) => withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, definitions);
    return materializeL4CI2Dataset(store, dataset).materialization
      .earningsAsOfMaterializationReportId;
  });
  const order = [L4C_I2_FILING_DEFINITIONS.q1EightK, L4C_I2_FILING_DEFINITIONS.q1TenQ,
    L4C_I2_FILING_DEFINITIONS.fyTenKA];
  assert.equal(project([...order].reverse()), project(order));
});

test('I2-A018 threat T18: temporary store path affects output', () => {
  const project = () => withL4CI2ThreeFilingFixture((ctx) => ({
    root: ctx.root,
    id: materializeL4CI2Dataset(ctx.store, ctx).materialization
      .earningsAsOfMaterializationReportId,
  }));
  const first = project();
  const second = project();
  assert.notEqual(second.root, first.root);
  assert.equal(second.id, first.id);
});

/* --- T19..T25: fiscal and provenance forgeries --------------------------- */

test('I2-A019 threat T19: comparative used as the current period', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    // Every classified raw period ends on its filing's DocumentPeriodEndDate.
    assert.equal(report.classifiedRawPeriodCount, 2);
    assert.equal(report.unclassifiedRawPeriodCount, 0);
  });
});

test('I2-A020 threat T20: Q4 derived as FY minus nine months', () => {
  withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, [L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations]);
    const report = materializeL4CI2Dataset(store, dataset)
      .materialization.earningsAsOfMaterializationReport;
    assert.equal(report.countsByFiscalPeriodClass.QUARTER, 0);
    assert.equal(report.countsByFiscalPeriodFocus.Q4, 0);
    assert.equal(report.classificationDiagnosticCount, 1);
  });
});

test('I2-A021 threat T21: 53-week knowledge imported from the future', () => {
  withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, [L4C_I2_FILING_DEFINITIONS.fyFiftyThreeWeek]);
    const report = materializeL4CI2Dataset(store, dataset)
      .materialization.earningsAsOfMaterializationReport;
    assert.equal(report.countsByFiscalPeriodClass.FISCAL_YEAR, 1);
    // The source dates are kept verbatim and no week count is ever stored: the
    // classification names no week, and the raw period keeps its exact bounds.
    const [classificationId] = report.orderedFiscalClassificationIds;
    const core = store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'snapshots', objectId: classificationId }),
      expectedObjectId: classificationId,
      schemaVersion: 'EarningsFiscalPeriodClassificationCore/1',
    }).value;
    assert.equal(core.documentPeriodEndDate, '2027-01-02');
    for (const key of Object.keys(core)) {
      assert.equal(/week|Week|dayCount|spanDays/u.test(key), false, key);
    }
  });
});

test('I2-A022 threat T22: retroactive fiscal year change', () => {
  withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.fyNonCalendar, L4C_I2_FILING_DEFINITIONS.fyTenKTwoDurations,
    ]);
    const early = materializeL4CI2Dataset(store, dataset, '2026-09-30T00:00:00.000Z')
      .materialization.earningsAsOfMaterializationReport;
    const late = materializeL4CI2Dataset(store, dataset, L4C_I2_CUTOFF_AFTER_ALL)
      .materialization.earningsAsOfMaterializationReport;
    for (const id of early.orderedFiscalClassificationIds) {
      assert.equal(late.orderedFiscalClassificationIds.includes(id), true, id);
    }
  });
});

test('I2-A023 threat T23: future /A accession', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    // The 10-K/A is the earliest filing here, so a cutoff before it hides it
    // exactly like any other event: amendments get no privileged visibility.
    const before = materializeAt(ctx, L4C_I2_CUTOFF_BEFORE_ALL);
    assert.equal(before.visibleRevisionCount, 0);
    const after = materializeAt(ctx, L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
    assert.equal(after.visibleRevisionCount, 1);
  });
});

test('I2-A024 threat T24: unpinned source bytes', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const closure = verifyEarningsSnapshotTraversalV1({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
    }).closureObjectIds;
    // Every classification names a document bytes id that is inside the pinned
    // L4C-I1 closure: no unpinned byte stream can be read.
    const report = materialization.earningsAsOfMaterializationReport;
    assert.ok(report.orderedFiscalClassificationIds.length > 0);
    for (const objectId of report.orderedFiscalClassificationIds) {
      const core = ctx.store.readCanonicalObject({
        uri: ctx.store.uriForObject({ namespace: 'snapshots', objectId }),
        expectedObjectId: objectId,
        schemaVersion: 'EarningsFiscalPeriodClassificationCore/1',
      }).value;
      assert.equal(closure.includes(core.fiscalMetadataSourceDocumentBytesId), true);
    }
  });
});

test('I2-A025 threat T25: foreign dataset identity', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[materialization.earningsAsOfMaterializationReportId, {
        ...materialization.earningsAsOfMaterializationReport,
        datasetSeriesIdentity: 'SOME_OTHER_DATASET_V1',
      }]]));
    assert.throws(() => verifyEarningsAsOfMaterializationReport({
      store: overlay,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    }), code('EARNINGS_MATERIALIZATION_FOREIGN_DATASET'));
  });
});

/* --- T26..T30: cutoff and counting forgeries ----------------------------- */

test('I2-A026 threat T26: cutoff absent', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => buildEarningsDatasetBinding({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
      earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
      earningsFiscalClassificationPolicyId: ctx.earningsFiscalClassificationPolicyId,
      transformImplementationManifestId: ctx.transformImplementationManifestId,
    }), code('MARKET_DATA_INPUT_INVALID'));
  });
});

test('I2-A027 threat T27: cutoff not UTC', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    for (const value of ['2026-04-23T20:05:30', '2026-04-23T16:05:30-04:00', '2026-04-23 20:05:30Z']) {
      assert.throws(() => bindL4CI2Dataset(ctx.store, ctx, value),
        code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'), value);
    }
  });
});

test('I2-A028 threat T28: after-cutoff metadata leaks into diagnostics', () => {
  withEarningsStore((store) => {
    const dataset = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.q1EightK, L4C_I2_FILING_DEFINITIONS.q4EightKMultiDuration,
    ]);
    const early = materializeL4CI2Dataset(store, dataset, '2026-12-31T00:00:00.000Z')
      .materialization;
    // The Q4 filing is not yet visible, so its ambiguity diagnostics cannot
    // appear in the earlier answer.
    assert.equal(early.classificationDiagnostics.length, 0);
    assert.equal(early.earningsAsOfMaterializationReport.classificationDiagnosticCount, 0);
    const late = materializeL4CI2Dataset(store, dataset, L4C_I2_CUTOFF_AFTER_ALL).materialization;
    assert.equal(late.classificationDiagnostics.length, 2);
  });
});

test('I2-A029 threat T29: counts include filtered objects', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const report = materializeAt(ctx, HIDING_CUTOFF);
    assert.equal(report.visibleRevisionCount, report.orderedVisibleRevisionIdentityIds.length);
    assert.equal(report.visibleEventCount, report.orderedVisibleEventIdentityIds.length);
    assert.equal(report.visibleMetricObservationCount,
      report.orderedVisibleMetricObservationIds.length);
    assert.equal(report.fiscalClassificationCount, report.orderedFiscalClassificationIds.length);
  });
});

test('I2-A030 threat T30: digest includes future objects', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const hidden = materializeAt(ctx, HIDING_CUTOFF);
    const all = materializeAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.notEqual(hidden.orderedVisibleRevisionIdentityDigest,
      all.orderedVisibleRevisionIdentityDigest);
    assert.notEqual(hidden.orderedFiscalClassificationDigest,
      all.orderedFiscalClassificationDigest);
  });
});

/* --- static guards over the ten declared I2 modules ---------------------- */

test('I2-A031 a supersedes field on the materialization report is refused', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[materialization.earningsAsOfMaterializationReportId, {
        ...materialization.earningsAsOfMaterializationReport,
        supersedesEarningsAsOfMaterializationReportId: null,
      }]]));
    assert.throws(() => verifyEarningsAsOfMaterializationReport({
      store: overlay,
      earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    }), code('EARNINGS_MATERIALIZATION_SUPERSESSION_FORBIDDEN'));
  });
});

test('I2-A032 a Date.now() call anywhere in the I2 modules is refused by the static scan', () => {
  assert.equal(I2_MODULE_SOURCES.length, 10);
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    assert.equal(code.includes('Date.now'), false, logicalPath);
  }
});

test('I2-A033 a readdir call anywhere in the I2 modules is refused by the static scan', () => {
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    assert.equal(/readdir/u.test(code), false, logicalPath);
  }
});

test('I2-A034 a new Date( ) call anywhere in the I2 modules is refused by the static scan', () => {
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    assert.equal(/new Date\s*\(/u.test(code), false, logicalPath);
  }
});

test('I2-A035 an import of buildFinancialPeriodIdentityCore into an I2 module is refused', () => {
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    assert.equal(code.includes('buildFinancialPeriodIdentityCore'), false, logicalPath);
  }
});

test('I2-A036 a network specifier in an I2 module is refused', () => {
  for (const { logicalPath, code } of I2_MODULE_SOURCES) {
    const specifiers = [...code.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gmu)]
      .map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.equal(/^(https?:|node:http|node:net|node:dns|node:tls)/u.test(specifier), false,
        `${logicalPath} -> ${specifier}`);
    }
    assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket/u.test(code), false, logicalPath);
  }
  assert.equal(l4cI2LabRoot().length > 0, true);
});
