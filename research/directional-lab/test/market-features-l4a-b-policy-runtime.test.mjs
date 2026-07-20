import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
} from '../src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import { MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1 } from '../src/contracts/marketVolumeStructureFeaturePolicyValuesL4V1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1,
  deriveMarketVolumeStructureRuntimePolicyV1,
} from '../src/features/marketVolumeStructureRuntimePolicyL4V1.mjs';
import { computeVolumeParticipationFeatures } from '../src/features/volumeParticipationFeaturesL4V1.mjs';
import { computeEodVolumeWeightedPriceFeatures } from '../src/features/eodVolumeWeightedPriceFeaturesL4V1.mjs';
import {
  computeAlternatedStreamStates,
  detectConfirmedPivots,
} from '../src/features/confirmedPivotFeaturesL4V1.mjs';
import { computeSupportResistanceFeatures } from '../src/features/supportResistanceFeaturesL4V1.mjs';
import { computeGapBreakoutFeatures } from '../src/features/gapBreakoutFeaturesL4V1.mjs';
import { computeCongestionFeatures } from '../src/features/congestionFeaturesL4V1.mjs';
import { computeFibonacciFeatures } from '../src/features/fibonacciStructureFeaturesL4V1.mjs';
import { buildMarketVolumeStructureFeatureComputationPolicy } from '../src/features/computeMarketVolumeStructureFeaturesL4V1.mjs';
import {
  makeTechnicalCellsFromBars,
  makeVolumeBars,
} from './marketVolumeStructureL4SyntheticFixture.mjs';
import { withStore } from './l2aSyntheticPipeline.mjs';

const RUNTIME = MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1;
const UNIT = 10n ** 24n;

function mutableSection(name, overrides = {}) {
  const base = RUNTIME[name];
  const copy = { ...base, scales: { ...base.scales } };
  for (const field of ['baselinePeriods', 'obvDeltaPeriods', 'rollingPeriods']) {
    if (Array.isArray(base[field])) copy[field] = [...base[field]];
  }
  if (Array.isArray(base.ratios)) copy.ratios = base.ratios.map((ratio) => ({ ...ratio }));
  return { ...copy, ...overrides };
}

function participation(bars, config) {
  const technical = makeTechnicalCellsFromBars(bars);
  return computeVolumeParticipationFeatures(
    bars, technical.map((cells) => cells.return20), config,
  );
}

function availableInternal(atoms) {
  return { value: { atoms, scale: 24 }, availability: 'AVAILABLE' };
}

function manualPivot(bars, index = 0, pivotType = 'SWING_LOW') {
  return {
    pivotType,
    pivotPrice: pivotType === 'SWING_LOW' ? bars[index].low : bars[index].high,
    pivotIndex: index,
    confirmedIndex: index,
    pivotSessionDate: bars[index].source.sessionDate,
    confirmedAtSessionDate: bars[index].source.sessionDate,
    pivotBarIdentityId: bars[index].source.barIdentityId,
    pivotResolvedObservationId: bars[index].source.resolvedObservationId,
  };
}

test('L4A-B V1 contract re-exports the exact deeply frozen canonical policy object', () => {
  assert.strictEqual(
    MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
    MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1,
  );
  assert.equal(Object.isFrozen(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1), true);
  assert.equal(Object.isFrozen(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.fibonacciRatios), true);
  assert.equal(Object.isFrozen(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.fibonacciRatios[0]), true);
});

test('L4A-B official policy retains the pre-hardening CAS identity', () => withStore((store) => {
  const built = buildMarketVolumeStructureFeatureComputationPolicy({ store });
  assert.equal(
    built.volumeStructureFeatureComputationPolicyId,
    'sha256:372fe3664a37ea29c73165ea405ae036518d7031d86ae738903dea868ba89556',
  );
  const runtime = deriveMarketVolumeStructureRuntimePolicyV1({
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1,
  });
  assert.deepEqual(runtime, RUNTIME);
}));

test('L4A-B volume percentile window is consumed instead of the historical literal', () => {
  const bars = makeVolumeBars([10n, 10n, 10n, 10n], { volumes: [1n, 2n, 3n, 4n] });
  const short = participation(bars, mutableSection('volumeParticipation', { percentileWindow: 3 }));
  const official = participation(bars, mutableSection('volumeParticipation'));
  assert.equal(short.rows[3].volumePercentile3Previous.availability, 'AVAILABLE');
  assert.equal(official.rows[3].volumePercentile60Previous.availability, 'INSUFFICIENT_HISTORY');
});

