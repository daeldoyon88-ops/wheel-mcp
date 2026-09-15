/**
 * GATE25 distance: D6 GATE25_DISTANCE_PARAMETERS_V1.
 *
 * Manhattan L1 over exactly the OD-2 dimensions F1_SIMPLE_RETURN@W5 and
 * F1_SIMPLE_RETURN@W21. Per-dimension min-max normalization over the frozen
 * eligible HISTORICAL candidate universe for query T; the query observation is
 * never part of that population. max == min keeps the dimension with every
 * normalized value and its component distance at 0.
 *
 * No weights, no epsilon, no tolerance, no intermediate rounding. Finite numbers
 * only: a non-finite input, intermediate or result fails closed.
 */

import { failClosed, isPlainObject } from './analogue-identity-v1.mjs';

export const DISTANCE_PARAMETER_SET_ID_V1 = 'GATE25_DISTANCE_PARAMETERS_V1';
export const DISTANCE_METRIC_V1 = 'MANHATTAN_L1';
export const NORMALIZATION_METHOD_V1 = 'PER_DIMENSION_MIN_MAX';
export const NORMALIZATION_POPULATION_V1 = 'ELIGIBLE_HISTORICAL_CANDIDATE_UNIVERSE_FOR_QUERY_T';

/** OD-2: exactly these distance dimensions, in this order. */
export const DISTANCE_FEATURE_IDS_V1 = Object.freeze(['F1_SIMPLE_RETURN@W5', 'F1_SIMPLE_RETURN@W21']);

/** Configuration surfaces the parameter set does not have; requesting one is refused. */
export const FORBIDDEN_DISTANCE_PARAMETER_KEYS_V1 = Object.freeze([
  'weights', 'weight', 'featureWeights', 'epsilon', 'tolerance', 'rounding', 'roundingDigits',
  'precision', 'clamp', 'threshold', 'distanceThreshold', 'k', 'neighbourCount', 'neighborCount',
  'metric', 'additionalFeatureIds',
]);

export function assertDistanceParameterRequest(request = {}) {
  if (!isPlainObject(request)) failClosed('DISTANCE_PARAMETER_REQUEST_INVALID');
  const forbidden = Object.keys(request).find((key) => FORBIDDEN_DISTANCE_PARAMETER_KEYS_V1.includes(key));
  if (forbidden !== undefined) failClosed('DISTANCE_PARAMETER_FORBIDDEN', { key: forbidden });
  if (Object.hasOwn(request, 'distanceFeatureIds')) {
    const ids = request.distanceFeatureIds;
    if (!Array.isArray(ids) || ids.length !== DISTANCE_FEATURE_IDS_V1.length
      || ids.some((id, index) => id !== DISTANCE_FEATURE_IDS_V1[index])) {
      failClosed('DISTANCE_FEATURE_SET_NOT_OD2', { distanceFeatureIds: ids });
    }
  }
  return true;
}

/** CanonicalJSON/1 refuses -0; +0 and -0 are numerically identical, so this is not rounding. */
const positiveZero = (value) => (value === 0 ? 0 : value);

function finite(value, code, details) {
  if (typeof value !== 'number' || !Number.isFinite(value)) failClosed(code, details);
  return positiveZero(value);
}

/**
 * Per-dimension bounds over the eligible historical population only. The caller
 * passes candidate feature vectors; there is no parameter through which a query
 * value could enter the population.
 */
export function computeNormalizationBounds(populationFeatureVectors) {
  if (!Array.isArray(populationFeatureVectors) || populationFeatureVectors.length === 0) {
    failClosed('NORMALIZATION_POPULATION_EMPTY');
  }
  return Object.freeze(DISTANCE_FEATURE_IDS_V1.map((featureId) => {
    let min = Infinity;
    let max = -Infinity;
    populationFeatureVectors.forEach((vector, index) => {
      const value = finite(vector?.[featureId], 'NORMALIZATION_POPULATION_VALUE_NOT_FINITE', { featureId, index });
      if (value < min) min = value;
      if (value > max) max = value;
    });
    return Object.freeze({ featureId, min: positiveZero(min), max: positiveZero(max), zeroRange: max === min });
  }));
}

