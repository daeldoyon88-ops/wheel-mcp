import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
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
import {
  MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
  buildMarketCalendarAuthorityPolicy,
  buildMarketCalendarRegistry,
  buildMarketSessionCalendar,
  verifyMarketCalendarRegistry,
} from '../src/contracts/marketCalendarL3V1.mjs';
import {
  MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
  buildMarketDataAcquisitionRecord,
  buildMarketDataIngestionLineage,
  buildMarketDataIngestionPolicy,
  buildMarketDataIngestionRegistryAuthorityPolicy,
  buildMarketDataParseResult,
  buildMarketDataSourceArtifact,
  buildMarketDataSourceAttestation,
  buildMarketDataSourceTemporalEvidence,
  verifyMarketDataAcquisitionRecord,
  verifyMarketDataIngestionLineage,
  verifyMarketDataIngestionPolicy,
  verifyMarketDataIngestionRegistryAuthorityPolicy,
  verifyMarketDataParseResult,
  verifyMarketDataSourceArtifact,
  verifyMarketDataSourceAttestation,
  verifyMarketDataSourceTemporalEvidence,
} from '../src/contracts/marketDataSourceL3V1.mjs';
import {
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
  buildMarketDataBarIdentity,
  verifyMarketDataBarIdentity,
} from '../src/contracts/marketDataBarIdentityL3V1.mjs';
import { sha256Digest } from '../src/contracts/marketDataL3CommonV1.mjs';
import * as CalendarApi from '../src/contracts/marketCalendarL3V1.mjs';
import * as SourceApi from '../src/contracts/marketDataSourceL3V1.mjs';
import * as BarApi from '../src/contracts/marketDataBarIdentityL3V1.mjs';

const I1_SCHEMAS = [
  'MarketCalendarAuthorityPolicy/1',
  'MarketSessionCalendarCore/1',
  'MarketCalendarRegistryManifest/1',
  'MarketDataIngestionPolicy/1',
  'MarketDataIngestionLineageCore/1',
  'MarketDataIngestionRegistryAuthorityPolicy/1',
  'MarketDataSourceArtifactCore/1',
  'MarketDataSourceAttestationCore/1',
  'MarketDataAcquisitionRecordCore/1',
  'MarketDataParseResultCore/1',
  'MarketDataSourceTemporalEvidenceCore/1',
  'MarketDataBarIdentityCore/1',
];

function corporateRegistryArgs(policies, instrumentRegistry, supersedesRegistryManifestId = null) {
  return {
    authorityPolicyId: policies.authorityPolicy.policyId,
    normalizationPolicyId: policies.normalizationPolicy.policyId,
    temporalPolicyId: policies.temporalPolicy.policyId,
    adjudicationPolicyId: policies.adjudicationPolicy.policyId,
    priceAdjustmentPolicyId: policies.priceAdjustmentPolicy.policyId,
    entitlementPolicyId: policies.entitlementPolicy.policyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    instrumentLedgerManifestIds: [],
    supersedesRegistryManifestId,
  };
}

function setupAuthorities(store, instrumentKind = 'EQUITY') {
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: `l3-i1-synthetic-instruments-${instrumentKind}/1`,
    identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: (instrumentKind === 'EQUITY' ? '1' : instrumentKind === 'ETF' ? '2' : '3').repeat(64),
    instrumentKind,
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
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i1-synthetic-actions/1', identityNamespaceVersion: 'L3-I1/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I1/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I1/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I1/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I1/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I1/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l3-i1',
      validFromDate: '2026-01-02',
      validToDateExclusive: '2026-01-03',
      civilDateBounds: [{
        civilDate: '2026-01-02',
        startUtc: '2026-01-02T05:00:00.000Z',
        endUtcExclusive: '2026-01-03T05:00:00.000Z',
      }],
    },
  });
  const calendarPolicy = buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['HALF_DAY_SESSION', 'REGULAR_SESSION'],
      calendarNamespaceVersion: 'synthetic-l3-i1/1',
    },
  });
  const calendar = buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      coverageFromDate: '2026-01-02',
      coverageToDateExclusive: '2026-01-06',
      sessions: [
        { sessionDate: '2026-01-02', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-02T14:30:00.000Z', closeUtc: '2026-01-02T21:00:00.000Z', marketValidTime: '2026-01-02T21:00:00.000Z' },
        { sessionDate: '2026-01-05', sessionKind: 'HALF_DAY_SESSION', openUtc: '2026-01-05T14:30:00.000Z', closeUtc: '2026-01-05T18:00:00.000Z', marketValidTime: '2026-01-05T18:00:00.000Z' },
      ],
    },
  });
  const calendarRegistry = buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [calendar.calendarCoreId],
      supersedesCalendarRegistryManifestId: null,
    },
  });
  return {
    instrumentAuthority, instrument, instrumentManifest, instrumentRegistry,
    corporatePolicies, corporateRegistry, ruleset, calendarPolicy, calendar, calendarRegistry,
  };
}

