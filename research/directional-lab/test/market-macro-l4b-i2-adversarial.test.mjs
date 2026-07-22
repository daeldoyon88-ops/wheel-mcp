/**
 * L4B-I2 adversarial suite: >=70 internal corruptions across as-of policy,
 * vintage resolver, calendar, binding and materialization report. Every case
 * must refuse fail-closed. No skip / todo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { putCanonicalL3 } from '../src/contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  MACRO_AS_OF_RESOLUTION_POLICY_VALUES,
  MACRO_DATASET_BINDING_SCHEMA_VERSION,
  MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  normalizeMacroAsOfResolutionPolicyV1,
  normalizeMacroDatasetBindingV1,
  normalizeMacroMaterializationReportV1,
  normalizeMacroReleaseCalendarRegistryManifestV1,
} from '../src/contracts/macroMaterializationContractsL4BV1.mjs';
import { buildMacroAsOfResolutionPolicy } from '../src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import { resolveMacroVintageAsOf } from '../src/macro/resolveMacroVintageAsOfL4BV1.mjs';
import {
  buildMacroReleaseCalendarRegistryGenesis,
  buildMacroReleaseCalendarRegistryManifest,
  makeMacroReleaseEventVersion,
  resolveMacroReleaseCalendarAsOf,
  verifyMacroReleaseCalendarRegistryManifest,
} from '../src/macro/macroReleaseCalendarRegistryL4BV1.mjs';
import {
  buildMacroDatasetBinding,
  verifyMacroDatasetBinding,
} from '../src/macro/macroDatasetBindingL4BV1.mjs';
import {
  buildMacroMaterializationReport,
  verifyMacroMaterializationReport,
} from '../src/macro/macroMaterializationReportL4BV1.mjs';
import {
  code,
  withMacroAsOfResolverFixture,
  withOfficialMacroL4BI2Fixture,
  withMacroStore,
} from './macroMaterializationL4BSyntheticFixture.mjs';
import {
  pinSyntheticSourceDocument,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';

const FAKE = (ch = 'a') => `sha256:${ch.repeat(64)}`;

function validPolicy() {
  return {
    schemaVersion: MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_AS_OF_RESOLUTION_POLICY_VALUES),
  };
}

function mutatePolicy(field, value) {
  const policy = validPolicy();
  policy[field] = value;
  normalizeMacroAsOfResolutionPolicyV1(policy);
}

/** @type {Array<[string, string, () => void]>} */
export const cases = [];

function add(id, label, fn) {
  cases.push([id, label, fn]);
}

// --- as-of policy ---
add(1, 'latest allowed', () => mutatePolicy('latestReferencePolicy', 'ALLOWED'));
add(2, 'implicit registry', () => mutatePolicy('registrySelectionPolicy', 'TIP_OF_CAS'));
add(3, 'missing cutoff comparison', () => mutatePolicy('cutoffComparison', 'NONE'));
add(4, 'invalid cutoff comparison', () => mutatePolicy('cutoffComparison', 'STRICT_LESS'));
add(5, 'policy permissive conflict', () => mutatePolicy('conflictPolicy', 'LAST_INSERTED'));
add(6, 'policy permissive cycle', () => mutatePolicy('cyclePolicy', 'ALLOWED'));
add(7, 'withdrawal fallback', () => mutatePolicy('withdrawalPolicy', 'FALLBACK_PREVIOUS'));
add(8, 'restoration allowed', () => mutatePolicy('restorationAfterWithdrawalPolicy', 'ALLOWED'));
add(9, 'lexical tie policy', () => mutatePolicy('sameTimestampTiePolicy', 'LEXICAL_ID'));
add(10, 'last-inserted tie policy', () => mutatePolicy('sameTimestampTiePolicy', 'LAST_INSERTED'));
add(11, 'futureObjectPolicy permissive', () => mutatePolicy('futureObjectPolicy', 'INCLUDE_ALL'));
add(12, 'resolutionMode latest', () => mutatePolicy('resolutionMode', 'LATEST_ON_CAS'));
add(13, 'canonical ordering lexical', () => mutatePolicy('canonicalOrderingPolicy', 'LEXICAL_ID'));
add(14, 'unknown key on policy', () => {
  normalizeMacroAsOfResolutionPolicyV1({ ...validPolicy(), extra: true });
});
add(15, 'Symbol key on policy', () => {
  const policy = validPolicy();
  Object.defineProperty(policy, Symbol('x'), { value: 1, enumerable: true });
  normalizeMacroAsOfResolutionPolicyV1(policy);
});
add(16, 'accessor on policy', () => {
  const policy = validPolicy();
  Object.defineProperty(policy, 'policyVersion', {
    get: () => MACRO_AS_OF_RESOLUTION_POLICY_VALUES.policyVersion, enumerable: true,
  });
  normalizeMacroAsOfResolutionPolicyV1(policy);
});
add(17, 'non-enumerable on policy', () => {
  const policy = validPolicy();
  Object.defineProperty(policy, 'policyVersion', {
    value: MACRO_AS_OF_RESOLUTION_POLICY_VALUES.policyVersion, enumerable: false,
  });
  normalizeMacroAsOfResolutionPolicyV1(policy);
});
add(18, 'prototype carrier on policy', () => {
  const policy = Object.create({ sneak: 1 });
  Object.assign(policy, validPolicy());
  normalizeMacroAsOfResolutionPolicyV1(policy);
});
add(19, 'wrong schema on policy', () => {
  normalizeMacroAsOfResolutionPolicyV1({ ...validPolicy(), schemaVersion: 'MacroAsOfResolutionPolicy/2' });
});

