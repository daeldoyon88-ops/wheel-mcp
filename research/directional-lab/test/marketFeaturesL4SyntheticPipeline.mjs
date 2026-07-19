/** Synthetic official L3-I6 binding fixture for L4 integration tests only. */

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
import {
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  buildMarketDataIngestionRegistryManifest,
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
import { toInternalFeatureBars } from '../src/features/fixedPointFeatureMathL4V1.mjs';
import { withStore } from './l2aSyntheticPipeline.mjs';

const SESSION_DATES = Object.freeze(['2026-01-02', '2026-01-05']);

/** Build unique synthetic observed-session bars for direct formula tests. */
export function makeInternalBars(closes, options = {}) {
  const scale = options.scale ?? 0;
  const spread = options.spread ?? 1n;
  const startDate = options.startDate ?? '2020-01-01';
  const rows = closes.map((close, index) => {
    const closeAtoms = typeof close === 'bigint' ? close : BigInt(close);
    const openAtoms = options.opens?.[index] ?? closeAtoms;
    const highAtoms = options.highs?.[index] ?? closeAtoms + spread;
    const lowAtoms = options.lows?.[index] ?? closeAtoms - spread;
    const suffix = index.toString(16).padStart(64, '0');
    return {
      sessionDate: addDays(startDate, index),
      barIdentityId: `sha256:${suffix}`,
      resolvedObservationId: `sha256:${(index + closes.length + 1).toString(16).padStart(64, '0')}`,
      frequency: 'DAILY_REGULAR_SESSION',
      currency: options.currency ?? 'USD',
      openAtoms: openAtoms.toString(),
      highAtoms: highAtoms.toString(),
      lowAtoms: lowAtoms.toString(),
      closeAtoms: closeAtoms.toString(),
      priceScale: scale,
      volumeAtoms: '1000',
      volumeScale: 0,
      priceBasis: 'RAW',
    };
  });
  return toInternalFeatureBars(rows);
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

function buildAuthorityGraph(store) {
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({
    store,
    authorityId: 'l4a-synthetic-instruments/1',
    identitySeedFormat: 'HEX_LOWERCASE',
    identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store,
    authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identitySeed: '4'.repeat(64),
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
      authorityId: 'l4a-synthetic-actions/1',
      identityNamespaceVersion: 'L4A/1',
      eventSeedFormat: 'HEX_LOWERCASE',
      eventSeedLength: 64,
    },
    normalizationPolicy: {
      schemaVersion: CA.NORMALIZATION,
      normalizationVersion: 'L4A/1',
      supportedEventKinds: ['FORWARD_SPLIT'],
      currencyCodes: ['USD'],
    },
    temporalPolicy: {
      schemaVersion: CA.TEMPORAL,
      temporalPolicyVersion: 'L4A/1',
      dateOnlyLowerBoundMode: 'START_UTC',
      maxRulesetDays: 366,
    },
    adjudicationPolicy: {
      schemaVersion: CA.ADJUDICATION_POLICY,
      adjudicationPolicyVersion: 'L4A/1',
      requireAllVisibleObservations: true,
      allowContested: false,
    },
    priceAdjustmentPolicy: {
      schemaVersion: CA.PRICE_POLICY,
      policyVersion: 'L4A/1',
      supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'],
    },
    entitlementPolicy: {
      schemaVersion: CA.ENTITLEMENT_POLICY,
      policyVersion: 'L4A/1',
      roundingRule: 'EXACT_ONLY',
      fractionalShareRule: 'FAIL_CLOSED',
    },
  });
  const corporateRegistry = buildCorporateActionRegistry({
    store,
    ...corporateRegistryArgs(corporatePolicies, instrumentRegistry),
  });
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: CA.TIMEZONE,
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l4a',
      validFromDate: '2026-01-02',
      validToDateExclusive: '2026-01-13',
      civilDateBounds: Array.from({ length: 11 }, (_, index) => {
        const civilDate = addDays('2026-01-02', index);
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
      calendarNamespaceVersion: 'synthetic-l4a/1',
    },
  });
  const calendar = Calendar.buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: Calendar.MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      coverageFromDate: '2026-01-02',
      coverageToDateExclusive: '2026-01-13',
      sessions: SESSION_DATES.map((sessionDate) => ({
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
  const knowledgeModes = [
    'CAPTURE_TIME_ONLY',
    'PROVIDER_PUBLICATION_TIME_ATTESTED',
    'PROVIDER_REVISION_HISTORY_ATTESTED',
  ];
  const ingestionPolicy = Source.buildMarketDataIngestionPolicy({
    store,
    policy: {
      schemaVersion: Source.MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
      allowedInstrumentKinds: ['EQUITY'],
      allowedFrequencies: ['DAILY_REGULAR_SESSION'],
      allowedPriceBases: ['RAW', 'SPLIT_ADJUSTED'],
      allowedSourceDatasetKinds: ['EOD_OHLCV'],
      allowedPayloadFormats: ['CSV_UTF8'],
      maxArtifactBytes: 100000,
      knowledgeModes,
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
      registryNamespaceVersion: 'synthetic-l4a/1',
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
    instrumentRegistry,
    corporateRegistry,
    calendarRegistry,
    ingestionPolicy,
    lineage,
    rootRegistry,
  };
}

function buildSource(store, graph) {
  const header = [...MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1];
  header.push(graph.ingestionPolicy.ingestionPolicy.providerPublicationTimeField);
  header.push(graph.ingestionPolicy.ingestionPolicy.providerRevisionIdField);
  const rows = SESSION_DATES.map((sessionDate, index) => {
    const cells = {
      sessionDate,
      openAtoms: index === 0 ? '10000' : '11000',
      highAtoms: index === 0 ? '10200' : '11200',
      lowAtoms: index === 0 ? '9900' : '10900',
      closeAtoms: index === 0 ? '10100' : '11100',
      priceScale: '2',
      volumeAtoms: '1000000',
      volumeScale: '0',
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
      acquisitionTimeUtc: '2026-01-05T22:00:00.000Z',
      providerId: graph.lineage.ingestionLineage.providerId,
      logicalEndpointKind: 'EOD_OHLCV_DATASET',
      requestDatasetKind: 'EOD_OHLCV',
      executionIdentity: { runnerId: 'node-test', runId: 'l4a-fixture', environment: 'LOCAL_TEST' },
      sourceAttestationId: attestation.sourceAttestationId,
    },
  });
  return { artifact, attestation, acquisition };
}

export function withOfficialL4Binding(callback) {
  return withStore((store) => {
    const graph = buildAuthorityGraph(store);
    const source = buildSource(store, graph);
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
    const resolved = buildMarketDataResolvedSeriesManifest({
      store,
      ingestionRegistryManifestId: ingestion.ingestionRegistryManifestId,
      ingestionLineageId: graph.lineage.ingestionLineageId,
      knowledgeCutoff: '2026-01-05T22:00:00.000Z',
      corporateActionRegistryManifestId: graph.corporateRegistry.registryManifestId,
    });
    const materializationPolicy = buildMarketDataSnapshotMaterializationPolicy({ store });
    const materialization = materializeMarketDataSnapshot({
      store,
      ingestionRegistryManifestId: ingestion.ingestionRegistryManifestId,
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
      assessedAt: '2026-01-05T23:00:00.000Z',
      assessmentToolVersion: 'l4a-quality/1',
      nodeVersion: 'v20.0.0',
      executionIdentity: { runnerId: 'node-test', runId: 'l4a-quality', environment: 'LOCAL_TEST' },
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
    return callback({ store, graph, source, ingestion, resolved, materialization, quality, bindingRoot, published });
  });
}
