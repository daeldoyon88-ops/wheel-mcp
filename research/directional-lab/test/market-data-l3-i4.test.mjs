/**
 * L3-I4 permanent suite — point-in-time resolver and
 * MarketDataResolvedSeriesManifest/1. Synthetic fixtures only.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
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
import { sha256Digest } from '../src/contracts/marketDataL3CommonV1.mjs';
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
import {
  runIngestion,
  MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1,
} from '../src/pipeline/runMarketDataIngestionL3V1.mjs';
import {
  MARKET_DATA_RESOLVED_BAR_DISPOSITIONS,
  MARKET_DATA_RESOLVED_SERIES_L3_SCHEMA_VERSIONS,
  MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
  normalizeMarketDataResolvedSeriesManifestV1,
} from '../src/contracts/marketDataResolvedSeriesL3V1.mjs';
import {
  buildMarketDataResolvedSeriesManifest,
  resolveMarketDataAsOf,
  verifyMarketDataResolvedSeries,
  verifyMarketDataResolvedSeriesManifest,
} from '../src/resolution/resolveMarketDataAsOfL3V1.mjs';
import { addDays } from '../src/time/civilDate.mjs';

const I4_SCHEMAS = ['MarketDataResolvedSeriesManifest/1'];
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

/** L2B/L2C/calendar (Jan 2026 sessions) + three-mode policy + empty root registry. */
function setupI4(store, options = {}) {
  const knowledgeModes = options.knowledgeModes
    ?? ['CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED', 'PROVIDER_REVISION_HISTORY_ATTESTED'];
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l3-i4-synthetic-instruments/1',
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
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i4-synthetic-actions/1', identityNamespaceVersion: 'L3-I4/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I4/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I4/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I4/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I4/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I4/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l3-i4',
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
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'synthetic-l3-i4/1',
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
      providerPublicationTimeField: knowledgeModes.some((m) => m !== 'CAPTURE_TIME_ONLY') ? 'providerPublicationTime' : null,
      providerRevisionIdField: knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED') ? 'providerRevisionId' : null,
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
      registryNamespaceVersion: 'synthetic-l3-i4/1',
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
    instrument, instrumentAuthority, instrumentManifest, instrumentRegistry,
    corporatePolicies, corporateRegistry, ruleset, calendarPolicy, calendar, calendarRegistry,
    ingestionPolicy, lineage, registryAuthority, rootRegistry, barBySession, priceBasis: 'RAW',
  };
}

function atomsHeader(policy) {
  const header = [...MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1];
  if (policy.knowledgeModes.some((m) => m !== 'CAPTURE_TIME_ONLY')) header.push(policy.providerPublicationTimeField);
  if (policy.knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED')) header.push(policy.providerRevisionIdField);
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

function buildEvidence(store, graph, source, rowIndex, timestamp, revisionId = null) {
  const header = atomsHeader(graph.ingestionPolicy.ingestionPolicy);
  const cellIndex = header.indexOf('providerPublicationTime');
  return Source.buildMarketDataSourceTemporalEvidence({
    store,
    evidence: {
      schemaVersion: Source.MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
      sourceArtifactId: source.artifact.sourceArtifactId,
      acquisitionRecordId: source.acquisition.acquisitionRecordId,
      parseResultId: source.parseResult.parseResultId,
      sourceRowIndex: rowIndex,
      sourceCellPath: `/cells/${cellIndex}`,
      sourceCellDigest: sha256Digest(timestamp),
      rawTimestampValue: timestamp,
      normalizedTimestampUtc: timestamp,
      evidenceKind: revisionId === null ? 'PROVIDER_PUBLICATION_TIMESTAMP' : 'PROVIDER_REVISION_TIMESTAMP',
      providerRevisionId: revisionId,
    },
  }).sourceTemporalEvidenceId;
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

function revisionCandidate(graph, source, sessionDate, targetCorrectionId, values, overrides = {}) {
  return candidateBase(graph, source, sessionDate, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId,
    replacementValues: { ...VALUES, ...values },
    ...overrides,
  });
}

function withdrawalCandidate(graph, source, sessionDate, targetCorrectionId, overrides = {}) {
  const candidate = candidateBase(graph, source, sessionDate, {
    candidateKind: 'BAR_WITHDRAWAL', targetCorrectionId, ...overrides,
  });
  delete candidate.replacementValues;
  return candidate;
}

function restorationCandidate(graph, source, sessionDate, targetWithdrawalCorrectionId, restoredObservationId, overrides = {}) {
  const candidate = candidateBase(graph, source, sessionDate, {
    candidateKind: 'BAR_RESTORATION', targetWithdrawalCorrectionId, restoredObservationId, ...overrides,
  });
  delete candidate.targetCorrectionId;
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

/** Publish candidates as one authoritative ingestion and append it to the pinned registry. */
function appendIngestion(store, graph, registryId, source, candidates, options = {}) {
  const { ingestionRegistryManifest: registry } = verifyMarketDataIngestionRegistry({
    store, ingestionRegistryManifestId: registryId,
  });
  const parentId = tipForLineage(registry, graph.lineage.ingestionLineageId);
  const pins = options.pins ?? {
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  };
  let view = options.baseView;
  if (!view) {
    const full = derivePinnedIngestionBaseView(store, registryId, graph.lineage.ingestionLineageId, parentId);
    view = {
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
  }
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
    ingestionManifest: ingestion.ingestionManifest,
    registryId: appended.ingestionRegistryManifestId,
    observationIds: newBarObservationIds,
    correctionIds: newBarCorrectionIds,
  };
}

function correctionsOf(store, correctionIds) {
  return correctionIds.map((correctionId) => ({
    correctionId,
    correction: Revision.verifyMarketDataBarCorrection({ store, correctionId }).correction,
  }));
}

function correctionOfKind(store, correctionIds, correctionKind) {
  const found = correctionsOf(store, correctionIds)
    .filter((item) => item.correction.correctionKind === correctionKind);
  assert.equal(found.length, 1);
  return found[0];
}

function observationValues(store, observationId) {
  return Revision.verifyMarketDataBarObservation({ store, observationId }).observation.values;
}

function readResolved(store, resolvedSeriesManifestId) {
  return store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: resolvedSeriesManifestId }),
    expectedObjectId: resolvedSeriesManifestId,
    schemaVersion: MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
  }).value;
}

function forgeResolved(store, manifest) {
  return store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
    value: manifest,
  }).objectId;
}

