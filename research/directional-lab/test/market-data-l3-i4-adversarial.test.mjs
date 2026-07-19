/**
 * L3-I4 adversarial suite. Shape-level counter-tests run inline; the
 * independent counter-test harness is generated under os.tmpdir() only,
 * executed in a child process and removed afterwards. Synthetic fixtures only.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  normalizeMarketDataResolvedSeriesManifestV1,
} from '../src/contracts/marketDataResolvedSeriesL3V1.mjs';

const ID_A = `sha256:${'a'.repeat(64)}`;
const ID_B = `sha256:${'b'.repeat(64)}`;
const ID_C = `sha256:${'c'.repeat(64)}`;
const ID_D = `sha256:${'d'.repeat(64)}`;

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code, String(error));
    assert.doesNotMatch(String(error), /TypeError/);
    return true;
  });
}

function entryValue(overrides = {}) {
  return {
    barIdentityId: ID_D,
    resolvedObservationId: ID_A,
    resolvedCorrectionTipId: ID_B,
    sessionDate: '2026-01-02',
    disposition: 'PRESENT',
    ...overrides,
  };
}

function manifestValue(overrides = {}) {
  return {
    schemaVersion: 'MarketDataResolvedSeriesManifest/1',
    contributingRegistryPrefixId: ID_A,
    ingestionLineageId: ID_B,
    knowledgeCutoff: '2026-01-12T08:00:00.000Z',
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    resolvedBarEntries: [entryValue()],
    contributingIngestionManifestIds: [ID_A],
    contributingObservationIds: [ID_B],
    contributingCorrectionIds: [ID_C],
    contributingAcquisitionRecordIds: [ID_D],
    contributingSourceArtifactIds: [],
    identityRegistryManifestId: ID_A,
    calendarRegistryManifestId: ID_B,
    corporateActionRegistryManifestId: ID_C,
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    ...overrides,
  };
}

test('L3-I4 normalize-level closed shape refuses every malformed manifest', () => {
  assert.deepEqual(
    normalizeMarketDataResolvedSeriesManifestV1(manifestValue()),
    manifestValue(),
  );
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({ alien: 1 })),
    'MARKET_DATA_UNKNOWN_FIELD');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    schemaVersion: 'MarketDataResolvedSeriesManifest/2',
  })), 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    knowledgeCutoff: '2026-01-12',
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    resolvedBarEntries: [],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    resolvedBarEntries: [entryValue({ disposition: 'LATEST_WINS' })],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    resolvedBarEntries: [entryValue({ disposition: 'WITHDRAWN' })],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    resolvedBarEntries: [entryValue({ resolvedObservationId: null })],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    resolvedBarEntries: [entryValue({ resolvedCorrectionTipId: null })],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    resolvedBarEntries: [
      entryValue({ sessionDate: '2026-01-05' }),
      entryValue({ barIdentityId: ID_C, sessionDate: '2026-01-02' }),
    ],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    resolvedBarEntries: [entryValue(), entryValue()],
  })), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    contributingCorrectionIds: [ID_D, ID_C],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    contributingIngestionManifestIds: [],
  })), 'MARKET_DATA_INPUT_INVALID');
  expectCode(() => normalizeMarketDataResolvedSeriesManifestV1(manifestValue({
    temporalCapability: 'LATEST',
  })), 'MARKET_DATA_INPUT_INVALID');
});

test('L3-I4 temporary adversarial harness runs at least 40 independent fail-closed counter-tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'market-data-l3-i4-'));
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
import { sha256Digest } from ${JSON.stringify(u('src/contracts/marketDataL3CommonV1.mjs'))};
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
} from ${JSON.stringify(u('src/contracts/marketDataIngestionRegistryL3V1.mjs'))};
import {
  MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
} from ${JSON.stringify(u('src/contracts/marketDataResolvedSeriesL3V1.mjs'))};
import {
  buildMarketDataResolvedSeriesManifest,
  resolveMarketDataAsOf,
  verifyMarketDataResolvedSeries,
  verifyMarketDataResolvedSeriesManifest,
} from ${JSON.stringify(u('src/resolution/resolveMarketDataAsOfL3V1.mjs'))};
import { addDays } from ${JSON.stringify(u('src/time/civilDate.mjs'))};

const SESSION_DATES = ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-10'];
const VALUES = Object.freeze({
  openAtoms: '100', highAtoms: '101', lowAtoms: '99', closeAtoms: '100',
  priceScale: 0, volumeAtoms: '100', volumeScale: 0, currency: 'USD', priceBasis: 'RAW',
});
const FAKE_ID = 'sha256:' + '0'.repeat(64);

let passed = 0;
const failedNames = [];
function run(name, fn) {
  try { fn(); passed += 1; } catch (error) {
    failedNames.push(name + ' :: ' + String(error && error.message || error));
  }
}
function expectThrow(fn) {
  try { fn(); } catch (error) {
    assert.ok(typeof error.code === 'string' && error.code.length > 0, 'coded error required');
    assert.doesNotMatch(String(error), /TypeError/);
    return error;
  }
  assert.fail('expected a coded failure');
}
function expectCode(fn, code) {
  const error = expectThrow(fn);
  assert.equal(error.code, code, String(error));
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

function setupI4(store, tag) {
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'i4-adv-instruments-' + tag + '/1',
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
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'i4-adv-actions-' + tag + '/1', identityNamespaceVersion: 'I4A/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'I4A/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'I4A/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'I4A/1', requireAllVisibleObservations: true, allowContested: false },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'I4A/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'I4A/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store, ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/i4-adv-' + tag,
      validFromDate: '2026-01-02', validToDateExclusive: '2026-01-13',
      civilDateBounds: Array.from({ length: 11 }, (unused, index) => {
        const civilDate = addDays('2026-01-02', index);
        return { civilDate, startUtc: civilDate + 'T05:00:00.000Z',
          endUtcExclusive: addDays(civilDate, 1) + 'T05:00:00.000Z' };
      }),
    },
  });
  const calendarPolicy = Calendar.buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS', timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'i4-adv-' + tag + '/1',
    },
  });
  const sessions = SESSION_DATES.map((sessionDate) => ({
    sessionDate, sessionKind: 'REGULAR_SESSION',
    openUtc: sessionDate + 'T14:30:00.000Z', closeUtc: sessionDate + 'T21:00:00.000Z',
    marketValidTime: sessionDate + 'T21:00:00.000Z',
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
      knowledgeModes: ['CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED', 'PROVIDER_REVISION_HISTORY_ATTESTED'],
      providerPublicationTimeField: 'providerPublicationTime', providerRevisionIdField: 'providerRevisionId',
      unknownFieldPolicy: 'REJECT', duplicateIdenticalRowPolicy: 'ACCEPT_IDENTICAL',
      volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
    },
  });
  const makeLineage = (providerId) => Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId, instrumentIdentityId: instrument.instrumentIdentityId,
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
      registryNamespaceVersion: 'i4-adv-' + tag + '/1',
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
    ingestionPolicy, lineage: makeLineage('SYNTHETIC_PROVIDER'), makeLineage,
    registryAuthority, rootRegistry, barBySession, priceBasis: 'RAW',
  };
}

const HEADER_EXTRA = ['providerPublicationTime', 'providerRevisionId'];
function atomsHeader() {
  return ['sessionDate', 'openAtoms', 'highAtoms', 'lowAtoms', 'closeAtoms', 'priceScale',
    'volumeAtoms', 'volumeScale', 'currency', 'knowledgeMode', 'identityRegistryManifestId',
    'calendarRegistryManifestId', 'corporateActionRegistryManifestId'].concat(HEADER_EXTRA);
}
function atomsRow(graph, sessionDate, overrides) {
  const cells = Object.assign({
    sessionDate,
    openAtoms: '100', highAtoms: '101', lowAtoms: '99', closeAtoms: '100',
    priceScale: '0', volumeAtoms: '100', volumeScale: '0', currency: 'USD',
    knowledgeMode: 'CAPTURE_TIME_ONLY',
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  }, overrides || {});
  return atomsHeader().map((field) => cells[field] === undefined ? '' : cells[field]);
}

function makeSource(store, graph, rows, acquisitionTimeUtc, runId) {
  const bytes = Buffer.from([atomsHeader().join(',')].concat(rows.map((row) => row.join(','))).concat(['']).join('\\n'));
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

function buildEvidence(store, graph, source, rowIndex, timestamp, revisionId) {
  const cellIndex = atomsHeader().indexOf('providerPublicationTime');
  return Source.buildMarketDataSourceTemporalEvidence({
    store,
    evidence: {
      schemaVersion: Source.MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
      sourceArtifactId: source.artifact.sourceArtifactId,
      acquisitionRecordId: source.acquisition.acquisitionRecordId,
      parseResultId: source.parseResult.parseResultId,
      sourceRowIndex: rowIndex,
      sourceCellPath: '/cells/' + cellIndex,
      sourceCellDigest: sha256Digest(timestamp),
      rawTimestampValue: timestamp,
      normalizedTimestampUtc: timestamp,
      evidenceKind: revisionId ? 'PROVIDER_REVISION_TIMESTAMP' : 'PROVIDER_PUBLICATION_TIMESTAMP',
      providerRevisionId: revisionId || null,
    },
  }).sourceTemporalEvidenceId;
}

function candidateBase(graph, source, sessionDate, overrides) {
  const merged = overrides || {};
  const rowIndex = merged.sourceRowIndex === undefined ? 0 : merged.sourceRowIndex;
  const row = source.parseResult.parseResult.rows[rowIndex];
  return Object.assign({
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
    marketValidTime: sessionDate + 'T21:00:00.000Z',
    barIdentityId: graph.barBySession.get(sessionDate),
    targetCorrectionId: null,
    replacementValues: Object.assign({}, VALUES),
  }, merged);
}

function revisionCandidate(graph, source, sessionDate, targetCorrectionId, values, overrides) {
  return candidateBase(graph, source, sessionDate, Object.assign({
    candidateKind: 'BAR_VALUE_REVISION', targetCorrectionId,
    replacementValues: Object.assign({}, VALUES, values || {}),
  }, overrides || {}));
}

function withdrawalCandidate(graph, source, sessionDate, targetCorrectionId) {
  const candidate = candidateBase(graph, source, sessionDate, {
    candidateKind: 'BAR_WITHDRAWAL', targetCorrectionId,
  });
  delete candidate.replacementValues;
  return candidate;
}

function restorationCandidate(graph, source, sessionDate, targetWithdrawalCorrectionId, restoredObservationId) {
  const candidate = candidateBase(graph, source, sessionDate, {
    candidateKind: 'BAR_RESTORATION', targetWithdrawalCorrectionId, restoredObservationId,
  });
  delete candidate.targetCorrectionId;
  delete candidate.replacementValues;
  return candidate;
}

function sessionMoveCandidate(graph, source, fromDate, toDate, targetCorrectionId) {
  const candidate = candidateBase(graph, source, toDate, {
    candidateKind: 'SESSION_DATE_CORRECTION',
    previousBarIdentityId: graph.barBySession.get(fromDate),
    nextBarIdentityId: graph.barBySession.get(toDate),
    targetCorrectionId,
  });
  delete candidate.barIdentityId;
  return candidate;
}

function candidateBarIds(candidate) {
  return candidate.candidateKind === 'SESSION_DATE_CORRECTION'
    ? [candidate.previousBarIdentityId, candidate.nextBarIdentityId]
    : [candidate.barIdentityId];
}

function appendIngestion(store, graph, registryId, source, candidates, options) {
  const opts = options || {};
  const registry = verifyMarketDataIngestionRegistry({
    store, ingestionRegistryManifestId: registryId,
  }).ingestionRegistryManifest;
  const parentId = tipForLineage(registry, graph.lineage.ingestionLineageId);
  const pins = opts.pins || {
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  };
  let view = opts.baseView;
  if (!view) {
    const full = derivePinnedIngestionBaseView(store, registryId, graph.lineage.ingestionLineageId, parentId);
    view = {
      baseIngestionRegistryManifestId: registryId,
      expectedParentIngestionManifestId: parentId,
      terminalCorrectionIds: full.terminalCorrectionIds,
      visibleCorrectionIds: full.visibleCorrectionIds,
      occupiedBarIdentityIds: full.occupiedBarIdentityIds,
      publishedBarIdentityIds: [...new Set(full.publishedBarIdentityIds.concat(
        candidates.flatMap(candidateBarIds),
      ))].sort(),
      duplicateCandidateIds: [],
    };
  }
  const built = candidates.map((candidate) => Candidate.buildMarketDataNormalizedCandidate({ store, candidate }));
  const candidateIds = built.map((item) => item.candidateId).sort();
  const set = Candidate.buildMarketDataCandidateSet({
    store,
    candidateSet: Object.assign({
      schemaVersion: Candidate.MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      sourceArtifactId: source.artifact.sourceArtifactId,
      acquisitionRecordId: source.acquisition.acquisitionRecordId,
      parseResultId: source.parseResult.parseResultId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      candidateIds,
    }, pins),
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
    manifest: Object.assign({
      schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      baseIngestionRegistryManifestId: registryId,
      expectedParentIngestionManifestId: parentId,
      supersedesIngestionManifestId: parentId,
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
    }, pins),
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

function correction(store, correctionId) {
  return Revision.verifyMarketDataBarCorrection({ store, correctionId }).correction;
}
function correctionOfKind(store, ids, kind) {
  const hits = ids.filter((id) => correction(store, id).correctionKind === kind);
  assert.equal(hits.length, 1);
  return hits[0];
}
function readResolved(store, id) {
  return store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: id }),
    expectedObjectId: id,
    schemaVersion: MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
  }).value;
}
function forgeResolved(store, manifest) {
  return store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
    value: manifest,
  }).objectId;
}
function swapStore(store, fromId, toId) {
  const redirect = (args) => args.expectedObjectId === fromId
    ? Object.assign({}, args, {
      uri: store.uriForObject({ namespace: 'snapshots', objectId: toId }),
      expectedObjectId: toId,
    })
    : args;
  return Object.assign({}, store, {
    readObject: (args) => store.readObject(redirect(args)),
    readCanonicalObject: (args) => store.readCanonicalObject(redirect(args)),
  });
}

withStore((store) => {
  const graph = setupI4(store, 'a');
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const t1 = '2026-01-06T22:00:00.000Z';
  const t2 = '2026-01-07T00:00:00.000Z';
  const t3 = '2026-01-08T00:00:00.000Z';
  const t4 = '2026-01-09T00:00:00.000Z';
  const t5 = '2026-01-10T22:00:00.000Z';
  const s1 = makeSource(store, graph, [atomsRow(graph, '2026-01-02'), atomsRow(graph, '2026-01-05')], t1, 'a1');
  const i1 = appendIngestion(store, graph, rootId, s1, [
    candidateBase(graph, s1, '2026-01-02', { sourceRowIndex: 0 }),
    candidateBase(graph, s1, '2026-01-05', { sourceRowIndex: 1 }),
  ]);
  const bar02 = graph.barBySession.get('2026-01-02');
  const root02 = i1.correctionIds.filter((id) => correction(store, id).barIdentityId === bar02)[0];
  const s2 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101' })], t2, 'a2');
  const i2 = appendIngestion(store, graph, i1.registryId, s2,
    [revisionCandidate(graph, s2, '2026-01-02', root02, { closeAtoms: '101' })]);
  const s3 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], t3, 'a3');
  const i3 = appendIngestion(store, graph, i2.registryId, s3,
    [withdrawalCandidate(graph, s3, '2026-01-02', i2.correctionIds[0])]);
  const s4 = makeSource(store, graph, [atomsRow(graph, '2026-01-02')], t4, 'a4');
  const i4 = appendIngestion(store, graph, i3.registryId, s4,
    [restorationCandidate(graph, s4, '2026-01-02', i3.correctionIds[0], i2.observationIds[0])]);
  const s5 = makeSource(store, graph, [atomsRow(graph, '2026-01-06')], t5, 'a5');
  const i5 = appendIngestion(store, graph, i4.registryId, s5,
    [sessionMoveCandidate(graph, s5, '2026-01-05', '2026-01-06', i1.correctionIds.filter((id) => id !== root02)[0])]);
  const R = i5.registryId;
  const lineageArgs = (registryId, knowledgeCutoff) => ({
    store, ingestionRegistryManifestId: registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId, knowledgeCutoff,
  });
  const buildAt = (registryId, knowledgeCutoff, extra) => buildMarketDataResolvedSeriesManifest(Object.assign({
    store, ingestionRegistryManifestId: registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId, knowledgeCutoff,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  }, extra || {}));

  run('01 cutoff just before first observation is not provable', () => expectCode(
    () => resolveMarketDataAsOf(lineageArgs(R, '2026-01-06T21:59:59.999Z')),
    'MARKET_DATA_HISTORICAL_KNOWLEDGE_NOT_PROVABLE'));
  run('02 cutoff exactly equal to the upper bound is visible', () => {
    const resolved = resolveMarketDataAsOf(lineageArgs(R, t1));
    assert.equal(resolved.resolvedBarEntries.length, 2);
  });
  run('03 future correction never leaks into an earlier cutoff', () => {
    const resolved = resolveMarketDataAsOf(lineageArgs(R, t1));
    const entry02 = resolved.resolvedBarEntries.filter((entry) => entry.sessionDate === '2026-01-02')[0];
    assert.equal(entry02.resolvedCorrectionTipId, root02);
  });
  run('15 withdrawal tip resolves WITHDRAWN with null observation', () => {
    const resolved = resolveMarketDataAsOf(lineageArgs(R, t3));
    const entry02 = resolved.resolvedBarEntries.filter((entry) => entry.sessionDate === '2026-01-02')[0];
    assert.equal(entry02.disposition, 'WITHDRAWN');
    assert.equal(entry02.resolvedObservationId, null);
  });
  run('16 restoration resolves exactly the pre-withdrawal effective observation', () => {
    const resolved = resolveMarketDataAsOf(lineageArgs(R, t4));
    const entry02 = resolved.resolvedBarEntries.filter((entry) => entry.sessionDate === '2026-01-02')[0];
    assert.equal(entry02.disposition, 'PRESENT');
    assert.equal(entry02.resolvedObservationId, i2.observationIds[0]);
  });
  run('18 session move resolves MOVED_TO_OTHER_SESSION plus PRESENT', () => {
    const resolved = resolveMarketDataAsOf(lineageArgs(R, t5));
    const by = new Map(resolved.resolvedBarEntries.map((entry) => [entry.sessionDate, entry]));
    assert.equal(by.get('2026-01-05').disposition, 'MOVED_TO_OTHER_SESSION');
    assert.equal(by.get('2026-01-06').disposition, 'PRESENT');
  });

  const mBuilt = buildAt(R, t2);
  const mBase = readResolved(store, mBuilt.resolvedSeriesManifestId);
  run('40 identical replay produces the identical manifest ID', () => {
    assert.equal(buildAt(R, t2).resolvedSeriesManifestId, mBuilt.resolvedSeriesManifestId);
  });
  run('09 orphan observation in the CAS never contributes', () => {
    const orphan = Object.assign({}, Revision.verifyMarketDataBarObservation({
      store, observationId: i1.observationIds[0],
    }).observation);
    orphan.values = Object.assign({}, orphan.values, { closeAtoms: '999', highAtoms: '999' });
    store.putCanonicalObject({
      namespace: 'snapshots', schemaVersion: Revision.MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
      value: orphan,
    });
    assert.equal(buildAt(R, t2).resolvedSeriesManifestId, mBuilt.resolvedSeriesManifestId);
  });
  run('10 non-authoritative correction in the CAS never contributes', () => {
    const forged = Object.assign({}, correction(store, i2.correctionIds[0]));
    forged.parentCorrectionId = i2.correctionIds[0];
    forged.sourceRowIndex = 0;
    store.putCanonicalObject({
      namespace: 'snapshots', schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: forged,
    });
    assert.equal(buildAt(R, t2).resolvedSeriesManifestId, mBuilt.resolvedSeriesManifestId);
  });
  run('11 forged registry listing an absent ingestion manifest fails closed', () => {
    const forgedRegistry = store.putCanonicalObject({
      namespace: 'snapshots', schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      value: {
        schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
        ingestionRegistryAuthorityPolicyId: graph.registryAuthority.ingestionRegistryAuthorityPolicyId,
        supersedesIngestionRegistryManifestId: null,
        ingestionManifestIds: [FAKE_ID],
        lineageTips: [{ ingestionLineageId: graph.lineage.ingestionLineageId, tipIngestionManifestId: FAKE_ID }],
      },
    }).objectId;
    expectThrow(() => resolveMarketDataAsOf(lineageArgs(forgedRegistry, t2)));
  });
  run('14 corrupted or absent CAS registry reference fails closed', () => {
    expectThrow(() => resolveMarketDataAsOf(lineageArgs(FAKE_ID, t2)));
  });
  run('06 direct correction cycle fails closed', () => {
    const forged = Object.assign({}, correction(store, root02));
    forged.correctionKind = 'VALUE_REVISION';
    forged.parentCorrectionId = root02;
    const forgedId = store.putCanonicalObject({
      namespace: 'snapshots', schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: forged,
    }).objectId;
    expectThrow(() => resolveMarketDataAsOf(Object.assign(
      lineageArgs(R, t2), { store: swapStore(store, root02, forgedId) },
    )));
  });
  run('07 indirect correction cycle fails closed', () => {
    const forged = Object.assign({}, correction(store, root02));
    forged.correctionKind = 'VALUE_REVISION';
    forged.parentCorrectionId = i2.correctionIds[0];
    const forgedId = store.putCanonicalObject({
      namespace: 'snapshots', schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: forged,
    }).objectId;
    expectThrow(() => resolveMarketDataAsOf(Object.assign(
      lineageArgs(R, t2), { store: swapStore(store, root02, forgedId) },
    )));
  });
  run('13 wrong CAS type behind a correction ID fails closed', () => {
    expectThrow(() => resolveMarketDataAsOf(Object.assign(
      lineageArgs(R, t2), { store: swapStore(store, root02, bar02) },
    )));
  });
  run('17 restoration of a non-ancestral observation fails closed', () => {
    const forged = Object.assign({}, correction(store, i4.correctionIds[0]));
    forged.restoredObservationId = i1.observationIds.filter((id) => Revision.verifyMarketDataBarObservation({
      store, observationId: id,
    }).observation.barIdentityId === bar02)[0];
    const forgedId = store.putCanonicalObject({
      namespace: 'snapshots', schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
      value: forged,
    }).objectId;
    expectThrow(() => resolveMarketDataAsOf(Object.assign(
      lineageArgs(R, t4), { store: swapStore(store, i4.correctionIds[0], forgedId) },
    )));
  });
  run('19 omitted contributing observation is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        contributingObservationIds: mBase.contributingObservationIds.slice(0, 1),
      })),
    }), 'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE'));
  run('20 omitted contributing correction is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        contributingCorrectionIds: mBase.contributingCorrectionIds.slice(0, 1),
      })),
    }), 'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE'));
  run('21 omitted contributing ingestion manifest is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        contributingIngestionManifestIds: mBase.contributingIngestionManifestIds.slice(0, 1),
      })),
    }), 'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE'));
  run('22 extra acquisition record is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        contributingAcquisitionRecordIds: [...mBase.contributingAcquisitionRecordIds,
          s3.acquisition.acquisitionRecordId].sort(),
      })),
    }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT'));
  run('23 future source artifact added as contributor is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        contributingSourceArtifactIds: [...mBase.contributingSourceArtifactIds,
          s3.artifact.sourceArtifactId].sort(),
      })),
    }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT'));
  run('24 registry prefix older than the contributors is refused', () => expectThrow(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        contributingRegistryPrefixId: rootId,
      })),
    })));
  run('25 registry prefix newer than the minimal prefix is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        contributingRegistryPrefixId: i3.registryId,
      })),
    }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT'));
  run('33 inflated temporal capability is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED',
      })),
    }), 'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH'));
  run('37 mixed price basis is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        priceBasis: 'SPLIT_ADJUSTED',
      })),
    }), 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH'));
  run('38 mixed corporate-action treatment is refused', () => expectCode(
    () => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
      })),
    }), 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH'));
  run('39 recomputation mismatch on a resolved entry is refused', () => {
    const obs02Initial = i1.observationIds.filter((id) => Revision.verifyMarketDataBarObservation({
      store, observationId: id,
    }).observation.barIdentityId === bar02)[0];
    expectCode(() => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        resolvedBarEntries: mBase.resolvedBarEntries.map((entry) => entry.sessionDate === '2026-01-02'
          ? Object.assign({}, entry, { resolvedObservationId: obs02Initial })
          : entry),
      })),
    }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT');
  });
  run('36 stored calendar pin without session coverage is refused', () => {
    const policyB = Calendar.buildMarketCalendarAuthorityPolicy({
      store,
      policy: {
        schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
        venueId: 'XNAS', timeZoneRulesetId: graph.ruleset.timeZoneRulesetId,
        allowedSessionKinds: ['REGULAR_SESSION'], calendarNamespaceVersion: 'i4-adv-coverage/1',
      },
    });
    const coreB = Calendar.buildMarketSessionCalendar({
      store,
      calendar: {
        schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
        calendarAuthorityPolicyId: policyB.calendarAuthorityPolicyId,
        venueId: 'XNAS', timeZoneRulesetId: graph.ruleset.timeZoneRulesetId,
        coverageFromDate: '2026-01-10', coverageToDateExclusive: '2026-01-11',
        sessions: [{
          sessionDate: '2026-01-10', sessionKind: 'REGULAR_SESSION',
          openUtc: '2026-01-10T14:30:00.000Z', closeUtc: '2026-01-10T21:00:00.000Z',
          marketValidTime: '2026-01-10T21:00:00.000Z',
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
    expectCode(() => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        calendarRegistryManifestId: registryB.calendarRegistryManifestId,
      })),
    }), 'MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE');
  });
  run('44 stored foreign corporate-action pin is refused', () => {
    const foreignPolicies = buildCorporateActionPolicies({
      store,
      authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'i4-adv-foreign-actions/1', identityNamespaceVersion: 'I4AF/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
      normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'I4AF/1', supportedEventKinds: ['FORWARD_SPLIT'], currencyCodes: ['USD'] },
      temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'I4AF/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
      adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'I4AF/1', requireAllVisibleObservations: true, allowContested: false },
      priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'I4AF/1', supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'] },
      entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'I4AF/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
    });
    const foreignRegistry = buildCorporateActionRegistry({
      store, ...corporateRegistryArgs(foreignPolicies, graph.instrumentRegistry),
    });
    expectCode(() => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, mBase, {
        corporateActionRegistryManifestId: foreignRegistry.registryManifestId,
      })),
    }), 'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH');
  });
  run('28 descendant call pin verifies the stored manifest', () => {
    verifyMarketDataResolvedSeries({
      store, resolvedSeriesManifestId: mBuilt.resolvedSeriesManifestId,
      ingestionRegistryManifestId: R,
    });
  });
  run('29 sibling call pin that skips the prefix is refused', () => {
    const s2c = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '101', volumeAtoms: '200' })], '2026-01-07T02:00:00.000Z', 'a2c');
    const i2c = appendIngestion(store, graph, i1.registryId, s2c,
      [revisionCandidate(graph, s2c, '2026-01-02', root02, { closeAtoms: '101', volumeAtoms: '200' })]);
    expectCode(() => verifyMarketDataResolvedSeries({
      store, resolvedSeriesManifestId: mBuilt.resolvedSeriesManifestId,
      ingestionRegistryManifestId: i2c.registryId,
    }), 'MARKET_DATA_INGESTION_STALE_BASE');
  });
  run('41 free contributor arrays are refused by the closed API', () => expectCode(
    () => resolveMarketDataAsOf(Object.assign(lineageArgs(R, t2), { resolvedBarEntries: [] })),
    'MARKET_DATA_UNKNOWN_FIELD'));
  run('42 implicit cutoff is impossible', () => expectCode(
    () => resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: R,
      ingestionLineageId: graph.lineage.ingestionLineageId,
    }), 'MARKET_DATA_INPUT_INVALID'));
  run('43 direct manifest object instead of a registry ID is refused', () => expectCode(
    () => resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: { ingestionManifestIds: [] },
      ingestionLineageId: graph.lineage.ingestionLineageId, knowledgeCutoff: t2,
    }), 'MARKET_DATA_INPUT_INVALID'));

  // Lineage C: initial acquired late, revision acquired early.
  const graphC = Object.assign({}, graph, { lineage: graph.makeLineage('SYNTHETIC_PROVIDER_C') });
  const sc1 = makeSource(store, graphC, [atomsRow(graphC, '2026-01-02')], '2026-01-20T00:00:00.000Z', 'c1');
  const c1 = appendIngestion(store, graphC, R, sc1, [candidateBase(graphC, sc1, '2026-01-02')]);
  const sc2 = makeSource(store, graphC, [atomsRow(graphC, '2026-01-02', { closeAtoms: '101' })], '2026-01-12T00:00:00.000Z', 'c2');
  const c2 = appendIngestion(store, graphC, c1.registryId, sc2,
    [revisionCandidate(graphC, sc2, '2026-01-02', c1.correctionIds[0], { closeAtoms: '101' })]);
  run('04 visible child with invisible parent fails closed', () => expectCode(
    () => resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: c2.registryId,
      ingestionLineageId: graphC.lineage.ingestionLineageId,
      knowledgeCutoff: '2026-01-15T00:00:00.000Z',
    }), 'MARKET_DATA_PARENT_INVISIBLE'));
  run('30 capture-only history remains unprovable before every bound', () => expectCode(
    () => resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: c2.registryId,
      ingestionLineageId: graphC.lineage.ingestionLineageId,
      knowledgeCutoff: '2026-01-11T00:00:00.000Z',
    }), 'MARKET_DATA_HISTORICAL_KNOWLEDGE_NOT_PROVABLE'));
  run('12 authoritative object of another lineage fails closed', () => {
    expectThrow(() => resolveMarketDataAsOf(Object.assign(
      lineageArgs(R, t2), { store: swapStore(store, root02, c1.correctionIds[0]) },
    )));
  });

  // Lineage D: divergent contributing calendar registry branches.
  const graphD = Object.assign({}, graph, { lineage: graph.makeLineage('SYNTHETIC_PROVIDER_D') });
  const calV2a = Calendar.buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [graph.calendar.calendarCoreId].sort(),
      supersedesCalendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    },
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
  const calV2b = Calendar.buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: graph.calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [graph.calendar.calendarCoreId, extraCore.calendarCoreId].sort(),
      supersedesCalendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    },
  });
  const sd1 = makeSource(store, graphD, [atomsRow(graphD, '2026-01-02', {
    calendarRegistryManifestId: calV2a.calendarRegistryManifestId,
  })], '2026-01-06T22:00:00.000Z', 'd1');
  const d1 = appendIngestion(store, graphD, c2.registryId, sd1,
    [candidateBase(graphD, sd1, '2026-01-02', {
      calendarRegistryManifestId: calV2a.calendarRegistryManifestId,
    })], {
      pins: {
        identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
        calendarRegistryManifestId: calV2a.calendarRegistryManifestId,
        corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      },
    });
  const sd2 = makeSource(store, graphD, [atomsRow(graphD, '2026-01-02', {
    closeAtoms: '101', calendarRegistryManifestId: calV2b.calendarRegistryManifestId,
  })], '2026-01-07T00:00:00.000Z', 'd2');
  const d2 = appendIngestion(store, graphD, d1.registryId, sd2,
    [revisionCandidate(graphD, sd2, '2026-01-02', d1.correctionIds[0], { closeAtoms: '101' }, {
      calendarRegistryManifestId: calV2b.calendarRegistryManifestId,
    })], {
      pins: {
        identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
        calendarRegistryManifestId: calV2b.calendarRegistryManifestId,
        corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
      },
    });
  run('35 divergent contributing calendar branches are refused', () => expectCode(
    () => resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: d2.registryId,
      ingestionLineageId: graphD.lineage.ingestionLineageId,
      knowledgeCutoff: '2026-01-07T00:00:00.000Z',
    }), 'MARKET_DATA_CALENDAR_BRANCH'));
});

withStore((store) => {
  const graph = setupI4(store, 'b');
  const rootId = graph.rootRegistry.ingestionRegistryManifestId;
  const revTs = '2026-01-02T21:30:00.000Z';
  const pubTs = '2026-01-05T21:30:00.000Z';
  const lateRevTs = '2026-01-03T00:00:00.000Z';
  const sb1 = makeSource(store, graph, [
    atomsRow(graph, '2026-01-02', { providerPublicationTime: revTs, providerRevisionId: 'rev-a' }),
    atomsRow(graph, '2026-01-05', { providerPublicationTime: pubTs }),
  ], '2026-01-31T00:00:00.000Z', 'b1');
  const b1 = appendIngestion(store, graph, rootId, sb1, [
    candidateBase(graph, sb1, '2026-01-02', {
      sourceRowIndex: 0,
      knowledgeMode: 'PROVIDER_REVISION_HISTORY_ATTESTED',
      knowledgeTimeLowerBound: revTs, knowledgeTimeUpperBound: revTs,
      sourceTimestampEvidenceId: buildEvidence(store, graph, sb1, 0, revTs, 'rev-a'),
      providerRevisionId: 'rev-a',
    }),
    candidateBase(graph, sb1, '2026-01-05', {
      sourceRowIndex: 1,
      knowledgeMode: 'PROVIDER_PUBLICATION_TIME_ATTESTED',
      knowledgeTimeLowerBound: pubTs, knowledgeTimeUpperBound: pubTs,
      sourceTimestampEvidenceId: buildEvidence(store, graph, sb1, 1, pubTs),
    }),
  ]);
  const bar02 = graph.barBySession.get('2026-01-02');
  const root02 = b1.correctionIds.filter((id) => correction(store, id).barIdentityId === bar02)[0];
  const sb2 = makeSource(store, graph,
    [atomsRow(graph, '2026-01-02', { closeAtoms: '101', providerPublicationTime: lateRevTs, providerRevisionId: 'rev-b' })],
    '2026-02-01T00:00:00.000Z', 'b2');
  const b2 = appendIngestion(store, graph, b1.registryId, sb2, [
    revisionCandidate(graph, sb2, '2026-01-02', root02, { closeAtoms: '101' }, {
      knowledgeMode: 'PROVIDER_REVISION_HISTORY_ATTESTED',
      knowledgeTimeLowerBound: lateRevTs, knowledgeTimeUpperBound: lateRevTs,
      sourceTimestampEvidenceId: buildEvidence(store, graph, sb2, 0, lateRevTs, 'rev-b'),
      providerRevisionId: 'rev-b',
    }),
  ]);
  const buildAt = (registryId, knowledgeCutoff) => buildMarketDataResolvedSeriesManifest({
    store, ingestionRegistryManifestId: registryId,
    ingestionLineageId: graph.lineage.ingestionLineageId, knowledgeCutoff,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  });

  run('32 provider-revision history contributes at its historical instant', () => {
    const resolved = resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: b2.registryId,
      ingestionLineageId: graph.lineage.ingestionLineageId, knowledgeCutoff: revTs,
    });
    assert.equal(resolved.resolvedBarEntries.length, 1);
    assert.equal(resolved.temporalCapability, 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED');
  });
  run('31 provider-publication time contributes at its historical instant', () => {
    const resolved = resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: b2.registryId,
      ingestionLineageId: graph.lineage.ingestionLineageId, knowledgeCutoff: pubTs,
    });
    assert.equal(resolved.resolvedBarEntries.length, 2);
    assert.equal(resolved.temporalCapability, 'POINT_IN_TIME_PUBLICATION_ATTESTED');
  });
  run('34 lowered temporal capability is refused', () => {
    const built = buildAt(b2.registryId, revTs);
    const base = readResolved(store, built.resolvedSeriesManifestId);
    assert.equal(base.temporalCapability, 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED');
    expectCode(() => verifyMarketDataResolvedSeriesManifest({
      store,
      resolvedSeriesManifestId: forgeResolved(store, Object.assign({}, base, {
        temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
      })),
    }), 'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH');
  });
  run('27 late historical revision is contributive: prefix and ID advance', () => {
    const before = buildAt(b1.registryId, '2026-01-04T00:00:00.000Z');
    const after = buildAt(b2.registryId, '2026-01-04T00:00:00.000Z');
    assert.notEqual(after.resolvedSeriesManifestId, before.resolvedSeriesManifestId);
    assert.equal(readResolved(store, before.resolvedSeriesManifestId).contributingRegistryPrefixId, b1.registryId);
    assert.equal(readResolved(store, after.resolvedSeriesManifestId).contributingRegistryPrefixId, b2.registryId);
  });

  // Fraudulent appends: concurrent roots (invisible until 02-10), then a branch (02-11).
  const sb3 = makeSource(store, graph, [atomsRow(graph, '2026-01-05', { closeAtoms: '101' })], '2026-02-10T00:00:00.000Z', 'b3');
  const b3 = appendIngestion(store, graph, b2.registryId, sb3,
    [candidateBase(graph, sb3, '2026-01-05', {
      replacementValues: Object.assign({}, VALUES, { closeAtoms: '101' }),
    })], {
      baseView: {
        baseIngestionRegistryManifestId: b2.registryId,
        expectedParentIngestionManifestId: b2.ingestionManifestId,
        terminalCorrectionIds: [], visibleCorrectionIds: [], occupiedBarIdentityIds: [],
        publishedBarIdentityIds: [graph.barBySession.get('2026-01-05')],
        duplicateCandidateIds: [],
      },
    });
  const sb4 = makeSource(store, graph, [atomsRow(graph, '2026-01-02', { closeAtoms: '102', highAtoms: '102' })], '2026-02-11T00:00:00.000Z', 'b4');
  const b4 = appendIngestion(store, graph, b3.registryId, sb4,
    [revisionCandidate(graph, sb4, '2026-01-02', root02, { closeAtoms: '102', highAtoms: '102' })], {
      baseView: {
        baseIngestionRegistryManifestId: b3.registryId,
        expectedParentIngestionManifestId: b3.ingestionManifestId,
        terminalCorrectionIds: [root02],
        visibleCorrectionIds: [root02],
        occupiedBarIdentityIds: [bar02],
        publishedBarIdentityIds: [bar02],
        duplicateCandidateIds: [],
      },
    });
  run('26 future non-contributing appends preserve the manifest identity', () => {
    const before = buildAt(b2.registryId, '2026-01-04T00:00:00.000Z');
    const after = buildAt(b4.registryId, '2026-01-04T00:00:00.000Z');
    assert.equal(after.resolvedSeriesManifestId, before.resolvedSeriesManifestId);
  });
  run('08 concurrent visible roots are refused', () => expectCode(
    () => resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: b4.registryId,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      knowledgeCutoff: '2026-02-10T00:00:00.000Z',
    }), 'MARKET_DATA_RESOLVED_SERIES_CONFLICT'));
  run('05 authoritative visible branch is refused', () => expectCode(
    () => resolveMarketDataAsOf({
      store, ingestionRegistryManifestId: b4.registryId,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      knowledgeCutoff: '2026-02-11T00:00:00.000Z',
    }), 'MARKET_DATA_BAR_REVISION_BRANCH'));
});

const total = passed + failedNames.length;
console.log(JSON.stringify({ total, passed, failed: failedNames.length, failedNames }));
assert.equal(failedNames.length, 0, JSON.stringify(failedNames));
assert.ok(total >= 40, 'at least 40 counter-tests required, got ' + total);
`;
  writeFileSync(harnessPath, source, 'utf8');
  const child = spawnSync(process.execPath, [harnessPath], { encoding: 'utf8', timeout: 570000 });
  try {
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
    const line = child.stdout.trim().split('\n').at(-1);
    const result = JSON.parse(line);
    assert.equal(result.failed, 0, JSON.stringify(result.failedNames));
    assert.ok(result.total >= 40);
    assert.equal(result.passed, result.total);
    console.log(`L3-I4 adversarial harness report: ${line}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