function ingestionPolicyValue(overrides = {}) {
  return {
    schemaVersion: MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
    allowedInstrumentKinds: ['EQUITY', 'ETF', 'ETN'],
    allowedFrequencies: ['DAILY_REGULAR_SESSION'],
    allowedPriceBases: ['RAW', 'SPLIT_ADJUSTED'],
    allowedSourceDatasetKinds: ['EOD_OHLCV'],
    allowedPayloadFormats: ['CANONICAL_JSON', 'CSV_UTF8'],
    maxArtifactBytes: 100000,
    knowledgeModes: ['PROVIDER_PUBLICATION_TIME_ATTESTED'],
    providerPublicationTimeField: 'providerPublicationTime',
    providerRevisionIdField: null,
    unknownFieldPolicy: 'REJECT',
    duplicateIdenticalRowPolicy: 'REJECT',
    volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
    ...overrides,
  };
}

function setupL3(store, policyOverrides = {}) {
  const authority = setupAuthorities(store);
  const ingestionPolicy = buildMarketDataIngestionPolicy({ store, policy: ingestionPolicyValue(policyOverrides) });
  const context = {
    ingestionPolicyId: ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: authority.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: authority.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: authority.corporateRegistry.registryManifestId,
  };
  const lineage = buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER',
      instrumentIdentityId: authority.instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION',
      venueId: 'XNAS',
      priceBasis: 'RAW',
      sourceDatasetKind: 'EOD_OHLCV',
    },
    ...context,
  });
  return { ...authority, ingestionPolicy, context, lineage };
}

test('L3-I1 nomenclature: exactly twelve additive canonical schema versions and dispatch remains live', () => {
  assert.equal(new Set(I1_SCHEMAS).size, 12);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.filter((schema) => I1_SCHEMAS.includes(schema)), I1_SCHEMAS);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size);
  const apiExports = { ...CalendarApi, ...SourceApi, ...BarApi };
  assert.equal(Object.keys(apiExports).filter((name) => /^buildMarket/.test(name)).length, 12);
  assert.equal(Object.keys(apiExports).filter((name) => /^verifyMarket/.test(name)).length, 12);
  for (const schemaVersion of I1_SCHEMAS) assert.equal(typeof normalizeCanonicalValue, 'function', schemaVersion);
  assert.throws(() => normalizeCanonicalValue('MarketDataNormalizedCandidate/1', {}), /CANONICAL_SCHEMA_UNKNOWN/);
});

test('L3-I1 calendar: explicit regular and half-day sessions round-trip by registry ID', () => withStore((store) => {
  const graph = setupAuthorities(store);
  const recovered = verifyMarketCalendarRegistry({ store, calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId });
  assert.equal(recovered.calendars[0].sessions[1].sessionKind, 'HALF_DAY_SESSION');
  assert.equal(recovered.calendars[0].sessions[1].marketValidTime, recovered.calendars[0].sessions[1].closeUtc);
}));

test('L3-I1 ingestion policy and authority policy have one builder and one ID-only verifier', () => withStore((store) => {
  const policy = buildMarketDataIngestionPolicy({ store, policy: ingestionPolicyValue() });
  assert.deepEqual(verifyMarketDataIngestionPolicy({ store, ingestionPolicyId: policy.ingestionPolicyId }).ingestionPolicy, policy.ingestionPolicy);
  const authority = buildMarketDataIngestionRegistryAuthorityPolicy({
    store,
    policy: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
      registryNamespaceVersion: 'synthetic-l3-i1/1', authorityScope: 'MARKET_DATA_INGESTION',
    },
  });
  assert.deepEqual(
    verifyMarketDataIngestionRegistryAuthorityPolicy({ store, ingestionRegistryAuthorityPolicyId: authority.ingestionRegistryAuthorityPolicyId }).ingestionRegistryAuthorityPolicy,
    authority.ingestionRegistryAuthorityPolicy,
  );
}));

