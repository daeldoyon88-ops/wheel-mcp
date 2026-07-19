import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  normalizeMarketDataIngestionManifestV1,
  normalizeMarketDataIngestionRegistryManifestV1,
  deriveCorporateActionTreatment,
  deriveTemporalCapabilityFromKnowledgeModes,
} from '../src/contracts/marketDataIngestionRegistryL3V1.mjs';
import * as Candidate from '../src/contracts/marketDataCandidateL3V1.mjs';

const ID_A = `sha256:${'a'.repeat(64)}`;
const ID_B = `sha256:${'b'.repeat(64)}`;
const ID_C = `sha256:${'c'.repeat(64)}`;
const ID_D = `sha256:${'d'.repeat(64)}`;

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code);
    assert.doesNotMatch(String(error), /TypeError/);
    return true;
  });
}

function registryValue(overrides = {}) {
  return {
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: ID_A,
    supersedesIngestionRegistryManifestId: null,
    ingestionManifestIds: [],
    lineageTips: [],
    ...overrides,
  };
}

function manifestValue(overrides = {}) {
  return {
    schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
    ingestionLineageId: ID_A,
    ingestionPolicyId: ID_B,
    baseIngestionRegistryManifestId: ID_C,
    expectedParentIngestionManifestId: null,
    supersedesIngestionManifestId: null,
    identityRegistryManifestId: ID_A,
    calendarRegistryManifestId: ID_B,
    corporateActionRegistryManifestId: ID_C,
    sourceArtifactId: ID_D,
    sourceAttestationId: ID_A,
    acquisitionRecordId: ID_B,
    parseResultId: ID_C,
    candidateSetId: ID_D,
    validationReportId: ID_A,
    acceptedCandidatePublicationManifestId: ID_B,
    deltaAssemblyManifestId: ID_C,
    newBarObservationIds: [ID_D],
    newBarCorrectionIds: [ID_A],
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    ...overrides,
  };
}

