/**
 * Unique canonical V1 values for the closed L4A-B computation policy.
 * The object is deeply immutable and is shared by the contract and builder;
 * moving it here must not alter the canonical policy bytes or object ID.
 */

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