/**
 * normalized = (x - min) / (max - min); the zero-range rule is applied by the caller.
 * Every intermediate must be finite: an overflowing range or offset fails closed
 * instead of silently collapsing the dimension.
 */
export function normalizeValue(value, { min, max }) {
  if (max === min) failClosed('ZERO_RANGE_NORMALIZATION_NOT_DEFINED');
  const range = finite(max - min, 'NORMALIZED_VALUE_NOT_FINITE', { value, min, max });
  const offset = finite(value - min, 'NORMALIZED_VALUE_NOT_FINITE', { value, min, max });
  return finite(offset / range, 'NORMALIZED_VALUE_NOT_FINITE', { value, min, max });
}

function assertBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== DISTANCE_FEATURE_IDS_V1.length) failClosed('NORMALIZATION_BOUNDS_INVALID');
  bounds.forEach((bound, index) => {
    if (bound?.featureId !== DISTANCE_FEATURE_IDS_V1[index]) failClosed('NORMALIZATION_BOUNDS_ORDER_INVALID', { index });
    finite(bound.min, 'NORMALIZATION_BOUND_NOT_FINITE', { featureId: bound.featureId });
    finite(bound.max, 'NORMALIZATION_BOUND_NOT_FINITE', { featureId: bound.featureId });
    if (bound.max < bound.min) failClosed('NORMALIZATION_BOUNDS_INVERTED', { featureId: bound.featureId });
  });
}

/**
 * Distance evidence for one historical analogue against query T:
 *   componentDistance = |queryNormalizedValue - candidateNormalizedValue|
 *   finalDistance     = sum of componentDistance in DISTANCE_FEATURE_IDS_V1 order
 */
export function computeDistanceEvidence({ queryFeatureValues, candidateFeatureValues, bounds }) {
  assertBounds(bounds);
  let finalDistance = 0;
  const distanceComponents = [];
  const differences = [];
  DISTANCE_FEATURE_IDS_V1.forEach((featureId, index) => {
    const bound = bounds[index];
    const queryRawValue = finite(queryFeatureValues?.[featureId], 'QUERY_DISTANCE_FEATURE_NOT_FINITE', { featureId });
    const candidateRawValue = finite(candidateFeatureValues?.[featureId], 'CANDIDATE_DISTANCE_FEATURE_NOT_FINITE', { featureId });
    const zeroRange = bound.max === bound.min;
    const queryNormalizedValue = zeroRange ? 0 : normalizeValue(queryRawValue, bound);
    const candidateNormalizedValue = zeroRange ? 0 : normalizeValue(candidateRawValue, bound);
    const absoluteNormalizedDelta = zeroRange
      ? 0
      : finite(Math.abs(queryNormalizedValue - candidateNormalizedValue), 'COMPONENT_DISTANCE_NOT_FINITE', { featureId });
    finalDistance += absoluteNormalizedDelta;
    distanceComponents.push(Object.freeze({ featureId, componentDistance: absoluteNormalizedDelta, zeroRange }));
    differences.push(Object.freeze({
      featureId,
      queryRawValue,
      candidateRawValue,
      min: bound.min,
      max: bound.max,
      queryNormalizedValue,
      candidateNormalizedValue,
      absoluteNormalizedDelta,
    }));
  });
  return Object.freeze({
    finalDistance: finite(finalDistance, 'FINAL_DISTANCE_NOT_FINITE'),
    distanceComponents: Object.freeze(distanceComponents),
    differences: Object.freeze(differences),
  });
}

export function describeDistanceParameters() {
  return Object.freeze({
    parameterSetId: DISTANCE_PARAMETER_SET_ID_V1,
    distance: DISTANCE_METRIC_V1,
    distanceFeatureIds: DISTANCE_FEATURE_IDS_V1,
    normalization: NORMALIZATION_METHOD_V1,
    population: NORMALIZATION_POPULATION_V1,
    queryObservationInPopulation: false,
    zeroRange: { queryNormalizedValue: 0, candidateNormalizedValue: 0, componentDistance: 0, dimensionRetained: true },
    weights: 'NONE',
    epsilon: 'NONE',
    tolerance: 'NONE',
    intermediateRounding: 'FORBIDDEN',
  });
}