function resolveArgs(store, graph, registryId, knowledgeCutoff) {
  return {
    store,
    ingestionRegistryManifestId: registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff,
  };
}

test('L3-I4 registers exactly one additive schema for a total of 80 after L4A-A', () => {
  assert.deepEqual([...MARKET_DATA_RESOLVED_SERIES_L3_SCHEMA_VERSIONS], I4_SCHEMAS);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 80);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 80);
  assert.deepEqual(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.filter((schema) => I4_SCHEMAS.includes(schema)),
    I4_SCHEMAS,
  );
  assert.deepEqual([...MARKET_DATA_RESOLVED_BAR_DISPOSITIONS],
    ['MOVED_TO_OTHER_SESSION', 'PRESENT', 'WITHDRAWN']);
  assert.throws(() => normalizeCanonicalValue(MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION, {}),
    /CANONICAL_SCHEMA_UNKNOWN/);
});

test('L3-I4 closed APIs refuse implicit registry, lineage, cutoff, unknown fields and direct objects', () => {
  const ID = `sha256:${'1'.repeat(64)}`;
  const fakeStore = {
    putCanonicalObject() {}, readCanonicalObject() {}, uriForObject() {}, readObject() {},
  };
  expectCode(() => resolveMarketDataAsOf(undefined), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => resolveMarketDataAsOf(null), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => resolveMarketDataAsOf({}), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => resolveMarketDataAsOf({
    store: fakeStore, ingestionRegistryManifestId: ID, ingestionLineageId: ID,
    knowledgeCutoff: '2026-01-01T00:00:00.000Z', extra: true,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => resolveMarketDataAsOf({
    store: fakeStore, ingestionRegistryManifestId: { schemaVersion: 'anything' },
    ingestionLineageId: ID, knowledgeCutoff: '2026-01-01T00:00:00.000Z',
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => resolveMarketDataAsOf({
    store: fakeStore, ingestionRegistryManifestId: ID, ingestionLineageId: ID,
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => resolveMarketDataAsOf({
    store: fakeStore, ingestionRegistryManifestId: ID, ingestionLineageId: ID,
    knowledgeCutoff: '2026-01-01',
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => resolveMarketDataAsOf({
    store: null, ingestionRegistryManifestId: ID, ingestionLineageId: ID,
    knowledgeCutoff: '2026-01-01T00:00:00.000Z',
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => buildMarketDataResolvedSeriesManifest({
    store: fakeStore, ingestionRegistryManifestId: ID, ingestionLineageId: ID,
    knowledgeCutoff: '2026-01-01T00:00:00.000Z',
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => buildMarketDataResolvedSeriesManifest({
    store: fakeStore, ingestionRegistryManifestId: ID, ingestionLineageId: ID,
    knowledgeCutoff: '2026-01-01T00:00:00.000Z', corporateActionRegistryManifestId: ID, alien: 1,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => verifyMarketDataResolvedSeries({
    store: fakeStore, resolvedSeriesManifestId: ID,
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store: fakeStore, resolvedSeriesManifestId: ID, alien: 1,
  }), 'MARKET_DATA_UNKNOWN_FIELD');
});

test('L3-I4 (§20) correction 100→101 resolves by provable knowledge; exact bound; idempotent build', () => withStore((store) => {
  const graph = setupI4(store);
  const upperA = '2026-01-10T21:00:00.000Z';
  const upperB = '2026-01-15T12:00:00.000Z';
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-10')], upperA, 'i4-2022-a');
  const first = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-10')]);
  const initialTip = first.correctionIds[0];
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-10', { closeAtoms: '101' })], upperB, 'i4-2022-b');
  const second = appendIngestion(store, graph, first.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-10', initialTip, { closeAtoms: '101' })]);

  // Resolve at the late cutoff FIRST so results cannot depend on resolution order.
  const late = resolveMarketDataAsOf(resolveArgs(store, graph, second.registryId, '2026-01-16T00:00:00.000Z'));
  assert.equal(late.resolvedBarEntries.length, 1);
  assert.equal(late.resolvedBarEntries[0].disposition, 'PRESENT');
  assert.equal(late.resolvedBarEntries[0].sessionDate, '2026-01-10');
  assert.equal(late.resolvedBarEntries[0].resolvedCorrectionTipId, second.correctionIds[0]);
  assert.equal(observationValues(store, late.resolvedBarEntries[0].resolvedObservationId).closeAtoms, '101');

  const early = resolveMarketDataAsOf(resolveArgs(store, graph, second.registryId, '2026-01-12T08:00:00.000Z'));
  assert.equal(early.resolvedBarEntries[0].resolvedCorrectionTipId, initialTip);
  assert.equal(observationValues(store, early.resolvedBarEntries[0].resolvedObservationId).closeAtoms, '100');

  // Exact-bound cutoff: knowledgeTimeUpperBound == knowledgeCutoff is visible.
  const exact = resolveMarketDataAsOf(resolveArgs(store, graph, second.registryId, upperA));
  assert.equal(exact.resolvedBarEntries[0].resolvedCorrectionTipId, initialTip);
  // One millisecond earlier nothing is provable.
  expectCode(() => resolveMarketDataAsOf(resolveArgs(store, graph, second.registryId, '2026-01-10T20:59:59.999Z')),
    'MARKET_DATA_HISTORICAL_KNOWLEDGE_NOT_PROVABLE');

  // Idempotent build: same pinned inputs → same resolvedSeriesManifestId.
  const buildArgs = {
    store, ingestionRegistryManifestId: second.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-12T08:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  };
  const m1 = buildMarketDataResolvedSeriesManifest(buildArgs);
  const m2 = buildMarketDataResolvedSeriesManifest(buildArgs);
  assert.deepEqual(Object.keys(m1), ['resolvedSeriesManifestId']);
  assert.equal(m1.resolvedSeriesManifestId, m2.resolvedSeriesManifestId);
  const mLate = buildMarketDataResolvedSeriesManifest({ ...buildArgs, knowledgeCutoff: '2026-01-16T00:00:00.000Z' });
  assert.notEqual(mLate.resolvedSeriesManifestId, m1.resolvedSeriesManifestId);
  verifyMarketDataResolvedSeriesManifest({ store, resolvedSeriesManifestId: m1.resolvedSeriesManifestId });
  verifyMarketDataResolvedSeries({
    store, resolvedSeriesManifestId: m1.resolvedSeriesManifestId,
    ingestionRegistryManifestId: second.registryId,
  });
  const manifest = readResolved(store, m1.resolvedSeriesManifestId);
  assert.equal(manifest.knowledgeCutoff, '2026-01-12T08:00:00.000Z');
  assert.equal(manifest.ingestionLineageId, graph.lineage.ingestionLineageId);
}));

test('L3-I4 (§16) capture-only history is not provable; absent lineage is refused', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-07-18T00:00:00.000Z', 'i4-hist');
  const first = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  expectCode(() => resolveMarketDataAsOf(resolveArgs(store, graph, first.registryId, '2026-06-01T00:00:00.000Z')),
    'MARKET_DATA_HISTORICAL_KNOWLEDGE_NOT_PROVABLE');
  expectCode(() => buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: first.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-06-01T00:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  }), 'MARKET_DATA_HISTORICAL_KNOWLEDGE_NOT_PROVABLE');
  // A lineage with no authoritative ingestion under the pin is refused, never an empty series.
  const foreignLineage = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER_B', instrumentIdentityId: graph.instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis: 'RAW',
      sourceDatasetKind: 'EOD_OHLCV',
    },
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  expectCode(() => resolveMarketDataAsOf({
    store, ingestionRegistryManifestId: first.registryId,
    ingestionLineageId: foreignLineage.ingestionLineageId,
    knowledgeCutoff: '2026-07-18T00:00:00.000Z',
  }), 'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION');
}));

test('L3-I4 attested knowledge: per-object bounds within one ingestion, late attested contributions, capabilities', () => withStore((store) => {
  const graph = setupI4(store);
  const acq = '2026-07-01T00:00:00.000Z';
  const revTs02 = '2026-01-02T21:30:00.000Z';
  const pubTs05 = '2026-01-05T21:30:00.000Z';
  const rows = [
    atomsRow(graph, '2026-01-02', { providerPublicationTime: revTs02, providerRevisionId: 'rev-a' }),
    atomsRow(graph, '2026-01-05', { providerPublicationTime: pubTs05 }),
    atomsRow(graph, '2026-01-06'),
  ];
  const s1 = makeSource(store, graph, rows, acq, 'i4-attested');
  const first = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1, [
    candidateBase(graph, s1, '2026-01-02', {
      sourceRowIndex: 0,
      knowledgeMode: 'PROVIDER_REVISION_HISTORY_ATTESTED',
      knowledgeTimeLowerBound: revTs02, knowledgeTimeUpperBound: revTs02,
      sourceTimestampEvidenceId: buildEvidence(store, graph, s1, 0, revTs02, 'rev-a'),
      providerRevisionId: 'rev-a',
    }),
    candidateBase(graph, s1, '2026-01-05', {
      sourceRowIndex: 1,
      knowledgeMode: 'PROVIDER_PUBLICATION_TIME_ATTESTED',
      knowledgeTimeLowerBound: pubTs05, knowledgeTimeUpperBound: pubTs05,
      sourceTimestampEvidenceId: buildEvidence(store, graph, s1, 1, pubTs05),
    }),
    candidateBase(graph, s1, '2026-01-06', { sourceRowIndex: 2 }),
  ]);

  // Revision-history-attested root alone: point-in-time revision capability. (exact bound too)
  const revOnly = resolveMarketDataAsOf(resolveArgs(store, graph, first.registryId, revTs02));
  assert.equal(revOnly.resolvedBarEntries.length, 1);
  assert.equal(revOnly.resolvedBarEntries[0].sessionDate, '2026-01-02');
  assert.equal(revOnly.temporalCapability, 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED');

  // Publication + revision mix: publication is the minimum.
  const pubMix = resolveMarketDataAsOf(resolveArgs(store, graph, first.registryId, '2026-01-06T00:00:00.000Z'));
  assert.equal(pubMix.resolvedBarEntries.length, 2);
  assert.equal(pubMix.temporalCapability, 'POINT_IN_TIME_PUBLICATION_ATTESTED');

  // Same ingestion carries visible and invisible objects at one cutoff (per-object visibility).
  assert.ok(pubMix.resolvedBarEntries.every((entry) => entry.sessionDate !== '2026-01-06'));

  // Capture-only object joins at its acquisition bound: capability collapses to retrospective.
  const all = resolveMarketDataAsOf(resolveArgs(store, graph, first.registryId, acq));
  assert.equal(all.resolvedBarEntries.length, 3);
  assert.equal(all.temporalCapability, 'RETROSPECTIVE_CAPTURE_ONLY');

  // A late-acquired revision-history correction contributes at its historical revision instant.
  const lateRevTs = '2026-01-04T00:00:00.000Z';
  const s2 = makeSource(store, graph,
    [atomsRow(graph, '2026-01-02', { closeAtoms: '101', providerPublicationTime: lateRevTs, providerRevisionId: 'rev-b' })],
    '2026-07-02T00:00:00.000Z', 'i4-late-rev');
  const second = appendIngestion(store, graph, first.registryId, s2, [
    revisionCandidate(graph, s2, '2026-01-02', first.correctionIds[0], { closeAtoms: '101' }, {
      knowledgeMode: 'PROVIDER_REVISION_HISTORY_ATTESTED',
      knowledgeTimeLowerBound: lateRevTs, knowledgeTimeUpperBound: lateRevTs,
      sourceTimestampEvidenceId: buildEvidence(store, graph, s2, 0, lateRevTs, 'rev-b'),
      providerRevisionId: 'rev-b',
    }),
  ]);
  const lateVisible = resolveMarketDataAsOf(resolveArgs(store, graph, second.registryId, '2026-01-04T12:00:00.000Z'));
  assert.equal(lateVisible.resolvedBarEntries.length, 1);
  assert.equal(lateVisible.resolvedBarEntries[0].resolvedCorrectionTipId, second.correctionIds[0]);
  assert.equal(observationValues(store, lateVisible.resolvedBarEntries[0].resolvedObservationId).closeAtoms, '101');
  assert.equal(lateVisible.temporalCapability, 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED');
}));

test('L3-I4 revision chain, withdrawal, restoration: dispositions and exact contributor closure', () => withStore((store) => {
  const graph = setupI4(store);
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const t1 = '2026-01-06T22:00:00.000Z';
  const t2 = '2026-01-07T00:00:00.000Z';
  const t3 = '2026-01-08T00:00:00.000Z';
  const t4 = '2026-01-09T00:00:00.000Z';
  const t5 = '2026-01-10T22:00:00.000Z';
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], t1, 'i4-chain-1');
  const i1 = appendIngestion(store, graph, rootId, s1, [candidateBase(graph, s1, '2026-01-02')]);
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101' })], t2, 'i4-chain-2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', i1.correctionIds[0], { closeAtoms: '101' })]);
  const s3 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { highAtoms: '102', closeAtoms: '102' })], t3, 'i4-chain-3');
  const i3 = appendIngestion(store, graph, i2.registryId, s3,
    [revisionCandidate(graph, s3, '2026-01-02', i2.correctionIds[0], { highAtoms: '102', closeAtoms: '102' })]);
  const s4 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], t4, 'i4-chain-4');
  const i4 = appendIngestion(store, graph, i3.registryId, s4,
    [withdrawalCandidate(graph, s4, '2026-01-02', i3.correctionIds[0])]);
  const revision2ObservationId = i3.observationIds[0];
  const s5 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], t5, 'i4-chain-5');
  const i5 = appendIngestion(store, graph, i4.registryId, s5,
    [restorationCandidate(graph, s5, '2026-01-02', i4.correctionIds[0], revision2ObservationId)]);
  const finalRegistryId = i5.registryId;

  const atInitial = resolveMarketDataAsOf(resolveArgs(store, graph, finalRegistryId, t1));
  assert.equal(atInitial.resolvedBarEntries[0].disposition, 'PRESENT');
  assert.equal(atInitial.resolvedBarEntries[0].resolvedObservationId, i1.observationIds[0]);

  const atRevision = resolveMarketDataAsOf(resolveArgs(store, graph, finalRegistryId, t2));
  assert.equal(atRevision.resolvedBarEntries[0].resolvedCorrectionTipId, i2.correctionIds[0]);
  // Full contributor closure at t2: tip, its visible ancestor, both observations,
  // both ingestions, their acquisitions and artifacts — nothing else.
  assert.deepEqual(atRevision.contributingCorrectionIds, [i1.correctionIds[0], i2.correctionIds[0]].sort());
  assert.deepEqual(atRevision.contributingObservationIds, [i1.observationIds[0], i2.observationIds[0]].sort());
  assert.deepEqual(atRevision.contributingIngestionManifestIds,
    [i1.ingestionManifestId, i2.ingestionManifestId].sort());
  assert.deepEqual(atRevision.contributingAcquisitionRecordIds,
    [s1.acquisition.acquisitionRecordId, s2.acquisition.acquisitionRecordId].sort());
  assert.deepEqual(atRevision.contributingSourceArtifactIds,
    [s1.artifact.sourceArtifactId, s2.artifact.sourceArtifactId].sort());

  const atRevision2 = resolveMarketDataAsOf(resolveArgs(store, graph, finalRegistryId, t3));
  assert.equal(atRevision2.resolvedBarEntries[0].resolvedCorrectionTipId, i3.correctionIds[0]);
  assert.equal(observationValues(store, atRevision2.resolvedBarEntries[0].resolvedObservationId).closeAtoms, '102');

  const atWithdrawal = resolveMarketDataAsOf(resolveArgs(store, graph, finalRegistryId, t4));
  assert.equal(atWithdrawal.resolvedBarEntries[0].disposition, 'WITHDRAWN');
  assert.equal(atWithdrawal.resolvedBarEntries[0].resolvedObservationId, null);
  assert.equal(atWithdrawal.resolvedBarEntries[0].resolvedCorrectionTipId, i4.correctionIds[0]);
  // Superseded observations stay contributing chain evidence.
  assert.deepEqual(atWithdrawal.contributingObservationIds,
    [i1.observationIds[0], i2.observationIds[0], i3.observationIds[0]].sort());

  const atRestoration = resolveMarketDataAsOf(resolveArgs(store, graph, finalRegistryId, t5));
  assert.equal(atRestoration.resolvedBarEntries[0].disposition, 'PRESENT');
  assert.equal(atRestoration.resolvedBarEntries[0].resolvedObservationId, revision2ObservationId);
  assert.equal(atRestoration.resolvedBarEntries[0].resolvedCorrectionTipId, i5.correctionIds[0]);
  assert.deepEqual(atRestoration.contributingIngestionManifestIds, [
    i1.ingestionManifestId, i2.ingestionManifestId, i3.ingestionManifestId,
    i4.ingestionManifestId, i5.ingestionManifestId,
  ].sort());
}));

test('L3-I4 session-date move resolves MOVED_TO_OTHER_SESSION plus PRESENT with both link members contributing', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-06T22:00:00.000Z', 'i4-move-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-05')], '2026-01-07T00:00:00.000Z', 'i4-move-2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [sessionMoveCandidate(graph, s2, '2026-01-02', '2026-01-05', i1.correctionIds[0])]);
  const withdrawal = correctionOfKind(store, i2.correctionIds, 'SESSION_DATE_WITHDRAWAL');
  const replacement = correctionOfKind(store, i2.correctionIds, 'SESSION_DATE_REPLACEMENT');

  const resolved = resolveMarketDataAsOf(resolveArgs(store, graph, i2.registryId, '2026-01-07T00:00:00.000Z'));
  assert.deepEqual(resolved.resolvedBarEntries.map((entry) => [entry.sessionDate, entry.disposition]), [
    ['2026-01-02', 'MOVED_TO_OTHER_SESSION'],
    ['2026-01-05', 'PRESENT'],
  ]);
  assert.equal(resolved.resolvedBarEntries[0].resolvedObservationId, null);
  assert.equal(resolved.resolvedBarEntries[0].resolvedCorrectionTipId, withdrawal.correctionId);
  assert.equal(resolved.resolvedBarEntries[1].resolvedCorrectionTipId, replacement.correctionId);
  assert.equal(resolved.resolvedBarEntries[1].resolvedObservationId, i2.observationIds[0]);
  for (const member of [withdrawal.correctionId, replacement.correctionId, i1.correctionIds[0]]) {
    assert.ok(resolved.contributingCorrectionIds.includes(member));
  }
  const built = buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: i2.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-07T00:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  verifyMarketDataResolvedSeries({
    store, resolvedSeriesManifestId: built.resolvedSeriesManifestId,
    ingestionRegistryManifestId: i2.registryId,
  });
}));

