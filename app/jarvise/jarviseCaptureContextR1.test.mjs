import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import createJarviseRoutesR1 from './jarviseRoutesR1.js';
import { captureYahooChartResult, clearCapturedYahooChartResultsForTest } from './g21BridgeCaptureR1.mjs';
import { getJarviseCaptureContextR1 } from './jarviseCaptureContextR1.mjs';
import { selectClosedMp1Sessions } from './closedSessionSelectorR1.mjs';

const calendar = JSON.parse(readFileSync(new URL('../../data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json', import.meta.url), 'utf8'));
const capturedAt = '2026-08-26T20:05:00.000Z';

function capture(symbol) {
  assert.equal(captureYahooChartResult(symbol, { quotes: [{ date: '2026-08-26', close: 1 }] }, { capturedAt }), true);
}

function invokeRoute(router, path, query) {
  const layer = router.stack.find((entry) => entry.route?.path === path);
  assert.ok(layer);
  const handler = layer.route.stack[0].handle;
  let statusCode = null;
  let body = null;
  handler({ query }, { status(code) { statusCode = code; return this; }, json(value) { body = value; return this; } });
  return { statusCode, body };
}

test('capture-present context derives only the latest closed MP-1 session', () => {
  clearCapturedYahooChartResultsForTest();
  capture('aapl');
  const context = getJarviseCaptureContextR1({ symbol: ' AAPL ' });
  const expected = selectClosedMp1Sessions(calendar, capturedAt).latestClosedSession;

  assert.deepEqual(context, {
    symbol: 'AAPL',
    captureAvailable: true,
    sessionDate: expected.sessionDate,
    effectiveKnowledgeCutoff: expected.closeUtc,
    historicalReplaySupport: 'UNAVAILABLE',
  });
  assert.notEqual(context.effectiveKnowledgeCutoff, capturedAt);
  assert.equal(Object.isFrozen(context), true);
  for (const key of ['chartResult', 'quotes', 'ohlc', 'volume', 'capturedAt']) assert.equal(key in context, false);
});

test('capture absence and cross-symbol requests remain isolated and side-effect free', () => {
  clearCapturedYahooChartResultsForTest();
  capture('AAPL');
  assert.deepEqual(getJarviseCaptureContextR1({ symbol: 'MSFT' }), {
    symbol: 'MSFT',
    captureAvailable: false,
    sessionDate: null,
    effectiveKnowledgeCutoff: null,
    historicalReplaySupport: 'UNAVAILABLE',
  });
  clearCapturedYahooChartResultsForTest();
  assert.deepEqual(getJarviseCaptureContextR1({ symbol: 'AAPL' }), {
    symbol: 'AAPL',
    captureAvailable: false,
    sessionDate: null,
    effectiveKnowledgeCutoff: null,
    historicalReplaySupport: 'UNAVAILABLE',
  });
});

test('context implementation contains no clock, acquisition, G23, G24, or trading coupling', () => {
  const source = readFileSync(new URL('./jarviseCaptureContextR1.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['Date.now', 'captureYahooChartResult', 'marketService', 'provider.', 'fetch(', 'G23', 'G24', 'IBKR', 'trade']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('GET context maps capture presence, absence, and invalid symbols without changing regime injection', () => {
  const router = createJarviseRoutesR1({
    pipeline: () => ({ status: 'AVAILABLE' }),
    context: getJarviseCaptureContextR1,
  });
  clearCapturedYahooChartResultsForTest();
  capture('AAPL');
  const present = invokeRoute(router, '/context', { symbol: 'AAPL' });
  assert.equal(present.statusCode, 200);
  assert.equal(present.body.captureAvailable, true);

  const absent = invokeRoute(router, '/context', { symbol: 'MSFT' });
  assert.equal(absent.statusCode, 200);
  assert.equal(absent.body.captureAvailable, false);

  const invalid = invokeRoute(router, '/context', {});
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.reasonCode, 'SYMBOL_INVALID');

  const defaultRouter = createJarviseRoutesR1();
  const regimeWithoutCutoff = invokeRoute(defaultRouter, '/regime', { symbol: 'AAPL' });
  assert.equal(regimeWithoutCutoff.statusCode, 409);
  assert.equal(regimeWithoutCutoff.body.reasonCode, 'KNOWLEDGE_CUTOFF_INVALID');
});
