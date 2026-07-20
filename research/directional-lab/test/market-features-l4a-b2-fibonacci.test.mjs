import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeAlternatedStreamStates,
  detectConfirmedPivots,
} from '../src/features/confirmedPivotFeaturesL4V1.mjs';
import { computeFibonacciFeatures } from '../src/features/fibonacciStructureFeaturesL4V1.mjs';
import { computeCongestionFeatures } from '../src/features/congestionFeaturesL4V1.mjs';
import {
  makeTechnicalCellsFromBars,
  makeVolumeBars,
} from './marketVolumeStructureL4SyntheticFixture.mjs';

function fixed(atoms) {
  return { atoms, scale: 12 };
}

function fibRows(bars) {
  return computeFibonacciFeatures(
    bars, computeAlternatedStreamStates(bars, detectConfirmedPivots(bars)),
  );
}

test('L4A-B2 Fibonacci stays unavailable until an opposite-type confirmed leg exists', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n];
  const rows = fibRows(makeVolumeBars(closes, { spread: 1n }));
  assert.deepEqual(rows[6].fibonacciDirection, {
    value: null, availability: 'NO_ACTIVE_FIBONACCI_LEG',
  });
  assert.deepEqual(rows[6].fibonacci500, {
    value: null, availability: 'NO_ACTIVE_FIBONACCI_LEG',
  });
});

test('L4A-B2 a SWING_HIGH to SWING_LOW leg is a BEARISH_RETRACEMENT with exact ratios', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 5n, 20n, 30n, 40n];
  const rows = fibRows(makeVolumeBars(closes, { spread: 1n }));
  assert.equal(rows[8].fibonacciDirection.availability, 'NO_ACTIVE_FIBONACCI_LEG');
  assert.deepEqual(rows[9].fibonacciDirection, {
    value: 'BEARISH_RETRACEMENT', availability: 'AVAILABLE',
  });
  // high=101, low=4, range=97; level(r)=4+(97*r); r=1/2 → 52.5
  assert.deepEqual(rows[9].fibonacci500, { value: fixed('52500000000000'), availability: 'AVAILABLE' });
  // r=618/1000 → 4 + 97*618/1000 = 4 + 59.946 = 63.946
  assert.deepEqual(rows[9].fibonacci618, { value: fixed('63946000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].fibonacci236, { value: fixed('26892000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].fibonacci382, { value: fixed('41054000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].fibonacci786, { value: fixed('80242000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].fibonacciStartSessionDate, { value: '2020-01-04', availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].fibonacciEndSessionDate, { value: '2020-01-07', availability: 'AVAILABLE' });
});

test('L4A-B2 a SWING_LOW to SWING_HIGH leg is a BULLISH_RETRACEMENT', () => {
  const lows = [50n, 40n, 30n, 10n, 30n, 40n, 50n, 60n, 90n, 60n, 50n, 40n];
  const highs = lows.map((low, index) => (index === 8 ? 100n : low + 5n));
  const closes = lows.map((low, index) => (index === 8 ? 95n : low + 2n));
  const rows = fibRows(makeVolumeBars(closes, { lows, highs }));
  const active = rows.find((row) => row.fibonacciDirection.value === 'BULLISH_RETRACEMENT');
  assert.ok(active);
  // high=100, low=10, range=90; level(0.5)=100-45=55
  assert.deepEqual(active.fibonacci500, { value: fixed('55000000000000'), availability: 'AVAILABLE' });
  // level(0.618)=100-55.62=44.38
  assert.deepEqual(active.fibonacci618, { value: fixed('44380000000000'), availability: 'AVAILABLE' });
});

test('L4A-B2 Fibonacci distances are close/level - 1 with HALF_EVEN', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 5n, 20n, 30n, 40n];
  const rows = fibRows(makeVolumeBars(closes, { spread: 1n }));
  // close=40, fib500=52.5 → 40/52.5 - 1 = -0.238095238095
  assert.deepEqual(rows[9].distanceToFibonacci500, {
    value: fixed('-238095238095'), availability: 'AVAILABLE',
  });
});

test('L4A-B2 congestion windows report INSUFFICIENT_HISTORY before their first complete window', () => {
  const closes = Array.from({ length: 25 }, () => 100n);
  const rows = computeCongestionFeatures(
    makeVolumeBars(closes, { spread: 1n }),
    makeTechnicalCellsFromBars(makeVolumeBars(closes, { spread: 1n })),
  );
  assert.deepEqual(rows[18].priceRange20Pct, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.equal(rows[19].priceRange20Pct.availability, 'AVAILABLE');
  assert.deepEqual(rows[19].priceRange60Pct, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});

test('L4A-B2 directionalEfficiency20 is zero on a flat path and DIVISION_BY_ZERO on a zero path sum', () => {
  const flat = Array.from({ length: 25 }, () => 100n);
  const bars = makeVolumeBars(flat, { spread: 0n });
  const rows = computeCongestionFeatures(bars, makeTechnicalCellsFromBars(bars));
  assert.deepEqual(rows[20].directionalEfficiency20, {
    value: null, availability: 'DIVISION_BY_ZERO',
  });
});

test('L4A-B2 isCongestion20 is descriptive and fires only under the closed dual threshold', () => {
  // Small sideways oscillation keeps efficiency low and range tight vs ATR.
  const closes = [];
  for (let index = 0; index < 40; index += 1) {
    closes.push(100n + BigInt(index % 2));
  }
  const bars = makeVolumeBars(closes, { spread: 1n });
  const rows = computeCongestionFeatures(bars, makeTechnicalCellsFromBars(bars));
  assert.equal(rows[30].isCongestion20.availability, 'AVAILABLE');
  assert.equal(typeof rows[30].isCongestion20.value, 'boolean');
  assert.equal(rows[30].isCongestion20.value, true);
});

test('L4A-B2 a strong directional move refuses the congestion boolean', () => {
  const closes = Array.from({ length: 40 }, (_, index) => 100n + BigInt(index) * 5n);
  const bars = makeVolumeBars(closes, { spread: 1n });
  const rows = computeCongestionFeatures(bars, makeTechnicalCellsFromBars(bars));
  assert.deepEqual(rows[30].isCongestion20, { value: false, availability: 'AVAILABLE' });
});

test('L4A-B2 rangeCompression20Vs60 divides the raw ranges exactly', () => {
  const closes = Array.from({ length: 70 }, () => 100n);
  const highs = closes.map((_, index) => (index < 50 ? 110n : 105n));
  const lows = closes.map((_, index) => (index < 50 ? 90n : 95n));
  const bars = makeVolumeBars(closes, { highs, lows });
  const rows = computeCongestionFeatures(bars, makeTechnicalCellsFromBars(bars));
  // last 20 range = 10, last 60 range = 20 → 0.5
  assert.deepEqual(rows[69].rangeCompression20Vs60, {
    value: fixed('500000000000'), availability: 'AVAILABLE',
  });
});
