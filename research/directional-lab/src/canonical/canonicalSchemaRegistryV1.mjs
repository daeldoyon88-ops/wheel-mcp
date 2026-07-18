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

/**
 * Snapshot-metadata schemas the CAS `snapshots` namespace may store. The
 * legacy DatasetManifestV1 canonical copy is historical evidence only; the
 * snapshot identity remains founded on the L1 core and CAS objects.
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
]);

/** @param {string} schemaVersion @param {unknown} value */
export function normalizeCanonicalValue(schemaVersion, value) {
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
    default:
      throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown canonical schema: ${String(schemaVersion)}`);
  }
}
