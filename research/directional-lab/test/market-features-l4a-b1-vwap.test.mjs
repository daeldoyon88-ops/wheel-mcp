import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeEodVolumeWeightedPriceFeatures } from '../src/features/eodVolumeWeightedPriceFeaturesL4V1.mjs';
import {
  computeAlternatedStreamStates,
  detectConfirmedPivots,
} from '../src/features/confirmedPivotFeaturesL4V1.mjs';
import { makeVolumeBars } from './marketVolumeStructureL4SyntheticFixture.mjs';
import { MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1 } from '../src/features/marketVolumeStructureRuntimePolicyL4V1.mjs';

function vwapRows(bars) {
  const pivots = detectConfirmedPivots(bars, MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1.pivots);
  const states = computeAlternatedStreamStates(
    bars, pivots, MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1.pivots,
  );
  return computeEodVolumeWeightedPriceFeatures(
    bars, states, MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1.eodVolumeWeightedPrices,
  );
}

function fixed(atoms) {
  return { atoms, scale: 12 };
}

test('L4A-B1 EOD VWAP20 weights the daily typical price by exact volume', () => {
  const closes = [...Array.from({ length: 10 }, () => 10n), ...Array.from({ length: 10 }, () => 20n)];
  const rows = vwapRows(makeVolumeBars(closes, { spread: 0n, volumes: closes.map(() => 1n) }));
  assert.deepEqual(rows[18].eodVolumeWeightedAveragePrice20, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[19].eodVolumeWeightedAveragePrice20, { value: fixed('15000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[19].distanceToEodVwap20, { value: fixed('333333333333'), availability: 'AVAILABLE' });
});

test('L4A-B1 EOD VWAP60 is available exactly at the sixtieth observed session', () => {
  const closes = Array.from({ length: 61 }, () => 10n);
  const rows = vwapRows(makeVolumeBars(closes, { spread: 0n, volumes: closes.map(() => 2n) }));
  assert.deepEqual(rows[58].eodVolumeWeightedAveragePrice60, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[59].eodVolumeWeightedAveragePrice60, { value: fixed('10000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[59].distanceToEodVwap60, { value: fixed('0'), availability: 'AVAILABLE' });
});

test('L4A-B1 EOD VWAP weights unequal volumes exactly', () => {
  const closes = Array.from({ length: 20 }, (_, index) => (index === 19 ? 40n : 10n));
  const volumes = closes.map((_, index) => (index === 19 ? 3n : 1n));
  const rows = vwapRows(makeVolumeBars(closes, { spread: 0n, volumes }));
  assert.deepEqual(rows[19].eodVolumeWeightedAveragePrice20, {
    value: fixed('14090909090909'), availability: 'AVAILABLE',
  });
});

test('L4A-B1 zero total volume in the VWAP window is ZERO_TOTAL_VOLUME, a null volume is MISSING_INPUT', () => {
  const closes = Array.from({ length: 20 }, () => 10n);
  const zero = vwapRows(makeVolumeBars(closes, { spread: 0n, volumes: closes.map(() => 0n) }));
  assert.deepEqual(zero[19].eodVolumeWeightedAveragePrice20, { value: null, availability: 'ZERO_TOTAL_VOLUME' });
  const withNull = vwapRows(makeVolumeBars(closes, {
    spread: 0n, volumes: closes.map((_, index) => (index === 4 ? null : 1n)),
  }));
  assert.deepEqual(withNull[19].eodVolumeWeightedAveragePrice20, { value: null, availability: 'MISSING_INPUT' });
});

test('L4A-B1 the anchored EOD VWAP from a swing low starts at the pivot session and activates at confirmation', () => {
  const closes = [20n, 18n, 16n, 10n, 16n, 18n, 20n, 20n];
  const bars = makeVolumeBars(closes, { spread: 1n, volumes: closes.map(() => 1n) });
  const rows = vwapRows(bars);
  assert.deepEqual(rows[5].anchoredEodVwapFromLastConfirmedSwingLow, { value: null, availability: 'NO_CONFIRMED_PIVOT' });
  assert.deepEqual(rows[6].anchoredEodVwapFromLastConfirmedSwingLow, { value: fixed('16000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[6].distanceToAnchoredEodVwapFromSwingLow, { value: fixed('250000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 the anchored EOD VWAP from a swing high mirrors the swing-low anchoring', () => {
  const closes = [10n, 12n, 14n, 20n, 14n, 12n, 10n, 10n];
  const bars = makeVolumeBars(closes, { spread: 1n, volumes: closes.map(() => 1n) });
  const rows = vwapRows(bars);
  assert.deepEqual(rows[5].anchoredEodVwapFromLastConfirmedSwingHigh, { value: null, availability: 'NO_CONFIRMED_PIVOT' });
  assert.deepEqual(rows[6].anchoredEodVwapFromLastConfirmedSwingHigh, { value: fixed('14000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 a newer confirmed pivot of the same type re-anchors the accumulated VWAP', () => {
  const closes = [20n, 18n, 16n, 10n, 16n, 18n, 20n, 18n, 16n, 8n, 16n, 18n, 20n, 20n];
  const bars = makeVolumeBars(closes, { spread: 1n, volumes: closes.map(() => 1n) });
  const rows = vwapRows(bars);
  assert.deepEqual(rows[11].anchoredEodVwapFromLastConfirmedSwingLow, {
    value: fixed('15555555555556'), availability: 'AVAILABLE',
  });
  assert.deepEqual(rows[12].anchoredEodVwapFromLastConfirmedSwingLow, {
    value: fixed('15500000000000'), availability: 'AVAILABLE',
  });
});

test('L4A-B1 anchored EOD VWAP reports ZERO_TOTAL_VOLUME over an all-zero anchor window', () => {
  const closes = [20n, 18n, 16n, 10n, 16n, 18n, 20n, 20n];
  const bars = makeVolumeBars(closes, { spread: 1n, volumes: closes.map(() => 0n) });
  const rows = vwapRows(bars);
  assert.deepEqual(rows[6].anchoredEodVwapFromLastConfirmedSwingLow, { value: null, availability: 'ZERO_TOTAL_VOLUME' });
});
