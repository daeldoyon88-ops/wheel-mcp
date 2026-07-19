import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  buildInstrumentIdentity, buildInstrumentIdentityAuthorityPolicy,
  buildInstrumentIdentityManifest, buildInstrumentIdentityRegistry,
} from '../src/data/buildInstrumentIdentity.mjs';
import {
  buildCorporateActionPolicies, buildCorporateActionRegistry, buildTimeZoneRuleset,
} from '../src/data/buildCorporateAction.mjs';
import { withStore } from './l2aSyntheticPipeline.mjs';
import * as Calendar from '../src/contracts/marketCalendarL3V1.mjs';
import * as Source from '../src/contracts/marketDataSourceL3V1.mjs';
import * as Bar from '../src/contracts/marketDataBarIdentityL3V1.mjs';
import { MarketDataL3Error } from '../src/contracts/marketDataL3CommonV1.mjs';

const ID_A = `sha256:${'a'.repeat(64)}`;
const ID_B = `sha256:${'b'.repeat(64)}`;
const ID_C = `sha256:${'c'.repeat(64)}`;
const ID_D = `sha256:${'d'.repeat(64)}`;

function code(error) { return error?.code; }
function expectCode(fn, expected) { assert.throws(fn, (error) => error instanceof MarketDataL3Error && code(error) === expected); }

function corporateRegistryArgs(policies, instrumentRegistry) {
  return {
    authorityPolicyId: policies.authorityPolicy.policyId,
    normalizationPolicyId: policies.normalizationPolicy.policyId,
    temporalPolicyId: policies.temporalPolicy.policyId,
    adjudicationPolicyId: policies.adjudicationPolicy.policyId,
    priceAdjustmentPolicyId: policies.priceAdjustmentPolicy.policyId,
    entitlementPolicyId: policies.entitlementPolicy.policyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    instrumentLedgerManifestIds: [], supersedesRegistryManifestId: null,
  };
}

function policyValue(overrides = {}) {
  return {
    schemaVersion: Source.MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
    allowedInstrumentKinds: ['EQUITY'],
    allowedFrequencies: ['DAILY_REGULAR_SESSION'],
    allowedPriceBases: ['RAW'],
    allowedSourceDatasetKinds: ['EOD_OHLCV'],
    allowedPayloadFormats: ['CSV_UTF8'],
    maxArtifactBytes: 10000,
    knowledgeModes: ['PROVIDER_PUBLICATION_TIME_ATTESTED'],
    providerPublicationTimeField: 'providerPublicationTime', providerRevisionIdField: null,
    unknownFieldPolicy: 'REJECT', duplicateIdenticalRowPolicy: 'REJECT',
    volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
    ...overrides,
  };
}

