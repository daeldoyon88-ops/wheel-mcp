/**
 * Unique canonical V1 values for the closed L4A-B computation policy.
 * The object is deeply immutable and is shared by the contract and builder;
 * moving it here must not alter the canonical policy bytes or object ID.
 */

import { MarketDataL3Error } from './marketDataL3CommonV1.mjs';
import { isPlainObject } from './contractPrimitivesV1.mjs';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Exact non-float scalar: canonical fixed-point atoms at a closed scale. */
function fixed(atoms, scale) {
  return { atoms, scale };
}

export const MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1 = deepFreeze({
  numericRepresentation: 'FIXED_POINT_BIGINT_V1',
  internalScale: 24,
  ratioScale: 12,
  priceScale: 12,
  roundingMode: 'HALF_EVEN',
  rowOrdering: 'SESSION_DATE_THEN_BAR_IDENTITY',
  futureDataPolicy: 'FORBIDDEN',
  missingHistoryPolicy: 'NULL_WITH_REASON',
  volumeBaseline20: 'PREVIOUS_SESSIONS_EXCLUDING_CURRENT',
  volumeBaseline50: 'PREVIOUS_SESSIONS_EXCLUDING_CURRENT',
  volumePercentileWindow: 60,
  obvOrigin: 'ZERO_AT_SNAPSHOT_START',
  obvDeltaPeriods: [5, 20, 60],
  adLineOrigin: 'ZERO_BEFORE_SNAPSHOT_START',
  adLineDeltaPeriod: 20,
  flatRangeMoneyFlowConvention: 'ZERO_MULTIPLIER_AND_ZERO_MONEY_FLOW_VOLUME',
  mfiPeriod: 14,
  cmfPeriod: 20,
  rollingEodVwapPeriods: [20, 60],
  eodVwapBasis: 'EOD_APPROXIMATION_FROM_DAILY_OHLCV_NOT_EXCHANGE_INTRADAY_VWAP',
  anchoredEodVwapActivation: 'FROM_PIVOT_CONFIRMATION_INCLUDING_BARS_SINCE_PIVOT_SESSION',
  priceVolumeComparisonPeriod: 20,
  pivotRadius: 3,
  pivotTiePolicy: 'STRICT_NO_PLATEAU',
  pivotConfirmationDelay: 3,
  pivotSameSessionOrder: 'SWING_LOW_FIRST',
  pivotStreamCompression: 'KEEP_EXTREME_THEN_MOST_RECENTLY_CONFIRMED',
  structureLookback: 252,
  levelTouchLookback: 120,
  levelTieBreak: 'MOST_RECENTLY_CONFIRMED',
  levelToleranceAtrMultiplier: fixed('25', 2),
  levelTolerancePricePct: fixed('5', 3),
  levelToleranceCombination: 'MAX',
  breakoutVolumeThreshold: fixed('15', 1),
  failedBreakoutObservationWindow: 5,
  openGapLookback: 252,
  openGapSidePolicy: 'EXCLUDE_GAPS_STRADDLING_CLOSE',
  openGapTieBreak: 'NEAREST_BOUNDARY_THEN_MOST_RECENT_SESSION',
  congestionWindow: 20,
  congestionReferenceWindow: 60,
  congestionEfficiencyThreshold: fixed('30', 2),
  congestionAtrMultiplier: fixed('4', 0),
  fibonacciRatios: [
    fixed('236', 3),
    fixed('382', 3),
    fixed('500', 3),
    fixed('618', 3),
    fixed('786', 3),
  ],
});

export const MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1 =
  'MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1';

/**
 * Stable Symbol path fragment for deterministic closed-policy errors.
 * Global symbols use Symbol.for("key"); others use Symbol(description) or Symbol().
 * @param {symbol} key
 * @returns {string}
 */
function formatClosedPolicySymbolKeyV1(key) {
  const globalKey = Symbol.keyFor(key);
  if (globalKey !== undefined) return `Symbol.for(${JSON.stringify(globalKey)})`;
  if (key.description === undefined) return 'Symbol()';
  return `Symbol(${key.description})`;
}

/**
 * @param {string} path
 * @param {string | symbol} key
 * @returns {string}
 */
function closedPolicyOwnKeyPathV1(path, key) {
  if (typeof key === 'symbol') return `${path}[${formatClosedPolicySymbolKeyV1(key)}]`;
  return `${path}.${key}`;
}

/**
 * Normative own data property: own, enumerable, data (not accessor).
 * writable/configurable are intentionally non-normative so mutable deep copies pass.
 * @param {object} value
 * @param {string | symbol} key
 * @returns {PropertyDescriptor | null}
 */
function getClosedPolicyEnumerableDataDescriptorV1(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return null;
  if (!descriptor.enumerable) return null;
  if ('get' in descriptor || 'set' in descriptor) return null;
  return descriptor;
}

