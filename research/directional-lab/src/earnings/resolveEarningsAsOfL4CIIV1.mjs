/**
 * L4C-I2 as-of resolver: what an explicitly pinned earnings snapshot makes
 * visible at one knowledgeCutoff.
 *
 * Standalone runtime resolver, exactly like its L4B-I2 sibling
 * resolveMacroVintageAsOfL4BV1.mjs. It has no CAS schema, writes nothing and
 * carries no state: the result is a pure function of
 * (snapshot, cutoff, as-of policy).
 *
 * Causal boundary: a revision is visible iff
 *   EarningsRevisionIdentityCore/1.publicAvailableAt <= knowledgeCutoff
 * Equality is included. Revisions published after the cutoff are ignored
 * silently - never counted, never digested, never an error. "latest", wall
 * clock, mtime, insertion order and CAS-wide scans are all absent by
 * construction: every id read here comes from the pinned snapshot composition.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  assertUtcInstant,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  assertExplicitPinnedEarningsIdV1,
} from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsDatasetSnapshotManifest } from './earningsDatasetSnapshotL4CIV1.mjs';
import { verifyEarningsRevisionIdentityCore } from './earningsRevisionL4CIV1.mjs';
import { verifyEarningsMetricObservationCore } from './earningsMetricObservationL4CIV1.mjs';
import { verifyEarningsAsOfResolutionPolicy } from './earningsAsOfResolutionPolicyL4CIIV1.mjs';

/** Bytewise ascending, strictly unique. Never insertion order. */
function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * Resolve the visible closure of a pinned snapshot as-of one cutoff.
 *
 * @param {{
 *   store: unknown,
 *   earningsDatasetSnapshotManifestId: string,
 *   knowledgeCutoff: string,
 *   earningsAsOfResolutionPolicyId: string
 * }} input
 */