test('L4A-B volume baseline periods and OBV delta periods are runtime-driven', () => {
  const bars = makeVolumeBars([10n, 11n, 12n, 13n], { volumes: [1n, 2n, 3n, 4n] });
  const config = mutableSection('volumeParticipation', {
    baselinePeriods: [2, 3], obvDeltaPeriods: [1, 2], priceVolumeComparisonPeriod: 1,
  });
  const result = participation(bars, config);
  assert.equal(result.rows[2].volumeMean2Previous.availability, 'AVAILABLE');
  assert.equal(result.rows[2].obvDelta1.availability, 'AVAILABLE');
  assert.equal(result.rows[2].obvDelta2.availability, 'AVAILABLE');
  assert.equal('obvDelta20' in result.rows[2], false);
});

test('L4A-B A/D, MFI and CMF periods are runtime-driven', () => {
  const bars = makeVolumeBars([10n, 11n, 12n, 13n], { volumes: [1n, 1n, 1n, 1n] });
  const config = mutableSection('volumeParticipation', {
    adLineDeltaPeriod: 2, mfiPeriod: 3, cmfPeriod: 3,
  });
  const result = participation(bars, config).rows;
  assert.equal(result[2].adLineDelta2.availability, 'AVAILABLE');
  assert.equal(result[2].chaikinMoneyFlow3.availability, 'AVAILABLE');
  assert.equal(result[3].moneyFlowIndex3.availability, 'AVAILABLE');
});

test('L4A-B rolling EOD VWAP periods are runtime-driven', () => {
  const bars = makeVolumeBars([10n, 20n, 30n], { spread: 0n, volumes: [1n, 1n, 1n] });
  const states = bars.map(() => ({ lastSwingLow: null, lastSwingHigh: null, leg: null }));
  const rows = computeEodVolumeWeightedPriceFeatures(
    bars, states, mutableSection('eodVolumeWeightedPrices', { rollingPeriods: [2, 3] }),
  );
  assert.equal(rows[1].eodVolumeWeightedAveragePrice2.availability, 'AVAILABLE');
  assert.equal(rows[2].eodVolumeWeightedAveragePrice3.availability, 'AVAILABLE');
  assert.equal('eodVolumeWeightedAveragePrice20' in rows[2], false);
});

test('L4A-B pivot radius and confirmation delay are runtime-driven', () => {
  const bars = makeVolumeBars([1n, 10n, 1n], { spread: 0n });
  const short = mutableSection('pivots', { radius: 1, confirmationDelay: 1 });
  const pivots = detectConfirmedPivots(bars, short);
  assert.equal(pivots.length, 1);
  assert.equal(pivots[0].pivotIndex, 1);
  assert.equal(pivots[0].confirmedIndex, 2);
  assert.equal(detectConfirmedPivots(bars, mutableSection('pivots')).length, 0);
});

test('L4A-B structure lookback is runtime-driven', () => {
  const bars = makeVolumeBars([10n, 20n, 20n, 20n, 20n, 20n, 20n], { spread: 0n });
  const pivots = [manualPivot(bars)];
  const technical = makeTechnicalCellsFromBars(bars);
  const short = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', { structureLookback: 5 }),
  );
  const long = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', { structureLookback: 10 }),
  );
  assert.equal(short.rows[6].nearestSupportPrice.availability, 'NO_SUPPORT_LEVEL');
  assert.equal(long.rows[6].nearestSupportPrice.availability, 'AVAILABLE');
});

test('L4A-B level touch lookback is runtime-driven', () => {
  const bars = makeVolumeBars([10n, 20n, 20n, 20n, 20n, 20n, 20n], { spread: 0n });
  const pivots = [manualPivot(bars)];
  const technical = makeTechnicalCellsFromBars(bars);
  const four = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', { touchLookback: 4 }),
  );
  const ten = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', { touchLookback: 10 }),
  );
  assert.equal(four.rows[6].nearestSupportTouchCount4.value, 0);
  assert.equal(ten.rows[6].nearestSupportTouchCount10.value, 1);
});

test('L4A-B price tolerance ratio is runtime-driven', () => {
  const bars = makeVolumeBars([10n, 20n, 12n], { spread: 0n });
  const pivots = [manualPivot(bars)];
  const technical = makeTechnicalCellsFromBars(bars);
  const tight = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', {
      priceTolerance: { numerator: 0n, denominator: 1n },
    }),
  );
  const wide = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', {
      priceTolerance: { numerator: 1n, denominator: 5n },
    }),
  );
  assert.ok(wide.rows[2].nearestSupportTouchCount120.value > tight.rows[2].nearestSupportTouchCount120.value);
});

