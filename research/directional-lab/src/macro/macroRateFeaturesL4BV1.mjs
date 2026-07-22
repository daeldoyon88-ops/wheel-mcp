/**
 * L4B-F1 rate-state features from per-session series resolutions.
 * Authority math is exact BigInt fixed-point via fixedPointFeatureMathL4V1.
 */

import {
  MarketDataL3Error,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  F1_SERIES_ALIAS_TO_CODE,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  compareFixed,
  divideRoundHalfEven,
  fixedFromCanonical,
  fixedToCanonical,
  subtractFixed,
} from '../features/fixedPointFeatureMathL4V1.mjs';

function resolutionMap(orderedResolutions) {
  return new Map(orderedResolutions.map((row) => [row.canonicalSeriesCode, row]));
}

function usableValue(resolution) {
  if (!resolution) return null;
  // STALE must not be treated as a fresh causal value in rate-state math.
  if (resolution.availabilityStatus !== 'AVAILABLE') return null;
  if (resolution.value === null) return null;
  return resolution.value;
}

function alignToPolicyScale(value, scale) {
  if (value === null) return null;
  const internal = fixedFromCanonical(value, scale);
  return fixedToCanonical(internal, scale);
}

function midpointExact(lower, upper, scale) {
  const left = fixedFromCanonical(lower, scale);
  const right = fixedFromCanonical(upper, scale);
  if (left.scale !== right.scale) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_CURVE_SCALE_MISMATCH',
      'fed target bounds must align before midpoint');
  }
  const atoms = divideRoundHalfEven(left.atoms + right.atoms, 2n);
  return fixedToCanonical({ atoms, scale: left.scale }, scale);
}

function widthExact(lower, upper, scale) {
  return fixedToCanonical(
    subtractFixed(fixedFromCanonical(upper, scale), fixedFromCanonical(lower, scale)),
    scale,
  );
}

function changeExact(current, previous, scale) {
  if (current === null || previous === null) return null;
  return fixedToCanonical(
    subtractFixed(fixedFromCanonical(current, scale), fixedFromCanonical(previous, scale)),
    scale,
  );
}

function classifyPolicyDirection(midpointChange) {
  if (midpointChange === null) return 'NOT_AVAILABLE';
  const internal = fixedFromCanonical(midpointChange, midpointChange.scale);
  if (internal.atoms < 0n) return 'EASING';
  if (internal.atoms > 0n) return 'TIGHTENING';
  return 'UNCHANGED';
}

function classifyRateRegime(policyRateLevel, thresholds) {
  if (policyRateLevel === null) return 'NOT_AVAILABLE';
  const level = fixedFromCanonical(policyRateLevel, policyRateLevel.scale);
  const lowMax = fixedFromCanonical(thresholds.lowMaxExclusive, thresholds.lowMaxExclusive.scale);
  const modMax = fixedFromCanonical(thresholds.moderateMaxExclusive,
    thresholds.moderateMaxExclusive.scale);
  const highMax = fixedFromCanonical(thresholds.highMaxExclusive,
    thresholds.highMaxExclusive.scale);
  if (compareFixed(level, lowMax) < 0) return 'LOW';
  if (compareFixed(level, modMax) < 0) return 'MODERATE';
  if (compareFixed(level, highMax) < 0) return 'HIGH';
  return 'VERY_HIGH';
}

function classifyMonetaryRegime(policyDirection, rateRegime) {
  if (policyDirection === 'EASING') return 'EASING';
  if (policyDirection === 'TIGHTENING') return 'TIGHTENING';
  if (policyDirection !== 'UNCHANGED') return 'NOT_AVAILABLE';
  if (rateRegime === 'LOW') return 'LOW_RATE_HOLD';
  if (rateRegime === 'MODERATE') return 'MID_RATE_HOLD';
  if (rateRegime === 'HIGH' || rateRegime === 'VERY_HIGH') return 'HIGH_RATE_HOLD';
  return 'NOT_AVAILABLE';
}

function policyCompleteness(lower, upper) {
  if (lower !== null && upper !== null) return 'COMPLETE';
  if (lower !== null || upper !== null) return 'PARTIAL';
  return 'UNAVAILABLE';
}

/**
 * @param {object} input
 * @param {object[]} input.orderedResolutions
 * @param {object} input.policy
 * @param {object|null} input.previousRateState
 */
