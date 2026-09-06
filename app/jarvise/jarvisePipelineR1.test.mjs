import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import createJarviseRoutesR1 from './jarviseRoutesR1.js';
import { captureYahooChartResult, clearCapturedYahooChartResultsForTest } from './g21BridgeCaptureR1.mjs';
import { buildG21ClosedSessionBridgeR1 } from './g21ClosedSessionBridgeR1.mjs';
import { deriveJarviseObservationDatasetIdR1 } from './jarviseDatasetIdentityTripleR1.mjs';
import { runJarviseHistoricalPreFetchPipelineR1, runJarvisePipelineR1 } from './jarvisePipelineR1.mjs';

const calendar = JSON.parse(readFileSync(new URL('../../data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json', import.meta.url), 'utf8'));
const K = '2026-08-26T20:00:00.000Z';
const coveredSymbol = 'AAPL';
const V1_CALENDAR_BINDING_ID = 'ac801193ad4ca02b7f0343ebaa4af93a8bdb118d3219edc12f80a9ef1046b023';
const V2_CALENDAR_BINDING_ID = '3fe7456e03175fc49fb8af810d2050e58f34d2e3d548b27ad071db8957882308';
const TEST_INSTRUMENT_ID = 'sha256:ddc5cc4c3476c414bcfad11c7e0e992c0cfe75f7cc8fddde56321a7c068fdd55';

function capturedChart() {
  const sessions = calendar.sessions.filter((session) => session.closeUtc <= K).slice(-30);
  return {
    quotes: sessions.map((session, index) => ({
      date: session.sessionDate,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 1_000_000 + index,
    })),
  };
}

test('T5 DatasetId_observation changes only when the repaired half-day joins the admitted cohort', () => {
  const regularSession = { sessionDate: '2026-11-25', closeUtc: '2026-11-25T21:00:00.000Z' };
  const halfDaySession = { sessionDate: '2026-11-27', closeUtc: '2026-11-27T18:00:00.000Z' };
  const quotes = [regularSession, halfDaySession].map((session, index) => ({
    date: session.sessionDate,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }));
  const halfDayCohort = buildG21ClosedSessionBridgeR1({
    symbol: coveredSymbol,
    knowledgeCutoff: halfDaySession.closeUtc,
    captureRecord: { chartResult: { quotes }, capturedAt: '2026-11-27T19:00:00.000Z' },
    calendar: { sessions: [regularSession, halfDaySession] },
  });
  const oldDelayedCohort = {
    ...halfDayCohort,
    admittedBarCount: 1,
    records: halfDayCohort.records.filter((record) => record.sessionDate !== halfDaySession.sessionDate),
  };
  const repairedHalfDayId = deriveJarviseObservationDatasetIdR1({
    g21BridgeOutput: halfDayCohort, instrumentIdentityId: TEST_INSTRUMENT_ID,
  }).datasetIdObservation;
  const oldDelayedId = deriveJarviseObservationDatasetIdR1({
    g21BridgeOutput: oldDelayedCohort, instrumentIdentityId: TEST_INSTRUMENT_ID,
  }).datasetIdObservation;
  assert.notEqual(repairedHalfDayId, oldDelayedId);

  const regularCohort = buildG21ClosedSessionBridgeR1({
    symbol: coveredSymbol,
    knowledgeCutoff: regularSession.closeUtc,
    captureRecord: { chartResult: { quotes: [quotes[0]] }, capturedAt: '2026-11-25T22:00:00.000Z' },
    calendar: { sessions: [regularSession] },
  });
  const regularBeforeRepair = {
    ...regularCohort,
    records: regularCohort.records.map((record) => ({
      ...record,
      eventTime: regularSession.closeUtc,
      availableAt: regularSession.closeUtc,
    })),
  };
  assert.equal(
    deriveJarviseObservationDatasetIdR1({
      g21BridgeOutput: regularCohort, instrumentIdentityId: TEST_INSTRUMENT_ID,
    }).datasetIdObservation,
    deriveJarviseObservationDatasetIdR1({
      g21BridgeOutput: regularBeforeRepair, instrumentIdentityId: TEST_INSTRUMENT_ID,
    }).datasetIdObservation,
  );
});

test('no capture, unresolved identity, and replay each fail closed before G23/G24', () => {
  clearCapturedYahooChartResultsForTest();
  const absent = runJarvisePipelineR1({ symbol: coveredSymbol, knowledgeCutoff: K });
  assert.equal(absent.reasonCode, 'CAPTURE_UNAVAILABLE');
  const unresolved = runJarvisePipelineR1({ symbol: 'TQQQ', knowledgeCutoff: K });
  assert.equal(unresolved.reasonCode, 'IDENTITY_UNAVAILABLE');

  assert.equal(captureYahooChartResult(coveredSymbol, capturedChart(), { capturedAt: K }), true);
  const replay = runJarvisePipelineR1({ symbol: coveredSymbol, knowledgeCutoff: '2026-08-25T20:00:00.000Z' });
  assert.equal(replay.reasonCode, 'HISTORICAL_REPLAY_UNAVAILABLE');
});

