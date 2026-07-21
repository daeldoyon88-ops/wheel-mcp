import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS, normalizeCanonicalValue } from '../src/canonical/canonicalSchemaRegistryV1.mjs';
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
  MARKET_DATA_INGESTION_REGISTRY_L3_SCHEMA_VERSIONS,
  appendMarketDataIngestionRegistry,
  buildMarketDataIngestionManifest,
  buildMarketDataIngestionRegistryManifest,
  deriveCorporateActionTreatment,
  deriveTemporalCapabilityFromDeltaObjects,
  deriveTemporalCapabilityFromKnowledgeModes,
  tipForLineage,
  verifyMarketDataIngestionManifest,
  verifyMarketDataIngestionRegistry,
  normalizeMarketDataIngestionManifestV1,
  normalizeMarketDataIngestionRegistryManifestV1,
} from '../src/contracts/marketDataIngestionRegistryL3V1.mjs';
import {
  runIngestion,
  MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1,
} from '../src/pipeline/runMarketDataIngestionL3V1.mjs';
import { addDays } from '../src/time/civilDate.mjs';

const I3_SCHEMAS = [
  'MarketDataIngestionManifest/1',
  'MarketDataIngestionRegistryManifest/1',
];

const VALUES = Object.freeze({
  openAtoms: '1000', highAtoms: '1200', lowAtoms: '900', closeAtoms: '1100',
  priceScale: 2, volumeAtoms: '100', volumeScale: 0, currency: 'USD', priceBasis: 'RAW',
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code);
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

/** L2B/L2C/calendar + CAPTURE_TIME_ONLY policy + empty root ingestion registry. */
function setupI3(store, options = {}) {
  const knowledgeModes = options.knowledgeModes ?? ['CAPTURE_TIME_ONLY'];
  const priceBasis = options.priceBasis ?? 'RAW';
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l3-i3-synthetic-instruments/1',
    identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: '5'.repeat(64), instrumentKind: 'EQUITY',
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
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i3-synthetic-actions/1', identityNamespaceVersion: 'L3-I3/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I3/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I3/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I3/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I3/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I3/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l3-i3',
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
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'synthetic-l3-i3/1',
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
  const policyFields = {
    schemaVersion: Source.MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
    allowedInstrumentKinds: ['EQUITY'], allowedFrequencies: ['DAILY_REGULAR_SESSION'],
    allowedPriceBases: ['RAW', 'SPLIT_ADJUSTED'], allowedSourceDatasetKinds: ['EOD_OHLCV'],
    allowedPayloadFormats: ['CSV_UTF8'], maxArtifactBytes: 100000,
    knowledgeModes,
    providerPublicationTimeField: knowledgeModes.some((m) => m !== 'CAPTURE_TIME_ONLY') ? 'providerPublicationTime' : null,
    providerRevisionIdField: knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED') ? 'providerRevisionId' : null,
    unknownFieldPolicy: 'REJECT', duplicateIdenticalRowPolicy: 'ACCEPT_IDENTICAL',
    volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
  };
  const ingestionPolicy = Source.buildMarketDataIngestionPolicy({ store, policy: policyFields });
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
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis,
      sourceDatasetKind: 'EOD_OHLCV',
    },
    ...context,
  });
  const registryAuthority = Source.buildMarketDataIngestionRegistryAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Source.MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
      registryNamespaceVersion: 'synthetic-l3-i3/1',
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
    ingestionPolicy, lineage, registryAuthority, rootRegistry, bars, sessions, context, priceBasis,
  };
}

function atomsHeader(policy) {
  const header = [...MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1];
  if (policy.knowledgeModes.some((m) => m !== 'CAPTURE_TIME_ONLY')) {
    header.push(policy.providerPublicationTimeField);
  }
  if (policy.knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED')) {
    header.push(policy.providerRevisionIdField);
  }
  return header;
}

function atomsRow(graph, sessionDate, overrides = {}) {
  const cells = {
    sessionDate,
    openAtoms: '1000', highAtoms: '1200', lowAtoms: '900', closeAtoms: '1100',
    priceScale: '2', volumeAtoms: '100', volumeScale: '0', currency: 'USD',
    knowledgeMode: 'CAPTURE_TIME_ONLY',
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
    ...overrides,
  };
  return atomsHeader(graph.ingestionPolicy.ingestionPolicy).map((field) => cells[field] ?? '');
}

function buildAtomsArtifact(store, graph, rows, runId = 'l3-i3-run') {
  const header = atomsHeader(graph.ingestionPolicy.ingestionPolicy);
  const bytes = Buffer.from([header.join(','), ...rows.map((r) => r.join(',')), ''].join('\n'));
  const source = store.putSourceBytes(bytes);
  const artifact = Source.buildMarketDataSourceArtifact({
    store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId, payloadFormat: 'CSV_UTF8',
      mediaType: 'text/csv; charset=utf-8', embeddedBytesObjectId: source.objectId,
      payloadDigest: source.objectId, payloadByteLength: bytes.length,
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
  return { artifact, attestation, acquisition, bytes };
}

function baseCandidate(graph, parseResult, overrides = {}) {
  const row = parseResult.parseResult.rows[0];
  return {
    schemaVersion: Candidate.MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
    candidateKind: 'BAR_INITIAL_VALUE', ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: graph.artifact.sourceArtifactId,
    acquisitionRecordId: graph.acquisition.acquisitionRecordId,
    parseResultId: parseResult.parseResultId, sourceRowIndex: 0,
    sourceRowDigest: row.rowDigest, knowledgeMode: 'CAPTURE_TIME_ONLY',
    knowledgeTimeLowerBound: null, knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
    sourceTimestampEvidenceId: null, providerRevisionId: null,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    marketValidTime: '2026-01-02T21:00:00.000Z', barIdentityId: graph.bars[0].barIdentityId,
    targetCorrectionId: null, replacementValues: { ...VALUES, priceBasis: graph.priceBasis },
    ...overrides,
  };
}

function attachI2Source(store, graph) {
  const built = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-02')]);
  Object.assign(graph, built);
  const parseResult = Source.buildMarketDataParseResult({
    store, sourceArtifactId: built.artifact.sourceArtifactId,
    acquisitionRecordId: built.acquisition.acquisitionRecordId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
  });
  graph.parseResult = parseResult;
  return graph;
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

function publishI2Delta(store, graph, registryId, parentId = null, candidateOverrides = {}) {
  const set = buildSet(store, graph, [baseCandidate(graph, graph.parseResult, candidateOverrides)]);
  const view = realBaseView(graph, registryId, {
    expectedParentIngestionManifestId: parentId,
    ...(parentId ? {} : {}),
  });
  if (parentId) {
    const parentManifest = verifyMarketDataIngestionManifest({
      store, ingestionManifestId: parentId,
    }).ingestionManifest;
    view.terminalCorrectionIds = [...parentManifest.newBarCorrectionIds];
    view.visibleCorrectionIds = [...parentManifest.newBarCorrectionIds];
    view.occupiedBarIdentityIds = [graph.bars[0].barIdentityId];
  }
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId,
    baseView: view,
  });
  return { set, report, delta, view };
}

function buildIngestionFromPublish(store, graph, registryId, parentId, published) {
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const newBarObservationIds = [...assembly.acceptedObservationIds].sort();
  const newBarCorrectionIds = [...assembly.acceptedCorrectionIds].sort();
  const temporalCapability = deriveTemporalCapabilityFromDeltaObjects(
    store, newBarObservationIds, newBarCorrectionIds,
  );
  const priceBasis = graph.lineage.ingestionLineage.priceBasis;
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
      newBarObservationIds,
      newBarCorrectionIds,
      temporalCapability,
      priceBasis,
      corporateActionTreatment: deriveCorporateActionTreatment(priceBasis),
    },
  });
}