test('L4A-B ATR tolerance ratio is runtime-driven', () => {
  const bars = makeVolumeBars([10n, 20n, 12n], { spread: 0n });
  const pivots = [manualPivot(bars)];
  const technical = bars.map(() => ({ atr14: availableInternal(2n * UNIT) }));
  const zero = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', {
      priceTolerance: { numerator: 0n, denominator: 1n },
      atrTolerance: { numerator: 0n, denominator: 1n },
    }),
  );
  const one = computeSupportResistanceFeatures(
    bars, pivots, technical, mutableSection('supportResistance', {
      priceTolerance: { numerator: 0n, denominator: 1n },
      atrTolerance: { numerator: 1n, denominator: 1n },
    }),
  );
  assert.ok(one.rows[2].nearestSupportTouchCount120.value > zero.rows[2].nearestSupportTouchCount120.value);
});

test('L4A-B breakout volume threshold is runtime-driven', () => {
  const bars = makeVolumeBars([9n, 11n], { spread: 0n });
  const level = { atoms: 10n * UNIT, scale: 24 };
  const levels = [{ support: null, resistance: level }, { support: null, resistance: level }];
  const relative = [
    { atoms: UNIT, availability: 'AVAILABLE' },
    { atoms: UNIT, availability: 'AVAILABLE' },
  ];
  const high = computeGapBreakoutFeatures(
    bars, levels, relative, mutableSection('gapsBreakouts', {
      volumeThreshold: { numerator: 3n, denominator: 2n },
    }),
  );
  const low = computeGapBreakoutFeatures(
    bars, levels, relative, mutableSection('gapsBreakouts', {
      volumeThreshold: { numerator: 1n, denominator: 2n },
    }),
  );
  assert.equal(high.rows[1].volumeConfirmedBreakout.value, false);
  assert.equal(low.rows[1].volumeConfirmedBreakout.value, true);
});

test('L4A-B failed-event observation window is runtime-driven', () => {
  const bars = makeVolumeBars([9n, 11n, 12n, 12n, 9n], { spread: 0n });
  const level = { atoms: 10n * UNIT, scale: 24 };
  const levels = bars.map(() => ({ support: null, resistance: level }));
  const relative = bars.map(() => ({ atoms: 2n * UNIT, availability: 'AVAILABLE' }));
  const short = computeGapBreakoutFeatures(
    bars, levels, relative, mutableSection('gapsBreakouts', { failedEventWindow: 2 }),
  );
  const long = computeGapBreakoutFeatures(
    bars, levels, relative, mutableSection('gapsBreakouts', { failedEventWindow: 4 }),
  );
  assert.equal(short.rows[4].failedBreakoutAboveResistanceWithin2.value, false);
  assert.equal(long.rows[4].failedBreakoutAboveResistanceWithin4.value, true);
});

test('L4A-B open-gap lookback is runtime-driven', () => {
  const bars = makeVolumeBars([10n, 13n, 13n, 13n], {
    highs: [10n, 14n, 14n, 14n], lows: [9n, 12n, 12n, 12n],
  });
  const levels = bars.map(() => ({ support: null, resistance: null }));
  const relative = bars.map(() => ({ atoms: null, availability: 'INSUFFICIENT_HISTORY' }));
  const short = computeGapBreakoutFeatures(
    bars, levels, relative, mutableSection('gapsBreakouts', { openGapLookback: 2 }),
  );
  const long = computeGapBreakoutFeatures(
    bars, levels, relative, mutableSection('gapsBreakouts', { openGapLookback: 5 }),
  );
  assert.equal(short.rows[3].nearestOpenGapBelowLower.availability, 'NO_OPEN_GAP');
  assert.equal(long.rows[3].nearestOpenGapBelowLower.availability, 'AVAILABLE');
});

test('L4A-B congestion window and reference window are runtime-driven', () => {
  const bars = makeVolumeBars([100n, 101n, 100n, 101n, 100n], { spread: 1n });
  const technical = bars.map(() => ({ atr14Pct: availableInternal(UNIT) }));
  const rows = computeCongestionFeatures(
    bars, technical, mutableSection('congestion', { window: 3, referenceWindow: 5 }),
  );
  assert.equal(rows[2].priceRange3Pct.availability, 'AVAILABLE');
  assert.equal(rows[4].priceRange5Pct.availability, 'AVAILABLE');
});

test('L4A-B congestion efficiency threshold is runtime-driven', () => {
  const bars = makeVolumeBars([100n, 101n, 100n, 101n, 100n, 101n], { spread: 1n });
  const technical = bars.map(() => ({ atr14Pct: availableInternal(UNIT) }));
  const base = { window: 3, referenceWindow: 5, atrMultiplier: { numerator: 10n, denominator: 1n } };
  const low = computeCongestionFeatures(bars, technical, mutableSection('congestion', {
    ...base, efficiencyThreshold: { numerator: 3n, denominator: 10n },
  }));
  const high = computeCongestionFeatures(bars, technical, mutableSection('congestion', {
    ...base, efficiencyThreshold: { numerator: 4n, denominator: 10n },
  }));
  assert.equal(low[5].isCongestion3.value, false);
  assert.equal(high[5].isCongestion3.value, true);
});

