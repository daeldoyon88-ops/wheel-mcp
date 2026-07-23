/**
 * L4B-F2 CPI / inflation causal state. All ratios are exact fixed-point. YoY and
 * MoM require the exact calendar reference months to be causally available; a
 * missing month never falls back to the nearest available observation.
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
  mostRecentAdmissibleReferencePeriodAsOf,
  resolveSeriesReferencePeriodAsOf,
} from './macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';

const RATIO_CODE = 'MARKET_DATA_MACRO_CPI_RATIO_INVALID';

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
  };
}

/** Level of an exact reference month if it resolves to a real value, else null. */
function resolvedLevel(cpiIndex, monthKey, knowledgeCutoff) {
  const resolution = resolveSeriesReferencePeriodAsOf(cpiIndex, monthKey, knowledgeCutoff);
  if (resolution.resolutionStatus !== 'RESOLVED' || resolution.value === null) return null;
  return resolution.value;
}

/**
 * @param {{cpiIndex: object, knowledgeCutoff: string, sessionMonthKey: string, policy: object}} input
 */
export function computeInflationState(input) {
  const { cpiIndex, knowledgeCutoff, sessionMonthKey, policy } = input;
  if (cpiIndex.status !== 'INDEXED') return notAvailableState();

  const current = mostRecentAdmissibleReferencePeriodAsOf(
    cpiIndex, knowledgeCutoff, sessionMonthKey,
  );
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
    };
  }

  const currentKey = current.referencePeriod;
  const currentLevel = current.value;
  if (currentLevel.scale !== policy.cpiInputScale) {
    throw new MarketDataL3Error(RATIO_CODE,
      `CPI input scale must equal closed policy scale ${policy.cpiInputScale}`);
  }
  const levelsByOffset = [currentLevel];
  for (let offset = 1; offset <= policy.cpiMinObservationsForYoY; offset += 1) {
    levelsByOffset.push(resolvedLevel(
      cpiIndex, addMonthsToMonthKey(currentKey, -offset), knowledgeCutoff,
    ));
  }
  for (const level of levelsByOffset) {
    if (level !== null && level.scale !== policy.cpiInputScale) {
      throw new MarketDataL3Error(RATIO_CODE,
        `CPI input scale must equal closed policy scale ${policy.cpiInputScale}`);
    }
  }
  const m1 = levelsByOffset[1];
  const m2 = levelsByOffset[2];
  const currentYoYWindow = levelsByOffset.slice(0, policy.cpiMinObservationsForYoY);
  const previousYoYWindow = levelsByOffset.slice(1, policy.cpiMinObservationsForYoY + 1);
  const currentYoYContiguous = currentYoYWindow.every((value) => value !== null);
  const previousYoYContiguous = previousYoYWindow.every((value) => value !== null);

  const cpiMoM = m1 === null ? null : macroRatioChangeFixed(currentLevel, m1, RATIO_CODE);
  const cpiYoY = currentYoYContiguous ? macroRatioChangeFixed(
    currentLevel, currentYoYWindow[currentYoYWindow.length - 1], RATIO_CODE,
  ) : null;
  const prevMoM = (m1 === null || m2 === null) ? null : macroRatioChangeFixed(m1, m2, RATIO_CODE);
  const prevYoY = previousYoYContiguous ? macroRatioChangeFixed(
    m1, previousYoYWindow[previousYoYWindow.length - 1], RATIO_CODE,
  ) : null;
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

  let availability;
  if (cpiAvailabilityStatus === 'AVAILABLE' && cpiMoM !== null && cpiYoY !== null) {
    availability = 'COMPLETE';
  } else {
    availability = 'PARTIAL';
  }

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
  };
}