test('L3-I4 a visible child with an invisible parent fails closed with MARKET_DATA_PARENT_INVISIBLE', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-20T00:00:00.000Z', 'i4-pinv-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101' })], '2026-01-12T00:00:00.000Z', 'i4-pinv-2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', i1.correctionIds[0], { closeAtoms: '101' })]);
  expectCode(() => resolveMarketDataAsOf(resolveArgs(store, graph, i2.registryId, '2026-01-15T00:00:00.000Z')),
    'MARKET_DATA_PARENT_INVISIBLE');
  // Once the parent is visible too, the chain resolves normally.
  const healed = resolveMarketDataAsOf(resolveArgs(store, graph, i2.registryId, '2026-01-21T00:00:00.000Z'));
  assert.equal(healed.resolvedBarEntries[0].resolvedCorrectionTipId, i2.correctionIds[0]);
}));

test('L3-I4 authoritative branch and concurrent roots (forged base views) fail closed', () => withStore((store) => {
  const graph = setupI4(store);
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const tA = '2026-01-06T22:00:00.000Z';
  const tB = '2026-01-07T00:00:00.000Z';
  const tC = '2026-01-08T00:00:00.000Z';
  const tD = '2026-01-09T00:00:00.000Z';
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02'), atomsRow(graph, '2026-01-05')], tA, 'i4-fraud-1');
  const i1 = appendIngestion(store, graph, rootId, s1, [
    candidateBase(graph, s1, '2026-01-02', { sourceRowIndex: 0 }),
    candidateBase(graph, s1, '2026-01-05', { sourceRowIndex: 1 }),
  ]);
  const root02 = correctionsOf(store, i1.correctionIds)
    .find((item) => item.correction.barIdentityId === graph.barBySession.get('2026-01-02'));
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101' })], tB, 'i4-fraud-2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', root02.correctionId, { closeAtoms: '101' })]);

  // Fraud A: a second INITIAL_ROOT for the occupied 01-05 bar via a lying base view.
  const s3 = makeSource(store, graph, [atomsRow(graph, '2026-01-05', { closeAtoms: '101' })], tC, 'i4-fraud-3');
  const i3 = appendIngestion(store, graph, i2.registryId, s3,
    [candidateBase(graph, s3, '2026-01-05', { replacementValues: { ...VALUES, closeAtoms: '101' } })], {
      baseView: {
        baseIngestionRegistryManifestId: i2.registryId,
        expectedParentIngestionManifestId: i2.ingestionManifestId,
        terminalCorrectionIds: [], visibleCorrectionIds: [], occupiedBarIdentityIds: [],
        publishedBarIdentityIds: [graph.barBySession.get('2026-01-05')],
        duplicateCandidateIds: [],
      },
    });

  // Fraud B: a second visible child of the 01-02 root via a lying base view.
  const s4 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '102', highAtoms: '102' })], tD, 'i4-fraud-4');
  const i4 = appendIngestion(store, graph, i3.registryId, s4,
    [revisionCandidate(graph, s4, '2026-01-02', root02.correctionId, { closeAtoms: '102', highAtoms: '102' })], {
      baseView: {
        baseIngestionRegistryManifestId: i3.registryId,
        expectedParentIngestionManifestId: i3.ingestionManifestId,
        terminalCorrectionIds: [root02.correctionId],
        visibleCorrectionIds: [root02.correctionId],
        occupiedBarIdentityIds: [graph.barBySession.get('2026-01-02')],
        publishedBarIdentityIds: [graph.barBySession.get('2026-01-02')],
        duplicateCandidateIds: [],
      },
    });

  // At tC only the concurrent roots are visible → conflict.
  expectCode(() => resolveMarketDataAsOf(resolveArgs(store, graph, i4.registryId, tC)),
    'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  // At tD the branch is visible as well → branch fails first.
  expectCode(() => resolveMarketDataAsOf(resolveArgs(store, graph, i4.registryId, tD)),
    'MARKET_DATA_BAR_REVISION_BRANCH');
  // Before either fraud becomes visible, resolution stays healthy.
  const healthy = resolveMarketDataAsOf(resolveArgs(store, graph, i4.registryId, tB));
  assert.equal(healthy.resolvedBarEntries.length, 2);
}));

