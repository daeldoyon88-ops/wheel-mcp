import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { verifyMarketMacroFullComputationReport } from '../src/macro/marketMacroFullComputationReportL4BF2V1.mjs';
import { openOfficialMacroL4BF2Live } from './macroFullFeaturesL4BF2SyntheticFixture.mjs';

let emptySessions;
let noF2;
let emptyRegistry;

before(() => {
  emptySessions = openOfficialMacroL4BF2Live({ emptySessions: true });
  noF2 = openOfficialMacroL4BF2Live({ includeF2Observations: false });
  emptyRegistry = openOfficialMacroL4BF2Live({ emptyInstrumentRegistry: true });
});

after(() => {
  emptyRegistry?.close();
  noF2?.close();
  emptySessions?.close();
});

test('no-session range produces empty F1 and F2 full rows', () => {
  assert.equal(emptySessions.f1Rows.macroStateBySessionRows.rows.length, 0);
  assert.deepEqual(emptySessions.fullRows.marketMacroFullStateRows.rows, []);
});

test('no-session range produces no synthetic instrument row', () => {
  assert.deepEqual(emptySessions.instrumentRows.marketMacroInstrumentRows.rows, []);
});

test('no-session report is explicitly empty with null bounds', () => {
  const r = emptySessions.fullReport.fullComputationReport;
  assert.equal(r.sessionCount, 0);
  assert.equal(r.fullStateRowCount, 0);
  assert.equal(r.instrumentRowCount, 0);
  assert.equal(r.emptyComputation, true);
  assert.equal(r.firstSessionId, null);
  assert.equal(r.lastSessionId, null);
  assert.equal(r.firstSessionDate, null);
  assert.equal(r.lastSessionDate, null);
});

test('no-session report still counts the four explicitly pinned instruments', () => {
  assert.equal(emptySessions.instrumentRegistry.identityBundles.length, 4);
  assert.equal(emptySessions.fullReport.fullComputationReport.instrumentCount, 4);
});

test('no-session report verifier recomputes the empty graph', () => {
  const verified = verifyMarketMacroFullComputationReport({
    store: emptySessions.store,
    fullComputationReportId: emptySessions.fullReport.fullComputationReportId,
  });
  assert.equal(verified.fullComputationReport.emptyComputation, true);
});

test('sessions without F2 observations retain all nine additive full rows', () => {
  assert.equal(noF2.f1Rows.macroStateBySessionRows.rows.length, 9);
  assert.equal(noF2.fullRows.marketMacroFullStateRows.rows.length, 9);
});

test('sessions without F2 observations expose explicit NOT_AVAILABLE axes', () => {
  for (const row of noF2.fullRows.marketMacroFullStateRows.rows) {
    assert.equal(row.inflationState.cpiAvailabilityStatus, 'NOT_AVAILABLE');
    assert.equal(row.unemploymentState.unemploymentAvailabilityStatus, 'NOT_AVAILABLE');
    assert.equal(row.claimsState.claimsAvailabilityStatus, 'NOT_AVAILABLE');
    assert.equal(row.fullMacroRegimeState.inflationRegime, 'NOT_AVAILABLE');
    assert.equal(row.fullMacroRegimeState.laborRegime, 'NOT_AVAILABLE');
    assert.equal(row.fullMacroRegimeState.claimsRegime, 'NOT_AVAILABLE');
    assert.equal(row.fullMacroRegimeState.macroCompositeState, 'INSUFFICIENT_DATA');
  }
});

test('sessions without F2 observations are non-empty and counted unavailable', () => {
  const r = noF2.fullReport.fullComputationReport;
  assert.equal(r.emptyComputation, false);
  assert.equal(r.sessionCount, 9);
  assert.equal(r.cpiNotAvailableSessionCount, 9);
  assert.equal(r.unrateNotAvailableSessionCount, 9);
  assert.equal(r.claimsNotAvailableSessionCount, 9);
});

test('sessions without F2 data keep null causal provenance IDs', () => {
  for (const row of noF2.fullRows.marketMacroFullStateRows.rows) {
    assert.equal(row.fullProvenanceState.cpiObservationVintageId, null);
    assert.equal(row.fullProvenanceState.unrateObservationVintageId, null);
    assert.equal(row.fullProvenanceState.claimsObservationVintageId, null);
  }
});

test('valid empty instrument registry preserves all nine full rows', () => {
  assert.equal(emptyRegistry.instrumentRegistry.identityBundles.length, 0);
  assert.equal(emptyRegistry.fullRows.marketMacroFullStateRows.rows.length, 9);
});

test('valid empty instrument registry produces empty projection rows', () => {
  assert.deepEqual(emptyRegistry.instrumentRows.marketMacroInstrumentRows.rows, []);
});

test('empty-registry report is non-empty with instrumentCount zero', () => {
  const r = emptyRegistry.fullReport.fullComputationReport;
  assert.equal(r.emptyComputation, false);
  assert.equal(r.sessionCount, 9);
  assert.equal(r.instrumentCount, 0);
  assert.equal(r.instrumentRowCount, 0);
});

test('empty-registry projection counters are all zero', () => {
  const r = emptyRegistry.fullReport.fullComputationReport;
  assert.equal(r.projectedInstrumentRowCount, 0);
  assert.equal(r.partialInstrumentRowCount, 0);
  assert.equal(r.notApplicableInstrumentRowCount, 0);
  assert.equal(r.sessionMismatchInstrumentRowCount, 0);
  assert.deepEqual(Object.values(r.projectionStatusCounts), [0, 0, 0, 0]);
});