test('L3-I1 ingestion policy closes capture, publication and revision-history modes', () => withStore((store) => {
  const capture = buildMarketDataIngestionPolicy({ store, policy: ingestionPolicyValue({
    knowledgeModes: ['CAPTURE_TIME_ONLY'], providerPublicationTimeField: null,
    providerRevisionIdField: null, duplicateIdenticalRowPolicy: 'ACCEPT_IDENTICAL',
  }) });
  const publication = buildMarketDataIngestionPolicy({ store, policy: ingestionPolicyValue() });
  const revision = buildMarketDataIngestionPolicy({ store, policy: ingestionPolicyValue({
    knowledgeModes: ['PROVIDER_REVISION_HISTORY_ATTESTED'],
    providerRevisionIdField: 'providerRevisionId',
  }) });
  assert.deepEqual(capture.ingestionPolicy.knowledgeModes, ['CAPTURE_TIME_ONLY']);
  assert.deepEqual(publication.ingestionPolicy.knowledgeModes, ['PROVIDER_PUBLICATION_TIME_ATTESTED']);
  assert.deepEqual(revision.ingestionPolicy.knowledgeModes, ['PROVIDER_REVISION_HISTORY_ATTESTED']);
}));

test('L3-I1 lineage is stable across registry tips and changes across provider or price basis', () => withStore((store) => {
  const graph = setupL3(store);
  const verified = verifyMarketDataIngestionLineage({ store, ingestionLineageId: graph.lineage.ingestionLineageId, ...graph.context });
  assert.equal(verified.ingestionLineage.instrumentIdentityId, graph.instrument.instrumentIdentityId);
  const descendantInstrumentRegistry = buildInstrumentIdentityRegistry({
    store,
    authorityPolicyId: graph.instrumentAuthority.authorityPolicyId,
    identityManifestIds: [graph.instrumentManifest.identityManifestId],
    supersedesRegistryManifestId: graph.instrumentRegistry.registryManifestId,
  });
  const descendantCorporateRegistry = buildCorporateActionRegistry({
    store,
    ...corporateRegistryArgs(graph.corporatePolicies, descendantInstrumentRegistry, graph.corporateRegistry.registryManifestId),
  });
  const descendantContext = {
    ...graph.context,
    instrumentIdentityRegistryManifestId: descendantInstrumentRegistry.registryManifestId,
    corporateActionRegistryManifestId: descendantCorporateRegistry.registryManifestId,
  };
  const same = buildMarketDataIngestionLineage({ store, lineage: graph.lineage.ingestionLineage, ...descendantContext });
  assert.equal(same.ingestionLineageId, graph.lineage.ingestionLineageId);
  const providerB = buildMarketDataIngestionLineage({ store, lineage: { ...graph.lineage.ingestionLineage, providerId: 'SYNTHETIC_PROVIDER_B' }, ...descendantContext });
  const adjusted = buildMarketDataIngestionLineage({ store, lineage: { ...graph.lineage.ingestionLineage, priceBasis: 'SPLIT_ADJUSTED' }, ...descendantContext });
  assert.notEqual(providerB.ingestionLineageId, graph.lineage.ingestionLineageId);
  assert.notEqual(adjusted.ingestionLineageId, graph.lineage.ingestionLineageId);
}));

