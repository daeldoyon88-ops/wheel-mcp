/**
 * L4B-I2 MacroMaterializationReport/1: recomputable proof of what a macro
 * binding makes available as-of its knowledgeCutoff. No feature rows are
 * produced. Every counter and digest is derived; none may be caller-supplied.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  canonicalDigest,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  compareMacroCalendarStateOrderKeys,
  compareMacroResolvedObservationOrderKeys,
  normalizeMacroMaterializationReportV1,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroDatasetBinding } from './macroDatasetBindingL4BV1.mjs';
import { resolveMacroVintageAsOf } from './resolveMacroVintageAsOfL4BV1.mjs';
import {
  resolveMacroReleaseCalendarAsOf,
  verifyMacroReleaseCalendarRegistryManifest,
} from './macroReleaseCalendarRegistryL4BV1.mjs';
import { verifyMacroObservationVintageCore } from './macroObservationVintageL4BV1.mjs';

function emptyCountMap(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function bump(map, key) {
  if (!Object.hasOwn(map, key)) map[key] = 0;
  map[key] += 1;
}

/**
 * Recompute the full materialization report value from a verified binding.
 * Future vintages and future calendar knowledge are excluded by the resolvers.
 */
export function computeMacroMaterializationReportValueV1(store, bindingId, bindingContext) {
  const { binding, vintageSet, seriesRegistry, calendarRegistry } = bindingContext;
  const knowledgeCutoff = binding.knowledgeCutoff;

  const countsByResolutionStatus = emptyCountMap(['NOT_AVAILABLE', 'RESOLVED', 'WITHDRAWN']);
  const countsByCompletenessClass = {};
  const countsByRevisionKind = {};
  const resolvedRows = [];
  let futureVintageRejectedCount = 0;
  let revisionCountUsed = 0;
  let correctionCountUsed = 0;
  let benchmarkRevisionCountUsed = 0;

  for (const observation of vintageSet.orderedObservationEntries) {
    for (const vintageEntry of observation.orderedVintages) {
      if (vintageEntry.availableAt > knowledgeCutoff) futureVintageRejectedCount += 1;
    }
    const resolution = resolveMacroVintageAsOf({
      store,
      observationIdentityId: observation.observationIdentityId,
      knowledgeCutoff,
      macroVintageSetManifestId: binding.macroVintageSetManifestId,
      macroAsOfResolutionPolicyId: binding.macroAsOfResolutionPolicyId,
    });
    bump(countsByResolutionStatus, resolution.resolutionStatus);

    if (resolution.resolutionStatus === 'RESOLVED'
        || resolution.resolutionStatus === 'WITHDRAWN') {
      const { observationVintage } = verifyMacroObservationVintageCore({
        store, observationVintageId: resolution.selectedMacroObservationVintageId,
      });
      bump(countsByCompletenessClass, observationVintage.vintageCompletenessClass);
      bump(countsByRevisionKind, observationVintage.revisionKind);
      if (observationVintage.revisionKind === 'REVISION') revisionCountUsed += 1;
      if (observationVintage.revisionKind === 'CORRECTION') correctionCountUsed += 1;
      if (observationVintage.revisionKind === 'BENCHMARK_REVISION') {
        benchmarkRevisionCountUsed += 1;
      }
      if (resolution.resolutionStatus === 'RESOLVED') {
        resolvedRows.push({
          macroSeriesIdentityId: observation.macroSeriesIdentityId,
          observationPeriodStart: observation.observationPeriodStart,
          observationPeriodEnd: observation.observationPeriodEnd,
          observationIdentityId: observation.observationIdentityId,
          selectedAvailableAt: resolution.selectedAvailableAt,
          selectedVintageSequence: resolution.selectedVintageSequence,
          selectedMacroVintageIdentityId: resolution.selectedMacroVintageIdentityId,
        });
      }
    }
  }

  resolvedRows.sort(compareMacroResolvedObservationOrderKeys);
  const availableAts = resolvedRows.map((row) => row.selectedAvailableAt).sort();

  // Unique logical release events, resolved as-of the binding cutoff.
  const identityIds = [...new Set(calendarRegistry.orderedReleaseEventVersions
    .map((version) => version.releaseEventIdentityId))].sort();
  const calendarStates = [];
  const statusCounts = {
    SCHEDULED: 0, RESCHEDULED: 0, RELEASED: 0, CANCELLED: 0, DELAYED: 0,
  };
  for (const releaseEventIdentityId of identityIds) {
    const state = resolveMacroReleaseCalendarAsOf({
      store,
      releaseEventIdentityId,
      knowledgeCutoff,
      macroReleaseCalendarRegistryManifestId: binding.macroReleaseCalendarRegistryManifestId,
    });
    if (state.resolutionStatus !== 'RESOLVED') continue;
    statusCounts[state.eventStatus] += 1;
    calendarStates.push({
      macroSeriesIdentityId: state.macroSeriesIdentityId,
      referencePeriod: state.referencePeriod,
      releaseKind: state.releaseKind,
      releaseEventIdentityId: state.releaseEventIdentityId,
      calendarKnowledgeAvailableAt: state.calendarKnowledgeAvailableAt,
      releaseEventVersionId: state.selectedReleaseEventVersionId,
      eventStatus: state.eventStatus,
    });
  }
  calendarStates.sort(compareMacroCalendarStateOrderKeys);

  const observationCount = vintageSet.observationCount;
  const releaseCalendarEventCount = calendarStates.length;
  return normalizeMacroMaterializationReportV1({
    schemaVersion: MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    macroDatasetBindingId: bindingId,
    macroDatasetSnapshotManifestId: binding.macroDatasetSnapshotManifestId,
    macroVintageSetManifestId: binding.macroVintageSetManifestId,
    macroSeriesRegistryManifestId: binding.macroSeriesRegistryManifestId,
    macroReleaseCalendarRegistryManifestId: binding.macroReleaseCalendarRegistryManifestId,
    macroIngestionPolicyId: binding.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: binding.macroAsOfResolutionPolicyId,
    knowledgeCutoff,
    jurisdictionCode: binding.jurisdictionCode,
    currencyCode: binding.currencyCode,
    seriesCount: seriesRegistry.orderedSeriesEntries.length,
    observationCount,
    resolvedObservationCount: countsByResolutionStatus.RESOLVED,
    notAvailableObservationCount: countsByResolutionStatus.NOT_AVAILABLE,
    withdrawnObservationCount: countsByResolutionStatus.WITHDRAWN,
    futureVintageRejectedCount,
    revisionCountUsed,
    correctionCountUsed,
    benchmarkRevisionCountUsed,
    releaseCalendarEventCount,
    scheduledEventCount: statusCounts.SCHEDULED,
    rescheduledEventCount: statusCounts.RESCHEDULED,
    releasedEventCount: statusCounts.RELEASED,
    cancelledEventCount: statusCounts.CANCELLED,
    delayedEventCount: statusCounts.DELAYED,
    earliestResolvedAvailableAt: availableAts.length === 0 ? null : availableAts[0],
    latestResolvedAvailableAt: availableAts.length === 0 ? null : availableAts[availableAts.length - 1],
    countsByResolutionStatus,
    countsByCompletenessClass,
    countsByRevisionKind,
    orderedResolvedVintageIdentityDigest: canonicalDigest(
      resolvedRows.map((row) => row.selectedMacroVintageIdentityId),
    ),
    orderedResolvedObservationDigest: canonicalDigest(
      resolvedRows.map((row) => row.observationIdentityId),
    ),
    orderedCalendarStateDigest: canonicalDigest(
      calendarStates.map((state) => state.releaseEventVersionId),
    ),
    emptyMaterialization: observationCount === 0 && releaseCalendarEventCount === 0,
  });
}

