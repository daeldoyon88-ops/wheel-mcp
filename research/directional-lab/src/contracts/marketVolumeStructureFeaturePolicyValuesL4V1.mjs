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
 * Recursive closed comparison against the unique V1 canon.
 * Object key order is ignored; array order is significant.
 * Returns the first deterministic JSON-path mismatch, or null when closed.
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
    if (expected.length !== actual.length) return path;
    for (let index = 0; index < expected.length; index += 1) {
      const child = findClosedMarketVolumeStructureFeaturePolicyMismatchPathV1(
        expected[index], actual[index], `${path}[${index}]`,
      );
      if (child !== null) return child;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (!isPlainObject(actual)) return path;
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    for (const key of expectedKeys) {
      if (!Object.hasOwn(actual, key)) return `${path}.${key}`;
    }
    for (const key of actualKeys) {
      if (!Object.hasOwn(expected, key)) return `${path}.${key}`;
    }
    for (const key of expectedKeys) {
      const child = findClosedMarketVolumeStructureFeaturePolicyMismatchPathV1(
        expected[key], actual[key], `${path}.${key}`,
      );
      if (child !== null) return child;
    }
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

/** Extract value fields from a full policy object (drops schemaVersion extras). */
export function extractMarketVolumeStructureFeaturePolicyValuesV1(policy) {
  if (!isPlainObject(policy)) {
    throw new MarketDataL3Error(
      MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
      'policy values are not the closed V1 canon at $',
      { path: '$' },
    );
  }
  const values = {};
  for (const key of Object.keys(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1)) {
    if (Object.hasOwn(policy, key)) values[key] = policy[key];
  }
  for (const key of Object.keys(policy)) {
    if (key === 'schemaVersion') continue;
    if (!Object.hasOwn(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1, key)) {
      values[key] = policy[key];
    }
  }
  return values;
}
