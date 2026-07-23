/**
 * L3-I6 permanent suite — official MarketDataDatasetSnapshotBinding,
 * closed authority policy, and append-only binding registry.
 * Synthetic fixtures only. Offline research pipeline — no scanner imports.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
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
} from '../src/resolution/resolveMarketDataAsOfL3V1.mjs';
import {
  buildMarketDataSnapshotMaterializationPolicy,
  materializeMarketDataSnapshot,
} from '../src/materialization/materializeMarketDataSnapshotL3V1.mjs';
import { defaultDatasetQualityPolicyV1 } from '../src/contracts/datasetQualityAssessmentV1.mjs';
import {
  assessDatasetSnapshotQuality,
  buildDatasetQualityAssessmentRecord,
  verifyDatasetQualityAssessment,
} from '../src/data/assessDatasetSnapshotQuality.mjs';
import { verifySnapshotDatasetManifest } from '../src/data/buildSnapshotDatasetManifest.mjs';
import { addDays } from '../src/time/civilDate.mjs';
import {
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_L3_SCHEMA_VERSIONS,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE,
  MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION,
  MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION,
  appendMarketDataDatasetSnapshotBindingRegistry,
  buildMarketDataDatasetSnapshotBinding,
  buildMarketDataDatasetSnapshotBindingAuthorityPolicy,
  buildRootMarketDataDatasetSnapshotBindingRegistry,
  deriveBindingPublicationKey,
  normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1,
  normalizeMarketDataDatasetSnapshotBindingRegistryManifestV1,
  normalizeMarketDataDatasetSnapshotBindingV1,
  tipForBindingPublicationKey,
  verifyMarketDataDatasetSnapshotBinding,
  verifyMarketDataDatasetSnapshotBindingAuthorityPolicy,
  verifyMarketDataDatasetSnapshotBindingRegistry,
} from '../src/contracts/marketDataDatasetSnapshotBindingL3V1.mjs';
import { publishOfficialMarketDataSnapshotBinding } from '../src/publication/publishOfficialMarketDataSnapshotBindingL3V1.mjs';

const I6_SCHEMAS = [
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
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

function setupI6(store) {
  const knowledgeModes = ['CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED', 'PROVIDER_REVISION_HISTORY_ATTESTED'];
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l3-i6-synthetic-instruments/1',
    identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: '6'.repeat(64), instrumentKind: 'EQUITY',
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
    authorityPolicy: {
      schemaVersion: CA.AUTHORITY, authorityId: 'l3-i6-synthetic-actions/1',
      identityNamespaceVersion: 'L3-I6/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64,
    },
    normalizationPolicy: {
      schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I6/1',
      supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'],
    },
    temporalPolicy: {
      schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I6/1',
      dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366,
    },
    adjudicationPolicy: {
      schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I6/1',
      requireAllVisibleObservations: true, allowContested: false,
    },
    priceAdjustmentPolicy: {
      schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I6/1',
      supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'],
    },
    entitlementPolicy: {
      schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I6/1',
      roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED',
    },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l3-i6',
      validFromDate: '2026-01-02', validToDateExclusive: '2026-01-13',
      civilDateBounds: Array.from({ length: 11 }, (_, index) => {
        const civilDate = addDays('2026-01-02', index);
        return {
          civilDate, startUtc: `${civilDate}T05:00:00.000Z`,
          endUtcExclusive: `${addDays(civilDate, 1)}T05:00:00.000Z`,
        };
      }),
    },
  });
  const calendarPolicy = Calendar.buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'synthetic-l3-i6/1',
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
      registryNamespaceVersion: 'synthetic-l3-i6/1',
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
  const graph = setupI6(store);
  let registryId = graph.rootRegistry.ingestionRegistryManifestId;
  const source = makeSource(store, graph, [
    atomsRow(graph, '2026-01-02'),
    atomsRow(graph, '2026-01-05', { openAtoms: '200', highAtoms: '201', lowAtoms: '199', closeAtoms: '200' }),
  ], '2026-01-05T22:00:00.000Z', 'i6-seed');
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

function assessQuality(store, datasetSnapshotManifestId, runId = 'i6-qa') {
  const manifest = verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: datasetSnapshotManifestId });
  const assessed = assessDatasetSnapshotQuality({
    store,
    snapshotCoreId: manifest.manifest.snapshotCoreId,
    policy: defaultDatasetQualityPolicyV1(),
  });
  const record = buildDatasetQualityAssessmentRecord({
    store,
    qualityAssessmentCoreId: assessed.qualityCoreId,
    assessedAt: '2026-01-05T23:00:00.000Z',
    assessmentToolVersion: 'l3-i6-quality/1',
    nodeVersion: 'v20.0.0',
    executionIdentity: { runnerId: 'node-test', runId, environment: 'LOCAL_TEST' },
  });
  verifyDatasetQualityAssessment({ store, qualityAssessmentRecordId: record.recordId });
  return {
    qualityAssessmentId: record.recordId,
    qualityAssessmentCoreId: assessed.qualityCoreId,
    assessed,
    record,
    snapshotCoreId: manifest.manifest.snapshotCoreId,
  };
}

function materializeAndAssess(store, registryId, resolved, policy, runId = 'i6-mat') {
  const materialization = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: registryId,
    resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
    materializationPolicyId: policy.materializationPolicyId,
  });
  const quality = assessQuality(store, materialization.datasetSnapshotManifestId, runId);
  return { materialization, quality };
}

function openBindingRoot(store) {
  const authority = buildMarketDataDatasetSnapshotBindingAuthorityPolicy({ store });
  const root = buildRootMarketDataDatasetSnapshotBindingRegistry({
    store, bindingAuthorityPolicyId: authority.bindingAuthorityPolicyId,
  });
  return { authority, root, bindingRegistryManifestId: root.bindingRegistryManifestId };
}

function seedPublishedBinding(store) {
  const seeded = seedTwoSessions(store);
  const { materialization, quality } = materializeAndAssess(
    store, seeded.registryId, seeded.resolved, seeded.policy, 'i6-pub',
  );
  const { authority, root } = openBindingRoot(store);
  const published = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: root.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: materialization.materializationReportId,
    qualityAssessmentId: quality.qualityAssessmentId,
  });
  return { ...seeded, materialization, quality, authority, root, published };
}

function readBinding(store, bindingId) {
  return store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: bindingId }),
    expectedObjectId: bindingId,
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
  }).value;
}

function readRegistry(store, registryId) {
  return store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: registryId }),
    expectedObjectId: registryId,
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
  }).value;
}

// ---------------------------------------------------------------------------
// Schemas + authority policy
// ---------------------------------------------------------------------------

test('L3-I6 registers exactly three additive schemas for a total of 85 after L4A-C2', () => {
  assert.deepEqual([...MARKET_DATA_DATASET_SNAPSHOT_BINDING_L3_SCHEMA_VERSIONS], I6_SCHEMAS);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 109);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 109);
  assert.deepEqual(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.filter((schema) => I6_SCHEMAS.includes(schema)),
    I6_SCHEMAS,
  );
  for (const schemaVersion of I6_SCHEMAS) {
    assert.throws(() => normalizeCanonicalValue(schemaVersion, {}), (error) => (
      error?.code === 'CANONICAL_SCHEMA_UNKNOWN'
      || error?.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED'
      || error?.code === 'MARKET_DATA_INPUT_INVALID'
      || error?.code === 'MARKET_DATA_UNKNOWN_FIELD'
    ));
  }
});

test('L3-I6 authority policy is deterministic with closed scope and uniqueness key', () => withStore((store) => {
  const a = buildMarketDataDatasetSnapshotBindingAuthorityPolicy({ store });
  const b = buildMarketDataDatasetSnapshotBindingAuthorityPolicy({ store });
  assert.equal(a.bindingAuthorityPolicyId, b.bindingAuthorityPolicyId);
  const verified = verifyMarketDataDatasetSnapshotBindingAuthorityPolicy({
    store, bindingAuthorityPolicyId: a.bindingAuthorityPolicyId,
  });
  assert.equal(verified.bindingAuthorityPolicy.authorityScope, MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE);
  assert.equal(
    verified.bindingAuthorityPolicy.bindingUniquenessKeyVersion,
    MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION,
  );
  assert.equal(
    verified.bindingAuthorityPolicy.registryNamespaceVersion,
    MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION,
  );
}));

test('L3-I6 forged authority policy is refused', () => {
  expectCode(() => normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1({
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION,
    authorityScope: 'OTHER_SCOPE',
    bindingUniquenessKeyVersion: MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION,
  }), 'MARKET_DATA_BINDING_AUTHORITY_MISMATCH');
  expectCode(() => normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1({
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION,
    authorityScope: MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE,
    bindingUniquenessKeyVersion: 'OTHER_KEY/1',
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1({
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: 'OtherNamespace/1',
    authorityScope: MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE,
    bindingUniquenessKeyVersion: MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION,
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1({
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION,
    authorityScope: MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE,
    bindingUniquenessKeyVersion: MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION,
    extra: true,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
});

// ---------------------------------------------------------------------------
// Binding + quality + coherence
// ---------------------------------------------------------------------------

test('L3-I6 first binding via publishOfficialMarketDataSnapshotBinding', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  assert.ok(ctx.published.bindingId);
  assert.ok(ctx.published.bindingRegistryManifestId);
  assert.notEqual(ctx.published.bindingRegistryManifestId, ctx.root.bindingRegistryManifestId);
  const verified = verifyMarketDataDatasetSnapshotBinding({
    store, bindingId: ctx.published.bindingId,
  });
  assert.equal(verified.binding.materializationReportId, ctx.materialization.materializationReportId);
  assert.equal(verified.binding.qualityAssessmentId, ctx.quality.qualityAssessmentId);
  assert.equal(verified.binding.supersedesBindingId, null);
  const registry = verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
  });
  assert.deepEqual(registry.bindingRegistryManifest.bindingIds, [ctx.published.bindingId]);
  assert.equal(registry.bindingRegistryManifest.bindingTips.length, 1);
  assert.equal(registry.bindingRegistryManifest.bindingTips[0].tipBindingId, ctx.published.bindingId);
}));

test('L3-I6 publication key is derived from lineage/cutoff/policy', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const binding = readBinding(store, ctx.published.bindingId);
  const expected = deriveBindingPublicationKey(
    {
      ingestionLineageId: ctx.graph.lineage.ingestionLineageId,
      knowledgeCutoff: '2026-01-05T22:00:00.000Z',
    },
    ctx.policy.materializationPolicyId,
  );
  assert.deepEqual(binding.bindingPublicationKey, expected);
  assert.equal(binding.ingestionLineageId, expected.ingestionLineageId);
  assert.equal(binding.knowledgeCutoff, expected.knowledgeCutoff);
  assert.equal(binding.materializationPolicyId, expected.materializationPolicyId);
  // Closed V1: only one official materialization policy exists — a forged
  // alternate policy id in the publication key is refused by binding normalize.
  expectCode(() => normalizeMarketDataDatasetSnapshotBindingV1({
    ...binding,
    bindingPublicationKey: {
      ...binding.bindingPublicationKey,
      materializationPolicyId: ctx.graph.lineage.ingestionLineageId,
    },
  }), 'MARKET_DATA_SNAPSHOT_BINDING_INVALID');
}));

test('L3-I6 unknown fields refused on binding surfaces', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const binding = readBinding(store, ctx.published.bindingId);
  expectCode(() => normalizeMarketDataDatasetSnapshotBindingV1({ ...binding, latest: true }), 'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => normalizeMarketDataDatasetSnapshotBindingRegistryManifestV1({
    ...readRegistry(store, ctx.published.bindingRegistryManifestId),
    tipOfCas: true,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    materializationReportId: ctx.materialization.materializationReportId,
    qualityAssessmentId: ctx.quality.qualityAssessmentId,
    latest: true,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
}));

test('L3-I6 quality assessment is required', () => withStore((store) => {
  const seeded = seedTwoSessions(store);
  const { materialization } = materializeAndAssess(
    store, seeded.registryId, seeded.resolved, seeded.policy, 'i6-req',
  );
  const { root } = openBindingRoot(store);
  expectCode(() => publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: root.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: materialization.materializationReportId,
    qualityAssessmentId: null,
  }), 'MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED');
  expectCode(() => buildMarketDataDatasetSnapshotBinding({
    store,
    baseBindingRegistryManifestId: root.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: materialization.materializationReportId,
    qualityAssessmentId: null,
  }), 'MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED');
}));

test('L3-I6 quality assessment for another snapshot is refused', () => withStore((store) => {
  const seeded = seedTwoSessions(store);
  const first = materializeAndAssess(store, seeded.registryId, seeded.resolved, seeded.policy, 'i6-q1');
  const futureSource = makeSource(store, seeded.graph, [
    atomsRow(seeded.graph, '2026-01-10'),
  ], '2026-01-10T22:00:00.000Z', 'i6-q-alt');
  const future = appendIngestion(store, seeded.graph, seeded.registryId, futureSource, [
    candidateBase(seeded.graph, futureSource, '2026-01-10'),
  ]);
  const resolvedAlt = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: future.registryId,
    ingestionLineageId: seeded.graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-10T22:00:00.000Z',
    corporateActionRegistryManifestId: seeded.graph.corporateRegistry.registryManifestId,
  });
  const second = materializeAndAssess(store, future.registryId, resolvedAlt, seeded.policy, 'i6-q2');
  assert.notEqual(
    first.materialization.datasetSnapshotManifestId,
    second.materialization.datasetSnapshotManifestId,
  );
  const { root } = openBindingRoot(store);
  expectCode(() => publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: root.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: first.materialization.materializationReportId,
    qualityAssessmentId: second.quality.qualityAssessmentId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_INVALID');
}));

test('L3-I6 temporal capability, basis, treatment and pins stay coherent', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const binding = verifyMarketDataDatasetSnapshotBinding({
    store, bindingId: ctx.published.bindingId,
  }).binding;
  assert.equal(binding.temporalCapability, 'RETROSPECTIVE_CAPTURE_ONLY');
  assert.equal(binding.priceBasis, 'RAW');
  assert.equal(binding.corporateActionTreatment, 'RAW_SOURCE_UNTRANSFORMED');
  assert.equal(binding.identityRegistryManifestId, ctx.graph.instrumentRegistry.registryManifestId);
  assert.equal(binding.calendarRegistryManifestId, ctx.graph.calendarRegistry.calendarRegistryManifestId);
  assert.equal(
    binding.corporateActionRegistryManifestId,
    ctx.graph.corporateRegistry.registryManifestId,
  );
  assert.equal(binding.ingestionRegistryManifestId, ctx.registryId);
  // Forged temporal capability fails closed on verify recompute.
  const forged = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
    value: {
      ...binding,
      temporalCapability: 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED',
    },
  });
  expectCode(() => verifyMarketDataDatasetSnapshotBinding({
    store, bindingId: forged.objectId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_INVALID');
}));

test('L3-I6 verifier recomputes binding closure', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const again = verifyMarketDataDatasetSnapshotBinding({
    store, bindingId: ctx.published.bindingId,
  });
  assert.equal(again.bindingId, ctx.published.bindingId);
  const binding = readBinding(store, ctx.published.bindingId);
  const forged = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
    value: {
      ...binding,
      knowledgeCutoff: '2026-01-05T22:00:01.000Z',
      bindingPublicationKey: {
        ...binding.bindingPublicationKey,
        knowledgeCutoff: '2026-01-05T22:00:01.000Z',
      },
    },
  });
  expectCode(() => verifyMarketDataDatasetSnapshotBinding({
    store, bindingId: forged.objectId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_INVALID');
}));

// ---------------------------------------------------------------------------
// Root + append + versioning
// ---------------------------------------------------------------------------

test('L3-I6 root registry is deterministic and empty', () => withStore((store) => {
  const a = buildMarketDataDatasetSnapshotBindingAuthorityPolicy({ store });
  const root1 = buildRootMarketDataDatasetSnapshotBindingRegistry({
    store, bindingAuthorityPolicyId: a.bindingAuthorityPolicyId,
  });
  const root2 = buildRootMarketDataDatasetSnapshotBindingRegistry({
    store, bindingAuthorityPolicyId: a.bindingAuthorityPolicyId,
  });
  assert.equal(root1.bindingRegistryManifestId, root2.bindingRegistryManifestId);
  const verified = verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: root1.bindingRegistryManifestId,
  });
  assert.deepEqual(verified.bindingRegistryManifest.bindingIds, []);
  assert.deepEqual(verified.bindingRegistryManifest.bindingTips, []);
  assert.equal(verified.bindingRegistryManifest.supersedesBindingRegistryManifestId, null);
  const forgedRoot = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
    value: {
      schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
      bindingAuthorityPolicyId: a.bindingAuthorityPolicyId,
      supersedesBindingRegistryManifestId: null,
      bindingIds: [a.bindingAuthorityPolicyId],
      bindingTips: [{
        bindingPublicationKey: {
          ingestionLineageId: a.bindingAuthorityPolicyId,
          knowledgeCutoff: '2026-01-05T22:00:00.000Z',
          materializationPolicyId: a.bindingAuthorityPolicyId,
        },
        tipBindingId: a.bindingAuthorityPolicyId,
      }],
    },
  });
  expectCode(() => verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: forgedRoot.objectId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_INVALID');
}));

test('L3-I6 append adds exactly one binding; other tips unchanged', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  // Independent key via later cutoff (after future non-contributive session).
  const futureSource = makeSource(store, ctx.graph, [
    atomsRow(ctx.graph, '2026-01-10'),
  ], '2026-01-10T22:00:00.000Z', 'i6-future-tip');
  const future = appendIngestion(store, ctx.graph, ctx.registryId, futureSource, [
    candidateBase(ctx.graph, futureSource, '2026-01-10'),
  ]);
  const resolved2 = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: future.registryId,
    ingestionLineageId: ctx.graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-10T22:00:00.000Z',
    corporateActionRegistryManifestId: ctx.graph.corporateRegistry.registryManifestId,
  });
  const second = materializeAndAssess(store, future.registryId, resolved2, ctx.policy, 'i6-k2');
  const tipsBefore = readRegistry(store, ctx.published.bindingRegistryManifestId).bindingTips;
  const published2 = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: second.materialization.materializationReportId,
    qualityAssessmentId: second.quality.qualityAssessmentId,
  });
  const registry = verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: published2.bindingRegistryManifestId,
  });
  assert.equal(registry.bindingRegistryManifest.bindingIds.length, 2);
  assert.ok(registry.bindingRegistryManifest.bindingIds.includes(ctx.published.bindingId));
  assert.ok(registry.bindingRegistryManifest.bindingIds.includes(published2.bindingId));
  assert.equal(registry.bindingRegistryManifest.bindingTips.length, 2);
  const tipK1 = registry.bindingRegistryManifest.bindingTips.find((tip) => (
    tip.tipBindingId === ctx.published.bindingId
  ));
  assert.ok(tipK1);
  assert.deepEqual(
    tipK1.bindingPublicationKey,
    tipsBefore.find((tip) => tip.tipBindingId === ctx.published.bindingId).bindingPublicationKey,
  );
}));

test('L3-I6 stale/omitted/other-key parent and branch are refused', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);

  // Omitted parent field.
  expectCode(() => publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    materializationReportId: ctx.materialization.materializationReportId,
    qualityAssessmentId: ctx.quality.qualityAssessmentId,
  }), 'MARKET_DATA_INPUT_INVALID');

  // Parent belonging to another key: publish independent cutoff tip, then misuse it.
  const futureSource = makeSource(store, ctx.graph, [
    atomsRow(ctx.graph, '2026-01-10'),
  ], '2026-01-10T22:00:00.000Z', 'i6-other-key');
  const future = appendIngestion(store, ctx.graph, ctx.registryId, futureSource, [
    candidateBase(ctx.graph, futureSource, '2026-01-10'),
  ]);
  const resolved2 = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: future.registryId,
    ingestionLineageId: ctx.graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-10T22:00:00.000Z',
    corporateActionRegistryManifestId: ctx.graph.corporateRegistry.registryManifestId,
  });
  const second = materializeAndAssess(store, future.registryId, resolved2, ctx.policy, 'i6-other');
  const published2 = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: second.materialization.materializationReportId,
    qualityAssessmentId: second.quality.qualityAssessmentId,
  });
  // Same-key successor claiming the other key's tip as parent.
  expectCode(() => buildMarketDataDatasetSnapshotBinding({
    store,
    baseBindingRegistryManifestId: published2.bindingRegistryManifestId,
    expectedParentBindingId: published2.bindingId,
    materializationReportId: ctx.materialization.materializationReportId,
    qualityAssessmentId: ctx.quality.qualityAssessmentId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT');

  // Stale parent: tip exists for key; new same-key version must not claim null.
  const tip02 = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: ctx.resolved.resolvedSeriesManifestId }),
    expectedObjectId: ctx.resolved.resolvedSeriesManifestId,
    schemaVersion: 'MarketDataResolvedSeriesManifest/1',
  }).value.resolvedBarEntries.find((e) => e.sessionDate === '2026-01-02').resolvedCorrectionTipId;
  const revSource = makeSource(store, ctx.graph, [
    atomsRow(ctx.graph, '2026-01-02', { closeAtoms: '111', highAtoms: '112' }),
  ], '2026-01-05T21:30:00.000Z', 'i6-stale-rev');
  const late = appendIngestion(store, ctx.graph, ctx.registryId, revSource, [
    candidateBase(ctx.graph, revSource, '2026-01-02', {
      candidateKind: 'BAR_VALUE_REVISION',
      targetCorrectionId: tip02,
      replacementValues: { ...VALUES, closeAtoms: '111', highAtoms: '112' },
    }),
  ]);
  const resolvedRev = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: late.registryId,
    ingestionLineageId: ctx.graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-05T22:00:00.000Z',
    corporateActionRegistryManifestId: ctx.graph.corporateRegistry.registryManifestId,
  });
  const revMat = materializeAndAssess(store, late.registryId, resolvedRev, ctx.policy, 'i6-stale');
  expectCode(() => publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: published2.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: revMat.materialization.materializationReportId,
    qualityAssessmentId: revMat.quality.qualityAssessmentId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT');

  // Branch: append child A, then refuse sibling child B against the same stale parent.
  const childA = buildMarketDataDatasetSnapshotBinding({
    store,
    baseBindingRegistryManifestId: published2.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    materializationReportId: revMat.materialization.materializationReportId,
    qualityAssessmentId: revMat.quality.qualityAssessmentId,
  });
  const revMatB = materializeAndAssess(store, late.registryId, resolvedRev, ctx.policy, 'i6-branch-b');
  const childB = buildMarketDataDatasetSnapshotBinding({
    store,
    baseBindingRegistryManifestId: published2.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    materializationReportId: revMat.materialization.materializationReportId,
    qualityAssessmentId: revMatB.quality.qualityAssessmentId,
  });
  const appendedA = appendMarketDataDatasetSnapshotBindingRegistry({
    store,
    baseBindingRegistryManifestId: published2.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    bindingId: childA.bindingId,
  });
  expectCode(() => appendMarketDataDatasetSnapshotBindingRegistry({
    store,
    baseBindingRegistryManifestId: appendedA.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    bindingId: childB.bindingId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT');
}));

test('L3-I6 same-key new version supersedes; concurrent child refused', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const tip02 = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: ctx.resolved.resolvedSeriesManifestId }),
    expectedObjectId: ctx.resolved.resolvedSeriesManifestId,
    schemaVersion: 'MarketDataResolvedSeriesManifest/1',
  }).value.resolvedBarEntries.find((e) => e.sessionDate === '2026-01-02').resolvedCorrectionTipId;
  const revSource = makeSource(store, ctx.graph, [
    atomsRow(ctx.graph, '2026-01-02', { closeAtoms: '111', highAtoms: '112' }),
  ], '2026-01-05T21:30:00.000Z', 'i6-ver');
  const late = appendIngestion(store, ctx.graph, ctx.registryId, revSource, [
    candidateBase(ctx.graph, revSource, '2026-01-02', {
      candidateKind: 'BAR_VALUE_REVISION',
      targetCorrectionId: tip02,
      replacementValues: { ...VALUES, closeAtoms: '111', highAtoms: '112' },
    }),
  ]);
  const resolved2 = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: late.registryId,
    ingestionLineageId: ctx.graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-05T22:00:00.000Z',
    corporateActionRegistryManifestId: ctx.graph.corporateRegistry.registryManifestId,
  });
  const second = materializeAndAssess(store, late.registryId, resolved2, ctx.policy, 'i6-ver-q');
  assert.notEqual(second.materialization.materializationReportId, ctx.materialization.materializationReportId);
  const published2 = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    materializationReportId: second.materialization.materializationReportId,
    qualityAssessmentId: second.quality.qualityAssessmentId,
  });
  assert.notEqual(published2.bindingId, ctx.published.bindingId);
  const binding2 = verifyMarketDataDatasetSnapshotBinding({
    store, bindingId: published2.bindingId,
  }).binding;
  assert.equal(binding2.supersedesBindingId, ctx.published.bindingId);
  const registry = verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: published2.bindingRegistryManifestId,
  });
  assert.ok(registry.bindingRegistryManifest.bindingIds.includes(ctx.published.bindingId));
  assert.ok(registry.bindingRegistryManifest.bindingIds.includes(published2.bindingId));
  const tip = tipForBindingPublicationKey(
    registry.bindingRegistryManifest, binding2.bindingPublicationKey,
  );
  assert.equal(tip, published2.bindingId);
  // Concurrent child against stale parent (distinct quality so idempotence does not short-circuit).
  const secondAlt = materializeAndAssess(store, late.registryId, resolved2, ctx.policy, 'i6-ver-q-alt');
  expectCode(() => publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: published2.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    materializationReportId: second.materialization.materializationReportId,
    qualityAssessmentId: secondAlt.quality.qualityAssessmentId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT');
}));

test('L3-I6 independent keys by cutoff and lineage; forged policy key refused', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  // Cutoff-different key.
  const futureSource = makeSource(store, ctx.graph, [
    atomsRow(ctx.graph, '2026-01-10'),
  ], '2026-01-10T22:00:00.000Z', 'i6-ind-cut');
  const future = appendIngestion(store, ctx.graph, ctx.registryId, futureSource, [
    candidateBase(ctx.graph, futureSource, '2026-01-10'),
  ]);
  const resolvedCut = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: future.registryId,
    ingestionLineageId: ctx.graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-10T22:00:00.000Z',
    corporateActionRegistryManifestId: ctx.graph.corporateRegistry.registryManifestId,
  });
  const matCut = materializeAndAssess(store, future.registryId, resolvedCut, ctx.policy, 'i6-ind-cut-q');
  const pubCut = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: matCut.materialization.materializationReportId,
    qualityAssessmentId: matCut.quality.qualityAssessmentId,
  });
  assert.notEqual(pubCut.bindingId, ctx.published.bindingId);

  const binding1 = readBinding(store, ctx.published.bindingId);
  const binding2 = readBinding(store, pubCut.bindingId);
  assert.notEqual(binding1.bindingPublicationKey.knowledgeCutoff, binding2.bindingPublicationKey.knowledgeCutoff);
  assert.equal(binding1.bindingPublicationKey.ingestionLineageId, binding2.bindingPublicationKey.ingestionLineageId);
  assert.equal(
    binding1.bindingPublicationKey.materializationPolicyId,
    binding2.bindingPublicationKey.materializationPolicyId,
  );
  // Append on K_cutoff must leave K_original tip unchanged.
  const registry = verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: pubCut.bindingRegistryManifestId,
  });
  assert.equal(
    tipForBindingPublicationKey(registry.bindingRegistryManifest, binding1.bindingPublicationKey),
    ctx.published.bindingId,
  );
  // Official builder always emits the closed V1 materializationPolicyId. A forged
  // alternate policy id in the publication key is refused by binding verify
  // (cannot produce an independent tip via official APIs).
  const forgedPolicyBinding = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
    value: {
      ...binding1,
      materializationPolicyId: ctx.graph.lineage.ingestionLineageId,
      bindingPublicationKey: {
        ...binding1.bindingPublicationKey,
        materializationPolicyId: ctx.graph.lineage.ingestionLineageId,
      },
    },
  });
  expectCode(() => verifyMarketDataDatasetSnapshotBinding({
    store, bindingId: forgedPolicyBinding.objectId,
  }), 'MARKET_DATA_SNAPSHOT_BINDING_INVALID');
}));

// ---------------------------------------------------------------------------
// Idempotence + non-interference + isolation
// ---------------------------------------------------------------------------

test('L3-I6 idempotent replay returns same IDs (noop preferred)', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const again = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: ctx.materialization.materializationReportId,
    qualityAssessmentId: ctx.quality.qualityAssessmentId,
  });
  assert.equal(again.bindingId, ctx.published.bindingId);
  assert.equal(again.bindingRegistryManifestId, ctx.published.bindingRegistryManifestId);
  assert.equal(again.noop, true);
}));

test('L3-I6 non-interference: non-contributive ingestion pin keeps same bindingId', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const futureSource = makeSource(store, ctx.graph, [
    atomsRow(ctx.graph, '2026-01-10'),
  ], '2026-01-10T22:00:00.000Z', 'i6-nonint');
  const future = appendIngestion(store, ctx.graph, ctx.registryId, futureSource, [
    candidateBase(ctx.graph, futureSource, '2026-01-10'),
  ]);
  const remat = materializeMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: future.registryId,
    resolvedSeriesManifestId: ctx.resolved.resolvedSeriesManifestId,
    materializationPolicyId: ctx.policy.materializationPolicyId,
  });
  assert.equal(remat.materializationReportId, ctx.materialization.materializationReportId);
  const again = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: null,
    materializationReportId: remat.materializationReportId,
    qualityAssessmentId: ctx.quality.qualityAssessmentId,
  });
  assert.equal(again.bindingId, ctx.published.bindingId);
  assert.equal(again.noop, true);
}));

test('L3-I6 historical contributive revision produces new superseding bindingId', () => withStore((store) => {
  const ctx = seedPublishedBinding(store);
  const tip02 = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: ctx.resolved.resolvedSeriesManifestId }),
    expectedObjectId: ctx.resolved.resolvedSeriesManifestId,
    schemaVersion: 'MarketDataResolvedSeriesManifest/1',
  }).value.resolvedBarEntries.find((e) => e.sessionDate === '2026-01-02').resolvedCorrectionTipId;
  const revSource = makeSource(store, ctx.graph, [
    atomsRow(ctx.graph, '2026-01-02', { closeAtoms: '111', highAtoms: '112' }),
  ], '2026-01-05T21:30:00.000Z', 'i6-hist');
  const late = appendIngestion(store, ctx.graph, ctx.registryId, revSource, [
    candidateBase(ctx.graph, revSource, '2026-01-02', {
      candidateKind: 'BAR_VALUE_REVISION',
      targetCorrectionId: tip02,
      replacementValues: { ...VALUES, closeAtoms: '111', highAtoms: '112' },
    }),
  ]);
  const resolved2 = buildMarketDataResolvedSeriesManifest({
    store,
    ingestionRegistryManifestId: late.registryId,
    ingestionLineageId: ctx.graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-05T22:00:00.000Z',
    corporateActionRegistryManifestId: ctx.graph.corporateRegistry.registryManifestId,
  });
  const second = materializeAndAssess(store, late.registryId, resolved2, ctx.policy, 'i6-hist-q');
  const published2 = publishOfficialMarketDataSnapshotBinding({
    store,
    baseBindingRegistryManifestId: ctx.published.bindingRegistryManifestId,
    expectedParentBindingId: ctx.published.bindingId,
    materializationReportId: second.materialization.materializationReportId,
    qualityAssessmentId: second.quality.qualityAssessmentId,
  });
  assert.notEqual(published2.bindingId, ctx.published.bindingId);
  assert.equal(
    readBinding(store, published2.bindingId).supersedesBindingId,
    ctx.published.bindingId,
  );
}));

test('L3-I6 isolation: no scanner imports in I6 modules', () => {
  const contract = readFileSync(
    new URL('../src/contracts/marketDataDatasetSnapshotBindingL3V1.mjs', import.meta.url), 'utf8',
  );
  const publication = readFileSync(
    new URL('../src/publication/publishOfficialMarketDataSnapshotBindingL3V1.mjs', import.meta.url), 'utf8',
  );
  for (const source of [contract, publication]) {
    assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/app\//);
    assert.doesNotMatch(source, /wheel-dashboard/);
    assert.doesNotMatch(source, /server\.js/);
    assert.doesNotMatch(source, /wheelScanner/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /Date\.now\s*\(/);
    assert.doesNotMatch(source, /new Date\s*\(\s*\)/);
    assert.doesNotMatch(source, /Math\.random/);
    assert.doesNotMatch(source, /randomUUID/);
    assert.doesNotMatch(source, /tipOfCas|findLatest/);
  }
});

test('L3-I6 multi-store idempotence yields identical IDs', () => {
  function publishOnce(root) {
    const store = createContentAddressedStore({ root });
    const seeded = seedTwoSessions(store);
    const { materialization, quality } = materializeAndAssess(
      store, seeded.registryId, seeded.resolved, seeded.policy, 'i6-multi',
    );
    const authority = buildMarketDataDatasetSnapshotBindingAuthorityPolicy({ store });
    const rootReg = buildRootMarketDataDatasetSnapshotBindingRegistry({
      store, bindingAuthorityPolicyId: authority.bindingAuthorityPolicyId,
    });
    const published = publishOfficialMarketDataSnapshotBinding({
      store,
      baseBindingRegistryManifestId: rootReg.bindingRegistryManifestId,
      expectedParentBindingId: null,
      materializationReportId: materialization.materializationReportId,
      qualityAssessmentId: quality.qualityAssessmentId,
    });
    return {
      bindingAuthorityPolicyId: authority.bindingAuthorityPolicyId,
      rootBindingRegistryManifestId: rootReg.bindingRegistryManifestId,
      bindingId: published.bindingId,
      bindingRegistryManifestId: published.bindingRegistryManifestId,
    };
  }
  const rootA = mkdtempSync(join(tmpdir(), 'l3-i6-multi-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'l3-i6-multi-b-'));
  try {
    const a = publishOnce(rootA);
    const b = publishOnce(rootB);
    assert.deepEqual(a, b);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
