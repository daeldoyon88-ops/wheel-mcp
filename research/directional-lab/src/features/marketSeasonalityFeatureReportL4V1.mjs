/**
 * L4A-C2 deterministic report derivation for seasonality features.
 * Counters come only from recomputed rows and occurrence unions — never from caller-supplied totals.
 */

import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import {
  MARKET_SEASONALITY_CONFIGURED_HORIZON_WINDOW_PAIR_COUNT,
  MARKET_SEASONALITY_CURRENT_WINDOW_STATUSES,
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
  MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1,
  MARKET_SEASONALITY_PRIMARY_AVAILABILITY_REASONS,
  MARKET_SEASONALITY_REJECTED_OCCURRENCE_COUNT_KEYS,
  normalizeMarketSeasonalityFeatureComputationReportV1,
} from '../contracts/marketSeasonalityFeatureComputationL4V1.mjs';

/** SHA-256 of CanonicalJSON([ { sessionDate, subjectBarIdentityId }, ... ]) in row order. */
export function computeSeasonalityOrderedRowIdentityDigestV1(rows) {
  const projection = rows.map((row) => ({
    sessionDate: row.sessionDate,
    subjectBarIdentityId: row.subjectBarIdentityId,
  }));
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(projection)).digest('hex')}`;
}

function emptyBucket() {
  return { rowPresenceCount: 0, occurrenceCountSum: 0, distinctOccurrenceCount: 0 };
}

function emptyReasonCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

/**
 * Derive the closed report value from verified IDs, recomputed rows and occurrence unions.
 * @param {object} input
 */
export function deriveMarketSeasonalityFeatureComputationReportValueV1(input) {
  const rows = input.document.rows;
  const unions = input.occurrenceUnions;
  const horizons = MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1.horizons;
  const forwards = MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1.forwardSessionCounts;

  const countsByHorizon = Object.fromEntries(horizons.map((horizon) => [String(horizon), emptyBucket()]));
  const countsByForwardSessionCount = Object.fromEntries(
    forwards.map((count) => [String(count), emptyBucket()]),
  );
  const availabilityCounts = emptyReasonCounts([
    'availableHorizonWindowCount', 'unavailableHorizonWindowCount',
  ]);
  const primaryAvailabilityReasonCounts = emptyReasonCounts(
    MARKET_SEASONALITY_PRIMARY_AVAILABILITY_REASONS,
  );
  const rejectedOccurrenceCounts = emptyReasonCounts(MARKET_SEASONALITY_REJECTED_OCCURRENCE_COUNT_KEYS);
  const currentWindowStatusCounts = emptyReasonCounts(MARKET_SEASONALITY_CURRENT_WINDOW_STATUSES);

  for (const row of rows) {
    availabilityCounts.availableHorizonWindowCount += row.availability.availableHorizonWindowCount;
    availabilityCounts.unavailableHorizonWindowCount += row.availability.unavailableHorizonWindowCount;
    for (const window of row.features.seasonality.horizonWindows) {
      const horizonKey = String(window.horizonYears);
      const forwardKey = String(window.forwardSessionCount);
      countsByHorizon[horizonKey].rowPresenceCount += 1;
      countsByHorizon[horizonKey].occurrenceCountSum += window.occurrenceCount;
      countsByForwardSessionCount[forwardKey].rowPresenceCount += 1;
      countsByForwardSessionCount[forwardKey].occurrenceCountSum += window.occurrenceCount;
      primaryAvailabilityReasonCounts[window.primaryAvailabilityReason] += 1;
      for (const key of MARKET_SEASONALITY_REJECTED_OCCURRENCE_COUNT_KEYS) {
        rejectedOccurrenceCounts[key] += window.diagnostics[key];
      }
    }
    for (const window of row.features.seasonality.currentWindows) {
      currentWindowStatusCounts[window.status] += 1;
    }
  }

  for (const horizon of horizons) {
    const key = String(horizon);
    countsByHorizon[key].distinctOccurrenceCount = unions.distinctOccurrenceCountByHorizon[key];
  }
  for (const count of forwards) {
    const key = String(count);
    countsByForwardSessionCount[key].distinctOccurrenceCount =
      unions.distinctOccurrenceCountByForwardSessionCount[key];
  }

  return normalizeMarketSeasonalityFeatureComputationReportV1({
    schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    seasonalityFeatureSourceBundleId: input.seasonalityFeatureSourceBundleId,
    seasonalityFeatureComputationPolicyId: input.seasonalityFeatureComputationPolicyId,
    seasonalityFeatureRowsId: input.seasonalityFeatureRowsId,
    datasetSnapshotBindingId: input.sourceBundle.subjectBindingId,
    instrumentIdentityId: input.sourceBundle.instrumentIdentityId,
    normalizedMarketDataObjectId: input.sourceBundle.normalizedMarketDataObjectId,
    knowledgeCutoff: input.sourceBundle.knowledgeCutoff,
    priceBasis: input.sourceBundle.priceBasis,
    corporateActionTreatment: input.sourceBundle.corporateActionTreatment,
    featureFamilyVersion: MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
    implementationManifestId: input.sourceBundle.implementationManifestId,
    rowCount: rows.length,
    firstSessionDate: rows.length === 0 ? null : rows[0].sessionDate,
    lastSessionDate: rows.length === 0 ? null : rows[rows.length - 1].sessionDate,
    configuredHorizonWindowPairCount: MARKET_SEASONALITY_CONFIGURED_HORIZON_WINDOW_PAIR_COUNT,
    countsByHorizon,
    countsByForwardSessionCount,
    availabilityCounts,
    primaryAvailabilityReasonCounts,
    rejectedOccurrenceCounts,
    currentWindowStatusCounts,
    partialCurrentWindowCount: currentWindowStatusCounts.IN_PROGRESS,
    completedCurrentWindowCount: currentWindowStatusCounts.COMPLETE_AS_OF_T,
    distinctOccurrenceCount: unions.distinctOccurrenceCount,
    distinctHistoricalYearCount: unions.distinctHistoricalYearCount,
    emptySnapshot: rows.length === 0,
    orderedRowIdentityDigest: computeSeasonalityOrderedRowIdentityDigestV1(rows),
  });
}
