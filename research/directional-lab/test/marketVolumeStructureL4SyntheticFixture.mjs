/**
 * Synthetic fixtures for L4A-B tests only: internal volume bars for direct
 * formula tests plus a parameterized official L3-I6 binding whose snapshot
 * carries caller-chosen OHLCV/volume sessions, closed by a full L4A-A
 * computation report.
 */

import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
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
import * as Source from '../src/contracts/marketDataSourceL3V1.mjs';
import * as Calendar from '../src/contracts/marketCalendarL3V1.mjs';
import * as Candidate from '../src/contracts/marketDataCandidateL3V1.mjs';
import * as Delta from '../src/contracts/marketDataDeltaL3V1.mjs';
import {
  MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  appendMarketDataIngestionRegistry,
  buildMarketDataIngestionManifest,
  buildMarketDataIngestionRegistryManifest,
  deriveCorporateActionTreatment,
  deriveTemporalCapabilityFromDeltaObjects,
  derivePinnedIngestionBaseView,
  verifyMarketDataIngestionManifest,
} from '../src/contracts/marketDataIngestionRegistryL3V1.mjs';
import {
  MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1,
  runIngestion,
} from '../src/pipeline/runMarketDataIngestionL3V1.mjs';
import { buildMarketDataResolvedSeriesManifest } from '../src/resolution/resolveMarketDataAsOfL3V1.mjs';
import {
  buildMarketDataSnapshotMaterializationPolicy,
  materializeMarketDataSnapshot,
} from '../src/materialization/materializeMarketDataSnapshotL3V1.mjs';
import { defaultDatasetQualityPolicyV1 } from '../src/contracts/datasetQualityAssessmentV1.mjs';
import {
  assessDatasetSnapshotQuality,
  buildDatasetQualityAssessmentRecord,
} from '../src/data/assessDatasetSnapshotQuality.mjs';
import { verifySnapshotDatasetManifest } from '../src/data/buildSnapshotDatasetManifest.mjs';
import {
  buildMarketDataDatasetSnapshotBindingAuthorityPolicy,
  buildRootMarketDataDatasetSnapshotBindingRegistry,
} from '../src/contracts/marketDataDatasetSnapshotBindingL3V1.mjs';
import { publishOfficialMarketDataSnapshotBinding } from '../src/publication/publishOfficialMarketDataSnapshotBindingL3V1.mjs';
import { addDays } from '../src/time/civilDate.mjs';
import {
  buildMarketTechnicalFeatureComputationPolicy,
  buildMarketTechnicalFeatureSourceBundle,
  computeMarketTechnicalFeatures,
} from '../src/features/computeMarketTechnicalFeaturesL4V1.mjs';
import {
  FEATURE_CALCULATION_SCALE,
  fixedFromCanonical,
  fixedToCanonical,
} from '../src/features/fixedPointFeatureMathL4V1.mjs';
import {
  computeAtr14Series,
  computeTrueRangeSeries,
} from '../src/features/volatilityFeaturesL4V1.mjs';
import { simpleReturnAt } from '../src/features/returnsDrawdownFeaturesL4V1.mjs';
import { divideFixed } from '../src/features/fixedPointFeatureMathL4V1.mjs';
import { toInternalVolumeStructureBars } from '../src/features/volumeStructureBarInputsL4V1.mjs';
import { MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1 } from '../src/features/marketVolumeStructureRuntimePolicyL4V1.mjs';
import { withStore } from './l2aSyntheticPipeline.mjs';

const FIRST_SESSION_DATE = '2026-01-02';
const EMPTY_FIXTURE_CUTOFF = '2026-01-02T22:00:00.000Z';
const EMPTY_FIXTURE_ASSESSED_AT = '2026-01-02T23:00:00.000Z';

/**
 * Build internal volume-structure bars for direct formula tests. Volumes may
 * be BigInt atoms or null; prices default to close ± spread.
 */
