/** Deterministic fixed-point elementary statistics for L4A-C1. */

import {
  divideRoundHalfEven,
  fixedFromCanonical,
  fixedToCanonical,
  powerOfTen,
  squareRootFixed,
} from './fixedPointFeatureMathL4V1.mjs';
import { assertMarketSeasonalityRuntimePolicyV1 } from './marketSeasonalityRuntimePolicyL4V1.mjs';

function atInternal(value, runtime) {
  if (value === null || typeof value !== 'object') throw new TypeError('seasonality statistic requires fixed values');
  if (typeof value.atoms === 'bigint') {
    if (value.scale !== runtime.internalScale) throw new RangeError('internal seasonality scale mismatch');
    return value.atoms;
  }
  return fixedFromCanonical(value, runtime.internalScale).atoms;
}

function canonical(atoms, runtime) {
  return fixedToCanonical({ atoms, scale: runtime.internalScale }, runtime.ratioScale);
}

function sortedAtoms(values, runtime) {
  return values.map((value) => atInternal(value, runtime)).sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function meanSeasonalityFixedV1(values, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  if (!Array.isArray(values) || values.length === 0) return null;
  const sum = values.reduce((total, value) => total + atInternal(value, runtime), 0n);
  return canonical(divideRoundHalfEven(sum, BigInt(values.length)), runtime);
}

export function medianSeasonalityFixedV1(values, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = sortedAtoms(values, runtime);
  const middle = Math.floor(sorted.length / 2);
  const atoms = sorted.length % 2 === 1
    ? sorted[middle]
    : divideRoundHalfEven(sorted[middle - 1] + sorted[middle], 2n);
  return canonical(atoms, runtime);
}

export function quantileSeasonalityFixedV1(values, probabilityNumerator, probabilityDenominator, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  if (!Array.isArray(values) || values.length === 0) return null;
  if (typeof probabilityNumerator !== 'bigint' || typeof probabilityDenominator !== 'bigint'
      || probabilityDenominator <= 0n || probabilityNumerator < 0n
      || probabilityNumerator > probabilityDenominator) {
    throw new RangeError('quantile probability must be an exact fraction in [0, 1]');
  }
  const sorted = sortedAtoms(values, runtime);
  if (sorted.length === 1) return canonical(sorted[0], runtime);
  const positionNumerator = BigInt(sorted.length - 1) * probabilityNumerator;
  const lowerIndex = Number(positionNumerator / probabilityDenominator);
  const remainder = positionNumerator % probabilityDenominator;
  if (remainder === 0n) return canonical(sorted[lowerIndex], runtime);
  const upperIndex = Math.min(lowerIndex + 1, sorted.length - 1);
  const atoms = sorted[lowerIndex] + divideRoundHalfEven(
    (sorted[upperIndex] - sorted[lowerIndex]) * remainder,
    probabilityDenominator,
  );
  return canonical(atoms, runtime);
}

export function sampleStandardDeviationSeasonalityFixedV1(values, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  if (!Array.isArray(values) || values.length < 2) return null;
  const atoms = values.map((value) => atInternal(value, runtime));
  const mean = divideRoundHalfEven(
    atoms.reduce((total, value) => total + value, 0n), BigInt(atoms.length),
  );
  const sumSquares = atoms.reduce((total, value) => {
    const deviation = value - mean;
    return total + deviation * deviation;
  }, 0n);
  const varianceAtoms = divideRoundHalfEven(sumSquares, BigInt(atoms.length - 1));
  const root = squareRootFixed(
    { atoms: varianceAtoms, scale: runtime.internalScale * 2 }, runtime.ratioScale,
  );
  return { atoms: root.atoms === 0n ? '0' : root.atoms.toString(), scale: runtime.ratioScale };
}

function rate(count, total, runtime) {
  if (total === 0) return null;
  const atoms = divideRoundHalfEven(BigInt(count) * powerOfTen(runtime.ratioScale), BigInt(total));
  return { atoms: atoms === 0n ? '0' : atoms.toString(), scale: runtime.ratioScale };
}

/** Aggregate one horizon/window occurrence set. */
export function calculateSeasonalityStatisticsV1(occurrences, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  if (!Array.isArray(occurrences)) throw new TypeError('occurrences must be an array');
  const returns = occurrences.map((occurrence) => occurrence.returnValue);
  const adverse = occurrences.map((occurrence) => occurrence.maxAdverseExcursion);
  const favorable = occurrences.map((occurrence) => occurrence.maxFavorableExcursion);
  const internalReturns = returns.map((value) => atInternal(value, runtime));
  const bullishCount = internalReturns.filter((atoms) => atoms > 0n).length;
  const bearishCount = internalReturns.filter((atoms) => atoms < 0n).length;
  const flatCount = internalReturns.length - bullishCount - bearishCount;
  const sorted = [...internalReturns].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return {
    occurrenceCount: occurrences.length,
    distinctYearCount: new Set(occurrences.map((occurrence) => occurrence.historicalYear)).size,
    bullishCount,
    bearishCount,
    flatCount,
    bullishRate: rate(bullishCount, occurrences.length, runtime),
    bearishRate: rate(bearishCount, occurrences.length, runtime),
    meanReturn: meanSeasonalityFixedV1(returns, runtime),
    medianReturn: medianSeasonalityFixedV1(returns, runtime),
    minimumReturn: sorted.length === 0 ? null : canonical(sorted[0], runtime),
    maximumReturn: sorted.length === 0 ? null : canonical(sorted.at(-1), runtime),
    returnStdSample: sampleStandardDeviationSeasonalityFixedV1(returns, runtime),
    lowerQuantile25: quantileSeasonalityFixedV1(returns, 1n, 4n, runtime),
    upperQuantile75: quantileSeasonalityFixedV1(returns, 3n, 4n, runtime),
    medianMaxAdverseExcursion: medianSeasonalityFixedV1(adverse, runtime),
    medianMaxFavorableExcursion: medianSeasonalityFixedV1(favorable, runtime),
  };
}