function setup(store, instrumentKind = 'EQUITY') {
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: `l3-i1-adversarial-${instrumentKind}/1`, identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: (instrumentKind === 'EQUITY' ? '4' : '5').repeat(64), instrumentKind,
  });
  const instrumentManifest = buildInstrumentIdentityManifest({ store, instrumentIdentityId: instrument.instrumentIdentityId, aliasBindingCoreIds: [] });
  const instrumentRegistry = buildInstrumentIdentityRegistry({
    store, authorityPolicyId: instrumentAuthority.authorityPolicyId, identityManifestIds: [instrumentManifest.identityManifestId],
  });
  const policies = buildCorporateActionPolicies({
    store,
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l3-i1-adversarial-actions/1', identityNamespaceVersion: 'L3-I1/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'L3-I1/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'L3-I1/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'L3-I1/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'L3-I1/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'L3-I1/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({ store, ...corporateRegistryArgs(policies, instrumentRegistry) });
  const ruleset = buildTimeZoneRuleset({ store, ruleset: {
    schemaVersion: CA.TIMEZONE, rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1', zoneId: 'America/New_York/l3-i1-adversarial',
    validFromDate: '2026-01-02', validToDateExclusive: '2026-01-03',
    civilDateBounds: [{ civilDate: '2026-01-02', startUtc: '2026-01-02T05:00:00.000Z', endUtcExclusive: '2026-01-03T05:00:00.000Z' }],
  } });
  const calendarPolicy = Calendar.buildMarketCalendarAuthorityPolicy({ store, policy: {
    schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
    venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
    allowedSessionKinds: ['HALF_DAY_SESSION', 'REGULAR_SESSION'], calendarNamespaceVersion: 'adversarial/1',
  } });
  const calendarValue = {
    schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
    calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
    venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
    coverageFromDate: '2026-01-02', coverageToDateExclusive: '2026-01-06',
    sessions: [{ sessionDate: '2026-01-02', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-02T14:30:00.000Z', closeUtc: '2026-01-02T21:00:00.000Z', marketValidTime: '2026-01-02T21:00:00.000Z' }],
  };
  const calendar = Calendar.buildMarketSessionCalendar({ store, calendar: calendarValue });
  const calendarRegistry = Calendar.buildMarketCalendarRegistry({ store, registry: {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
    calendarCoreIds: [calendar.calendarCoreId], supersedesCalendarRegistryManifestId: null,
  } });
  const ingestionPolicy = Source.buildMarketDataIngestionPolicy({ store, policy: policyValue() });
  const context = {
    ingestionPolicyId: ingestionPolicy.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: corporateRegistry.registryManifestId,
  };
  const lineageValue = {
    schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
    providerId: 'SYNTHETIC_PROVIDER', instrumentIdentityId: instrument.instrumentIdentityId,
    frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS', priceBasis: 'RAW', sourceDatasetKind: 'EOD_OHLCV',
  };
  const lineage = instrumentKind === 'EQUITY'
    ? Source.buildMarketDataIngestionLineage({ store, lineage: lineageValue, ...context }) : null;
  return { instrumentAuthority, instrument, instrumentManifest, instrumentRegistry, policies, corporateRegistry,
    ruleset, calendarPolicy, calendarValue, calendar, calendarRegistry, ingestionPolicy, context, lineageValue, lineage };
}

const builders = [
  Calendar.buildMarketCalendarAuthorityPolicy,
  Calendar.buildMarketSessionCalendar,
  Calendar.buildMarketCalendarRegistry,
  Source.buildMarketDataIngestionPolicy,
  Source.buildMarketDataIngestionLineage,
  Source.buildMarketDataIngestionRegistryAuthorityPolicy,
  Source.buildMarketDataSourceArtifact,
  Source.buildMarketDataSourceAttestation,
  Source.buildMarketDataAcquisitionRecord,
  Source.buildMarketDataParseResult,
  Source.buildMarketDataSourceTemporalEvidence,
  Bar.buildMarketDataBarIdentity,
];
const verifiers = [
  Calendar.verifyMarketCalendarAuthorityPolicy,
  Calendar.verifyMarketSessionCalendar,
  Calendar.verifyMarketCalendarRegistry,
  Source.verifyMarketDataIngestionPolicy,
  Source.verifyMarketDataIngestionLineage,
  Source.verifyMarketDataIngestionRegistryAuthorityPolicy,
  Source.verifyMarketDataSourceArtifact,
  Source.verifyMarketDataSourceAttestation,
  Source.verifyMarketDataAcquisitionRecord,
  Source.verifyMarketDataParseResult,
  Source.verifyMarketDataSourceTemporalEvidence,
  Bar.verifyMarketDataBarIdentity,
];

test('L3-I1 adversarial public APIs: undefined, null, empty and unknown fields never leak TypeError', () => {
  for (const api of [...builders, ...verifiers]) {
    for (const input of [undefined, null, {}]) {
      assert.throws(() => api(input), (error) => error instanceof MarketDataL3Error && error.name === 'MarketDataL3Error', api.name);
    }
    expectCode(() => api({ unexpected: true }), 'MARKET_DATA_UNKNOWN_FIELD');
  }
});

test('L3-I1 adversarial schema versions: all twelve normalizers fail closed without aliases', () => {
  const normalizers = [
    Calendar.normalizeMarketCalendarAuthorityPolicyV1,
    Calendar.normalizeMarketSessionCalendarCoreV1,
    Calendar.normalizeMarketCalendarRegistryManifestV1,
    Source.normalizeMarketDataIngestionPolicyV1,
    Source.normalizeMarketDataIngestionLineageCoreV1,
    Source.normalizeMarketDataIngestionRegistryAuthorityPolicyV1,
    Source.normalizeMarketDataSourceArtifactCoreV1,
    Source.normalizeMarketDataSourceAttestationCoreV1,
    Source.normalizeMarketDataAcquisitionRecordCoreV1,
    Source.normalizeMarketDataParseResultCoreV1,
    Source.normalizeMarketDataSourceTemporalEvidenceCoreV1,
    Bar.normalizeMarketDataBarIdentityCoreV1,
  ];
  for (const normalize of normalizers) {
    expectCode(() => normalize({ schemaVersion: 'Wrong/1' }), 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
  }
});

test('L3-I1 canonical reference errors distinguish corrupt ID, missing object, corrupt bytes and wrong type', () => withStore((store) => {
  expectCode(() => Bar.verifyMarketDataBarIdentity({ store, barIdentityId: 'bad' }), 'MARKET_DATA_REFERENCE_CORRUPT');
  const missingStore = {
    uriForObject: () => 'snapshots/missing.json',
    readObject: () => { const error = new Error('missing'); error.details = { fsCode: 'ENOENT' }; throw error; },
    readCanonicalObject: () => { throw new Error('unreachable'); },
  };
  expectCode(() => Bar.verifyMarketDataBarIdentity({ store: missingStore, barIdentityId: ID_A }), 'MARKET_DATA_REFERENCE_MISSING');
  const corruptStore = { ...missingStore, readObject: () => { throw new Error('corrupt'); } };
  expectCode(() => Bar.verifyMarketDataBarIdentity({ store: corruptStore, barIdentityId: ID_A }), 'MARKET_DATA_REFERENCE_CORRUPT');
  const policy = Source.buildMarketDataIngestionPolicy({ store, policy: policyValue() });
  expectCode(() => Bar.verifyMarketDataBarIdentity({ store, barIdentityId: policy.ingestionPolicyId }), 'MARKET_DATA_WRONG_REFERENCE_TYPE');
}));

test('L3-I1 knowledge policy errors use the three canonical knowledge codes', () => {
  expectCode(() => Source.normalizeMarketDataIngestionPolicyV1(policyValue({
    knowledgeModes: [], providerPublicationTimeField: null,
  })), 'MARKET_DATA_KNOWLEDGE_BOUNDS_REQUIRED');
  expectCode(() => Source.normalizeMarketDataIngestionPolicyV1(policyValue({
    knowledgeModes: ['PROVIDER_REVISION_HISTORY_ATTESTED', 'PROVIDER_PUBLICATION_TIME_ATTESTED'],
    providerRevisionIdField: 'revisionId',
  })), 'MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID');
  expectCode(() => Source.normalizeMarketDataIngestionPolicyV1(policyValue({
    knowledgeModes: ['CALLER_ASSERTED'],
  })), 'MARKET_DATA_KNOWLEDGE_MODE_INVALID');
});

test('L3-I1 calendar rejects duplicate sessions and incomplete coverage', () => withStore((store) => {
  const graph = setup(store);
  expectCode(() => Calendar.normalizeMarketSessionCalendarCoreV1({
    ...graph.calendarValue, sessions: [graph.calendarValue.sessions[0], graph.calendarValue.sessions[0]],
  }), 'MARKET_DATA_CALENDAR_SESSION_DUPLICATE');
  expectCode(() => Calendar.normalizeMarketSessionCalendarCoreV1({
    ...graph.calendarValue, coverageToDateExclusive: graph.calendarValue.coverageFromDate,
  }), 'MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE');
}));

test('L3-I1 calendar registry accepts identical overlap and rejects divergent overlap and gaps', () => withStore((store) => {
  const graph = setup(store);
  const identical = Calendar.buildMarketSessionCalendar({ store, calendar: {
    ...graph.calendarValue, coverageFromDate: '2026-01-02', coverageToDateExclusive: '2026-01-07',
  } });
  assert.doesNotThrow(() => Calendar.buildMarketCalendarRegistry({ store, registry: {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
    calendarCoreIds: [graph.calendar.calendarCoreId, identical.calendarCoreId].sort(), supersedesCalendarRegistryManifestId: null,
  } }));
  const divergent = Calendar.buildMarketSessionCalendar({ store, calendar: {
    ...graph.calendarValue,
    sessions: [{ ...graph.calendarValue.sessions[0], closeUtc: '2026-01-02T20:00:00.000Z', marketValidTime: '2026-01-02T20:00:00.000Z' }],
  } });
  expectCode(() => Calendar.buildMarketCalendarRegistry({ store, registry: {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
    calendarCoreIds: [graph.calendar.calendarCoreId, divergent.calendarCoreId].sort(), supersedesCalendarRegistryManifestId: null,
  } }), 'MARKET_DATA_CALENDAR_OVERLAP');
  const closedInstead = Calendar.buildMarketSessionCalendar({ store, calendar: {
    ...graph.calendarValue, sessions: [],
  } });
  expectCode(() => Calendar.buildMarketCalendarRegistry({ store, registry: {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
    calendarCoreIds: [graph.calendar.calendarCoreId, closedInstead.calendarCoreId].sort(), supersedesCalendarRegistryManifestId: null,
  } }), 'MARKET_DATA_CALENDAR_OVERLAP');
  const gap = Calendar.buildMarketSessionCalendar({ store, calendar: {
    ...graph.calendarValue, coverageFromDate: '2026-01-08', coverageToDateExclusive: '2026-01-10',
    sessions: [{ sessionDate: '2026-01-08', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-08T14:30:00.000Z', closeUtc: '2026-01-08T21:00:00.000Z', marketValidTime: '2026-01-08T21:00:00.000Z' }],
  } });
  expectCode(() => Calendar.buildMarketCalendarRegistry({ store, registry: {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
    calendarCoreIds: [graph.calendar.calendarCoreId, gap.calendarCoreId].sort(), supersedesCalendarRegistryManifestId: null,
  } }), 'MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE');
}));

test('L3-I1 calendar registry is append-only and authority-pinned', () => withStore((store) => {
  const graph = setup(store);
  const replacement = Calendar.buildMarketSessionCalendar({ store, calendar: {
    ...graph.calendarValue, coverageFromDate: '2026-01-06', coverageToDateExclusive: '2026-01-08',
    sessions: [{ sessionDate: '2026-01-06', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-06T14:30:00.000Z', closeUtc: '2026-01-06T21:00:00.000Z', marketValidTime: '2026-01-06T21:00:00.000Z' }],
  } });
  expectCode(() => Calendar.buildMarketCalendarRegistry({ store, registry: {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
    calendarCoreIds: [replacement.calendarCoreId],
    supersedesCalendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
  } }), 'MARKET_DATA_CALENDAR_APPEND_ONLY_VIOLATION');
  const foreignPolicy = Calendar.buildMarketCalendarAuthorityPolicy({ store, policy: {
    schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION, venueId: 'XNYS',
    timeZoneRulesetId: graph.ruleset.timeZoneRulesetId, allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'foreign/1',
  } });
  expectCode(() => Calendar.buildMarketCalendarRegistry({ store, registry: {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: foreignPolicy.calendarAuthorityPolicyId,
    calendarCoreIds: [graph.calendar.calendarCoreId],
    supersedesCalendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
  } }), 'MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH');
}));

test('L3-I1 calendar registry detects a cycle in the explicitly pinned chain', () => {
  const policy = {
    schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
    venueId: 'XNAS', timeZoneRulesetId: ID_D, allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'mock/1',
  };
  const calendar = {
    schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
    calendarAuthorityPolicyId: ID_B, venueId: 'XNAS', timeZoneRulesetId: ID_D,
    coverageFromDate: '2026-01-02', coverageToDateExclusive: '2026-01-03',
    sessions: [{ sessionDate: '2026-01-02', sessionKind: 'REGULAR_SESSION', openUtc: '2026-01-02T14:30:00.000Z', closeUtc: '2026-01-02T21:00:00.000Z', marketValidTime: '2026-01-02T21:00:00.000Z' }],
  };
  const registry = {
    schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: ID_B, calendarCoreIds: [ID_C], supersedesCalendarRegistryManifestId: ID_A,
  };
  const values = new Map([[ID_A, registry], [ID_B, policy], [ID_C, calendar], [ID_D, { schemaVersion: 'TimeZoneRuleset/1' }]]);
  const store = {
    uriForObject: ({ objectId }) => objectId,
    readObject: ({ expectedObjectId }) => ({ bytes: canonicalJsonBytes(values.get(expectedObjectId)) }),
    readCanonicalObject: ({ expectedObjectId }) => ({ value: values.get(expectedObjectId) }),
  };
  expectCode(() => Calendar.verifyMarketCalendarRegistry({ store, calendarRegistryManifestId: ID_A }), 'MARKET_DATA_CALENDAR_REGISTRY_CYCLE');
});

test('L3-I1 lineage rejects policy, authorization and pinned-registry mismatches', () => withStore((store) => {
  const graph = setup(store);
  const disallowedPolicy = Source.buildMarketDataIngestionPolicy({ store, policy: policyValue({ allowedPriceBases: ['SPLIT_ADJUSTED'] }) });
  expectCode(() => Source.buildMarketDataIngestionLineage({ store, lineage: graph.lineageValue,
    ...graph.context, ingestionPolicyId: disallowedPolicy.ingestionPolicyId }), 'MARKET_DATA_INGESTION_LINEAGE_INVALID');
  expectCode(() => Source.buildMarketDataIngestionLineage({ store, lineage: { ...graph.lineageValue, instrumentIdentityId: ID_A },
    ...graph.context }), 'MARKET_DATA_INSTRUMENT_NOT_AUTHORIZED');
  expectCode(() => Source.buildMarketDataIngestionLineage({ store, lineage: graph.lineageValue,
    ...graph.context, instrumentIdentityRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId }), 'MARKET_DATA_IDENTITY_REGISTRY_MISMATCH');
  expectCode(() => Source.buildMarketDataIngestionLineage({ store, lineage: graph.lineageValue,
    ...graph.context, calendarRegistryManifestId: graph.instrumentRegistry.registryManifestId }), 'MARKET_DATA_CALENDAR_REGISTRY_MISMATCH');
  expectCode(() => Source.buildMarketDataIngestionLineage({ store, lineage: graph.lineageValue,
    ...graph.context, corporateActionRegistryManifestId: graph.instrumentRegistry.registryManifestId }), 'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH');
}));

test('L3-I1 lineage rejects an L2B kind outside EQUITY/ETF/ETN', () => withStore((store) => {
  const graph = setup(store, 'INDEX');
  expectCode(() => Source.buildMarketDataIngestionLineage({ store, lineage: graph.lineageValue, ...graph.context }), 'MARKET_DATA_INSTRUMENT_KIND_UNSUPPORTED');
}));

test('L3-I1 artifact and attestation reject digest, size, secret and mixed-mode claims', () => withStore((store) => {
  const graph = setup(store);
  const bytes = Buffer.from('date,providerPublicationTime\n2026-01-02,2026-01-02T21:01:00.000Z\n');
  const source = store.putSourceBytes(bytes);
  const artifactValue = {
    schemaVersion: Source.MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId, payloadFormat: 'CSV_UTF8', mediaType: 'text/csv; charset=utf-8',
    embeddedBytesObjectId: source.objectId, payloadDigest: source.objectId, payloadByteLength: bytes.length,
  };
  expectCode(() => Source.normalizeMarketDataSourceArtifactCoreV1({ ...artifactValue, mediaType: 'application/json' }), 'MARKET_DATA_SOURCE_ARTIFACT_INVALID');
  expectCode(() => Source.buildMarketDataSourceArtifact({ store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: { ...artifactValue, payloadDigest: ID_A } }), 'MARKET_DATA_SOURCE_DIGEST_MISMATCH');
  expectCode(() => Source.buildMarketDataSourceArtifact({ store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: { ...artifactValue, payloadByteLength: bytes.length + 1 } }), 'MARKET_DATA_SOURCE_ARTIFACT_INVALID');
  const smallPolicy = Source.buildMarketDataIngestionPolicy({ store, policy: policyValue({ maxArtifactBytes: 1 }) });
  expectCode(() => Source.buildMarketDataSourceArtifact({ store, ingestionPolicyId: smallPolicy.ingestionPolicyId,
    artifact: artifactValue }), 'MARKET_DATA_SOURCE_ARTIFACT_INVALID');
  const secretBytes = Buffer.from('api_key=synthetic-secret');
  const secret = store.putSourceBytes(secretBytes);
  expectCode(() => Source.buildMarketDataSourceArtifact({ store, ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: { ...artifactValue, embeddedBytesObjectId: secret.objectId, payloadDigest: secret.objectId, payloadByteLength: secretBytes.length } }), 'MARKET_DATA_SOURCE_ARTIFACT_INVALID');
  expectCode(() => Source.normalizeMarketDataSourceAttestationCoreV1({
    schemaVersion: Source.MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId, attestationMode: 'CALLER_ASSERTED', embeddedArtifactId: null,
    payloadDigest: null, payloadByteLength: null, payloadFormat: null, providerId: null,
  }), 'MARKET_DATA_SOURCE_ATTESTATION_MODE_INVALID');
  expectCode(() => Source.normalizeMarketDataSourceAttestationCoreV1({
    schemaVersion: Source.MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId, attestationMode: 'EMBEDDED_ARTIFACT', embeddedArtifactId: null,
    payloadDigest: null, payloadByteLength: null, payloadFormat: null, providerId: null,
  }), 'MARKET_DATA_SOURCE_EMBEDDED_REQUIRED');
  expectCode(() => Source.normalizeMarketDataSourceAttestationCoreV1({
    schemaVersion: Source.MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId, attestationMode: 'EMBEDDED_ARTIFACT', embeddedArtifactId: ID_A,
    payloadDigest: ID_B, payloadByteLength: 1, payloadFormat: 'CSV_UTF8', providerId: 'SYNTHETIC_PROVIDER',
  }), 'MARKET_DATA_SOURCE_ATTESTATION_MODE_INVALID');
}));

test('L3-I1 acquisition rejects paths, URLs, tokens, provider and lineage mismatches', () => withStore((store) => {
  const graph = setup(store);
  const digestOnly = Source.buildMarketDataSourceAttestation({ store, attestation: {
    schemaVersion: Source.MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId, attestationMode: 'DIGEST_ONLY', embeddedArtifactId: null,
    payloadDigest: ID_A, payloadByteLength: 10, payloadFormat: 'CSV_UTF8', providerId: 'SYNTHETIC_PROVIDER',
  } });
  const record = {
    schemaVersion: Source.MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
    ingestionLineageId: graph.lineage.ingestionLineageId, acquisitionTimeUtc: '2026-01-02T21:02:00.000Z',
    providerId: 'SYNTHETIC_PROVIDER', logicalEndpointKind: 'EOD_OHLCV_DATASET', requestDatasetKind: 'EOD_OHLCV',
    executionIdentity: { runnerId: 'node-test', runId: 'adversarial', environment: 'LOCAL_TEST' },
    sourceAttestationId: digestOnly.sourceAttestationId,
  };
  expectCode(() => Source.normalizeMarketDataAcquisitionRecordCoreV1({ ...record,
    executionIdentity: { ...record.executionIdentity, runId: 'C:\\secret\\run' } }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => Source.normalizeMarketDataAcquisitionRecordCoreV1({ ...record,
    executionIdentity: { ...record.executionIdentity, runId: 'Authorization: Bearer abc' } }), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => Source.buildMarketDataAcquisitionRecord({ store, record: { ...record, providerId: 'FOREIGN_PROVIDER' } }), 'MARKET_DATA_INGESTION_LINEAGE_INVALID');
}));

test('L3-I1 temporal evidence requires an exact present provider cell and revision ID', () => {
  expectCode(() => Source.normalizeMarketDataSourceTemporalEvidenceCoreV1({
    schemaVersion: Source.MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
    sourceArtifactId: ID_A, acquisitionRecordId: ID_B, parseResultId: ID_C,
    sourceRowIndex: 0, sourceCellPath: '/missing/0', sourceCellDigest: ID_A,
    rawTimestampValue: '2026-01-02T21:01:00.000Z', normalizedTimestampUtc: '2026-01-02T21:01:00.000Z',
    evidenceKind: 'PROVIDER_PUBLICATION_TIMESTAMP', providerRevisionId: null,
  }), 'MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID');
  expectCode(() => Source.normalizeMarketDataSourceTemporalEvidenceCoreV1({
    schemaVersion: Source.MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
    sourceArtifactId: ID_A, acquisitionRecordId: ID_B, parseResultId: ID_C,
    sourceRowIndex: 0, sourceCellPath: '/cells/0', sourceCellDigest: ID_A,
    rawTimestampValue: '2026-01-02T21:01:00.000Z', normalizedTimestampUtc: '2026-01-02T21:01:00.000Z',
    evidenceKind: 'PROVIDER_REVISION_TIMESTAMP', providerRevisionId: null,
  }), 'MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_REQUIRED');
});

test('L3-I1 bar identity rejects bad date, frequency and contaminating fields', () => {
  const value = {
    schemaVersion: Bar.MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
    instrumentIdentityId: ID_A, frequency: 'DAILY_REGULAR_SESSION', venueId: 'XNAS',
    sessionDate: '2026-02-29', sessionKind: 'DAILY_REGULAR_SESSION',
  };
  expectCode(() => Bar.normalizeMarketDataBarIdentityCoreV1(value), 'MARKET_DATA_BAR_IDENTITY_INVALID');
  expectCode(() => Bar.normalizeMarketDataBarIdentityCoreV1({ ...value, sessionDate: '2026-02-28', frequency: 'WEEKLY' }), 'MARKET_DATA_BAR_IDENTITY_INVALID');
  expectCode(() => Bar.normalizeMarketDataBarIdentityCoreV1({ ...value, sessionDate: '2026-02-28', providerId: 'X' }), 'MARKET_DATA_UNKNOWN_FIELD');
});

test('L3-I1 canonical error-code inventory is exact and contains no aliases', () => {
  const expected = new Set([
    'MARKET_DATA_INPUT_INVALID', 'MARKET_DATA_UNKNOWN_FIELD', 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED',
    'MARKET_DATA_REFERENCE_MISSING', 'MARKET_DATA_REFERENCE_CORRUPT', 'MARKET_DATA_WRONG_REFERENCE_TYPE',
    'MARKET_DATA_SOURCE_ARTIFACT_INVALID', 'MARKET_DATA_SOURCE_ATTESTATION_MODE_INVALID',
    'MARKET_DATA_SOURCE_EMBEDDED_REQUIRED', 'MARKET_DATA_SOURCE_DIGEST_MISMATCH',
    'MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_REQUIRED', 'MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID',
    'MARKET_DATA_BAR_IDENTITY_INVALID', 'MARKET_DATA_INGESTION_LINEAGE_INVALID',
    'MARKET_DATA_INSTRUMENT_NOT_AUTHORIZED', 'MARKET_DATA_INSTRUMENT_KIND_UNSUPPORTED',
    'MARKET_DATA_IDENTITY_REGISTRY_MISMATCH', 'MARKET_DATA_CALENDAR_REGISTRY_MISMATCH',
    'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH', 'MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE',
    'MARKET_DATA_CALENDAR_SESSION_DUPLICATE', 'MARKET_DATA_CALENDAR_OVERLAP',
    'MARKET_DATA_CALENDAR_APPEND_ONLY_VIOLATION', 'MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH',
    'MARKET_DATA_CALENDAR_REGISTRY_CYCLE', 'MARKET_DATA_KNOWLEDGE_BOUNDS_REQUIRED',
    'MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'MARKET_DATA_KNOWLEDGE_MODE_INVALID',
  ]);
  assert.equal(expected.size, 28);
});