export function makeVolumeBars(closes, options = {}) {
  const scale = options.scale ?? 0;
  const spread = options.spread ?? 1n;
  const startDate = options.startDate ?? '2020-01-01';
  const rows = closes.map((close, index) => {
    const closeAtoms = typeof close === 'bigint' ? close : BigInt(close);
    const openAtoms = options.opens?.[index] ?? closeAtoms;
    const highAtoms = options.highs?.[index] ?? closeAtoms + spread;
    const lowAtoms = options.lows?.[index] ?? closeAtoms - spread;
    const volume = options.volumes === undefined ? 1000n : options.volumes[index];
    return {
      sessionDate: addDays(startDate, index),
      barIdentityId: `sha256:${index.toString(16).padStart(64, '0')}`,
      resolvedObservationId: `sha256:${(index + closes.length + 1).toString(16).padStart(64, '0')}`,
      frequency: 'DAILY_REGULAR_SESSION',
      currency: 'USD',
      openAtoms: openAtoms.toString(),
      highAtoms: highAtoms.toString(),
      lowAtoms: lowAtoms.toString(),
      closeAtoms: closeAtoms.toString(),
      priceScale: scale,
      volumeAtoms: volume === null ? null : volume.toString(),
      volumeScale: volume === null ? null : 0,
      priceBasis: 'RAW',
    };
  });
  return toInternalVolumeStructureBars(rows, MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1.barInputs);
}

/** @param {any} cell canonical-roundtrip an internal L4A-A cell like the orchestrator does */
function roundTripCell(cell) {
  if (cell.availability !== 'AVAILABLE') return { value: null, availability: cell.availability };
  return {
    value: fixedFromCanonical(fixedToCanonical(cell.value, 12), FEATURE_CALCULATION_SCALE),
    availability: 'AVAILABLE',
  };
}

/**
 * Synthetic L4A-A dependency cells for direct tests, using the real L4A-A
 * calculators and the same canonical scale-12 round-trip the orchestrator
 * applies when reading published L4A-A rows.
 */
export function makeTechnicalCellsFromBars(bars) {
  const trueRanges = computeTrueRangeSeries(bars);
  const atr14 = computeAtr14Series(trueRanges);
  return bars.map((bar, index) => {
    const atrCell = roundTripCell(atr14[index]);
    let atrPct;
    if (atrCell.availability !== 'AVAILABLE') atrPct = { value: null, availability: atrCell.availability };
    else if (bar.close.atoms === 0n) atrPct = { value: null, availability: 'DIVISION_BY_ZERO' };
    else atrPct = roundTripCell({ value: divideFixed(atr14[index].value, bar.close), availability: 'AVAILABLE' });
    const return20 = roundTripCell(simpleReturnAt(bars, index, 20));
    return { atr14: atrCell, atr14Pct: atrPct, return20 };
  });
}

