import assert from 'node:assert/strict';
import test from 'node:test';
import basis from './yahooSourceBasisDeclarationR1.json' with { type: 'json' };
import { captureYahooChartResult, clearCapturedYahooChartResultsForTest, getCapturedYahooChartResult, setCaptureFailureForTest } from './g21BridgeCaptureR1.mjs';
import { selectClosedMp1Sessions } from './closedSessionSelectorR1.mjs';
import { buildG21ClosedSessionBridgeR1 } from './g21ClosedSessionBridgeR1.mjs';
import { requestHistoricalCausalData } from '../../governance/gates/GATE21/implementation/causal-data-interface.mjs';
import { createMarketService } from '../services/marketService.js';

const calendar = {
  sessions: [
    { sessionDate: '2026-11-25', closeUtc: '2026-11-25T21:00:00.000Z' },
    { sessionDate: '2026-11-27', closeUtc: '2026-11-27T18:00:00.000Z' },
    { sessionDate: '2026-11-30', closeUtc: '2026-11-30T21:00:00.000Z' },
  ],
};

const quotes = [
  { date: '2026-11-25', open: 100, high: 103, low: 99, close: 102, adjclose: 88, volume: 0 },
  { date: '2026-11-27', open: 102, high: 104, low: 101, close: 103, adjclose: 89, volume: null },
  { date: '2026-11-30', open: 103, high: 105, low: 102, close: 104, adjclose: 90, volume: 200 },
];

