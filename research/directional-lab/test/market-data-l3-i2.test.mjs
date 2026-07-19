import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS, normalizeCanonicalValue } from '../src/canonical/canonicalSchemaRegistryV1.mjs';
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
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { addDays } from '../src/time/civilDate.mjs';

const I2_SCHEMAS = [
  'MarketDataNormalizedCandidate/1',
  'MarketDataCandidateSetCore/1',
  'MarketDataValidationReport/1',
  'MarketDataBarObservationCore/1',
  'MarketDataBarCorrectionCore/1',
  'MarketDataAcceptedCandidatePublicationManifest/1',
  'NormalizedMarketDataDeltaChunk/1',
  'NormalizedMarketDataDeltaAssemblyManifest/1',
];

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

function setupI2(store) {
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l3-i2-synthetic-instruments/1',
    identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: '4'.repeat(64), instrumentKind: 'EQUITY',
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
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i2-synthetic-actions/1', identityNamespaceVersion: 'L3-I2/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I2/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I2/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I2/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I2/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I2/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l3-i2',
      validFromDate: '2026-01-02', validToDateExclusive: '2026-01-11',
      civilDateBounds: Array.from({ length: 9 }, (_, index) => {
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
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'synthetic-l3-i2/1',
    },
  });
  const sessions = [
    { sessionDate: '2026-01-02', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-02T14:30:00.000Z', closeUtc: '2026-01-02T21:00:00.000Z', marketValidTime: '2026-01-02T21:00:00.000Z' },
    { sessionDate: '2026-01-05', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-05T14:30:00.000Z', closeUtc: '2026-01-05T21:00:00.000Z', marketValidTime: '2026-01-05T21:00:00.000Z' },
    { sessionDate: '2026-01-06', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-06T14:30:00.000Z', closeUtc: '2026-01-06T21:00:00.000Z', marketValidTime: '2026-01-06T21:00:00.000Z' },
  ];
  const calendar = Calendar.buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
      coverageFromDate: '2026-01-02', coverageToDateExclusive: '2026-01-11', sessions,
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
      allowedPriceBases: ['RAW'], allowedSourceDatasetKinds: ['EOD_OHLCV'],
      allowedPayloadFormats: ['CSV_UTF8'], maxArtifactBytes: 100000,
      knowledgeModes: ['CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED', 'PROVIDER_REVISION_HISTORY_ATTESTED'],
      providerPublicationTimeField: 'providerPublicationTime', providerRevisionIdField: 'providerRevisionId',
      unknownFieldPolicy: 'REJECT', duplicateIdenticalRowPolicy: 'ACCEPT_IDENTICAL',
      volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
    },
  });
  const context = {
    ingestionPolicyId: ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: corporateRegistry.registryManifestId,
  };
  const lineage = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER', instrumentIdentityId: instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis: 'RAW',
      sourceDatasetKind: 'EOD_OHLCV',
    },
    ...context,
  });
  const bytes = Buffer.from([
    'date,providerPublicationTime,providerRevisionId,open,high,low,close,volume',
    '2026-01-02,2026-01-02T21:01:00.000Z,rev-1,1000,1200,900,1100,100',
    '2026-01-05,2026-01-05T21:01:00.000Z,rev-2,1100,1300,1000,1200,',
    '2026-01-06,2026-01-06T21:01:00.000Z,rev-3,1200,1400,1100,1300,300',
    '',
  ].join('\n'));
  const source = store.putSourceBytes(bytes);
  const artifact = Source.buildMarketDataSourceArtifact({
    store, ingestionPolicyId: ingestionPolicy.ingestionPolicyId,
    artifact: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
      ingestionLineageId: lineage.ingestionLineageId, payloadFormat: 'CSV_UTF8',
      mediaType: 'text/csv; charset=utf-8', embeddedBytesObjectId: source.objectId,
      payloadDigest: source.objectId, payloadByteLength: bytes.length,
    },
  });
  const attestation = Source.buildMarketDataSourceAttestation({
    store,
    attestation: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
      ingestionLineageId: lineage.ingestionLineageId, attestationMode: 'EMBEDDED_ARTIFACT',
      embeddedArtifactId: artifact.sourceArtifactId, payloadDigest: null,
      payloadByteLength: null, payloadFormat: null, providerId: null,
    },
  });
  const acquisition = Source.buildMarketDataAcquisitionRecord({
    store,
    record: {
      schemaVersion: Source.MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
      ingestionLineageId: lineage.ingestionLineageId,
      acquisitionTimeUtc: '2026-01-07T00:00:00.000Z', providerId: 'SYNTHETIC_PROVIDER',
      logicalEndpointKind: 'EOD_OHLCV_DATASET', requestDatasetKind: 'EOD_OHLCV',
      executionIdentity: { runnerId: 'node-test', runId: 'l3-i2-run', environment: 'LOCAL_TEST' },
      sourceAttestationId: attestation.sourceAttestationId,
    },
  });
  const parseResult = Source.buildMarketDataParseResult({
    store, sourceArtifactId: artifact.sourceArtifactId,
    acquisitionRecordId: acquisition.acquisitionRecordId,
    ingestionPolicyId: ingestionPolicy.ingestionPolicyId,
  });
  const bars = sessions.map((session) => Bar.buildMarketDataBarIdentity({
    store,
    identity: {
      schemaVersion: Bar.MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
      instrumentIdentityId: instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS',
      sessionDate: session.sessionDate, sessionKind: 'DAILY_REGULAR_SESSION',
    },
  }));
  const evidence = Source.buildMarketDataSourceTemporalEvidence({
    store,
    evidence: {
      schemaVersion: Source.MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
      sourceArtifactId: artifact.sourceArtifactId, acquisitionRecordId: acquisition.acquisitionRecordId,
      parseResultId: parseResult.parseResultId, sourceRowIndex: 0, sourceCellPath: '/cells/1',
      sourceCellDigest: sha256Digest('2026-01-02T21:01:00.000Z'),
      rawTimestampValue: '2026-01-02T21:01:00.000Z', normalizedTimestampUtc: '2026-01-02T21:01:00.000Z',
      evidenceKind: 'PROVIDER_PUBLICATION_TIMESTAMP', providerRevisionId: null,
    },
  });
  const revisionEvidence = Source.buildMarketDataSourceTemporalEvidence({
    store,
    evidence: {
      schemaVersion: Source.MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
      sourceArtifactId: artifact.sourceArtifactId, acquisitionRecordId: acquisition.acquisitionRecordId,
      parseResultId: parseResult.parseResultId, sourceRowIndex: 0, sourceCellPath: '/cells/1',
      sourceCellDigest: sha256Digest('2026-01-02T21:01:00.000Z'),
      rawTimestampValue: '2026-01-02T21:01:00.000Z', normalizedTimestampUtc: '2026-01-02T21:01:00.000Z',
      evidenceKind: 'PROVIDER_REVISION_TIMESTAMP', providerRevisionId: 'rev-1',
    },
  });
  return { instrumentRegistry, corporateRegistry, calendarRegistry, ingestionPolicy, lineage,
    artifact, acquisition, parseResult, bars, evidence, revisionEvidence };
}

