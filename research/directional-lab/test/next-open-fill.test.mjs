import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';
import { ma50Baseline } from '../src/strategy/ma50Baseline.mjs';
import { createSlippageModel } from '../src/execution/slippageModel.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.2: entry price must be open(t+1) plus slippage; exit
 * price must be open(t+1) minus slippage, with the exact configured model.
 */
test('entry fills at next open + slippage, exit fills at next open - slippage (exact math)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const slippageConfig = { bps: 10, minPerShare: 0.02, gapMultiplier: 2 };
  const model = createSlippageModel(slippageConfig);
  const byDate = new Map(series.map((b) => [b.sessionDate, b]));

  const result = runBacktest({
    symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: ma50Baseline, slippage: slippageConfig,
  });
  let checked = 0;
  for (const fill of result.fills) {
    const bar = byDate.get(fill.fillDate);
    if (fill.kind === 'OPEN_BUY') {
      assert.equal(fill.referencePrice, bar.open, 'entry reference must be the session open');
      assert.equal(fill.fillPrice, model.adversePrice(bar.open, 'BUY'), 'entry fill = open + slippage');
      assert.ok(fill.fillPrice > bar.open);
      checked++;
    }
    if (fill.kind === 'OPEN_SELL') {
      assert.equal(fill.referencePrice, bar.open);
      assert.equal(fill.fillPrice, model.adversePrice(bar.open, 'SELL'), 'exit fill = open - slippage');
      assert.ok(fill.fillPrice < bar.open);
      checked++;
    }
  }
  assert.ok(checked >= 2, 'expected at least one entry and one exit');
});