test('R2 declaration binds the accepted Yahoo split-adjusted and retrospective semantics', () => {
  assert.equal(basis.sourceId, 'YAHOO_CHART_EOD');
  assert.equal(basis.providerLibraryVersion, '3.14.0');
  assert.equal(basis.priceBasis, 'SPLIT_ADJUSTED');
  assert.equal(basis.ohlcBasis, 'SPLIT_ADJUSTED');
  assert.equal(basis.corporateActionTreatment, 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED');
  assert.equal(basis.temporalCapability, 'RETROSPECTIVE_CAPTURE_ONLY');
  assert.equal(basis.basisProofClass, 'EMPIRICALLY_PROVEN');
  assert.deepEqual(basis.evidenceReferences.map((entry) => entry.symbol), ['AAPL', 'TSLA']);
});

test('capture records strict UTC provenance by reference and same-symbol recapture replaces it', () => {
  clearCapturedYahooChartResultsForTest();
  const chartResult = { quotes };
  assert.equal(captureYahooChartResult('aapl', chartResult, { capturedAt: '2026-11-30T22:00:00.000Z' }), true);
  assert.deepEqual(getCapturedYahooChartResult('AAPL'), { chartResult, capturedAt: '2026-11-30T22:00:00.000Z' });
  assert.equal(captureYahooChartResult('AAPL', { quotes: [] }, { capturedAt: 'invalid' }), false);
  const replacement = { quotes };
  assert.equal(captureYahooChartResult('AAPL', replacement, { capturedAt: '2026-11-30T22:01:00.000Z' }), true);
  assert.deepEqual(getCapturedYahooChartResult('AAPL'), { chartResult: replacement, capturedAt: '2026-11-30T22:01:00.000Z' });
});

test('same latest MP-1 session is admitted at canonical K(T), without a second Yahoo result', () => {
  clearCapturedYahooChartResultsForTest();
  const chartResult = { quotes };
  captureYahooChartResult('AAPL', chartResult, { capturedAt: '2026-11-30T22:00:00.000Z' });
  const bridge = buildG21ClosedSessionBridgeR1({
    symbol: 'AAPL', knowledgeCutoff: '2026-11-30T23:00:00.000Z', calendar,
  });
  assert.equal(bridge.status, 'AVAILABLE');
  assert.equal(bridge.admittedBarCount, 3);
  assert.equal(bridge.effectiveKnowledgeCutoff, '2026-11-30T21:00:00.000Z');
  assert.equal(bridge.requestedLatestClosedSession.sessionDate, '2026-11-30');
  assert.equal(bridge.captureLatestClosedSession.sessionDate, '2026-11-30');
  assert.equal(bridge.historicalPlaneStatus, 'HISTORICAL');
  assert.equal(bridge.records[0].basis, 'SPLIT_ADJUSTED');
  assert.equal(bridge.records[0].selected.close, 102);
  assert.equal(bridge.records[0].selected.close, quotes[0].close);
  assert.equal(bridge.records[0].source, 'YAHOO_CHART_EOD');
  assert.equal(bridge.records[1].selected.close, quotes[1].close);
  assert.equal(bridge.records[1].selected.volume, null);
  assert.equal(bridge.records[1].missing.missingReason, 'VOLUME_MISSING');
  assert.equal(bridge.records[1].qualityFlags.includes('TOTAL_RETURN_CLOSE_AVAILABLE'), true);
  assert.equal(bridge.historicalReplaySupport, 'UNAVAILABLE');
});

test('old requested K is mechanically refused before G21 admission', () => {
  let g21Calls = 0;
  const bridge = buildG21ClosedSessionBridgeR1({
    symbol: 'AAPL',
    knowledgeCutoff: '2026-11-25T22:00:00.000Z',
    captureRecord: { chartResult: { quotes }, capturedAt: '2026-11-30T22:00:00.000Z' },
    calendar,
    requestHistoricalCausalDataFn: () => { g21Calls += 1; throw new Error('must not execute'); },
  });
  assert.equal(bridge.status, 'UNAVAILABLE');
  assert.equal(bridge.reasonCode, 'HISTORICAL_REPLAY_UNAVAILABLE');
  assert.equal(bridge.admittedBarCount, 0);
  assert.deepEqual(bridge.records, []);
  assert.equal(g21Calls, 0);
});

test('MP-1 excludes current sessions and conservatively delays half-day bars at canonical K(T)', () => {
  const selected = selectClosedMp1Sessions(calendar, '2026-11-27T19:00:00.000Z');
  assert.equal(selected.latestClosedSession.sessionDate, '2026-11-27');
  assert.equal(selected.latestClosedSession.closeUtc, '2026-11-27T18:00:00.000Z');
  const bridge = buildG21ClosedSessionBridgeR1({
    symbol: 'AAPL', knowledgeCutoff: '2026-11-27T19:00:00.000Z',
    captureRecord: { chartResult: { quotes }, capturedAt: '2026-11-27T19:00:00.000Z' }, calendar,
  });
  assert.equal(bridge.effectiveKnowledgeCutoff, '2026-11-27T18:00:00.000Z');
  assert.equal(bridge.admittedBarCount, 1);
  assert.equal(bridge.excludedCurrentSessionCount, 1);
  assert.equal(bridge.excludedNotYetAvailableCount, 1);
  assert.equal(bridge.records[0].sessionDate, '2026-11-25');
  assert.equal(bridge.exclusions.some((entry) => entry.reasonCode === 'NORMALIZED_BAR_NOT_AVAILABLE_AT_K'), true);
});

test('bridge and canonical G21 refuse live, substitution, future, timezone, fill, and volume-coercion paths', () => {
  const bridge = buildG21ClosedSessionBridgeR1({
    symbol: 'AAPL', knowledgeCutoff: '2026-11-27T19:00:00.000Z',
    captureRecord: { chartResult: { quotes }, capturedAt: '2026-11-27T19:00:00.000Z' }, calendar,
  });
  assert.equal(bridge.records.some((record) => record.sessionDate === '2026-11-27'), false);
  assert.equal(bridge.records[0].selected.volume, 0);
  assert.equal(bridge.records[0].basis, 'SPLIT_ADJUSTED');
  assert.equal(requestHistoricalCausalData({ plane: 'LIVE' }).code, 'LIVE_PLANE_NOT_IMPLEMENTED');
  assert.equal(requestHistoricalCausalData({ liveSubstitution: true }).code, 'LIVE_INTO_HISTORICAL_FORBIDDEN');
  assert.equal(requestHistoricalCausalData({ forwardFill: true }).code, 'FORWARD_FILL_FORBIDDEN');
  assert.equal(requestHistoricalCausalData({ coerceMissingVolumeToZero: true }).code, 'MISSING_VOLUME_NOT_ZERO');
  assert.equal(requestHistoricalCausalData({ timezone: 'EST' }).code, 'TIMEZONE_AMBIGUOUS');
});

test('a forced supplementary capture failure leaves Wheel technicals usable', async () => {
  clearCapturedYahooChartResultsForTest();
  setCaptureFailureForTest(true);
  const service = createMarketService({
    async getChart() {
      return { quotes: Array.from({ length: 51 }, (_, index) => ({ close: 100 + index })) };
    },
  });
  const technicals = await service.getTechnicals('AAPL');
  assert.equal(technicals.symbol, 'AAPL');
  assert.equal(technicals.currentPrice, 150);
  setCaptureFailureForTest(false);
});