function publishAndAppend(store, graph, registryId, parentId = null) {
  const published = publishI2Delta(store, graph, registryId, parentId);
  assert.equal(published.delta.status, 'PUBLISHED');
  const ingestion = buildIngestionFromPublish(store, graph, registryId, parentId, published);
  const registry = appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: parentId,
    ingestionManifestId: ingestion.ingestionManifestId,
  });
  return { published, ingestion, registry };
}

function secondLineage(store, graph, providerId = 'SYNTHETIC_PROVIDER_B') {
  const lineage = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId, instrumentIdentityId: graph.instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis: graph.priceBasis,
      sourceDatasetKind: 'EOD_OHLCV',
    },
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });
  const g2 = { ...graph, lineage, bars: [graph.bars[0]] };
  const built = buildAtomsArtifact(store, g2, [atomsRow(g2, '2026-01-02')], 'l3-i3-lineage-b');
  Object.assign(g2, built);
  g2.parseResult = Source.buildMarketDataParseResult({
    store, sourceArtifactId: built.artifact.sourceArtifactId,
    acquisitionRecordId: built.acquisition.acquisitionRecordId,
    ingestionPolicyId: g2.ingestionPolicy.ingestionPolicyId,
  });
  return g2;
}

function manifestTemplate(graph, registryId, published, overrides = {}) {
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store: null,
  });
  void assembly;
  const recovered = published._assembly || Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store: published._store, deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const newBarObservationIds = [...recovered.acceptedObservationIds].sort();
  const newBarCorrectionIds = [...recovered.acceptedCorrectionIds].sort();
  return {
    schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: null,
    supersedesIngestionManifestId: null,
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
    newBarObservationIds,
    newBarCorrectionIds,
    temporalCapability: deriveTemporalCapabilityFromKnowledgeModes(['CAPTURE_TIME_ONLY']),
    priceBasis: graph.priceBasis,
    corporateActionTreatment: deriveCorporateActionTreatment(graph.priceBasis),
    ...overrides,
  };
}

test('L3-I3 registers exactly two additive schemas (85 total after additive L4A-C1)', () => {
  assert.deepEqual(MARKET_DATA_INGESTION_REGISTRY_L3_SCHEMA_VERSIONS, I3_SCHEMAS);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 85);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 85);
  assert.deepEqual(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.filter((schema) => I3_SCHEMAS.includes(schema)),
    I3_SCHEMAS,
  );
  for (const schemaVersion of I3_SCHEMAS) {
    assert.equal(typeof normalizeCanonicalValue, 'function', schemaVersion);
  }
});

test('L3-I3 (1-2) first and next valid ingestion manifests append onto the tip', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const first = publishAndAppend(store, graph, rootId, null);
  assert.equal(first.ingestion.ingestionManifest.expectedParentIngestionManifestId, null);
  assert.equal(tipForLineage(first.registry.ingestionRegistryManifest, graph.lineage.ingestionLineageId),
    first.ingestion.ingestionManifestId);

  const nextSource = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05', {
    openAtoms: '1100', highAtoms: '1300', lowAtoms: '1000', closeAtoms: '1200',
  })], 'l3-i3-next');
  const nextGraph = {
    ...graph,
    artifact: nextSource.artifact,
    attestation: nextSource.attestation,
    acquisition: nextSource.acquisition,
    parseResult: Source.buildMarketDataParseResult({
      store, sourceArtifactId: nextSource.artifact.sourceArtifactId,
      acquisitionRecordId: nextSource.acquisition.acquisitionRecordId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    }),
    bars: [graph.bars[1]],
  };
  const published = publishI2Delta(store, nextGraph, first.registry.ingestionRegistryManifestId,
    first.ingestion.ingestionManifestId, {
      barIdentityId: graph.bars[1].barIdentityId,
      marketValidTime: '2026-01-05T21:00:00.000Z',
      replacementValues: { ...VALUES, openAtoms: '1100', highAtoms: '1300', lowAtoms: '1000', closeAtoms: '1200' },
    });
  // Parent tip already occupies bar0; next uses bar1 — clear occupied for bar1-only publish.
  const view = realBaseView(nextGraph, first.registry.ingestionRegistryManifestId, {
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
  });
  const parentManifest = first.ingestion.ingestionManifest;
  view.visibleCorrectionIds = [...parentManifest.newBarCorrectionIds];
  view.terminalCorrectionIds = [...parentManifest.newBarCorrectionIds];
  view.occupiedBarIdentityIds = [graph.bars[0].barIdentityId];
  view.publishedBarIdentityIds = [graph.bars[0].barIdentityId, graph.bars[1].barIdentityId].sort();
  const set = buildSet(store, nextGraph, [baseCandidate(nextGraph, nextGraph.parseResult, {
    barIdentityId: graph.bars[1].barIdentityId,
    marketValidTime: '2026-01-05T21:00:00.000Z',
    replacementValues: { ...VALUES, openAtoms: '1100', highAtoms: '1300', lowAtoms: '1000', closeAtoms: '1200' },
  })]);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId, baseView: view,
  });
  assert.equal(delta.status, 'PUBLISHED');
  const nextIngestion = buildIngestionFromPublish(store, nextGraph, first.registry.ingestionRegistryManifestId,
    first.ingestion.ingestionManifestId, { set, report, delta });
  const nextRegistry = appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
    ingestionManifestId: nextIngestion.ingestionManifestId,
  });
  assert.equal(nextIngestion.ingestionManifest.expectedParentIngestionManifestId,
    first.ingestion.ingestionManifestId);
  assert.equal(tipForLineage(nextRegistry.ingestionRegistryManifest, graph.lineage.ingestionLineageId),
    nextIngestion.ingestionManifestId);
  void published;
}));

