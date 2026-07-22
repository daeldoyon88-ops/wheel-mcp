/**
 * Synthetic L4B-I2 fixtures: as-of policy, release calendar, binding and
 * materialization report. Reuses L4B-I1 official objects without mutating them.
 * Every value is fabricated offline test data.
 */

import {
  withEmptyMacroL4BI1Fixture,
  withMacroStore,
  withOfficialMacroL4BI1Fixture,
  pinSyntheticSourceDocument,
} from './macroIngestionL4BSyntheticFixture.mjs';
import { buildMacroAsOfResolutionPolicy } from '../src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import {
  buildMacroReleaseCalendarRegistryGenesis,
  buildMacroReleaseCalendarRegistryManifest,
  makeMacroReleaseEventVersion,
} from '../src/macro/macroReleaseCalendarRegistryL4BV1.mjs';
import { buildMacroDatasetBinding } from '../src/macro/macroDatasetBindingL4BV1.mjs';
import { buildMacroMaterializationReport } from '../src/macro/macroMaterializationReportL4BV1.mjs';
import {
  buildMacroObservationIdentityCore,
  buildMacroObservationVintageCore,
} from '../src/macro/macroObservationVintageL4BV1.mjs';
import { buildMacroVintageSetManifest } from '../src/macro/macroVintageSetL4BV1.mjs';
import { buildMacroDatasetSnapshotManifest } from '../src/macro/macroDatasetSnapshotL4BV1.mjs';
import { buildMacroSeriesIdentityCore, buildMacroSeriesRegistryGenesis } from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import { buildMacroIngestionPolicy } from '../src/macro/macroIngestionPolicyL4BV1.mjs';
import { syntheticMacroSeriesIdentity } from './macroIngestionL4BSyntheticFixture.mjs';

export { code, withMacroStore } from './macroIngestionL4BSyntheticFixture.mjs';

/** Official L4B-I2 golden fixture built on top of the official I1 fixture. */
export function withOfficialMacroL4BI2Fixture(callback) {
  return withOfficialMacroL4BI1Fixture((i1) => {
    const asOf = buildMacroAsOfResolutionPolicy({ store: i1.store });
    const cpiSeriesId = i1.series['US.BLS.CPIAUCSL'].macroSeriesIdentityId;
    const docSchedule = pinSyntheticSourceDocument(i1.store, 'cpi-calendar-schedule');
    const docReschedule = pinSyntheticSourceDocument(i1.store, 'cpi-calendar-reschedule');
    const docRelease = pinSyntheticSourceDocument(i1.store, 'cpi-calendar-release');

    const schedule = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: cpiSeriesId,
      referencePeriod: '2025-12',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'BLS',
      eventStatus: 'SCHEDULED',
      scheduledReleaseTimestamp: '2026-01-13T13:30:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2025-12-15T15:00:00.000Z',
      sourceDocumentId: docSchedule,
      supersedesReleaseEventVersionId: null,
      updateReason: 'INITIAL_SCHEDULE',
    });
    const reschedule = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: cpiSeriesId,
      referencePeriod: '2025-12',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'BLS',
      eventStatus: 'RESCHEDULED',
      scheduledReleaseTimestamp: '2026-01-14T13:30:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2026-01-05T15:00:00.000Z',
      sourceDocumentId: docReschedule,
      supersedesReleaseEventVersionId: schedule.releaseEventVersionId,
      updateReason: 'RESCHEDULE',
    });
    const released = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: cpiSeriesId,
      referencePeriod: '2025-12',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'BLS',
      eventStatus: 'RELEASED',
      scheduledReleaseTimestamp: '2026-01-14T13:30:00.000Z',
      actualReleaseTimestamp: '2026-01-14T13:30:00.000Z',
      availableAt: '2026-01-14T13:30:00.000Z',
      calendarKnowledgeAvailableAt: '2026-01-14T13:30:00.000Z',
      sourceDocumentId: docRelease,
      supersedesReleaseEventVersionId: reschedule.releaseEventVersionId,
      updateReason: 'ACTUAL_RELEASE',
    });

    const calendar = buildMacroReleaseCalendarRegistryGenesis({
      store: i1.store,
      macroSeriesRegistryManifestId: i1.registry.macroSeriesRegistryManifestId,
      jurisdictionCode: 'UNITED_STATES',
      currencyCode: 'USD',
      orderedReleaseEventVersions: [schedule, reschedule, released],
    });

    // Cutoff after CPI correction and calendar release, before ICSA benchmark.
    const knowledgeCutoff = '2026-02-11T18:00:00.000Z';
    const binding = buildMacroDatasetBinding({
      store: i1.store,
      macroDatasetSnapshotManifestId: i1.snapshot.macroDatasetSnapshotManifestId,
      macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
      macroReleaseCalendarRegistryManifestId: calendar.macroReleaseCalendarRegistryManifestId,
      knowledgeCutoff,
    });
    const report = buildMacroMaterializationReport({
      store: i1.store,
      macroDatasetBindingId: binding.macroDatasetBindingId,
    });

    return callback({
      ...i1,
      asOf,
      calendar,
      calendarVersions: { schedule, reschedule, released },
      knowledgeCutoff,
      binding,
      report,
    });
  });
}