/** Sequential synthetic session dates for the official fixture. */
export function fixtureSessionDates(count) {
  return Array.from({ length: count }, (_, index) => addDays(FIRST_SESSION_DATE, index));
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

function buildAuthorityGraph(store, sessionDates) {
  const lastSessionDate = sessionDates.length === 0 ? null : sessionDates[sessionDates.length - 1];
  const boundsToExclusive = lastSessionDate === null
    ? addDays(FIRST_SESSION_DATE, 1)
    : addDays(lastSessionDate, 1);
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store,
    authorityId: 'l4b-synthetic-instruments/1',
    identitySeedFormat: 'HEX_LOWERCASE',
    identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store,
    authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: '5'.repeat(64),
    instrumentKind: 'EQUITY',
  });
  const instrumentManifest = buildInstrumentIdentityManifest({
    store,
    instrumentIdentityId: instrument.instrumentIdentityId,
    aliasBindingCoreIds: [],
  });
  const instrumentRegistry = buildInstrumentIdentityRegistry({
    store,
    authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identityManifestIds: [instrumentManifest.identityManifestId],
  });
  const corporatePolicies = buildCorporateActionPolicies({
    store,
    authorityPolicy: {
      schemaVersion: CA.AUTHORITY,
      authorityId: 'l4b-synthetic-actions/1',
      identityNamespaceVersion: 'L4B/1',
      eventSeedFormat: 'HEX_LOWERCASE',
      eventSeedLength: 64,
    },
    normalizationPolicy: {
      schemaVersion: CA.NORMALIZATION,
      normalizationVersion: 'L4B/1',
      supportedEventKinds: ['FORWARD_SPLIT'],
      currencyCodes: ['USD'],
    },
    temporalPolicy: {
      schemaVersion: CA.TEMPORAL,
      temporalPolicyVersion: 'L4B/1',
      dateOnlyLowerBoundMode: 'START_UTC',
      maxRulesetDays: 366,
    },
    adjudicationPolicy: {
      schemaVersion: CA.ADJUDICATION_POLICY,
      adjudicationPolicyVersion: 'L4B/1',
      requireAllVisibleObservations: true,
      allowContested: false,
    },
    priceAdjustmentPolicy: {
      schemaVersion: CA.PRICE_POLICY,
      policyVersion: 'L4B/1',
      supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'],
    },
    entitlementPolicy: {
      schemaVersion: CA.ENTITLEMENT_POLICY,
      policyVersion: 'L4B/1',
      roundingRule: 'EXACT_ONLY',
      fractionalShareRule: 'FAIL_CLOSED',
    },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store,
    ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const dayCount = sessionDates.length === 0 ? 1 : sessionDates.length;
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l4b',
      validFromDate: FIRST_SESSION_DATE,
      validToDateExclusive: boundsToExclusive,
      civilDateBounds: Array.from({ length: dayCount }, (_, index) => {
        const civilDate = addDays(FIRST_SESSION_DATE, index);
        return {
          civilDate,
          startUtc: `${civilDate}T05:00:00.000Z`,
          endUtcExclusive: `${addDays(civilDate, 1)}T05:00:00.000Z`,
        };
      }),
    },
  });
  const calendarPolicy = Calendar.buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: Calendar.MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION'],
      calendarNamespaceVersion: 'synthetic-l4b/1',
    },
  });
  const calendar = Calendar.buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      coverageFromDate: FIRST_SESSION_DATE,
      coverageToDateExclusive: boundsToExclusive,
      sessions: sessionDates.map((sessionDate) => ({
        sessionDate,
        sessionKind: 'REGULAR_SESSION',
        openUtc: `${sessionDate}T14:30:00.000Z`,
        closeUtc: `${sessionDate}T21:00:00.000Z`,
        marketValidTime: `${sessionDate}T21:00:00.000Z`,
      })),
    },
  });
  const calendarRegistry = Calendar.buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: Calendar.MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [calendar.calendarCoreId],
      supersedesCalendarRegistryManifestId: null,
    },
  });
  const ingestionPolicy = Source.buildMarketDataIngestionPolicy({
    store,
    policy: {
      schemaVersion: Source.MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
      allowedInstrumentKinds: ['EQUITY'],
      allowedFrequencies: ['DAILY_REGULAR_SESSION'],
      allowedPriceBases: ['RAW', 'SPLIT_ADJUSTED'],
      allowedSourceDatasetKinds: ['EOD_OHLCV'],
      allowedPayloadFormats: ['CSV_UTF8'],
      maxArtifactBytes: 1000000,
      knowledgeModes: [
        'CAPTURE_TIME_ONLY',
        'PROVIDER_PUBLICATION_TIME_ATTESTED',
        'PROVIDER_REVISION_HISTORY_ATTESTED',
      ],
      providerPublicationTimeField: 'providerPublicationTime',
      providerRevisionIdField: 'providerRevisionId',
      unknownFieldPolicy: 'REJECT',
      duplicateIdenticalRowPolicy: 'ACCEPT_IDENTICAL',
      volumePolicy: 'NULLABLE_NON_NEGATIVE_DECIMAL_STRING',
    },
  });
  const lineage = Source.buildMarketDataIngestionLineage({
    store,
    lineage: {
      schemaVersion: Source.MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
      providerId: 'SYNTHETIC_PROVIDER',
      instrumentIdentityId: instrument.instrumentIdentityId,
      frequency: 'DAILY_REGULAR_SESSION',
      venueId: 'XNAS',
      priceBasis: 'RAW',
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
      registryNamespaceVersion: 'synthetic-l4b/1',
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
  return {
    instrumentRegistry, corporateRegistry, calendarRegistry, ingestionPolicy, lineage, rootRegistry,
  };
}

function buildSource(store, graph, sessions) {
  const lastSessionDate = sessions.length === 0 ? null : sessions[sessions.length - 1].sessionDate;
  const header = [...MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1];
  header.push(graph.ingestionPolicy.ingestionPolicy.providerPublicationTimeField);
  header.push(graph.ingestionPolicy.ingestionPolicy.providerRevisionIdField);
  const rows = sessions.map((session) => {
    const cells = {
      sessionDate: session.sessionDate,
      openAtoms: session.openAtoms,
      highAtoms: session.highAtoms,
      lowAtoms: session.lowAtoms,
      closeAtoms: session.closeAtoms,
      priceScale: session.priceScale ?? '2',
      volumeAtoms: session.volumeAtoms ?? '',
      volumeScale: session.volumeScale ?? (session.volumeAtoms ? '0' : ''),
      currency: 'USD',
      knowledgeMode: 'CAPTURE_TIME_ONLY',
      identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
      calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
      corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
    };
    return header.map((field) => cells[field] ?? '').join(',');
  });
  const bytes = Buffer.from([header.join(','), ...rows, ''].join('\n'));
  const sourceObject = store.putSourceBytes(bytes);
  const artifact = Source.buildMarketDataSourceArtifact({
    store,
    ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
    artifact: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      payloadFormat: 'CSV_UTF8',
      mediaType: 'text/csv; charset=utf-8',
      embeddedBytesObjectId: sourceObject.objectId,
      payloadDigest: sourceObject.objectId,
      payloadByteLength: bytes.length,
    },
  });
  const attestation = Source.buildMarketDataSourceAttestation({
    store,
    attestation: {
      schemaVersion: Source.MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      attestationMode: 'EMBEDDED_ARTIFACT',
      embeddedArtifactId: artifact.sourceArtifactId,
      payloadDigest: null,
      payloadByteLength: null,
      payloadFormat: null,
      providerId: null,
    },
  });
  const acquisition = Source.buildMarketDataAcquisitionRecord({
    store,
    record: {
      schemaVersion: Source.MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      acquisitionTimeUtc: lastSessionDate === null
        ? EMPTY_FIXTURE_CUTOFF
        : `${lastSessionDate}T22:00:00.000Z`,
      providerId: graph.lineage.ingestionLineage.providerId,
      logicalEndpointKind: 'EOD_OHLCV_DATASET',
      requestDatasetKind: 'EOD_OHLCV',
      executionIdentity: { runnerId: 'node-test', runId: 'l4b-fixture', environment: 'LOCAL_TEST' },
      sourceAttestationId: attestation.sourceAttestationId,
    },
  });
  return { artifact, attestation, acquisition };
}

function appendWithdrawalForOnlySession(store, graph, firstIngestion) {
  const verifiedFirst = verifyMarketDataIngestionManifest({
    store, ingestionManifestId: firstIngestion.ingestionManifestId,
  }).ingestionManifest;
  const candidateSet = Candidate.verifyMarketDataCandidateSet({
    store, candidateSetId: firstIngestion.candidateSetId,
  });
  if (candidateSet.candidates.length !== 1) {
    throw new Error('empty L4A-B fixture requires exactly one seed candidate');
  }
  const firstAssembly = Delta.verifyNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: firstIngestion.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  if (firstAssembly.acceptedCorrectionIds.length !== 1) {
    throw new Error('empty L4A-B fixture requires exactly one seed correction');
  }
  const registryId = firstIngestion.ingestionRegistryManifestId;
  const parentId = firstIngestion.ingestionManifestId;
  const pins = {
    identityRegistryManifestId: graph.instrumentRegistry.registryManifestId,
    calendarRegistryManifestId: graph.calendarRegistry.calendarRegistryManifestId,
    corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
  };
  const full = derivePinnedIngestionBaseView(
    store, registryId, graph.lineage.ingestionLineageId, parentId,
  );
  const initial = candidateSet.candidates[0];
  const withdrawal = {
    ...initial,
    candidateKind: 'BAR_WITHDRAWAL',
    targetCorrectionId: firstAssembly.acceptedCorrectionIds[0],
  };
  delete withdrawal.replacementValues;
  const built = Candidate.buildMarketDataNormalizedCandidate({ store, candidate: withdrawal });
  const view = {
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: parentId,
    terminalCorrectionIds: full.terminalCorrectionIds,
    visibleCorrectionIds: full.visibleCorrectionIds,
    occupiedBarIdentityIds: full.occupiedBarIdentityIds,
    publishedBarIdentityIds: full.publishedBarIdentityIds,
    duplicateCandidateIds: [],
  };
  const set = Candidate.buildMarketDataCandidateSet({
    store,
    candidateSet: {
      schemaVersion: Candidate.MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      sourceArtifactId: initial.sourceArtifactId,
      acquisitionRecordId: initial.acquisitionRecordId,
      parseResultId: initial.parseResultId,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      ...pins,
      candidateIds: [built.candidateId],
    },
  });
  const report = Candidate.validateMarketDataCandidateSet({
    store, candidateSetId: set.candidateSetId, baseView: view,
  });
  const published = Delta.publishValidatedMarketDataDelta({
    store, candidateSetId: set.candidateSetId,
    validationReportId: report.validationReportId, baseView: view,
  });
  if (published.status !== 'PUBLISHED') throw new Error('empty L4A-B withdrawal was not published');
  const assembly = Delta.verifyNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: published.deltaAssemblyManifestId,
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
      sourceArtifactId: initial.sourceArtifactId,
      sourceAttestationId: verifiedFirst.sourceAttestationId,
      acquisitionRecordId: initial.acquisitionRecordId,
      parseResultId: initial.parseResultId,
      candidateSetId: set.candidateSetId,
      validationReportId: report.validationReportId,
      acceptedCandidatePublicationManifestId: published.publicationManifestId,
      deltaAssemblyManifestId: published.deltaAssemblyManifestId,
      newBarObservationIds,
      newBarCorrectionIds,
      temporalCapability: deriveTemporalCapabilityFromDeltaObjects(
        store, newBarObservationIds, newBarCorrectionIds,
      ),
      priceBasis: graph.lineage.ingestionLineage.priceBasis,
      corporateActionTreatment: deriveCorporateActionTreatment(
        graph.lineage.ingestionLineage.priceBasis,
      ),
    },
  });
  return appendMarketDataIngestionRegistry({
    store,
    baseIngestionRegistryManifestId: registryId,
    expectedParentIngestionManifestId: parentId,
    ingestionManifestId: ingestion.ingestionManifestId,
  }).ingestionRegistryManifestId;
}