test('L3-I3 (3-6) parent required, mismatch, stale base and foreign-lineage parent', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const first = publishAndAppend(store, graph, rootId, null);
  const published = publishI2Delta(store, graph, first.registry.ingestionRegistryManifestId, null);
  // Force another candidate set for a second valid-looking publish against stale root tip null assumption.
  const g2 = secondLineage(store, graph);
  const other = publishAndAppend(store, g2, first.registry.ingestionRegistryManifestId, null);

  // 3. tip exists but expectedParent null on next build against tip registry
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  expectCode(() => buildMarketDataIngestionManifest({
    store,
    manifest: {
      schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      expectedParentIngestionManifestId: null,
      supersedesIngestionManifestId: null,
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
      newBarObservationIds: [...assembly.acceptedObservationIds].sort(),
      newBarCorrectionIds: [...assembly.acceptedCorrectionIds].sort(),
      temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
      priceBasis: 'RAW',
      corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    },
  }), 'MARKET_DATA_INGESTION_PARENT_REQUIRED');

  // 4. parent mismatch (wrong non-null parent)
  const nextSource = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05')], 'mismatch');
  const nextGraph = {
    ...graph, ...nextSource,
    parseResult: Source.buildMarketDataParseResult({
      store, sourceArtifactId: nextSource.artifact.sourceArtifactId,
      acquisitionRecordId: nextSource.acquisition.acquisitionRecordId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    }),
    bars: [graph.bars[1]],
  };
  const view = realBaseView(nextGraph, first.registry.ingestionRegistryManifestId, {
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
    visibleCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds],
    terminalCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    publishedBarIdentityIds: [graph.bars[0].barIdentityId, graph.bars[1].barIdentityId].sort(),
  });
  const set = buildSet(store, nextGraph, [baseCandidate(nextGraph, nextGraph.parseResult, {
    barIdentityId: graph.bars[1].barIdentityId, marketValidTime: '2026-01-05T21:00:00.000Z',
  })]);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId, baseView: view,
  });
  const goodAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  expectCode(() => buildMarketDataIngestionManifest({
    store,
    manifest: {
      schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      expectedParentIngestionManifestId: other.ingestion.ingestionManifestId,
      supersedesIngestionManifestId: other.ingestion.ingestionManifestId,
      identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
      calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
      corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      sourceArtifactId: nextGraph.artifact.sourceArtifactId,
      sourceAttestationId: nextGraph.attestation.sourceAttestationId,
      acquisitionRecordId: nextGraph.acquisition.acquisitionRecordId,
      parseResultId: nextGraph.parseResult.parseResultId,
      candidateSetId: set.candidateSetId,
      validationReportId: report.validationReportId,
      acceptedCandidatePublicationManifestId: delta.publicationManifestId,
      deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
      newBarObservationIds: [...goodAssembly.acceptedObservationIds].sort(),
      newBarCorrectionIds: [...goodAssembly.acceptedCorrectionIds].sort(),
      temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
      priceBasis: 'RAW',
      corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    },
  }), 'MARKET_DATA_INGESTION_PARENT_MISMATCH');

  // 5. stale base: expected parent against empty tip of a fresh lineage registry
  expectCode(() => buildMarketDataIngestionManifest({
    store,
    manifest: {
      schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: rootId,
      expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
      supersedesIngestionManifestId: first.ingestion.ingestionManifestId,
      identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
      calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
      corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      sourceArtifactId: nextGraph.artifact.sourceArtifactId,
      sourceAttestationId: nextGraph.attestation.sourceAttestationId,
      acquisitionRecordId: nextGraph.acquisition.acquisitionRecordId,
      parseResultId: nextGraph.parseResult.parseResultId,
      candidateSetId: set.candidateSetId,
      validationReportId: report.validationReportId,
      acceptedCandidatePublicationManifestId: delta.publicationManifestId,
      deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
      newBarObservationIds: [...goodAssembly.acceptedObservationIds].sort(),
      newBarCorrectionIds: [...goodAssembly.acceptedCorrectionIds].sort(),
      temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
      priceBasis: 'RAW',
      corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    },
  }), 'MARKET_DATA_INGESTION_STALE_BASE');

  // 6. forged tip pointing at other lineage → KEY_MISMATCH
  const forgedRegistry = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    value: normalizeMarketDataIngestionRegistryManifestV1({
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: null,
      ingestionManifestIds: [other.ingestion.ingestionManifestId].sort(),
      lineageTips: [{
        ingestionLineageId: graph.lineage.ingestionLineageId,
        tipIngestionManifestId: other.ingestion.ingestionManifestId,
      }],
    }),
  });
  expectCode(() => verifyMarketDataIngestionRegistry({
    store, ingestionRegistryManifestId: forgedRegistry.objectId,
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
}));

