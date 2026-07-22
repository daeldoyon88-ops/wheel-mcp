import { CanonicalizationError } from './canonicalJsonV1.mjs';
import {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  normalizeCanonicalDailyBarsV1,
} from './canonicalDailyBarsV1.mjs';
import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  normalizeDatasetSnapshotCoreV1,
  normalizeDatasetSnapshotRecordV1,
} from '../contracts/datasetSnapshotV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
  normalizeTransformImplementationManifestV1,
} from '../data/transformImplementationManifestV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  normalizeTransformImplementationManifestV2,
} from '../data/transformImplementationManifestV2.mjs';
import {
  LEGACY_DATASET_MANIFEST_SCHEMA_VERSION,
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  normalizeLegacyDatasetManifestV1,
  normalizeSnapshotDatasetManifestV1,
} from '../contracts/snapshotDatasetManifestV1.mjs';
import {
  DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION,
  normalizeDatasetMaterializationVerificationV1,
} from '../contracts/datasetMaterializationVerificationV1.mjs';
import {
  TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION,
  normalizeTransformPipelineProfileV1,
} from '../contracts/transformPipelineProfileV1.mjs';
import {
  DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
  DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION,
  DATASET_QUALITY_POLICY_SCHEMA_VERSION,
  normalizeDatasetQualityAssessmentCoreV1,
  normalizeDatasetQualityAssessmentRecordV1,
  normalizeDatasetQualityPolicyV1,
} from '../contracts/datasetQualityAssessmentV1.mjs';
import {
  DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION,
  INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION,
  INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
  PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION,
  PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION,
  SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION,
  normalizeDatasetSnapshotInstrumentBindingV1,
  normalizeInstrumentAliasBindingCoreV1,
  normalizeInstrumentAliasRevocationCoreV1,
  normalizeInstrumentDescriptorCoreV1,
  normalizeInstrumentIdentityAuthorityPolicyV1,
  normalizeInstrumentIdentityCoreV1,
  normalizeInstrumentIdentityManifestV1,
  normalizeInstrumentIdentityRecordV1,
  normalizeInstrumentIdentityRegistryManifestV1,
  normalizeProviderInstrumentBindingCoreV1,
  normalizeProviderInstrumentRevocationCoreV1,
  normalizeSymbolNamespacePolicyV1,
} from '../contracts/instrumentIdentityV1.mjs';
import {
  CORPORATE_ACTION_SCHEMA_VERSIONS,
  normalizeCorporateActionCanonicalValue,
} from '../contracts/corporateActionL2CV1.mjs';
import {
  MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_CALENDAR_L3_SCHEMA_VERSIONS,
  MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
  normalizeMarketCalendarAuthorityPolicyV1,
  normalizeMarketCalendarRegistryManifestV1,
  normalizeMarketSessionCalendarCoreV1,
} from '../contracts/marketCalendarL3V1.mjs';
import {
  MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_L3_SCHEMA_VERSIONS,
  MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
  normalizeMarketDataAcquisitionRecordCoreV1,
  normalizeMarketDataIngestionLineageCoreV1,
  normalizeMarketDataIngestionPolicyV1,
  normalizeMarketDataIngestionRegistryAuthorityPolicyV1,
  normalizeMarketDataParseResultCoreV1,
  normalizeMarketDataSourceArtifactCoreV1,
  normalizeMarketDataSourceAttestationCoreV1,
  normalizeMarketDataSourceTemporalEvidenceCoreV1,
} from '../contracts/marketDataSourceL3V1.mjs';
import {
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
  MARKET_DATA_BAR_IDENTITY_L3_SCHEMA_VERSIONS,
  normalizeMarketDataBarIdentityCoreV1,
} from '../contracts/marketDataBarIdentityL3V1.mjs';
import {
  MARKET_DATA_CANDIDATE_L3_SCHEMA_VERSIONS,
  MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
  MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
  MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
  normalizeMarketDataCandidateSetCoreV1,
  normalizeMarketDataNormalizedCandidateV1,
  normalizeMarketDataValidationReportV1,
} from '../contracts/marketDataCandidateL3V1.mjs';
import {
  MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
  MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
  MARKET_DATA_BAR_REVISION_L3_SCHEMA_VERSIONS,
  normalizeMarketDataAcceptedCandidatePublicationManifestV1,
  normalizeMarketDataBarCorrectionCoreV1,
  normalizeMarketDataBarObservationCoreV1,
} from '../contracts/marketDataBarRevisionL3V1.mjs';
import {
  MARKET_DATA_DELTA_L3_SCHEMA_VERSIONS,
  NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION,
  NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION,
  normalizeNormalizedMarketDataDeltaAssemblyManifestV1,
  normalizeNormalizedMarketDataDeltaChunkV1,
} from '../contracts/marketDataDeltaL3V1.mjs';
import {
  MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_L3_SCHEMA_VERSIONS,
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  normalizeMarketDataIngestionManifestV1,
  normalizeMarketDataIngestionRegistryManifestV1,
} from '../contracts/marketDataIngestionRegistryL3V1.mjs';
import {
  MARKET_DATA_RESOLVED_SERIES_L3_SCHEMA_VERSIONS,
  MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
  normalizeMarketDataResolvedSeriesManifestV1,
} from '../contracts/marketDataResolvedSeriesL3V1.mjs';
import {
  MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_L3_SCHEMA_VERSIONS,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketDataEodOhlcvCanonicalRowsV1,
  normalizeMarketDataSnapshotMaterializationPolicyV1,
  normalizeMarketDataSnapshotMaterializationReportV1,
  normalizeMarketDataSnapshotSourceBundleV1,
} from '../contracts/marketDataSnapshotMaterializationL3V1.mjs';
import {
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_L3_SCHEMA_VERSIONS,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
  normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1,
  normalizeMarketDataDatasetSnapshotBindingRegistryManifestV1,
  normalizeMarketDataDatasetSnapshotBindingV1,
} from '../contracts/marketDataDatasetSnapshotBindingL3V1.mjs';
import {
  MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_L4_SCHEMA_VERSIONS,
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketTechnicalFeatureComputationPolicyV1,
  normalizeMarketTechnicalFeatureComputationReportV1,
  normalizeMarketTechnicalFeatureRowsV1,
  normalizeMarketTechnicalFeatureSourceBundleV1,
} from '../contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_L4_SCHEMA_VERSIONS,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketVolumeStructureFeatureComputationPolicyV1,
  normalizeMarketVolumeStructureFeatureComputationReportV1,
  normalizeMarketVolumeStructureFeatureRowsV1,
  normalizeMarketVolumeStructureFeatureSourceBundleV1,
} from '../contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_L4_SCHEMA_VERSIONS,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketSeasonalityFeatureComputationPolicyV1,
  normalizeMarketSeasonalityFeatureComputationReportV1,
  normalizeMarketSeasonalityFeatureRowsV1,
  normalizeMarketSeasonalityFeatureSourceBundleV1,
} from '../contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_L4_SCHEMA_VERSIONS,
  MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  normalizeMarketFeaturePublicationAuthorityPolicyV1,
  normalizeMarketFeaturePublicationManifestV1,
  normalizeMarketFeaturePublicationRegistryManifestV1,
} from '../contracts/marketFeaturePublicationContractsV1.mjs';
import {
  MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  MACRO_INGESTION_L4B_SCHEMA_VERSIONS,
  MACRO_INGESTION_POLICY_SCHEMA_VERSION,
  MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
  MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
  normalizeMacroDatasetSnapshotManifestV1,
  normalizeMacroIngestionPolicyV1,
  normalizeMacroObservationIdentityCoreV1,
  normalizeMacroObservationVintageCoreV1,
  normalizeMacroSeriesIdentityCoreV1,
  normalizeMacroSeriesRegistryManifestV1,
  normalizeMacroVintageIdentityCoreV1,
  normalizeMacroVintageSetManifestV1,
} from '../contracts/macroIngestionContractsL4BV1.mjs';
import {
  MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  MACRO_DATASET_BINDING_SCHEMA_VERSION,
  MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS,
  MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  normalizeMacroAsOfResolutionPolicyV1,
  normalizeMacroDatasetBindingV1,
  normalizeMacroMaterializationReportV1,
  normalizeMacroReleaseCalendarRegistryManifestV1,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS,
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMacroStateBySessionRowsV1,
  normalizeMarketMacroFeatureComputationPolicyV1,
  normalizeMarketMacroFeatureComputationReportV1,
  normalizeMarketMacroFeatureSourceBundleV1,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
/**
 * Snapshot-metadata schemas the CAS `snapshots` namespace may store. The
 * legacy DatasetManifestV1 canonical copy is historical evidence only; the
 * snapshot identity remains founded on the L1 core and CAS objects.
 * L2B instrument-identity schemas are additive registrations in the same
 * namespace (no new CAS path layout; no change to L1/L2A contract bytes).
 */
export const SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS = Object.freeze([
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  LEGACY_DATASET_MANIFEST_SCHEMA_VERSION,
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION,
  TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION,
  DATASET_QUALITY_POLICY_SCHEMA_VERSION,
  DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
  DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION,
  INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION,
  SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION,
  INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION,
  PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION,
  INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION,
  PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
  DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  ...CORPORATE_ACTION_SCHEMA_VERSIONS,
  ...MARKET_CALENDAR_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_SOURCE_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_BAR_IDENTITY_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_CANDIDATE_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_BAR_REVISION_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_DELTA_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_INGESTION_REGISTRY_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_RESOLVED_SERIES_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_SNAPSHOT_MATERIALIZATION_L3_SCHEMA_VERSIONS,
  ...MARKET_DATA_DATASET_SNAPSHOT_BINDING_L3_SCHEMA_VERSIONS,
  ...MARKET_TECHNICAL_FEATURE_L4_SCHEMA_VERSIONS,
  ...MARKET_VOLUME_STRUCTURE_FEATURE_L4_SCHEMA_VERSIONS,
  ...MARKET_SEASONALITY_FEATURE_L4_SCHEMA_VERSIONS,
  ...MARKET_FEATURE_PUBLICATION_L4_SCHEMA_VERSIONS,
  ...MACRO_INGESTION_L4B_SCHEMA_VERSIONS,
  ...MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS,
  ...MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS,
]);

/** @param {string} schemaVersion @param {unknown} value */
export function normalizeCanonicalValue(schemaVersion, value) {
  if (CORPORATE_ACTION_SCHEMA_VERSIONS.includes(schemaVersion)) {
    return normalizeCorporateActionCanonicalValue(schemaVersion, value);
  }
  switch (schemaVersion) {
    case CANONICAL_DAILY_BARS_SCHEMA_VERSION:
      return normalizeCanonicalDailyBarsV1(value);
    case DATASET_SNAPSHOT_CORE_SCHEMA_VERSION:
      return normalizeDatasetSnapshotCoreV1(value);
    case DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION:
      return normalizeDatasetSnapshotRecordV1(value);
    case TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION:
      return normalizeTransformImplementationManifestV1(value);
    case TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION:
      return normalizeTransformImplementationManifestV2(value);
    case LEGACY_DATASET_MANIFEST_SCHEMA_VERSION:
      return normalizeLegacyDatasetManifestV1(value);
    case SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION:
      return normalizeSnapshotDatasetManifestV1(value);
    case DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION:
      return normalizeDatasetMaterializationVerificationV1(value);
    case TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION:
      return normalizeTransformPipelineProfileV1(value);
    case DATASET_QUALITY_POLICY_SCHEMA_VERSION:
      return normalizeDatasetQualityPolicyV1(value);
    case DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION:
      return normalizeDatasetQualityAssessmentCoreV1(value);
    case DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION:
      return normalizeDatasetQualityAssessmentRecordV1(value);
    case INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION:
      return normalizeInstrumentIdentityAuthorityPolicyV1(value);
    case INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION:
      return normalizeInstrumentIdentityCoreV1(value);
    case INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION:
      return normalizeInstrumentIdentityRecordV1(value);
    case INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION:
      return normalizeInstrumentDescriptorCoreV1(value);
    case SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION:
      return normalizeSymbolNamespacePolicyV1(value);
    case INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION:
      return normalizeInstrumentAliasBindingCoreV1(value);
    case PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION:
      return normalizeProviderInstrumentBindingCoreV1(value);
    case INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION:
      return normalizeInstrumentAliasRevocationCoreV1(value);
    case PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION:
      return normalizeProviderInstrumentRevocationCoreV1(value);
    case INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION:
      return normalizeInstrumentIdentityManifestV1(value);
    case INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION:
      return normalizeInstrumentIdentityRegistryManifestV1(value);
    case DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION:
      return normalizeDatasetSnapshotInstrumentBindingV1(value);
    case MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION:
      return normalizeMarketCalendarAuthorityPolicyV1(value);
    case MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION:
      return normalizeMarketSessionCalendarCoreV1(value);
    case MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION:
      return normalizeMarketCalendarRegistryManifestV1(value);
    case MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION:
      return normalizeMarketDataIngestionPolicyV1(value);
    case MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION:
      return normalizeMarketDataIngestionLineageCoreV1(value);
    case MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION:
      return normalizeMarketDataIngestionRegistryAuthorityPolicyV1(value);
    case MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION:
      return normalizeMarketDataSourceArtifactCoreV1(value);
    case MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION:
      return normalizeMarketDataSourceAttestationCoreV1(value);
    case MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION:
      return normalizeMarketDataAcquisitionRecordCoreV1(value);
    case MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION:
      return normalizeMarketDataParseResultCoreV1(value);
    case MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION:
      return normalizeMarketDataSourceTemporalEvidenceCoreV1(value);
    case MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION:
      return normalizeMarketDataBarIdentityCoreV1(value);
    case MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION:
      // Preserve the L3-I1 negative dispatch probe: a schema name supplied
      // with no self-bound schemaVersion is still an unknown canonical value,
      // while every properly bound L3-I2 candidate dispatches below.
      if (!value || typeof value !== 'object'
          || value.schemaVersion !== MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataNormalizedCandidateV1(value);
    case MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION:
      return normalizeMarketDataCandidateSetCoreV1(value);
    case MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION:
      return normalizeMarketDataValidationReportV1(value);
    case MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION:
      return normalizeMarketDataBarObservationCoreV1(value);
    case MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION:
      return normalizeMarketDataBarCorrectionCoreV1(value);
    case MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION:
      return normalizeMarketDataAcceptedCandidatePublicationManifestV1(value);
    case NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION:
      return normalizeNormalizedMarketDataDeltaChunkV1(value);
    case NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION:
      return normalizeNormalizedMarketDataDeltaAssemblyManifestV1(value);
    case MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION:
      // Preserve the L3-I2 negative dispatch probe for unbound values while
      // accepting properly bound L3-I3 ingestion manifests.
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataIngestionManifestV1(value);
    case MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataIngestionRegistryManifestV1(value);
    case MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataResolvedSeriesManifestV1(value);
    case MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataSnapshotSourceBundleV1(value);
    case MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataSnapshotMaterializationPolicyV1(value);
    case MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataSnapshotMaterializationReportV1(value);
    case MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataDatasetSnapshotBindingV1(value);
    case MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1(value);
    case MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION:
      if (!value || typeof value !== 'object'
          || /** @type {any} */ (value).schemaVersion !== MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION) {
        throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown or unbound canonical schema: ${String(schemaVersion)}`);
      }
      return normalizeMarketDataDatasetSnapshotBindingRegistryManifestV1(value);
    case MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION:
      return normalizeMarketTechnicalFeatureSourceBundleV1(value);
    case MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION:
      return normalizeMarketTechnicalFeatureComputationPolicyV1(value);
    case MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION:
      return normalizeMarketTechnicalFeatureComputationReportV1(value);
    case MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION:
      // Normalized-namespace content schema (like CanonicalDailyBars/1): not
      // counted in SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.
      return normalizeMarketDataEodOhlcvCanonicalRowsV1(value);
    case MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION:
      // Normalized-namespace content; intentionally excluded from the
      // snapshots schema count, exactly like L3-I5 canonical OHLCV rows.
      return normalizeMarketTechnicalFeatureRowsV1(value);
    case MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION:
      return normalizeMarketVolumeStructureFeatureSourceBundleV1(value);
    case MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION:
      return normalizeMarketVolumeStructureFeatureComputationPolicyV1(value);
    case MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION:
      return normalizeMarketVolumeStructureFeatureComputationReportV1(value);
    case MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION:
      // Normalized-namespace content; intentionally excluded from the
      // snapshots schema count, exactly like the L4A-A feature rows.
      return normalizeMarketVolumeStructureFeatureRowsV1(value);
    case MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION:
      return normalizeMarketSeasonalityFeatureSourceBundleV1(value);
    case MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION:
      return normalizeMarketSeasonalityFeatureComputationPolicyV1(value);
    case MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION:
      return normalizeMarketSeasonalityFeatureComputationReportV1(value);
    case MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION:
      // L4A-C1 normalized content. Report verification authority belongs to L4A-C2.
      return normalizeMarketSeasonalityFeatureRowsV1(value);
    case MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION:
      return normalizeMarketFeaturePublicationAuthorityPolicyV1(value);
    case MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION:
      return normalizeMarketFeaturePublicationManifestV1(value);
    case MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION:
      return normalizeMarketFeaturePublicationRegistryManifestV1(value);
    case MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION:
      return normalizeMacroSeriesIdentityCoreV1(value);
    case MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION:
      return normalizeMacroSeriesRegistryManifestV1(value);
    case MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION:
      return normalizeMacroObservationIdentityCoreV1(value);
    case MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION:
      return normalizeMacroVintageIdentityCoreV1(value);
    case MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION:
      return normalizeMacroObservationVintageCoreV1(value);
    case MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION:
      return normalizeMacroVintageSetManifestV1(value);
    case MACRO_INGESTION_POLICY_SCHEMA_VERSION:
      return normalizeMacroIngestionPolicyV1(value);
    case MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION:
      return normalizeMacroDatasetSnapshotManifestV1(value);
    case MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION:
      return normalizeMacroAsOfResolutionPolicyV1(value);
    case MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION:
      return normalizeMacroReleaseCalendarRegistryManifestV1(value);
    case MACRO_DATASET_BINDING_SCHEMA_VERSION:
      return normalizeMacroDatasetBindingV1(value);
    case MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION:
      return normalizeMacroMaterializationReportV1(value);
    case MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION:
      return normalizeMarketMacroFeatureSourceBundleV1(value);
    case MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION:
      return normalizeMarketMacroFeatureComputationPolicyV1(value);
    case MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION:
      return normalizeMacroStateBySessionRowsV1(value);
    case MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION:
      return normalizeMarketMacroFeatureComputationReportV1(value);
    default:
      throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown canonical schema: ${String(schemaVersion)}`);
  }
}
