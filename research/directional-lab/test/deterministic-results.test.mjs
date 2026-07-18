import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';
import { trendAtrBaseline } from '../src/strategy/trendAtrBaseline.mjs';
import { ma50Baseline } from '../src/strategy/ma50Baseline.mjs';
import { stableStringify, stableHash } from '../src/contracts/backtestResultV1.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.10: two identical runs produce the same result hash.
 */
test('two identical runs hash identically (full determinism, no wall clock)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const a = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: trendAtrBaseline });
  const b = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: trendAtrBaseline });
  assert.equal(a.resultHash, b.resultHash);
  assert.equal(stableStringify(a), stableStringify(b));
});

test('changing any input changes the hash (hash actually binds the result)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const a = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: ma50Baseline });
  const b = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: ma50Baseline, slippage: { bps: 6 } });
  assert.notEqual(a.resultHash, b.resultHash);
});

test('stable serialization sorts keys and is insensitive to insertion order', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(stableHash({ x: [1, 2, 3] }), stableHash({ x: [1, 2, 3] }));
  assert.notEqual(stableHash({ x: [1, 2, 3] }), stableHash({ x: [3, 2, 1] }));
});

test('NaN and Infinity can never be serialized into a result', () => {
  assert.throws(() => stableStringify({ v: NaN }), /Non-finite/);
  assert.throws(() => stableStringify({ v: Infinity }), /Non-finite/);
  assert.throws(() => stableStringify({ nested: [{ v: -Infinity }] }), /Non-finite/);
});

test('a full serialized result contains no NaN/Infinity anywhere', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const result = runBacktest({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED', strategy: trendAtrBaseline });
  const text = stableStringify(result); // throws if any non-finite number is present
  assert.ok(!text.includes('NaN'));
});
