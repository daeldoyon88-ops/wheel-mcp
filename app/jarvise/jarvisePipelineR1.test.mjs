import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import createJarviseRoutesR1 from './jarviseRoutesR1.js';
import { captureYahooChartResult, clearCapturedYahooChartResultsForTest } from './g21BridgeCaptureR1.mjs';
import { runJarvisePipelineR1 } from './jarvisePipelineR1.mjs';

const calendar = JSON.parse(readFileSync(new URL('../../data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json', import.meta.url), 'utf8'));
const K = '2026-08-26T20:00:00.000Z';
const coveredSymbol = 'AAPL';

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

test('same-process G21 capture produces only the F1 W5/W21 cohort and an emitted G24 record', () => {
  clearCapturedYahooChartResultsForTest();
  assert.equal(captureYahooChartResult(coveredSymbol, capturedChart(), { capturedAt: K }), true);
  const outcome = runJarvisePipelineR1({ symbol: coveredSymbol, knowledgeCutoff: K });
  assert.equal(outcome.status, 'AVAILABLE');
  assert.equal(outcome.cohort.status, 'VERIFIED');
  assert.deepEqual(outcome.featureSet.memberIndex, ['F1_SIMPLE_RETURN@W5', 'F1_SIMPLE_RETURN@W21']);
  assert.equal(outcome.regimeRecord.RegimeHorizonSpecId, 'f9766b932b62c14ccac05753402e26d990b363296e6d399b37bb8586aee68c88');
  assert.equal(outcome.regimeRecord.ClassifierVersionId, '08d4d7e65a831d8cdef25d9f3beb5c800c7f203408079ecb82e379825e121a49');
  assert.equal(outcome.regimeRecord.ParameterSetId, '52ca49f2d4adbcb70c66b4c9830b311a1eefed783a717a684e551dcc512385b2');
  assert.equal(typeof outcome.regimeRecord.regimeRecordId, 'string');
  assert.equal(outcome.regimeRecord.classificationQuality, 'PARTIAL');
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
