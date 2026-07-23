import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { canonicalJsonText } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
  normalizeMarketMacroFullStateRowsV1,
  normalizeMarketMacroInstrumentRowsV1,
} from '../src/contracts/macroFullFeatureContractsL4BF2V1.mjs';
import { buildMarketMacroFullStateRows, verifyMarketMacroFullStateRows } from '../src/macro/marketMacroFullStateRowsL4BF2V1.mjs';
import { buildMarketMacroInstrumentRows, verifyMarketMacroInstrumentRows } from '../src/macro/marketMacroInstrumentRowsL4BF2V1.mjs';
import { buildMarketMacroFullComputationReport, verifyMarketMacroFullComputationReport } from '../src/macro/marketMacroFullComputationReportL4BF2V1.mjs';
import { verifyMarketMacroInstrumentProjectionPolicy } from '../src/macro/marketMacroInstrumentProjectionPolicyL4BF2V1.mjs';
import { pinSyntheticSourceDocument } from './macroIngestionL4BSyntheticFixture.mjs';
import { openOfficialMacroL4BF2Live } from './macroFullFeaturesL4BF2SyntheticFixture.mjs';

let live;
let ctx;
let originalF1Bytes;

before(() => {
  live = openOfficialMacroL4BF2Live();
  ctx = live;
  originalF1Bytes = canonicalJsonText(ctx.f1Rows.macroStateBySessionRows);
});

after(() => live?.close());

function f2Pins() {
  return {
    f1MacroStateBySessionRowsId: ctx.f1Rows.macroStateBySessionRowsId,
    f1SourceBundleId: ctx.sourceBundle.sourceBundleId,
    f1FeatureComputationPolicyId: ctx.featurePolicy.featureComputationPolicyId,
    f1MacroFeatureComputationReportId: ctx.f1Report.macroFeatureComputationReportId,
    instrumentProjectionPolicyId: ctx.projectionPolicy.instrumentProjectionPolicyId,
  };
}

function instrumentPins() {
  return {
    ...f2Pins(),
    fullStateRowsId: ctx.fullRows.fullStateRowsId,
    instrumentIdentityRegistryManifestId: ctx.instrumentRegistry.registryManifestId,
  };
}

test('official fixture has nine exact sessions including DST and half-day', () => {
  const rows = ctx.fullRows.marketMacroFullStateRows.rows;
  assert.equal(rows.length, 9);
  const dst = rows.find((row) => row.sessionDate === '2025-03-10');
  const halfDay = rows.find((row) => row.sessionDate === '2025-11-28');
  assert.equal(dst.sessionCloseUtc, '2025-03-10T20:00:00.000Z');
  assert.equal(halfDay.sessionCloseUtc, '2025-11-28T18:00:00.000Z');
});

test('full rows pin the exact immutable F1 quartet and session row identity', () => {
  for (const row of ctx.fullRows.marketMacroFullStateRows.rows) {
    assert.equal(row.f1StateReference.f1MacroStateBySessionRowsId, ctx.f1Rows.macroStateBySessionRowsId);
    assert.equal(row.f1StateReference.f1SourceBundleId, ctx.sourceBundle.sourceBundleId);
    assert.equal(row.f1StateReference.f1FeatureComputationPolicyId, ctx.featurePolicy.featureComputationPolicyId);
    assert.equal(row.f1StateReference.f1MacroFeatureComputationReportId, ctx.f1Report.macroFeatureComputationReportId);
    assert.equal(row.f1StateReference.f1SessionId, row.sessionId);
    assert.equal(row.f1StateReference.f1SessionCloseUtc, row.sessionCloseUtc);
  }
});

test('F2 construction does not mutate the F1 canonical rows', () => {
  assert.equal(canonicalJsonText(ctx.f1Rows.macroStateBySessionRows), originalF1Bytes);
  assert.equal(ctx.store.readCanonicalObject({
    uri: ctx.store.uriForObject({
      namespace: 'snapshots', objectId: ctx.f1Rows.macroStateBySessionRowsId,
    }),
    expectedObjectId: ctx.f1Rows.macroStateBySessionRowsId,
    schemaVersion: 'MacroStateBySessionRows/1',
  }).objectId, ctx.f1Rows.macroStateBySessionRowsId);
});