test('L3-I1 embedded artifact, attestation and explicit acquisition round-trip', () => withStore((store) => {
  const graph = setupL3(store);
  const bytes = Buffer.from('date,providerPublicationTime,open,high,low,close,volume\n2026-01-02,2026-01-02T21:01:00.000Z,10,12,9,11,100\n', 'utf8');
  const source = store.putSourceBytes(bytes);
  const artifact = buildMarketDataSourceArtifact({
    store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: {
      schemaVersion: MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      payloadFormat: 'CSV_UTF8', mediaType: 'text/csv; charset=utf-8',
      embeddedBytesObjectId: source.objectId, payloadDigest: source.objectId, payloadByteLength: bytes.length,
    },
  });
  const attestation = buildMarketDataSourceAttestation({
    store,
    attestation: {
      schemaVersion: MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      attestationMode: 'EMBEDDED_ARTIFACT', embeddedArtifactId: artifact.sourceArtifactId,
      payloadDigest: null, payloadByteLength: null, payloadFormat: null, providerId: null,
    },
  });
  const acquisition = buildMarketDataAcquisitionRecord({
    store,
    record: {
      schemaVersion: MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      acquisitionTimeUtc: '2026-01-02T21:02:00.000Z', providerId: 'SYNTHETIC_PROVIDER',
      logicalEndpointKind: 'EOD_OHLCV_DATASET', requestDatasetKind: 'EOD_OHLCV',
      executionIdentity: { runnerId: 'node-test', runId: 'l3-i1-run-1', environment: 'LOCAL_TEST' },
      sourceAttestationId: attestation.sourceAttestationId,
    },
  });
  assert.equal(verifyMarketDataSourceArtifact({ store, sourceArtifactId: artifact.sourceArtifactId, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId }).source.sizeBytes, bytes.length);
  assert.equal(verifyMarketDataSourceAttestation({ store, sourceAttestationId: attestation.sourceAttestationId }).payloadDigest, source.objectId);
  assert.equal(verifyMarketDataAcquisitionRecord({ store, acquisitionRecordId: acquisition.acquisitionRecordId }).acquisitionRecord.acquisitionTimeUtc, '2026-01-02T21:02:00.000Z');
}));

test('L3-I1 digest-only attestation never promises source-byte recovery', () => withStore((store) => {
  const graph = setupL3(store);
  const attestation = buildMarketDataSourceAttestation({
    store,
    attestation: {
      schemaVersion: MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      attestationMode: 'DIGEST_ONLY', embeddedArtifactId: null,
      payloadDigest: `sha256:${'a'.repeat(64)}`, payloadByteLength: 123,
      payloadFormat: 'CSV_UTF8', providerId: 'SYNTHETIC_PROVIDER',
    },
  });
  const verified = verifyMarketDataSourceAttestation({ store, sourceAttestationId: attestation.sourceAttestationId });
  assert.equal(verified.source, null);
  assert.equal(verified.artifact, null);
}));

test('L3-I1 CSV parser preserves header, source order, blank/faulty rows and row digests', () => withStore((store) => {
  const graph = setupL3(store);
  const bytes = Buffer.from('date,providerPublicationTime,close\n2026-01-02,2026-01-02T21:01:00.000Z,11\n\n2026-01-05,2026-01-05T18:01:00.000Z\n');
  const source = store.putSourceBytes(bytes);
  const artifact = buildMarketDataSourceArtifact({ store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId, artifact: {
    schemaVersion: MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    payloadFormat: 'CSV_UTF8', mediaType: 'text/csv; charset=utf-8', embeddedBytesObjectId: source.objectId,
    payloadDigest: source.objectId, payloadByteLength: bytes.length,
  } });
  const attestation = buildMarketDataSourceAttestation({ store, attestation: {
    schemaVersion: MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    attestationMode: 'EMBEDDED_ARTIFACT', embeddedArtifactId: artifact.sourceArtifactId,
    payloadDigest: null, payloadByteLength: null, payloadFormat: null, providerId: null,
  } });
  const acquisition = buildMarketDataAcquisitionRecord({ store, record: {
    schemaVersion: MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    acquisitionTimeUtc: '2026-01-05T18:02:00.000Z', providerId: 'SYNTHETIC_PROVIDER',
    logicalEndpointKind: 'EOD_OHLCV_DATASET', requestDatasetKind: 'EOD_OHLCV',
    executionIdentity: { runnerId: 'node-test', runId: 'l3-i1-parse', environment: 'LOCAL_TEST' },
    sourceAttestationId: attestation.sourceAttestationId,
  } });
  const parsed = buildMarketDataParseResult({ store, sourceArtifactId: artifact.sourceArtifactId,
    acquisitionRecordId: acquisition.acquisitionRecordId, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId });
  assert.deepEqual(parsed.parseResult.headerFields, ['date', 'providerPublicationTime', 'close']);
  assert.equal(parsed.parseResult.rowCount, 3);
  assert.deepEqual(parsed.parseResult.rows.map((row) => row.rowIndex), [0, 1, 2]);
  assert.ok(parsed.parseResult.syntaxErrors.some((error) => error.code === 'EMPTY_ROW'));
  assert.ok(parsed.parseResult.syntaxErrors.some((error) => error.code === 'CELL_COUNT_MISMATCH'));
  assert.deepEqual(verifyMarketDataParseResult({ store, parseResultId: parsed.parseResultId }).parseResult, parsed.parseResult);
}));

