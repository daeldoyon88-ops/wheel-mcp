/** Closed V1 values and own-key gate for L4A-C1 seasonality computation. */

import { MarketDataL3Error } from './marketDataL3CommonV1.mjs';
import { isPlainObject } from './contractPrimitivesV1.mjs';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1 = deepFreeze({
  priceBasisPolicy: 'USE_BINDING_PIN_ONLY',
  horizons: [3, 5, 10, 15],
  forwardSessionCounts: [5, 10, 20, 40, 60],
  minimumOccurrenceCount: 3,
  calendarAlignment: 'CIVIL_MONTH_DAY_ON_OR_AFTER_START',
  returnFormula: 'CLOSE_END_OVER_CLOSE_START_MINUS_ONE',
  flatThreshold: 'EXACT_ZERO_AT_RATIO_SCALE',
  numericRepresentation: 'FIXED_POINT_ATOMS_SCALE',
  internalScale: 24,
  ratioScale: 12,
  roundingMode: 'HALF_EVEN',
  leapDayPolicy: 'LEAP_DAY_PREVIOUS_CIVIL_DAY',
  week53Policy: 'UNSUPPORTED',
  crossYearPolicy: 'ALLOWED_IF_CAUSAL',
  currentYearPolicy: 'EXCLUDE_FROM_HISTORICAL_UNTIL_COMPLETE',
  quantileDefinition: 'LINEAR_INCLUSIVE_N_MINUS_ONE_V1',
  missingHistoryPolicy: 'NULL_WITH_REASON',
  futureDataPolicy: 'FORBIDDEN',
  rowOrdering: 'SESSION_DATE_THEN_BAR_IDENTITY',
});

export const MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1 =
  'MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1';

function symbolPath(symbol) {
  const global = Symbol.keyFor(symbol);
  if (global !== undefined) return `Symbol.for(${JSON.stringify(global)})`;
  return symbol.description === undefined ? 'Symbol()' : `Symbol(${symbol.description})`;
}

function childPath(path, key) {
  return typeof key === 'symbol' ? `${path}[${symbolPath(key)}]` : `${path}.${key}`;
}

function enumerableDataDescriptor(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
    return null;
  }
  return descriptor;
}

/** Return the first deterministic mismatch path against the unique V1 canon. */
export function findClosedMarketSeasonalityFeaturePolicyMismatchPathV1(
  expected, actual, path = '$',
) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || Object.getPrototypeOf(actual) !== Array.prototype
        || actual.length !== expected.length) return path;
    for (let index = 0; index < expected.length; index += 1) {
      const descriptor = enumerableDataDescriptor(actual, String(index));
      if (descriptor === null) return `${path}[${index}]`;
      const mismatch = findClosedMarketSeasonalityFeaturePolicyMismatchPathV1(
        expected[index], descriptor.value, `${path}[${index}]`,
      );
      if (mismatch !== null) return mismatch;
    }
    const allowed = new Set(['length', ...expected.map((_, index) => String(index))]);
    const extras = Reflect.ownKeys(actual)
      .filter((key) => typeof key === 'string' && !allowed.has(key)).sort();
    if (extras.length > 0) return childPath(path, extras[0]);
    const symbols = Reflect.ownKeys(actual).filter((key) => typeof key === 'symbol')
      .sort((left, right) => symbolPath(left).localeCompare(symbolPath(right)));
    return symbols.length === 0 ? null : childPath(path, symbols[0]);
  }
  if (expected !== null && typeof expected === 'object') {
    if (!isPlainObject(actual)) return path;
    const expectedKeys = Object.keys(expected).sort();
    for (const key of expectedKeys) {
      const descriptor = enumerableDataDescriptor(actual, key);
      if (descriptor === null) return childPath(path, key);
      const mismatch = findClosedMarketSeasonalityFeaturePolicyMismatchPathV1(
        expected[key], descriptor.value, childPath(path, key),
      );
      if (mismatch !== null) return mismatch;
    }
    const allowed = new Set(expectedKeys);
    const extras = Reflect.ownKeys(actual)
      .filter((key) => typeof key === 'string' && !allowed.has(key)).sort();
    if (extras.length > 0) return childPath(path, extras[0]);
    const symbols = Reflect.ownKeys(actual).filter((key) => typeof key === 'symbol')
      .sort((left, right) => symbolPath(left).localeCompare(symbolPath(right)));
    return symbols.length === 0 ? null : childPath(path, symbols[0]);
  }
  return Object.is(expected, actual) ? null : path;
}

export function assertClosedMarketSeasonalityFeaturePolicyValuesV1(actual) {
  const path = findClosedMarketSeasonalityFeaturePolicyMismatchPathV1(
    MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1, actual,
  );
  if (path !== null) {
    throw new MarketDataL3Error(
      MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1,
      `seasonality policy values are not the closed V1 canon at ${path}`,
      { path },
    );
  }
  return actual;
}

/** Drop schemaVersion while preserving every other own-key descriptor. */
export function extractMarketSeasonalityFeaturePolicyValuesV1(policy) {
  if (!isPlainObject(policy)) {
    throw new MarketDataL3Error(
      MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1,
      'seasonality policy values are not the closed V1 canon at $',
      { path: '$' },
    );
  }
  const values = {};
  for (const key of Reflect.ownKeys(policy)) {
    if (key === 'schemaVersion') continue;
    const descriptor = Object.getOwnPropertyDescriptor(policy, key);
    if (descriptor !== undefined) Object.defineProperty(values, key, descriptor);
  }
  return values;
}
