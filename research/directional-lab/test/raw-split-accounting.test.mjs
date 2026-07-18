import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';

/**
 * S1-S12 — split and reverse-split accounting on the RAW basis, no-op on
 * already-adjusted bases, explicit refusal of fractional results and of
 * ambiguous DERIVED_ADJUSTED corporate actions.
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

const ENTER_FIRST = { '2024-03-04': { intent: 'ENTER_LONG' } };

test('S1 — RAW 2:1 split: quantity x2, average cost /2, economic value continuous', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 99, 100, 1000],
    ['2024-03-07', 50, 51, 49, 50, 2000, 2],
    ['2024-03-08', 50, 51, 49, 50, 2000],
  ]);
  const result = run(series, { script: ENTER_FIRST });
  // Entry open 03-05 at 100 -> 100 shares, cash 0. Prices are economically flat.
  for (const point of result.equityCurve) {
    assert.equal(point.equity, 10000, `fake equity jump at ${point.sessionDate}`);
  }
  assert.deepEqual(result.equityCurve.map((p) => p.quantity), [0, 100, 100, 200, 200]);
  const splitEvents = result.corporateActionEvents.filter((e) => e.type === 'SPLIT');
  assert.equal(splitEvents.length, 1);
  assert.equal(splitEvents[0].quantityBefore, 100);
  assert.equal(splitEvents[0].quantityAfter, 200);
  assert.equal(splitEvents[0].averageCostBefore, 100);
  assert.equal(splitEvents[0].averageCostAfter, 50);
  // Open trade at end of data reflects post-split, economically identical terms.
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 50);
  assert.equal(result.trades[0].maxQuantity, 200);
  assert.equal(result.trades[0].entryPrice * result.trades[0].maxQuantity, 10000);
});

test('S2 — RAW 1:5 reverse split with divisible quantity: 100 -> 20 shares, value continuous', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 500, 510, 490, 500, 200, 0.2],
    ['2024-03-07', 500, 510, 490, 500, 200],
  ]);
  const result = run(series, { script: ENTER_FIRST });
  for (const point of result.equityCurve) {
    assert.equal(point.equity, 10000, `fake equity jump at ${point.sessionDate}`);
  }
  assert.deepEqual(result.equityCurve.map((p) => p.quantity), [0, 100, 20, 20]);
  const splitEvent = result.corporateActionEvents.find((e) => e.type === 'SPLIT');
  assert.equal(splitEvent.quantityBefore, 100);
  assert.equal(splitEvent.quantityAfter, 20);
  assert.equal(splitEvent.averageCostBefore, 100);
  assert.equal(splitEvent.averageCostAfter, 500);
});

test('S3 — fractional reverse split result is refused, never rounded silently', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 500, 510, 490, 500, 200, 0.2],
    ['2024-03-07', 500, 510, 490, 500, 200],
  ]);
  // 10300 buys 103 shares at 100; 103 x 0.2 = 20.6 shares -> refused.
  assert.throws(
    () => run(series, { script: ENTER_FIRST, initialCapital: 10300 }),
    /FRACTIONAL_SPLIT_RESULT_UNSUPPORTED/
  );
});

test('S4 — active stop is divided by the factor; no artificial trigger, later trigger exact', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 95, 100, 1000],
    ['2024-03-07', 50, 51, 48, 50, 2000, 2],
    ['2024-03-08', 50, 50.5, 44, 46, 2000],
  ]);
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' }, '2024-03-05': { stopLevel: 90 } },
  });
  // Unadjusted, the stop 90 would fake-gap-fill at the 03-07 open of 50.
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitDate, '2024-03-08');
  assert.equal(result.trades[0].exitKind, 'STOP');
  assert.equal(result.trades[0].exitPrice, 45);
  const splitEvent = result.corporateActionEvents.find((e) => e.type === 'SPLIT');
  assert.equal(splitEvent.activeStopBefore, 90);
  assert.equal(splitEvent.activeStopAfter, 45);
});

test('S5 — pending stop decided the session before the split is adjusted and activates correctly', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 99, 100, 1000],
    ['2024-03-07', 50, 51, 46, 50, 2000, 2],
    ['2024-03-08', 50, 50.5, 44, 46, 2000],
  ]);
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' }, '2024-03-06': { stopLevel: 90 } },
  });
  // Stop decided at close 03-06 (pre-split terms) becomes 45, active from 03-07.
  // 03-07 low 46 > 45: no trigger (unadjusted 90 would gap-fill at open 50).
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitDate, '2024-03-08');
  assert.equal(result.trades[0].exitKind, 'STOP');
  assert.equal(result.trades[0].exitPrice, 45);
});

test('S6 — closed trade through a split: entry terms, commissions and PnL economically coherent', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 99, 100, 1000],
    ['2024-03-07', 50, 51, 49, 50, 2000, 2],
    ['2024-03-08', 60, 61, 59, 60, 2000],
  ]);
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' }, '2024-03-07': { intent: 'EXIT' } },
    initialCapital: 10010,
    commission: { fixedPerOrder: 10, perShare: 0, minimum: 0 },
  });
  // 100 shares at 100 (+10 commission), split 2:1, sold 200 at 60 (+10 commission).
  const trade = result.trades[0];
  assert.equal(trade.entryPrice, 50);
  assert.equal(trade.maxQuantity, 200);
  assert.equal(trade.exitPrice, 60);
  assert.equal(trade.commissions, 20);
  assert.ok(Math.abs(trade.realizedPnl - 1980) < 1e-9, `realizedPnl ${trade.realizedPnl}, expected 1980`);
  assert.ok(Math.abs(trade.returnPct - 19.8) < 1e-9, `returnPct ${trade.returnPct}, expected 19.8`);
  assert.equal(result.metrics.finalEquity, 11990);
});

test('S7 — partial exit before the split: realized PnL preserved, no double counting', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 111, 99, 110, 1000],
    ['2024-03-06', 110, 112, 108, 110, 1000],
    ['2024-03-07', 55, 56, 54, 55, 2000, 2],
    ['2024-03-08', 60, 61, 59, 60, 2000],
  ]);
  const result = run(series, {
    script: {
      '2024-03-04': { intent: 'ENTER_LONG' },
      '2024-03-05': { intent: 'REDUCE_50' },
      '2024-03-07': { intent: 'EXIT' },
    },
  });
  // 100 at 100; 50 sold at 110 (+500); split 2:1 -> 100 shares at cost 50;
  // 100 sold at 60 (+1000). Total +1500 on 10000.
  const trade = result.trades[0];
  assert.equal(trade.maxQuantity, 200);
  assert.equal(trade.realizedPnl, 1500);
  assert.equal(trade.returnPct, 15);
  assert.equal(result.metrics.finalEquity, 11500);
});

test('S8 — two successive splits applied in causal order, value continuous', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 50, 51, 49, 50, 2000, 2],
    ['2024-03-07', 50, 51, 49, 50, 2000],
    ['2024-03-08', 25, 26, 24, 25, 4000, 2],
    ['2024-03-11', 25, 26, 24, 25, 4000],
  ]);
  const result = run(series, { script: ENTER_FIRST });
  for (const point of result.equityCurve) {
    assert.equal(point.equity, 10000, `fake equity jump at ${point.sessionDate}`);
  }
  const splitEvents = result.corporateActionEvents.filter((e) => e.type === 'SPLIT');
  assert.equal(splitEvents.length, 2);
  assert.deepEqual(
    splitEvents.map((e) => [e.sessionDate, e.quantityBefore, e.quantityAfter, e.averageCostBefore, e.averageCostAfter]),
    [['2024-03-06', 100, 200, 100, 50], ['2024-03-08', 200, 400, 50, 25]]
  );
  assert.equal(result.equityCurve[result.equityCurve.length - 1].quantity, 400);
});

test('S9 — documented split on SPLIT_ADJUSTED: no quantity change, no double adjustment', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 99, 100, 1000, 2],
    ['2024-03-07', 100, 101, 99, 100, 1000],
  ], { ohlcBasis: 'SPLIT_ADJUSTED', basis: 'SPLIT_ADJUSTED' });
  const result = run(series, { script: ENTER_FIRST, priceBasis: 'SPLIT_ADJUSTED' });
  assert.deepEqual(result.equityCurve.map((p) => p.quantity), [0, 100, 100, 100]);
  for (const point of result.equityCurve) assert.equal(point.equity, 10000);
  assert.deepEqual(result.corporateActionEvents.map((e) => e.type), ['SPLIT_ALREADY_EMBEDDED']);
  assert.equal(result.corporateActionEvents[0].splitFactor, 2);
});

test('S10 — documented split on TOTAL_RETURN_ADJUSTED: no quantity change, no double adjustment', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 99, 100, 1000, 2],
    ['2024-03-07', 100, 101, 99, 100, 1000],
  ], { ohlcBasis: 'TOTAL_RETURN_ADJUSTED', basis: 'TOTAL_RETURN_ADJUSTED' });
  const result = run(series, { script: ENTER_FIRST, priceBasis: 'TOTAL_RETURN_ADJUSTED' });
  assert.deepEqual(result.equityCurve.map((p) => p.quantity), [0, 100, 100, 100]);
  assert.deepEqual(result.corporateActionEvents.map((e) => e.type), ['SPLIT_ALREADY_EMBEDDED']);
});

test('S11 — DERIVED_ADJUSTED with a corporate action is refused explicitly', () => {
  const rows = [
    { date: '2024-03-04', open: 100, high: 101, low: 99, close: 100, volume: 1000, adjclose: 100 },
    { date: '2024-03-05', open: 100, high: 101, low: 99, close: 100, volume: 1000, adjclose: 100, splitFactor: 2 },
    { date: '2024-03-06', open: 100, high: 101, low: 99, close: 100, volume: 1000, adjclose: 100 },
  ];
  const bars = normalizeDailyBars(rows, { symbol: 'TST', source: 'inline-fixture', ohlcBasis: 'RAW' });
  bars.forEach((b) => { b.lineage.totalReturnClose = b.adjusted.close; });
  const { series } = selectPriceBasis(bars, 'DERIVED_ADJUSTED');
  assert.throws(
    () => run(series, { script: ENTER_FIRST, priceBasis: 'DERIVED_ADJUSTED' }),
    /CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED/
  );
});

test('S12 — SPLIT audit trail carries the exact before/after values', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000],
    ['2024-03-06', 100, 101, 95, 100, 1000],
    ['2024-03-07', 50, 51, 48, 50, 2000, 2],
    ['2024-03-08', 50, 51, 49, 50, 2000],
  ]);
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' }, '2024-03-05': { stopLevel: 90 } },
  });
  const splitEvent = result.corporateActionEvents.find((e) => e.type === 'SPLIT');
  assert.deepEqual(splitEvent, {
    type: 'SPLIT',
    sessionDate: '2024-03-07',
    symbol: 'TST',
    priceBasis: 'RAW',
    splitFactor: 2,
    quantityBefore: 100,
    quantityAfter: 200,
    averageCostBefore: 100,
    averageCostAfter: 50,
    activeStopBefore: 90,
    activeStopAfter: 45,
    source: 'inline-fixture',
  });
});
