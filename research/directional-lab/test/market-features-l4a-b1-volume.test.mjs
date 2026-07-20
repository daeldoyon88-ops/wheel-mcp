import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeVolumeParticipationFeatures } from '../src/features/volumeParticipationFeaturesL4V1.mjs';
import { MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1 } from '../src/features/marketVolumeStructureRuntimePolicyL4V1.mjs';
import {
  makeTechnicalCellsFromBars,
  makeVolumeBars,
} from './marketVolumeStructureL4SyntheticFixture.mjs';

function participationRows(bars) {
  const cells = makeTechnicalCellsFromBars(bars);
  return computeVolumeParticipationFeatures(
    bars, cells.map((cell) => cell.return20),
    MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1.volumeParticipation,
  ).rows;
}

function fixed(atoms) {
  return { atoms, scale: 12 };
}

test('L4A-B1 volumeMean20Previous averages the previous twenty sessions excluding the current one', () => {
  const closes = Array.from({ length: 25 }, () => 100n);
  const volumes = Array.from({ length: 25 }, (_, index) => BigInt(index + 1));
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[19].volumeMean20Previous, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[20].volumeMean20Previous, { value: fixed('10500000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[24].volumeMean20Previous, { value: fixed('14500000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 volumeMean50Previous requires fifty complete previous sessions', () => {
  const closes = Array.from({ length: 55 }, () => 100n);
  const volumes = Array.from({ length: 55 }, () => 2n);
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[49].volumeMean50Previous, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[50].volumeMean50Previous, { value: fixed('2000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 relative volume divides the exact volume by the previous-session baseline', () => {
  const closes = Array.from({ length: 25 }, () => 100n);
  const volumes = Array.from({ length: 25 }, (_, index) => BigInt(index + 1));
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[20].relativeVolume20, { value: fixed('2000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 a zero volume baseline reports DIVISION_BY_ZERO, never a fabricated ratio', () => {
  const closes = Array.from({ length: 22 }, () => 100n);
  const volumes = closes.map((_, index) => (index < 20 ? 0n : 5n));
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[20].volumeMean20Previous, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[20].relativeVolume20, { value: null, availability: 'DIVISION_BY_ZERO' });
});

test('L4A-B1 a null volume in the baseline window or on the current session is MISSING_INPUT', () => {
  const closes = Array.from({ length: 23 }, () => 100n);
  const volumes = closes.map((_, index) => (index === 5 ? null : 10n));
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[20].volumeMean20Previous, { value: null, availability: 'MISSING_INPUT' });
  const currentNull = closes.map((_, index) => (index === 21 ? null : 10n));
  const rows2 = participationRows(makeVolumeBars(closes, { volumes: currentNull }));
  assert.equal(rows2[21].volumeMean20Previous.availability, 'AVAILABLE');
  assert.deepEqual(rows2[21].relativeVolume20, { value: null, availability: 'MISSING_INPUT' });
});

test('L4A-B1 volume percentile is 1 above every previous volume and 0 below all of them', () => {
  const closes = Array.from({ length: 62 }, () => 100n);
  const ascending = closes.map((_, index) => BigInt(index + 1));
  const rows = participationRows(makeVolumeBars(closes, { volumes: ascending }));
  assert.deepEqual(rows[59].volumePercentile60Previous, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[60].volumePercentile60Previous, { value: fixed('1000000000000'), availability: 'AVAILABLE' });
  const withDrop = closes.map((_, index) => (index === 61 ? 0n : BigInt(index + 1)));
  const rows2 = participationRows(makeVolumeBars(closes, { volumes: withDrop }));
  assert.deepEqual(rows2[61].volumePercentile60Previous, { value: fixed('0'), availability: 'AVAILABLE' });
});

test('L4A-B1 volume percentile ties use the deterministic median rank', () => {
  const closes = Array.from({ length: 61 }, () => 100n);
  const equal = closes.map(() => 7n);
  const rows = participationRows(makeVolumeBars(closes, { volumes: equal }));
  assert.deepEqual(rows[60].volumePercentile60Previous, { value: fixed('500000000000'), availability: 'AVAILABLE' });
  const mixed = closes.map((_, index) => {
    if (index === 60) return 5n;
    return index < 30 ? 5n : 10n;
  });
  const rows2 = participationRows(makeVolumeBars(closes, { volumes: mixed }));
  assert.deepEqual(rows2[60].volumePercentile60Previous, { value: fixed('250000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 OBV starts at zero, adds on up closes, subtracts on down closes, holds on equality', () => {
  const closes = [10n, 12n, 11n, 11n, 13n];
  const volumes = [5n, 7n, 3n, 4n, 6n];
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[0].obv, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[1].obv, { value: fixed('7000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[2].obv, { value: fixed('4000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[3].obv, { value: fixed('4000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[4].obv, { value: fixed('10000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 a null volume poisons OBV forward but the first-session volume is never consumed', () => {
  const closes = [10n, 11n, 12n, 13n];
  const rows = participationRows(makeVolumeBars(closes, { volumes: [null, 2n, 3n, 4n] }));
  assert.deepEqual(rows[0].obv, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[3].obv, { value: fixed('9000000000000'), availability: 'AVAILABLE' });
  const rows2 = participationRows(makeVolumeBars(closes, { volumes: [1n, 2n, null, 4n] }));
  assert.deepEqual(rows2[2].obv, { value: null, availability: 'MISSING_INPUT' });
  assert.deepEqual(rows2[3].obv, { value: null, availability: 'MISSING_INPUT' });
});

test('L4A-B1 OBV deltas require both endpoints and enough history', () => {
  const closes = Array.from({ length: 26 }, (_, index) => BigInt(100 + index));
  const volumes = closes.map(() => 3n);
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[4].obvDelta5, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[5].obvDelta5, { value: fixed('15000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[25].obvDelta20, { value: fixed('60000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[25].obvDelta60, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});

test('L4A-B1 the money flow multiplier and volume follow the closed A/D formula', () => {
  const bars = makeVolumeBars([18n], {
    highs: [20n], lows: [10n], volumes: [10n],
  });
  const rows = participationRows(bars);
  assert.deepEqual(rows[0].moneyFlowMultiplier, { value: fixed('600000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[0].moneyFlowVolume, { value: fixed('6000000000000'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[0].accumulationDistributionLine, { value: fixed('6000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 a flat range fixes MFM and MFV to exactly zero for this family, even without volume', () => {
  const bars = makeVolumeBars([10n, 10n, 12n], {
    highs: [10n, 10n, 13n], lows: [10n, 10n, 11n], volumes: [4n, null, 5n],
  });
  const rows = participationRows(bars);
  assert.deepEqual(rows[1].moneyFlowMultiplier, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[1].moneyFlowVolume, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.equal(rows[2].accumulationDistributionLine.availability, 'AVAILABLE');
});

test('L4A-B1 the A/D line accumulates money flow volume and its 20-session delta is causal', () => {
  const closes = Array.from({ length: 22 }, () => 15n);
  const bars = makeVolumeBars(closes, {
    highs: closes.map(() => 20n),
    lows: closes.map(() => 10n),
    opens: closes.map(() => 15n),
    volumes: closes.map(() => 10n),
  });
  const rows = participationRows(bars);
  assert.deepEqual(rows[1].accumulationDistributionLine, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[21].adLineDelta20, { value: fixed('0'), availability: 'AVAILABLE' });
  assert.deepEqual(rows[19].adLineDelta20, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});

test('L4A-B1 CMF20 divides the 20-session money flow volume by the 20-session volume', () => {
  const closes = Array.from({ length: 21 }, () => 105n);
  const bars = makeVolumeBars(closes, {
    highs: closes.map(() => 110n),
    lows: closes.map(() => 90n),
    volumes: closes.map(() => 4n),
  });
  const rows = participationRows(bars);
  assert.deepEqual(rows[18].chaikinMoneyFlow20, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[19].chaikinMoneyFlow20, { value: fixed('500000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 CMF20 reports ZERO_TOTAL_VOLUME on an all-zero window', () => {
  const closes = Array.from({ length: 20 }, () => 105n);
  const bars = makeVolumeBars(closes, {
    highs: closes.map(() => 110n),
    lows: closes.map(() => 90n),
    volumes: closes.map(() => 0n),
  });
  const rows = participationRows(bars);
  assert.deepEqual(rows[19].chaikinMoneyFlow20, { value: null, availability: 'ZERO_TOTAL_VOLUME' });
});

test('L4A-B1 MFI is first available at index 14 and saturates at 100 on all-rising typical prices', () => {
  const closes = Array.from({ length: 16 }, (_, index) => BigInt(10 + index));
  const rows = participationRows(makeVolumeBars(closes, { spread: 0n, volumes: closes.map(() => 1n) }));
  assert.deepEqual(rows[13].moneyFlowIndex14, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(rows[14].moneyFlowIndex14, { value: fixed('100000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 MFI is 0 on all-falling and 50 on all-flat typical prices', () => {
  const falling = Array.from({ length: 15 }, (_, index) => BigInt(100 - index));
  const rowsFalling = participationRows(makeVolumeBars(falling, { spread: 0n, volumes: falling.map(() => 1n) }));
  assert.deepEqual(rowsFalling[14].moneyFlowIndex14, { value: fixed('0'), availability: 'AVAILABLE' });
  const flat = Array.from({ length: 15 }, () => 100n);
  const rowsFlat = participationRows(makeVolumeBars(flat, { spread: 0n, volumes: flat.map(() => 1n) }));
  assert.deepEqual(rowsFlat[14].moneyFlowIndex14, { value: fixed('50000000000000'), availability: 'AVAILABLE' });
});

test('L4A-B1 MFI mixes positive and negative flows with a single HALF_EVEN rounding', () => {
  const closes = [10n, 12n, 11n, 13n, 12n, 14n, 13n, 15n, 14n, 16n, 15n, 17n, 16n, 18n, 17n];
  const rows = participationRows(makeVolumeBars(closes, { spread: 0n, volumes: closes.map(() => 1n) }));
  assert.deepEqual(rows[14].moneyFlowIndex14, { value: fixed('51724137931034'), availability: 'AVAILABLE' });
});

test('L4A-B1 a null volume inside the MFI window is MISSING_INPUT', () => {
  const closes = Array.from({ length: 16 }, (_, index) => BigInt(10 + index));
  const volumes = closes.map((_, index) => (index === 10 ? null : 1n));
  const rows = participationRows(makeVolumeBars(closes, { spread: 0n, volumes }));
  assert.deepEqual(rows[14].moneyFlowIndex14, { value: null, availability: 'MISSING_INPUT' });
});

test('L4A-B1 price-volume confirmation fires only when both return20 and obvDelta20 agree strictly', () => {
  const closes = Array.from({ length: 25 }, (_, index) => BigInt(100 + index));
  const volumes = closes.map(() => 10n);
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[24].priceVolumeBullishConfirmation20, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(rows[24].priceVolumeBearishConfirmation20, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(rows[24].bullishPriceVolumeDivergence20, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(rows[24].bearishPriceVolumeDivergence20, { value: false, availability: 'AVAILABLE' });
});

test('L4A-B1 a bearish divergence marks rising price against falling on-balance volume', () => {
  const closes = [];
  for (let index = 0; index < 20; index += 1) closes.push(BigInt(200 - index));
  closes.push(300n);
  const volumes = closes.map(() => 10n);
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[20].bearishPriceVolumeDivergence20, { value: true, availability: 'AVAILABLE' });
  assert.deepEqual(rows[20].priceVolumeBullishConfirmation20, { value: false, availability: 'AVAILABLE' });
});

test('L4A-B1 exact zero return or zero OBV delta yields false, never a fabricated signal', () => {
  const closes = Array.from({ length: 21 }, () => 100n);
  const volumes = closes.map(() => 10n);
  const rows = participationRows(makeVolumeBars(closes, { volumes }));
  assert.deepEqual(rows[20].priceVolumeBullishConfirmation20, { value: false, availability: 'AVAILABLE' });
  assert.deepEqual(rows[20].priceVolumeBearishConfirmation20, { value: false, availability: 'AVAILABLE' });
});

test('L4A-B1 an unavailable comparison component leaves the booleans null with its reason', () => {
  const closes = Array.from({ length: 10 }, (_, index) => BigInt(100 + index));
  const rows = participationRows(makeVolumeBars(closes, { volumes: closes.map(() => 1n) }));
  assert.deepEqual(rows[9].priceVolumeBullishConfirmation20, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});
