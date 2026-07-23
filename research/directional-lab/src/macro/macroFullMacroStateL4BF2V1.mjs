/**
 * L4B-F2 full macro regime. A limited, explainable set of separate axes — never
 * an opaque score. The optional macroCompositeState is a closed classification
 * pinned in the policy and tested at its boundaries; it makes no market
 * prediction.
 */

import { macroCompareCanonical } from './macroFixedPointRatioL4BF2V1.mjs';

/** Level band of a YoY inflation ratio against the pinned policy bands. */
function inflationLevelBand(cpiYoY, bands) {
  if (macroCompareCanonical(cpiYoY, bands.lowMaxExclusiveYoY) < 0) return 'LOW';
  if (macroCompareCanonical(cpiYoY, bands.moderateMaxExclusiveYoY) < 0) return 'MODERATE';
  return 'HIGH';
}

function inflationRegimeOf(inflationState, policy) {
  if (inflationState.cpiYoY === null || inflationState.inflationDirection === 'NOT_AVAILABLE') {
    return 'NOT_AVAILABLE';
  }
  const band = inflationLevelBand(inflationState.cpiYoY, policy.inflationRegimeBands);
  // The six-way regime folds an unchanged inflation rate into the non-rising
  // (FALLING) side; only a strict RISING direction lands on the RISING side.
  const side = inflationState.inflationDirection === 'RISING' ? 'RISING'
    : policy.inflationUnchangedRegimeSide === 'NON_RISING' ? 'FALLING' : 'RISING';
  return `${band}_AND_${side}`;
}

function laborRegimeOf(unemploymentState) {
  return unemploymentState.unemploymentTrend;
}

function claimsRegimeOf(claimsState) {
  if (claimsState.claimsSpikeState === 'NOT_AVAILABLE') return 'NOT_AVAILABLE';
  if (claimsState.claimsSpikeState === 'SPIKE') return 'SPIKE';
  if (claimsState.claimsSpikeState === 'ELEVATED') return 'ELEVATED';
  switch (claimsState.claimsTrend) {
    case 'IMPROVING': return 'IMPROVING';
    case 'DETERIORATING': return 'DETERIORATING';
    case 'MIXED': return 'MIXED';
    default: return 'NORMAL';
  }
}

function macroCompositeStateOf(inflationDirection, policyDirection, laborRegime) {
  if (inflationDirection === 'NOT_AVAILABLE' || laborRegime === 'NOT_AVAILABLE'
      || policyDirection === 'NOT_AVAILABLE') {
    return 'INSUFFICIENT_DATA';
  }
  if (laborRegime === 'DETERIORATING') return 'LABOR_WEAKENING';
  const rising = inflationDirection === 'RISING';
  const falling = inflationDirection === 'FALLING' || inflationDirection === 'UNCHANGED';
  const easing = policyDirection === 'EASING';
  const tightening = policyDirection === 'TIGHTENING';
  const holding = policyDirection === 'UNCHANGED';
  if (falling && easing) return 'DISINFLATIONARY_EASING';
  if (falling && (tightening || holding)) return 'DISINFLATIONARY_TIGHT';
  if (rising && (easing || holding)) return 'REFLATIONARY';
  if (rising && tightening) return 'INFLATIONARY_TIGHTENING';
  return 'MIXED';
}

function combineCompleteness(parts) {
  if (parts.every((part) => part === 'COMPLETE')) return 'COMPLETE';
  if (parts.every((part) => part === 'UNAVAILABLE')) return 'UNAVAILABLE';
  return 'PARTIAL';
}

/**
 * @param {{f1Row: object, inflation: object, labor: object, claims: object, policy: object}} input
 */
export function computeFullMacroState(input) {
  const { f1Row, inflation, labor, claims, policy } = input;
  if (policy.compositeRuleVersion !== 'EXPLAINABLE_AXES_V1') {
    throw new TypeError('unsupported macro composite rule version');
  }
  const nominalRateRegime = f1Row.rateState.rateRegime;
  const curveRegime = f1Row.curveState.curveShape;
  const policyDirection = f1Row.rateState.policyDirection;

  const inflationRegime = inflationRegimeOf(inflation.inflationState, policy);
  const laborRegime = laborRegimeOf(labor.unemploymentState);
  const claimsRegime = claimsRegimeOf(claims.claimsState);
  const macroCompositeState = macroCompositeStateOf(
    inflation.inflationState.inflationDirection, policyDirection, laborRegime,
  );
  const macroDataCompleteness = combineCompleteness([
    inflation.availability, labor.availability, claims.availability,
  ]);

  const f1Completeness = f1Row.availabilityState.overallF1Completeness;
  const fullMacroCompleteness = combineCompleteness([
    f1Completeness, inflation.availability, labor.availability, claims.availability,
  ]);

  return {
    fullMacroRegimeState: {
      nominalRateRegime,
      curveRegime,
      inflationRegime,
      laborRegime,
      claimsRegime,
      policyDirection,
      macroCompositeState,
      macroDataCompleteness,
    },
    fullAvailabilityState: {
      inflationAvailability: inflation.availability,
      laborAvailability: labor.availability,
      claimsAvailability: claims.availability,
      f1Completeness,
      fullMacroCompleteness,
    },
    f1StateReferenceRegime: { nominalRateRegime, curveRegime, policyDirection },
  };
}