/**
 * Build a full official L3-I6 binding over the supplied synthetic sessions.
 * @param {Array<object>} sessions rows with atoms strings and sessionDate
 * @param {(context: object) => any} callback
 */
export function withOfficialVolumeStructureBinding(sessions, callback, options = {}) {
  return withStore((store, root) => {
    if (options.beforeBuild !== undefined) options.beforeBuild({ store, root });
    const lastSessionDate = sessions.length === 0 ? null : sessions[sessions.length - 1].sessionDate;
    const knowledgeCutoff = lastSessionDate === null
      ? EMPTY_FIXTURE_CUTOFF
      : `${lastSessionDate}T22:00:00.000Z`;
    const assessedAt = lastSessionDate === null
      ? EMPTY_FIXTURE_ASSESSED_AT
      : `${lastSessionDate}T23:00:00.000Z`;
    const pipelineSessions = sessions.length === 0
      ? [{
        sessionDate: FIRST_SESSION_DATE,
        openAtoms: '10000', highAtoms: '10100', lowAtoms: '9900', closeAtoms: '10000',
        priceScale: '2', volumeAtoms: '1000000', volumeScale: '0',
      }]
      : sessions;
    const graph = buildAuthorityGraph(
      store, pipelineSessions.map((session) => session.sessionDate),
    );
    const source = buildSource(store, graph, pipelineSessions);
    const ingestion = runIngestion({
      store,
      baseIngestionRegistryManifestId: graph.rootRegistry.ingestionRegistryManifestId,
      expectedParentIngestionManifestId: null,
      ingestionPolicyId: graph.ingestionPolicy.ingestionPolicyId,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      sourceArtifactId: source.artifact.sourceArtifactId,
      sourceAttestationId: source.attestation.sourceAttestationId,
      acquisitionRecordId: source.acquisition.acquisitionRecordId,
    });
    const ingestionRegistryManifestId = sessions.length === 0
      ? appendWithdrawalForOnlySession(store, graph, ingestion)
      : ingestion.ingestionRegistryManifestId;
    const resolved = buildMarketDataResolvedSeriesManifest({
      store,
      ingestionRegistryManifestId,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      knowledgeCutoff,
      corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
    });
    const materializationPolicy = buildMarketDataSnapshotMaterializationPolicy({ store });
    const materialization = materializeMarketDataSnapshot({
      store,
      ingestionRegistryManifestId,
      resolvedSeriesManifestId: resolved.resolvedSeriesManifestId,
      materializationPolicyId: materializationPolicy.materializationPolicyId,
    });
    const snapshotManifest = verifySnapshotDatasetManifest({
      store,
      snapshotDatasetManifestId: materialization.datasetSnapshotManifestId,
    });
    const assessed = assessDatasetSnapshotQuality({
      store,
      snapshotCoreId: snapshotManifest.manifest.snapshotCoreId,
      policy: defaultDatasetQualityPolicyV1(),
    });
    const quality = buildDatasetQualityAssessmentRecord({
      store,
      qualityAssessmentCoreId: assessed.qualityCoreId,
      assessedAt,
      assessmentToolVersion: 'l4b-quality/1',
      nodeVersion: 'v20.0.0',
      executionIdentity: { runnerId: 'node-test', runId: 'l4b-quality', environment: 'LOCAL_TEST' },
    });
    const bindingAuthority = buildMarketDataDatasetSnapshotBindingAuthorityPolicy({ store });
    const bindingRoot = buildRootMarketDataDatasetSnapshotBindingRegistry({
      store,
      bindingAuthorityPolicyId: bindingAuthority.bindingAuthorityPolicyId,
    });
    const published = publishOfficialMarketDataSnapshotBinding({
      store,
      baseBindingRegistryManifestId: bindingRoot.bindingRegistryManifestId,
      expectedParentBindingId: null,
      materializationReportId: materialization.materializationReportId,
      qualityAssessmentId: quality.recordId,
    });
    return callback({ store, root, graph, materialization, bindingRoot, published });
  });
}

