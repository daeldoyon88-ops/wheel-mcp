/**
 * L4B-F2 CPI / inflation causal state under the V2 successor policy
 * (MarketMacroInstrumentProjectionPolicy/2, ENDPOINTS_M_AND_M_MINUS_12_REQUIRED).
 * Additive: macroInflationFeaturesL4BF2V1.mjs is unchanged.
 *
 * Identical to V1 except the YoY window rule:
 *   cpiYoY = CPI(m) / CPI(m - 12) - 1   (ratio scale 6, HALF_EVEN, as V1)
 * where m is the latest reference month, at or before the causal current month
 * and within the V1 staleness bound, for which BOTH endpoint observations resolve
 * to a real value at K(T). Intervening months are never consulted, never required
 * and never created. Every consumed level comes from the unchanged as-of resolver
 * (availableAt <= K(T), single causal chain tip). A missing endpoint is simply not
 * a candidate; when no lawful pair exists cpiYoY is null (fail closed).
 * cpiLevel, cpiReferencePeriod, MoM, staleness and availability keep V1 meaning.
 */

import {
  addMonthsToMonthKey,
  macroFixedSign,
  macroNominalDeltaFixed,
  macroRatioChangeFixed,
  monthsBetweenMonthKeys,
} from './macroFixedPointRatioL4BF2V1.mjs';
import { MarketDataL3Error } from '../contracts/marketDataL3CommonV1.mjs';
import {
  CPI_YOY_ENDPOINT_LAG_MONTHS_V2,
  CPI_YOY_ENDPOINT_WINDOW_POLICY_V2,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION,
} from '../contracts/macroFullFeatureContractsL4BF2V2.mjs';
import {
  mostRecentAdmissibleReferencePeriodAsOf,
  resolveSeriesReferencePeriodAsOf,
} from './macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';

const RATIO_CODE = 'MARKET_DATA_MACRO_CPI_RATIO_INVALID';
export const CPI_INFLATION_V2_POLICY_CODE = 'MARKET_DATA_MACRO_CPI_POLICY_NOT_V2';

const NULL_PROVENANCE = Object.freeze({
  observationIdentityId: null, macroVintageIdentityId: null, observationVintageId: null,
});

function notAvailableState() {
  return {
    inflationState: {
      cpiLevel: null, cpiReferencePeriod: null, cpiAvailableAt: null, cpiRevisionKind: null,
      cpiCompletenessClass: null, cpiMoM: null, cpiYoY: null, cpiMoMChange: null, cpiYoYChange: null,
      inflationDirection: 'NOT_AVAILABLE', inflationAccelerationState: 'NOT_AVAILABLE',
      monthsSinceLatestCpi: null, cpiAvailabilityStatus: 'NOT_AVAILABLE',
      cpiProvenance: { ...NULL_PROVENANCE },
    },
    availability: 'UNAVAILABLE',
    cpiYoYEndpointEvidence: null,
  };
}

function assertV2Policy(policy) {
  if (policy?.schemaVersion !== MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION
    || policy.monthlyWindowPolicy !== CPI_YOY_ENDPOINT_WINDOW_POLICY_V2
    || policy.cpiMinObservationsForYoY !== 2) {
    throw new MarketDataL3Error(CPI_INFLATION_V2_POLICY_CODE,
      'computeInflationStateV2 requires the closed MarketMacroInstrumentProjectionPolicy/2');
  }
}

/** An exact reference month that resolves to a real value as-of the cutoff, else null. */
function resolvedEndpoint(cpiIndex, monthKey, knowledgeCutoff, policy) {
  const resolution = resolveSeriesReferencePeriodAsOf(cpiIndex, monthKey, knowledgeCutoff);
  if (resolution.resolutionStatus !== 'RESOLVED' || resolution.value === null) return null;
  if (resolution.value.scale !== policy.cpiInputScale) {
    throw new MarketDataL3Error(RATIO_CODE,
      `CPI input scale must equal closed policy scale ${policy.cpiInputScale}`);
  }
  if (!(resolution.availableAt <= knowledgeCutoff)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FUTURE_VINTAGE', 'endpoint vintage after K(T)');
  }
  return Object.freeze({
    referencePeriod: monthKey,
    value: resolution.value,
    availableAt: resolution.availableAt,
    observationIdentityId: resolution.observationIdentityId,
    observationVintageId: resolution.observationVintageId,
    vintageSequence: resolution.vintageSequence,
  });
}

/** Endpoint pair (m, m - 12) for one candidate m, or null when either endpoint is absent. */
function endpointPair(cpiIndex, monthKey, knowledgeCutoff, policy) {
  const current = resolvedEndpoint(cpiIndex, monthKey, knowledgeCutoff, policy);
  if (current === null) return null;
  const base = resolvedEndpoint(cpiIndex, addMonthsToMonthKey(monthKey, -CPI_YOY_ENDPOINT_LAG_MONTHS_V2), knowledgeCutoff, policy);
  if (base === null) return null;
  return Object.freeze({ current, base });
}

/**
 * @param {{cpiIndex: object, knowledgeCutoff: string, sessionMonthKey: string, policy: object}} input
 */
