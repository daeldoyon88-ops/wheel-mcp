import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeVolumeParticipationFeatures } from '../src/features/volumeParticipationFeaturesL4V1.mjs';
import { detectConfirmedPivots } from '../src/features/confirmedPivotFeaturesL4V1.mjs';
import { computeSupportResistanceFeatures } from '../src/features/supportResistanceFeaturesL4V1.mjs';
import { computeGapBreakoutFeatures } from '../src/features/gapBreakoutFeaturesL4V1.mjs';
import {
  makeTechnicalCellsFromBars,
  makeVolumeBars,
} from './marketVolumeStructureL4SyntheticFixture.mjs';

function fixed(atoms) {
  return { atoms, scale: 12 };
}

function gapBreakoutRows(bars) {
  const cells = makeTechnicalCellsFromBars(bars);
  const participation = computeVolumeParticipationFeatures(bars, cells.map((cell) => cell.return20));
  const levels = computeSupportResistanceFeatures(bars, detectConfirmedPivots(bars), cells).levels;
  return computeGapBreakoutFeatures(bars, levels, participation.relativeVolume20Internal);
}

test('L4A-B2 a breakout uses the previous row levels and requires a strict cross of the resistance', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 50n, 101n, 120n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[7].breakoutAboveResistance, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(rows[8].breakoutAboveResistance, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].breakoutAboveResistance, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].breakoutLevel, { value: fixed('101000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[0].breakoutAboveResistance, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});

test('L4A-B2 a breakdown mirrors the breakout on the previous support', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n, 60n, 10n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[7].breakdownBelowSupport, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(rows[8].breakdownBelowSupport, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(rows[8].breakdownLevel, { value: fixed('19000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B2 a close exactly on the level is never a breakout', () => {
  const highs = [10n, 20n, 30n, 101n, 30n, 20n, 10n, 50n, 101n, 101n];
  const closes = highs.map((high, index) => (index >= 7 ? high : high - 5n));
  const bars = makeVolumeBars(closes, {
    highs, lows: highs.map((_, index) => (index >= 7 ? closes[index] - 1n : 5n - BigInt(index > 4 ? 4 : index))),
  });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[9].breakoutAboveResistance, { value: false, availability: 'AVAILABLE' });
});

test('L4A-B2 volume confirmation compares relativeVolume20 to the closed 1.5 threshold', () => {
  const closes = [];
  for (let index = 0; index < 22; index += 1) closes.push([10n, 20n, 30n, 100n, 30n, 20n][index] ?? 50n);
  closes.push(102n);
  const volumes = closes.map((_, index) => (index === 22 ? 200n : 100n));
  const bars = makeVolumeBars(closes, { spread: 1n, volumes });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[22].breakoutAboveResistance, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(rows[22].volumeConfirmedBreakout, { value: true, availability: 'AVAILABLE' });
  const weak = makeVolumeBars(closes, { spread: 1n, volumes: closes.map(() => 100n) });
  const weakRows = gapBreakoutRows(weak).rows;
  assert.deepEqual(weakRows[22].volumeConfirmedBreakout, { value: false, availability: 'AVAILABLE' });
});

test('L4A-B2 an unavailable relative volume leaves confirmation null while the event stays defined', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 50n, 101n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[8].breakoutAboveResistance, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(rows[8].volumeConfirmedBreakout, { value: false, availability: 'AVAILABLE' });
  const crossing = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 50n, 102n];
  const crossingRows = gapBreakoutRows(makeVolumeBars(crossing, { spread: 1n })).rows;
  assert.deepEqual(crossingRows[8].breakoutAboveResistance, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(crossingRows[8].volumeConfirmedBreakout, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});

test('L4A-B2 a failed breakout is observed causally from a past event, never from future rows', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 50n, 102n, 40n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[8].failedBreakoutAboveResistanceWithin5, { value: null, availability: 'MISSING_INPUT' });
  assert.deepEqual(rows[9].failedBreakoutAboveResistanceWithin5, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].failedEventAgeSessions, { value: 1, availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].failedEventLevel, { value: fixed('101000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B2 a failed breakdown is observed when the close crosses back above the broken support', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 100n, 60n, 10n, 70n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[9].failedBreakdownBelowSupportWithin5, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(rows[9].failedEventAgeSessions, { value: 1, availability: 'AVAILABLE' });
});

test('L4A-B2 an event older than five sessions can no longer fail', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 50n, 102n, 110n, 111n, 112n, 113n, 114n, 40n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = gapBreakoutRows(bars);
  assert.equal(rows[14].failedBreakoutAboveResistanceWithin5.value, null);
  assert.equal(rows[13].failedBreakoutAboveResistanceWithin5.value, null);
});

test('L4A-B2 quiet defined windows report false with NO_FAILED_EVENT details', () => {
  const closes = [100n, 90n, 80n, 20n, 80n, 90n, 300n, 90n, 80n, 50n, 60n, 50n, 60n, 55n, 60n, 55n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const { rows } = gapBreakoutRows(bars);
  const last = rows[15];
  assert.deepEqual(last.failedBreakoutAboveResistanceWithin5, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(last.failedBreakdownBelowSupportWithin5, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(last.failedEventAgeSessions, { value: null, availability: 'NO_FAILED_EVENT' });
  assert.deepEqual(last.failedEventLevel, { value: null, availability: 'NO_FAILED_EVENT' });
});

test('L4A-B2 a full gap up records the exact zone and a partial overlap is never a gap', () => {
  const closes = [10n, 13n, 13n];
  const bars = makeVolumeBars(closes, {
    highs: [10n, 14n, 14n], lows: [9n, 12n, 12n],
  });
  const { rows, detectedGapCount } = gapBreakoutRows(bars);
  assert.equal(detectedGapCount, 1);
  assert.deepEqual(rows[1].nearestOpenGapBelowLower, { value: fixed('10000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[1].nearestOpenGapBelowUpper, { value: fixed('12000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[1].nearestOpenGapBelowAgeSessions, { value: 0, availability: 'AVAILABLE' });
  const touching = makeVolumeBars(closes, { highs: [10n, 14n, 14n], lows: [9n, 10n, 10n] });
  assert.equal(gapBreakoutRows(touching).detectedGapCount, 0);
});

test('L4A-B2 a full gap down mirrors the gap up definition', () => {
  const closes = [20n, 15n, 15n];
  const bars = makeVolumeBars(closes, {
    highs: [21n, 16n, 16n], lows: [19n, 14n, 14n],
  });
  const { rows, detectedGapCount } = gapBreakoutRows(bars);
  assert.equal(detectedGapCount, 1);
  assert.deepEqual(rows[1].nearestOpenGapAboveLower, { value: fixed('16000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[1].nearestOpenGapAboveUpper, { value: fixed('19000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[1].distanceToNearestOpenGapAbove, {
    value: fixed('66666666667'), availability: 'AVAILABLE',
  });
});

test('L4A-B2 a gap is filled only when the opposite boundary is reached exactly or beyond', () => {
  const closes = [10n, 13n, 13n, 13n];
  const partial = makeVolumeBars(closes, {
    highs: [10n, 14n, 14n, 14n], lows: [9n, 12n, 11n, 11n],
  });
  const partialRows = gapBreakoutRows(partial);
  assert.equal(partialRows.openGapCount, 1);
  assert.equal(partialRows.rows[3].nearestOpenGapBelowLower.availability, 'AVAILABLE');
  const filled = makeVolumeBars(closes, {
    highs: [10n, 14n, 14n, 14n], lows: [9n, 12n, 10n, 11n],
  });
  const filledRows = gapBreakoutRows(filled);
  assert.equal(filledRows.openGapCount, 0);
  assert.deepEqual(filledRows.rows[2].nearestOpenGapBelowLower, { value: null, availability: 'NO_OPEN_GAP' });
});

test('L4A-B2 the nearest open gaps split deterministically around the close and exclude straddles', () => {
  const closes = [10n, 13n, 18n, 30n, 15n];
  const bars = makeVolumeBars(closes, {
    highs: [10n, 14n, 19n, 31n, 15n], lows: [9n, 12n, 16n, 25n, 15n],
  });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[2].nearestOpenGapBelowUpper, { value: fixed('16000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[4].nearestOpenGapBelowUpper, { value: fixed('12000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[4].nearestOpenGapAboveLower, { value: fixed('15000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B2 a straddled gap zone belongs to neither side', () => {
  const closes = [10n, 14n, 11n];
  const bars = makeVolumeBars(closes, {
    highs: [10n, 15n, 12n], lows: [9n, 12n, 11n],
  });
  const { rows } = gapBreakoutRows(bars);
  assert.deepEqual(rows[2].nearestOpenGapBelowUpper, { value: null, availability: 'NO_OPEN_GAP' });
  assert.deepEqual(rows[2].nearestOpenGapAboveLower, { value: null, availability: 'NO_OPEN_GAP' });
});

test('L4A-B2 an unfilled gap leaves the reported set after the 252-session lookback', () => {
  const closes = [10n, 13n];
  for (let index = 0; index < 254; index += 1) closes.push(13n);
  const bars = makeVolumeBars(closes, {
    highs: closes.map((close, index) => (index === 0 ? 10n : 14n)),
    lows: closes.map((close, index) => (index === 0 ? 9n : 12n)),
  });
  const { rows, detectedGapCount, openGapCount } = gapBreakoutRows(bars);
  assert.equal(detectedGapCount, 1);
  assert.equal(openGapCount, 0);
  assert.equal(rows[252].nearestOpenGapBelowLower.availability, 'AVAILABLE');
  assert.deepEqual(rows[253].nearestOpenGapBelowLower, { value: null, availability: 'NO_OPEN_GAP' });
});
