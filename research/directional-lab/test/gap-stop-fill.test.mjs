import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';
import { trendAtrBaseline } from '../src/strategy/trendAtrBaseline.mjs';
import { resolveLongStopFill } from '../src/execution/stopFillModel.mjs';
import { createSlippageModel } from '../src/execution/slippageModel.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.3: stop=100, next open=90 -> the fill can NEVER be 100;
 * it must be ~90 minus slippage for a long.
 */
test('unit: gap through the stop fills at the open minus gap slippage, never at the stop', () => {
  const slippageModel = createSlippageModel({ bps: 5, minPerShare: 0.01, gapMultiplier: 1.5 });
  const fill = resolveLongStopFill({ stopLevel: 100, open: 90, low: 88, slippageModel });
  assert.equal(fill.kind, 'GAP_STOP');
  assert.equal(fill.referencePrice, 90);
  assert.ok(fill.fillPrice < 90, `fill ${fill.fillPrice} must be below the gap open`);
  assert.ok(Math.abs(fill.fillPrice - (90 - Math.max(90 * 0.0005, 0.01) * 1.5)) < 1e-9);
});

test('unit: intraday touch fills at the stop level minus normal slippage', () => {
  const slippageModel = createSlippageModel({ bps: 5, minPerShare: 0.01, gapMultiplier: 1.5 });
  const fill = resolveLongStopFill({ stopLevel: 100, open: 103, low: 99, slippageModel });
  assert.equal(fill.kind, 'STOP');
  assert.equal(fill.referencePrice, 100);
  assert.ok(fill.fillPrice < 100);
});

test('unit: no fill when the session never reaches the stop', () => {
  const slippageModel = createSlippageModel();
  assert.equal(resolveLongStopFill({ stopLevel: 100, open: 105, low: 101, slippageModel }), null);
});

test('engine: the gap fixture produces a GAP_STOP fill at the gapped open, far below the stop', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'gap-stop-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const result = runBacktest({ symbol: 'GAP', series, priceBasis: 'SPLIT_ADJUSTED', strategy: trendAtrBaseline });
  const gapFill = result.fills.find((f) => f.kind === 'GAP_STOP');
  assert.ok(gapFill, `expected a GAP_STOP fill, got kinds: ${result.fills.map((f) => f.kind)}`);
  const stopNote = gapFill.notes.find((n) => n.startsWith('stop level '));
  const stopLevel = Number(stopNote.replace('stop level ', ''));
  assert.ok(Number.isFinite(stopLevel));
  assert.ok(gapFill.fillPrice < stopLevel - 5, `fill ${gapFill.fillPrice} must be well below stop ${stopLevel} after a -30% gap`);
  assert.ok(gapFill.fillPrice < gapFill.referencePrice, 'gap fill must include adverse slippage below the open');
  // The stop was decided at the previous close, never the same session.
  assert.ok(gapFill.decisionDate < gapFill.fillDate);
});

test('engine: the B3 stop never triggers on its own decision session', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'gap-stop-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const result = runBacktest({ symbol: 'GAP', series, priceBasis: 'SPLIT_ADJUSTED', strategy: trendAtrBaseline });
  for (const fill of result.fills.filter((f) => f.kind === 'STOP' || f.kind === 'GAP_STOP')) {
    assert.ok(fill.fillDate > fill.decisionDate, 'stop active only from the session after its decision');
  }
});