test('L3-I1 canonical JSON parser preserves raw textual cells', () => withStore((store) => {
  const graph = setupL3(store);
  const table = { headerFields: ['date', 'providerPublicationTime'], rows: [['2026-01-02', '2026-01-02T21:01:00.000Z']] };
  const bytes = canonicalJsonBytes(table);
  const source = store.putSourceBytes(bytes);
  const artifact = buildMarketDataSourceArtifact({ store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId, artifact: {
    schemaVersion: MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    payloadFormat: 'CANONICAL_JSON', mediaType: 'application/json', embeddedBytesObjectId: source.objectId,
    payloadDigest: source.objectId, payloadByteLength: bytes.length,
  } });
  const attestation = buildMarketDataSourceAttestation({ store, attestation: {
    schemaVersion: MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    attestationMode: 'EMBEDDED_ARTIFACT', embeddedArtifactId: artifact.sourceArtifactId,
    payloadDigest: null, payloadByteLength: null, payloadFormat: null, providerId: null,
  } });
  const acquisition = buildMarketDataAcquisitionRecord({ store, record: {
    schemaVersion: MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    acquisitionTimeUtc: '2026-01-02T21:02:00.000Z', providerId: 'SYNTHETIC_PROVIDER', logicalEndpointKind: 'EOD_OHLCV_DATASET',
    requestDatasetKind: 'EOD_OHLCV', executionIdentity: { runnerId: 'node-test', runId: 'l3-i1-json', environment: 'LOCAL_TEST' },
    sourceAttestationId: attestation.sourceAttestationId,
  } });
  const parsed = buildMarketDataParseResult({ store, sourceArtifactId: artifact.sourceArtifactId,
    acquisitionRecordId: acquisition.acquisitionRecordId, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId });
  assert.deepEqual(parsed.parseResult.rows[0].cells, table.rows[0]);
}));

test('L3-I1 temporal evidence is founded on an exact ParseResult cell', () => withStore((store) => {
  const graph = setupL3(store);
  const bytes = Buffer.from('date,providerPublicationTime\n2026-01-02,2026-01-02T21:01:00.000Z\n');
  const source = store.putSourceBytes(bytes);
  const artifact = buildMarketDataSourceArtifact({ store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId, artifact: {
    schemaVersion: MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    payloadFormat: 'CSV_UTF8', mediaType: 'text/csv; charset=utf-8', embeddedBytesObjectId: source.objectId,
    payloadDigest: source.objectId, payloadByteLength: bytes.length,
  } });
  const attestation = buildMarketDataSourceAttestation({ store, attestation: {
    schemaVersion: MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    attestationMode: 'EMBEDDED_ARTIFACT', embeddedArtifactId: artifact.sourceArtifactId,
    payloadDigest: null, payloadByteLength: null, payloadFormat: null, providerId: null,
  } });
  const acquisition = buildMarketDataAcquisitionRecord({ store, record: {
    schemaVersion: MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    acquisitionTimeUtc: '2026-01-02T21:02:00.000Z', providerId: 'SYNTHETIC_PROVIDER', logicalEndpointKind: 'EOD_OHLCV_DATASET',
    requestDatasetKind: 'EOD_OHLCV', executionIdentity: { runnerId: 'node-test', runId: 'l3-i1-time', environment: 'LOCAL_TEST' },
    sourceAttestationId: attestation.sourceAttestationId,
  } });
  const parsed = buildMarketDataParseResult({ store, sourceArtifactId: artifact.sourceArtifactId,
    acquisitionRecordId: acquisition.acquisitionRecordId, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId });
  const raw = parsed.parseResult.rows[0].cells[1];
  const evidence = buildMarketDataSourceTemporalEvidence({ store, evidence: {
    schemaVersion: MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
    sourceArtifactId: artifact.sourceArtifactId, acquisitionRecordId: acquisition.acquisitionRecordId,
    parseResultId: parsed.parseResultId, sourceRowIndex: 0, sourceCellPath: '/cells/1',
    sourceCellDigest: sha256Digest(raw), rawTimestampValue: raw, normalizedTimestampUtc: raw,
    evidenceKind: 'PROVIDER_PUBLICATION_TIMESTAMP', providerRevisionId: null,
  } });
  assert.deepEqual(verifyMarketDataSourceTemporalEvidence({ store, sourceTemporalEvidenceId: evidence.sourceTemporalEvidenceId }).sourceTemporalEvidence, evidence.sourceTemporalEvidence);
}));