test('every selected F2 vintage is available no later than its session close', () => {
  for (const row of ctx.fullRows.marketMacroFullStateRows.rows) {
    for (const availableAt of [
      row.inflationState.cpiAvailableAt,
      row.unemploymentState.unemploymentAvailableAt,
      row.claimsState.claimsAvailableAt,
    ]) {
      if (availableAt !== null) assert.ok(availableAt <= row.sessionCloseUtc);
    }
  }
});

test('monthly and weekly reference periods never exceed the current session', () => {
  for (const row of ctx.fullRows.marketMacroFullStateRows.rows) {
    if (row.inflationState.cpiReferencePeriod !== null) {
      assert.ok(row.inflationState.cpiReferencePeriod <= row.sessionDate.slice(0, 7));
    }
    if (row.unemploymentState.unemploymentReferencePeriod !== null) {
      assert.ok(row.unemploymentState.unemploymentReferencePeriod <= row.sessionDate.slice(0, 7));
    }
    if (row.claimsState.claimsReferenceWeek !== null) {
      assert.ok(row.claimsState.claimsReferenceWeek <= row.sessionDate);
    }
  }
});

test('fixture exercises CPI initial and causally used revision vintages', () => {
  const kinds = new Set(ctx.fullRows.marketMacroFullStateRows.rows
    .map((row) => row.inflationState.cpiRevisionKind));
  assert.equal(kinds.has('INITIAL'), true);
  assert.equal(kinds.has('REVISION'), true);
});

test('fixture exercises claims NORMAL, ELEVATED and SPIKE classifications', () => {
  const states = new Set(ctx.fullRows.marketMacroFullStateRows.rows
    .map((row) => row.claimsState.claimsSpikeState));
  assert.equal(states.has('NORMAL'), true);
  assert.equal(states.has('ELEVATED'), true);
  assert.equal(states.has('SPIKE'), true);
});

test('full macro state keeps explainable axes and no opaque score', () => {
  for (const row of ctx.fullRows.marketMacroFullStateRows.rows) {
    assert.deepEqual(Object.keys(row.fullMacroRegimeState), [
      'nominalRateRegime', 'curveRegime', 'inflationRegime', 'laborRegime',
      'claimsRegime', 'policyDirection', 'macroCompositeState', 'macroDataCompleteness',
    ]);
    assert.equal(Object.hasOwn(row, 'score'), false);
    assert.equal(Object.hasOwn(row, 'recommendation'), false);
  }
});

test('full provenance pins all three causal observation vintage identities', () => {
  for (const row of ctx.fullRows.marketMacroFullStateRows.rows) {
    assert.match(row.fullProvenanceState.orderedFullProvenanceDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(row.fullProvenanceState.f1SessionId, row.sessionId);
    assert.equal(row.fullProvenanceState.sessionCloseUtc, row.sessionCloseUtc);
  }
});

test('projection policy is the closed explicit-registry session-aligned singleton', () => {
  const policy = verifyMarketMacroInstrumentProjectionPolicy({
    store: ctx.store,
    instrumentProjectionPolicyId: ctx.projectionPolicy.instrumentProjectionPolicyId,
  }).instrumentProjectionPolicy;
  assert.equal(policy.instrumentSelectionPolicy, 'EXPLICIT_REGISTRY_ONLY');
  assert.equal(policy.sessionAlignmentPolicy, 'INSTRUMENT_LISTING_INTERVAL_ON_MACRO_SESSION');
  assert.equal(policy.neighbourSessionFallbackPolicy, 'FORBIDDEN');
  assert.equal(policy.latestPolicy, 'FORBIDDEN');
});

test('instrument projection exercises all four closed statuses', () => {
  const statuses = new Set(ctx.instrumentRows.marketMacroInstrumentRows.rows
    .map((row) => row.projectionStatus));
  assert.deepEqual([...statuses].sort(), [
    'NOT_APPLICABLE', 'PARTIAL', 'PROJECTED', 'SESSION_MISMATCH',
  ]);
});

test('instrument rows contain no ticker mapping or decision fields', () => {
  const forbidden = ['canonicalTicker', 'score', 'rank', 'ranking', 'recommendation',
    'signal', 'buy', 'sell', 'strike', 'premium'];
  for (const row of ctx.instrumentRows.marketMacroInstrumentRows.rows) {
    for (const field of forbidden) assert.equal(Object.hasOwn(row, field), false);
  }
});

test('TQQQ ETF receives no inferred leverage classification', () => {
  const bundle = ctx.instrumentRegistry.identityBundles.find((item) => item.descriptors
    .some((descriptor) => descriptor.descriptorCore.displayName === 'TQQQ'));
  assert.ok(bundle);
  const instrumentId = bundle.identityManifest.instrumentIdentityId;
  const rows = ctx.instrumentRows.marketMacroInstrumentRows.rows
    .filter((row) => row.instrumentIdentityId === instrumentId);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.assetClass === 'ETF'
    && row.leverageClass === 'NOT_AUTHORITATIVE'));
});

