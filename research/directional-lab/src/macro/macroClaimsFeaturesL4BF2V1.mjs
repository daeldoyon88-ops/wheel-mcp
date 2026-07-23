/**
 * L4B-F2 initial jobless claims (ICSA) causal state. Weekly windows are causal
 * and exact: the four-week average requires exactly four consecutive weekly
 * observations; a missing week never substitutes a non-consecutive observation.
 * IMPROVING means only a nominal fall in weekly claims.
 */

import { addDays, toEpochDay } from '../time/civilDate.mjs';
import { MarketDataL3Error } from '../contracts/marketDataL3CommonV1.mjs';
import {
  macroCompareCanonical,
  macroFixedSign,
  macroNominalDeltaFixed,
  macroWindowAverageFixed,
} from './macroFixedPointRatioL4BF2V1.mjs';
import {
  mostRecentAdmissibleReferencePeriodAsOf,
  resolveSeriesReferencePeriodAsOf,
} from './macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';

const WINDOW_CODE = 'MARKET_DATA_MACRO_CLAIMS_WINDOW_INVALID';
const CLAIMS_SCALE = 0;

const NULL_PROVENANCE = Object.freeze({
  observationIdentityId: null, macroVintageIdentityId: null, observationVintageId: null,
});

function notAvailableState() {
  return {
    claimsState: {
      initialClaims: null, claimsReferenceWeek: null, claimsAvailableAt: null,
      claimsWoWChange: null, claimsFourWeekAverage: null, claimsFourWeekAverageChange: null,
      claimsDirection: 'NOT_AVAILABLE', claimsTrend: 'NOT_AVAILABLE', claimsSpikeState: 'NOT_AVAILABLE',
      weeksSinceLatestClaims: null, claimsAvailabilityStatus: 'NOT_AVAILABLE',
      claimsProvenance: { ...NULL_PROVENANCE },
    },
    availability: 'UNAVAILABLE',
  };
}

function resolvedLevel(index, weekKey, knowledgeCutoff, expectedScale) {
  const resolution = resolveSeriesReferencePeriodAsOf(index, weekKey, knowledgeCutoff);
  if (resolution.resolutionStatus !== 'RESOLVED' || resolution.value === null) return null;
  if (resolution.value.scale !== expectedScale) {
    throw new MarketDataL3Error(WINDOW_CODE,
      `claims input scale must equal closed policy scale ${expectedScale}`);
  }
  return resolution.value;
}

/** Mean of the four consecutive weeks ending at weekKey, or null if any missing. */
function fourWeekAverage(index, weekKey, knowledgeCutoff, window, inputScale) {
  const values = [];
  for (let offset = 0; offset < window; offset += 1) {
    const key = offset === 0 ? weekKey : addDays(weekKey, -7 * offset);
    const level = resolvedLevel(index, key, knowledgeCutoff, inputScale);
    if (level === null) return null;
    values.push(level);
  }
  return macroWindowAverageFixed(values, window, CLAIMS_SCALE, WINDOW_CODE);
}

/**
 * @param {{claimsIndex: object, knowledgeCutoff: string, sessionDate: string, policy: object}} input
 */
