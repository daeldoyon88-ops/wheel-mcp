import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { computeFeatureSnapshots } from '../src/features/featureEngine.mjs';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.4: mutate every candle AFTER t; features at [0..t] must
 * be strictly identical.
 */
test('future mutation does not change any feature at or before t', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const T = 80;

  const baseline = computeFeatureSnapshots({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED' });

  const mutated = series.map((bar, i) => (i <= T ? bar : {
    ...bar,
    open: bar.open * 7 + 3,
    high: bar.high * 9 + 5,
    low: bar.low * 0.1,
    close: bar.close * 5 + 11,
    volume: bar.volume === null ? null : bar.volume * 3,
  }));
  const after = computeFeatureSnapshots({ symbol: 'TEST', series: mutated, priceBasis: 'SPLIT_ADJUSTED' });

  for (let i = 0; i <= T; i++) {
    assert.deepEqual(after[i], baseline[i], `snapshot at index ${i} changed after mutating bars > ${T}`);
  }
  // Sanity: the mutation must actually change later snapshots.
  assert.notDeepEqual(after[T + 5], baseline[T + 5]);
});

test('future mutation of the BENCHMARK does not change relative-strength features at or before t', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'multi-symbol-bars.json'), 'utf8'));
  const opts = (s) => ({ symbol: s, source: 'fixture', ohlcBasis: 'SPLIT_ADJUSTED' });
  const tick = selectPriceBasis(normalizeDailyBars(fixture.symbols.TICK, opts('TICK')), 'SPLIT_ADJUSTED').series;
  const qqq = selectPriceBasis(normalizeDailyBars(fixture.symbols.QQQ, opts('QQQ')), 'SPLIT_ADJUSTED').series;
  const T = 90;

  const baseline = computeFeatureSnapshots({ symbol: 'TICK', series: tick, priceBasis: 'SPLIT_ADJUSTED', benchmarks: { QQQ: qqq } });
  const qqqMutated = qqq.map((bar) => (bar.sessionDate <= tick[T].sessionDate ? bar : { ...bar, close: bar.close * 3 }));
  const after = computeFeatureSnapshots({ symbol: 'TICK', series: tick, priceBasis: 'SPLIT_ADJUSTED', benchmarks: { QQQ: qqqMutated } });

  for (let i = 0; i <= T; i++) {
    assert.deepEqual(after[i], baseline[i], `RS snapshot at index ${i} changed after mutating future benchmark bars`);
  }
});