test('L3-I4 foreign lineages stay isolated; orphan CAS objects never contribute', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-06T22:00:00.000Z', 'i4-iso-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  // Second lineage, same registry.
  const lineageB = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER_B', instrumentIdentityId: graph.instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis: 'RAW',
      sourceDatasetKind: 'EOD_OHLCV',
    },
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const graphB = { ...graph, lineage: lineageB };
  const sB = makeSource(store, graphB, [atomsRow(graphB, '2026-01-05', { closeAtoms: '101' })], '2026-01-06T23:00:00.000Z', 'i4-iso-b');
  const iB = appendIngestion(store, graphB, i1.registryId, sB,
    [candidateBase(graphB, sB, '2026-01-05', { replacementValues: { ...VALUES, closeAtoms: '101' } })]);

  const before = buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: iB.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-07T00:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const manifest = readResolved(store, before.resolvedSeriesManifestId);
  assert.equal(manifest.resolvedBarEntries.length, 1);
  assert.equal(manifest.resolvedBarEntries[0].sessionDate, '2026-01-02');
  for (const foreignId of [...iB.correctionIds, ...iB.observationIds, iB.ingestionManifestId]) {
    assert.ok(!manifest.contributingCorrectionIds.includes(foreignId));
    assert.ok(!manifest.contributingObservationIds.includes(foreignId));
    assert.ok(!manifest.contributingIngestionManifestIds.includes(foreignId));
  }
  const resolvedB = resolveMarketDataAsOf({
    store, ingestionRegistryManifestId: iB.registryId,
    ingestionLineageId: lineageB.ingestionLineageId,
    knowledgeCutoff: '2026-01-07T00:00:00.000Z',
  });
  assert.equal(resolvedB.resolvedBarEntries.length, 1);
  assert.equal(resolvedB.resolvedBarEntries[0].sessionDate, '2026-01-05');

  // Orphan (never authorized) correction and observation for the same bar are ignored:
  // rejected or orphan CAS objects never gain authority, so the manifest ID is unchanged.
  const orphanObservation = { ...Revision.verifyMarketDataBarObservation({
    store, observationId: i1.observationIds[0],
  }).observation };
  orphanObservation.values = { ...orphanObservation.values, closeAtoms: '999', highAtoms: '999' };
  const orphanObservationId = store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: Revision.MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
    value: orphanObservation,
  }).objectId;
  const orphanCorrection = { ...Revision.verifyMarketDataBarCorrection({
    store, correctionId: i1.correctionIds[0],
  }).correction };
  orphanCorrection.correctionKind = 'VALUE_REVISION';
  orphanCorrection.parentCorrectionId = i1.correctionIds[0];
  orphanCorrection.observationId = orphanObservationId;
  store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
    value: orphanCorrection,
  });
  const after = buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: iB.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-07T00:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  assert.equal(after.resolvedSeriesManifestId, before.resolvedSeriesManifestId);
  const kept = readResolved(store, after.resolvedSeriesManifestId);
  assert.equal(observationValues(store, kept.resolvedBarEntries[0].resolvedObservationId).closeAtoms, '100');
}));

