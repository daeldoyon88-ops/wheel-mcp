/**
 * L4B-F1 FOMC state: decision classification from DFEDTAR changes and optional
 * FOMC.DECISION observation, plus next-known event from the release calendar
 * resolved as-of session close only.
 */

import {
  MarketDataL3Error,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  F1_SERIES_ALIAS_TO_CODE,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  fixedFromCanonical,
} from '../features/fixedPointFeatureMathL4V1.mjs';
import { resolveMacroReleaseCalendarAsOf } from './macroReleaseCalendarRegistryL4BV1.mjs';

function resolutionByCode(orderedResolutions, code) {
  return orderedResolutions.find((row) => row.canonicalSeriesCode === code) ?? null;
}

function classifyDecisionType(lowerChange, upperChange, midpointChange, withdrawn) {
  if (withdrawn) return 'WITHDRAWN';
  if (midpointChange === null || lowerChange === null || upperChange === null) {
    return 'NOT_AVAILABLE';
  }
  const mid = fixedFromCanonical(midpointChange, midpointChange.scale);
  const lower = fixedFromCanonical(lowerChange, lowerChange.scale);
  const upper = fixedFromCanonical(upperChange, upperChange.scale);
  const widthChanged = lower.atoms !== upper.atoms
    || (lower.atoms !== 0n || upper.atoms !== 0n);
  // Range restructure: width changes without a clear mid direction, or asymmetric bounds.
  const midZero = mid.atoms === 0n;
  const asymmetric = lower.atoms !== upper.atoms;
  if ((widthChanged && midZero) || (asymmetric && midZero && (lower.atoms !== 0n || upper.atoms !== 0n))) {
    return 'RANGE_RESTRUCTURE';
  }
  if (mid.atoms > 0n) return 'HIKE';
  if (mid.atoms < 0n) return 'CUT';
  if (lower.atoms === 0n && upper.atoms === 0n) return 'HOLD';
  if (asymmetric) return 'RANGE_RESTRUCTURE';
  return 'HOLD';
}

function sessionsBetween(orderedSessions, fromSessionId, toSessionId) {
  if (fromSessionId === null || toSessionId === null) return null;
  const fromIndex = orderedSessions.findIndex((session) => session.sessionId === fromSessionId);
  const toIndex = orderedSessions.findIndex((session) => session.sessionId === toSessionId);
  if (fromIndex < 0 || toIndex < 0 || toIndex < fromIndex) return null;
  return toIndex - fromIndex;
}

/**
 * @param {object} input
 */
