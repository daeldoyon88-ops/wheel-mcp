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
    default:
      throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown canonical schema: ${String(schemaVersion)}`);
  }
}