test('L3-I4 non-interference and contributive late revision: prefix and manifest identity', () => withStore((store) => {
  const graph = setupI4(store);
  const cutoff = '2026-01-07T00:00:00.000Z';
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-06T22:00:00.000Z', 'i4-prefix-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101' })], cutoff, 'i4-prefix-2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', i1.correctionIds[0], { closeAtoms: '101' })]);

  const buildArgs = {
    store, ingestionLineageId: graph.lineage.ingestionLineageId, knowledgeCutoff: cutoff,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  };
  const m1 = buildMarketDataResolvedSeriesManifest({ ...buildArgs, ingestionRegistryManifestId: i2.registryId });
  assert.equal(readResolved(store, m1.resolvedSeriesManifestId).contributingRegistryPrefixId, i2.registryId);

  // Append a future, entirely invisible ingestion: same prefix, same manifest bytes, same ID.
  const s3 = makeSource(store, graph, [atomsRow(graph, '2026-01-05')], '2026-02-01T00:00:00.000Z', 'i4-prefix-3');
  const i3 = appendIngestion(store, graph, i2.registryId, s3, [candidateBase(graph, s3, '2026-01-05')]);
  const m2 = buildMarketDataResolvedSeriesManifest({ ...buildArgs, ingestionRegistryManifestId: i3.registryId });
  assert.equal(m2.resolvedSeriesManifestId, m1.resolvedSeriesManifestId);
  assert.equal(readResolved(store, m2.resolvedSeriesManifestId).contributingRegistryPrefixId, i2.registryId);
  const resolvedUnderFuture = resolveMarketDataAsOf(resolveArgs(store, graph, i3.registryId, cutoff));
  assert.ok(!resolvedUnderFuture.contributingIngestionManifestIds.includes(i3.ingestionManifestId));
  assert.ok(!resolvedUnderFuture.contributingAcquisitionRecordIds.includes(s3.acquisition.acquisitionRecordId));
  assert.ok(!resolvedUnderFuture.contributingSourceArtifactIds.includes(s3.artifact.sourceArtifactId));

  // A late acquisition carrying attested pre-cutoff revision history becomes contributive:
  // the prefix advances and the manifest ID changes.
  const lateRevTs = '2026-01-06T23:00:00.000Z';
  const s4 = makeSource(store, graph,
    [atomsRow(graph, '2026-01-02', { closeAtoms: '102', highAtoms: '102', providerPublicationTime: lateRevTs, providerRevisionId: 'rev-l' })],
    '2026-02-02T00:00:00.000Z', 'i4-prefix-4');
  const i4 = appendIngestion(store, graph, i3.registryId, s4, [
    revisionCandidate(graph, s4, '2026-01-02', i2.correctionIds[0], { closeAtoms: '102', highAtoms: '102' }, {
      knowledgeMode: 'PROVIDER_REVISION_HISTORY_ATTESTED',
      knowledgeTimeLowerBound: lateRevTs, knowledgeTimeUpperBound: lateRevTs,
      sourceTimestampEvidenceId: buildEvidence(store, graph, s4, 0, lateRevTs, 'rev-l'),
      providerRevisionId: 'rev-l',
    }),
  ]);
  const m3 = buildMarketDataResolvedSeriesManifest({ ...buildArgs, ingestionRegistryManifestId: i4.registryId });
  assert.notEqual(m3.resolvedSeriesManifestId, m1.resolvedSeriesManifestId);
  assert.equal(readResolved(store, m3.resolvedSeriesManifestId).contributingRegistryPrefixId, i4.registryId);
  // The old manifest no longer replays identically under the advanced pin:
  // it omits the newly contributive ingestion and fails closed.
  expectCode(() => verifyMarketDataResolvedSeries({
    store, resolvedSeriesManifestId: m1.resolvedSeriesManifestId,
    ingestionRegistryManifestId: i4.registryId,
  }), 'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE');
}));