/**
 * Recursive closed comparison against the unique V1 canon.
 * Inspects all own keys (enumerable, non-enumerable, Symbol).
 * Object string-key insertion order is ignored for acceptance; array order is significant.
 * Returns the first deterministic JSON-path mismatch, or null when closed.
 *
 * Deterministic mismatch priority at each node:
 * 1. canonical string keys missing/invalid (sorted string order);
 * 2. extra string own keys (sorted);
 * 3. Symbol own keys (sorted by formatClosedPolicySymbolKeyV1);
 * 4. nested mismatches under the same rules.
 *
 * Proxy limitation: a Proxy can forge getOwnPropertyDescriptor/ownKeys answers;
 * this gate does not claim perfect Proxy detection.
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} path
 * @returns {string | null}
 */
export function findClosedMarketVolumeStructureFeaturePolicyMismatchPathV1(
  expected, actual, path = '$',
) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return path;
    if (Object.getPrototypeOf(actual) !== Array.prototype) return path;
    if (expected.length !== actual.length) return path;

    for (let index = 0; index < expected.length; index += 1) {
      const indexKey = String(index);
      const descriptor = getClosedPolicyEnumerableDataDescriptorV1(actual, indexKey);
      if (descriptor === null) return `${path}[${index}]`;
      const child = findClosedMarketVolumeStructureFeaturePolicyMismatchPathV1(
        expected[index], descriptor.value, `${path}[${index}]`,
      );
      if (child !== null) return child;
    }

    const allowed = new Set(
      Array.from({ length: expected.length }, (_, index) => String(index)),
    );
    allowed.add('length');
    const ownKeys = Reflect.ownKeys(actual);
    const extraStrings = ownKeys
      .filter((key) => typeof key === 'string' && !allowed.has(key))
      .sort();
    if (extraStrings.length > 0) return closedPolicyOwnKeyPathV1(path, extraStrings[0]);
    const symbols = ownKeys
      .filter((key) => typeof key === 'symbol')
      .sort((left, right) => (
        formatClosedPolicySymbolKeyV1(left).localeCompare(formatClosedPolicySymbolKeyV1(right))
      ));
    if (symbols.length > 0) return closedPolicyOwnKeyPathV1(path, symbols[0]);
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (!isPlainObject(actual)) return path;
    const expectedKeys = Object.keys(expected).sort();
    for (const key of expectedKeys) {
      const descriptor = getClosedPolicyEnumerableDataDescriptorV1(actual, key);
      if (descriptor === null) return closedPolicyOwnKeyPathV1(path, key);
      const child = findClosedMarketVolumeStructureFeaturePolicyMismatchPathV1(
        expected[key], descriptor.value, closedPolicyOwnKeyPathV1(path, key),
      );
      if (child !== null) return child;
    }
    const expectedKeySet = new Set(expectedKeys);
    const ownKeys = Reflect.ownKeys(actual);
    const extraStrings = ownKeys
      .filter((key) => typeof key === 'string' && !expectedKeySet.has(key))
      .sort();
    if (extraStrings.length > 0) return closedPolicyOwnKeyPathV1(path, extraStrings[0]);
    const symbols = ownKeys
      .filter((key) => typeof key === 'symbol')
      .sort((left, right) => (
        formatClosedPolicySymbolKeyV1(left).localeCompare(formatClosedPolicySymbolKeyV1(right))
      ));
    if (symbols.length > 0) return closedPolicyOwnKeyPathV1(path, symbols[0]);
    return null;
  }
  return Object.is(expected, actual) ? null : path;
}

/**
 * Unique closed V1 gate for policy values. Compares exclusively against
 * MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1 — no concurrent literals.
 * @param {unknown} actual
 */
export function assertClosedMarketVolumeStructureFeaturePolicyValuesV1(actual) {
  if (!isPlainObject(actual)) {
    throw new MarketDataL3Error(
      MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
      'policy values are not the closed V1 canon at $',
      { path: '$' },
    );
  }
  const path = findClosedMarketVolumeStructureFeaturePolicyMismatchPathV1(
    MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1, actual, '$',
  );
  if (path !== null) {
    throw new MarketDataL3Error(
      MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
      `policy values are not the closed V1 canon at ${path}`,
      { path },
    );
  }
  return actual;
}

/**
 * Extract value fields from a full policy object (drops schemaVersion only).
 * Preserves every other own key and its descriptor so the closed gate can see
 * non-enumerable strings, Symbols and accessor/data shape.
 */
export function extractMarketVolumeStructureFeaturePolicyValuesV1(policy) {
  if (!isPlainObject(policy)) {
    throw new MarketDataL3Error(
      MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
      'policy values are not the closed V1 canon at $',
      { path: '$' },
    );
  }
  const values = {};
  for (const key of Reflect.ownKeys(policy)) {
    if (key === 'schemaVersion') continue;
    const descriptor = Object.getOwnPropertyDescriptor(policy, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(values, key, descriptor);
  }
  return values;
}
