import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeAlternatedStreamStates,
  computePivotFamilyRows,
  detectConfirmedPivots,
} from '../src/features/confirmedPivotFeaturesL4V1.mjs';
import { computeSupportResistanceFeatures } from '../src/features/supportResistanceFeaturesL4V1.mjs';
import {
  makeTechnicalCellsFromBars,
  makeVolumeBars,
} from './marketVolumeStructureL4SyntheticFixture.mjs';

function fixed(atoms) {
  return { atoms, scale: 12 };
}

function supportResistanceRows(bars) {
  return computeSupportResistanceFeatures(
    bars, detectConfirmedPivots(bars), makeTechnicalCellsFromBars(bars),
  );
}

test('L4A-B2 a strict swing high requires strictly greater highs on both three-session sides', () => {
  const closes = [1n, 2n, 3n, 10n, 3n, 2n, 1n].map((value) => value * 10n);
  const bars = makeVolumeBars(closes, { spread: 1n });
  const pivots = detectConfirmedPivots(bars);
  const highs = pivots.filter((pivot) => pivot.pivotType === 'SWING_HIGH');
  assert.equal(highs.length, 1);
  assert.equal(highs[0].pivotIndex, 3);
  assert.equal(highs[0].confirmedIndex, 6);
  assert.equal(highs[0].pivotPrice.atoms, 101n * 10n ** 24n);
});

test('L4A-B2 a strict swing low mirrors the swing high rule', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const pivots = detectConfirmedPivots(bars);
  const lows = pivots.filter((pivot) => pivot.pivotType === 'SWING_LOW');
  assert.equal(lows.length, 1);
  assert.equal(lows[0].pivotIndex, 3);
  assert.equal(lows[0].pivotPrice.atoms, 19n * 10n ** 24n);
});

test('L4A-B2 plateaus never produce a pivot', () => {
  const highs = [10n, 20n, 100n, 100n, 20n, 10n, 9n, 8n, 7n];
  const closes = highs.map((high) => high - 1n);
  const bars = makeVolumeBars(closes, {
    highs, lows: closes.map((_, index) => 200n - BigInt(index)),
  });
  const pivots = detectConfirmedPivots(bars);
  assert.equal(pivots.filter((pivot) => pivot.pivotType === 'SWING_HIGH').length, 0);
});

test('L4A-B2 a candidate top beaten by a later bar inside the radius is never confirmed', () => {
  const highs = [50n, 60n, 70n, 100n, 80n, 120n, 90n, 80n, 70n];
  const closes = highs.map((high) => high - 10n);
  const bars = makeVolumeBars(closes, {
    highs, lows: highs.map((_, index) => 300n - BigInt(index)),
  });
  const pivots = detectConfirmedPivots(bars);
  const highPivots = pivots.filter((pivot) => pivot.pivotType === 'SWING_HIGH');
  assert.equal(highPivots.length, 1);
  assert.equal(highPivots[0].pivotIndex, 5);
  assert.equal(highPivots[0].confirmedIndex, 8);
});