test('L3-I3 (7-11) foreign source, CandidateSet, ValidationReport, publication and assembly', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const published = publishI2Delta(store, graph, rootId, null);
  assert.equal(published.delta.status, 'PUBLISHED');
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const base = {
    schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    baseIngestionRegistryManifestId: rootId,
    expectedParentIngestionManifestId: null,
    supersedesIngestionManifestId: null,
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
    newBarObservationIds: [...assembly.acceptedObservationIds].sort(),
    newBarCorrectionIds: [...assembly.acceptedCorrectionIds].sort(),
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
  };

  const foreign = secondLineage(store, graph);
  const foreignPub = publishI2Delta(store, foreign, rootId, null);
  assert.equal(foreignPub.delta.status, 'PUBLISHED');

  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, sourceAttestationId: foreign.attestation.sourceAttestationId },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, candidateSetId: foreignPub.set.candidateSetId },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, validationReportId: foreignPub.report.validationReportId },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, acceptedCandidatePublicationManifestId: foreignPub.delta.publicationManifestId },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, deltaAssemblyManifestId: foreignPub.delta.deltaAssemblyManifestId },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
}));

test('L3-I3 (12-15) omitted, extra and historical delta object membership', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const first = publishAndAppend(store, graph, rootId, null);
  const nextSource = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05')], 'delta-mem');
  const nextGraph = {
    ...graph, ...nextSource,
    parseResult: Source.buildMarketDataParseResult({
      store, sourceArtifactId: nextSource.artifact.sourceArtifactId,
      acquisitionRecordId: nextSource.acquisition.acquisitionRecordId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    }),
  };
  const view = realBaseView(nextGraph, first.registry.ingestionRegistryManifestId, {
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
    visibleCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds],
    terminalCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    publishedBarIdentityIds: [graph.bars[0].barIdentityId, graph.bars[1].barIdentityId].sort(),
  });
  const set = buildSet(store, nextGraph, [baseCandidate(nextGraph, nextGraph.parseResult, {
    barIdentityId: graph.bars[1].barIdentityId, marketValidTime: '2026-01-05T21:00:00.000Z',
  })]);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId, baseView: view,
  });
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const obs = [...assembly.acceptedObservationIds].sort();
  const corr = [...assembly.acceptedCorrectionIds].sort();
  const base = {
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
    candidateSetId: set.candidateSetId,
    validationReportId: report.validationReportId,
    acceptedCandidatePublicationManifestId: delta.publicationManifestId,
    deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
    newBarObservationIds: obs,
    newBarCorrectionIds: corr,
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
  };
  // 12 omitted observation (corrections remain → non-empty total)
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, newBarObservationIds: [] },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
  // 13 omitted correction (observations remain → non-empty total)
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, newBarCorrectionIds: [] },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
  // both empty → normalize rejects before closure
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, newBarObservationIds: [], newBarCorrectionIds: [] },
  }), 'MARKET_DATA_INPUT_INVALID');
  // 14 extra object
  const fakeObs = first.ingestion.ingestionManifest.newBarObservationIds[0];
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...base,
      newBarObservationIds: [...obs, fakeObs].sort(),
    },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
  // 15 historical object added as the entire delta
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: {
      ...base,
      newBarObservationIds: [...first.ingestion.ingestionManifest.newBarObservationIds].sort(),
      newBarCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds].sort(),
    },
  }), 'MARKET_DATA_INGESTION_KEY_MISMATCH');
}));

test('L3-I3 (16-18) fraudulent temporal capability and incoherent price/treatment', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const published = publishI2Delta(store, graph, rootId, null);
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const base = {
    schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    baseIngestionRegistryManifestId: rootId,
    expectedParentIngestionManifestId: null,
    supersedesIngestionManifestId: null,
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
    newBarObservationIds: [...assembly.acceptedObservationIds].sort(),
    newBarCorrectionIds: [...assembly.acceptedCorrectionIds].sort(),
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
  };
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, temporalCapability: 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED' },
  }), 'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH');
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, priceBasis: 'SPLIT_ADJUSTED', corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED' },
  }), 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH');
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED' },
  }), 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH');
}));

test('L3-I3 (19-22) empty root, first lineage, second lineage and append on tip', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const root = graph.rootRegistry;
  assert.deepEqual(root.ingestionRegistryManifest.ingestionManifestIds, []);
  assert.deepEqual(root.ingestionRegistryManifest.lineageTips, []);
  assert.equal(root.ingestionRegistryManifest.supersedesIngestionRegistryManifestId, null);

  const first = publishAndAppend(store, graph, root.ingestionRegistryManifestId, null);
  assert.equal(first.registry.ingestionRegistryManifest.ingestionManifestIds.length, 1);
  assert.equal(first.registry.ingestionRegistryManifest.lineageTips.length, 1);

  const g2 = secondLineage(store, graph);
  const second = publishAndAppend(store, g2, first.registry.ingestionRegistryManifestId, null);
  assert.equal(second.registry.ingestionRegistryManifest.lineageTips.length, 2);
  assert.equal(second.registry.ingestionRegistryManifest.ingestionManifestIds.length, 2);

  const nextSource = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05')], 'append-tip');
  const nextGraph = {
    ...graph, ...nextSource,
    parseResult: Source.buildMarketDataParseResult({
      store, sourceArtifactId: nextSource.artifact.sourceArtifactId,
      acquisitionRecordId: nextSource.acquisition.acquisitionRecordId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    }),
  };
  const view = realBaseView(nextGraph, second.registry.ingestionRegistryManifestId, {
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
    visibleCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds],
    terminalCorrectionIds: [...first.ingestion.ingestionManifest.newBarCorrectionIds],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    publishedBarIdentityIds: [graph.bars[0].barIdentityId, graph.bars[1].barIdentityId].sort(),
  });
  const set = buildSet(store, nextGraph, [baseCandidate(nextGraph, nextGraph.parseResult, {
    barIdentityId: graph.bars[1].barIdentityId, marketValidTime: '2026-01-05T21:00:00.000Z',
  })]);
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const delta = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: report.validationReportId, baseView: view,
  });
  const nextIngestion = buildIngestionFromPublish(store, nextGraph, second.registry.ingestionRegistryManifestId,
    first.ingestion.ingestionManifestId, { set, report, delta });
  const appended = appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: second.registry.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: first.ingestion.ingestionManifestId,
    ingestionManifestId: nextIngestion.ingestionManifestId,
  });
  assert.equal(appended.ingestionRegistryManifest.ingestionManifestIds.length, 3);
  assert.equal(
    tipForLineage(appended.ingestionRegistryManifest, graph.lineage.ingestionLineageId),
    nextIngestion.ingestionManifestId,
  );
  assert.equal(
    tipForLineage(appended.ingestionRegistryManifest, g2.lineage.ingestionLineageId),
    second.ingestion.ingestionManifestId,
  );
}));