export function computeClaimsState(input) {
  const { claimsIndex, knowledgeCutoff, sessionDate, policy } = input;
  if (claimsIndex.status !== 'INDEXED') return notAvailableState();

  const current = mostRecentAdmissibleReferencePeriodAsOf(
    claimsIndex, knowledgeCutoff, sessionDate,
  );
  if (current === null) return notAvailableState();

  const provenance = {
    observationIdentityId: current.observationIdentityId,
    macroVintageIdentityId: current.macroVintageIdentityId,
    observationVintageId: current.observationVintageId,
  };
  const dayGap = toEpochDay(sessionDate) - toEpochDay(current.referencePeriod);
  const weeksSinceLatestClaims = dayGap >= 0 ? Math.floor(dayGap / 7) : null;

  if (current.resolutionStatus === 'WITHDRAWN') {
    return {
      claimsState: {
        initialClaims: null, claimsReferenceWeek: current.referencePeriod,
        claimsAvailableAt: current.availableAt, claimsWoWChange: null,
        claimsFourWeekAverage: null, claimsFourWeekAverageChange: null,
        claimsDirection: 'NOT_AVAILABLE', claimsTrend: 'NOT_AVAILABLE', claimsSpikeState: 'NOT_AVAILABLE',
        weeksSinceLatestClaims, claimsAvailabilityStatus: 'WITHDRAWN', claimsProvenance: provenance,
      },
      availability: 'UNAVAILABLE',
    };
  }

  const weekKey = current.referencePeriod;
  const currentLevel = current.value;
  if (currentLevel.scale !== policy.claimsInputScale) {
    throw new MarketDataL3Error(WINDOW_CODE,
      `claims input scale must equal closed policy scale ${policy.claimsInputScale}`);
  }
  const window = policy.claimsFourWeekWindow;
  const prevWeekKey = addDays(weekKey, -7);
  const prevLevel = resolvedLevel(claimsIndex, prevWeekKey, knowledgeCutoff, policy.claimsInputScale);

  const claimsWoWChange = prevLevel === null ? null
    : macroNominalDeltaFixed(currentLevel, prevLevel, WINDOW_CODE);
  const claimsFourWeekAverage = fourWeekAverage(
    claimsIndex, weekKey, knowledgeCutoff, window, policy.claimsInputScale,
  );
  const prevFourWeekAverage = fourWeekAverage(
    claimsIndex, prevWeekKey, knowledgeCutoff, window, policy.claimsInputScale,
  );
  const claimsFourWeekAverageChange = (claimsFourWeekAverage === null || prevFourWeekAverage === null)
    ? null : macroNominalDeltaFixed(claimsFourWeekAverage, prevFourWeekAverage, WINDOW_CODE);

  let claimsDirection = 'NOT_AVAILABLE';
  let claimsTrend = 'NOT_AVAILABLE';
  if (claimsWoWChange !== null) {
    const wowSign = macroFixedSign(claimsWoWChange);
    claimsDirection = wowSign > 0 ? 'RISING' : wowSign < 0 ? 'FALLING' : 'UNCHANGED';
    const avgSign = claimsFourWeekAverageChange === null ? null
      : macroFixedSign(claimsFourWeekAverageChange);
    if (avgSign !== null && wowSign !== 0 && avgSign !== 0 && (wowSign > 0) !== (avgSign > 0)) {
      claimsTrend = 'MIXED';
    } else if (wowSign < 0) {
      claimsTrend = 'IMPROVING';
    } else if (wowSign > 0) {
      claimsTrend = 'DETERIORATING';
    } else {
      claimsTrend = 'STABLE';
    }
  }

  let claimsSpikeState;
  if (macroCompareCanonical(currentLevel, policy.claimsSpikeThresholds.spikeMinInclusive) >= 0) {
    claimsSpikeState = 'SPIKE';
  } else if (macroCompareCanonical(currentLevel, policy.claimsSpikeThresholds.elevatedMinInclusive) >= 0) {
    claimsSpikeState = 'ELEVATED';
  } else {
    claimsSpikeState = 'NORMAL';
  }

  const stale = weeksSinceLatestClaims === null || weeksSinceLatestClaims > policy.claimsStalenessMaxWeeks;
  const claimsAvailabilityStatus = stale ? 'STALE' : 'AVAILABLE';
  const availability = (claimsAvailabilityStatus === 'AVAILABLE' && claimsWoWChange !== null
    && claimsFourWeekAverage !== null) ? 'COMPLETE' : 'PARTIAL';

  return {
    claimsState: {
      initialClaims: currentLevel,
      claimsReferenceWeek: weekKey,
      claimsAvailableAt: current.availableAt,
      claimsWoWChange,
      claimsFourWeekAverage,
      claimsFourWeekAverageChange,
      claimsDirection,
      claimsTrend,
      claimsSpikeState,
      weeksSinceLatestClaims,
      claimsAvailabilityStatus,
      claimsProvenance: provenance,
    },
    availability,
  };
}
