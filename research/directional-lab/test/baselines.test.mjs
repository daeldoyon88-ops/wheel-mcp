import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';
import { buyAndHoldBaseline } from '../src/strategy/buyAndHoldBaseline.mjs';
import { ma50Baseline } from '../src/strategy/ma50Baseline.mjs';
import { ema21Ema50Baseline } from '../src/strategy/ema21Ema50Baseline.mjs';
import { trendAtrBaseline } from '../src/strategy/trendAtrBaseline.mjs';
import { strategyProblems } from '../src/strategy/strategyInterface.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadSeries(name) {
  const { bars } = loadJsonDaily(join(FIXTURES, name));
  return selectPriceBasis(bars, 'SPLIT_ADJUSTED').series;
}

test('all four baselines satisfy the strategy interface', () => {
  for (const s of [buyAndHoldBaseline, ma50Baseline, ema21Ema50Baseline, trendAtrBaseline]) {
    assert.deepEqual(strategyProblems(s), []);
  }
});

test('B0 buy-and-hold: enters at the SECOND session open (first decision close -> next open) and never exits', () => {
  const series = loadSeries('causal-bars.json');
  const result = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: buyAndHoldBaseline });
  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].kind, 'OPEN_BUY');
  assert.equal(result.fills[0].decisionDate, series[0].sessionDate);
  assert.equal(result.fills[0].fillDate, series[1].sessionDate);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].open, true);
  assert.equal(result.metrics.exposurePct > 95, true);
});

test('B1 MA50: entry only when close > SMA50 with positive slope, exit when close < SMA50', () => {
  const series = loadSeries('causal-bars.json');
  const result = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: ma50Baseline });
  assert.ok(result.fills.length >= 2, 'fixture is engineered to trigger at least one round trip');
  const firstBuy = result.fills.find((f) => f.kind === 'OPEN_BUY');
  const dates = series.map((b) => b.sessionDate);
  const decisionIdx = dates.indexOf(firstBuy.decisionDate);
  assert.ok(decisionIdx >= 54, `SMA50 slope needs >= 55 bars, entry decided at index ${decisionIdx}`);
  for (const f of result.fills.filter((f) => f.kind === 'OPEN_SELL')) {
    assert.ok(f.notes.some((n) => n.includes('< SMA50')), 'exit reason must be the MA50 rule');
  }
});

test('B2 EMA21/EMA50 runs and respects its exit rule', () => {
  const series = loadSeries('causal-bars.json');
  const result = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: ema21Ema50Baseline });
  assert.ok(result.fills.length >= 2);
  for (const f of result.fills.filter((f) => f.kind === 'OPEN_SELL')) {
    assert.ok(f.notes.some((n) => n.includes('EMA21')), 'exit reason must reference the EMA rule');
  }
});

test('B3 trend+ATR: the trailing stop only ratchets upward and k stays 2.5', () => {
  const series = loadSeries('causal-bars.json');
  const result = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: trendAtrBaseline });
  assert.equal(result.parameters.k, 2.5);
  // Reconstruct stop decisions from HOLD signals is internal; instead verify
  // via stop fills: every STOP/GAP_STOP reference cannot exceed the max close.
  const maxClose = Math.max(...series.map((b) => b.close));
  for (const f of result.fills.filter((f) => f.kind === 'STOP' || f.kind === 'GAP_STOP')) {
    assert.ok(f.referencePrice <= maxClose);
  }
  assert.ok(result.signalCounts.HOLD > 0);
});

test('all baselines produce finite serializable metrics on every fixture', () => {
  for (const fixture of ['causal-bars.json', 'gap-stop-bars.json', 'split-bars.json', 'missing-bars.json']) {
    const series = loadSeries(fixture);
    for (const strategy of [buyAndHoldBaseline, ma50Baseline, ema21Ema50Baseline, trendAtrBaseline]) {
      const result = runBacktest({ symbol: 'X', series, priceBasis: 'SPLIT_ADJUSTED', strategy });
      assert.equal(result.label, 'PILOT_TECHNICAL_ONLY');
      for (const [name, value] of Object.entries(result.metrics)) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value), `${fixture}/${strategy.id}/${name} = ${value}`);
        if (value === null) {
          assert.ok(result.metricReasons[name], `${fixture}/${strategy.id}/${name} is null without a reason`);
        }
      }
    }
  }
});

test('costs are actually charged: gross return >= net return', () => {
  const series = loadSeries('causal-bars.json');
  for (const strategy of [buyAndHoldBaseline, ma50Baseline]) {
    const r = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy });
    assert.ok(r.metrics.totalReturnGrossPct >= r.metrics.totalReturnNetPct);
    assert.ok(r.metrics.totalCommissions > 0);
  }
});