export function resolveEarningsAsOfV1(input) {
  const api = assertApiInput(input, [
    'earningsDatasetSnapshotManifestId', 'knowledgeCutoff', 'earningsAsOfResolutionPolicyId',
  ]);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  for (const field of ['earningsDatasetSnapshotManifestId', 'earningsAsOfResolutionPolicyId']) {
    assertExplicitPinnedEarningsIdV1(api[field], field);
    assertCasId(api[field], field);
  }
  try {
    assertUtcInstant(api.knowledgeCutoff, 'knowledgeCutoff');
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_KNOWLEDGE_CUTOFF_INVALID',
      'knowledgeCutoff must be a strict UTC instant', { cause });
  }

  // The policy governs only once it is the pinned closed singleton.
  const { earningsAsOfResolutionPolicy: policy } = verifyEarningsAsOfResolutionPolicy({
    store: api.store, earningsAsOfResolutionPolicyId: api.earningsAsOfResolutionPolicyId,
  });
  if (policy.latestReferencePolicy !== 'FORBIDDEN'
    || policy.snapshotSelectionPolicy !== 'EXPLICIT_PIN_ONLY') {
    throw new MarketDataL3Error('EARNINGS_AS_OF_POLICY_INVALID',
      'as-of resolution requires an explicit-pin, latest-forbidden policy');
  }

  const verifiedSnapshot = verifyEarningsDatasetSnapshotManifest({
    store: api.store,
    earningsDatasetSnapshotManifestId: api.earningsDatasetSnapshotManifestId,
  });
  const snapshot = verifiedSnapshot.earningsDatasetSnapshotManifest;
  const { eventSet, revisionSet, extractionSet } = verifiedSnapshot.composition;

  const pinnedEventIds = new Set(eventSet.orderedEventEntries.map((e) => e.eventIdentityId));
  const extractionByRevision = new Map(extractionSet.orderedRevisionExtractionEntries
    .map((entry) => [entry.earningsRevisionIdentityId, entry]));

  const visibleEventIds = [];
  const visibleRevisionIds = [];
  const visibleExtractionReportIds = [];
  const visibleObservationIds = [];
  const visibleRawPeriodIds = [];
  const publicAvailableAts = [];
  /** Per-revision detail the materialization builder needs; runtime only. */
  const orderedVisibleRevisionEntries = [];

  for (const chain of revisionSet.orderedEventChains) {
    const earningsRevisionIdentityId = chain.orderedRevisions[0].earningsRevisionIdentityId;
    const identity = verifyEarningsRevisionIdentityCore({
      store: api.store, earningsRevisionIdentityId,
    }).earningsRevisionIdentityCore;

    // An /A filing is a distinct event with its own identity and its own
    // publicAvailableAt: it becomes visible on its own schedule.
    if (!pinnedEventIds.has(identity.eventIdentityId)) {
      throw new MarketDataL3Error('EARNINGS_AS_OF_REFERENCE_MISMATCH',
        'revision identity references an event outside the pinned event set');
    }
    // Cutoff boundary: equality is inside the visible set.
    if (identity.publicAvailableAt > api.knowledgeCutoff) continue;

    const entry = extractionByRevision.get(earningsRevisionIdentityId);
    if (entry === undefined) {
      throw new MarketDataL3Error('EARNINGS_AS_OF_REFERENCE_MISMATCH',
        'visible revision is absent from the pinned extraction set');
    }

    const rawPeriodIds = [];
    for (const earningsMetricObservationId of entry.orderedMetricObservationIds) {
      const observation = verifyEarningsMetricObservationCore({
        store: api.store, earningsMetricObservationId,
      }).earningsMetricObservationCore;
      if (observation.earningsRevisionIdentityId !== earningsRevisionIdentityId) {
        throw new MarketDataL3Error('EARNINGS_AS_OF_REFERENCE_MISMATCH',
          'observation belongs to a revision outside the pinned extraction entry');
      }
      visibleObservationIds.push(earningsMetricObservationId);
      rawPeriodIds.push(observation.financialPeriodIdentityId);
      visibleRawPeriodIds.push(observation.financialPeriodIdentityId);
    }

    visibleEventIds.push(identity.eventIdentityId);
    visibleRevisionIds.push(earningsRevisionIdentityId);
    visibleExtractionReportIds.push(entry.earningsMetricExtractionReportId);
    publicAvailableAts.push(identity.publicAvailableAt);
    orderedVisibleRevisionEntries.push({
      earningsRevisionIdentityId,
      eventIdentityId: identity.eventIdentityId,
      sourceFilingDocumentId: identity.sourceFilingDocumentId,
      publicAvailableAt: identity.publicAvailableAt,
      earningsMetricExtractionReportId: entry.earningsMetricExtractionReportId,
      orderedMetricObservationIds: [...entry.orderedMetricObservationIds],
      // A raw period shared by two visible revisions is counted once per
      // revision here and exactly once in the deduplicated snapshot-wide list.
      orderedRawPeriodIds: sortedUnique(rawPeriodIds),
    });
  }

  orderedVisibleRevisionEntries.sort((left, right) =>
    (left.earningsRevisionIdentityId < right.earningsRevisionIdentityId ? -1 : 1));
  const sortedPublicAvailableAts = [...publicAvailableAts].sort();
  const orderedVisibleRevisionIdentityIds = sortedUnique(visibleRevisionIds);

  return {
    earningsDatasetSnapshotManifestId: api.earningsDatasetSnapshotManifestId,
    earningsAsOfResolutionPolicyId: api.earningsAsOfResolutionPolicyId,
    knowledgeCutoff: api.knowledgeCutoff,
    sourceSnapshotEmpty: snapshot.emptySnapshot,
    emptyMaterialization: orderedVisibleRevisionIdentityIds.length === 0,
    orderedVisibleEventIdentityIds: sortedUnique(visibleEventIds),
    orderedVisibleRevisionIdentityIds,
    orderedVisibleExtractionReportIds: sortedUnique(visibleExtractionReportIds),
    orderedVisibleMetricObservationIds: sortedUnique(visibleObservationIds),
    orderedVisibleRawPeriodIds: sortedUnique(visibleRawPeriodIds),
    visibleEventCount: sortedUnique(visibleEventIds).length,
    visibleRevisionCount: orderedVisibleRevisionIdentityIds.length,
    visibleExtractionReportCount: sortedUnique(visibleExtractionReportIds).length,
    visibleMetricObservationCount: sortedUnique(visibleObservationIds).length,
    visibleRawPeriodCount: sortedUnique(visibleRawPeriodIds).length,
    earliestVisiblePublicAvailableAt: sortedPublicAvailableAts[0] ?? null,
    latestVisiblePublicAvailableAt: sortedPublicAvailableAts.at(-1) ?? null,
    orderedVisibleRevisionEntries,
  };
}