const VALUES = Object.freeze({
  openAtoms: '1000', highAtoms: '1200', lowAtoms: '900', closeAtoms: '1100',
  priceScale: 2, volumeAtoms: '100', volumeScale: 0, currency: 'USD', priceBasis: 'RAW',
});

function baseCandidate(graph, overrides = {}) {
  const row = graph.parseResult.parseResult.rows[0];
  return {
    schemaVersion: Candidate.MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
    candidateKind: 'BAR_INITIAL_VALUE', ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: graph.artifact.sourceArtifactId,
    acquisitionRecordId: graph.acquisition.acquisitionRecordId,
    parseResultId: graph.parseResult.parseResultId, sourceRowIndex: 0,
    sourceRowDigest: row.rowDigest, knowledgeMode: 'CAPTURE_TIME_ONLY',
    knowledgeTimeLowerBound: null, knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
    sourceTimestampEvidenceId: null, providerRevisionId: null,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    marketValidTime: '2026-01-02T21:00:00.000Z', barIdentityId: graph.bars[0].barIdentityId,
    targetCorrectionId: null, replacementValues: VALUES,
    ...overrides,
  };
}

function buildSet(store, graph, candidates) {
  const built = candidates.map((candidate) => Candidate.buildMarketDataNormalizedCandidate({ store, candidate }));
  const candidateIds = built.map((item) => item.candidateId).sort();
  return Candidate.buildMarketDataCandidateSet({
    store,
    candidateSet: {
      schemaVersion: Candidate.MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      sourceArtifactId: graph.artifact.sourceArtifactId,
      acquisitionRecordId: graph.acquisition.acquisitionRecordId,
      parseResultId: graph.parseResult.parseResultId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
      calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
      corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      candidateIds,
    },
  });
}

function baseView(graph, overrides = {}) {
  return {
    baseIngestionRegistryManifestId: graph.ingestionPolicy.ingestionPolicyId,
    expectedParentIngestionManifestId: null,
    terminalCorrectionIds: [], visibleCorrectionIds: [], occupiedBarIdentityIds: [],
    publishedBarIdentityIds: graph.bars.map((bar) => bar.barIdentityId).sort(),
    duplicateCandidateIds: [],
    ...overrides,
  };
}

function validateAndPublish(store, set, view) {
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId,
    baseView: view,
  });
  return { report, delta };
}

function putRevisionChild(store, graph, parentCorrectionId, overrides = {}) {
  return putBaseCorrection(store, graph, {
    correctionKind: 'VALUE_REVISION',
    parentCorrectionId,
    observationId: graph.ingestionPolicy.ingestionPolicyId,
    restoredObservationId: null,
    ...overrides,
  });
}

function putWithdrawalChild(store, graph, parentCorrectionId, overrides = {}) {
  return putBaseCorrection(store, graph, {
    correctionKind: 'WITHDRAWAL',
    parentCorrectionId,
    observationId: null,
    restoredObservationId: null,
    ...overrides,
  });
}

function putBaseCorrection(store, graph, overrides = {}) {
  const value = Revision.normalizeMarketDataBarCorrectionCoreV1({
    schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
    correctionKind: 'INITIAL_ROOT', ingestionLineageId: graph.lineage.ingestionLineageId,
    barIdentityId: graph.bars[0].barIdentityId, parentCorrectionId: null,
    observationId: graph.ingestionPolicy.ingestionPolicyId, restoredObservationId: null,
    sessionDateLink: null, sourceArtifactId: graph.artifact.sourceArtifactId,
    acquisitionRecordId: graph.acquisition.acquisitionRecordId,
    parseResultId: graph.parseResult.parseResultId, sourceRowIndex: 0,
    sourceRowDigest: graph.parseResult.parseResult.rows[0].rowDigest,
    knowledgeMode: 'CAPTURE_TIME_ONLY', knowledgeTimeLowerBound: null,
    knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
    sourceTimestampEvidenceId: null, providerRevisionId: null,
    ...overrides,
  });
  return store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
    value,
  }).objectId;
}

function decisionFor(store, graph, candidate, view) {
  const set = buildSet(store, graph, [candidate]);
  return Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  }).validationReport.decisions[0];
}

test('L3-I2 registers exactly the eight requested additive canonical schemas', () => {
  assert.equal(new Set(I2_SCHEMAS).size, 8);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.filter((schema) => I2_SCHEMAS.includes(schema)), I2_SCHEMAS);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size);
  for (const schemaVersion of I2_SCHEMAS) assert.equal(typeof normalizeCanonicalValue, 'function', schemaVersion);
  assert.throws(() => normalizeCanonicalValue('MarketDataIngestionManifest/1', {}), /CANONICAL_SCHEMA_UNKNOWN/);
});

