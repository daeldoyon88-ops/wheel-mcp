import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1,
  normalizeMarketVolumeStructureFeatureComputationPolicyV1,
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
import {
  buildMarketVolumeStructureFeatureComputationPolicy,
  verifyMarketVolumeStructureFeatureComputationPolicy,
} from '../src/features/computeMarketVolumeStructureFeaturesL4V1.mjs';
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

function deepClonePolicyValues(value) {
  if (Array.isArray(value)) return value.map(deepClonePolicyValues);
  if (value !== null && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = deepClonePolicyValues(value[key]);
    return copy;
  }
  return value;
}

function fullPolicyFromValues(values) {
  return {
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...values,
  };
}

function assertClosedRefusal(mutatedValues, expectedPath) {
  const errMatcher = (error) => {
    assert.equal(error.code, MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1);
    assert.equal(error.details.path, expectedPath);
    assert.equal(error.message.includes(expectedPath), true);
    return true;
  };
  assert.throws(
    () => assertClosedMarketVolumeStructureFeaturePolicyValuesV1(mutatedValues),
    errMatcher,
  );
  assert.throws(
    () => normalizeMarketVolumeStructureFeatureComputationPolicyV1(fullPolicyFromValues(mutatedValues)),
    errMatcher,
  );
  assert.throws(
    () => deriveMarketVolumeStructureRuntimePolicyV1(fullPolicyFromValues(mutatedValues)),
    errMatcher,
  );
}

test('L4A-B closed policy gate accepts canon, deep copies, reordered keys and frozen values', () => {
  const canon = MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1;
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(canon);
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(deepClonePolicyValues(canon));
  const reorderedRoot = {};
  for (const key of Object.keys(canon).reverse()) reorderedRoot[key] = deepClonePolicyValues(canon[key]);
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(reorderedRoot);
  const nested = deepClonePolicyValues(canon);
  nested.levelToleranceAtrMultiplier = {
    scale: nested.levelToleranceAtrMultiplier.scale,
    atoms: nested.levelToleranceAtrMultiplier.atoms,
  };
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(nested);
  const normalized = normalizeMarketVolumeStructureFeatureComputationPolicyV1(fullPolicyFromValues(canon));
  const { schemaVersion, ...normalizedValues } = normalized;
  assert.equal(schemaVersion, MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION);
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(normalizedValues);
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(normalizedValues);
  const frozenCopy = deepClonePolicyValues(canon);
  Object.freeze(frozenCopy);
  Object.freeze(frozenCopy.fibonacciRatios);
  Object.freeze(frozenCopy.fibonacciRatios[0]);
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(frozenCopy);
  const mutableIdentical = deepClonePolicyValues(canon);
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(mutableIdentical);
  deriveMarketVolumeStructureRuntimePolicyV1(fullPolicyFromValues(reorderedRoot));
  deriveMarketVolumeStructureRuntimePolicyV1(normalized);
});

test('L4A-B closed policy gate emits deterministic errors for identical mismatches', () => {
  const left = deepClonePolicyValues(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1);
  const right = deepClonePolicyValues(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1);
  left.mfiPeriod = 13;
  right.mfiPeriod = 13;
  let first;
  let second;
  try { assertClosedMarketVolumeStructureFeaturePolicyValuesV1(left); }
  catch (error) { first = error; }
  try { assertClosedMarketVolumeStructureFeaturePolicyValuesV1(right); }
  catch (error) { second = error; }
  assert.equal(first.code, second.code);
  assert.equal(first.message, second.message);
  assert.equal(first.details.path, '$.mfiPeriod');
});

test('L4A-B deriver refuses the exact audit drift proofs', () => {
  const base = deepClonePolicyValues(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1);
  const proofs = [
    [{ ...base, mfiPeriod: 13 }, '$.mfiPeriod'],
    [{ ...base, volumePercentileWindow: 3 }, '$.volumePercentileWindow'],
    [{ ...base, pivotRadius: 4 }, '$.pivotRadius'],
    [{ ...base, pivotConfirmationDelay: 4 }, '$.pivotConfirmationDelay'],
    [{
      ...base,
      fibonacciRatios: [{ atoms: '100', scale: 3 }],
    }, '$.fibonacciRatios'],
  ];
  for (const [mutated, path] of proofs) {
    assert.throws(
      () => deriveMarketVolumeStructureRuntimePolicyV1(fullPolicyFromValues(mutated)),
      (error) => {
        assert.equal(error.code, MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1);
        assert.equal(error.details.path, path);
        return true;
      },
    );
  }
});