test('L3-I3 (23-32) registry append-only, authority, cycles, tips, branch and append API pins', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const first = publishAndAppend(store, graph, graph.rootRegistry.ingestionRegistryManifestId, null);
  const reg = first.registry.ingestionRegistryManifest;
  const authId = reg.ingestionRegistryAuthorityPolicyId;

  // 23 historical removal
  expectCode(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: authId,
      supersedesIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [],
      lineageTips: [],
    },
  }), 'MARKET_DATA_INGESTION_APPEND_ONLY_VIOLATION');

  // 24 policy change
  const otherAuth = Source.buildMarketDataIngestionRegistryAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Source.MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
      registryNamespaceVersion: 'synthetic-l3-i3/other',
      authorityScope: 'MARKET_DATA_INGESTION',
    },
  });
  expectCode(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: otherAuth.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [...reg.ingestionManifestIds],
      lineageTips: [...reg.lineageTips],
    },
  }), 'MARKET_DATA_INGESTION_AUTHORITY_MISMATCH');

  // 25-26 registry cycles are covered by dedicated mock-store tests (CAS cannot mutual-cycle).

  // 27 foreign tip (not in ids)
  expectCode(() => normalizeMarketDataIngestionRegistryManifestV1({
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: authId,
    supersedesIngestionRegistryManifestId: null,
    ingestionManifestIds: [...reg.ingestionManifestIds],
    lineageTips: [{
      ingestionLineageId: graph.lineage.ingestionLineageId,
      tipIngestionManifestId: `sha256:${'c'.repeat(64)}`,
    }],
  }), 'MARKET_DATA_INGESTION_CHAIN_INVALID');

  // 28 duplicate tip lineage
  expectCode(() => normalizeMarketDataIngestionRegistryManifestV1({
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: authId,
    supersedesIngestionRegistryManifestId: null,
    ingestionManifestIds: [...reg.ingestionManifestIds],
    lineageTips: [
      { ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: first.ingestion.ingestionManifestId },
      { ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: first.ingestion.ingestionManifestId },
    ],
  }), 'MARKET_DATA_INPUT_INVALID');

  // 29 branch: two children of same parent listed
  const childA = first.ingestion;
  const nextSource = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05')], 'branch-a');
  const nextGraph = {
    ...graph, ...nextSource,
    parseResult: Source.buildMarketDataParseResult({
      store, sourceArtifactId: nextSource.artifact.sourceArtifactId,
      acquisitionRecordId: nextSource.acquisition.acquisitionRecordId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    }),
  };
  const view = realBaseView(nextGraph, first.registry.ingestionRegistryManifestId, {
    expectedParentIngestionManifestId: childA.ingestionManifestId,
    visibleCorrectionIds: [...childA.ingestionManifest.newBarCorrectionIds],
    terminalCorrectionIds: [...childA.ingestionManifest.newBarCorrectionIds],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    publishedBarIdentityIds: [graph.bars[0].barIdentityId, graph.bars[1].barIdentityId].sort(),
  });
  const setA = buildSet(store, nextGraph, [baseCandidate(nextGraph, nextGraph.parseResult, {
    barIdentityId: graph.bars[1].barIdentityId, marketValidTime: '2026-01-05T21:00:00.000Z',
  })]);
  const reportA = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: setA.candidateSetId, baseView: view,
  });
  const deltaA = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: setA.candidateSetId, validationReportId: reportA.validationReportId, baseView: view,
  });
  const branchChild1 = buildIngestionFromPublish(store, nextGraph, first.registry.ingestionRegistryManifestId,
    childA.ingestionManifestId, { set: setA, report: reportA, delta: deltaA });
  const nextSourceB = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-06')], 'branch-b');
  const nextGraphB = {
    ...graph, ...nextSourceB,
    parseResult: Source.buildMarketDataParseResult({
      store, sourceArtifactId: nextSourceB.artifact.sourceArtifactId,
      acquisitionRecordId: nextSourceB.acquisition.acquisitionRecordId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    }),
  };
  const viewB = realBaseView(nextGraphB, first.registry.ingestionRegistryManifestId, {
    expectedParentIngestionManifestId: childA.ingestionManifestId,
    visibleCorrectionIds: [...childA.ingestionManifest.newBarCorrectionIds],
    terminalCorrectionIds: [...childA.ingestionManifest.newBarCorrectionIds],
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    publishedBarIdentityIds: [graph.bars[0].barIdentityId, graph.bars[2].barIdentityId].sort(),
  });
  const setB = buildSet(store, nextGraphB, [baseCandidate(nextGraphB, nextGraphB.parseResult, {
    barIdentityId: graph.bars[2].barIdentityId, marketValidTime: '2026-01-06T21:00:00.000Z',
  })]);
  const reportB = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: setB.candidateSetId, baseView: viewB,
  });
  const deltaB = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: setB.candidateSetId, validationReportId: reportB.validationReportId, baseView: viewB,
  });
  const branchChild2 = buildIngestionFromPublish(store, nextGraphB, first.registry.ingestionRegistryManifestId,
    childA.ingestionManifestId, { set: setB, report: reportB, delta: deltaB });
  expectCode(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: authId,
      supersedesIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
      ingestionManifestIds: [
        childA.ingestionManifestId, branchChild1.ingestionManifestId, branchChild2.ingestionManifestId,
      ].sort(),
      lineageTips: [{
        ingestionLineageId: graph.lineage.ingestionLineageId,
        tipIngestionManifestId: branchChild1.ingestionManifestId,
      }],
    },
  }), 'MARKET_DATA_INGESTION_BRANCH');

  // 30 missing parent registry
  expectCode(() => buildMarketDataIngestionRegistryManifest({
    store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: authId,
      supersedesIngestionRegistryManifestId: `sha256:${'d'.repeat(64)}`,
      ingestionManifestIds: [...reg.ingestionManifestIds],
      lineageTips: [...reg.lineageTips],
    },
  }), 'MARKET_DATA_REFERENCE_MISSING');

  // 31 omitted expected parent key
  expectCode(() => appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
    ingestionManifestId: branchChild1.ingestionManifestId,
  }), 'MARKET_DATA_INPUT_INVALID');

  // 32 stale expected parent on append (tip is first; claiming null mismatches the tip/manifest)
  expectCode(() => appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: first.registry.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: null,
    ingestionManifestId: branchChild1.ingestionManifestId,
  }), 'MARKET_DATA_INGESTION_PARENT_MISMATCH');
}));

