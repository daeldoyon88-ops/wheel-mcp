import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  computeRelativeStrengthFeatures,
  computeTrendFeatures,
} from '../src/features/trendRelativeStrengthFeaturesL4V1.mjs';
import { makeInternalBars } from './marketFeaturesL4SyntheticPipeline.mjs';

const rising = (length, start = 100n) => Array.from({ length }, (_, index) => start + BigInt(index));

for (const period of [20, 50, 200]) {
  test(`L4A-A4 SMA${period} requires and averages exactly ${period} closes`, () => {
    const result = computeTrendFeatures(makeInternalBars(Array(period).fill(100n)));
    assert.equal(result[period - 2][`sma${period}`].availability, 'INSUFFICIENT_HISTORY');
    assert.equal(result[period - 1][`sma${period}`].value.atoms, '100000000000000');
  });
}

for (const period of [8, 34, 50, 200]) {
  test(`L4A-A4 EMA${period} is seeded only by its full SMA`, () => {
    const result = computeTrendFeatures(makeInternalBars(Array(period).fill(100n)));
    assert.equal(result[period - 2][`ema${period}`].availability, 'INSUFFICIENT_HISTORY');
    assert.equal(result[period - 1][`ema${period}`].value.atoms, '100000000000000');
  });
}

test('L4A-A4 normalized distances are zero when close equals every available average', () => {
  const row = computeTrendFeatures(makeInternalBars(Array(200).fill(100n)))[199];
  for (const name of [
    'distanceToSma20', 'distanceToSma50', 'distanceToSma200',
    'distanceToEma8', 'distanceToEma34', 'distanceToEma50', 'distanceToEma200',
  ]) assert.equal(row[name].value.atoms, '0');
});

test('L4A-A4 five-session slopes require both current and lagged averages', () => {
  const result = computeTrendFeatures(makeInternalBars(Array(25).fill(100n)));
  assert.equal(result[23].sma20Change5.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[24].sma20Change5.value.atoms, '0');
});

test('L4A-A4 trend booleans are closed and null before their components exist', () => {
  const result = computeTrendFeatures(makeInternalBars(rising(40)));
  assert.equal(result[0].closeAboveEma8.value, null);
  assert.equal(result[0].closeAboveEma8.availability, 'INSUFFICIENT_HISTORY');
  assert.equal(result[39].closeAboveEma8.value, true);
  assert.equal(result[39].ema8AboveEma34.value, true);
});

test('L4A-A4 flat ADX has zero +DI, -DI, DX-derived ADX', () => {
  const values = Array(28).fill(100n);
  const row = computeTrendFeatures(makeInternalBars(values, {
    highs: values, lows: values, spread: 0n,
  }))[27];
  assert.equal(row.plusDi14.value.atoms, '0');
  assert.equal(row.minusDi14.value.atoms, '0');
  assert.equal(row.adx14.value.atoms, '0');
});

test('L4A-A4 directional movement and ADX reach 100 on a monotonic series', () => {
  const row = computeTrendFeatures(makeInternalBars(rising(28)))[27];
  assert.equal(row.plusDi14.availability, 'AVAILABLE');
  assert.equal(row.minusDi14.value.atoms, '0');
  assert.equal(row.adx14.value.atoms, '100000000000000');
});

test('L4A-A4 MARKET relative strength is neutral against an identical benchmark', () => {
  const subject = makeInternalBars(rising(61));
  const result = computeRelativeStrengthFeatures(subject, { MARKET: subject }).MARKET[60];
  assert.equal(result.relativePriceRatio.value.atoms, '1000000000000');
  assert.equal(result.relativeReturn5.value.atoms, '0');
  assert.equal(result.relativeReturn20.value.atoms, '0');
  assert.equal(result.relativeReturn60.value.atoms, '0');
  assert.equal(result.relativeRatioChange20.value.atoms, '0');
  assert.equal(result.relativeRatioChange60.value.atoms, '0');
});

test('L4A-A4 SECTOR relative price ratio uses exact subject-date alignment', () => {
  const subject = makeInternalBars(Array(2).fill(100n));
  const sector = makeInternalBars(Array(2).fill(50n));
  const row = computeRelativeStrengthFeatures(subject, { SECTOR: sector }).SECTOR[1];
  assert.equal(row.relativePriceRatio.value.atoms, '2000000000000');
});

test('L4A-A4 unconfigured UNDERLYING stays null with BENCHMARK_NOT_CONFIGURED', () => {
  const subject = makeInternalBars([100n]);
  const row = computeRelativeStrengthFeatures(subject, {}).UNDERLYING[0];
  assert.deepEqual(row.relativePriceRatio, {
    value: null, availability: 'BENCHMARK_NOT_CONFIGURED',
  });
});

test('L4A-A4 missing benchmark session never forward-fills or finds a nearest price', () => {
  const subject = makeInternalBars(rising(6));
  const benchmark = makeInternalBars(rising(6));
  benchmark.splice(5, 1);
  const row = computeRelativeStrengthFeatures(subject, { MARKET: benchmark }).MARKET[5];
  assert.equal(row.relativePriceRatio.availability, 'BENCHMARK_SESSION_MISSING');
  assert.equal(row.relativeReturn5.availability, 'BENCHMARK_SESSION_MISSING');
});

test('L4A-A4 benchmark prefix invariance holds for both subject and benchmark futures', () => {
  const subjectPrefix = makeInternalBars(rising(70));
  const benchmarkPrefix = makeInternalBars(rising(70, 200n));
  const subjectFull = makeInternalBars([...rising(70), ...rising(100, 1000n)]);
  const benchmarkFull = makeInternalBars([...rising(70, 200n), ...rising(100, 2000n)]);
  const a = computeRelativeStrengthFeatures(subjectPrefix, { MARKET: benchmarkPrefix }).MARKET;
  const b = computeRelativeStrengthFeatures(subjectFull, { MARKET: benchmarkFull }).MARKET.slice(0, 70);
  assert.ok(canonicalJsonBytes(a).equals(canonicalJsonBytes(b)));
});
