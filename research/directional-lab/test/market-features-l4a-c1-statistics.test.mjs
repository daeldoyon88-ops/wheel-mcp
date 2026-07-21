import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateSeasonalityStatisticsV1,
  meanSeasonalityFixedV1,
  medianSeasonalityFixedV1,
  quantileSeasonalityFixedV1,
  sampleStandardDeviationSeasonalityFixedV1,
} from '../src/features/marketSeasonalityStatisticsL4V1.mjs';
import { MARKET_SEASONALITY_RUNTIME_POLICY_V1 as RUNTIME } from '../src/features/marketSeasonalityRuntimePolicyL4V1.mjs';

const fixed = (atoms, scale = 12) => ({ atoms: String(atoms), scale });
const internal = (atoms) => ({ atoms: BigInt(atoms) * (10n ** 12n), scale: 24 });

test('L4A-C1 mean and medians use exact HALF_EVEN fixed-point arithmetic', () => {
  assert.deepEqual(meanSeasonalityFixedV1([fixed('1'), fixed('2')], RUNTIME), fixed('2'));
  assert.deepEqual(medianSeasonalityFixedV1([fixed('9'), fixed('1'), fixed('5')], RUNTIME), fixed('5'));
  assert.deepEqual(medianSeasonalityFixedV1([fixed('1'), fixed('4')], RUNTIME), fixed('2'));
  assert.deepEqual(medianSeasonalityFixedV1([fixed('2'), fixed('5')], RUNTIME), fixed('4'));
});

test('L4A-C1 inclusive n-minus-one quantiles cover n=1..5 and negatives', () => {
  const vectors = [
    [[0], '0', '0'],
    [[0, 4], '1', '3'],
    [[0, 4, 8], '2', '6'],
    [[0, 4, 8, 12], '3', '9'],
    [[0, 4, 8, 12, 16], '4', '12'],
    [[-8, -4, 0], '-6', '-2'],
  ];
  for (const [atoms, q25, q75] of vectors) {
    const values = atoms.map((value) => fixed(value));
    assert.equal(quantileSeasonalityFixedV1(values, 1n, 4n, RUNTIME).atoms, q25);
    assert.equal(quantileSeasonalityFixedV1(values, 3n, 4n, RUNTIME).atoms, q75);
  }
  assert.equal(quantileSeasonalityFixedV1([fixed('0'), fixed('2')], 1n, 4n, RUNTIME).atoms, '0');
  assert.equal(quantileSeasonalityFixedV1([fixed('0'), fixed('2')], 3n, 4n, RUNTIME).atoms, '2');
});

test('L4A-C1 sample standard deviation is null for n=1 and deterministic for n=2', () => {
  assert.equal(sampleStandardDeviationSeasonalityFixedV1([fixed('1')], RUNTIME), null);
  assert.deepEqual(
    sampleStandardDeviationSeasonalityFixedV1([fixed('0'), fixed('2000000000000')], RUNTIME),
    fixed('1414213562373'),
  );
});

test('L4A-C1 aggregate keeps horizon-local counts, rates, quantiles and excursions', () => {
  const occurrences = [
    { historicalYear: 2021, returnValue: internal(-2), maxAdverseExcursion: internal(-4), maxFavorableExcursion: internal(1) },
    { historicalYear: 2022, returnValue: internal(0), maxAdverseExcursion: internal(-1), maxFavorableExcursion: internal(2) },
    { historicalYear: 2023, returnValue: internal(4), maxAdverseExcursion: internal(1), maxFavorableExcursion: internal(6) },
  ];
  const stats = calculateSeasonalityStatisticsV1(occurrences, RUNTIME);
  assert.equal(stats.occurrenceCount, 3);
  assert.equal(stats.distinctYearCount, 3);
  assert.deepEqual([stats.bullishCount, stats.bearishCount, stats.flatCount], [1, 1, 1]);
  assert.equal(stats.bullishRate.atoms, '333333333333');
  assert.equal(stats.bearishRate.atoms, '333333333333');
  assert.equal(stats.minimumReturn.atoms, '-2');
  assert.equal(stats.maximumReturn.atoms, '4');
  assert.equal(stats.medianMaxAdverseExcursion.atoms, '-1');
  assert.equal(stats.medianMaxFavorableExcursion.atoms, '2');
});

test('L4A-C1 empty aggregate emits null statistics rather than false zeros', () => {
  const stats = calculateSeasonalityStatisticsV1([], RUNTIME);
  assert.equal(stats.occurrenceCount, 0);
  assert.equal(stats.meanReturn, null);
  assert.equal(stats.bullishRate, null);
  assert.equal(stats.medianMaxAdverseExcursion, null);
});