test('L3-I3 (33-39) runIngestion publish, no-op, fatal, idempotence and authority boundary', () => withStore((store) => {
  const graph = setupI3(store);
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const firstArt = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-02')], 'run-1');
  const first = runIngestion({
    store,
    baseIngestionRegistryManifestId: rootId,
    expectedParentIngestionManifestId: null,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: firstArt.artifact.sourceArtifactId,
    sourceAttestationId: firstArt.attestation.sourceAttestationId,
    acquisitionRecordId: firstArt.acquisition.acquisitionRecordId,
  });
  assert.equal(first.status, 'PUBLISHED');
  assert.ok(first.ingestionManifestId);
  assert.notEqual(first.ingestionRegistryManifestId, rootId);

  const nextArt = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05', {
    openAtoms: '1100', highAtoms: '1300', lowAtoms: '1000', closeAtoms: '1200',
  })], 'run-2');
  const second = runIngestion({
    store,
    baseIngestionRegistryManifestId: first.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: first.ingestionManifestId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: nextArt.artifact.sourceArtifactId,
    sourceAttestationId: nextArt.attestation.sourceAttestationId,
    acquisitionRecordId: nextArt.acquisition.acquisitionRecordId,
  });
  assert.equal(second.status, 'PUBLISHED');
  assert.notEqual(second.ingestionManifestId, first.ingestionManifestId);

  // 35 duplicate-only → no-op
  const dupArt = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-02')], 'run-dup');
  const dup = runIngestion({
    store,
    baseIngestionRegistryManifestId: second.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: second.ingestionManifestId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: dupArt.artifact.sourceArtifactId,
    sourceAttestationId: dupArt.attestation.sourceAttestationId,
    acquisitionRecordId: dupArt.acquisition.acquisitionRecordId,
  });
  assert.equal(dup.status, 'NO_AUTHORITATIVE_DELTA');
  assert.equal(dup.ingestionManifestId, null);
  assert.equal(dup.ingestionRegistryManifestId, second.ingestionRegistryManifestId);

  // 36 zero accepted non-fatal (occupied conflict without duplicate digest match)
  const conflictArt = buildAtomsArtifact(store, graph, [atomsRow(graph, '2026-01-05', {
    openAtoms: '9999', highAtoms: '9999', lowAtoms: '9000', closeAtoms: '9500',
  })], 'run-conflict');
  const conflict = runIngestion({
    store,
    baseIngestionRegistryManifestId: second.ingestionRegistryManifestId,
    expectedParentIngestionManifestId: second.ingestionManifestId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    sourceArtifactId: conflictArt.artifact.sourceArtifactId,
    sourceAttestationId: conflictArt.attestation.sourceAttestationId,
    acquisitionRecordId: conflictArt.acquisition.acquisitionRecordId,
  });
  assert.equal(conflict.status, 'NO_AUTHORITATIVE_DELTA');


  // 37 fatal → MARKET_DATA_VALIDATION_FAILED via same I2 publisher path runIngestion uses
  {
    const parent = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: Revision.normalizeMarketDataBarCorrectionCoreV1({
        schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
        correctionKind: 'INITIAL_ROOT',
        ingestionLineageId: graph.lineage.ingestionLineageId,
        barIdentityId: graph.bars[0].barIdentityId,
        parentCorrectionId: null,
        observationId: graph.ingestionPolicy.ingestionPolicyId,
        restoredObservationId: null,
        sessionDateLink: null,
        sourceArtifactId: firstArt.artifact.sourceArtifactId,
        acquisitionRecordId: firstArt.acquisition.acquisitionRecordId,
        parseResultId: Source.buildMarketDataParseResult({
          store,
          sourceArtifactId: firstArt.artifact.sourceArtifactId,
          acquisitionRecordId: firstArt.acquisition.acquisitionRecordId,
          ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
        }).parseResultId,
        sourceRowIndex: 0,
        sourceRowDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        knowledgeMode: 'CAPTURE_TIME_ONLY',
        knowledgeTimeLowerBound: null,
        knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
        sourceTimestampEvidenceId: null,
        providerRevisionId: null,
      }),
    }).objectId;
    const child = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: Revision.normalizeMarketDataBarCorrectionCoreV1({
        schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
        correctionKind: 'VALUE_REVISION',
        ingestionLineageId: graph.lineage.ingestionLineageId,
        barIdentityId: graph.bars[0].barIdentityId,
        parentCorrectionId: parent,
        observationId: graph.ingestionPolicy.ingestionPolicyId,
        restoredObservationId: null,
        sessionDateLink: null,
        sourceArtifactId: firstArt.artifact.sourceArtifactId,
        acquisitionRecordId: firstArt.acquisition.acquisitionRecordId,
        parseResultId: Source.buildMarketDataParseResult({
          store,
          sourceArtifactId: firstArt.artifact.sourceArtifactId,
          acquisitionRecordId: firstArt.acquisition.acquisitionRecordId,
          ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
        }).parseResultId,
        sourceRowIndex: 0,
        sourceRowDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        knowledgeMode: 'CAPTURE_TIME_ONLY',
        knowledgeTimeLowerBound: null,
        knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
        sourceTimestampEvidenceId: null,
        providerRevisionId: null,
      }),
    }).objectId;
    const gFatal = attachI2Source(store, setupI3(store));
    const setFatal = buildSet(store, gFatal, [baseCandidate(gFatal, gFatal.parseResult, {
      candidateKind: 'BAR_VALUE_REVISION',
      targetCorrectionId: parent,
      replacementValues: { ...VALUES, closeAtoms: '1180' },
    })]);
    const viewFatal = realBaseView(gFatal, gFatal.rootRegistry.ingestionRegistryManifestId, {
      terminalCorrectionIds: [parent],
      visibleCorrectionIds: [parent, child].sort(),
    });
    const reportFatal = Candidate.validateMarketDataCandidateSet({
      store, candidateSetId: setFatal.candidateSetId, baseView: viewFatal,
    });
    assert.ok(reportFatal.validationReport.fatalErrors.includes('MARKET_DATA_BAR_REVISION_BRANCH'));
    expectCode(() => Delta.publishValidatedMarketDataDelta({
      store,
      candidateSetId: setFatal.candidateSetId,
      validationReportId: reportFatal.validationReportId,
      baseView: viewFatal,
    }), 'MARKET_DATA_VALIDATION_FAILED');
  }

  // 38 idempotence of identical first publish IDs
  const graph2 = setupI3(store);
  // Can't reuse same store cleanly for identical CAS — replay same bytes on fresh root:
  const root2 = graph2.rootRegistry.ingestionRegistryManifestId;
  const artA = buildAtomsArtifact(store, graph2, [atomsRow(graph2, '2026-01-02')], 'idem-1');
  const r1 = runIngestion({
    store,
    baseIngestionRegistryManifestId: root2,
    expectedParentIngestionManifestId: null,
    ingestionPolicyId: graph2.ingestionPolicy.ingestionPolicyId,
    ingestionLineageId: graph2.lineage.ingestionLineageId,
    sourceArtifactId: artA.artifact.sourceArtifactId,
    sourceAttestationId: artA.attestation.sourceAttestationId,
    acquisitionRecordId: artA.acquisition.acquisitionRecordId,
  });
  const artB = buildAtomsArtifact(store, graph2, [atomsRow(graph2, '2026-01-02')], 'idem-1');
  // Same runId → same acquisition identity → same acquisition id when other fields match
  assert.equal(artB.acquisition.acquisitionRecordId, artA.acquisition.acquisitionRecordId);
  assert.equal(artB.artifact.sourceArtifactId, artA.artifact.sourceArtifactId);
  const r2 = runIngestion({
    store,
    baseIngestionRegistryManifestId: root2,
    expectedParentIngestionManifestId: null,
    ingestionPolicyId: graph2.ingestionPolicy.ingestionPolicyId,
    ingestionLineageId: graph2.lineage.ingestionLineageId,
    sourceArtifactId: artB.artifact.sourceArtifactId,
    sourceAttestationId: artB.attestation.sourceAttestationId,
    acquisitionRecordId: artB.acquisition.acquisitionRecordId,
  });
  assert.equal(r1.ingestionManifestId, r2.ingestionManifestId);
  assert.equal(r1.ingestionRegistryManifestId, r2.ingestionRegistryManifestId);

  // 39 no authority before new registry: I2 objects exist without tip until append
  const graph3 = attachI2Source(store, setupI3(store));
  const publishedOnly = publishI2Delta(store, graph3, graph3.rootRegistry.ingestionRegistryManifestId, null);
  assert.equal(publishedOnly.delta.status, 'PUBLISHED');
  const tipBefore = tipForLineage(
    verifyMarketDataIngestionRegistry({
      store, ingestionRegistryManifestId: graph3.rootRegistry.ingestionRegistryManifestId,
    }).ingestionRegistryManifest,
    graph3.lineage.ingestionLineageId,
  );
  assert.equal(tipBefore, null);
}));