test('L3-I3 normalize-level rejects unknown fields, empty delta, tip shape and fatal/ACCEPTED mix', () => {
  expectCode(() => normalizeMarketDataIngestionManifestV1(manifestValue({ alien: true })),
    'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => normalizeMarketDataIngestionManifestV1(manifestValue({
    newBarObservationIds: [], newBarCorrectionIds: [],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataIngestionRegistryManifestV1(registryValue({
    lineageTips: [{ ingestionLineageId: ID_A, tipIngestionManifestId: ID_B }],
  })), 'MARKET_DATA_INGESTION_CHAIN_INVALID');
  expectCode(() => normalizeMarketDataIngestionRegistryManifestV1(registryValue({
    ingestionManifestIds: [ID_B],
    lineageTips: [
      { ingestionLineageId: ID_A, tipIngestionManifestId: ID_B },
      { ingestionLineageId: ID_A, tipIngestionManifestId: ID_B },
    ],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => deriveTemporalCapabilityFromKnowledgeModes([]),
    'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH');
  expectCode(() => deriveTemporalCapabilityFromKnowledgeModes(['WALL_CLOCK']),
    'MARKET_DATA_KNOWLEDGE_MODE_INVALID');
  assert.equal(deriveCorporateActionTreatment('RAW'), 'RAW_SOURCE_UNTRANSFORMED');
  assert.equal(deriveCorporateActionTreatment('SPLIT_ADJUSTED'), 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED');
  expectCode(() => Candidate.normalizeMarketDataValidationReportV1({
    schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
    candidateSetId: ID_A, ingestionPolicyId: ID_B,
    baseIngestionRegistryManifestId: ID_C, expectedParentIngestionManifestId: null,
    decisions: [{ candidateId: ID_D, disposition: 'ACCEPTED', reasonCodes: [] }],
    fatalErrors: ['MARKET_DATA_CORRECTION_CHAIN_INVALID'], warnings: [],
  }), 'MARKET_DATA_VALIDATION_FAILED');
});

test('L3-I3 temporary adversarial harness runs at least 30 independent fail-closed scenarios', () => {
  const root = mkdtempSync(join(tmpdir(), 'market-data-l3-i3-'));
  const harnessPath = join(root, 'counter-harness.mjs');
  const lab = resolve('research/directional-lab');
  const u = (rel) => pathToFileURL(resolve(lab, rel)).href;
  const source = `
import assert from 'node:assert/strict';
import { CA } from ${JSON.stringify(u('src/contracts/corporateActionL2CV1.mjs'))};
import {
  buildInstrumentIdentity, buildInstrumentIdentityAuthorityPolicy,
  buildInstrumentIdentityManifest, buildInstrumentIdentityRegistry,
} from ${JSON.stringify(u('src/data/buildInstrumentIdentity.mjs'))};
import {
  buildCorporateActionPolicies, buildCorporateActionRegistry, buildTimeZoneRuleset,
} from ${JSON.stringify(u('src/data/buildCorporateAction.mjs'))};
import { withStore } from ${JSON.stringify(u('test/l2aSyntheticPipeline.mjs'))};
import * as Candidate from ${JSON.stringify(u('src/contracts/marketDataCandidateL3V1.mjs'))};
import * as Revision from ${JSON.stringify(u('src/contracts/marketDataBarRevisionL3V1.mjs'))};
import * as Delta from ${JSON.stringify(u('src/contracts/marketDataDeltaL3V1.mjs'))};
import * as Source from ${JSON.stringify(u('src/contracts/marketDataSourceL3V1.mjs'))};
import * as Calendar from ${JSON.stringify(u('src/contracts/marketCalendarL3V1.mjs'))};
import * as Bar from ${JSON.stringify(u('src/contracts/marketDataBarIdentityL3V1.mjs'))};
import {
  MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  appendMarketDataIngestionRegistry,
  buildMarketDataIngestionManifest,
  buildMarketDataIngestionRegistryManifest,
  deriveCorporateActionTreatment,
  deriveTemporalCapabilityFromDeltaObjects,
  tipForLineage,
  verifyMarketDataIngestionManifest,
  verifyMarketDataIngestionRegistry,
  normalizeMarketDataIngestionManifestV1,
  normalizeMarketDataIngestionRegistryManifestV1,
} from ${JSON.stringify(u('src/contracts/marketDataIngestionRegistryL3V1.mjs'))};
import { MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1 } from ${JSON.stringify(u('src/pipeline/runMarketDataIngestionL3V1.mjs'))};
import { addDays } from ${JSON.stringify(u('src/time/civilDate.mjs'))};
import { canonicalJsonBytes } from ${JSON.stringify(u('src/canonical/canonicalJsonV1.mjs'))};

const ID_A = 'sha256:' + 'a'.repeat(64);
const ID_B = 'sha256:' + 'b'.repeat(64);
const ID_AUTH = 'sha256:' + 'c'.repeat(64);
const VALUES = Object.freeze({
  openAtoms: '1000', highAtoms: '1200', lowAtoms: '900', closeAtoms: '1100',
  priceScale: 2, volumeAtoms: '100', volumeScale: 0, currency: 'USD', priceBasis: 'RAW',
});

const failedNames = [];
let passed = 0;
function run(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { failedNames.push(name + ': ' + (error?.code || error?.message || String(error))); }
}
function expectThrow(fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert.equal(threw, true, 'expected throw');
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

function setupI3(store, priceBasis = 'RAW') {
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l3-i3-adv/1', identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
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
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i3-adv-ca/1', identityNamespaceVersion: 'L3-I3-ADV/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I3-ADV/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I3-ADV/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I3-ADV/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I3-ADV/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I3-ADV/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({ store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry) });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE, rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l3-i3-adv',
      validFromDate: '2026-01-02', validToDateExclusive: '2026-01-11',
      civilDateBounds: Array.from({ length: 9 }, (_, index) => {
        const civilDate = addDays('2026-01-02', index);
        return { civilDate, startUtc: civilDate + 'T05:00:00.000Z', endUtcExclusive: addDays(civilDate, 1) + 'T05:00:00.000Z' };
      }),
    },
  });
  const calendarPolicy = Calendar.buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'synthetic-l3-i3-adv/1',
    },
  });
  const sessions = [
    { sessionDate: '2026-01-02', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-02T14:30:00.000Z', closeUtc: '2026-01-02T21:00:00.000Z', marketValidTime: '2026-01-02T21:00:00.000Z' },
    { sessionDate: '2026-01-05', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-05T14:30:00.000Z', closeUtc: '2026-01-05T21:00:00.000Z', marketValidTime: '2026-01-05T21:00:00.000Z' },
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
      allowedPriceBases: ['RAW', 'SPLIT_ADJUSTED'], allowedSourceDatasetKinds: ['EOD_OHLCV'],
      allowedPayloadFormats: ['CSV_UTF8'], maxArtifactBytes: 100000,
      knowledgeModes: ['CAPTURE_TIME_ONLY'],
      providerPublicationTimeField: null, providerRevisionIdField: null,
      unknownFieldPolicy: 'REJECT', duplicateIdenticalRowPolicy: 'ACCEPT_IDENTICAL',
      volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
    },
  });
  const lineage = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER', instrumentIdentityId: instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis, sourceDatasetKind: 'EOD_OHLCV',
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
      registryNamespaceVersion: 'synthetic-l3-i3-adv/1', authorityScope: 'MARKET_DATA_INGESTION',
    },
  });
  const rootRegistry = buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: null, ingestionManifestIds: [], lineageTips: [],
    },
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
  return {
    instrument, instrumentRegistry, corporateRegistry, calendarRegistry,
    ingestionPolicy, lineage, registryAuthority, rootRegistry, bars, priceBasis,
  };
}

function atomsRow(graph, sessionDate) {
  return [
    sessionDate, '1000', '1200', '900', '1100', '2', '100', '0', 'USD', 'CAPTURE_TIME_ONLY',
    graph.instrumentRegistry.registryManifestId,
    graph.calendarRegistry.calendarRegistryManifestId,
    graph.corporateRegistry.registryManifestId,
  ];
}

function buildAtomsArtifact(store, graph, rows, runId) {
  const bytes = Buffer.from([[...MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1].join(','), ...rows.map((r) => r.join(',')), ''].join('\\n'));
  const sourceBytes = store.putSourceBytes(bytes);
  const artifact = Source.buildMarketDataSourceArtifact({
    store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId, payloadFormat: 'CSV_UTF8',
      mediaType: 'text/csv; charset=utf-8', embeddedBytesObjectId: sourceBytes.objectId,
      payloadDigest: sourceBytes.objectId, payloadByteLength: bytes.length,
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
      acquisitionTimeUtc: '2026-01-07T00:00:00.000Z',
      providerId: graph.lineage.ingestionLineage.providerId,
      logicalEndpointKind: 'EOD_OHLCV_DATASET', requestDatasetKind: 'EOD_OHLCV',
      executionIdentity: { runnerId: 'node-test', runId, environment: 'LOCAL_TEST' },
      sourceAttestationId: attestation.sourceAttestationId,
    },
  });
  return { artifact, attestation, acquisition };
}

function attach(store, graph) {
  Object.assign(graph, buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-02')], 'adv'));
  graph.parseResult = Source.buildMarketDataParseResult({
    store, sourceArtifactId: graph.artifact.sourceArtifactId,
    acquisitionRecordId: graph.acquisition.acquisitionRecordId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
  });
  return graph;
}

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
    targetCorrectionId: null, replacementValues: { ...VALUES, priceBasis: graph.priceBasis },
    ...overrides,
  };
}

function buildSet(store, graph, candidates) {
  const built = candidates.map((c) => Candidate.buildMarketDataNormalizedCandidate({ store, candidate: c }));
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
      candidateIds: built.map((item) => item.candidateId).sort(),
    },
  });
}

function realBaseView(graph, registryId, overrides = {}) {
  return {
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: null,
    terminalCorrectionIds: [], visibleCorrectionIds: [], occupiedBarIdentityIds: [],
    publishedBarIdentityIds: graph.bars.map((bar) => bar.barIdentityId).sort(),
    duplicateCandidateIds: [],
    ...overrides,
  };
}

function publishI2(store, graph, registryId, parentId = null, overrides = {}) {
  const set = buildSet(store, graph, [baseCandidate(graph, overrides)]);
  const view = realBaseView(graph, registryId, { expectedParentIngestionManifestId: parentId });
  if (parentId) {
    const parentManifest = verifyMarketDataIngestionManifest({ store, ingestionManifestId: parentId }).ingestionManifest;
    view.terminalCorrectionIds = [...parentManifest.newBarCorrectionIds];
    view.visibleCorrectionIds = [...parentManifest.newBarCorrectionIds];
    view.occupiedBarIdentityIds = [graph.bars[0].barIdentityId];
  }
  const report = Candidate.validateMarketDataCandidateSet({ store, candidateSetId: set.candidateSetId, baseView: view });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId, baseView: view,
  });
  return { set, report, delta };
}

function buildIngestion(store, graph, registryId, parentId, published, overrides = {}) {
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const newBarObservationIds = [...assembly.acceptedObservationIds].sort();
  const newBarCorrectionIds = [...assembly.acceptedCorrectionIds].sort();
  return buildMarketDataIngestionManifest({
    store,
    manifest: {
      schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: registryId,
      expectedParentIngestionManifestId: parentId,
      supersedesIngestionManifestId: parentId,
      identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
      calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
      corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      sourceArtifactId: graph.artifact.sourceArtifactId,
      sourceAttestationId: graph.attestation.sourceAttestationId,
      acquisitionRecordId: graph.acquisition.acquisitionRecordId,
      parseResultId: graph.parseResult.parseResultId,
      candidateSetId: published.set.candidateSetId,
      validationReportId: published.report.validationReportId,
      acceptedCandidatePublicationManifestId: published.delta.publicationManifestId,
      deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
      newBarObservationIds, newBarCorrectionIds,
      temporalCapability: deriveTemporalCapabilityFromDeltaObjects(store, newBarObservationIds, newBarCorrectionIds),
      priceBasis: graph.priceBasis,
      corporateActionTreatment: deriveCorporateActionTreatment(graph.priceBasis),
      ...overrides,
    },
  });
}

function publishAndAppend(store, graph, registryId, parentId = null) {
  const published = publishI2(store, graph, registryId, parentId);
  assert.equal(published.delta.status, 'PUBLISHED');
  const ingestion = buildIngestion(store, graph, registryId, parentId, published);
  const registry = appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: parentId,
    ingestionManifestId: ingestion.ingestionManifestId,
  });
  return { published, ingestion, registry };
}

function secondLineage(store, graph) {
  const lineage = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER_B', instrumentIdentityId: graph.instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis: graph.priceBasis, sourceDatasetKind: 'EOD_OHLCV',
    },
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const g2 = { ...graph, lineage, bars: [graph.bars[0]] };
  Object.assign(g2, buildAtomsArtifact(store, g2, [atomsRow(g2, '2026-01-02')], 'adv-b'));
  g2.parseResult = Source.buildMarketDataParseResult({
    store, sourceArtifactId: g2.artifact.sourceArtifactId,
    acquisitionRecordId: g2.acquisition.acquisitionRecordId,
    ingestionPolicyId: g2.ingestionPolicy.ingestionPolicyId,
  });
  return g2;
}

function mockStore(values) {
  return {
    uriForObject: ({ objectId }) => objectId,
    readObject: ({ expectedObjectId }) => ({ bytes: canonicalJsonBytes(values.get(expectedObjectId)) }),
    readCanonicalObject: ({ expectedObjectId }) => ({ value: values.get(expectedObjectId) }),
  };
}

withStore((store) => {
  const graph = attach(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const first = publishAndAppend(store, graph, rootId, null);
  const nextArt = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05')], 'adv-next');
  const nextGraph = {
    ...graph, ...nextArt,
    parseResult: Source.buildMarketDataParseResult({
      store, sourceArtifactId: nextArt.artifact.sourceArtifactId,
      acquisitionRecordId: nextArt.acquisition.acquisitionRecordId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    }),
  };
  const parentCorr = [...first.ingestion.ingestionManifest.newBarCorrectionIds];
  const nextView = realBaseView(nextGraph, first.registry.ingestionRegistryManifestId, {
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
    visibleCorrectionIds: parentCorr, terminalCorrectionIds: parentCorr,
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    publishedBarIdentityIds: [graph.bars[0].barIdentityId, graph.bars[1].barIdentityId].sort(),
  });
  const nextSet = buildSet(store, nextGraph, [baseCandidate(nextGraph, {
    barIdentityId: graph.bars[1].barIdentityId, marketValidTime: '2026-01-05T21:00:00.000Z',
  })]);
  const nextReport = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: nextSet.candidateSetId, baseView: nextView,
  });
  const nextDelta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: nextSet.candidateSetId, validationReportId: nextReport.validationReportId, baseView: nextView,
  });
  const nextPublished = { set: nextSet, report: nextReport, delta: nextDelta };
  const nextAsm = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: nextDelta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const nextBase = {
    schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
    supersedesIngestionManifestId: first.ingestion.ingestionManifestId,
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
    sourceArtifactId: nextGraph.artifact.sourceArtifactId,
    sourceAttestationId: nextGraph.attestation.sourceAttestationId,
    acquisitionRecordId: nextGraph.acquisition.acquisitionRecordId,
    parseResultId: nextGraph.parseResult.parseResultId,
    candidateSetId: nextSet.candidateSetId,
    validationReportId: nextReport.validationReportId,
    acceptedCandidatePublicationManifestId: nextDelta.publicationManifestId,
    deltaAssemblyManifestId: nextDelta.deltaAssemblyManifestId,
    newBarObservationIds: [...nextAsm.acceptedObservationIds].sort(),
    newBarCorrectionIds: [...nextAsm.acceptedCorrectionIds].sort(),
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
  };
  const g2 = secondLineage(store, graph);
  const other = publishAndAppend(store, g2, first.registry.ingestionRegistryManifestId, null);
  const child1 = buildIngestion(store, nextGraph, first.registry.ingestionRegistryManifestId,
    first.ingestion.ingestionManifestId, nextPublished);

  run('1 false parent', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase,
      expectedParentIngestionManifestId: other.ingestion.ingestionManifestId,
      supersedesIngestionManifestId: other.ingestion.ingestionManifestId,
    },
  })));
  run('2 foreign base registry', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: { ...nextBase, baseIngestionRegistryManifestId: rootId },
  })));
  run('3 omitted tip', () => expectThrow(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [first.ingestion.ingestionManifestId],
      lineageTips: [],
    },
  })));
  run('4 stale tip', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase,
      baseIngestionRegistryManifestId: rootId,
      expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
      supersedesIngestionManifestId: first.ingestion.ingestionManifestId,
    },
  })));
  run('5 other lineage manifest', () => expectThrow(() => verifyMarketDataIngestionRegistry({
    store,
    ingestionRegistryManifestId: store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      value: normalizeMarketDataIngestionRegistryManifestV1({
        schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
        ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
        supersedesIngestionRegistryManifestId: null,
        ingestionManifestIds: [other.ingestion.ingestionManifestId],
        lineageTips: [{
          ingestionLineageId: graph.lineage.ingestionLineageId,
          tipIngestionManifestId: other.ingestion.ingestionManifestId,
        }],
      }),
    }).objectId,
  })));
  run('6 foreign correction', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase,
      newBarCorrectionIds: [...other.ingestion.ingestionManifest.newBarCorrectionIds].sort(),
    },
  })));
  run('7 foreign observation', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase,
      newBarObservationIds: [...other.ingestion.ingestionManifest.newBarObservationIds].sort(),
    },
  })));
  run('8 incomplete publication', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase,
      acceptedCandidatePublicationManifestId: other.published.delta.publicationManifestId,
    },
  })));
  run('9 incomplete assembly', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase,
      deltaAssemblyManifestId: other.published.delta.deltaAssemblyManifestId,
    },
  })));
  run('10 historical removal', () => expectThrow(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [], lineageTips: [],
    },
  })));
  const otherAuth = Source.buildMarketDataIngestionRegistryAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Source.MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
      registryNamespaceVersion: 'synthetic-l3-i3-adv/other', authorityScope: 'MARKET_DATA_INGESTION',
    },
  });
  run('11 replaced registry policy', () => expectThrow(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: otherAuth.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [...first.registry.ingestionRegistryManifest.ingestionManifestIds],
      lineageTips: [...first.registry.ingestionRegistryManifest.lineageTips],
    },
  })));
  const authority = {
    schemaVersion: Source.MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: 'mock-adv/1', authorityScope: 'MARKET_DATA_INGESTION',
  };
  const empty = {
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: ID_AUTH,
    supersedesIngestionRegistryManifestId: null, ingestionManifestIds: [], lineageTips: [],
  };
  run('12 cycle', () => expectThrow(() => verifyMarketDataIngestionRegistry({
    store: mockStore(new Map([
      [ID_A, { ...empty, supersedesIngestionRegistryManifestId: ID_A }],
      [ID_AUTH, authority],
    ])),
    ingestionRegistryManifestId: ID_A,
  })));
  run('13 branch', () => expectThrow(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: other.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [
        first.ingestion.ingestionManifestId,
        other.ingestion.ingestionManifestId,
        child1.ingestionManifestId,
      ].sort(),
      lineageTips: [{
        ingestionLineageId: graph.lineage.ingestionLineageId,
        tipIngestionManifestId: child1.ingestionManifestId,
      }],
    },
  })));
  run('14 duplicate tip', () => expectThrow(() => normalizeMarketDataIngestionRegistryManifestV1({
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
    supersedesIngestionRegistryManifestId: null,
    ingestionManifestIds: [first.ingestion.ingestionManifestId],
    lineageTips: [
      { ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: first.ingestion.ingestionManifestId },
      { ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: first.ingestion.ingestionManifestId },
    ],
  })));
  run('15 inflated temporal capability', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: { ...nextBase, temporalCapability: 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED' },
  })));
  run('16 fraudulent corporate action treatment', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: { ...nextBase, corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED' },
  })));
  run('17 RAW mapped as split-adjusted', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase, priceBasis: 'SPLIT_ADJUSTED',
      corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
    },
  })));
  {
    const splitGraph = attach(store, setupI3(store, 'SPLIT_ADJUSTED'));
    const splitPub = publishI2(store, splitGraph, splitGraph.rootRegistry.ingestionRegistryManifestId, null);
    const splitAsm = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
      store, deltaAssemblyManifestId: splitPub.delta.deltaAssemblyManifestId,
    }).deltaAssemblyManifest;
    run('18 SPLIT_ADJUSTED mapped as RAW', () => expectThrow(() => buildMarketDataIngestionManifest({
      store,
      manifest: {
        schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
        ingestionLineageId: splitGraph.lineage.ingestionLineageId,
        ingestionPolicyId: splitGraph.ingestionPolicy.ingestionPolicyId,
        baseIngestionRegistryManifestId: splitGraph.rootRegistry.ingestionRegistryManifestId,
        expectedParentIngestionManifestId: null, supersedesIngestionManifestId: null,
        identityRegistryManifestId: splitGraph.instrumentRegistry.registryManifestId,
        calendarRegistryManifestId: splitGraph.calendarRegistry.calendarRegistryManifestId,
        corporateActionRegistryManifestId: splitGraph.corporateRegistry.registryManifestId,
        sourceArtifactId: splitGraph.artifact.sourceArtifactId,
        sourceAttestationId: splitGraph.attestation.sourceAttestationId,
        acquisitionRecordId: splitGraph.acquisition.acquisitionRecordId,
        parseResultId: splitGraph.parseResult.parseResultId,
        candidateSetId: splitPub.set.candidateSetId,
        validationReportId: splitPub.report.validationReportId,
        acceptedCandidatePublicationManifestId: splitPub.delta.publicationManifestId,
        deltaAssemblyManifestId: splitPub.delta.deltaAssemblyManifestId,
        newBarObservationIds: [...splitAsm.acceptedObservationIds].sort(),
        newBarCorrectionIds: [...splitAsm.acceptedCorrectionIds].sort(),
        temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
        priceBasis: 'RAW', corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
      },
    })));
  }
  run('19 zero-delta', () => expectThrow(() => normalizeMarketDataIngestionManifestV1({
    ...nextBase, newBarObservationIds: [], newBarCorrectionIds: [],
  })));
  run('20 fatal mixed with accepted', () => expectThrow(() => Candidate.normalizeMarketDataValidationReportV1({
    schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
    candidateSetId: ID_A, ingestionPolicyId: ID_B,
    baseIngestionRegistryManifestId: ID_B, expectedParentIngestionManifestId: null,
    decisions: [{ candidateId: ID_A, disposition: 'ACCEPTED', reasonCodes: [] }],
    fatalErrors: ['MARKET_DATA_BAR_REVISION_BRANCH'], warnings: [],
  })));
  run('20b fatal mixed with duplicate disposition still listed', () => expectThrow(() => Candidate.normalizeMarketDataValidationReportV1({
    schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
    candidateSetId: ID_A, ingestionPolicyId: ID_B,
    baseIngestionRegistryManifestId: ID_B, expectedParentIngestionManifestId: null,
    decisions: [
      { candidateId: ID_A, disposition: 'DUPLICATE', reasonCodes: ['MARKET_DATA_CANDIDATE_DUPLICATE'] },
      { candidateId: ID_B, disposition: 'ACCEPTED', reasonCodes: [] },
    ],
    fatalErrors: ['MARKET_DATA_BAR_REVISION_BRANCH'], warnings: [],
  })));
  run('21 forged ACCEPTED', () => {
    const set = buildSet(store, graph, [baseCandidate(graph)]);
    const view = realBaseView(graph, rootId, { occupiedBarIdentityIds: [graph.bars[0].barIdentityId] });
    const forged = Candidate.buildMarketDataValidationReport({
      store,
      report: {
        schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
        candidateSetId: set.candidateSetId,
        ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
        baseIngestionRegistryManifestId: rootId, expectedParentIngestionManifestId: null,
        decisions: [{ candidateId: set.candidateSet.candidateIds[0], disposition: 'ACCEPTED', reasonCodes: [] }],
        fatalErrors: [], warnings: [],
      },
    });
    expectThrow(() => Delta.publishValidatedMarketDataDelta({
      store, candidateSetId: set.candidateSetId, validationReportId: forged.validationReportId, baseView: view,
    }));
  });
  run('22 second visible child', () => {
    const parent = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: Revision.normalizeMarketDataBarCorrectionCoreV1({
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
      }),
    }).objectId;
    const child = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: Revision.normalizeMarketDataBarCorrectionCoreV1({
        schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
        correctionKind: 'VALUE_REVISION', ingestionLineageId: graph.lineage.ingestionLineageId,
        barIdentityId: graph.bars[0].barIdentityId, parentCorrectionId: parent,
        observationId: graph.ingestionPolicy.ingestionPolicyId, restoredObservationId: null,
        sessionDateLink: null, sourceArtifactId: graph.artifact.sourceArtifactId,
        acquisitionRecordId: graph.acquisition.acquisitionRecordId,
        parseResultId: graph.parseResult.parseResultId, sourceRowIndex: 0,
        sourceRowDigest: 'sha256:' + 'e'.repeat(64),
        knowledgeMode: 'CAPTURE_TIME_ONLY', knowledgeTimeLowerBound: null,
        knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
        sourceTimestampEvidenceId: null, providerRevisionId: null,
      }),
    }).objectId;
    const set = buildSet(store, graph, [baseCandidate(graph, {
      candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: parent,
      replacementValues: { ...VALUES, closeAtoms: '1180' },
    })]);
    const validated = Candidate.validateMarketDataCandidateSet({
      store, candidateSetId: set.candidateSetId,
      baseView: realBaseView(graph, rootId, {
        terminalCorrectionIds: [parent], visibleCorrectionIds: [parent, child].sort(),
      }),
    });
    assert.ok(validated.validationReport.fatalErrors.includes('MARKET_DATA_BAR_REVISION_BRANCH'));
    expectThrow(() => Delta.publishValidatedMarketDataDelta({
      store, candidateSetId: set.candidateSetId, validationReportId: validated.validationReportId,
      baseView: realBaseView(graph, rootId, {
        terminalCorrectionIds: [parent], visibleCorrectionIds: [parent, child].sort(),
      }),
    }));
  });
  run('23 non-ancestral restoration', () => {
    const g = attach(store, setupI3(store));
    const root = g.rootRegistry.ingestionRegistryManifestId;
    const initial = publishI2(store, g, root, null);
    const initialCorr = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
      store, deltaAssemblyManifestId: initial.delta.deltaAssemblyManifestId,
    }).deltaAssemblyManifest.acceptedCorrectionIds[0];
    const setR = buildSet(store, g, [baseCandidate(g, {
      candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: initialCorr,
      replacementValues: { ...VALUES, closeAtoms: '1150' },
    })]);
    const viewR = realBaseView(g, root, {
      terminalCorrectionIds: [initialCorr], visibleCorrectionIds: [initialCorr],
      occupiedBarIdentityIds: [g.bars[0].barIdentityId],
    });
    const reportR = Candidate.validateMarketDataCandidateSet({ store, candidateSetId: setR.candidateSetId, baseView: viewR });
    const revision = Delta.publishValidatedMarketDataDelta({
      store, candidateSetId: setR.candidateSetId, validationReportId: reportR.validationReportId, baseView: viewR,
    });
    const revisionCorr = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
      store, deltaAssemblyManifestId: revision.deltaAssemblyManifestId,
    }).deltaAssemblyManifest.acceptedCorrectionIds[0];
    const withdrawalCandidate = { ...baseCandidate(g), candidateKind: 'BAR_WITHDRAWAL', targetCorrectionId: revisionCorr };
    delete withdrawalCandidate.replacementValues;
    const wSet = buildSet(store, g, [withdrawalCandidate]);
    const wView = realBaseView(g, root, {
      terminalCorrectionIds: [revisionCorr],
      visibleCorrectionIds: [initialCorr, revisionCorr].sort(),
      occupiedBarIdentityIds: [g.bars[0].barIdentityId],
    });
    const wReport = Candidate.validateMarketDataCandidateSet({ store, candidateSetId: wSet.candidateSetId, baseView: wView });
    const withdrawal = Delta.publishValidatedMarketDataDelta({
      store, candidateSetId: wSet.candidateSetId, validationReportId: wReport.validationReportId, baseView: wView,
    });
    const wCorr = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
      store, deltaAssemblyManifestId: withdrawal.deltaAssemblyManifestId,
    }).deltaAssemblyManifest.acceptedCorrectionIds[0];
    const fakeObs = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: Revision.MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
      value: Revision.normalizeMarketDataBarObservationCoreV1({
        schemaVersion: Revision.MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
        ingestionLineageId: g.lineage.ingestionLineageId, barIdentityId: g.bars[0].barIdentityId,
        sourceArtifactId: g.artifact.sourceArtifactId, acquisitionRecordId: g.acquisition.acquisitionRecordId,
        parseResultId: g.parseResult.parseResultId, sourceRowIndex: 0,
        sourceRowDigest: 'sha256:' + 'f'.repeat(64),
        values: { ...VALUES, closeAtoms: '1199' },
        calendarRegistryManifestId: g.calendarRegistry.calendarRegistryManifestId,
        marketValidTime: '2026-01-02T21:00:00.000Z', knowledgeMode: 'CAPTURE_TIME_ONLY',
        knowledgeTimeLowerBound: null, knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
        sourceTimestampEvidenceId: null, providerRevisionId: null,
      }),
    }).objectId;
    const restorationCandidate = {
      ...baseCandidate(g), candidateKind: 'BAR_RESTORATION',
      targetWithdrawalCorrectionId: wCorr, restoredObservationId: fakeObs,
    };
    delete restorationCandidate.targetCorrectionId;
    delete restorationCandidate.replacementValues;
    const rSet = buildSet(store, g, [restorationCandidate]);
    const rView = realBaseView(g, root, {
      terminalCorrectionIds: [wCorr],
      visibleCorrectionIds: [initialCorr, revisionCorr, wCorr].sort(),
      occupiedBarIdentityIds: [g.bars[0].barIdentityId],
    });
    const rReport = Candidate.validateMarketDataCandidateSet({ store, candidateSetId: rSet.candidateSetId, baseView: rView });
    assert.equal(rReport.validationReport.decisions[0].disposition, 'REJECTED');
    assert.deepEqual(rReport.validationReport.decisions[0].reasonCodes, ['MARKET_DATA_CORRECTION_CHAIN_INVALID']);
  });
  run('24 identical replay', () => expectThrow(() => appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: null,
    ingestionManifestId: first.ingestion.ingestionManifestId,
  })));
  run('25 non-authoritative CAS orphans', () => {
    const orphanPub = publishI2(store, graph, rootId, null);
    assert.equal(orphanPub.delta.status, 'PUBLISHED');
    assert.equal(tipForLineage(
      verifyMarketDataIngestionRegistry({ store, ingestionRegistryManifestId: rootId }).ingestionRegistryManifest,
      graph.lineage.ingestionLineageId,
    ), null);
    expectThrow(() => appendMarketDataIngestionRegistry({
      store,
      baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
      ingestionManifestId: buildIngestion(store, graph, rootId, null, orphanPub).ingestionManifestId,
    }));
  });
  run('26 append second lineage', () => {
    // Registry already holds two independent lineage tips; stealing lineage B tip must fail closed
    assert.equal(tipForLineage(other.registry.ingestionRegistryManifest, g2.lineage.ingestionLineageId),
      other.ingestion.ingestionManifestId);
    assert.equal(tipForLineage(other.registry.ingestionRegistryManifest, graph.lineage.ingestionLineageId),
      first.ingestion.ingestionManifestId);
    expectThrow(() => buildMarketDataIngestionRegistryManifest({
      store,
      registry: {
        schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
        ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
        supersedesIngestionRegistryManifestId: other.registry.ingestionRegistryManifestId,
        ingestionManifestIds: [...other.registry.ingestionRegistryManifest.ingestionManifestIds, child1.ingestionManifestId].sort(),
        lineageTips: [
          { ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: child1.ingestionManifestId },
          { ingestionLineageId: g2.lineage.ingestionLineageId, tipIngestionManifestId: child1.ingestionManifestId },
        ].sort((a, b) => a.ingestionLineageId.localeCompare(b.ingestionLineageId)),
      },
    }));
  });
  run('27 append altering other lineage', () => expectThrow(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: other.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [
        first.ingestion.ingestionManifestId, other.ingestion.ingestionManifestId, child1.ingestionManifestId,
      ].sort(),
      lineageTips: [
        { ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: child1.ingestionManifestId },
        // drop / replace other tip illegally with first
        { ingestionLineageId: g2.lineage.ingestionLineageId, tipIngestionManifestId: first.ingestion.ingestionManifestId },
      ].sort((a, b) => a.ingestionLineageId.localeCompare(b.ingestionLineageId)),
    },
  })));
  run('28 historical object in delta', () => expectThrow(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...nextBase,
      newBarObservationIds: [...first.ingestion.ingestionManifest.newBarObservationIds].sort(),
      newBarCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds].sort(),
    },
  })));
  run('29 implicit latest impossible', () => {
    assert.equal(typeof tipForLineage, 'function');
    // No API accepts omitted base registry; append without base key fails closed
    expectThrow(() => appendMarketDataIngestionRegistry({
      store,
      expectedParentIngestionManifestId: null,
      ingestionManifestId: first.ingestion.ingestionManifestId,
    }));
  });
  run('30 corrupted CAS reference', () => expectThrow(() => verifyMarketDataIngestionManifest({
    store, ingestionManifestId: 'sha256:' + '0'.repeat(64),
  })));
  run('31 foreign tip id', () => expectThrow(() => normalizeMarketDataIngestionRegistryManifestV1({
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
    supersedesIngestionRegistryManifestId: null,
    ingestionManifestIds: [first.ingestion.ingestionManifestId],
    lineageTips: [{ ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: ID_B }],
  })));
  run('32 indirect cycle', () => expectThrow(() => verifyMarketDataIngestionRegistry({
    store: mockStore(new Map([
      [ID_A, { ...empty, supersedesIngestionRegistryManifestId: ID_B }],
      [ID_B, { ...empty, supersedesIngestionRegistryManifestId: ID_A }],
      [ID_AUTH, authority],
    ])),
    ingestionRegistryManifestId: ID_A,
  })));

  const total = passed + failedNames.length;
  console.log(JSON.stringify({ total, passed, failed: failedNames.length, failedNames }));
  assert.equal(failedNames.length, 0, JSON.stringify(failedNames));
  assert.ok(total >= 30);
});
`;
  writeFileSync(harnessPath, source, 'utf8');
  const run = spawnSync(process.execPath, [harnessPath], { encoding: 'utf8' });
  try {
    assert.equal(run.status, 0, run.stderr + '\n' + run.stdout);
    const line = run.stdout.trim().split('\n').at(-1);
    const result = JSON.parse(line);
    assert.equal(result.failed, 0, JSON.stringify(result.failedNames));
    assert.ok(result.total >= 30);
    assert.equal(result.passed, result.total);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