test('L3-I4 call pins: descendant accepted, sibling registry branch refused', () => withStore((store) => {
  const graph = setupI4(store);
  const cutoff = '2026-01-07T00:00:00.000Z';
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-06T22:00:00.000Z', 'i4-pin-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101' })], cutoff, 'i4-pin-2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', i1.correctionIds[0], { closeAtoms: '101' })]);
  const built = buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: i2.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: cutoff,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  // Descendant call pin (future non-contributing append) verifies cleanly.
  const s3 = makeSource(store, graph, [atomsRow(graph, '2026-01-05')], '2026-02-01T00:00:00.000Z', 'i4-pin-3');
  const i3 = appendIngestion(store, graph, i2.registryId, s3, [candidateBase(graph, s3, '2026-01-05')]);
  verifyMarketDataResolvedSeries({
    store, resolvedSeriesManifestId: built.resolvedSeriesManifestId,
    ingestionRegistryManifestId: i3.registryId,
  });
  // A sibling branch grown from i1's registry does not descend from the prefix.
  const s2b = makeSource(store, graph, [atomsRow(graph, '2026-01-06')], '2026-01-07T01:00:00.000Z', 'i4-pin-2b');
  const i2b = appendIngestion(store, graph, i1.registryId, s2b, [candidateBase(graph, s2b, '2026-01-06')]);
  expectCode(() => verifyMarketDataResolvedSeries({
    store, resolvedSeriesManifestId: built.resolvedSeriesManifestId,
    ingestionRegistryManifestId: i2b.registryId,
  }), 'MARKET_DATA_INGESTION_STALE_BASE');
}));