test('T12 GATE24 V1 keeps its binding, F1 cohort, and emitted regime record', () => {
  clearCapturedYahooChartResultsForTest();
  assert.equal(captureYahooChartResult(coveredSymbol, capturedChart(), { capturedAt: K }), true);
  const outcome = runJarvisePipelineR1({ symbol: coveredSymbol, knowledgeCutoff: K });
  assert.equal(outcome.status, 'AVAILABLE', JSON.stringify(outcome));
  assert.equal(outcome.cohort.status, 'VERIFIED');
  assert.deepEqual(outcome.featureSet.memberIndex, ['F1_SIMPLE_RETURN@W5', 'F1_SIMPLE_RETURN@W21']);
  assert.equal(outcome.regimeRecord.RegimeHorizonSpecId, 'f9766b932b62c14ccac05753402e26d990b363296e6d399b37bb8586aee68c88');
  assert.equal(outcome.regimeRecord.ClassifierVersionId, '08d4d7e65a831d8cdef25d9f3beb5c800c7f203408079ecb82e379825e121a49');
  assert.equal(outcome.regimeRecord.ParameterSetId, '52ca49f2d4adbcb70c66b4c9830b311a1eefed783a717a684e551dcc512385b2');
  assert.equal(typeof outcome.regimeRecord.regimeRecordId, 'string');
  assert.equal(outcome.regimeRecord.classificationQuality, 'PARTIAL');
  const v1Provenance = JSON.parse(readFileSync(
    new URL('../../data/jarvise/session-calendar/XNYS/2026/PROVENANCE.json', import.meta.url), 'utf8',
  ));
  assert.equal(v1Provenance.calendarWindowBindingId, V1_CALENDAR_BINDING_ID);
});

test('T8 historical V2 enforces validFrom and terminates before GATE24', () => {
  const historicalCalendar = JSON.parse(readFileSync(
    new URL('../../data/jarvise/session-calendar-historical/XNYS/2026/session-calendar-core.json', import.meta.url),
    'utf8',
  ));
  const priorSession = historicalCalendar.sessions.filter((session) => session.sessionDate < '2026-05-03').at(-1);
  const currentSessions = historicalCalendar.sessions
    .filter((session) => session.sessionDate >= '2026-05-04')
    .slice(0, 22);
  assert.equal(currentSessions[0].sessionDate, '2026-05-04');
  assert.ok(priorSession.sessionDate < '2026-05-03');
  const latestSession = currentSessions.at(-1);
  const sourceAcquiredAt = new Date(Date.parse(latestSession.closeUtc) + 60 * 60 * 1000).toISOString();
  const snapshotBars = [priorSession, ...currentSessions].map((session, index) => ({
    sessionDate: session.sessionDate,
    eventTime: session.closeUtc,
    availableAt: session.closeUtc,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000_000 + index,
  }));
  let reuseCalls = 0;
  const snapshotPersistence = {
    acquisitionInvocations: () => 0,
    reuse({ acquisitionKey }) {
      reuseCalls += 1;
      assert.equal(acquisitionKey, 'P2-TEST-AAPL-2026');
      return {
        manifestId: 'sha256:4c64e96a5d79df7113558834428c773705585d24b0c46a710a0041cf26092733',
        refetched: false,
        historicalReplaySupport: 'RETROSPECTIVE_RECONSTRUCTION_FROM_PINNED_SNAPSHOT',
        retrospectiveSemantics: 'RETROSPECTIVE_RECONSTRUCTION',
        snapshot: {
          record: { sourceAcquiredAt },
          normalizedDailyBars: { bars: snapshotBars },
        },
      };
    },
  };
  const outcome = runJarviseHistoricalPreFetchPipelineR1({
    symbol: coveredSymbol,
    knowledgeCutoff: latestSession.closeUtc,
    snapshotPersistence,
    acquisitionKey: 'P2-TEST-AAPL-2026',
  });
  assert.equal(outcome.status, 'AVAILABLE', JSON.stringify(outcome));
  assert.equal(reuseCalls, 1);
  assert.equal(outcome.g21.records[0].sessionDate, '2026-05-04');
  assert.equal(outcome.g21.records.some((record) => record.sessionDate < '2026-05-03'), false);
  assert.equal(outcome.identityCohort.resolutions.length, outcome.g21.records.length);
  assert.equal(outcome.calendarWindowBindingId, V2_CALENDAR_BINDING_ID);
  assert.equal(outcome.historicalProcessingBoundary, 'OBSERVATION_FEATURE');
  assert.equal(outcome.gate24RegimeRecordEmission, 'FORBIDDEN_UNDER_CALENDAR_V2');
  assert.equal(Object.hasOwn(outcome, 'regimeRecord'), false);
  assert.equal(outcome.snapshotPersistence.refetched, false);
  assert.equal(outcome.snapshotPersistence.acquisitionInvocationsDelta, 0);
});

test('GET adapter maps controlled pipeline refusals without an HTTP 500', () => {
  const router = createJarviseRoutesR1({ pipeline: () => ({ status: 'ABSENT', reasonCode: 'CAPTURE_UNAVAILABLE' }) });
  const handler = router.stack[0].route.stack[0].handle;
  let statusCode = null;
  let body = null;
  handler({ query: {} }, { status(code) { statusCode = code; return this; }, json(value) { body = value; return this; } });
  assert.equal(statusCode, 409);
  assert.equal(body.reasonCode, 'CAPTURE_UNAVAILABLE');
});