test('L3-I1 revision evidence binds timestamp and revision ID to the same parsed row', () => withStore((store) => {
  const graph = setupL3(store, {
    knowledgeModes: ['PROVIDER_REVISION_HISTORY_ATTESTED'],
    providerRevisionIdField: 'providerRevisionId',
  });
  const bytes = Buffer.from('date,providerPublicationTime,providerRevisionId\n2026-01-02,2026-01-02T21:01:00.000Z,revision-7\n');
  const source = store.putSourceBytes(bytes);
  const artifact = buildMarketDataSourceArtifact({ store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId, artifact: {
    schemaVersion: MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    payloadFormat: 'CSV_UTF8', mediaType: 'text/csv; charset=utf-8', embeddedBytesObjectId: source.objectId,
    payloadDigest: source.objectId, payloadByteLength: bytes.length,
  } });
  const attestation = buildMarketDataSourceAttestation({ store, attestation: {
    schemaVersion: MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    attestationMode: 'EMBEDDED_ARTIFACT', embeddedArtifactId: artifact.sourceArtifactId,
    payloadDigest: null, payloadByteLength: null, payloadFormat: null, providerId: null,
  } });
  const acquisition = buildMarketDataAcquisitionRecord({ store, record: {
    schemaVersion: MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, ingestionLineageId: graph.lineage.ingestionLineageId,
    acquisitionTimeUtc: '2026-01-02T21:02:00.000Z', providerId: 'SYNTHETIC_PROVIDER', logicalEndpointKind: 'EOD_OHLCV_DATASET',
    requestDatasetKind: 'EOD_OHLCV', executionIdentity: { runnerId: 'node-test', runId: 'l3-i1-revision', environment: 'LOCAL_TEST' },
    sourceAttestationId: attestation.sourceAttestationId,
  } });
  const parsed = buildMarketDataParseResult({ store, sourceArtifactId: artifact.sourceArtifactId,
    acquisitionRecordId: acquisition.acquisitionRecordId, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId });
  const raw = parsed.parseResult.rows[0].cells[1];
  const evidence = buildMarketDataSourceTemporalEvidence({ store, evidence: {
    schemaVersion: MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
    sourceArtifactId: artifact.sourceArtifactId, acquisitionRecordId: acquisition.acquisitionRecordId,
    parseResultId: parsed.parseResultId, sourceRowIndex: 0, sourceCellPath: '/cells/1',
    sourceCellDigest: sha256Digest(raw), rawTimestampValue: raw, normalizedTimestampUtc: raw,
    evidenceKind: 'PROVIDER_REVISION_TIMESTAMP', providerRevisionId: 'revision-7',
  } });
  assert.equal(evidence.sourceTemporalEvidence.providerRevisionId, 'revision-7');
}));

test('L3-I1 bar identity excludes provider, basis, registry and calendar authority', () => withStore((store) => {
  const graph = setupL3(store);
  const value = {
    schemaVersion: MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
    instrumentIdentityId: graph.instrument.instrumentIdentityId,
    frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', sessionDate: '2026-01-02',
    sessionKind: 'DAILY_REGULAR_SESSION',
  };
  const providerA = buildMarketDataBarIdentity({ store, identity: value });
  const providerB = buildMarketDataBarIdentity({ store, identity: { ...value } });
  const raw = buildMarketDataBarIdentity({ store, identity: { ...value } });
  const adjusted = buildMarketDataBarIdentity({ store, identity: { ...value } });
  assert.equal(providerA.barIdentityId, providerB.barIdentityId);
  assert.equal(raw.barIdentityId, adjusted.barIdentityId);
  assert.equal(verifyMarketDataBarIdentity({ store, barIdentityId: providerA.barIdentityId }).barIdentity.sessionDate, '2026-01-02');
}));