test('L3-I4 identity/calendar pins advance with contributors only; calendar branch refused', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-06T22:00:00.000Z', 'i4-adv-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);

  const identityV2 = buildInstrumentIdentityRegistry({
    store, authorityPolicyId: graph.instrumentAuthority.authorityPolicyId,
    identityManifestIds: [graph.instrumentManifest.identityManifestId],
    supersedesRegistryManifestId: graph.instrumentRegistry.registryManifestId,
  });
  const extraCore = Calendar.buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
      venueId: 'XNAS', timeZoneRulesetId: graph.ruleset.timeZoneRulesetId,
      coverageFromDate: '2026-01-06', coverageToDateExclusive: '2026-01-07',
      sessions: [{
        sessionDate: '2026-01-06', sessionKind: 'REGULAR_SESSION',
        openUtc: '2026-01-06T14:30:00.000Z', closeUtc: '2026-01-06T21:00:00.000Z',
        marketValidTime: '2026-01-06T21:00:00.000Z',
      }],
    },
  });
  const calendarV2a = Calendar.buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [graph.calendar.calendarCoreId].sort(),
      supersedesCalendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    },
  });
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', {
    closeAtoms: '101',
    identityRegistryManifestId: identityV2.registryManifestId,
    calendarRegistryManifestId: calendarV2a.calendarRegistryManifestId,
  })], '2026-01-07T00:00:00.000Z', 'i4-adv-2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', i1.correctionIds[0], { closeAtoms: '101' }, {
      calendarRegistryManifestId: calendarV2a.calendarRegistryManifestId,
    })], {
      pins: {
        identityRegistryManifestId: identityV2.registryManifestId,
        calendarRegistryManifestId: calendarV2a.calendarRegistryManifestId,
        corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      },
    });
  const resolved = resolveMarketDataAsOf(resolveArgs(store, graph, i2.registryId, '2026-01-07T00:00:00.000Z'));
  assert.equal(resolved.identityRegistryManifestId, identityV2.registryManifestId);
  assert.equal(resolved.calendarRegistryManifestId, calendarV2a.calendarRegistryManifestId);

  // A future, non-contributing ingestion carrying newer pins never moves the stored pins.
  const identityV3 = buildInstrumentIdentityRegistry({
    store, authorityPolicyId: graph.instrumentAuthority.authorityPolicyId,
    identityManifestIds: [graph.instrumentManifest.identityManifestId],
    supersedesRegistryManifestId: identityV2.registryManifestId,
  });
  const s3 = makeSource(store, graph, [atomsRow(graph, '2026-01-05', {
    identityRegistryManifestId: identityV3.registryManifestId,
    calendarRegistryManifestId: calendarV2a.calendarRegistryManifestId,
  })], '2026-02-01T00:00:00.000Z', 'i4-adv-3');
  const i3 = appendIngestion(store, graph, i2.registryId, s3,
    [candidateBase(graph, s3, '2026-01-05', {
      calendarRegistryManifestId: calendarV2a.calendarRegistryManifestId,
    })], {
      pins: {
        identityRegistryManifestId: identityV3.registryManifestId,
        calendarRegistryManifestId: calendarV2a.calendarRegistryManifestId,
        corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      },
    });
  const unchanged = resolveMarketDataAsOf(resolveArgs(store, graph, i3.registryId, '2026-01-07T00:00:00.000Z'));
  assert.equal(unchanged.identityRegistryManifestId, identityV2.registryManifestId);
  assert.equal(unchanged.calendarRegistryManifestId, calendarV2a.calendarRegistryManifestId);

  // A second calendar branch (same authority, divergent chains) among contributors is refused.
  const calendarV2b = Calendar.buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [graph.calendar.calendarCoreId, extraCore.calendarCoreId].sort(),
      supersedesCalendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    },
  });
  const s4 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', {
    closeAtoms: '102', highAtoms: '102',
    identityRegistryManifestId: identityV2.registryManifestId,
    calendarRegistryManifestId: calendarV2b.calendarRegistryManifestId,
  })], '2026-01-08T00:00:00.000Z', 'i4-adv-4');
  const i4 = appendIngestion(store, graph, i3.registryId, s4,
    [revisionCandidate(graph, s4, '2026-01-02', i2.correctionIds[0], { closeAtoms: '102', highAtoms: '102' }, {
      calendarRegistryManifestId: calendarV2b.calendarRegistryManifestId,
    })], {
      pins: {
        identityRegistryManifestId: identityV2.registryManifestId,
        calendarRegistryManifestId: calendarV2b.calendarRegistryManifestId,
        corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      },
    });
  expectCode(() => resolveMarketDataAsOf(resolveArgs(store, graph, i4.registryId, '2026-01-08T00:00:00.000Z')),
    'MARKET_DATA_CALENDAR_BRANCH');
}));

test('L3-I4 stored calendar pin must cover every resolved session', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-06T22:00:00.000Z', 'i4-cov-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  const built = buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: i1.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-07T00:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  // A valid root calendar registry that only covers 2026-01-05 cannot back a 2026-01-02 series.
  const policyB = Calendar.buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS', timeZoneRulesetId: graph.ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'synthetic-i4-coverage/1',
    },
  });
  const coreB = Calendar.buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: policyB.calendarAuthorityPolicyId,
      venueId: 'XNAS', timeZoneRulesetId: graph.ruleset.timeZoneRulesetId,
      coverageFromDate: '2026-01-05', coverageToDateExclusive: '2026-01-06',
      sessions: [{
        sessionDate: '2026-01-05', sessionKind: 'REGULAR_SESSION',
        openUtc: '2026-01-05T14:30:00.000Z', closeUtc: '2026-01-05T21:00:00.000Z',
        marketValidTime: '2026-01-05T21:00:00.000Z',
      }],
    },
  });
  const registryB = Calendar.buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: policyB.calendarAuthorityPolicyId,
      calendarCoreIds: [coreB.calendarCoreId], supersedesCalendarRegistryManifestId: null,
    },
  });
  const forged = forgeResolved(store, {
    ...readResolved(store, built.resolvedSeriesManifestId),
    calendarRegistryManifestId: registryB.calendarRegistryManifestId,
  });
  expectCode(() => verifyMarketDataResolvedSeriesManifest({ store, resolvedSeriesManifestId: forged }),
    'MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE');
}));