test('L3-I3 (40-43) hardened I2 publisher mandatory: forged report, contradictory terminal, non-ancestral restoration', () => withStore((store) => {
  const graph = attachI2Source(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const set = buildSet(store, graph, [baseCandidate(graph, graph.parseResult)]);
  const view = realBaseView(graph, rootId, { occupiedBarIdentityIds: [graph.bars[0].barIdentityId] });
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
      baseIngestionRegistryManifestId: rootId,
      expectedParentIngestionManifestId: null,
      decisions: [{ candidateId: set.candidateSet.candidateIds[0], disposition: 'ACCEPTED', reasonCodes: [] }],
      fatalErrors: [], warnings: [],
    },
  });
  expectCode(() => Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId, validationReportId: forged.validationReportId, baseView: view,
  }), 'MARKET_DATA_VALIDATION_FAILED');

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
      sourceRowDigest: graph.parseResult.parseResult.rows[0].rowDigest,
      knowledgeMode: 'CAPTURE_TIME_ONLY', knowledgeTimeLowerBound: null,
      knowledgeTimeUpperBound: '2026-01-07T00:00:00.000Z',
      sourceTimestampEvidenceId: null, providerRevisionId: null,
    }),
  }).objectId;
  const branchSet = buildSet(store, graph, [baseCandidate(graph, graph.parseResult, {
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: parent,
    replacementValues: { ...VALUES, closeAtoms: '1180' },
  })]);
  const wrongBuilt = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: branchSet.candidateSetId,
    baseView: realBaseView(graph, rootId, {
      terminalCorrectionIds: [parent],
      visibleCorrectionIds: [parent, child].sort(),
    }),
  });
  assert.ok(wrongBuilt.validationReport.fatalErrors.includes('MARKET_DATA_BAR_REVISION_BRANCH'));
  expectCode(() => Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: branchSet.candidateSetId,
    validationReportId: wrongBuilt.validationReportId,
    baseView: realBaseView(graph, rootId, {
      terminalCorrectionIds: [parent],
      visibleCorrectionIds: [parent, child].sort(),
    }),
  }), 'MARKET_DATA_VALIDATION_FAILED');

  const initial = publishI2Delta(store, graph, rootId, null);
  const initialAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: initial.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const initialCorrectionId = initialAssembly.acceptedCorrectionIds[0];
  const revision = (() => {
    const setR = buildSet(store, graph, [baseCandidate(graph, graph.parseResult, {
      candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId: initialCorrectionId,
      replacementValues: { ...VALUES, closeAtoms: '1150' },
    })]);
    const viewR = realBaseView(graph, rootId, {
      terminalCorrectionIds: [initialCorrectionId], visibleCorrectionIds: [initialCorrectionId],
      occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
    });
    const reportR = Candidate.validateMarketDataCandidateSet({
      store, candidateSetId: setR.candidateSetId, baseView: viewR,
    });
    return Delta.publishValidatedMarketDataDelta({
      store, candidateSetId: setR.candidateSetId, validationReportId: reportR.validationReportId, baseView: viewR,
    });
  })();
  const revisionAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: revision.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const revisionCorrectionId = revisionAssembly.acceptedCorrectionIds[0];
  const withdrawalCandidate = {
    ...baseCandidate(graph, graph.parseResult),
    candidateKind: 'BAR_WITHDRAWAL', targetCorrectionId: revisionCorrectionId,
  };
  delete withdrawalCandidate.replacementValues;
  const withdrawalSet = buildSet(store, graph, [withdrawalCandidate]);
  const withdrawalView = realBaseView(graph, rootId, {
    terminalCorrectionIds: [revisionCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  });
  const withdrawalReport = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: withdrawalSet.candidateSetId, baseView: withdrawalView,
  });
  const withdrawal = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: withdrawalSet.candidateSetId,
    validationReportId: withdrawalReport.validationReportId, baseView: withdrawalView,
  });
  const withdrawalAssembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: withdrawal.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const withdrawalCorrectionId = withdrawalAssembly.acceptedCorrectionIds[0];
  const fakeObs = store.putCanonicalObject({
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
      sourceRowDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
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
  const restorationCandidate = {
    ...baseCandidate(graph, graph.parseResult),
    candidateKind: 'BAR_RESTORATION',
    targetWithdrawalCorrectionId: withdrawalCorrectionId,
    restoredObservationId: fakeObs,
  };
  delete restorationCandidate.targetCorrectionId;
  delete restorationCandidate.replacementValues;
  const restorationSet = buildSet(store, graph, [restorationCandidate]);
  const restorationView = realBaseView(graph, rootId, {
    terminalCorrectionIds: [withdrawalCorrectionId],
    visibleCorrectionIds: [initialCorrectionId, revisionCorrectionId, withdrawalCorrectionId].sort(),
    occupiedBarIdentityIds: [graph.bars[0].barIdentityId],
  });
  const restorationReport = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: restorationSet.candidateSetId, baseView: restorationView,
  });
  assert.equal(restorationReport.validationReport.decisions[0].disposition, 'REJECTED');
  const restorationPub = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: restorationSet.candidateSetId,
    validationReportId: restorationReport.validationReportId, baseView: restorationView,
  });
  assert.equal(restorationPub.status, 'NO_AUTHORITATIVE_DELTA');
}));