test('L3-I2 replacementValues preserves integer atoms, nullable volume and closed basis', () => {
  assert.deepEqual(Candidate.normalizeMarketDataReplacementValuesV1(VALUES), VALUES);
  const nullable = Candidate.normalizeMarketDataReplacementValuesV1({ ...VALUES, volumeAtoms: null, volumeScale: null });
  assert.equal(nullable.volumeAtoms, null);
  assert.throws(() => Candidate.normalizeMarketDataReplacementValuesV1({ ...VALUES, highAtoms: '999' }),
    (error) => error.code === 'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
  assert.throws(() => Candidate.normalizeMarketDataReplacementValuesV1({ ...VALUES, priceScale: 19 }),
    (error) => error.code === 'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
  assert.throws(() => Candidate.normalizeMarketDataReplacementValuesV1({ ...VALUES, priceBasis: 'TOTAL_RETURN' }),
    (error) => error.code === 'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
});

test('L3-I2 initial candidate flows losslessly through validation, publication and ID-only delta recovery', () => withStore((store) => {
  const graph = setupI2(store);
  const set = buildSet(store, graph, [baseCandidate(graph)]);
  const { report, delta } = validateAndPublish(store, set, baseView(graph));
  assert.equal(report.validationReport.decisions[0].disposition, 'ACCEPTED');
  assert.equal(delta.status, 'PUBLISHED');
  const recovered = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
  });
  assert.equal(recovered.deltaAssemblyManifest.acceptedCandidateCount, 1);
  assert.equal(recovered.deltaAssemblyManifest.acceptedObservationIds.length, 1);
  assert.equal(recovered.deltaAssemblyManifest.acceptedCorrectionIds.length, 1);
  const observation = Revision.verifyMarketDataBarObservation({
    store, observationId: recovered.deltaAssemblyManifest.acceptedObservationIds[0],
  }).observation;
  assert.deepEqual(observation.values, VALUES);
  assert.equal(observation.knowledgeTimeUpperBound, '2026-01-07T00:00:00.000Z');
}));

test('L3-I2 publication-attested candidate keeps exact evidence and bounds under a multi-mode policy', () => withStore((store) => {
  const graph = setupI2(store);
  const candidate = baseCandidate(graph, {
    knowledgeMode: 'PROVIDER_PUBLICATION_TIME_ATTESTED',
    knowledgeTimeLowerBound: '2026-01-02T21:01:00.000Z',
    knowledgeTimeUpperBound: '2026-01-02T21:01:00.000Z',
    sourceTimestampEvidenceId: graph.evidence.sourceTemporalEvidenceId,
  });
  const built = Candidate.buildMarketDataNormalizedCandidate({ store, candidate });
  assert.equal(built.candidate.sourceTimestampEvidenceId, graph.evidence.sourceTemporalEvidenceId);
  const capture = Candidate.buildMarketDataNormalizedCandidate({ store, candidate: baseCandidate(graph) });
  assert.equal(capture.candidate.sourceTimestampEvidenceId, null);
  assert.equal(capture.candidate.knowledgeTimeLowerBound, null);
  const revision = Candidate.buildMarketDataNormalizedCandidate({ store, candidate: baseCandidate(graph, {
    knowledgeMode: 'PROVIDER_REVISION_HISTORY_ATTESTED',
    knowledgeTimeLowerBound: '2026-01-02T21:01:00.000Z',
    knowledgeTimeUpperBound: '2026-01-02T21:01:00.000Z',
    sourceTimestampEvidenceId: graph.revisionEvidence.sourceTemporalEvidenceId,
    providerRevisionId: 'rev-1',
  }) });
  assert.equal(revision.candidate.providerRevisionId, 'rev-1');
}));

test('L3-I2 revision, withdrawal, restoration and session-date pair form explicit immutable corrections', () => withStore((store) => {
  const graph = setupI2(store);
  const initialSet = buildSet(store, graph, [baseCandidate(graph)]);
  const initial = validateAndPublish(store, initialSet, baseView(graph));
  const initialAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: initial.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const initialCorrectionId = initialAssembly.acceptedCorrectionIds[0];

  const revisionSet = buildSet(store, graph, [baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: initialCorrectionId,
    replacementValues: { ...VALUES, closeAtoms: '1150' },
  })]);
  const revision = validateAndPublish(store, revisionSet, baseView(graph, {
    terminalCorrectionIds: [initialCorrectionId], visibleCorrectionIds: [initialCorrectionId],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const revisionAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: revision.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const revisionCorrectionId = revisionAssembly.acceptedCorrectionIds[0];
  assert.equal(Revision.verifyMarketDataBarCorrection({ store, correctionId: revisionCorrectionId }).correction.correctionKind, 'VALUE_REVISION');

  const withdrawalCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_WITHDRAWAL', targetCorrectionId: revisionCorrectionId };
  delete withdrawalCandidate.replacementValues;
  const correctedWithdrawalSet = buildSet(store, graph, [withdrawalCandidate]);
  const withdrawal = validateAndPublish(store, correctedWithdrawalSet, baseView(graph, {
    terminalCorrectionIds: [revisionCorrectionId], visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const withdrawalAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: withdrawal.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const withdrawalCorrectionId = withdrawalAssembly.acceptedCorrectionIds[0];
  assert.equal(withdrawalAssembly.acceptedObservationIds.length, 0);

  const restorationCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_RESTORATION',
    targetWithdrawalCorrectionId: withdrawalCorrectionId,
    restoredObservationId: revisionAssembly.acceptedObservationIds[0] };
  delete restorationCandidate.targetCorrectionId;
  delete restorationCandidate.replacementValues;
  const restorationSet = buildSet(store, graph, [restorationCandidate]);
  const restoration = validateAndPublish(store, restorationSet, baseView(graph, {
    terminalCorrectionIds: [withdrawalCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId, withdrawalCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const restorationAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: restoration.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const restorationCorrectionId = restorationAssembly.acceptedCorrectionIds[0];
  assert.equal(Revision.verifyMarketDataBarCorrection({ store, correctionId: restorationCorrectionId }).correction.correctionKind, 'RESTORATION');

  const sessionCandidate = baseCandidate(graph, {
    candidateKind: 'SESSION_DATE_CORRECTION', previousBarIdentityId: graph.bars[0].barIdentityId,
    nextBarIdentityId: graph.bars[1].barIdentityId, targetCorrectionId: restorationCorrectionId,
    marketValidTime: '2026-01-05T21:00:00.000Z',
  });
  delete sessionCandidate.barIdentityId;
  const sessionSet = buildSet(store, graph, [sessionCandidate]);
  const session = validateAndPublish(store, sessionSet, baseView(graph, {
    terminalCorrectionIds: [restorationCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId, withdrawalCorrectionId, restorationCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const sessionRecovered = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: session.delta.deltaAssemblyManifestId,
  });
  const kinds = sessionRecovered.deltaAssemblyManifest.acceptedCorrectionIds.map((correctionId) =>
    Revision.verifyMarketDataBarCorrection({ store, correctionId }).correction.correctionKind).sort();
  assert.deepEqual(kinds, ['SESSION_DATE_REPLACEMENT', 'SESSION_DATE_WITHDRAWAL']);
  assert.equal(sessionRecovered.deltaAssemblyManifest.acceptedObservationIds.length, 1);
}));

test('L3-I2 duplicates produce no publication manifest, chunk or assembly', () => withStore((store) => {
  const graph = setupI2(store);
  const set = buildSet(store, graph, [baseCandidate(graph)]);
  const view = baseView(graph, { duplicateCandidateIds: [...set.candidateSet.candidateIds] });
  const report = Candidate.validateMarketDataCandidateSet({ store, candidateSetId: set.candidateSetId, baseView: view });
  const result = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId,
    baseView: view,
  });
  assert.deepEqual(result, {
    status: 'NO_AUTHORITATIVE_DELTA', publicationManifestId: null, deltaAssemblyManifestId: null,
  });
}));

test('L3-I2 ValidationReport partition is exact and does not carry future object IDs', () => withStore((store) => {
  const graph = setupI2(store);
  const set = buildSet(store, graph, [baseCandidate(graph)]);
  assert.throws(() => Candidate.buildMarketDataValidationReport({
    store,
    report: {
      schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
      candidateSetId: set.candidateSetId, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: graph.ingestionPolicy.ingestionPolicyId,
      expectedParentIngestionManifestId: null, decisions: [], fatalErrors: [], warnings: [],
    },
  }), (error) => error.code === 'MARKET_DATA_VALIDATION_FAILED');
  const report = Candidate.validateMarketDataCandidateSet({ store, candidateSetId: set.candidateSetId, baseView: baseView(graph) });
  assert.deepEqual(Object.keys(report.validationReport).sort(), [
    'baseIngestionRegistryManifestId', 'candidateSetId', 'decisions',
    'expectedParentIngestionManifestId', 'fatalErrors', 'ingestionPolicyId',
    'schemaVersion', 'warnings',
  ]);
}));

test('L3-I2 V1 chunk-size constant is documented by the contract and enforced', () => {
  assert.equal(Delta.MAX_NORMALIZED_MARKET_DATA_DELTA_CHUNK_SIZE_V1, 100);
  assert.throws(() => Delta.normalizeNormalizedMarketDataDeltaChunkV1({
    schemaVersion: Delta.NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION,
    ingestionLineageId: `sha256:${'1'.repeat(64)}`, chunkIndex: 0,
    fromSessionDate: '2026-01-02', toSessionDateExclusive: '2026-01-03',
    observationIds: Array.from({ length: 101 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`),
    correctionIds: [],
  }), (error) => error.code === 'MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH');
});

test('L3-I2 rejects an invisible or wrong-bar correction parent with MARKET_DATA_CORRECTION_PARENT_MISMATCH', () => withStore((store) => {
  const graph = setupI2(store);
  const invisible = decisionFor(store, graph, baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: `sha256:${'e'.repeat(64)}`,
  }), baseView(graph));
  assert.deepEqual(invisible.reasonCodes, ['MARKET_DATA_CORRECTION_PARENT_MISMATCH']);
  const wrongBar = putBaseCorrection(store, graph, { barIdentityId: graph.bars[1].barIdentityId });
  const mismatch = decisionFor(store, graph, baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: wrongBar,
  }), baseView(graph, { terminalCorrectionIds: [wrongBar], visibleCorrectionIds: [wrongBar] }));
  assert.deepEqual(mismatch.reasonCodes, ['MARKET_DATA_CORRECTION_PARENT_MISMATCH']);
}));

test('L3-I2 rejects a foreign-lineage parent with MARKET_DATA_CORRECTION_LINEAGE_MISMATCH', () => withStore((store) => {
  const graph = setupI2(store);
  const foreign = putBaseCorrection(store, graph, { ingestionLineageId: `sha256:${'f'.repeat(64)}` });
  const decision = decisionFor(store, graph, baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: foreign,
  }), baseView(graph, { terminalCorrectionIds: [foreign], visibleCorrectionIds: [foreign] }));
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_CORRECTION_LINEAGE_MISMATCH']);
}));

test('L3-I2 rejects a visible non-terminal parent with MARKET_DATA_BAR_REVISION_BRANCH', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const child = putRevisionChild(store, graph, parent);
  const decision = decisionFor(store, graph, baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: parent,
    replacementValues: { ...VALUES, closeAtoms: '1125' },
  }), baseView(graph, {
    terminalCorrectionIds: [child],
    visibleCorrectionIds: [parent, child].sort(),
  }));
  assert.equal(decision.disposition, 'CONFLICTING');
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_BAR_REVISION_BRANCH']);
}));

test('L3-I2 rejects two children of one parent with MARKET_DATA_BAR_REVISION_BRANCH', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const set = buildSet(store, graph, [
    baseCandidate(graph, { candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: parent,
      replacementValues: { ...VALUES, closeAtoms: '1125' } }),
    baseCandidate(graph, { candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: parent,
      replacementValues: { ...VALUES, closeAtoms: '1150' } }),
  ]);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId,
    baseView: baseView(graph, { terminalCorrectionIds: [parent], visibleCorrectionIds: [parent] }),
  }).validationReport;
  assert.deepEqual(report.decisions.map((item) => item.reasonCodes), [
    ['MARKET_DATA_BAR_REVISION_BRANCH'], ['MARKET_DATA_BAR_REVISION_BRANCH'],
  ]);
}));

test('L3-I2 rejects an occupied initial bar with MARKET_DATA_BAR_INITIAL_VALUE_CONFLICT', () => withStore((store) => {
  const graph = setupI2(store);
  const decision = decisionFor(store, graph, baseCandidate(graph), baseView(graph, {
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_BAR_INITIAL_VALUE_CONFLICT']);
}));

test('L3-I2 rejects restoration from a non-withdrawal with MARKET_DATA_CORRECTION_CHAIN_INVALID', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const candidate = baseCandidate(graph, {
    candidateKind: 'BAR_RESTORATION', targetWithdrawalCorrectionId: parent,
    restoredObservationId: graph.ingestionPolicy.ingestionPolicyId,
  });
  delete candidate.targetCorrectionId;
  delete candidate.replacementValues;
  const decision = decisionFor(store, graph, candidate, baseView(graph, {
    terminalCorrectionIds: [parent], visibleCorrectionIds: [parent],
  }));
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_CORRECTION_CHAIN_INVALID']);
}));

test('L3-I2 rejects an occupied session-date destination with MARKET_DATA_SESSION_DATE_TARGET_OCCUPIED', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const candidate = baseCandidate(graph, {
    candidateKind: 'SESSION_DATE_CORRECTION', previousBarIdentityId: graph.bars[0].barIdentityId,
    nextBarIdentityId: graph.bars[1].barIdentityId, targetCorrectionId: parent,
    marketValidTime: '2026-01-05T21:00:00.000Z',
  });
  delete candidate.barIdentityId;
  const decision = decisionFor(store, graph, candidate, baseView(graph, {
    terminalCorrectionIds: [parent], visibleCorrectionIds: [parent],
    occupiedBarIdentityIds: [graph.bars[1].barIdentityId],
  }));
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_SESSION_DATE_TARGET_OCCUPIED']);
}));

test('L3-I2 refuses missing/divergent temporal evidence and future information with dedicated codes', () => withStore((store) => {
  const graph = setupI2(store);
  assert.throws(() => Candidate.buildMarketDataNormalizedCandidate({ store, candidate: baseCandidate(graph, {
    knowledgeMode: 'PROVIDER_PUBLICATION_TIME_ATTESTED', knowledgeTimeLowerBound: null,
    sourceTimestampEvidenceId: null,
  }) }), (error) => error.code === 'MARKET_DATA_KNOWLEDGE_BOUNDS_REQUIRED');
  assert.throws(() => Candidate.buildMarketDataNormalizedCandidate({ store, candidate: baseCandidate(graph, {
    knowledgeTimeUpperBound: '2026-01-06T23:59:59.000Z',
  }) }), (error) => error.code === 'MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID');
  assert.throws(() => Candidate.buildMarketDataNormalizedCandidate({ store, candidate: baseCandidate(graph, {
    barIdentityId: graph.bars[1].barIdentityId, marketValidTime: '2026-01-05T21:00:00.000Z',
    knowledgeMode: 'PROVIDER_PUBLICATION_TIME_ATTESTED',
    knowledgeTimeLowerBound: '2026-01-02T21:01:00.000Z',
    knowledgeTimeUpperBound: '2026-01-02T21:01:00.000Z',
    sourceTimestampEvidenceId: graph.evidence.sourceTemporalEvidenceId,
  }) }), (error) => error.code === 'MARKET_DATA_FUTURE_INFORMATION');
}));

test('L3-I2 refuses observation publication from a rejected candidate before any authoritative manifest', () => withStore((store) => {
  const graph = setupI2(store);
  const set = buildSet(store, graph, [baseCandidate(graph)]);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId,
    baseView: baseView(graph, { occupiedBarIdentityIds: [graph.bars[0].barIdentityId] }),
  });
  const candidateId = set.candidateSet.candidateIds[0];
  assert.throws(() => Revision.buildMarketDataBarObservation({
    store, candidateId, candidateSetId: set.candidateSetId,
    validationReportId: report.validationReportId,
    observation: {},
  }), (error) => error.code === 'MARKET_DATA_VALIDATION_PUBLICATION_ORDER_VIOLATION');
}));

test('L3-I2 fatal validation mixed with a duplicate fails publication with MARKET_DATA_VALIDATION_FAILED', () => withStore((store) => {
  const graph = setupI2(store);
  const set = buildSet(store, graph, [baseCandidate(graph)]);
  const candidateId = set.candidateSet.candidateIds[0];
  const view = baseView(graph, { duplicateCandidateIds: [candidateId] });
  const report = Candidate.buildMarketDataValidationReport({
    store,
    report: {
      schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
      candidateSetId: set.candidateSetId, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: graph.ingestionPolicy.ingestionPolicyId,
      expectedParentIngestionManifestId: null,
      decisions: [{ candidateId, disposition: 'DUPLICATE', reasonCodes: ['MARKET_DATA_CANDIDATE_DUPLICATE'] }],
      fatalErrors: ['MARKET_DATA_CORRECTION_CHAIN_INVALID'], warnings: [],
    },
  });
  assert.throws(() => Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId,
    baseView: view,
  }), (error) => error.code === 'MARKET_DATA_VALIDATION_FAILED');
}));

test('L3-I2 supports a deterministic multi-chunk delta whose exact union is ID-only recoverable', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const candidate = baseCandidate(graph, {
    candidateKind: 'SESSION_DATE_CORRECTION', previousBarIdentityId: graph.bars[0].barIdentityId,
    nextBarIdentityId: graph.bars[1].barIdentityId, targetCorrectionId: parent,
    marketValidTime: '2026-01-05T21:00:00.000Z',
  });
  delete candidate.barIdentityId;
  const set = buildSet(store, graph, [candidate]);
  const result = validateAndPublish(store, set, baseView(graph, {
    terminalCorrectionIds: [parent], visibleCorrectionIds: [parent],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const automatic = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: result.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const publication = Revision.verifyMarketDataAcceptedCandidatePublicationManifest({
    store, publicationManifestId: automatic.publicationManifestId,
  }).publicationManifest;
  const entry = publication.publications[0];
  const withdrawalId = entry.correctionIds.find((correctionId) =>
    Revision.verifyMarketDataBarCorrection({ store, correctionId }).correction.correctionKind === 'SESSION_DATE_WITHDRAWAL');
  const replacementId = entry.correctionIds.find((correctionId) => correctionId !== withdrawalId);
  const first = Delta.buildNormalizedMarketDataDeltaChunk({
    store, publicationManifestId: automatic.publicationManifestId,
    chunk: {
      schemaVersion: Delta.NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId, chunkIndex: 0,
      fromSessionDate: '2026-01-02', toSessionDateExclusive: '2026-01-03',
      observationIds: [], correctionIds: [withdrawalId],
    },
  });
  const second = Delta.buildNormalizedMarketDataDeltaChunk({
    store, publicationManifestId: automatic.publicationManifestId,
    chunk: {
      schemaVersion: Delta.NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId, chunkIndex: 1,
      fromSessionDate: '2026-01-05', toSessionDateExclusive: '2026-01-06',
      observationIds: [entry.observationId], correctionIds: [replacementId],
    },
  });
  const assembly = Delta.buildNormalizedMarketDataDeltaAssemblyManifest({
    store,
    assembly: {
      schemaVersion: Delta.NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      candidateSetId: set.candidateSetId, validationReportId: result.report.validationReportId,
      publicationManifestId: automatic.publicationManifestId,
      chunkIds: [first.deltaChunkId, second.deltaChunkId],
      acceptedObservationIds: [entry.observationId],
      acceptedCorrectionIds: [withdrawalId, replacementId],
      coverageFromDate: '2026-01-02', coverageToDateExclusive: '2026-01-06',
      acceptedCandidateCount: 1,
    },
  });
  const recovered = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: assembly.deltaAssemblyManifestId,
  });
  assert.equal(recovered.chunks.length, 2);
  assert.deepEqual(recovered.deltaAssemblyManifest.acceptedCorrectionIds, [withdrawalId, replacementId]);
}));

test('forged ACCEPTED report cannot override deterministic CONFLICTING validation', () => withStore((store) => {
  const graph = setupI2(store);
  const set = buildSet(store, graph, [baseCandidate(graph)]);
  const view = baseView(graph, { occupiedBarIdentityIds: [graph.bars[0].barIdentityId] });
  const honest = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  }).validationReport;
  assert.equal(honest.decisions[0].disposition, 'CONFLICTING');
  const forged = Candidate.buildMarketDataValidationReport({
    store,
    report: {
      schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
      candidateSetId: set.candidateSetId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: view.baseIngestionRegistryManifestId,
      expectedParentIngestionManifestId: view.expectedParentIngestionManifestId,
      decisions: [{
        candidateId: set.candidateSet.candidateIds[0], disposition: 'ACCEPTED', reasonCodes: [],
      }],
      fatalErrors: [], warnings: [],
    },
  });
  assert.throws(() => Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: forged.validationReportId, baseView: view,
  }), (error) => error.code === 'MARKET_DATA_VALIDATION_FAILED');
}));

test('visible child makes its parent non-terminal and blocks a second branch', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const child = putRevisionChild(store, graph, parent);
  const set = buildSet(store, graph, [baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: parent,
    replacementValues: { ...VALUES, closeAtoms: '1180' },
  })]);
  const wrongTerminals = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [parent],
      visibleCorrectionIds: [parent, child].sort(),
    }),
  }).validationReport;
  assert.ok(wrongTerminals.fatalErrors.includes('MARKET_DATA_BAR_REVISION_BRANCH'));
  assert.equal(wrongTerminals.decisions.every((item) => item.disposition !== 'ACCEPTED'), true);
  const validated = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [child],
      visibleCorrectionIds: [parent, child].sort(),
    }),
  });
  assert.equal(validated.validationReport.decisions[0].disposition, 'CONFLICTING');
  assert.deepEqual(validated.validationReport.decisions[0].reasonCodes, ['MARKET_DATA_BAR_REVISION_BRANCH']);
  const published = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: validated.validationReportId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [child],
      visibleCorrectionIds: [parent, child].sort(),
    }),
  });
  assert.deepEqual(published, {
    status: 'NO_AUTHORITATIVE_DELTA', publicationManifestId: null, deltaAssemblyManifestId: null,
  });
}));

test('restoration must restore the effective observation immediately preceding withdrawal', () => withStore((store) => {
  const graph = setupI2(store);
  const initial = validateAndPublish(store, buildSet(store, graph, [baseCandidate(graph)]), baseView(graph));
  const initialCorrectionId = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: initial.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest.acceptedCorrectionIds[0];
  const revision = validateAndPublish(store, buildSet(store, graph, [baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: initialCorrectionId,
    replacementValues: { ...VALUES, closeAtoms: '1150' },
  })]), baseView(graph, {
    terminalCorrectionIds: [initialCorrectionId], visibleCorrectionIds: [initialCorrectionId],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const revisionAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: revision.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const revisionCorrectionId = revisionAssembly.acceptedCorrectionIds[0];
  const o1 = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: initial.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest.acceptedObservationIds[0];
  const o2Independent = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: Revision.MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
    value: Revision.normalizeMarketDataBarObservationCoreV1({
      schemaVersion: Revision.MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      barIdentityId: graph.bars[0].barIdentityId,
      sourceArtifactId: graph.artifact.sourceArtifactId,
      acquisitionRecordId: graph.acquisition.acquisitionRecordId,
      parseResultId: graph.parseResult.parseResultId,
      sourceRowIndex: 0,
      sourceRowDigest: graph.parseResult.parseResult.rows[0].rowDigest,
      values: { ...VALUES, closeAtoms: '1199' },
      calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
      marketValidTime: '2026-01-02T21:00:00.000Z',
      knowledgeMode: 'CAPTURE_TIME_ONLY',
      knowledgeTimeLowerBound: null,
      knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
      sourceTimestampEvidenceId: null,
      providerRevisionId: null,
    }),
  }).objectId;
  assert.notEqual(o2Independent, o1);
  assert.notEqual(o2Independent, revisionAssembly.acceptedObservationIds[0]);
  const withdrawalCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_WITHDRAWAL',
    targetCorrectionId: revisionCorrectionId };
  delete withdrawalCandidate.replacementValues;
  const withdrawal = validateAndPublish(store, buildSet(store, graph, [withdrawalCandidate]), baseView(graph, {
    terminalCorrectionIds: [revisionCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const withdrawalCorrectionId = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: withdrawal.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest.acceptedCorrectionIds[0];
  const restorationCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_RESTORATION',
    targetWithdrawalCorrectionId: withdrawalCorrectionId, restoredObservationId: o2Independent };
  delete restorationCandidate.targetCorrectionId;
  delete restorationCandidate.replacementValues;
  const decision = decisionFor(store, graph, restorationCandidate, baseView(graph, {
    terminalCorrectionIds: [withdrawalCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId, withdrawalCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_CORRECTION_CHAIN_INVALID']);
}));

test('restoration of the exact effective pre-withdrawal observation succeeds', () => withStore((store) => {
  const graph = setupI2(store);
  const initial = validateAndPublish(store, buildSet(store, graph, [baseCandidate(graph)]), baseView(graph));
  const initialCorrectionId = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: initial.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest.acceptedCorrectionIds[0];
  const revision = validateAndPublish(store, buildSet(store, graph, [baseCandidate(graph, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: initialCorrectionId,
    replacementValues: { ...VALUES, closeAtoms: '1150' },
  })]), baseView(graph, {
    terminalCorrectionIds: [initialCorrectionId], visibleCorrectionIds: [initialCorrectionId],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const revisionAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: revision.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const revisionCorrectionId = revisionAssembly.acceptedCorrectionIds[0];
  const withdrawalCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_WITHDRAWAL',
    targetCorrectionId: revisionCorrectionId };
  delete withdrawalCandidate.replacementValues;
  const withdrawal = validateAndPublish(store, buildSet(store, graph, [withdrawalCandidate]), baseView(graph, {
    terminalCorrectionIds: [revisionCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const withdrawalCorrectionId = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: withdrawal.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest.acceptedCorrectionIds[0];
  const restorationCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_RESTORATION',
    targetWithdrawalCorrectionId: withdrawalCorrectionId,
    restoredObservationId: revisionAssembly.acceptedObservationIds[0] };
  delete restorationCandidate.targetCorrectionId;
  delete restorationCandidate.replacementValues;
  const restoration = validateAndPublish(store, buildSet(store, graph, [restorationCandidate]), baseView(graph, {
    terminalCorrectionIds: [withdrawalCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId, withdrawalCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  assert.equal(restoration.delta.status, 'PUBLISHED');
}));

test('validation report with fatal errors cannot contain accepted decisions', () => {
  const report = {
    schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
    candidateSetId: `sha256:${'a'.repeat(64)}`,
    ingestionPolicyId: `sha256:${'b'.repeat(64)}`,
    baseIngestionRegistryManifestId: `sha256:${'c'.repeat(64)}`,
    expectedParentIngestionManifestId: null,
    decisions: [{
      candidateId: `sha256:${'d'.repeat(64)}`, disposition: 'ACCEPTED', reasonCodes: [],
    }],
    fatalErrors: ['MARKET_DATA_CORRECTION_CHAIN_INVALID'],
    warnings: [],
  };
  assert.throws(() => Candidate.normalizeMarketDataValidationReportV1(report),
    (error) => error.code === 'MARKET_DATA_VALIDATION_FAILED');
});

test('successful authoritative delta returns PUBLISHED', () => withStore((store) => {
  const graph = setupI2(store);
  const { delta } = validateAndPublish(store, buildSet(store, graph, [baseCandidate(graph)]), baseView(graph));
  assert.equal(delta.status, 'PUBLISHED');
  assert.notEqual(delta.status, 'AUTHORITATIVE_DELTA_READY');
  assert.match(JSON.stringify(delta), /"status":"PUBLISHED"/);
  assert.doesNotMatch(JSON.stringify(delta), /AUTHORITATIVE_DELTA_READY/);
}));

test('L3-I2 terminal list missing a leaf fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const child = putRevisionChild(store, graph, parent);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [],
      visibleCorrectionIds: [parent, child].sort(),
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    }),
  }).validationReport;
  assert.ok(report.fatalErrors.includes('MARKET_DATA_CORRECTION_CHAIN_INVALID'));
  assert.equal(report.decisions.every((item) => item.disposition !== 'ACCEPTED'), true);
}));

test('L3-I2 terminal list with a non-terminal parent added fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const child = putRevisionChild(store, graph, parent);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [parent, child].sort(),
      visibleCorrectionIds: [parent, child].sort(),
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    }),
  }).validationReport;
  assert.ok(report.fatalErrors.includes('MARKET_DATA_BAR_REVISION_BRANCH'));
}));

test('L3-I2 terminal list with a foreign ID fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const foreign = `sha256:${'e'.repeat(64)}`;
  assert.throws(() => Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [foreign],
      visibleCorrectionIds: [parent],
    }),
  }), (error) => error.code === 'MARKET_DATA_VALIDATION_FAILED');
}));

test('L3-I2 visible child of another lineage fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const child = putRevisionChild(store, graph, parent, {
    ingestionLineageId: `sha256:${'f'.repeat(64)}`,
  });
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [child],
      visibleCorrectionIds: [parent, child].sort(),
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    }),
  }).validationReport;
  assert.ok(report.fatalErrors.includes('MARKET_DATA_CORRECTION_LINEAGE_MISMATCH'));
}));

test('L3-I2 visible child of another bar fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const child = putRevisionChild(store, graph, parent, {
    barIdentityId: graph.bars[1].barIdentityId,
  });
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [child],
      visibleCorrectionIds: [parent, child].sort(),
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    }),
  }).validationReport;
  assert.ok(report.fatalErrors.includes('MARKET_DATA_CORRECTION_PARENT_MISMATCH'));
}));

test('L3-I2 two visible children of the same parent fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const childA = putRevisionChild(store, graph, parent, {
    observationId: graph.calendarRegistry.calendarRegistryManifestId,
  });
  const childB = putRevisionChild(store, graph, parent, {
    observationId: graph.artifact.sourceArtifactId,
  });
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [childA, childB].sort(),
      visibleCorrectionIds: [parent, childA, childB].sort(),
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    }),
  }).validationReport;
  assert.ok(report.fatalErrors.includes('MARKET_DATA_BAR_REVISION_BRANCH'));
}));

test('L3-I2 visible parent missing from the closure fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const parent = putBaseCorrection(store, graph);
  const child = putRevisionChild(store, graph, parent);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [child],
      visibleCorrectionIds: [child],
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    }),
  }).validationReport;
  assert.ok(report.fatalErrors.includes('MARKET_DATA_CORRECTION_PARENT_MISMATCH'));
}));

test('L3-I2 indirect correction cycle fails closed', () => withStore((baseStore) => {
  const graph = setupI2(baseStore);
  const idA = `sha256:${'1'.repeat(64)}`;
  const idB = `sha256:${'2'.repeat(64)}`;
  const idC = `sha256:${'3'.repeat(64)}`;
  const cyclicValue = (parentCorrectionId) => Revision.normalizeMarketDataBarCorrectionCoreV1({
    schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
    correctionKind: 'VALUE_REVISION',
    ingestionLineageId: graph.lineage.ingestionLineageId,
    barIdentityId: graph.bars[0].barIdentityId,
    parentCorrectionId,
    observationId: graph.ingestionPolicy.ingestionPolicyId,
    restoredObservationId: null,
    sessionDateLink: null,
    sourceArtifactId: graph.artifact.sourceArtifactId,
    acquisitionRecordId: graph.acquisition.acquisitionRecordId,
    parseResultId: graph.parseResult.parseResultId,
    sourceRowIndex: 0,
    sourceRowDigest: graph.parseResult.parseResult.rows[0].rowDigest,
    knowledgeMode: 'CAPTURE_TIME_ONLY',
    knowledgeTimeLowerBound: null,
    knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
    sourceTimestampEvidenceId: null,
    providerRevisionId: null,
  });
  const overlay = new Map([
    [idA, cyclicValue(idC)],
    [idB, cyclicValue(idA)],
    [idC, cyclicValue(idB)],
  ]);
  const store = {
    root: baseStore.root,
    uriForObject: (input) => baseStore.uriForObject(input),
    putSourceBytes: (bytes) => baseStore.putSourceBytes(bytes),
    putCanonicalObject: (input) => baseStore.putCanonicalObject(input),
    verifyObject: (input) => baseStore.verifyObject(input),
    readObject(input) {
      if (overlay.has(input.expectedObjectId)) {
        const bytes = canonicalJsonBytes(overlay.get(input.expectedObjectId));
        return { bytes, objectId: input.expectedObjectId, uri: input.uri, sizeBytes: bytes.length };
      }
      return baseStore.readObject(input);
    },
    readCanonicalObject(input) {
      if (overlay.has(input.expectedObjectId)) {
        return {
          objectId: input.expectedObjectId, uri: input.uri,
          value: overlay.get(input.expectedObjectId), bytes: Buffer.alloc(0), sizeBytes: 0,
        };
      }
      return baseStore.readCanonicalObject(input);
    },
  };
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: buildSet(store, graph, [baseCandidate(graph)]).candidateSetId,
    baseView: baseView(graph, {
      terminalCorrectionIds: [],
      visibleCorrectionIds: [idA, idB, idC].sort(),
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    }),
  }).validationReport;
  assert.ok(report.fatalErrors.includes('MARKET_DATA_CORRECTION_CHAIN_INVALID'));
}));

test('L3-I2 restoration after a previous restoration requires a withdrawal parent', () => withStore((store) => {
  const graph = setupI2(store);
  const initial = validateAndPublish(store, buildSet(store, graph, [baseCandidate(graph)]), baseView(graph));
  const initialAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: initial.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const initialCorrectionId = initialAssembly.acceptedCorrectionIds[0];
  const withdrawalCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_WITHDRAWAL',
    targetCorrectionId: initialCorrectionId };
  delete withdrawalCandidate.replacementValues;
  const withdrawal = validateAndPublish(store, buildSet(store, graph, [withdrawalCandidate]), baseView(graph, {
    terminalCorrectionIds: [initialCorrectionId], visibleCorrectionIds: [initialCorrectionId],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const withdrawalCorrectionId = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: withdrawal.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest.acceptedCorrectionIds[0];
  const restorationCandidate = { ...baseCandidate(graph), candidateKind: 'BAR_RESTORATION',
    targetWithdrawalCorrectionId: withdrawalCorrectionId,
    restoredObservationId: initialAssembly.acceptedObservationIds[0] };
  delete restorationCandidate.targetCorrectionId;
  delete restorationCandidate.replacementValues;
  const restoration = validateAndPublish(store, buildSet(store, graph, [restorationCandidate]), baseView(graph, {
    terminalCorrectionIds: [withdrawalCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, withdrawalCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  const restorationCorrectionId = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: restoration.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest.acceptedCorrectionIds[0];
  const second = { ...baseCandidate(graph), candidateKind: 'BAR_RESTORATION',
    targetWithdrawalCorrectionId: restorationCorrectionId,
    restoredObservationId: initialAssembly.acceptedObservationIds[0] };
  delete second.targetCorrectionId;
  delete second.replacementValues;
  const decision = decisionFor(store, graph, second, baseView(graph, {
    terminalCorrectionIds: [restorationCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, withdrawalCorrectionId, restorationCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_CORRECTION_CHAIN_INVALID']);
}));

test('L3-I2 restoration when the prior state is already withdrawn fails closed', () => withStore((store) => {
  const graph = setupI2(store);
  const root = putBaseCorrection(store, graph);
  const firstWithdrawal = putWithdrawalChild(store, graph, root);
  const secondWithdrawal = putWithdrawalChild(store, graph, firstWithdrawal);
  const candidate = { ...baseCandidate(graph), candidateKind: 'BAR_RESTORATION',
    targetWithdrawalCorrectionId: secondWithdrawal,
    restoredObservationId: graph.ingestionPolicy.ingestionPolicyId };
  delete candidate.targetCorrectionId;
  delete candidate.replacementValues;
  const decision = decisionFor(store, graph, candidate, baseView(graph, {
    terminalCorrectionIds: [secondWithdrawal],
    visibleCorrectionIds: [root, firstWithdrawal, secondWithdrawal].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  }));
  assert.deepEqual(decision.reasonCodes, ['MARKET_DATA_CORRECTION_CHAIN_INVALID']);
}));