test('L3-I4 corporate-action pin: contributor chain honored, foreign chain and wrong type refused', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], '2026-01-06T22:00:00.000Z', 'i4-l2c-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1,
    [candidateBase(graph, s1, '2026-01-02')]);
  const args = {
    store, ingestionRegistryManifestId: i1.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-07T00:00:00.000Z',
  };
  const withContributorPin = buildMarketDataResolvedSeriesManifest({
    ...args, corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  // A descending L2C registry is coherent with the contributors and closes provenance.
  const corporateV2 = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(graph.corporatePolicies, graph.instrumentRegistry),
    supersedesRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const withDescendantPin = buildMarketDataResolvedSeriesManifest({
    ...args, corporateActionRegistryManifestId: corporateV2.registryManifestId,
  });
  assert.notEqual(withDescendantPin.resolvedSeriesManifestId, withContributorPin.resolvedSeriesManifestId);
  assert.equal(readResolved(store, withDescendantPin.resolvedSeriesManifestId).corporateActionRegistryManifestId,
    corporateV2.registryManifestId);
  // L3-I4 never applies L2C adjustments: the resolved values stay raw source values.
  const entries = readResolved(store, withDescendantPin.resolvedSeriesManifestId).resolvedBarEntries;
  assert.equal(observationValues(store, entries[0].resolvedObservationId).closeAtoms, '100');

  // A foreign authority chain is refused.
  const foreignPolicies = buildCorporateActionPolicies({
    store,
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i4-foreign-actions/1', identityNamespaceVersion: 'L3-I4-F/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I4-F/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I4-F/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I4-F/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I4-F/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I4-F/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const foreignRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(foreignPolicies, graph.instrumentRegistry),
  });
  expectCode(() => buildMarketDataResolvedSeriesManifest({
    ...args, corporateActionRegistryManifestId: foreignRegistry.registryManifestId,
  }), 'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH');
  // A non-L2C object as pin is refused fail-closed.
  expectCode(() => buildMarketDataResolvedSeriesManifest({
    ...args, corporateActionRegistryManifestId: i1.ingestionManifestId,
  }), 'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH');
}));

test('L3-I4 forged manifests fail closed with dedicated codes', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02'), atomsRow(graph, '2026-01-05')], '2026-01-06T22:00:00.000Z', 'i4-forge-1');
  const i1 = appendIngestion(store, graph, graph.rootRegistry.ingestionRegistryManifestId, s1, [
    candidateBase(graph, s1, '2026-01-02', { sourceRowIndex: 0 }),
    candidateBase(graph, s1, '2026-01-05', { sourceRowIndex: 1 }),
  ]);
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101' })], '2026-01-07T00:00:00.000Z', 'i4-forge-2');
  const root02 = correctionsOf(store, i1.correctionIds)
    .find((item) => item.correction.barIdentityId === graph.barBySession.get('2026-01-02'));
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', root02.correctionId, { closeAtoms: '101' })]);
  const built = buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: i2.registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-07T00:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const base = readResolved(store, built.resolvedSeriesManifestId);
  const FOREIGN = `sha256:${'f'.repeat(64)}`;

  // Shape-level frauds.
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1({ ...base, alien: true }),
    'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1({
    ...base, schemaVersion: 'MarketDataResolvedSeriesManifest/2',
  }), 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1({
    ...base, resolvedBarEntries: [...base.resolvedBarEntries].reverse(),
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1({
    ...base, resolvedBarEntries: [base.resolvedBarEntries[0], base.resolvedBarEntries[0]],
  }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1({
    ...base,
    resolvedBarEntries: [{ ...base.resolvedBarEntries[0], resolvedObservationId: null }, base.resolvedBarEntries[1]],
  }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1({
    ...base, resolvedBarEntries: [],
  }), 'MARKET_DATA_INPUT_INVALID');

  // Stored-manifest frauds against exact recomputation.
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: forgeResolved(store, {
      ...base, contributingCorrectionIds: base.contributingCorrectionIds.slice(0, 1),
    }),
  }), 'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE');
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: forgeResolved(store, {
      ...base, contributingObservationIds: [...base.contributingObservationIds, FOREIGN].sort(),
    }),
  }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: forgeResolved(store, {
      ...base, contributingCorrectionIds: [...base.contributingCorrectionIds, FOREIGN].sort(),
    }),
  }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: forgeResolved(store, {
      ...base, temporalCapability: 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED',
    }),
  }), 'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH');
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: forgeResolved(store, {
      ...base, priceBasis: 'SPLIT_ADJUSTED',
    }),
  }), 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH');
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: forgeResolved(store, {
      ...base, corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
    }),
  }), 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH');
  // Recomputation mismatch: the tip observation is silently replaced by the superseded one.
  const forgedEntries = base.resolvedBarEntries.map((entry) => (
    entry.sessionDate === '2026-01-02'
      ? { ...entry, resolvedObservationId: i1.observationIds[0] }
      : entry
  ));
  expectCode(() => verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: forgeResolved(store, { ...base, resolvedBarEntries: forgedEntries }),
  }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
}));

test('L3-I4 official runIngestion output resolves and round-trips under its returned registry pin', () => withStore((store) => {
  const graph = setupI4(store);
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02'), atomsRow(graph, '2026-01-05')], '2026-01-06T22:00:00.000Z', 'i4-run-1');
  const run = runIngestion({
    store,
    baseIngestionRegistryManifestId: graph.rootRegistry.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: null,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: s1.artifact.sourceArtifactId,
    sourceAttestationId: s1.attestation.sourceAttestationId,
    acquisitionRecordId: s1.acquisition.acquisitionRecordId,
  });
  assert.equal(run.status, 'PUBLISHED');
  const resolved = resolveMarketDataAsOf({
    store, ingestionRegistryManifestId: run.ingestionRegistryManifestId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-06T22:00:00.000Z',
  });
  assert.deepEqual(resolved.resolvedBarEntries.map((entry) => entry.sessionDate), ['2026-01-02', '2026-01-05']);
  assert.ok(resolved.resolvedBarEntries.every((entry) => entry.disposition === 'PRESENT'));
  const built = buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: run.ingestionRegistryManifestId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    knowledgeCutoff: '2026-01-06T22:00:00.000Z',
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const verified = verifyMarketDataResolvedSeries({
    store, resolvedSeriesManifestId: built.resolvedSeriesManifestId,
    ingestionRegistryManifestId: run.ingestionRegistryManifestId,
  });
  assert.equal(verified.resolvedSeriesManifest.contributingIngestionManifestIds.length, 1);
  assert.equal(verified.resolvedSeriesManifest.contributingIngestionManifestIds[0], run.ingestionManifestId);
}));