test('L4A-B verifier shares the closed policy gate with the normalizer', () => withStore((store) => {
  const built = buildMarketVolumeStructureFeatureComputationPolicy({ store });
  const verified = verifyMarketVolumeStructureFeatureComputationPolicy({
    store,
    volumeStructureFeatureComputationPolicyId: built.volumeStructureFeatureComputationPolicyId,
  });
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(
    Object.fromEntries(
      Object.keys(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1).map((key) => [
        key, verified.verifiedPolicy[key],
      ]),
    ),
  );
  const drift = {
    ...verified.verifiedPolicy,
    mfiPeriod: 13,
  };
  assert.throws(
    () => normalizeMarketVolumeStructureFeatureComputationPolicyV1(drift),
    (error) => error.code === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
  );
  assert.throws(
    () => deriveMarketVolumeStructureRuntimePolicyV1(drift),
    (error) => error.code === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
  );
}));

const FIELD_MUTATIONS = [
  ['numericRepresentation', (v) => { v.numericRepresentation = 'FLOAT64'; return '$.numericRepresentation'; }],
  ['internalScale', (v) => { v.internalScale = 23; return '$.internalScale'; }],
  ['ratioScale', (v) => { v.ratioScale = 11; return '$.ratioScale'; }],
  ['priceScale', (v) => { v.priceScale = 11; return '$.priceScale'; }],
  ['roundingMode', (v) => { v.roundingMode = 'HALF_UP'; return '$.roundingMode'; }],
  ['rowOrdering', (v) => { v.rowOrdering = 'BAR_IDENTITY_ONLY'; return '$.rowOrdering'; }],
  ['futureDataPolicy', (v) => { v.futureDataPolicy = 'ALLOWED'; return '$.futureDataPolicy'; }],
  ['missingHistoryPolicy', (v) => { v.missingHistoryPolicy = 'THROW'; return '$.missingHistoryPolicy'; }],
  ['volumeBaseline20', (v) => { v.volumeBaseline20 = 'INCLUDING_CURRENT'; return '$.volumeBaseline20'; }],
  ['volumeBaseline50', (v) => { v.volumeBaseline50 = 'INCLUDING_CURRENT'; return '$.volumeBaseline50'; }],
  ['volumePercentileWindow', (v) => { v.volumePercentileWindow = 3; return '$.volumePercentileWindow'; }],
  ['obvOrigin', (v) => { v.obvOrigin = 'ZERO_BEFORE_SNAPSHOT'; return '$.obvOrigin'; }],
  ['obvDeltaPeriods_element', (v) => { v.obvDeltaPeriods = [5, 21, 60]; return '$.obvDeltaPeriods[1]'; }],
  ['obvDeltaPeriods_order', (v) => { v.obvDeltaPeriods = [60, 20, 5]; return '$.obvDeltaPeriods[0]'; }],
  ['obvDeltaPeriods_add', (v) => { v.obvDeltaPeriods = [5, 20, 60, 120]; return '$.obvDeltaPeriods'; }],
  ['obvDeltaPeriods_remove', (v) => { v.obvDeltaPeriods = [5, 20]; return '$.obvDeltaPeriods'; }],
  ['obvDeltaPeriods_duplicate', (v) => { v.obvDeltaPeriods = [5, 20, 20]; return '$.obvDeltaPeriods[2]'; }],
  ['obvDeltaPeriods_object', (v) => { v.obvDeltaPeriods = { 0: 5, 1: 20, 2: 60 }; return '$.obvDeltaPeriods'; }],
  ['adLineOrigin', (v) => { v.adLineOrigin = 'ZERO_AT_START'; return '$.adLineOrigin'; }],
  ['adLineDeltaPeriod', (v) => { v.adLineDeltaPeriod = 19; return '$.adLineDeltaPeriod'; }],
  ['flatRangeMoneyFlowConvention', (v) => {
    v.flatRangeMoneyFlowConvention = 'MIDPOINT'; return '$.flatRangeMoneyFlowConvention';
  }],
  ['mfiPeriod', (v) => { v.mfiPeriod = 13; return '$.mfiPeriod'; }],
  ['cmfPeriod', (v) => { v.cmfPeriod = 21; return '$.cmfPeriod'; }],
  ['rollingEodVwapPeriods_element', (v) => { v.rollingEodVwapPeriods = [20, 61]; return '$.rollingEodVwapPeriods[1]'; }],
  ['rollingEodVwapPeriods_order', (v) => { v.rollingEodVwapPeriods = [60, 20]; return '$.rollingEodVwapPeriods[0]'; }],
  ['rollingEodVwapPeriods_add', (v) => { v.rollingEodVwapPeriods = [20, 60, 120]; return '$.rollingEodVwapPeriods'; }],
  ['rollingEodVwapPeriods_remove', (v) => { v.rollingEodVwapPeriods = [20]; return '$.rollingEodVwapPeriods'; }],
  ['eodVwapBasis', (v) => { v.eodVwapBasis = 'EXCHANGE_INTRADAY'; return '$.eodVwapBasis'; }],
  ['anchoredEodVwapActivation', (v) => {
    v.anchoredEodVwapActivation = 'FROM_PIVOT_ONLY'; return '$.anchoredEodVwapActivation';
  }],
  ['priceVolumeComparisonPeriod', (v) => {
    v.priceVolumeComparisonPeriod = 19; return '$.priceVolumeComparisonPeriod';
  }],
  ['pivotRadius', (v) => { v.pivotRadius = 4; return '$.pivotRadius'; }],
  ['pivotTiePolicy', (v) => { v.pivotTiePolicy = 'ALLOW_PLATEAU'; return '$.pivotTiePolicy'; }],
  ['pivotConfirmationDelay', (v) => { v.pivotConfirmationDelay = 4; return '$.pivotConfirmationDelay'; }],
  ['pivotSameSessionOrder', (v) => {
    v.pivotSameSessionOrder = 'SWING_HIGH_FIRST'; return '$.pivotSameSessionOrder';
  }],
  ['pivotStreamCompression', (v) => {
    v.pivotStreamCompression = 'KEEP_FIRST'; return '$.pivotStreamCompression';
  }],
  ['structureLookback', (v) => { v.structureLookback = 251; return '$.structureLookback'; }],
  ['levelTouchLookback', (v) => { v.levelTouchLookback = 121; return '$.levelTouchLookback'; }],
  ['levelTieBreak', (v) => { v.levelTieBreak = 'OLDEST'; return '$.levelTieBreak'; }],
  ['levelToleranceAtrMultiplier_atoms', (v) => {
    v.levelToleranceAtrMultiplier = { atoms: '26', scale: 2 }; return '$.levelToleranceAtrMultiplier.atoms';
  }],
  ['levelToleranceAtrMultiplier_scale', (v) => {
    v.levelToleranceAtrMultiplier = { atoms: '25', scale: 3 }; return '$.levelToleranceAtrMultiplier.scale';
  }],
  ['levelTolerancePricePct_atoms', (v) => {
    v.levelTolerancePricePct = { atoms: '6', scale: 3 }; return '$.levelTolerancePricePct.atoms';
  }],
  ['levelTolerancePricePct_scale', (v) => {
    v.levelTolerancePricePct = { atoms: '5', scale: 2 }; return '$.levelTolerancePricePct.scale';
  }],
  ['levelToleranceCombination', (v) => {
    v.levelToleranceCombination = 'MIN'; return '$.levelToleranceCombination';
  }],
  ['breakoutVolumeThreshold_atoms', (v) => {
    v.breakoutVolumeThreshold = { atoms: '16', scale: 1 }; return '$.breakoutVolumeThreshold.atoms';
  }],
  ['breakoutVolumeThreshold_scale', (v) => {
    v.breakoutVolumeThreshold = { atoms: '15', scale: 2 }; return '$.breakoutVolumeThreshold.scale';
  }],
  ['failedBreakoutObservationWindow', (v) => {
    v.failedBreakoutObservationWindow = 6; return '$.failedBreakoutObservationWindow';
  }],
  ['openGapLookback', (v) => { v.openGapLookback = 251; return '$.openGapLookback'; }],
  ['openGapSidePolicy', (v) => {
    v.openGapSidePolicy = 'INCLUDE_STRADDLE'; return '$.openGapSidePolicy';
  }],
  ['openGapTieBreak', (v) => { v.openGapTieBreak = 'MOST_RECENT_ONLY'; return '$.openGapTieBreak'; }],
  ['congestionWindow', (v) => { v.congestionWindow = 21; return '$.congestionWindow'; }],
  ['congestionReferenceWindow', (v) => {
    v.congestionReferenceWindow = 61; return '$.congestionReferenceWindow';
  }],
  ['congestionEfficiencyThreshold_atoms', (v) => {
    v.congestionEfficiencyThreshold = { atoms: '31', scale: 2 };
    return '$.congestionEfficiencyThreshold.atoms';
  }],
  ['congestionEfficiencyThreshold_scale', (v) => {
    v.congestionEfficiencyThreshold = { atoms: '30', scale: 3 };
    return '$.congestionEfficiencyThreshold.scale';
  }],
  ['congestionAtrMultiplier_atoms', (v) => {
    v.congestionAtrMultiplier = { atoms: '5', scale: 0 }; return '$.congestionAtrMultiplier.atoms';
  }],
  ['congestionAtrMultiplier_scale', (v) => {
    v.congestionAtrMultiplier = { atoms: '4', scale: 1 }; return '$.congestionAtrMultiplier.scale';
  }],
  ['fibonacciRatios_element_atoms', (v) => {
    v.fibonacciRatios = [
      { atoms: '100', scale: 3 },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
    ];
    return '$.fibonacciRatios[0].atoms';
  }],
  ['fibonacciRatios_element_scale', (v) => {
    v.fibonacciRatios = [
      { atoms: '236', scale: 2 },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
    ];
    return '$.fibonacciRatios[0].scale';
  }],
  ['fibonacciRatios_order', (v) => {
    v.fibonacciRatios = [
      { atoms: '786', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '382', scale: 3 },
      { atoms: '236', scale: 3 },
    ];
    return '$.fibonacciRatios[0].atoms';
  }],
  ['fibonacciRatios_add', (v) => {
    v.fibonacciRatios = [
      { atoms: '236', scale: 3 },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
      { atoms: '1000', scale: 3 },
    ];
    return '$.fibonacciRatios';
  }],
  ['fibonacciRatios_remove', (v) => {
    v.fibonacciRatios = [
      { atoms: '236', scale: 3 },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
    ];
    return '$.fibonacciRatios';
  }],
  ['fibonacciRatios_duplicate', (v) => {
    v.fibonacciRatios = [
      { atoms: '236', scale: 3 },
      { atoms: '236', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
    ];
    return '$.fibonacciRatios[1].atoms';
  }],
  ['fibonacciRatios_object', (v) => {
    v.fibonacciRatios = { 0: { atoms: '236', scale: 3 } }; return '$.fibonacciRatios';
  }],
  ['fibonacciRatios_atoms_type', (v) => {
    v.fibonacciRatios = [
      { atoms: 236, scale: 3 },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
    ];
    return '$.fibonacciRatios[0].atoms';
  }],
  ['fibonacciRatios_scale_type', (v) => {
    v.fibonacciRatios = [
      { atoms: '236', scale: '3' },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
    ];
    return '$.fibonacciRatios[0].scale';
  }],
  ['fibonacciRatios_unknown_key', (v) => {
    v.fibonacciRatios = [
      { atoms: '236', scale: 3, extra: true },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
    ];
    return '$.fibonacciRatios[0].extra';
  }],
  ['fibonacciRatios_missing_key', (v) => {
    v.fibonacciRatios = [
      { atoms: '236' },
      { atoms: '382', scale: 3 },
      { atoms: '500', scale: 3 },
      { atoms: '618', scale: 3 },
      { atoms: '786', scale: 3 },
    ];
    return '$.fibonacciRatios[0].scale';
  }],
  ['wrong_type_period', (v) => { v.cmfPeriod = '20'; return '$.cmfPeriod'; }],
];

for (const [name, mutate] of FIELD_MUTATIONS) {
  test(`L4A-B closed policy refuses mutation ${name}`, () => {
    const mutated = deepClonePolicyValues(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1);
    const path = mutate(mutated);
    assertClosedRefusal(mutated, path);
  });
}

test('L4A-B closed gate and field-shape checks jointly refuse unknown and missing fields', () => {
  const withAlien = deepClonePolicyValues(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1);
  withAlien.alienField = true;
  assert.throws(
    () => assertClosedMarketVolumeStructureFeaturePolicyValuesV1(withAlien),
    (error) => error.code === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1
      && error.details.path === '$.alienField',
  );
  assert.throws(() => normalizeMarketVolumeStructureFeatureComputationPolicyV1(
    fullPolicyFromValues(withAlien),
  ));
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1(fullPolicyFromValues(withAlien)));

  const missing = deepClonePolicyValues(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1);
  delete missing.mfiPeriod;
  assert.throws(
    () => assertClosedMarketVolumeStructureFeaturePolicyValuesV1(missing),
    (error) => error.code === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1
      && error.details.path === '$.mfiPeriod',
  );
  assert.throws(() => normalizeMarketVolumeStructureFeatureComputationPolicyV1(
    fullPolicyFromValues(missing),
  ));
  assert.throws(() => deriveMarketVolumeStructureRuntimePolicyV1(fullPolicyFromValues(missing)));
});