/**
 * Official binding + verified L4A-A computation over the sessions, handing
 * the L4A-A report ID to the callback — the authoritative L4A-B entry.
 */
export function withOfficialL4AReport(sessions, callback, options = {}) {
  return withOfficialVolumeStructureBinding(sessions, (context) => {
    const technicalPolicy = buildMarketTechnicalFeatureComputationPolicy({ store: context.store });
    const technicalBundle = buildMarketTechnicalFeatureSourceBundle({
      store: context.store,
      subject: {
        bindingRegistryManifestId: context.published.bindingRegistryManifestId,
        bindingId: context.published.bindingId,
      },
      benchmarks: [],
    });
    const technical = computeMarketTechnicalFeatures({
      store: context.store,
      technicalFeatureSourceBundleId: technicalBundle.technicalFeatureSourceBundleId,
      technicalFeatureComputationPolicyId: technicalPolicy.technicalFeatureComputationPolicyId,
    });
    return callback({ ...context, technicalPolicy, technicalBundle, technical });
  }, options);
}

/** Simple deterministic OHLCV session specs for pipeline-level tests. */
export function defaultFixtureSessions(count) {
  const dates = fixtureSessionDates(count);
  return dates.map((sessionDate, index) => {
    const close = 10000 + 400 * (index % 5) + 25 * index;
    const high = close + 220;
    const low = close - 220;
    return {
      sessionDate,
      openAtoms: String(close - 40),
      highAtoms: String(high),
      lowAtoms: String(low),
      closeAtoms: String(close),
      priceScale: '2',
      volumeAtoms: String(1000000 + 50000 * (index % 4)),
      volumeScale: '0',
    };
  });
}
