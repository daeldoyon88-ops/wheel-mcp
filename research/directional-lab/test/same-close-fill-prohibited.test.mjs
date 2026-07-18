import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';
import { ma50Baseline } from '../src/strategy/ma50Baseline.mjs';
import { ema21Ema50Baseline } from '../src/strategy/ema21Ema50Baseline.mjs';
import { trendAtrBaseline } from '../src/strategy/trendAtrBaseline.mjs';
import { buyAndHoldBaseline } from '../src/strategy/buyAndHoldBaseline.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.1: a signal depending on close t can never be executed
 * at close t. Every fill of every baseline must be dated strictly after its
 * decision date.
 */
test('no fill ever happens on the decision session (all baselines, all fills)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  for (const strategy of [buyAndHoldBaseline, ma50Baseline, ema21Ema50Baseline, trendAtrBaseline]) {
    const result = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy });
    assert.ok(result.fills.length > 0, `${strategy.id}: expected at least one fill on this fixture`);
    for (const fill of result.fills) {
      assert.ok(
        fill.fillDate > fill.decisionDate,
        `${strategy.id}: fill at ${fill.fillDate} not strictly after decision ${fill.decisionDate}`
      );
    }
  }
});

test('fills land exactly on the next session after the decision (no skipped causality)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const dates = series.map((b) => b.sessionDate);
  const result = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: ma50Baseline });
  for (const fill of result.fills.filter((f) => f.kind === 'OPEN_BUY' || f.kind === 'OPEN_SELL')) {
    const decisionIdx = dates.indexOf(fill.decisionDate);
    assert.equal(dates[decisionIdx + 1], fill.fillDate, `${fill.kind} decided ${fill.decisionDate} filled ${fill.fillDate}`);
  }
});