test('non-US instrument is explicit NOT_APPLICABLE with no macro axes', () => {
  const row = ctx.instrumentRows.marketMacroInstrumentRows.rows
    .find((item) => item.projectionStatus === 'NOT_APPLICABLE');
  assert.ok(row);
  assert.equal(row.instrumentJurisdictionCode, 'CA');
  assert.equal(row.instrumentCurrencyCode, 'CAD');
  assert.equal(row.sessionId, null);
  assert.equal(row.macroRegimeAxes, null);
});

test('partial listing yields exact SESSION_MISMATCH rather than nearest session', () => {
  const mismatches = ctx.instrumentRows.marketMacroInstrumentRows.rows
    .filter((row) => row.projectionStatus === 'SESSION_MISMATCH');
  assert.ok(mismatches.length > 0);
  assert.ok(mismatches.every((row) => row.sessionId !== null
    && row.macroFullStateRowIdentity === null && row.macroRegimeAxes === null));
});

test('official fixture has four pinned instruments and 28 projection rows', () => {
  assert.equal(ctx.instrumentRegistry.identityBundles.length, 4);
  assert.equal(ctx.instrumentRows.marketMacroInstrumentRows.rows.length, 28);
});

test('official fixture exposes four reproducible F2 content addresses', (t) => {
  const ids = {
    instrumentProjectionPolicyId: ctx.projectionPolicy.instrumentProjectionPolicyId,
    fullStateRowsId: ctx.fullRows.fullStateRowsId,
    instrumentRowsId: ctx.instrumentRows.instrumentRowsId,
    fullComputationReportId: ctx.fullReport.fullComputationReportId,
  };
  assert.ok(Object.values(ids).every((id) => /^sha256:[0-9a-f]{64}$/u.test(id)));
  t.diagnostic(`L4B-F2-GOLDEN ${JSON.stringify(ids)}`);
});

test('report base counts are fully reconciled', () => {
  const report = ctx.fullReport.fullComputationReport;
  assert.equal(report.sessionCount, 9);
  assert.equal(report.instrumentCount, 4);
  assert.equal(report.fullStateRowCount, ctx.fullRows.marketMacroFullStateRows.rows.length);
  assert.equal(report.instrumentRowCount, ctx.instrumentRows.marketMacroInstrumentRows.rows.length);
  assert.equal(report.emptyComputation, false);
});

test('report completeness and availability counters each close over sessions', () => {
  const r = ctx.fullReport.fullComputationReport;
  assert.equal(r.completeMacroSessionCount + r.partialMacroSessionCount
    + r.unavailableMacroSessionCount, r.sessionCount);
  assert.equal(r.cpiAvailableSessionCount + r.cpiStaleSessionCount
    + r.cpiWithdrawnSessionCount + r.cpiNotAvailableSessionCount, r.sessionCount);
  assert.equal(r.unrateAvailableSessionCount + r.unrateStaleSessionCount
    + r.unrateWithdrawnSessionCount + r.unrateNotAvailableSessionCount, r.sessionCount);
  assert.equal(r.claimsAvailableSessionCount + r.claimsStaleSessionCount
    + r.claimsWithdrawnSessionCount + r.claimsNotAvailableSessionCount, r.sessionCount);
});

test('report projection counters close over instrument rows', () => {
  const r = ctx.fullReport.fullComputationReport;
  assert.equal(r.projectedInstrumentRowCount + r.partialInstrumentRowCount
    + r.notApplicableInstrumentRowCount + r.sessionMismatchInstrumentRowCount,
  r.instrumentRowCount);
  assert.equal(Object.values(r.projectionStatusCounts).reduce((a, b) => a + b, 0),
    r.instrumentRowCount);
});

test('report regime maps close over full rows', () => {
  const r = ctx.fullReport.fullComputationReport;
  for (const counts of [r.inflationRegimeCounts, r.laborRegimeCounts,
    r.claimsRegimeCounts, r.compositeStateCounts]) {
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), r.fullStateRowCount);
  }
});

