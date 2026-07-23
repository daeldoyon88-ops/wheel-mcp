/**
 * L4B-F2 UNRATE / labor causal state. Deliberately narrow semantics: IMPROVING
 * means only a nominal fall in the unemployment rate and DETERIORATING only a
 * nominal rise; no claim is made about the broader labour market. Changes use
 * exact prior calendar months; a missing month yields NOT_AVAILABLE, never an
 * approximation.
 */

import { macroFixedSign, macroNominalDeltaFixed, monthsBetweenMonthKeys, addMonthsToMonthKey } from './macroFixedPointRatioL4BF2V1.mjs';
import { MarketDataL3Error } from '../contracts/marketDataL3CommonV1.mjs';
import {
  mostRecentAdmissibleReferencePeriodAsOf,
  resolveSeriesReferencePeriodAsOf,
} from './macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';

const DELTA_CODE = 'MARKET_DATA_MACRO_UNRATE_RESOLUTION_MISMATCH';

const NULL_PROVENANCE = Object.freeze({
  observationIdentityId: null, macroVintageIdentityId: null, observationVintageId: null,
});

function notAvailableState() {
  return {
    unemploymentState: {
      unemploymentRate: null, unemploymentReferencePeriod: null, unemploymentAvailableAt: null,
      unemploymentMoMChange: null, unemploymentThreeMonthChange: null,
      unemploymentDirection: 'NOT_AVAILABLE', unemploymentTrend: 'NOT_AVAILABLE',
      monthsSinceLatestUnrate: null, unemploymentAvailabilityStatus: 'NOT_AVAILABLE',
      unemploymentProvenance: { ...NULL_PROVENANCE },
    },
    availability: 'UNAVAILABLE',
  };
}

function resolvedLevel(index, monthKey, knowledgeCutoff) {
  const resolution = resolveSeriesReferencePeriodAsOf(index, monthKey, knowledgeCutoff);
  if (resolution.resolutionStatus !== 'RESOLVED' || resolution.value === null) return null;
  return resolution.value;
}

/**
 * @param {{unrateIndex: object, knowledgeCutoff: string, sessionMonthKey: string, policy: object}} input
 */
export function computeUnemploymentState(input) {
  const { unrateIndex, knowledgeCutoff, sessionMonthKey, policy } = input;
  if (unrateIndex.status !== 'INDEXED') return notAvailableState();

  const current = mostRecentAdmissibleReferencePeriodAsOf(
    unrateIndex, knowledgeCutoff, sessionMonthKey,
  );
  if (current === null) return notAvailableState();

  const provenance = {
    observationIdentityId: current.observationIdentityId,
    macroVintageIdentityId: current.macroVintageIdentityId,
    observationVintageId: current.observationVintageId,
  };
  const monthsSinceLatestUnrate = monthsBetweenMonthKeys(current.referencePeriod, sessionMonthKey);

  if (current.resolutionStatus === 'WITHDRAWN') {
    return {
      unemploymentState: {
        unemploymentRate: null, unemploymentReferencePeriod: current.referencePeriod,
        unemploymentAvailableAt: current.availableAt, unemploymentMoMChange: null,
        unemploymentThreeMonthChange: null, unemploymentDirection: 'NOT_AVAILABLE',
        unemploymentTrend: 'NOT_AVAILABLE',
        monthsSinceLatestUnrate: monthsSinceLatestUnrate >= 0 ? monthsSinceLatestUnrate : null,
        unemploymentAvailabilityStatus: 'WITHDRAWN', unemploymentProvenance: provenance,
      },
      availability: 'UNAVAILABLE',
    };
  }

  const currentKey = current.referencePeriod;
  const currentLevel = current.value;
  if (currentLevel.scale !== policy.unrateInputScale) {
    throw new MarketDataL3Error(DELTA_CODE,
      `UNRATE input scale must equal closed policy scale ${policy.unrateInputScale}`);
  }
  const window = policy.unrateTrendWindowMonths;
  const trendWindow = [];
  for (let offset = 1; offset <= window; offset += 1) {
    trendWindow.push(resolvedLevel(
      unrateIndex, addMonthsToMonthKey(currentKey, -offset), knowledgeCutoff,
    ));
  }
  for (const level of trendWindow) {
    if (level !== null && level.scale !== policy.unrateInputScale) {
      throw new MarketDataL3Error(DELTA_CODE,
        `UNRATE input scale must equal closed policy scale ${policy.unrateInputScale}`);
    }
  }
  const m1 = trendWindow[0];
  const trendWindowContiguous = trendWindow.every((value) => value !== null);
  const mWindow = trendWindowContiguous ? trendWindow[trendWindow.length - 1] : null;

  const unemploymentMoMChange = m1 === null ? null
    : macroNominalDeltaFixed(currentLevel, m1, DELTA_CODE);
  const unemploymentThreeMonthChange = mWindow === null ? null
    : macroNominalDeltaFixed(currentLevel, mWindow, DELTA_CODE);

  let unemploymentDirection = 'NOT_AVAILABLE';
  let unemploymentTrend = 'NOT_AVAILABLE';
  if (unemploymentMoMChange !== null) {
    const momSign = macroFixedSign(unemploymentMoMChange);
    unemploymentDirection = momSign > 0 ? 'RISING' : momSign < 0 ? 'FALLING' : 'UNCHANGED';
    const tmSign = unemploymentThreeMonthChange === null ? null
      : macroFixedSign(unemploymentThreeMonthChange);
    if (tmSign === null) {
      unemploymentTrend = 'NOT_AVAILABLE';
    } else if (momSign !== 0 && tmSign !== 0 && (momSign > 0) !== (tmSign > 0)) {
      unemploymentTrend = 'MIXED';
    } else if (momSign < 0) {
      unemploymentTrend = 'IMPROVING';
    } else if (momSign > 0) {
      unemploymentTrend = 'DETERIORATING';
    } else {
      unemploymentTrend = 'STABLE';
    }
  }

  const stale = monthsSinceLatestUnrate > policy.unrateStalenessMaxMonths;
  const unemploymentAvailabilityStatus = stale ? 'STALE' : 'AVAILABLE';
  const availability = (unemploymentAvailabilityStatus === 'AVAILABLE'
    && unemploymentMoMChange !== null && unemploymentThreeMonthChange !== null)
    ? 'COMPLETE' : 'PARTIAL';

  return {
    unemploymentState: {
      unemploymentRate: currentLevel,
      unemploymentReferencePeriod: currentKey,
      unemploymentAvailableAt: current.availableAt,
      unemploymentMoMChange,
      unemploymentThreeMonthChange,
      unemploymentDirection,
      unemploymentTrend,
      monthsSinceLatestUnrate,
      unemploymentAvailabilityStatus,
      unemploymentProvenance: provenance,
    },
    availability,
  };
}
