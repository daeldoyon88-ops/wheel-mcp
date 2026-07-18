import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';

/**
 * D1-D10 — causal cash dividend accounting per price basis.
 * Every test asserts exact amounts, never just the absence of an exception.
 */

const NO_COSTS = Object.freeze({
  commission: Object.freeze({ fixedPerOrder: 0, perShare: 0, minimum: 0 }),
  slippage: Object.freeze({ bps: 0, minPerShare: 0, gapMultiplier: 1 }),
});

/** rows spec: [date, open, high, low, close, volume, splitFactor?, cashDividend?] */
function toRows(specs) {
  return specs.map(([date, open, high, low, close, volume, splitFactor, cashDividend]) => {
    const row = { date, open, high, low, close, volume };
    if (splitFactor !== undefined) row.splitFactor = splitFactor;
    if (cashDividend !== undefined) row.cashDividend = cashDividend;
    return row;
  });
}

function seriesFor(specs, { ohlcBasis = 'RAW', basis = 'RAW' } = {}) {
  const bars = normalizeDailyBars(toRows(specs), { symbol: 'TST', source: 'inline-fixture', ohlcBasis });
  return selectPriceBasis(bars, basis).series;
}

/** Strategy scripted by decision date; HOLD everywhere else. */
function scripted(script) {
  return {
    id: 'SCRIPTED_TEST',
    version: 'test/1',
    defaultParams: {},
    decide(ctx) {
      const d = script[ctx.sessionDate];
      return { intent: d?.intent ?? 'HOLD', stopLevel: d?.stopLevel ?? null, reasons: ['scripted'] };
    },
  };
}

function run(series, { script, priceBasis = 'RAW', initialCapital = 10000, commission = NO_COSTS.commission, slippage = NO_COSTS.slippage }) {
  return runBacktest({ symbol: 'TST', series, priceBasis, strategy: scripted(script), initialCapital, commission, slippage });
}

const FLAT_WITH_EXDATE_0306 = [
  ['2024-03-04', 100, 101, 99, 100, 1000],
  ['2024-03-05', 100, 101, 99, 100, 1000],
  ['2024-03-06', 100, 101, 99, 100, 1000, undefined, 0.75],
  ['2024-03-07', 100, 101, 99, 100, 1000],
];

test('D1 — position held before the ex-date receives the dividend on the full eligible quantity', () => {
  const series = seriesFor(FLAT_WITH_EXDATE_0306);
  const result = run(series, { script: { '2024-03-04': { intent: 'ENTER_LONG' } } });
  // Entry open 2024-03-05 at 100 -> 100 shares, cash 0.
  assert.equal(result.totalDividendsCash, 75);
  assert.deepEqual(result.corporateActionEvents, [{
    type: 'CASH_DIVIDEND',
    sessionDate: '2024-03-06',
    symbol: 'TST',
    priceBasis: 'RAW',
    cashDividendPerShare: 0.75,
    eligibleQuantity: 100,
    cashImpact: 75,
    source: 'inline-fixture',
  }]);
  assert.equal(result.equityCurve[2].cash, 75);
  assert.equal(result.metrics.finalEquity, 10075);
});

test('D2 — a buy filled at the open of the ex-date receives no dividend', () => {
  const series = seriesFor(FLAT_WITH_EXDATE_0306);
  const result = run(series, { script: { '2024-03-05': { intent: 'ENTER_LONG' } } });
  // No position at close 2024-03-05 -> the fill at the ex-date open is not entitled.
  assert.equal(result.totalDividendsCash, 0);
  assert.equal(result.corporateActionEvents.length, 1);
  assert.deepEqual(result.corporateActionEvents[0], {
    type: 'CASH_DIVIDEND_NOT_ENTITLED',
    sessionDate: '2024-03-06',
    symbol: 'TST',
    priceBasis: 'RAW',
    cashDividendPerShare: 0.75,
    eligibleQuantity: 0,
    cashImpact: 0,
    source: 'inline-fixture',
  });
  assert.equal(result.metrics.finalEquity, 10000);
});

test('D3 — a sell filled at the open of the ex-date keeps the dividend earned at close t-1', () => {
  const series = seriesFor(FLAT_WITH_EXDATE_0306);
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' }, '2024-03-05': { intent: 'EXIT' } },
  });
  assert.equal(result.totalDividendsCash, 75);
  assert.equal(result.corporateActionEvents.length, 1);
  assert.equal(result.corporateActionEvents[0].eligibleQuantity, 100);
  // Trade PnL excludes the dividend (flat prices, zero costs -> 0).
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].realizedPnl, 0);
  assert.equal(result.metrics.finalEquity, 10075);
});

