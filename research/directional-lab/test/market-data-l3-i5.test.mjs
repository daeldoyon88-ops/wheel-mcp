/**
 * L3-I5 permanent suite — source bundle, closed materialization policy,
 * PRESENT_ONLY projection and official L1 snapshot materialization.
 * Synthetic fixtures only. Offline research pipeline — no scanner imports.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  buildInstrumentIdentity,
  buildInstrumentIdentityAuthorityPolicy,
  buildInstrumentIdentityManifest,
  buildInstrumentIdentityRegistry,
} from '../src/data/buildInstrumentIdentity.mjs';
import {
  buildCorporateActionPolicies,
  buildCorporateActionRegistry,
  buildTimeZoneRuleset,
} from '../src/data/buildCorporateAction.mjs';
import { withStore } from './l2aSyntheticPipeline.mjs';
import * as Candidate from '../src/contracts/marketDataCandidateL3V1.mjs';
import * as Revision from '../src/contracts/marketDataBarRevisionL3V1.mjs';
import * as Delta from '../src/contracts/marketDataDeltaL3V1.mjs';
import * as Source from '../src/contracts/marketDataSourceL3V1.mjs';
import * as Calendar from '../src/contracts/marketCalendarL3V1.mjs';
import * as Bar from '../src/contracts/marketDataBarIdentityL3V1.mjs';
import {
  MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  appendMarketDataIngestionRegistry,
  buildMarketDataIngestionManifest,
  buildMarketDataIngestionRegistryManifest,
  deriveCorporateActionTreatment,
  deriveTemporalCapabilityFromDeltaObjects,
  derivePinnedIngestionBaseView,
  tipForLineage,
  verifyMarketDataIngestionRegistry,
} from '../src/contracts/marketDataIngestionRegistryL3V1.mjs';
import { MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1 } from '../src/pipeline/runMarketDataIngestionL3V1.mjs';
import {
  buildMarketDataResolvedSeriesManifest,
  verifyMarketDataResolvedSeries,
} from '../src/resolution/resolveMarketDataAsOfL3V1.mjs';
import {
  MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
  MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1_FORMAT,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_L3_SCHEMA_VERSIONS,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketDataEodOhlcvCanonicalRowsV1,
  normalizeMarketDataSnapshotMaterializationPolicyV1,
  normalizeMarketDataSnapshotMaterializationReportV1,
  normalizeMarketDataSnapshotSourceBundleV1,
} from '../src/contracts/marketDataSnapshotMaterializationL3V1.mjs';
import {
  buildMarketDataSnapshotMaterializationPolicy,
  buildMarketDataSnapshotSourceBundle,
  materializeMarketDataSnapshot,
  verifyMarketDataSnapshotMaterializationPolicy,
  verifyMarketDataSnapshotSourceBundle,
  verifyMaterializedMarketDataSnapshot,
} from '../src/materialization/materializeMarketDataSnapshotL3V1.mjs';
import { verifyDatasetSnapshot } from '../src/data/buildDatasetSnapshot.mjs';
import { verifySnapshotDatasetManifest } from '../src/data/buildSnapshotDatasetManifest.mjs';
import { addDays } from '../src/time/civilDate.mjs';

const I5_SCHEMAS = [
  MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
];
const SESSION_DATES = Object.freeze(['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-10']);
const VALUES = Object.freeze({
  openAtoms: '100', highAtoms: '101', lowAtoms: '99', closeAtoms: '100',
  priceScale: 0, volumeAtoms: '100', volumeScale: 0, currency: 'USD', priceBasis: 'RAW',
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, String(error));
    assert.doesNotMatch(String(error), /TypeError/);
    return true;
  });
}

function corporateRegistryArgs(policies, instrumentRegistry) {
  return {
    authorityPolicyId: policies.authorityPolicy.policyId,
    normalizationPolicyId: policies.normalizationPolicy.policyId,
    temporalPolicyId: policies.temporalPolicy.policyId,
    adjudicationPolicyId: policies.adjudicationPolicy.policyId,
    priceAdjustmentPolicyId: policies.priceAdjustmentPolicy.policyId,
    entitlementPolicyId: policies.entitlementPolicy.policyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    instrumentLedgerManifestIds: [],
  };
}

function setupI5(store) {
  const knowledgeModes = ['CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED', 'PROVIDER_REVISION_HISTORY_ATTESTED'];
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l3-i5-synthetic-instruments/1',
    identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: '7'.repeat(64), instrumentKind: 'EQUITY',
  });
  const instrumentManifest = buildInstrumentIdentityManifest({
    store, instrumentIdentityId: instrument.instrumentIdentityId, aliasBindingCoreIds: [],
  });
  const instrumentRegistry = buildInstrumentIdentityRegistry({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identityManifestIds: [instrumentManifest.identityManifestId],
  });
  const corporatePolicies = buildCorporateActionPolicies({
    store,
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i5-synthetic-actions/1', identityNamespaceVersion: 'L3-I5/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I5/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I5/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I5/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I5/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I5/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l3-i5',
      validFromDate: '2026-01-02', validToDateExclusive: '2026-01-13',
      civilDateBounds: Array.from({ length: 11 }, (_, index) => {
        const civilDate = addDays('2026-01-02', index);
        return { civilDate, startUtc: `${civilDate}T05:00:00.000Z`,
          endUtcExclusive: `${addDays(civilDate, 1)}T05:00:00.000Z` };
      }),
    },
  });
  const calendarPolicy = Calendar.buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'synthetic-l3-i5/1',
    },
  });
  const sessions = SESSION_DATES.map((sessionDate) => ({
    sessionDate, sessionKind: 'REGULAR_SESSION',
    openUtc: `${sessionDate}T14:30:00.000Z`, closeUtc: `${sessionDate}T21:00:00.000Z`,
    marketValidTime: `${sessionDate}T21:00:00.000Z`,
  }));
  const calendar = Calendar.buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
      coverageFromDate: '2026-01-02', coverageToDateExclusive: '2026-01-13', sessions,
    },
  });
  const calendarRegistry = Calendar.buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [calendar.calendarCoreId], supersedesCalendarRegistryManifestId: null,
    },
  });
  const ingestionPolicy = Source.buildMarketDataIngestionPolicy({
    store,
    policy: {
      schemaVersion: Source.MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
      allowedInstrumentKinds: ['EQUITY'], allowedFrequencies: ['DAILY_REGULAR_SESSION'],
      allowedPriceBases: ['RAW', 'SPLIT_ADJUSTED'], allowedSourceDatasetKinds: ['EOD_OHLCV'],
      allowedPayloadFormats: ['CSV_UTF8'], maxArtifactBytes: 100000,
      knowledgeModes,
      providerPublicationTimeField: 'providerPublicationTime',
      providerRevisionIdField: 'providerRevisionId',
      unknownFieldPolicy: 'REJECT', duplicateIdenticalRowPolicy: 'ACCEPT_IDENTICAL',
      volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
    },
  });
  const lineage = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER', instrumentIdentityId: instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis: 'RAW',
      sourceDatasetKind: 'EOD_OHLCV',
    },
    ingestionPolicyId: ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: corporateRegistry.registryManifestId,
  });
  const registryAuthority = Source.buildMarketDataIngestionRegistryAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Source.MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
      registryNamespaceVersion: 'synthetic-l3-i5/1',
      authorityScope: 'MARKET_DATA_INGESTION',
    },
  });
  const rootRegistry = buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: null,
      ingestionManifestIds: [],
      lineageTips: [],
    },
  });
  const barBySession = new Map(SESSION_DATES.map((sessionDate) => [sessionDate, Bar.buildMarketDataBarIdentity({
    store,
    identity: {
      schemaVersion: Bar.MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
      instrumentIdentityId: instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS',
      sessionDate, sessionKind: 'DAILY_REGULAR_SESSION',
    },
  }).barIdentityId]));
  return {
    instrument, instrumentRegistry, corporateRegistry, calendarRegistry,
    ingestionPolicy, lineage, registryAuthority, rootRegistry, barBySession, priceBasis: 'RAW',
  };
}

function atomsHeader(policy) {
  const header = [...MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1];
  header.push(policy.providerPublicationTimeField);
  header.push(policy.providerRevisionIdField);
  return header;
}

function atomsRow(graph, sessionDate, overrides = {}) {
  const cells = {
    sessionDate,
    openAtoms: '100', highAtoms: '101', lowAtoms: '99', closeAtoms: '100',
    priceScale: '0', volumeAtoms: '100', volumeScale: '0', currency: 'USD',
    knowledgeMode: 'CAPTURE_TIME_ONLY',
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
    ...overrides,
  };
  return atomsHeader(graph.ingestionPolicy.ingestionPolicy).map((field) => cells[field] ?? '');
}

function makeSource(store, graph, rows, acquisitionTimeUtc, runId) {
  const header = atomsHeader(graph.ingestionPolicy.ingestionPolicy);
  const bytes = Buffer.from([header.join(','), ...rows.map((row) => row.join(',')), ''].join('\n'));
  const stored = store.putSourceBytes(bytes);
  const artifact = Source.buildMarketDataSourceArtifact({
    store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId, payloadFormat: 'CSV_UTF8',
      mediaType: 'text/csv; charset=utf-8', embeddedBytesObjectId: stored.objectId,
      payloadDigest: stored.objectId, payloadByteLength: bytes.length,
    },
  });
  const attestation = Source.buildMarketDataSourceAttestation({
    store,
    attestation: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId, attestationMode: 'EMBEDDED_ARTIFACT',
      embeddedArtifactId: artifact.sourceArtifactId, payloadDigest: null,
      payloadByteLength: null, payloadFormat: null, providerId: null,
    },
  });
  const acquisition = Source.buildMarketDataAcquisitionRecord({
    store,
    record: {
      schemaVersion: Source.MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      acquisitionTimeUtc,
      providerId: graph.lineage.ingestionLineage.providerId,
      logicalEndpointKind: 'EOD_OHLCV_DATASET', requestDatasetKind: 'EOD_OHLCV',
      executionIdentity: { runnerId: 'node-test', runId, environment: 'LOCAL_TEST' },
      sourceAttestationId: attestation.sourceAttestationId,
    },
  });
  const parseResult = Source.buildMarketDataParseResult({
    store, sourceArtifactId: artifact.sourceArtifactId,
    acquisitionRecordId: acquisition.acquisitionRecordId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
  });
  return { artifact, attestation, acquisition, parseResult, acquisitionTimeUtc };
}

function candidateBase(graph, source, sessionDate, overrides = {}) {
  const rowIndex = overrides.sourceRowIndex ?? 0;
  const row = source.parseResult.parseResult.rows[rowIndex];
  return {
    schemaVersion: Candidate.MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
    candidateKind: 'BAR_INITIAL_VALUE',
    ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: source.artifact.sourceArtifactId,
    acquisitionRecordId: source.acquisition.acquisitionRecordId,
    parseResultId: source.parseResult.parseResultId,
    sourceRowIndex: rowIndex,
    sourceRowDigest: row.rowDigest,
    knowledgeMode: 'CAPTURE_TIME_ONLY',
    knowledgeTimeLowerBound: null,
    knowledgeTimeUpperBound: source.acquisitionTimeUtc,
    sourceTimestampEvidenceId: null,
    providerRevisionId: null,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    marketValidTime: `${sessionDate}T21:00:00.000Z`,
    barIdentityId: graph.barBySession.get(sessionDate),
    targetCorrectionId: null,
    replacementValues: { ...VALUES },
    ...overrides,
  };
}

function withdrawalCandidate(graph, source, sessionDate, targetCorrectionId, overrides = {}) {
  const candidate = candidateBase(graph, source, sessionDate, {
    candidateKind: 'BAR_WITHDRAWAL', targetCorrectionId, ...overrides,
  });
  delete candidate.replacementValues;
  return candidate;
}

function sessionMoveCandidate(graph, source, fromDate, toDate, targetCorrectionId, overrides = {}) {
  const candidate = candidateBase(graph, source, toDate, {
    candidateKind: 'SESSION_DATE_CORRECTION',
    previousBarIdentityId: graph.barBySession.get(fromDate),
    nextBarIdentityId: graph.barBySession.get(toDate),
    targetCorrectionId,
    ...overrides,
  });
  delete candidate.barIdentityId;
  return candidate;
}

function candidateBarIds(candidate) {
  return candidate.candidateKind === 'SESSION_DATE_CORRECTION'
    ? [candidate.previousBarIdentityId, candidate.nextBarIdentityId]
    : [candidate.barIdentityId];
}

function appendIngestion(store, graph, registryId, source, candidates) {
  const { ingestionRegistryManifest: registry } = verifyMarketDataIngestionRegistry({
    store, ingestionRegistryManifestId: registryId,
  });
  const parentId = tipForLineage(registry, graph.lineage.ingestionLineageId);
  const pins = {
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  };
  const full = derivePinnedIngestionBaseView(store, registryId, graph.lineage.ingestionLineageId, parentId);
  const view = {
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: parentId,
    terminalCorrectionIds: full.terminalCorrectionIds,
    visibleCorrectionIds: full.visibleCorrectionIds,
    occupiedBarIdentityIds: full.occupiedBarIdentityIds,
    publishedBarIdentityIds: [...new Set([
      ...full.publishedBarIdentityIds,
      ...candidates.flatMap(candidateBarIds),
    ])].sort(),
    duplicateCandidateIds: [],
  };
  const built = candidates.map((candidate) => Candidate.buildMarketDataNormalizedCandidate({ store, candidate }));
  const candidateIds = built.map((item) => item.candidateId).sort();
  const set = Candidate.buildMarketDataCandidateSet({
    store,
    candidateSet: {
      schemaVersion: Candidate.MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      sourceArtifactId: source.artifact.sourceArtifactId,
      acquisitionRecordId: source.acquisition.acquisitionRecordId,
      parseResultId: source.parseResult.parseResultId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      ...pins,
      candidateIds,
    },
  });
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId, baseView: view,
  });
  assert.equal(delta.status, 'PUBLISHED');
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const newBarObservationIds = [...assembly.acceptedObservationIds].sort();
  const newBarCorrectionIds = [...assembly.acceptedCorrectionIds].sort();
  const ingestion = buildMarketDataIngestionManifest({
    store,
    manifest: {
      schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: registryId,
      expectedParentIngestionManifestId: parentId,
      supersedesIngestionManifestId: parentId,
      ...pins,
      sourceArtifactId: source.artifact.sourceArtifactId,
      sourceAttestationId: source.attestation.sourceAttestationId,
      acquisitionRecordId: source.acquisition.acquisitionRecordId,
      parseResultId: source.parseResult.parseResultId,
      candidateSetId: set.candidateSetId,
      validationReportId: report.validationReportId,
      acceptedCandidatePublicationManifestId: delta.publicationManifestId,
      deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
      newBarObservationIds,
      newBarCorrectionIds,
      temporalCapability: deriveTemporalCapabilityFromDeltaObjects(store, newBarObservationIds, newBarCorrectionIds),
      priceBasis: graph.priceBasis,
      corporateActionTreatment: deriveCorporateActionTreatment(graph.priceBasis),
    },
  });
  const appended = appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: parentId,
    ingestionManifestId: ingestion.ingestionManifestId,
  });
  return {
    ingestionManifestId: ingestion.ingestionManifestId,
    registryId: appended.ingestionRegistryManifestId,
    observationIds: newBarObservationIds,
    correctionIds: newBarCorrectionIds,
  };
}

function seedTwoSessions(store) {
  const graph = setupI5(store);
  let registryId = graph.rootRegistry.ingestionRegistryManifestId;
  const source = makeSource(store, graph, [
    atomsRow(graph, '2026-01-02'),
    atomsRow(graph, '2026-01-05', { openAtoms: '200', highAtoms: '201', lowAtoms: '199', closeAtoms: '200' }),
  ], '2026-01-05T22:00:00.000Z', 'i5-seed');
  const published = appendIngestion(store, graph, registryId, source, [
    candidateBase(graph, source, '2026-01-02', { sourceRowIndex: 0 }),
    candidateBase(graph, source, '2026-01-05', {
      sourceRowIndex: 1,
      replacementValues: { ...VALUES, openAtoms: '200', highAtoms: '201', lowAtoms: '199', closeAtoms: '200' },
    }),
  ]);
  registryId = published.registryId;
  const resolved = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-05T22:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const policy = buildMarketDataSnapshotMaterializationPolicy({ store });
  return { graph, registryId, resolved, policy, published, source };
}

test('L3-I5 registers exactly three additive schemas for a total of 85 after L4A-C2', () => {
  assert.deepEqual([...MARKET_DATA_SNAPSHOT_MATERIALIZATION_L3_SCHEMA_VERSIONS], I5_SCHEMAS);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 109);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 109);
  assert.deepEqual(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.filter((schema) => I5_SCHEMAS.includes(schema)),
    I5_SCHEMAS,
  );
  for (const schemaVersion of I5_SCHEMAS) {
    assert.throws(() => normalizeCanonicalValue(schemaVersion, {}), (error) => error?.code === 'CANONICAL_SCHEMA_UNKNOWN'
      || error?.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED'
      || error?.code === 'MARKET_DATA_INPUT_INVALID'
      || error?.code === 'MARKET_DATA_UNKNOWN_FIELD');
  }
});

test('L3-I5 closed APIs reject unknown fields and free policy options', () => {
  expectCode(() => normalizeMarketDataSnapshotSourceBundleV1({ schemaVersion: MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION, extra: 1 }), 'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => normalizeMarketDataSnapshotMaterializationPolicyV1({
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
    ...MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES,
    freeOption: true,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => normalizeMarketDataSnapshotMaterializationPolicyV1({
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
    ...MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES,
    priceTransformation: 'SPLIT_ADJUST',
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataSnapshotMaterializationPolicyV1({
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
    ...MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES,
    format: 'OTHER',
  }), 'MARKET_DATA_INPUT_INVALID');
  assert.equal(MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES.format, MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1_FORMAT);
  assert.equal(MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES.priceTransformation, 'NONE');
  assert.equal(MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES.corporateActionTransformation, 'NONE');
  expectCode(() => materializeMarketDataSnapshot({
    store: {}, ingestionRegistryManifestId: 'x', resolvedSeriesManifestId: 'y', materializationPolicyId: 'z', latest: true,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
});

test('L3-I5 policy builder is deterministic and reject-free of economic parameters', () => withStore((store) => {
  const a = buildMarketDataSnapshotMaterializationPolicy({ store });
  const b = buildMarketDataSnapshotMaterializationPolicy({ store });
  assert.equal(a.materializationPolicyId, b.materializationPolicyId);
  const verified = verifyMarketDataSnapshotMaterializationPolicy({
    store, materializationPolicyId: a.materializationPolicyId,
  });
  assert.equal(verified.materializationPolicy.format, MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1_FORMAT);
  assert.equal(verified.materializationPolicy.rowSelection, 'PRESENT_ONLY');
  assert.equal(verified.materializationPolicy.serialization, 'CanonicalJSON/1');
}));

test('L3-I5 source bundle derives contributors and rejects caller-supplied lists', () => withStore((store) => {
  const { graph, registryId, resolved } = seedTwoSessions(store);
  const bundle = buildMarketDataSnapshotSourceBundle({
    store,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    ingestionRegistryManifestId: registryId,
  });
  const verified = verifyMarketDataSnapshotSourceBundle({
    store,
    snapshotSourceBundleId: bundle.snapshotSourceBundleId,
    ingestionRegistryManifestId: registryId,
  });
  assert.equal(verified.snapshotSourceBundle.resolvedSeriesManifestId, resolved.resolvedSeriesManifestId);
  assert.ok(verified.snapshotSourceBundle.contributingObservationIds.length >= 2);
  expectCode(() => buildMarketDataSnapshotSourceBundle({
    store,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    ingestionRegistryManifestId: registryId,
    contributingObservationIds: [],
  }), 'MARKET_DATA_UNKNOWN_FIELD');
  const again = buildMarketDataSnapshotSourceBundle({
    store,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    ingestionRegistryManifestId: registryId,
  });
  assert.equal(again.snapshotSourceBundleId, bundle.snapshotSourceBundleId);
  void graph;
}));

test('L3-I5 materializes PRESENT rows into official L1 with atom preservation', () => withStore((store) => {
  const { graph, registryId, resolved, policy } = seedTwoSessions(store);
  const result = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const verified = verifyMaterializedMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    materializationReportId: result.materializationReportId,
  });
  assert.equal(verified.datasetSnapshotManifestId, result.datasetSnapshotManifestId);
  const report = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: result.materializationReportId }),
    expectedObjectId: result.materializationReportId,
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  }).value;
  assert.equal(report.status, 'MATERIALIZED');
  assert.equal(report.rowCount, 2);
  assert.equal(report.presentEntryCount, 2);
  assert.equal(report.firstSessionDate, '2026-01-02');
  assert.equal(report.lastSessionDate, '2026-01-05');
  assert.equal(report.outputSchemaVersion, MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION);

  const dataset = verifySnapshotDatasetManifest({
    store, snapshotDatasetManifestId: result.datasetSnapshotManifestId,
  });
  const snapshot = verifyDatasetSnapshot({
    store, snapshotRecordId: dataset.manifest.snapshotRecordId,
  });
  assert.equal(snapshot.normalizedDailyBars.schemaVersion, MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION);
  assert.equal(snapshot.normalizedDailyBars.rows.length, 2);
  assert.equal(snapshot.normalizedDailyBars.rows[0].sessionDate, '2026-01-02');
  assert.equal(snapshot.normalizedDailyBars.rows[1].sessionDate, '2026-01-05');
  assert.equal(snapshot.normalizedDailyBars.rows[0].openAtoms, '100');
  assert.equal(snapshot.normalizedDailyBars.rows[1].closeAtoms, '200');
  assert.equal(snapshot.normalizedDailyBars.rows[0].instrumentIdentityId, graph.instrument.instrumentIdentityId);
  assert.deepEqual(
    Buffer.from(snapshot.sourceBytes),
    canonicalJsonBytes(snapshot.normalizedDailyBars),
  );
}));

test('L3-I5 omits WITHDRAWN and MOVED_TO_OTHER_SESSION source entries', () => withStore((store) => {
  const graph = setupI5(store);
  let registryId = graph.rootRegistry.ingestionRegistryManifestId;
  const source1 = makeSource(store, graph, [
    atomsRow(graph, '2026-01-02'),
    atomsRow(graph, '2026-01-05'),
  ], '2026-01-05T22:00:00.000Z', 'i5-disp-1');
  const first = appendIngestion(store, graph, registryId, source1, [
    candidateBase(graph, source1, '2026-01-02', { sourceRowIndex: 0 }),
    candidateBase(graph, source1, '2026-01-05', { sourceRowIndex: 1 }),
  ]);
  registryId = first.registryId;
  const tip02 = first.correctionIds.find((id) => {
    const c = Revision.verifyMarketDataBarCorrection({ store, correctionId: id }).correction;
    return c.barIdentityId === graph.barBySession.get('2026-01-02') && c.correctionKind === 'INITIAL_ROOT';
  });
  const tip05 = first.correctionIds.find((id) => {
    const c = Revision.verifyMarketDataBarCorrection({ store, correctionId: id }).correction;
    return c.barIdentityId === graph.barBySession.get('2026-01-05') && c.correctionKind === 'INITIAL_ROOT';
  });
  const source2 = makeSource(store, graph, [
    atomsRow(graph, '2026-01-02'),
    atomsRow(graph, '2026-01-06'),
  ], '2026-01-06T22:00:00.000Z', 'i5-disp-2');
  const second = appendIngestion(store, graph, registryId, source2, [
    withdrawalCandidate(graph, source2, '2026-01-02', tip02, { sourceRowIndex: 0 }),
    sessionMoveCandidate(graph, source2, '2026-01-05', '2026-01-06', tip05, { sourceRowIndex: 1 }),
  ]);
  registryId = second.registryId;
  const resolved = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-06T22:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const policy = buildMarketDataSnapshotMaterializationPolicy({ store });
  const result = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const report = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: result.materializationReportId }),
    expectedObjectId: result.materializationReportId,
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  }).value;
  assert.equal(report.withdrawnEntryCount, 1);
  assert.equal(report.movedToOtherSessionEntryCount, 1);
  assert.equal(report.presentEntryCount, 1);
  assert.equal(report.rowCount, 1);
  assert.equal(report.firstSessionDate, '2026-01-06');
  assert.equal(report.lastSessionDate, '2026-01-06');
}));

test('L3-I5 MATERIALIZED_EMPTY when every resolved entry is non-PRESENT', () => withStore((store) => {
  const graph = setupI5(store);
  let registryId = graph.rootRegistry.ingestionRegistryManifestId;
  const source1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-02T22:00:00.000Z', 'i5-empty-1');
  const first = appendIngestion(store, graph, registryId, source1, [
    candidateBase(graph, source1, '2026-01-02'),
  ]);
  registryId = first.registryId;
  const tip = first.correctionIds[0];
  const source2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-03T22:00:00.000Z', 'i5-empty-2');
  const second = appendIngestion(store, graph, registryId, source2, [
    withdrawalCandidate(graph, source2, '2026-01-02', tip),
  ]);
  registryId = second.registryId;
  const resolved = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-03T22:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const policy = buildMarketDataSnapshotMaterializationPolicy({ store });
  const result = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const report = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: result.materializationReportId }),
    expectedObjectId: result.materializationReportId,
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  }).value;
  assert.equal(report.status, 'MATERIALIZED_EMPTY');
  assert.equal(report.rowCount, 0);
  assert.equal(report.firstSessionDate, null);
  assert.equal(report.lastSessionDate, null);
  const dataset = verifySnapshotDatasetManifest({
    store, snapshotDatasetManifestId: result.datasetSnapshotManifestId,
  });
  const snapshot = verifyDatasetSnapshot({
    store, snapshotRecordId: dataset.manifest.snapshotRecordId,
  });
  assert.deepEqual(snapshot.normalizedDailyBars.rows, []);
}));

test('L3-I5 non-interference: future non-contributive append keeps the same IDs', () => withStore((store) => {
  const { graph, registryId, resolved, policy } = seedTwoSessions(store);
  const first = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const futureSource = makeSource(store, graph, [
    atomsRow(graph, '2026-01-10'),
  ], '2026-01-10T22:00:00.000Z', 'i5-future');
  const future = appendIngestion(store, graph, registryId, futureSource, [
    candidateBase(graph, futureSource, '2026-01-10'),
  ]);
  const second = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: future.registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  assert.equal(second.snapshotSourceBundleId, first.snapshotSourceBundleId);
  assert.equal(second.datasetSnapshotManifestId, first.datasetSnapshotManifestId);
  assert.equal(second.materializationReportId, first.materializationReportId);
  verifyMarketDataResolvedSeries({
    store,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    ingestionRegistryManifestId: future.registryId,
  });
}));

test('L3-I5 late historical revision produces new materialization IDs', () => withStore((store) => {
  const { graph, registryId, resolved, policy } = seedTwoSessions(store);
  const first = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const tip02 = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: resolved.resolvedSeriesManifestId }),
    expectedObjectId: resolved.resolvedSeriesManifestId,
    schemaVersion: 'MarketDataResolvedSeriesManifest/1',
  }).value.resolvedBarEntries.find((e) => e.sessionDate === '2026-01-02').resolvedCorrectionTipId;
  // Capture-only revision acquired before the original cutoff → contributive historically.
  const revSource = makeSource(store, graph, [
    atomsRow(graph, '2026-01-02', { closeAtoms: '111', highAtoms: '112' }),
  ], '2026-01-05T21:30:00.000Z', 'i5-late-rev');
  const late = appendIngestion(store, graph, registryId, revSource, [
    candidateBase(graph, revSource, '2026-01-02', {
      candidateKind: 'BAR_VALUE_REVISION',
      targetCorrectionId: tip02,
      replacementValues: { ...VALUES, closeAtoms: '111', highAtoms: '112' },
    }),
  ]);
  const resolved2 = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: late.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-05T22:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  assert.notEqual(resolved2.resolvedSeriesManifestId, resolved.resolvedSeriesManifestId);
  const second = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: late.registryId,
    resolvedSeriesManifestId: resolved2.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  assert.notEqual(second.snapshotSourceBundleId, first.snapshotSourceBundleId);
  assert.notEqual(second.datasetSnapshotManifestId, first.datasetSnapshotManifestId);
  assert.notEqual(second.materializationReportId, first.materializationReportId);
}));

test('L3-I5 idempotent replay and atomic restart after partial success', () => withStore((store) => {
  const { registryId, resolved, policy } = seedTwoSessions(store);
  const bundle = buildMarketDataSnapshotSourceBundle({
    store,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    ingestionRegistryManifestId: registryId,
  });
  const first = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  assert.equal(first.snapshotSourceBundleId, bundle.snapshotSourceBundleId);
  const second = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  assert.deepEqual(second, first);
}));

test('L3-I5 descendant registry pin accepted; sibling pin refused', () => withStore((store) => {
  const { graph, registryId, resolved, policy } = seedTwoSessions(store);
  const result = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const futureSource = makeSource(store, graph, [atomsRow(graph, '2026-01-10')], '2026-01-10T22:00:00.000Z', 'i5-pin');
  const future = appendIngestion(store, graph, registryId, futureSource, [
    candidateBase(graph, futureSource, '2026-01-10'),
  ]);
  verifyMaterializedMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: future.registryId,
    materializationReportId: result.materializationReportId,
  });
  const sibling = buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: graph.rootRegistry.ingestionRegistryManifestId,
      ingestionManifestIds: [],
      lineageTips: [],
    },
  });
  expectCode(() => verifyMaterializedMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: sibling.ingestionRegistryManifestId,
    materializationReportId: result.materializationReportId,
  }), 'MARKET_DATA_INGESTION_STALE_BASE');
}));

test('L3-I5 forged report and corrupted snapshot fail closed', () => withStore((store) => {
  const { registryId, resolved, policy } = seedTwoSessions(store);
  const result = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const report = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: result.materializationReportId }),
    expectedObjectId: result.materializationReportId,
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  }).value;
  expectCode(() => normalizeMarketDataSnapshotMaterializationReportV1({
    ...report, rowCount: 99,
  }), 'MARKET_DATA_INPUT_INVALID');
  const forgedReport = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    value: {
      ...report,
      materializedObservationIds: [
        report.materializedObservationIds[0],
        policy.materializationPolicyId,
      ].sort(),
    },
  });
  expectCode(() => verifyMaterializedMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    materializationReportId: forgedReport.objectId,
  }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');

  const dataset = verifySnapshotDatasetManifest({
    store, snapshotDatasetManifestId: result.datasetSnapshotManifestId,
  });
  const snapshot = verifyDatasetSnapshot({
    store, snapshotRecordId: dataset.manifest.snapshotRecordId,
  });
  expectCode(() => normalizeMarketDataEodOhlcvCanonicalRowsV1({
    schemaVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
    rows: [...snapshot.normalizedDailyBars.rows].reverse(),
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataEodOhlcvCanonicalRowsV1({
    schemaVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
    rows: snapshot.normalizedDailyBars.rows.map((row, index) => (
      index === 0 ? { ...row, closeAtoms: '999' } : row
    )),
  }), 'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
}));

test('L3-I5 isolation: no scanner/dashboard/network/I6 imports in materialization modules', () => {
  const contract = readFileSync(new URL('../src/contracts/marketDataSnapshotMaterializationL3V1.mjs', import.meta.url), 'utf8');
  const materializer = readFileSync(new URL('../src/materialization/materializeMarketDataSnapshotL3V1.mjs', import.meta.url), 'utf8');
  for (const source of [contract, materializer]) {
    assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/app\//);
    assert.doesNotMatch(source, /wheel-dashboard/);
    assert.doesNotMatch(source, /server\.js/);
    assert.doesNotMatch(source, /wheelScanner/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /Date\.now\s*\(/);
    assert.doesNotMatch(source, /new Date\s*\(\s*\)/);
    assert.doesNotMatch(source, /Math\.random/);
    assert.doesNotMatch(source, /randomUUID/);
    assert.doesNotMatch(source, /MarketDataDatasetSnapshotBinding/);
    assert.doesNotMatch(source, /\blatest\b/);
  }
});