export function computeFomcState(input) {
  const {
    store, binding, calendarRegistry, orderedResolutions, rateState, previousFomcState,
    session, orderedSessionsWithIds, seriesRegistry,
  } = input;

  const lowerRes = resolutionByCode(orderedResolutions, F1_SERIES_ALIAS_TO_CODE.FED_TARGET_LOWER_BOUND);
  const upperRes = resolutionByCode(orderedResolutions, F1_SERIES_ALIAS_TO_CODE.FED_TARGET_UPPER_BOUND);
  const decisionRes = resolutionByCode(orderedResolutions, F1_SERIES_ALIAS_TO_CODE.FOMC_DECISION);

  const withdrawn = (lowerRes?.availabilityStatus === 'WITHDRAWN')
    || (upperRes?.availabilityStatus === 'WITHDRAWN')
    || (decisionRes?.availabilityStatus === 'WITHDRAWN');

  const lowerChange = rateState.lowerBoundChange;
  const upperChange = rateState.upperBoundChange;
  const midpointChange = rateState.midpointChange;

  const boundsChanged = midpointChange !== null
    && (fixedFromCanonical(midpointChange, midpointChange.scale).atoms !== 0n
      || (lowerChange !== null && fixedFromCanonical(lowerChange, lowerChange.scale).atoms !== 0n)
      || (upperChange !== null && fixedFromCanonical(upperChange, upperChange.scale).atoms !== 0n));

  const decisionAvailable = decisionRes
    && (decisionRes.availabilityStatus === 'AVAILABLE' || decisionRes.availabilityStatus === 'STALE')
    && decisionRes.availableAt !== null
    && decisionRes.availableAt <= session.closeUtc;

  const decisionDuringSession = Boolean(
    (boundsChanged && previousFomcState !== undefined)
    || (decisionAvailable && previousFomcState
      && decisionRes.availableAt
      && (previousFomcState.lastKnownFomcDecisionAvailableAt === null
        || decisionRes.availableAt > previousFomcState.lastKnownFomcDecisionAvailableAt)),
  );

  // First session: treat a known midpoint as not "during" unless previous exists
  // and values changed. When previous is null, decisionDuringSession is false
  // unless decision observation availableAt falls within (prevClose, close].
  let fomcDecisionDuringSession = false;
  if (previousFomcState === null) {
    fomcDecisionDuringSession = false;
  } else if (boundsChanged) {
    fomcDecisionDuringSession = true;
  } else if (decisionAvailable) {
    const prevAt = previousFomcState.lastKnownFomcDecisionAvailableAt;
    if (prevAt === null || decisionRes.availableAt > prevAt) {
      fomcDecisionDuringSession = true;
    }
  }

  const fomcDecisionType = fomcDecisionDuringSession
    ? classifyDecisionType(lowerChange, upperChange, midpointChange, withdrawn)
    : (withdrawn && decisionDuringSession ? 'WITHDRAWN' : 'NOT_AVAILABLE');

  let lastKnownFomcDecisionEventId = previousFomcState?.lastKnownFomcDecisionEventId ?? null;
  let lastKnownFomcDecisionAvailableAt = previousFomcState?.lastKnownFomcDecisionAvailableAt ?? null;
  let lastKnownFomcDecisionSessionId = previousFomcState?.lastKnownFomcDecisionSessionId ?? null;
  let lastFomcReleaseEventVersionId = previousFomcState?.lastFomcReleaseEventVersionId ?? null;

  if (fomcDecisionDuringSession && !withdrawn) {
    lastKnownFomcDecisionAvailableAt = decisionRes?.availableAt
      ?? lowerRes?.availableAt
      ?? upperRes?.availableAt
      ?? session.closeUtc;
    lastKnownFomcDecisionSessionId = session.sessionId;
    lastKnownFomcDecisionEventId = decisionRes?.observationIdentityId
      ?? lowerRes?.observationIdentityId
      ?? upperRes?.observationIdentityId
      ?? session.sessionId;
  } else if (fomcDecisionDuringSession && withdrawn) {
    lastKnownFomcDecisionAvailableAt = decisionRes?.availableAt
      ?? lowerRes?.availableAt
      ?? session.closeUtc;
    lastKnownFomcDecisionSessionId = session.sessionId;
    lastKnownFomcDecisionEventId = decisionRes?.observationIdentityId
      ?? lowerRes?.observationIdentityId
      ?? null;
  }

  const sessionsSinceLastFomcDecision = lastKnownFomcDecisionSessionId === null
    ? null
    : sessionsBetween(orderedSessionsWithIds, lastKnownFomcDecisionSessionId, session.sessionId);

  // Calendar: unique FOMC logical events, resolve as-of close.
  const fomcSeriesEntry = seriesRegistry.orderedSeriesEntries
    .find((entry) => entry.canonicalSeriesCode === F1_SERIES_ALIAS_TO_CODE.FOMC_DECISION);
  let nextKnownFomcEventId = null;
  let nextKnownFomcScheduledTimestamp = null;
  let sessionsUntilNextKnownFomcEvent = null;
  let nextEventKnowledgeAvailableAt = null;
  let fomcCalendarStatus = null;
  let nextFomcReleaseEventVersionId = null;
  let futureCalendarUpdateRejectedCount = 0;

  if (fomcSeriesEntry) {
    const identityIds = [...new Set(calendarRegistry.orderedReleaseEventVersions
      .filter((version) => version.macroSeriesIdentityId === fomcSeriesEntry.macroSeriesIdentityId)
      .map((version) => version.releaseEventIdentityId))].sort();

    for (const version of calendarRegistry.orderedReleaseEventVersions) {
      if (version.macroSeriesIdentityId === fomcSeriesEntry.macroSeriesIdentityId
          && version.calendarKnowledgeAvailableAt > session.closeUtc) {
        futureCalendarUpdateRejectedCount += 1;
      }
    }

    const nextCandidates = [];
    for (const releaseEventIdentityId of identityIds) {
      const state = resolveMacroReleaseCalendarAsOf({
        store,
        releaseEventIdentityId,
        knowledgeCutoff: session.closeUtc,
        macroReleaseCalendarRegistryManifestId: binding.macroReleaseCalendarRegistryManifestId,
      });
      if (state.resolutionStatus !== 'RESOLVED') continue;
      if (state.eventStatus === 'CANCELLED') continue;
      if (state.scheduledReleaseTimestamp === null) continue;
      if (state.scheduledReleaseTimestamp <= session.closeUtc) continue;
      if (state.calendarKnowledgeAvailableAt > session.closeUtc) {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_FOMC_FUTURE_KNOWLEDGE',
          'calendar tip knowledge exceeds session close');
      }
      nextCandidates.push(state);
    }
    nextCandidates.sort((left, right) => {
      if (left.scheduledReleaseTimestamp < right.scheduledReleaseTimestamp) return -1;
      if (left.scheduledReleaseTimestamp > right.scheduledReleaseTimestamp) return 1;
      return left.releaseEventIdentityId < right.releaseEventIdentityId ? -1
        : left.releaseEventIdentityId > right.releaseEventIdentityId ? 1 : 0;
    });
    if (nextCandidates.length > 0) {
      const next = nextCandidates[0];
      nextKnownFomcEventId = next.releaseEventIdentityId;
      nextKnownFomcScheduledTimestamp = next.scheduledReleaseTimestamp;
      nextEventKnowledgeAvailableAt = next.calendarKnowledgeAvailableAt;
      fomcCalendarStatus = next.eventStatus;
      nextFomcReleaseEventVersionId = next.selectedReleaseEventVersionId;
      const targetSession = orderedSessionsWithIds.find((item) => (
        item.closeUtc >= next.scheduledReleaseTimestamp
      ));
      if (targetSession) {
        sessionsUntilNextKnownFomcEvent = sessionsBetween(
          orderedSessionsWithIds, session.sessionId, targetSession.sessionId,
        );
      }
    }
  }

  let fomcStateAvailability = 'UNAVAILABLE';
  if (lastKnownFomcDecisionEventId !== null || nextKnownFomcEventId !== null) {
    fomcStateAvailability = (lastKnownFomcDecisionEventId !== null && nextKnownFomcEventId !== null)
      ? 'COMPLETE'
      : 'PARTIAL';
  }

  return {
    state: {
      lastKnownFomcDecisionEventId,
      lastKnownFomcDecisionAvailableAt,
      lastKnownFomcDecisionSessionId,
      sessionsSinceLastFomcDecision,
      fomcDecisionDuringSession,
      fomcDecisionType: fomcDecisionDuringSession ? fomcDecisionType : 'NOT_AVAILABLE',
      targetLowerChange: fomcDecisionDuringSession ? lowerChange : null,
      targetUpperChange: fomcDecisionDuringSession ? upperChange : null,
      targetMidpointChange: fomcDecisionDuringSession ? midpointChange : null,
      nextKnownFomcEventId,
      nextKnownFomcScheduledTimestamp,
      sessionsUntilNextKnownFomcEvent,
      nextEventKnowledgeAvailableAt,
      fomcCalendarStatus,
      fomcStateAvailability,
    },
    lastFomcReleaseEventVersionId,
    nextFomcReleaseEventVersionId,
    futureCalendarUpdateRejectedCount,
  };
}

export { classifyDecisionType };