test('D4 — partial exit before the ex-date: dividend only on the remaining quantity', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 99, 100, 1000],
    ['2024-03-07', 100, 101, 99, 100, 1000, undefined, 0.75],
    ['2024-03-08', 100, 101, 99, 100, 1000],
  ]);
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' }, '2024-03-05': { intent: 'REDUCE_50' } },
  });
  // 100 shares entered 03-05, 50 sold at the 03-06 open -> 50 eligible on 03-07.
  assert.equal(result.totalDividendsCash, 37.5);
  assert.equal(result.corporateActionEvents.length, 1);
  assert.equal(result.corporateActionEvents[0].eligibleQuantity, 50);
  assert.equal(result.corporateActionEvents[0].cashImpact, 37.5);
});

test('D5 — SPLIT_ADJUSTED basis credits an available cash dividend exactly once', () => {
  const series = seriesFor(FLAT_WITH_EXDATE_0306, { ohlcBasis: 'SPLIT_ADJUSTED', basis: 'SPLIT_ADJUSTED' });
  const result = run(series, { script: { '2024-03-04': { intent: 'ENTER_LONG' } }, priceBasis: 'SPLIT_ADJUSTED' });
  assert.equal(result.totalDividendsCash, 75);
  const dividendEvents = result.corporateActionEvents.filter((e) => e.type === 'CASH_DIVIDEND');
  assert.equal(dividendEvents.length, 1);
  assert.equal(dividendEvents[0].priceBasis, 'SPLIT_ADJUSTED');
  assert.equal(result.metrics.finalEquity, 10075);
});

test('D6 — TOTAL_RETURN_ADJUSTED never credits cashDividend separately (no double counting)', () => {
  const withDividend = seriesFor(FLAT_WITH_EXDATE_0306, { ohlcBasis: 'TOTAL_RETURN_ADJUSTED', basis: 'TOTAL_RETURN_ADJUSTED' });
  const withoutDividend = seriesFor(
    FLAT_WITH_EXDATE_0306.map(([d, o, h, l, c, v]) => [d, o, h, l, c, v]),
    { ohlcBasis: 'TOTAL_RETURN_ADJUSTED', basis: 'TOTAL_RETURN_ADJUSTED' }
  );
  const script = { '2024-03-04': { intent: 'ENTER_LONG' } };
  const a = run(withDividend, { script, priceBasis: 'TOTAL_RETURN_ADJUSTED' });
  const b = run(withoutDividend, { script, priceBasis: 'TOTAL_RETURN_ADJUSTED' });
  assert.equal(a.totalDividendsCash, 0);
  assert.equal(a.corporateActionEvents.filter((e) => e.type === 'CASH_DIVIDEND').length, 0);
  // The declared dividend stays traceable, without any cash impact.
  assert.deepEqual(a.corporateActionEvents.map((e) => e.type), ['CASH_DIVIDEND_ALREADY_EMBEDDED']);
  assert.deepEqual(a.equityCurve, b.equityCurve);
  assert.equal(a.metrics.finalEquity, b.metrics.finalEquity);
});

test('D7 — cashDividend null or 0: cash untouched, no artificial dividend event', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 99, 100, 1000, undefined, 0],
    ['2024-03-07', 100, 101, 99, 100, 1000],
  ]);
  const result = run(series, { script: { '2024-03-04': { intent: 'ENTER_LONG' } } });
  assert.equal(result.totalDividendsCash, 0);
  assert.equal(result.corporateActionEvents.length, 0);
  assert.equal(result.metrics.finalEquity, 10000);
});

test('D8 — dividends stay separate from commissions and slippage', () => {
  const series = seriesFor(FLAT_WITH_EXDATE_0306);
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' } },
    commission: { fixedPerOrder: 5, perShare: 0, minimum: 0 },
  });
  // Cash 10000, price 100, commission 5 -> 99 shares (9905 spent), cash 95.
  assert.equal(result.totalDividendsCash, 99 * 0.75);
  assert.equal(result.metrics.totalCommissions, 5);
  assert.equal(result.corporateActionEvents[0].cashImpact, 74.25);
  // The open trade carries commissions, never the dividend.
  assert.equal(result.trades[0].realizedPnl, 0);
  assert.equal(result.trades[0].commissions, 5);
  assert.equal(result.metrics.finalEquity, 95 + 74.25 + 99 * 100);
});

test('D9 — determinism: same series, same config -> same hash and same corporateActionEvents', () => {
  const script = { '2024-03-04': { intent: 'ENTER_LONG' } };
  const a = run(seriesFor(FLAT_WITH_EXDATE_0306), { script });
  const b = run(seriesFor(FLAT_WITH_EXDATE_0306), { script });
  assert.equal(a.resultHash, b.resultHash);
  assert.deepEqual(a.corporateActionEvents, b.corporateActionEvents);
});

test('D10 — split and dividend on the same session without provable order are refused', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 50, 51, 49, 50, 2000, 2, 0.75],
    ['2024-03-07', 50, 51, 49, 50, 2000],
  ]);
  assert.throws(
    () => run(series, { script: { '2024-03-04': { intent: 'ENTER_LONG' } } }),
    /CORPORATE_ACTION_ORDER_AMBIGUOUS/
  );
});