export function buildMacroMaterializationReport(input) {
  const api = assertApiInput(input, ['macroDatasetBindingId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroDatasetBindingId, 'macroDatasetBindingId');
  assertCasId(api.macroDatasetBindingId, 'macroDatasetBindingId');

  const bindingContext = verifyMacroDatasetBinding({
    store: api.store, macroDatasetBindingId: api.macroDatasetBindingId,
  });
  // Ensure calendar verifier still agrees with the binding pin.
  verifyMacroReleaseCalendarRegistryManifest({
    store: api.store,
    macroReleaseCalendarRegistryManifestId:
      bindingContext.binding.macroReleaseCalendarRegistryManifestId,
  });

  const report = computeMacroMaterializationReportValueV1(
    api.store, api.macroDatasetBindingId, bindingContext,
  );
  const stored = putCanonicalL3(api.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: api.store, macroMaterializationReportId: stored.objectId,
  });
  return {
    macroMaterializationReportId: stored.objectId,
    materializationReport: stored.value,
  };
}

export function verifyMacroMaterializationReport(input) {
  const api = assertApiInput(input, ['macroMaterializationReportId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroMaterializationReportId, 'macroMaterializationReportId');
  assertCasId(api.macroMaterializationReportId, 'macroMaterializationReportId');
  const raw = readTypedReference(api.store, api.macroMaterializationReportId,
    MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, 'macro materialization report');
  const report = normalizeMacroMaterializationReportV1(raw);

  const bindingContext = verifyMacroDatasetBinding({
    store: api.store, macroDatasetBindingId: report.macroDatasetBindingId,
  });
  const expected = computeMacroMaterializationReportValueV1(
    api.store, report.macroDatasetBindingId, bindingContext,
  );
  if (!canonicalValuesEqual(report, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_MATERIALIZATION_REPORT_MISMATCH',
      'materialization report diverges from its recomputed canonical value');
  }
  return {
    macroMaterializationReportId: api.macroMaterializationReportId,
    materializationReport: report,
    binding: bindingContext.binding,
  };
}