test('report records rejected future observations and canonical digests', () => {
  const r = ctx.fullReport.fullComputationReport;
  assert.ok(r.futureObservationRejectedCount > 0);
  assert.ok(r.futureRevisionRejectedCount > 0);
  for (const digest of [r.orderedFullStateRowDigest, r.orderedInstrumentRowDigest,
    r.orderedFullProvenanceDigest]) assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
});

test('top-level report verifier recursively recomputes the pinned graph', () => {
  const verified = verifyMarketMacroFullComputationReport({
    store: ctx.store,
    fullComputationReportId: ctx.fullReport.fullComputationReportId,
  });
  assert.deepEqual(verified.fullComputationReport, ctx.fullReport.fullComputationReport);
});

test('duplicate full-state and instrument rows are rejected by closed ordering', () => {
  const full = structuredClone(ctx.fullRows.marketMacroFullStateRows);
  full.rows.splice(1, 0, structuredClone(full.rows[0]));
  assert.throws(() => normalizeMarketMacroFullStateRowsV1(full), /strictly sorted/u);
  const instruments = structuredClone(ctx.instrumentRows.marketMacroInstrumentRows);
  instruments.rows.splice(1, 0, structuredClone(instruments.rows[0]));
  assert.throws(() => normalizeMarketMacroInstrumentRowsV1(instruments), /strictly sorted/u);
});

test('recomputation rejects canonical full-row, instrument-row and report forgeries', () => {
  const forgedFull = structuredClone(ctx.fullRows.marketMacroFullStateRows);
  forgedFull.rows[0].inflationState.cpiLevel = { atoms: '999999', scale: 3 };
  const storedFull = ctx.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
    value: forgedFull,
  });
  assert.throws(() => verifyMarketMacroFullStateRows({
    store: ctx.store, fullStateRowsId: storedFull.objectId, ...f2Pins(),
  }), /MISMATCH/u);

  const forgedInstrument = structuredClone(ctx.instrumentRows.marketMacroInstrumentRows);
  const projected = forgedInstrument.rows.find((row) => row.projectionStatus === 'PROJECTED');
  projected.projectionStatus = 'PARTIAL';
  const storedInstrument = ctx.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
    value: forgedInstrument,
  });
  assert.throws(() => verifyMarketMacroInstrumentRows({
    store: ctx.store, instrumentRowsId: storedInstrument.objectId, ...instrumentPins(),
  }), /MISMATCH/u);

  const forgedReport = structuredClone(ctx.fullReport.fullComputationReport);
  forgedReport.instrumentCount += 1;
  const storedReport = ctx.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
    value: forgedReport,
  });
  assert.throws(() => verifyMarketMacroFullComputationReport({
    store: ctx.store, fullComputationReportId: storedReport.objectId,
  }), /MISMATCH/u);
});

test('CAS enrichment preserves full rows, instrument rows, report bytes and IDs', () => {
  pinSyntheticSourceDocument(ctx.store, 'f2-post-computation-future-latest-noise');
  const fullRows = buildMarketMacroFullStateRows({ store: ctx.store, ...f2Pins() });
  const instrumentRows = buildMarketMacroInstrumentRows({
    store: ctx.store, ...instrumentPins(), fullStateRowsId: fullRows.fullStateRowsId,
  });
  const report = buildMarketMacroFullComputationReport({
    store: ctx.store,
    ...instrumentPins(),
    fullStateRowsId: fullRows.fullStateRowsId,
    instrumentRowsId: instrumentRows.instrumentRowsId,
  });
  assert.equal(fullRows.fullStateRowsId, ctx.fullRows.fullStateRowsId);
  assert.equal(instrumentRows.instrumentRowsId, ctx.instrumentRows.instrumentRowsId);
  assert.equal(report.fullComputationReportId, ctx.fullReport.fullComputationReportId);
  assert.equal(canonicalJsonText(fullRows.marketMacroFullStateRows),
    canonicalJsonText(ctx.fullRows.marketMacroFullStateRows));
  assert.equal(canonicalJsonText(instrumentRows.marketMacroInstrumentRows),
    canonicalJsonText(ctx.instrumentRows.marketMacroInstrumentRows));
  assert.equal(canonicalJsonText(report.fullComputationReport),
    canonicalJsonText(ctx.fullReport.fullComputationReport));
});
