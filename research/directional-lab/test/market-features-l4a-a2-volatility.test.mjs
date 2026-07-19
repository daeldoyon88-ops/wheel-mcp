import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  computeAtr14Series,
  computeTrueRangeSeries,
  computeVolatilityFeatures,
  realizedVolatilityAt,
} from '../src/features/volatilityFeaturesL4V1.mjs';
import { makeInternalBars } from './marketFeaturesL4SyntheticPipeline.mjs';

test('L4A-A2 first-session true range is high minus low', () => {
  const bars = makeInternalBars([100n]);
  const result = computeVolatilityFeatures(bars)[0];
  assert.deepEqual(result.trueRange, {
    value: { atoms: '2000000000000', scale: 12 }, availability: 'AVAILABLE',
  });
});

test('L4A-A2 true range takes the maximum of range and both previous-close gaps', () => {
  const bars = makeInternalBars([100n, 105n], { highs: [101n, 110n], lows: [99n, 104n] });
  const tr = computeTrueRangeSeries(bars);
  assert.equal(tr[1].value.atoms, 10000000000000000000000000n);
});

test('L4A-A2 ATR14 is absent before its complete 14-TR seed', () => {
  const result = computeVolatilityFeatures(makeInternalBars(Array(13).fill(100n)));
  assert.equal(result[12].atr14.availability, 'INSUFFICIENT_HISTORY');
});

test('L4A-A2 ATR14 seed is the simple mean of the first 14 true ranges', () => {
  const bars = makeInternalBars(Array(14).fill(100n));
  const atr = computeAtr14Series(computeTrueRangeSeries(bars));
  assert.equal(atr[13].value.atoms, 2000000000000000000000000n);
});

test('L4A-A2 ATR14 uses the exact Wilder recurrence after the seed', () => {
  const closes = Array(15).fill(100n);
  const highs = [...Array(14).fill(101n), 115n];
  const lows = [...Array(14).fill(99n), 99n];
  const bars = makeInternalBars(closes, { highs, lows });
  const result = computeVolatilityFeatures(bars);
  assert.equal(result[14].atr14.value.atoms, '3000000000000');
});

test('L4A-A2 ATR percent is ATR divided by close', () => {
  const result = computeVolatilityFeatures(makeInternalBars(Array(14).fill(100n)));
  assert.equal(result[13].atr14Pct.value.atoms, '20000000000');
});

test('L4A-A2 intraday range percent and exact opening gap are deterministic', () => {
  const bars = makeInternalBars([100n, 100n], { opens: [100n, 110n] });
  const result = computeVolatilityFeatures(bars);
  assert.equal(result[1].intradayRangePct.value.atoms, '20000000000');
  assert.equal(result[1].gapOpenPct.value.atoms, '100000000000');
});

test('L4A-A2 first opening gap keeps explicit insufficient history', () => {
  const result = computeVolatilityFeatures(makeInternalBars([100n]))[0];
  assert.deepEqual(result.gapOpenPct, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});

test('L4A-A2 close-location value rejects a flat high-low range', () => {
  const result = computeVolatilityFeatures(makeInternalBars([100n], {
    highs: [100n], lows: [100n], spread: 0n,
  }))[0];
  assert.deepEqual(result.closeLocationValue, { value: null, availability: 'FLAT_RANGE' });
});

test('L4A-A2 centered close has a zero close-location value', () => {
  const result = computeVolatilityFeatures(makeInternalBars([100n]))[0];
  assert.equal(result.closeLocationValue.value.atoms, '0');
});

for (const period of [5, 10, 20, 60]) {
  test(`L4A-A2 realized volatility ${period} uses ${period} observed simple returns`, () => {
    const bars = makeInternalBars(Array(period + 1).fill(100n));
    const cell = realizedVolatilityAt(bars, period, period);
    assert.equal(cell.availability, 'AVAILABLE');
    assert.equal(cell.value.atoms, 0n);
    const features = computeVolatilityFeatures(bars);
    assert.equal(features[period][`realizedVolatility${period}`].value.atoms, '0');
  });
}

test('L4A-A2 realized volatility annualization is positive on non-constant returns', () => {
  const bars = makeInternalBars([100n, 110n, 99n, 108n, 97n, 107n]);
  const cell = realizedVolatilityAt(bars, 5, 5);
  assert.equal(cell.availability, 'AVAILABLE');
  assert.ok(cell.value.atoms > 0n);
});

test('L4A-A2 volatility acceleration refuses a zero 60-session denominator', () => {
  const result = computeVolatilityFeatures(makeInternalBars(Array(61).fill(100n)))[60];
  assert.deepEqual(result.volatilityAcceleration20vs60, {
    value: null, availability: 'DIVISION_BY_ZERO',
  });
});

test('L4A-A2 prefix output is unchanged by future volatility', () => {
  const prefix = Array(70).fill(100n);
  const future = Array.from({ length: 100 }, (_, index) => index % 2 === 0 ? 1n : 1000n);
  const a = computeVolatilityFeatures(makeInternalBars(prefix));
  const b = computeVolatilityFeatures(makeInternalBars([...prefix, ...future])).slice(0, prefix.length);
  assert.ok(canonicalJsonBytes(a).equals(canonicalJsonBytes(b)));
});
