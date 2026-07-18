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
    default:
      throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `unknown canonical schema: ${String(schemaVersion)}`);
  }
}