test('L4A-B congestion ATR multiplier is runtime-driven', () => {
  const bars = makeVolumeBars([100n, 101n, 100n, 101n, 100n, 101n], { spread: 1n });
  const technical = bars.map(() => ({ atr14Pct: availableInternal(UNIT / 100n) }));
  const base = { window: 3, referenceWindow: 5, efficiencyThreshold: { numerator: 1n, denominator: 1n } };
  const low = computeCongestionFeatures(bars, technical, mutableSection('congestion', {
    ...base, atrMultiplier: { numerator: 2n, denominator: 1n },
  }));
  const high = computeCongestionFeatures(bars, technical, mutableSection('congestion', {
    ...base, atrMultiplier: { numerator: 4n, denominator: 1n },
  }));
  assert.equal(low[5].isCongestion3.value, false);
  assert.equal(high[5].isCongestion3.value, true);
});

test('L4A-B Fibonacci ratios are runtime-driven', () => {
  const bars = makeVolumeBars([40n], { spread: 0n });
  const high = { ...manualPivot(makeVolumeBars([100n], { spread: 0n }), 0, 'SWING_HIGH') };
  const low = { ...manualPivot(makeVolumeBars([0n], { spread: 0n }), 0, 'SWING_LOW') };
  const states = [{ lastSwingHigh: high, lastSwingLow: low, leg: { start: high, end: low } }];
  const half = computeFibonacciFeatures(bars, states, mutableSection('fibonacci', {
    ratios: [{ suffix: '500', numerator: 1n, denominator: 2n }],
  }));
  const quarter = computeFibonacciFeatures(bars, states, mutableSection('fibonacci', {
    ratios: [{ suffix: '250', numerator: 1n, denominator: 4n }],
  }));
  assert.equal(half[0].fibonacci500.value.atoms, '50000000000000');
  assert.equal(quarter[0].fibonacci250.value.atoms, '25000000000000');
});

test('L4A-B calculators reject absent, partial, unknown and mistyped config', () => {
  const bars = makeVolumeBars([10n]);
  assert.throws(() => computeVolumeParticipationFeatures(bars, [], undefined));
  assert.throws(() => computeVolumeParticipationFeatures(bars, [], { scales: RUNTIME.barInputs.scales }));
  assert.throws(() => computeCongestionFeatures(bars, [], {
    ...mutableSection('congestion'), unknownField: true,
  }));
  assert.throws(() => detectConfirmedPivots(bars, mutableSection('pivots', { radius: '3' })));
});

test('L4A-B calculators reject invalid ratios and zero or negative periods', () => {
  const bars = makeVolumeBars([10n]);
  assert.throws(() => computeGapBreakoutFeatures(bars, [], [], mutableSection('gapsBreakouts', {
    volumeThreshold: { numerator: 1n, denominator: 0n },
  })));
  assert.throws(() => computeCongestionFeatures(bars, [], mutableSection('congestion', { window: 0 })));
  assert.throws(() => computeEodVolumeWeightedPriceFeatures(
    bars, [], mutableSection('eodVolumeWeightedPrices', { rollingPeriods: [-1] }),
  ));
});

test('L4A-B runtime derivation refuses scale and rounding drift', () => {
  const base = {
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1,
  };
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1({ ...base, internalScale: 23 }));
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1({ ...base, ratioScale: 11 }));
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1({ ...base, priceScale: 11 }));
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1({ ...base, roundingMode: 'HALF_UP' }));
});

test('L4A-B runtime derivation rejects partial, unknown and mistyped verified policies', () => {
  const base = {
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1,
  };
  const partial = { ...base };
  delete partial.mfiPeriod;
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1(partial));
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1({ ...base, alien: true }));
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1({ ...base, cmfPeriod: '20' }));
});

test('L4A-B README records policy authority, independent oracle, empty snapshots and normative performance', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const required of [
    'source runtime effective', '**220\nscénarios**', 'au moins 30\nvecteurs manuels',
    '`MATERIALIZED_EMPTY`', 'deux stores\nphysiques distincts',
    "elle n'est ni une garantie normative, ni une borne contractuelle officielle",
    "pas un véritable VWAP intraday", "l'OBV reste relatif au début du\nsnapshot",
    "L4A-C n'est pas implémenté", "n'est connectée\nau scanner",
  ]) assert.equal(readme.includes(required), true, required);
});