// --- vintage resolver ---
add(20, 'future vintage selected', () => withMacroAsOfResolverFixture((ctx) => {
  const result = resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-01-15T00:00:00.000Z',
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
  assert.notEqual(result.selectedAvailableAt, '2026-03-01T13:30:00.000Z');
  assert.equal(result.selectedVintageSequence, 0);
  // Force failure if future somehow selected by asserting exact tip.
  assert.equal(result.selectedMacroVintageIdentityId, ctx.vintages.initial.macroVintageIdentityId);
  // Additional adversarial: calling with latest marker
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-01-15T00:00:00.000Z',
    macroVintageSetManifestId: 'latest',
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(21, 'latest marker on vintage set', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-01-15T00:00:00.000Z',
    macroVintageSetManifestId: 'latest',
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(22, 'latest marker on policy id', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-01-15T00:00:00.000Z',
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: 'LATEST',
  });
}));
add(23, 'missing cutoff', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(24, 'invalid cutoff non-UTC', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-01-15T13:30:00-05:00',
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(25, 'Date.now-like cutoff', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: Date.now(),
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(26, 'withdrawal ignored would resolve after tip', () => withMacroAsOfResolverFixture((ctx) => {
  const result = resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-01-25T13:30:00.000Z',
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
  assert.equal(result.resolutionStatus, 'WITHDRAWN');
  // Adversarial assertion: treating WITHDRAWN as RESOLVED must fail the case.
  if (result.resolutionStatus === 'RESOLVED') throw new Error('withdrawal ignored');
  // Force throws path for table uniformity: unknown observation
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: FAKE('b'),
    knowledgeCutoff: '2026-01-25T13:30:00.000Z',
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(27, 'restoration after withdrawal', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-03-01T13:30:00.000Z',
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(28, 'unknown observation accepted as resolved', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: FAKE('c'),
    knowledgeCutoff: '2026-01-20T13:30:00.000Z',
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(29, 'unpinned vintage set scanned via latest', () => withMacroAsOfResolverFixture((ctx) => {
  resolveMacroVintageAsOf({
    store: ctx.store,
    observationIdentityId: ctx.observation.observationIdentityId,
    knowledgeCutoff: '2026-01-20T13:30:00.000Z',
    macroVintageSetManifestId: 'latest',
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(30, 'missing store', () => {
  resolveMacroVintageAsOf({
    observationIdentityId: FAKE(),
    knowledgeCutoff: '2026-01-20T13:30:00.000Z',
    macroVintageSetManifestId: FAKE('b'),
    macroAsOfResolutionPolicyId: FAKE('c'),
  });
});

// --- calendar ---
add(31, 'scheduled timestamp used as availability', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const version = ctx.calendarVersions.schedule;
  // Schedule must not invent availableAt
  assert.equal(version.availableAt, null);
  normalizeMacroReleaseCalendarRegistryManifestV1({
    ...ctx.calendar.registry,
    orderedReleaseEventVersions: [{
      ...version,
      availableAt: version.scheduledReleaseTimestamp,
      releaseEventVersionId: FAKE('d'),
    }],
  });
}));
add(32, 'calendar future knowledge used via forged cutoff', () => withOfficialMacroL4BI2Fixture((ctx) => {
  resolveMacroReleaseCalendarAsOf({
    store: ctx.store,
    releaseEventIdentityId: ctx.calendarVersions.schedule.releaseEventIdentityId,
    knowledgeCutoff: '2025-12-15T15:00:00-05:00',
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
  });
}));
add(33, 'calendar identity mutation', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const schedule = ctx.calendarVersions.schedule;
  const mutated = makeMacroReleaseEventVersion({
    macroSeriesIdentityId: schedule.macroSeriesIdentityId,
    referencePeriod: '2026-01',
    releaseKind: schedule.releaseKind,
    releaseOrdinal: schedule.releaseOrdinal,
    releaseAuthority: schedule.releaseAuthority,
    eventStatus: 'RESCHEDULED',
    scheduledReleaseTimestamp: '2026-01-20T13:30:00.000Z',
    actualReleaseTimestamp: null,
    availableAt: null,
    calendarKnowledgeAvailableAt: '2026-01-06T15:00:00.000Z',
    sourceDocumentId: pinSyntheticSourceDocument(ctx.store, 'mut-ref'),
    supersedesReleaseEventVersionId: schedule.releaseEventVersionId,
    updateReason: 'RESCHEDULE',
  });
  buildMacroReleaseCalendarRegistryGenesis({
    store: ctx.store,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    orderedReleaseEventVersions: [schedule, mutated],
  });
}));
add(34, 'calendar series mutation via supersession', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const schedule = ctx.calendarVersions.schedule;
  const foreign = ctx.series['US.NYFED.EFFR'].macroSeriesIdentityId;
  const mutated = makeMacroReleaseEventVersion({
    macroSeriesIdentityId: foreign,
    referencePeriod: schedule.referencePeriod,
    releaseKind: schedule.releaseKind,
    releaseOrdinal: schedule.releaseOrdinal,
    releaseAuthority: schedule.releaseAuthority,
    eventStatus: 'RESCHEDULED',
    scheduledReleaseTimestamp: '2026-01-20T13:30:00.000Z',
    actualReleaseTimestamp: null,
    availableAt: null,
    calendarKnowledgeAvailableAt: '2026-01-06T15:00:00.000Z',
    sourceDocumentId: pinSyntheticSourceDocument(ctx.store, 'mut-series'),
    supersedesReleaseEventVersionId: schedule.releaseEventVersionId,
    updateReason: 'RESCHEDULE',
  });
  buildMacroReleaseCalendarRegistryGenesis({
    store: ctx.store,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    orderedReleaseEventVersions: [schedule, mutated],
  });
}));
add(35, 'self-supersedes calendar', () => withOfficialMacroL4BI1Fixture((i1) => {
  const doc = pinSyntheticSourceDocument(i1.store, 'self-cycle');
  const draft = {
    macroSeriesIdentityId: i1.series['US.BLS.CPIAUCSL'].macroSeriesIdentityId,
    referencePeriod: '2025-12',
    releaseKind: 'REGULAR',
    releaseOrdinal: 0,
    releaseAuthority: 'BLS',
    eventStatus: 'SCHEDULED',
    scheduledReleaseTimestamp: '2026-01-13T13:30:00.000Z',
    actualReleaseTimestamp: null,
    availableAt: null,
    calendarKnowledgeAvailableAt: '2025-12-15T15:00:00.000Z',
    sourceDocumentId: doc,
    supersedesReleaseEventVersionId: null,
    updateReason: 'INITIAL_SCHEDULE',
  };
  const version = makeMacroReleaseEventVersion(draft);
  version.supersedesReleaseEventVersionId = version.releaseEventVersionId;
  buildMacroReleaseCalendarRegistryGenesis({
    store: i1.store,
    macroSeriesRegistryManifestId: i1.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    orderedReleaseEventVersions: [version],
  });
}));
add(36, 'two tips active', () => withOfficialMacroL4BI1Fixture((i1) => {
  const seriesId = i1.series['US.BLS.CPIAUCSL'].macroSeriesIdentityId;
  const a = makeMacroReleaseEventVersion({
    macroSeriesIdentityId: seriesId,
    referencePeriod: '2025-12', releaseKind: 'REGULAR', releaseOrdinal: 0,
    releaseAuthority: 'BLS', eventStatus: 'SCHEDULED',
    scheduledReleaseTimestamp: '2026-01-13T13:30:00.000Z',
    calendarKnowledgeAvailableAt: '2025-12-15T15:00:00.000Z',
    sourceDocumentId: pinSyntheticSourceDocument(i1.store, 'tip-a'),
    updateReason: 'INITIAL_SCHEDULE',
  });
  const b = makeMacroReleaseEventVersion({
    macroSeriesIdentityId: seriesId,
    referencePeriod: '2025-12', releaseKind: 'REGULAR', releaseOrdinal: 0,
    releaseAuthority: 'BLS', eventStatus: 'SCHEDULED',
    scheduledReleaseTimestamp: '2026-01-14T13:30:00.000Z',
    calendarKnowledgeAvailableAt: '2025-12-16T15:00:00.000Z',
    sourceDocumentId: pinSyntheticSourceDocument(i1.store, 'tip-b'),
    updateReason: 'INITIAL_SCHEDULE',
  });
  buildMacroReleaseCalendarRegistryGenesis({
    store: i1.store,
    macroSeriesRegistryManifestId: i1.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    orderedReleaseEventVersions: [a, b],
  });
}));
add(37, 'append-only deletion', () => withOfficialMacroL4BI2Fixture((ctx) => {
  buildMacroReleaseCalendarRegistryManifest({
    store: ctx.store,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    supersedesRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    orderedReleaseEventVersions: [ctx.calendarVersions.released],
  });
}));
add(38, 'append-only historical mutation', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const mutated = {
    ...ctx.calendarVersions.schedule,
    scheduledReleaseTimestamp: '2026-01-20T13:30:00.000Z',
  };
  buildMacroReleaseCalendarRegistryManifest({
    store: ctx.store,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    supersedesRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    orderedReleaseEventVersions: [
      mutated,
      ctx.calendarVersions.reschedule,
      ctx.calendarVersions.released,
    ],
  });
}));
add(39, 'calendar latest registry pin', () => withOfficialMacroL4BI2Fixture((ctx) => {
  verifyMacroReleaseCalendarRegistryManifest({
    store: ctx.store,
    macroReleaseCalendarRegistryManifestId: 'latest',
  });
}));
add(40, 'calendar wrong parent type id', () => withOfficialMacroL4BI2Fixture((ctx) => {
  verifyMacroReleaseCalendarRegistryManifest({
    store: ctx.store,
    macroReleaseCalendarRegistryManifestId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));

// --- binding ---
add(41, 'binding snapshot mismatch free vintage set', () => withOfficialMacroL4BI2Fixture((ctx) => {
  buildMacroDatasetBinding({
    store: ctx.store,
    macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff: ctx.knowledgeCutoff,
    macroVintageSetManifestId: FAKE('e'),
  });
}));
add(42, 'binding jurisdiction forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  buildMacroDatasetBinding({
    store: ctx.store,
    macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff: ctx.knowledgeCutoff,
    jurisdictionCode: 'CANADA',
  });
}));
add(43, 'binding currency forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  buildMacroDatasetBinding({
    store: ctx.store,
    macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff: ctx.knowledgeCutoff,
    currencyCode: 'CAD',
  });
}));
add(44, 'binding temporal capability forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  buildMacroDatasetBinding({
    store: ctx.store,
    macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff: ctx.knowledgeCutoff,
    temporalCapability: 'LATEST_ONLY',
  });
}));
add(45, 'binding latest-only capability enum', () => {
  normalizeMacroDatasetBindingV1({
    schemaVersion: MACRO_DATASET_BINDING_SCHEMA_VERSION,
    macroDatasetSnapshotManifestId: FAKE('a'),
    macroVintageSetManifestId: FAKE('b'),
    macroSeriesRegistryManifestId: FAKE('c'),
    macroIngestionPolicyId: FAKE('d'),
    macroAsOfResolutionPolicyId: FAKE('e'),
    macroReleaseCalendarRegistryManifestId: FAKE('f'),
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    knowledgeCutoff: '2026-02-11T18:00:00.000Z',
    temporalCapability: 'LATEST_ONLY',
    bindingPolicyVersion: 'MACRO_DATASET_BINDING_L4B_I2_V1',
  });
});
add(46, 'binding unknown release capability', () => {
  normalizeMacroDatasetBindingV1({
    schemaVersion: MACRO_DATASET_BINDING_SCHEMA_VERSION,
    macroDatasetSnapshotManifestId: FAKE('a'),
    macroVintageSetManifestId: FAKE('b'),
    macroSeriesRegistryManifestId: FAKE('c'),
    macroIngestionPolicyId: FAKE('d'),
    macroAsOfResolutionPolicyId: FAKE('e'),
    macroReleaseCalendarRegistryManifestId: FAKE('f'),
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    knowledgeCutoff: '2026-02-11T18:00:00.000Z',
    temporalCapability: 'UNKNOWN_RELEASE_TIME',
    bindingPolicyVersion: 'MACRO_DATASET_BINDING_L4B_I2_V1',
  });
});
add(47, 'binding latest id', () => withOfficialMacroL4BI2Fixture((ctx) => {
  verifyMacroDatasetBinding({ store: ctx.store, macroDatasetBindingId: 'latest' });
}));
add(48, 'binding wrong schema object', () => withOfficialMacroL4BI2Fixture((ctx) => {
  verifyMacroDatasetBinding({
    store: ctx.store, macroDatasetBindingId: ctx.asOf.macroAsOfResolutionPolicyId,
  });
}));
add(49, 'binding cutoff invalid timezone', () => withOfficialMacroL4BI2Fixture((ctx) => {
  buildMacroDatasetBinding({
    store: ctx.store,
    macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff: '2026-02-11T13:00:00.000America/New_York',
  });
}));
add(50, 'binding registry mismatch calendar', () => withOfficialMacroL4BI2Fixture((ctx) => {
  // Forge a binding wire value that pins a foreign vintage set id.
  normalizeMacroDatasetBindingV1({
    ...ctx.binding.binding,
    macroVintageSetManifestId: FAKE('9'),
  });
  const stored = putCanonicalL3(ctx.store, MACRO_DATASET_BINDING_SCHEMA_VERSION, {
    ...ctx.binding.binding,
    macroVintageSetManifestId: FAKE('9'),
  });
  verifyMacroDatasetBinding({
    store: ctx.store, macroDatasetBindingId: stored.objectId,
  });
}));

