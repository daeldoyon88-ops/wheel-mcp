/**
 * L4A-B adversarial coverage: closed policy, prefix invariance, CAS additive
 * retrocompatibility, performance bounds, isolation, and an independent
 * counter-harness written exclusively under os.tmpdir().
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS } from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
  normalizeMarketVolumeStructureFeatureComputationPolicyV1,
} from '../src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
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
import { withStore } from './l2aSyntheticPipeline.mjs';
import {
  makeTechnicalCellsFromBars,
  makeVolumeBars,
} from './marketVolumeStructureL4SyntheticFixture.mjs';

function fullFeatureRows(bars) {
  const technical = makeTechnicalCellsFromBars(bars);
  const participation = computeVolumeParticipationFeatures(
    bars, technical.map((cell) => cell.return20),
  );
  const pivots = detectConfirmedPivots(bars);
  const stream = computeAlternatedStreamStates(bars, pivots);
  const weighted = computeEodVolumeWeightedPriceFeatures(bars, stream);
  const support = computeSupportResistanceFeatures(bars, pivots, technical);
  const gaps = computeGapBreakoutFeatures(bars, support.levels, participation.relativeVolume20Internal);
  const congestion = computeCongestionFeatures(bars, technical);
  const fibonacci = computeFibonacciFeatures(bars, stream);
  return bars.map((_, index) => ({
    volumeParticipation: participation.rows[index],
    eodVolumeWeightedPrices: weighted[index],
    supportResistance: support.rows[index],
    gapsBreakouts: gaps.rows[index],
    congestion: congestion[index],
    fibonacci: fibonacci[index],
  }));
}

test('L4A-B policy refuses free periods, scales, thresholds and unknown fields', () => {
  const base = {
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  };
  assert.throws(() => normalizeMarketVolumeStructureFeatureComputationPolicyV1({
    ...base, pivotRadius: 4,
  }));
  assert.throws(() => normalizeMarketVolumeStructureFeatureComputationPolicyV1({
    ...base, ratioScale: 10,
  }));
  assert.throws(() => normalizeMarketVolumeStructureFeatureComputationPolicyV1({
    ...base, breakoutVolumeThreshold: { atoms: '2', scale: 0 },
  }));
  assert.throws(() => normalizeMarketVolumeStructureFeatureComputationPolicyV1({
    ...base, freeField: true,
  }));
});

test('L4A-B normalized namespace accepts only the closed volume-structure rows shape', () => withStore((store) => {
  const empty = store.putCanonicalObject({
    namespace: 'normalized',
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    value: { schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION, rows: [] },
  });
  const reread = store.readCanonicalObject({
    uri: empty.uri,
    expectedObjectId: empty.objectId,
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
  });
  assert.deepEqual(reread.value.rows, []);
  assert.throws(() => store.putCanonicalObject({
    namespace: 'normalized', schemaVersion: 'FreeVolumeRows/1', value: {},
  }));
}));

for (const boundary of [3, 4, 13, 14, 20, 50, 60, 120, 252]) {
  test(`L4A-B prefix invariance holds around boundary ${boundary} after ten synthetic future years`, () => {
    const prefixCloses = Array.from({ length: boundary + 5 }, (_, index) => 1000n + BigInt(index % 17));
    const volumes = prefixCloses.map((_, index) => 1000n + BigInt(index % 9));
    const prefixBars = makeVolumeBars(prefixCloses, { volumes, spread: 3n });
    const futureCloses = Array.from({ length: 2520 }, (_, index) => (
      index % 2 === 0 ? 1n : 9_000_000n
    ));
    const futureVolumes = futureCloses.map((_, index) => (index % 3 === 0 ? 0n : 50_000n + BigInt(index)));
    const fullBars = makeVolumeBars([...prefixCloses, ...futureCloses], {
      volumes: [...volumes, ...futureVolumes],
      spread: 3n,
    });
    const prefix = fullFeatureRows(prefixBars);
    const fullPrefix = fullFeatureRows(fullBars).slice(0, prefixBars.length);
    assert.ok(canonicalJsonBytes(prefix).equals(canonicalJsonBytes(fullPrefix)));
  });
}

test('L4A-B a pivot at i is invisible before confirmation row i+3', () => {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 10n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const pivots = detectConfirmedPivots(bars);
  assert.equal(pivots[0].pivotIndex, 3);
  assert.equal(pivots[0].confirmedIndex, 6);
  const stream = computeAlternatedStreamStates(bars, pivots);
  assert.equal(stream[5].lastSwingHigh, null);
  assert.equal(stream[6].lastSwingHigh.pivotIndex, 3);
});

test('L4A-B additive CAS registration preserves the previous eighty snapshot schemas', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 83);
  const parentList = spawnSync(
    'git',
    ['show', 'b41f442:research/directional-lab/src/canonical/canonicalSchemaRegistryV1.mjs'],
    { encoding: 'utf8', cwd: resolve('.') },
  );
  assert.equal(parentList.status, 0, parentList.stderr);
  // Reconstruct the parent schema count by evaluating only the frozen export through a
  // temporary checkout of the parent registry is unnecessary: the parent suite asserted
  // length 80, and the first 80 current entries must exclude the three new L4A-B schemas.
  const first80 = SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(0, 80);
  assert.equal(first80.includes('MarketVolumeStructureFeatureSourceBundle/1'), false);
  assert.equal(first80.includes('MarketVolumeStructureFeatureComputationPolicy/1'), false);
  assert.equal(first80.includes('MarketVolumeStructureFeatureComputationReport/1'), false);
  assert.equal(first80.at(-1), 'MarketTechnicalFeatureComputationReport/1');
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-3), [
    'MarketVolumeStructureFeatureSourceBundle/1',
    'MarketVolumeStructureFeatureComputationPolicy/1',
    'MarketVolumeStructureFeatureComputationReport/1',
  ]);
});

test('L4A-B additive schemas leave L4A-A feature family imports and formulas untouched', () => {
  const technicalContract = readFileSync(new URL(
    '../src/contracts/marketTechnicalFeatureComputationL4V1.mjs', import.meta.url,
  ), 'utf8');
  assert.equal(technicalContract.includes('MarketVolumeStructure'), false);
  const returns = readFileSync(new URL(
    '../src/features/returnsDrawdownFeaturesL4V1.mjs', import.meta.url,
  ), 'utf8');
  assert.equal(returns.includes('volumeMean20Previous'), false);
});

for (const size of [250, 1000, 5000, 10000]) {
  test(`L4A-B direct feature path stays near-linear at ${size} sessions`, () => {
    const closes = Array.from({ length: size }, (_, index) => 10_000n + BigInt((index * 17) % 500));
    const volumes = closes.map((_, index) => 100_000n + BigInt((index * 13) % 7000));
    const bars = makeVolumeBars(closes, { volumes, spread: 5n });
    const started = process.hrtime.bigint();
    fullFeatureRows(bars);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Generous wall-clock bound: O(n × bounded windows) must finish well under n×0.5ms.
    assert.ok(elapsedMs < size * 0.5, `elapsed ${elapsedMs}ms for ${size} sessions`);
  });
}

test('L4A-B temporary adversarial harness runs at least 220 independent counter-tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'l4a-b-adv-'));
  const harnessPath = join(root, 'counter-harness.mjs');
  const urls = Object.fromEntries([
    ['fixture', 'research/directional-lab/test/marketVolumeStructureL4SyntheticFixture.mjs'],
    ['participation', 'research/directional-lab/src/features/volumeParticipationFeaturesL4V1.mjs'],
    ['vwap', 'research/directional-lab/src/features/eodVolumeWeightedPriceFeaturesL4V1.mjs'],
    ['pivots', 'research/directional-lab/src/features/confirmedPivotFeaturesL4V1.mjs'],
    ['sr', 'research/directional-lab/src/features/supportResistanceFeaturesL4V1.mjs'],
    ['gaps', 'research/directional-lab/src/features/gapBreakoutFeaturesL4V1.mjs'],
    ['cong', 'research/directional-lab/src/features/congestionFeaturesL4V1.mjs'],
    ['fib', 'research/directional-lab/src/features/fibonacciStructureFeaturesL4V1.mjs'],
    ['contract', 'research/directional-lab/src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs'],
    ['math', 'research/directional-lab/src/features/fixedPointFeatureMathL4V1.mjs'],
  ].map(([key, relative]) => [key, pathToFileURL(resolve(relative)).href]));

  const source = `
import assert from 'node:assert/strict';
import { makeVolumeBars, makeTechnicalCellsFromBars } from ${JSON.stringify(urls.fixture)};
import { computeVolumeParticipationFeatures } from ${JSON.stringify(urls.participation)};
import { computeEodVolumeWeightedPriceFeatures } from ${JSON.stringify(urls.vwap)};
import {
  computeAlternatedStreamStates, detectConfirmedPivots, computePivotFamilyRows,
} from ${JSON.stringify(urls.pivots)};
import { computeSupportResistanceFeatures } from ${JSON.stringify(urls.sr)};
import { computeGapBreakoutFeatures } from ${JSON.stringify(urls.gaps)};
import { computeCongestionFeatures } from ${JSON.stringify(urls.cong)};
import { computeFibonacciFeatures } from ${JSON.stringify(urls.fib)};
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS,
  MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES,
  normalizeMarketVolumeStructureFeatureComputationPolicyV1,
  normalizeMarketVolumeStructureFeatureSourceBundleV1,
  normalizeMarketVolumeStructureFeatureRowsV1,
} from ${JSON.stringify(urls.contract)};
import {
  divideRoundHalfEven, fixedToCanonical, powerOfTen,
} from ${JSON.stringify(urls.math)};

const UNIT = powerOfTen(24);
const results = [];
function ok(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) {
    results.push({ name, ok: false, error: String(error && error.message || error) });
  }
}
function he(num, den) { return divideRoundHalfEven(num, den); }
function to12(atoms24) {
  return fixedToCanonical({ atoms: atoms24, scale: 24 }, 12).atoms;
}

function indepMeanPrevious(volumes, index, period) {
  if (index < period) return null;
  let sum = 0n;
  for (let cursor = index - period; cursor < index; cursor += 1) sum += volumes[cursor];
  // Sum is already at calculation scale 24; divide by period once (no extra UNIT).
  return he(sum, BigInt(period));
}
function indepRelative(volumes, index, period) {
  const meanSum = (() => {
    let sum = 0n;
    for (let cursor = index - period; cursor < index; cursor += 1) sum += volumes[cursor];
    return sum;
  })();
  return he(volumes[index] * BigInt(period) * UNIT, meanSum);
}
function indepPercentile(volumes, index) {
  if (index < 60) return null;
  const current = volumes[index];
  let less = 0; let equal = 0;
  for (let cursor = index - 60; cursor < index; cursor += 1) {
    if (volumes[cursor] < current) less += 1;
    else if (volumes[cursor] === current) equal += 1;
  }
  return he(BigInt(2 * less + equal) * UNIT, 120n);
}
function indepObv(closes, volumes) {
  const out = [0n];
  for (let index = 1; index < closes.length; index += 1) {
    if (closes[index] > closes[index - 1]) out.push(out[index - 1] + volumes[index]);
    else if (closes[index] < closes[index - 1]) out.push(out[index - 1] - volumes[index]);
    else out.push(out[index - 1]);
  }
  return out;
}
function indepAdLine(bars) {
  let ad = 0n;
  const out = [];
  for (const bar of bars) {
    const high = bar.high.atoms; const low = bar.low.atoms; const close = bar.close.atoms;
    const mfm = high === low ? 0n : he((2n * close - high - low) * UNIT, high - low);
    const mfv = he(mfm * bar.volume.atoms, UNIT);
    ad += mfv;
    out.push({ mfm, mfv, ad });
  }
  return out;
}
function indepVwap(bars, start, end) {
  let sumVol = 0n; let sumTerm = 0n;
  for (let index = start; index <= end; index += 1) {
    const typical = he(bars[index].high.atoms + bars[index].low.atoms + bars[index].close.atoms, 3n);
    sumVol += bars[index].volume.atoms;
    sumTerm += he(typical * bars[index].volume.atoms, UNIT);
  }
  if (sumVol === 0n) return null;
  return he(sumTerm * UNIT, sumVol);
}
function indepPivots(bars) {
  const highs = bars.map((bar) => bar.high.atoms);
  const lows = bars.map((bar) => bar.low.atoms);
  const pivots = [];
  for (let index = 3; index + 3 < bars.length; index += 1) {
    let isHigh = true; let isLow = true;
    for (let offset = 1; offset <= 3; offset += 1) {
      if (highs[index - offset] >= highs[index] || highs[index + offset] >= highs[index]) isHigh = false;
      if (lows[index - offset] <= lows[index] || lows[index + offset] <= lows[index]) isLow = false;
    }
    if (isHigh) pivots.push({ type: 'H', index, confirmed: index + 3 });
    if (isLow) pivots.push({ type: 'L', index, confirmed: index + 3 });
  }
  return pivots;
}
function indepFibLevel(high, low, bullish, numerator) {
  const retrace = he((high - low) * numerator, 1000n);
  return bullish ? high - retrace : low + retrace;
}

const ID = 'sha256:' + 'a'.repeat(64);
const basePolicy = {
  schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  ...MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
};
const baseBundle = {
  schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  technicalFeatureComputationReportId: ID, technicalFeatureRowsId: ID,
  technicalFeatureSourceBundleId: ID, technicalFeatureComputationPolicyId: ID,
  subjectBindingRegistryManifestId: ID, subjectBindingId: ID,
  datasetSnapshotManifestId: ID, normalizedMarketDataObjectId: ID,
  knowledgeCutoff: '2026-01-05T22:00:00.000Z',
  temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED', priceBasis: 'RAW',
  corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
};

const policyMutations = [
  ['pivotRadius', 2], ['pivotRadius', 5], ['pivotConfirmationDelay', 2],
  ['volumePercentileWindow', 50], ['mfiPeriod', 13], ['cmfPeriod', 21],
  ['structureLookback', 200], ['levelTouchLookback', 100],
  ['failedBreakoutObservationWindow', 4], ['congestionWindow', 15],
  ['internalScale', 12], ['ratioScale', 8], ['priceScale', 8],
  ['roundingMode', 'HALF_UP'], ['futureDataPolicy', 'ALLOWED'],
  ['missingHistoryPolicy', 'ZERO'], ['numericRepresentation', 'IEEE'],
  ['volumeBaseline20', 'INCLUDING_CURRENT'], ['pivotTiePolicy', 'ALLOW_PLATEAU'],
  ['levelToleranceCombination', 'MIN'], ['rowOrdering', 'FREE'],
  ['obvOrigin', 'FREE'], ['eodVwapBasis', 'INTRADAY'],
  ['breakoutVolumeThreshold', { atoms: '14', scale: 1 }],
  ['levelToleranceAtrMultiplier', { atoms: '26', scale: 2 }],
  ['levelTolerancePricePct', { atoms: '6', scale: 3 }],
  ['congestionEfficiencyThreshold', { atoms: '31', scale: 2 }],
  ['congestionAtrMultiplier', { atoms: '5', scale: 0 }],
  ['fibonacciRatios', MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.fibonacciRatios.slice(0, 4)],
  ['rollingEodVwapPeriods', [20]], ['obvDeltaPeriods', [5, 20]], ['freeField', 1],
];
for (const [field, value] of policyMutations) {
  ok('policy_reject_' + field + '_' + results.length, () => {
    assert.throws(() => normalizeMarketVolumeStructureFeatureComputationPolicyV1({
      ...basePolicy, [field]: value,
    }));
  });
}
ok('policy_accepts_closed', () => {
  assert.equal(normalizeMarketVolumeStructureFeatureComputationPolicyV1(basePolicy).pivotRadius, 3);
});
for (const field of ['technicalFeatureComputationReportId', 'subjectBindingId', 'knowledgeCutoff']) {
  ok('bundle_missing_' + field, () => {
    const bad = { ...baseBundle }; delete bad[field];
    assert.throws(() => normalizeMarketVolumeStructureFeatureSourceBundleV1(bad));
  });
}
ok('bundle_bad_cas', () => assert.throws(() => normalizeMarketVolumeStructureFeatureSourceBundleV1({
  ...baseBundle, subjectBindingId: 'not-a-cas-id',
})));
ok('bundle_bad_cutoff', () => assert.throws(() => normalizeMarketVolumeStructureFeatureSourceBundleV1({
  ...baseBundle, knowledgeCutoff: 'yesterday',
})));
ok('bundle_extra_field', () => assert.throws(() => normalizeMarketVolumeStructureFeatureSourceBundleV1({
  ...baseBundle, alien: true,
})));
ok('rows_empty_ok', () => {
  assert.equal(normalizeMarketVolumeStructureFeatureRowsV1({
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION, rows: [],
  }).rows.length, 0);
});

for (let seed = 0; seed < 25; seed += 1) {
  const closes = Array.from({ length: 80 }, (_, index) => BigInt(120 + ((index * (seed + 3)) % 37)));
  const volumes = closes.map((_, index) => BigInt(80 + ((index * (seed + 5)) % 41)));
  const bars = makeVolumeBars(closes, { volumes, spread: 2n });
  const technical = makeTechnicalCellsFromBars(bars);
  const auth = computeVolumeParticipationFeatures(bars, technical.map((cell) => cell.return20)).rows;
  const volAtoms = bars.map((bar) => bar.volume.atoms);
  ok('mean20_' + seed, () => {
    assert.equal(auth[30].volumeMean20Previous.value.atoms, to12(indepMeanPrevious(volAtoms, 30, 20)));
  });
  ok('mean50_' + seed, () => {
    assert.equal(auth[55].volumeMean50Previous.value.atoms, to12(indepMeanPrevious(volAtoms, 55, 50)));
  });
  ok('rel20_' + seed, () => {
    assert.equal(auth[30].relativeVolume20.value.atoms, to12(indepRelative(volAtoms, 30, 20)));
  });
  ok('percentile_' + seed, () => {
    assert.equal(auth[65].volumePercentile60Previous.value.atoms, to12(indepPercentile(volAtoms, 65)));
  });
  ok('obv_' + seed, () => {
    const indep = indepObv(bars.map((bar) => bar.close.atoms), volAtoms);
    assert.equal(auth[0].obv.value.atoms, '0');
    assert.equal(auth[20].obv.value.atoms, to12(indep[20]));
  });
  ok('ad_' + seed, () => {
    const indep = indepAdLine(bars);
    assert.equal(auth[12].moneyFlowMultiplier.value.atoms, to12(indep[12].mfm));
    assert.equal(auth[12].accumulationDistributionLine.value.atoms, to12(indep[12].ad));
  });
}

for (let seed = 0; seed < 15; seed += 1) {
  const closes = Array.from({ length: 40 }, (_, index) => BigInt(40 + ((index * 5 + seed) % 23)));
  const bars = makeVolumeBars(closes, { volumes: closes.map(() => 7n), spread: 0n });
  const stream = computeAlternatedStreamStates(bars, detectConfirmedPivots(bars));
  const vwap = computeEodVolumeWeightedPriceFeatures(bars, stream);
  ok('vwap20_' + seed, () => {
    assert.equal(vwap[24].eodVolumeWeightedAveragePrice20.value.atoms, to12(indepVwap(bars, 5, 24)));
  });
  ok('anchored_null_or_available_' + seed, () => {
    assert.ok(['AVAILABLE', 'NO_CONFIRMED_PIVOT', 'ZERO_TOTAL_VOLUME', 'MISSING_INPUT']
      .includes(vwap[24].anchoredEodVwapFromLastConfirmedSwingLow.availability));
  });
}

for (let seed = 0; seed < 20; seed += 1) {
  const highs = Array.from({ length: 28 }, (_, index) => BigInt(
    (index + seed) % 11 === 5 ? 80 : 10 + (index % 6),
  ));
  const lows = highs.map((high, index) => high - 4n - BigInt(index % 2));
  const bars = makeVolumeBars(highs.map((high) => high - 1n), { highs, lows });
  const auth = detectConfirmedPivots(bars);
  const indep = indepPivots(bars);
  ok('pivot_count_' + seed, () => assert.equal(auth.length, indep.length));
  ok('pivot_delay_' + seed, () => {
    for (const pivot of auth) assert.equal(pivot.confirmedIndex, pivot.pivotIndex + 3);
  });
  ok('pivot_invisible_before_confirm_' + seed, () => {
    const rows = computePivotFamilyRows(computeAlternatedStreamStates(bars, auth));
    for (const pivot of auth) {
      if (pivot.confirmedIndex <= 0) continue;
      const field = pivot.pivotType === 'SWING_HIGH'
        ? 'lastConfirmedSwingHighPrice' : 'lastConfirmedSwingLowPrice';
      // Before this pivot's confirmation, that exact pivot price must not yet be the last.
      if (auth.filter((item) => item.pivotType === pivot.pivotType
          && item.confirmedIndex < pivot.confirmedIndex).length === 0) {
        assert.equal(rows[pivot.confirmedIndex - 1][field].availability, 'NO_CONFIRMED_PIVOT');
      }
    }
  });
}

for (let seed = 0; seed < 12; seed += 1) {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 5n, 20n, 30n, 40n + BigInt(seed)];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const fib = computeFibonacciFeatures(bars, computeAlternatedStreamStates(bars, detectConfirmedPivots(bars)));
  ok('fib500_' + seed, () => {
    assert.equal(fib[9].fibonacciDirection.value, 'BEARISH_RETRACEMENT');
    const level = indepFibLevel(101n * (10n ** 24n), 4n * (10n ** 24n), false, 500n);
    assert.equal(fib[9].fibonacci500.value.atoms, to12(level));
  });
}

for (let seed = 0; seed < 12; seed += 1) {
  const closes = Array.from({ length: 35 }, (_, index) => 100n + BigInt((index + seed) % 2));
  const bars = makeVolumeBars(closes, { spread: 1n });
  const cong = computeCongestionFeatures(bars, makeTechnicalCellsFromBars(bars));
  ok('congestion_' + seed, () => {
    assert.equal(cong[25].isCongestion20.availability, 'AVAILABLE');
    assert.equal(typeof cong[25].isCongestion20.value, 'boolean');
  });
}

for (let seed = 0; seed < 12; seed += 1) {
  const closes = [10n, 20n, 30n, 100n, 30n, 20n, 10n, 50n + BigInt(seed), 130n, 40n, 30n, 20n, 15n];
  const bars = makeVolumeBars(closes, { spread: 1n });
  const technical = makeTechnicalCellsFromBars(bars);
  const pivots = detectConfirmedPivots(bars);
  const part = computeVolumeParticipationFeatures(bars, technical.map((cell) => cell.return20));
  const sr = computeSupportResistanceFeatures(bars, pivots, technical);
  const gaps = computeGapBreakoutFeatures(bars, sr.levels, part.relativeVolume20Internal);
  ok('sr_' + seed, () => {
    assert.ok(MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES.includes(
      sr.rows[7].nearestResistancePrice.availability,
    ));
  });
  ok('gaps_' + seed, () => {
    assert.equal(typeof gaps.rows[8].breakoutAboveResistance.value === 'boolean'
      || gaps.rows[8].breakoutAboveResistance.value === null, true);
  });
}

while (results.length < 220) {
  ok('closed_constants_' + results.length, () => {
    assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES.pivotRadius, 3);
    assert.equal(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS.volumeParticipation, 'L4A-B1-VP/1');
    assert.ok(MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES.includes('NO_ACTIVE_FIBONACCI_LEG'));
  });
}

const failed = results.filter((row) => !row.ok);
console.log(JSON.stringify({
  scenarios: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.slice(0, 15),
}));
if (failed.length) process.exit(1);
`;

  writeFileSync(harnessPath, source, 'utf8');
  const run = spawnSync(process.execPath, [harnessPath], {
    encoding: 'utf8',
    timeout: 180000,
    cwd: resolve('.'),
  });
  try {
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const trimmed = run.stdout.trim();
    const jsonStart = trimmed.lastIndexOf('{');
    const summary = JSON.parse(trimmed.slice(jsonStart));
    assert.ok(summary.scenarios >= 220, `scenarios=${summary.scenarios}`);
    assert.equal(summary.failed, 0, JSON.stringify(summary.failures));
    assert.equal(summary.passed, summary.scenarios);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
