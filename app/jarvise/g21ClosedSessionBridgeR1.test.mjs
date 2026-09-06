import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
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
  assert.equal(bridge.records[0].eventTime, '2026-11-25T21:00:00.000Z');
  assert.equal(bridge.records[0].availableAt, '2026-11-25T21:00:00.000Z');
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

test('half-day anchor is admitted at canonical K(T) and the old +3h timestamp is adversarially rejected', () => {
  const halfDayClose = '2026-11-27T18:00:00.000Z';
  const selected = selectClosedMp1Sessions(calendar, halfDayClose);
  assert.equal(selected.latestClosedSession.sessionDate, '2026-11-27');
  assert.equal(selected.latestClosedSession.closeUtc, halfDayClose);
  const bridge = buildG21ClosedSessionBridgeR1({
    symbol: 'AAPL', knowledgeCutoff: halfDayClose,
    captureRecord: { chartResult: { quotes }, capturedAt: '2026-11-27T19:00:00.000Z' }, calendar,
  });
  assert.equal(bridge.effectiveKnowledgeCutoff, halfDayClose);
  assert.equal(bridge.admittedBarCount, 2);
  assert.equal(bridge.excludedCurrentSessionCount, 1);
  assert.equal(bridge.excludedNotYetAvailableCount, 0);
  const halfDay = bridge.records.find((record) => record.sessionDate === '2026-11-27');
  assert.equal(halfDay.eventTime, halfDayClose);
  assert.equal(halfDay.availableAt, halfDayClose);
  assert.equal(Date.parse('2026-11-27T21:00:00.000Z') > Date.parse(halfDayClose), true);
});

test('T2 every historical V2 half-day is admitted at its pinned canonical closeUtc', () => {
  let halfDayCount = 0;
  for (const year of [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    const historicalCalendar = JSON.parse(readFileSync(
      new URL(`../../data/jarvise/session-calendar-historical/XNYS/${year}/session-calendar-core.json`, import.meta.url),
      'utf8',
    ));
    for (const session of historicalCalendar.sessions.filter((entry) => entry.sessionKind === 'HALF_DAY_SESSION')) {
      const capturedAt = new Date(Date.parse(session.closeUtc) + 60_000).toISOString();
      const bridge = buildG21ClosedSessionBridgeR1({
        symbol: 'AAPL',
        knowledgeCutoff: session.closeUtc,
        captureRecord: {
          chartResult: { quotes: [{ date: session.sessionDate, open: 100, high: 102, low: 99, close: 101, volume: 10 }] },
          capturedAt,
        },
        calendar: { sessions: [session] },
      });
      assert.equal(bridge.status, 'AVAILABLE', session.sessionDate);
      assert.equal(bridge.admittedBarCount, 1, session.sessionDate);
      assert.equal(bridge.records[0].eventTime, session.closeUtc, session.sessionDate);
      assert.equal(bridge.records[0].availableAt, session.closeUtc, session.sessionDate);
      halfDayCount += 1;
    }
  }
  assert.ok(halfDayCount > 0);
});

test('bridge and canonical G21 refuse live, substitution, future, timezone, fill, and volume-coercion paths', () => {
  const bridge = buildG21ClosedSessionBridgeR1({
    symbol: 'AAPL', knowledgeCutoff: '2026-11-27T19:00:00.000Z',
    captureRecord: { chartResult: { quotes }, capturedAt: '2026-11-27T19:00:00.000Z' }, calendar,
  });
  assert.equal(bridge.records.some((record) => record.sessionDate === '2026-11-27'), true);
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
