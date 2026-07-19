import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  computeMomentumFeatures,
  computeRsi14Series,
} from '../src/features/momentumFeaturesL4V1.mjs';
import { makeInternalBars } from './marketFeaturesL4SyntheticPipeline.mjs';

const rising = (length) => Array.from({ length }, (_, index) => 100n + BigInt(index));

test('L4A-A3 RSI14 seeds after fourteen variations and reaches 100 on an all-gain series', () => {
  const rsi = computeRsi14Series(makeInternalBars(rising(15)));
  assert.equal(rsi[13].availability, 'INSUFFICIENT_HISTORY');
  assert.equal(rsi[14].value.atoms, 100000000000000000000000000n);
});

test('L4A-A3 RSI14 reaches zero on an all-loss series', () => {
  const closes = Array.from({ length: 15 }, (_, index) => 100n - BigInt(index));
  const result = computeMomentumFeatures(makeInternalBars(closes));
  assert.equal(result[14].rsi14.value.atoms, '0');
});

test('L4A-A3 RSI14 is exactly 50 when average gain and loss are both zero', () => {
  const result = computeMomentumFeatures(makeInternalBars(Array(15).fill(100n)));
  assert.equal(result[14].rsi14.value.atoms, '50000000000000');
});

test('L4A-A3 MACD line waits for the complete SMA26-seeded EMA', () => {
  const result = computeMomentumFeatures(makeInternalBars(rising(26)));
  assert.equal(result[24].macdLine.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[25].macdLine.availability, 'AVAILABLE');
});

test('L4A-A3 MACD signal waits for nine admissible MACD values', () => {
  const result = computeMomentumFeatures(makeInternalBars(rising(34)));
  assert.equal(result[32].macdSignal.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[33].macdSignal.availability, 'AVAILABLE');
});

test('L4A-A3 MACD line, signal and histogram are zero on a constant series', () => {
  const row = computeMomentumFeatures(makeInternalBars(Array(34).fill(100n)))[33];
  assert.equal(row.macdLine.value.atoms, '0');
  assert.equal(row.macdSignal.value.atoms, '0');
  assert.equal(row.macdHistogram.value.atoms, '0');
});

test('L4A-A3 stochastic K14 starts only with a complete 14-session range', () => {
  const result = computeMomentumFeatures(makeInternalBars(rising(14)));
  assert.equal(result[12].stochasticK14.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[13].stochasticK14.availability, 'AVAILABLE');
});

test('L4A-A3 stochastic flat range is explicitly defined as 50', () => {
  const values = Array(14).fill(100n);
  const result = computeMomentumFeatures(makeInternalBars(values, {
    highs: values, lows: values, spread: 0n,
  }));
  assert.equal(result[13].stochasticK14.value.atoms, '50000000000000');
});

test('L4A-A3 stochastic D3 averages three admissible K values', () => {
  const result = computeMomentumFeatures(makeInternalBars(rising(16)));
  assert.equal(result[14].stochasticD3.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[15].stochasticD3.availability, 'AVAILABLE');
});

test('L4A-A3 Stoch RSI uses raw14 then SMA3 K then SMA3 D in that order', () => {
  const result = computeMomentumFeatures(makeInternalBars(Array(32).fill(100n)));
  assert.equal(result[27].stochRsiRaw.value.atoms, '50000000000000');
  assert.equal(result[28].stochRsiK.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[29].stochRsiK.value.atoms, '50000000000000');
  assert.equal(result[31].stochRsiD.value.atoms, '50000000000000');
});

test('L4A-A3 CCI20 flat mean deviation is explicitly zero', () => {
  const result = computeMomentumFeatures(makeInternalBars(Array(20).fill(100n)));
  assert.equal(result[18].cci20.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[19].cci20.value.atoms, '0');
});

for (const period of [5, 10, 20]) {
  test(`L4A-A3 ROC${period} equals the corresponding simple return`, () => {
    const result = computeMomentumFeatures(makeInternalBars(rising(period + 1)));
    assert.equal(
      result[period][`roc${period}`].value.atoms,
      (BigInt(period) * 10000000000n).toString(),
    );
  });
}

test('L4A-A3 historical bytes are invariant to appended future momentum', () => {
  const prefix = rising(80);
  const full = [...prefix, ...Array.from({ length: 200 }, (_, index) => index % 2 ? 500n : 5n)];
  const a = computeMomentumFeatures(makeInternalBars(prefix));
  const b = computeMomentumFeatures(makeInternalBars(full)).slice(0, prefix.length);
  assert.ok(canonicalJsonBytes(a).equals(canonicalJsonBytes(b)));
});