/** Empty I2: series registry configured, zero observations, empty calendar. */
export function withEmptyMacroL4BI2Fixture(callback) {
  return withEmptyMacroL4BI1Fixture((i1) => {
    const asOf = buildMacroAsOfResolutionPolicy({ store: i1.store });
    const calendar = buildMacroReleaseCalendarRegistryGenesis({
      store: i1.store,
      macroSeriesRegistryManifestId: i1.registry.macroSeriesRegistryManifestId,
      jurisdictionCode: 'UNITED_STATES',
      currencyCode: 'USD',
      orderedReleaseEventVersions: [],
    });
    const binding = buildMacroDatasetBinding({
      store: i1.store,
      macroDatasetSnapshotManifestId: i1.snapshot.macroDatasetSnapshotManifestId,
      macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
      macroReleaseCalendarRegistryManifestId: calendar.macroReleaseCalendarRegistryManifestId,
      knowledgeCutoff: '2026-06-01T00:00:00.000Z',
    });
    const report = buildMacroMaterializationReport({
      store: i1.store,
      macroDatasetBindingId: binding.macroDatasetBindingId,
    });
    return callback({ ...i1, asOf, calendar, binding, report });
  });
}

/**
 * Extended synthetic chain with withdrawal, same-timestamp sequence and
 * future noise — for resolver / adversarial coverage.
 */
export function withMacroAsOfResolverFixture(callback) {
  return withMacroStore((store) => {
    const policyBuild = buildMacroIngestionPolicy({ store });
    const policy = policyBuild.macroIngestionPolicy;
    const series = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL'),
    });
    const registry = buildMacroSeriesRegistryGenesis({
      store,
      entries: [{
        macroSeriesIdentityId: series.macroSeriesIdentityId,
        canonicalSeriesCode: 'US.BLS.CPIAUCSL',
        status: 'ACTIVE',
        supersedesSeriesIdentityId: null,
        replacementReason: null,
      }],
    });
    const observation = buildMacroObservationIdentityCore({
      store,
      identity: {
        schemaVersion: 'MacroObservationIdentityCore/1',
        macroSeriesIdentityId: series.macroSeriesIdentityId,
        observationPeriodStart: '2025-11-01',
        observationPeriodEnd: '2025-11-30',
        referencePeriod: '2025-11',
        unit: 'INDEX',
        seasonalAdjustment: 'SEASONALLY_ADJUSTED',
      },
    });
    const docs = {
      initial: pinSyntheticSourceDocument(store, 'asof-initial'),
      revision: pinSyntheticSourceDocument(store, 'asof-revision'),
      sameTs: pinSyntheticSourceDocument(store, 'asof-same-ts'),
      withdrawal: pinSyntheticSourceDocument(store, 'asof-withdrawal'),
      future: pinSyntheticSourceDocument(store, 'asof-future'),
    };
    const vintage = (options) => buildMacroObservationVintageCore({
      store, policy, series: series.macroSeriesIdentity, ...options,
    });
    const initial = vintage({
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-10T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 0, value: { atoms: '300000', scale: 3 },
      revisionKind: 'INITIAL', parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: docs.initial,
    });
    const revision = vintage({
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-20T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 1, value: { atoms: '300100', scale: 3 },
      revisionKind: 'REVISION', parentVintageId: initial.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: docs.revision,
    });
    const sameTs = vintage({
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-20T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 2, value: { atoms: '300150', scale: 3 },
      revisionKind: 'CORRECTION', parentVintageId: revision.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: docs.sameTs,
    });
    const withdrawal = vintage({
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-25T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 3, value: null,
      revisionKind: 'WITHDRAWAL', parentVintageId: sameTs.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: docs.withdrawal,
    });
    const future = vintage({
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-03-01T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 4, value: { atoms: '301000', scale: 3 },
      revisionKind: 'BENCHMARK_REVISION', parentVintageId: withdrawal.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: docs.future,
    });

    // Note: restoration after withdrawal is forbidden at resolve-time. The
    // future vintage after withdrawal is kept in the set for anti-lookahead
    // and restoration-refusal tests; the vintage-set graph still allows it
    // as a causal child — the as-of policy rejects selecting it as RESOLVED
    // after a withdrawal tip.
    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: [
        initial.observationVintageId,
        revision.observationVintageId,
        sameTs.observationVintageId,
        withdrawal.observationVintageId,
        future.observationVintageId,
      ],
    });
    const asOf = buildMacroAsOfResolutionPolicy({ store });
    return callback({
      store, policy, series, registry, observation, asOf, vintageSet,
      vintages: { initial, revision, sameTs, withdrawal, future },
    });
  });
}