export function computeInflationStateV2(input) {
  const { cpiIndex, knowledgeCutoff, sessionMonthKey, policy } = input;
  assertV2Policy(policy);
  if (cpiIndex.status !== 'INDEXED') return notAvailableState();

  const current = mostRecentAdmissibleReferencePeriodAsOf(cpiIndex, knowledgeCutoff, sessionMonthKey);
  if (current === null) return notAvailableState();

  const provenance = {
    observationIdentityId: current.observationIdentityId,
    macroVintageIdentityId: current.macroVintageIdentityId,
    observationVintageId: current.observationVintageId,
  };
  const monthsSinceLatestCpi = monthsBetweenMonthKeys(current.referencePeriod, sessionMonthKey);

  if (current.resolutionStatus === 'WITHDRAWN') {
    return {
      inflationState: {
        cpiLevel: null, cpiReferencePeriod: current.referencePeriod,
        cpiAvailableAt: current.availableAt, cpiRevisionKind: current.revisionKind,
        cpiCompletenessClass: current.completenessClass, cpiMoM: null, cpiYoY: null,
        cpiMoMChange: null, cpiYoYChange: null, inflationDirection: 'NOT_AVAILABLE',
        inflationAccelerationState: 'NOT_AVAILABLE',
        monthsSinceLatestCpi: monthsSinceLatestCpi >= 0 ? monthsSinceLatestCpi : null,
        cpiAvailabilityStatus: 'WITHDRAWN', cpiProvenance: provenance,
      },
      availability: 'UNAVAILABLE',
      cpiYoYEndpointEvidence: null,
    };
  }

  const currentKey = current.referencePeriod;
  const currentLevel = current.value;
  if (currentLevel.scale !== policy.cpiInputScale) {
    throw new MarketDataL3Error(RATIO_CODE,
      `CPI input scale must equal closed policy scale ${policy.cpiInputScale}`);
  }

  /* MoM keeps its V1 rule: the exact prior month, never a nearer substitute. */
  const m1 = resolvedEndpoint(cpiIndex, addMonthsToMonthKey(currentKey, -1), knowledgeCutoff, policy);
  const m2 = resolvedEndpoint(cpiIndex, addMonthsToMonthKey(currentKey, -2), knowledgeCutoff, policy);
  const cpiMoM = m1 === null ? null : macroRatioChangeFixed(currentLevel, m1.value, RATIO_CODE);
  const prevMoM = (m1 === null || m2 === null) ? null : macroRatioChangeFixed(m1.value, m2.value, RATIO_CODE);

  /* YoY endpoint selection: the current month first (exactly V1's m), then older
     fallback candidates only while they stay within the V1 staleness bound. */
  const candidatesExamined = [];
  let selected = null;
  for (let monthKey = currentKey;
    monthKey === currentKey || monthsBetweenMonthKeys(monthKey, sessionMonthKey) <= policy.cpiStalenessMaxMonths;
    monthKey = addMonthsToMonthKey(monthKey, -1)) {
    candidatesExamined.push(monthKey);
    const pair = endpointPair(cpiIndex, monthKey, knowledgeCutoff, policy);
    if (pair !== null) { selected = pair; break; }
  }
  const cpiYoY = selected === null ? null
    : macroRatioChangeFixed(selected.current.value, selected.base.value, RATIO_CODE);
  const previousPair = selected === null ? null
    : endpointPair(cpiIndex, addMonthsToMonthKey(selected.current.referencePeriod, -1), knowledgeCutoff, policy);
  const prevYoY = previousPair === null ? null
    : macroRatioChangeFixed(previousPair.current.value, previousPair.base.value, RATIO_CODE);

  const cpiMoMChange = (cpiMoM === null || prevMoM === null) ? null
    : macroNominalDeltaFixed(cpiMoM, prevMoM, RATIO_CODE);
  const cpiYoYChange = (cpiYoY === null || prevYoY === null) ? null
    : macroNominalDeltaFixed(cpiYoY, prevYoY, RATIO_CODE);

  let inflationDirection = 'NOT_AVAILABLE';
  if (cpiYoYChange !== null) {
    const sign = macroFixedSign(cpiYoYChange);
    inflationDirection = sign > 0 ? 'RISING' : sign < 0 ? 'FALLING' : 'UNCHANGED';
  }

  let inflationAccelerationState = 'NOT_AVAILABLE';
  if (cpiMoMChange !== null && cpiYoYChange !== null) {
    const momSign = macroFixedSign(cpiMoMChange);
    const yoySign = macroFixedSign(cpiYoYChange);
    if (momSign > 0 && yoySign > 0) inflationAccelerationState = 'ACCELERATING';
    else if (momSign < 0 && yoySign < 0) inflationAccelerationState = 'DECELERATING';
    else if (momSign === 0 && yoySign === 0) inflationAccelerationState = 'STABLE';
    else inflationAccelerationState = 'MIXED';
  }

  const stale = monthsSinceLatestCpi > policy.cpiStalenessMaxMonths;
  const cpiAvailabilityStatus = stale ? 'STALE' : 'AVAILABLE';
  const availability = cpiAvailabilityStatus === 'AVAILABLE' && cpiMoM !== null && cpiYoY !== null
    ? 'COMPLETE' : 'PARTIAL';

  return {
    inflationState: {
      cpiLevel: currentLevel,
      cpiReferencePeriod: currentKey,
      cpiAvailableAt: current.availableAt,
      cpiRevisionKind: current.revisionKind,
      cpiCompletenessClass: current.completenessClass,
      cpiMoM, cpiYoY, cpiMoMChange, cpiYoYChange,
      inflationDirection, inflationAccelerationState,
      monthsSinceLatestCpi,
      cpiAvailabilityStatus,
      cpiProvenance: provenance,
    },
    availability,
    cpiYoYEndpointEvidence: Object.freeze({
      monthlyWindowPolicy: CPI_YOY_ENDPOINT_WINDOW_POLICY_V2,
      endpointLagMonths: CPI_YOY_ENDPOINT_LAG_MONTHS_V2,
      knowledgeCutoff,
      candidatesExamined: Object.freeze(candidatesExamined),
      endpoints: selected === null ? null : Object.freeze([selected.current, selected.base]),
      previousEndpoints: previousPair === null ? null : Object.freeze([previousPair.current, previousPair.base]),
    }),
  };
}