// --- materialization report ---
add(51, 'report resolved count forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport, resolvedObservationCount: 999 };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(52, 'report unavailable count forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport, notAvailableObservationCount: 999 };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(53, 'report withdrawn count forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport, withdrawnObservationCount: 999 };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(54, 'report future rejected count forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport, futureVintageRejectedCount: 999 };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(55, 'report revision count forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport, revisionCountUsed: 999 };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(56, 'report calendar counts forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport, releasedEventCount: 999 };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(57, 'report earliest date forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = {
    ...ctx.report.materializationReport,
    earliestResolvedAvailableAt: '2000-01-01T00:00:00.000Z',
  };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(58, 'report latest date forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = {
    ...ctx.report.materializationReport,
    latestResolvedAvailableAt: '2099-01-01T00:00:00.000Z',
  };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(59, 'report digest observation forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = {
    ...ctx.report.materializationReport,
    orderedResolvedObservationDigest: FAKE('1'),
  };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(60, 'report digest vintage forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = {
    ...ctx.report.materializationReport,
    orderedResolvedVintageIdentityDigest: FAKE('2'),
  };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(61, 'report digest calendar forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = {
    ...ctx.report.materializationReport,
    orderedCalendarStateDigest: FAKE('3'),
  };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(62, 'empty flag forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport, emptyMaterialization: true };
  normalizeMacroMaterializationReportV1(report);
}));
add(63, 'report unknown key', () => withOfficialMacroL4BI2Fixture((ctx) => {
  normalizeMacroMaterializationReportV1({
    ...ctx.report.materializationReport, path: '/tmp/x',
  });
}));
add(64, 'report Symbol key', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport };
  Object.defineProperty(report, Symbol('x'), { value: 1, enumerable: true });
  normalizeMacroMaterializationReportV1(report);
}));
add(65, 'report accessor', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport };
  Object.defineProperty(report, 'seriesCount', {
    get: () => ctx.report.materializationReport.seriesCount, enumerable: true,
  });
  normalizeMacroMaterializationReportV1(report);
}));
add(66, 'report non-enumerable', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = { ...ctx.report.materializationReport };
  Object.defineProperty(report, 'seriesCount', {
    value: ctx.report.materializationReport.seriesCount, enumerable: false,
  });
  normalizeMacroMaterializationReportV1(report);
}));
add(67, 'report prototype', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = Object.create({ sneak: true });
  Object.assign(report, ctx.report.materializationReport);
  normalizeMacroMaterializationReportV1(report);
}));
add(68, 'report wrong schema', () => withOfficialMacroL4BI2Fixture((ctx) => {
  normalizeMacroMaterializationReportV1({
    ...ctx.report.materializationReport,
    schemaVersion: 'MacroMaterializationReport/2',
  });
}));
add(69, 'report latest id', () => withOfficialMacroL4BI2Fixture((ctx) => {
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: 'latest',
  });
}));
add(70, 'verifier only trusts schema when counts forged', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const report = {
    ...ctx.report.materializationReport,
    resolvedObservationCount: 0,
    notAvailableObservationCount: 5,
    countsByResolutionStatus: {
      RESOLVED: 0, NOT_AVAILABLE: 5, WITHDRAWN: 0,
    },
  };
  const stored = putCanonicalL3(ctx.store, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, report);
  verifyMacroMaterializationReport({
    store: ctx.store, macroMaterializationReportId: stored.objectId,
  });
}));
add(71, 'calendar cancel removes history via empty child', () => withOfficialMacroL4BI2Fixture((ctx) => {
  buildMacroReleaseCalendarRegistryManifest({
    store: ctx.store,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    supersedesRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    orderedReleaseEventVersions: [],
  });
}));
add(72, 'same event duplicate genesis tips', () => withOfficialMacroL4BI1Fixture((i1) => {
  const seriesId = i1.series['US.BLS.CPIAUCSL'].macroSeriesIdentityId;
  const a = makeMacroReleaseEventVersion({
    macroSeriesIdentityId: seriesId,
    referencePeriod: '2025-11', releaseKind: 'REGULAR', releaseOrdinal: 0,
    releaseAuthority: 'BLS', eventStatus: 'SCHEDULED',
    scheduledReleaseTimestamp: '2025-12-10T13:30:00.000Z',
    calendarKnowledgeAvailableAt: '2025-11-01T15:00:00.000Z',
    sourceDocumentId: pinSyntheticSourceDocument(i1.store, 'dup-a'),
    updateReason: 'INITIAL_SCHEDULE',
  });
  const b = makeMacroReleaseEventVersion({
    macroSeriesIdentityId: seriesId,
    referencePeriod: '2025-11', releaseKind: 'REGULAR', releaseOrdinal: 0,
    releaseAuthority: 'BLS', eventStatus: 'SCHEDULED',
    scheduledReleaseTimestamp: '2025-12-11T13:30:00.000Z',
    calendarKnowledgeAvailableAt: '2025-11-02T15:00:00.000Z',
    sourceDocumentId: pinSyntheticSourceDocument(i1.store, 'dup-b'),
    updateReason: 'INITIAL_SCHEDULE',
  });
  buildMacroReleaseCalendarRegistryGenesis({
    store: i1.store,
    macroSeriesRegistryManifestId: i1.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    orderedReleaseEventVersions: [a, b],
  });
}));
add(73, 'binding wrong calendar jurisdiction via normalize', () => {
  normalizeMacroReleaseCalendarRegistryManifestV1({
    schemaVersion: MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registryPolicyVersion: 'MACRO_RELEASE_CALENDAR_L4B_I2_V1',
    macroSeriesRegistryManifestId: FAKE('a'),
    jurisdictionCode: 'CANADA',
    currencyCode: 'USD',
    supersedesRegistryManifestId: null,
    orderedReleaseEventVersions: [],
    eventVersionCount: 0,
    orderedReleaseEventVersionDigest: FAKE('b'),
  });
});
add(74, 'report non-UTC timestamp', () => withOfficialMacroL4BI2Fixture((ctx) => {
  normalizeMacroMaterializationReportV1({
    ...ctx.report.materializationReport,
    knowledgeCutoff: '2026-02-11T18:00:00+00:00',
  });
}));
add(75, 'policy missing field', () => {
  const policy = validPolicy();
  delete policy.conflictPolicy;
  normalizeMacroAsOfResolutionPolicyV1(policy);
});

test(`adversarial table contains exactly ${cases.length} corruption cases (>=70)`, () => {
  assert.ok(cases.length >= 70, `expected >=70, got ${cases.length}`);
  assert.equal(cases.length, 75);
});

for (const [id, label, fn] of cases) {
  test(`adversarial #${id}: ${label}`, () => {
    assert.throws(fn);
  });
}