test('L4A-B2 the pivot family stays NO_CONFIRMED_PIVOT until the confirmation row', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 10n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const rows = computePivotFamilyRows(computeAlternatedStreamStates(bars, detectConfirmedPivots(bars)));
  assert.deepEqual(rows[5].lastConfirmedSwingHighPrice, { value: null, availability: 'NO_CONFIRMED_PIVOT' });
  assert.deepEqual(rows[6].lastConfirmedSwingHighPrice, { value: fixed('101000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[6].lastConfirmedSwingHighPivotSessionDate, { value: '2020-01-04', availability: 'AVAILABLE' });
  assert.deepEqual(rows[6].lastConfirmedSwingHighConfirmedAtSessionDate, { value: '2020-01-07', availability: 'AVAILABLE' });
  assert.deepEqual(rows[6].lastConfirmedSwingHighAgeSessions, { value: 3, availability: 'AVAILABLE' });
  assert.deepEqual(rows[7].lastConfirmedSwingHighAgeSessions, { value: 4, availability: 'AVAILABLE' });
});

test('L4A-B2 two consecutive same-type pivots keep the extreme in the alternated stream', () => {
  const highs = [10n, 20n, 30n, 100n, 30n, 20n, 30n, 120n, 30n, 20n, 10n];
  const closes = highs.map((high) => high - 5n);
  const bars = makeVolumeBars(closes, {
    highs, lows: highs.map((_, index) => 300n - BigInt(index)),
  });
  const states = computeAlternatedStreamStates(bars, detectConfirmedPivots(bars));
  assert.equal(states[6].lastSwingHigh.pivotIndex, 3);
  assert.equal(states[10].lastSwingHigh.pivotIndex, 7);
  assert.equal(states[10].lastSwingHigh.pivotPrice.atoms, 120n * 10n ** 24n);
});

test('L4A-B2 an exact same-type price tie keeps the most recently confirmed pivot', () => {
  const highs = [10n, 20n, 30n, 100n, 30n, 20n, 30n, 100n, 30n, 20n, 10n];
  const closes = highs.map((high) => high - 5n);
  const bars = makeVolumeBars(closes, {
    highs, lows: highs.map((_, index) => 300n - BigInt(index)),
  });
  const states = computeAlternatedStreamStates(bars, detectConfirmedPivots(bars));
  assert.equal(states[10].lastSwingHigh.pivotIndex, 7);
});

test('L4A-B2 opposite-type pivots alternate and expose an active leg', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 5n, 20n, 30n, 40n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const states = computeAlternatedStreamStates(bars, detectConfirmedPivots(bars));
  assert.equal(states[8].leg, null);
  assert.equal(states[9].leg.start.pivotType, 'SWING_HIGH');
  assert.equal(states[9].leg.end.pivotType, 'SWING_LOW');
  assert.equal(states[9].leg.end.pivotIndex, 6);
});

test('L4A-B2 the nearest support is the highest confirmed swing-low price at or below the close', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n, 60n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[5].nearestSupportPrice, { value: null, availability: 'NO_SUPPORT_LEVEL' });
  assert.deepEqual(rows[6].nearestSupportPrice, { value: fixed('19000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[7].nearestSupportPivotSessionDate, { value: '2020-01-04', availability: 'AVAILABLE' });
  assert.deepEqual(rows[7].nearestSupportConfirmedAtSessionDate, { value: '2020-01-07', availability: 'AVAILABLE' });
  assert.deepEqual(rows[7].nearestSupportAgeSessions, { value: 4, availability: 'AVAILABLE' });
});

test('L4A-B2 the nearest resistance is the lowest confirmed swing-high price at or above the close', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 40n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[5].nearestResistancePrice, { value: null, availability: 'NO_RESISTANCE_LEVEL' });
  assert.deepEqual(rows[6].nearestResistancePrice, { value: fixed('101000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[7].nearestResistanceAgeSessions, { value: 4, availability: 'AVAILABLE' });
});

test('L4A-B2 support and resistance distances follow the closed ratio definitions', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n, 40n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[7].distanceToNearestSupport, {
    value: fixed('1105263157895'), availability: 'AVAILABLE',
  });
});

test('L4A-B2 a close below every confirmed pivot low reports NO_SUPPORT_LEVEL', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n, 10n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[7].nearestSupportPrice, { value: null, availability: 'NO_SUPPORT_LEVEL' });
  assert.deepEqual(rows[7].supportPenetrationPct, { value: null, availability: 'NO_SUPPORT_LEVEL' });
});

test('L4A-B2 a close above every confirmed pivot high reports NO_RESISTANCE_LEVEL', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 200n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[7].nearestResistancePrice, { value: null, availability: 'NO_RESISTANCE_LEVEL' });
});

test('L4A-B2 level touches intersect the tolerance zone and count only the last 120 sessions', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n, 60n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[7].nearestSupportTouchCount120, { value: 1, availability: 'AVAILABLE' });
  assert.deepEqual(rows[7].nearestSupportLastTouchSessionsAgo, { value: 4, availability: 'AVAILABLE' });
});

test('L4A-B2 a level whose zone was never revisited inside the touch window is NO_LEVEL_TOUCH', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n];
  for (let index = 0; index < 125; index += 1) closes.push(100n);
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  const last = rows[rows.length - 1];
  assert.deepEqual(last.nearestSupportTouchCount120, { value: 0, availability: 'AVAILABLE' });
  assert.deepEqual(last.nearestSupportLastTouchSessionsAgo, { value: null, availability: 'NO_LEVEL_TOUCH' });
});

test('L4A-B2 penetration is exactly zero without a pierce and positive on a pierce', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n, 60n];
  const lows = closes.map((close, index) => (index === 7 ? 15n : close - 1n));
  const bars = makeVolumeBars(closes, { lows, highs: closes.map((close) => close + 1n) });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[6].supportPenetrationPct, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[7].supportPenetrationPct, {
    value: fixed('266666666667'), availability: 'AVAILABLE',
  });
});

test('L4A-B2 a pivot older than the 252-session structure lookback stops feeding levels', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n];
  for (let index = 0; index < 250; index += 1) closes.push(100n);
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.equal(rows[254].nearestSupportPrice.availability, 'AVAILABLE');
  assert.deepEqual(rows[255].nearestSupportPrice, { value: null, availability: 'NO_SUPPORT_LEVEL' });
});

test('L4A-B2 an exact level price tie between pivots keeps the most recently confirmed one', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 80n, 20n, 80n, 90n, 100n, 60n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = supportResistanceRows(bars);
  assert.deepEqual(rows[11].nearestSupportPrice, { value: fixed('19000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[11].nearestSupportPivotSessionDate, { value: '2020-01-08', availability: 'AVAILABLE' });
});