export function computeRateState(input) {
  const { orderedResolutions, policy, previousRateState = null } = input;
  const byCode = resolutionMap(orderedResolutions);
  const scale = policy.rateFeatureScale;

  const lowerRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.FED_TARGET_LOWER_BOUND));
  const upperRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.FED_TARGET_UPPER_BOUND));
  const effrRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.EFFECTIVE_FEDERAL_FUNDS_RATE));
  const sofrRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.SOFR));
  const t3mRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.TREASURY_3M));
  const t2yRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.TREASURY_2Y));
  const t5yRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.TREASURY_5Y));
  const t10yRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.TREASURY_10Y));
  const t30yRaw = usableValue(byCode.get(F1_SERIES_ALIAS_TO_CODE.TREASURY_30Y));

  // STALE values are exposed in rate state (status tracked in resolutions) but
  // still contribute to displayed levels; spreads refuse STALE separately.
  const lower = alignToPolicyScale(lowerRaw, scale);
  const upper = alignToPolicyScale(upperRaw, scale);
  const effr = alignToPolicyScale(effrRaw, scale);
  const sofr = alignToPolicyScale(sofrRaw, scale);
  const treasury3m = alignToPolicyScale(t3mRaw, scale);
  const treasury2y = alignToPolicyScale(t2yRaw, scale);
  const treasury5y = alignToPolicyScale(t5yRaw, scale);
  const treasury10y = alignToPolicyScale(t10yRaw, scale);
  const treasury30y = alignToPolicyScale(t30yRaw, scale);

  const fedTargetMidpoint = (lower !== null && upper !== null)
    ? midpointExact(lower, upper, scale)
    : null;
  const targetRangeWidth = (lower !== null && upper !== null)
    ? widthExact(lower, upper, scale)
    : null;
  const effrMinusTargetMidpoint = (effr !== null && fedTargetMidpoint !== null)
    ? fixedToCanonical(
      subtractFixed(fixedFromCanonical(effr, scale), fixedFromCanonical(fedTargetMidpoint, scale)),
      scale,
    )
    : null;
  const sofrMinusEffr = (sofr !== null && effr !== null)
    ? fixedToCanonical(
      subtractFixed(fixedFromCanonical(sofr, scale), fixedFromCanonical(effr, scale)),
      scale,
    )
    : null;

  const previous = previousRateState;
  const lowerBoundChange = changeExact(lower, previous?.fedTargetLowerBound ?? null, scale);
  const upperBoundChange = changeExact(upper, previous?.fedTargetUpperBound ?? null, scale);
  const midpointChange = changeExact(fedTargetMidpoint, previous?.fedTargetMidpoint ?? null, scale);
  const policyDirection = classifyPolicyDirection(midpointChange);

  let sessionsSincePolicyChange = null;
  if (previous === null) {
    sessionsSincePolicyChange = fedTargetMidpoint === null ? null : 0;
  } else if (policyDirection === 'NOT_AVAILABLE') {
    sessionsSincePolicyChange = null;
  } else if (policyDirection === 'UNCHANGED') {
    sessionsSincePolicyChange = previous.sessionsSincePolicyChange === null
      ? null
      : previous.sessionsSincePolicyChange + 1;
  } else {
    sessionsSincePolicyChange = 0;
  }

  const policyRateLevel = fedTargetMidpoint;
  const shortRateLevel = effr ?? treasury3m;
  const longRateLevel = treasury10y ?? treasury30y;
  const rateRegime = classifyRateRegime(policyRateLevel, policy.rateRegimeThresholds);
  const monetaryPolicyRegime = classifyMonetaryRegime(policyDirection, rateRegime);

  return {
    fedTargetLowerBound: lower,
    fedTargetUpperBound: upper,
    fedTargetMidpoint,
    targetRangeWidth,
    effectiveFedFundsRate: effr,
    sofr,
    effrMinusTargetMidpoint,
    sofrMinusEffr,
    lowerBoundChange,
    upperBoundChange,
    midpointChange,
    policyDirection,
    sessionsSincePolicyChange,
    policyStateAvailability: policyCompleteness(lower, upper),
    treasury3m,
    treasury2y,
    treasury5y,
    treasury10y,
    treasury30y,
    policyRateLevel,
    shortRateLevel,
    longRateLevel,
    rateRegime,
    monetaryPolicyRegime,
  };
}