test('L3-I3 (25-26) registry supersedes chain detects direct and indirect cycles via mock store', () => {
  const ID_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ID_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const ID_AUTH = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const authority = {
    schemaVersion: Source.MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: 'mock-i3-cycle/1',
    authorityScope: 'MARKET_DATA_INGESTION',
  };
  const emptyRoot = {
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: ID_AUTH,
    supersedesIngestionRegistryManifestId: null,
    ingestionManifestIds: [],
    lineageTips: [],
  };
  const direct = {
    ...emptyRoot,
    supersedesIngestionRegistryManifestId: ID_A,
  };
  const a = {
    ...emptyRoot,
    supersedesIngestionRegistryManifestId: ID_B,
  };
  const b = {
    ...emptyRoot,
    supersedesIngestionRegistryManifestId: ID_A,
  };
  function mockStore(values) {
    return {
      uriForObject: ({ objectId }) => objectId,
      readObject: ({ expectedObjectId }) => ({ bytes: canonicalJsonBytes(values.get(expectedObjectId)) }),
      readCanonicalObject: ({ expectedObjectId }) => ({ value: values.get(expectedObjectId) }),
    };
  }
  expectCode(() => verifyMarketDataIngestionRegistry({
    store: mockStore(new Map([[ID_A, direct], [ID_AUTH, authority]])),
    ingestionRegistryManifestId: ID_A,
  }), 'MARKET_DATA_INGESTION_REGISTRY_CYCLE');
  expectCode(() => verifyMarketDataIngestionRegistry({
    store: mockStore(new Map([[ID_A, a], [ID_B, b], [ID_AUTH, authority]])),
    ingestionRegistryManifestId: ID_A,
  }), 'MARKET_DATA_INGESTION_REGISTRY_CYCLE');
});

test('L3-I3 temporal capability derivation and mismatch guards', () => withStore((store) => {
  assert.equal(
    deriveTemporalCapabilityFromKnowledgeModes(['PROVIDER_REVISION_HISTORY_ATTESTED']),
    'POINT_IN_TIME_REVISION_HISTORY_ATTESTED',
  );
  assert.equal(
    deriveTemporalCapabilityFromKnowledgeModes([
      'PROVIDER_PUBLICATION_TIME_ATTESTED', 'PROVIDER_REVISION_HISTORY_ATTESTED',
    ]),
    'POINT_IN_TIME_PUBLICATION_ATTESTED',
  );
  assert.equal(
    deriveTemporalCapabilityFromKnowledgeModes([
      'CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED', 'PROVIDER_REVISION_HISTORY_ATTESTED',
    ]),
    'RETROSPECTIVE_CAPTURE_ONLY',
  );
  expectCode(() => deriveTemporalCapabilityFromKnowledgeModes([]),
    'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH');
  expectCode(() => deriveTemporalCapabilityFromKnowledgeModes(['WALL_CLOCK']),
    'MARKET_DATA_KNOWLEDGE_MODE_INVALID');

  const graph = attachI2Source(store, setupI3(store));
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const published = publishI2Delta(store, graph, rootId, null);
  const assembly = Delta.recoverNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: published.delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  const obs = assembly.acceptedObservationIds;
  const corr = assembly.acceptedCorrectionIds;
  assert.equal(deriveTemporalCapabilityFromDeltaObjects(store, obs, []), 'RETROSPECTIVE_CAPTURE_ONLY');
  assert.equal(deriveTemporalCapabilityFromDeltaObjects(store, [], corr), 'RETROSPECTIVE_CAPTURE_ONLY');

  const base = {
    schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    baseIngestionRegistryManifestId: rootId,
    expectedParentIngestionManifestId: null,
    supersedesIngestionManifestId: null,
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
    newBarObservationIds: [...obs].sort(),
    newBarCorrectionIds: [...corr].sort(),
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
  };
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED' },
  }), 'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH');
  expectCode(() => buildMarketDataIngestionManifest({
    store, manifest: { ...base, temporalCapability: 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED' },
  }), 'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH');
  assert.equal(normalizeMarketDataIngestionManifestV1(base).temporalCapability, 'RETROSPECTIVE_CAPTURE_ONLY');
}));
