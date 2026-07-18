/**
 * SnapshotDatasetManifestV1 — Phase 2 envelope around one immutable dataset
 * snapshot. It references the L1 snapshot core/record, an optional canonical
 * copy of the historical DatasetManifestV1 (kept as evidence, never as the
 * source of snapshot identity), plus sorted sets of materialization
 * verifications and quality assessment records. Adding an assessment creates
 * a NEW manifest object; previous manifests stay immutable in the CAS.
 *
 * The legacy DatasetManifestV1 contract itself is NOT modified here: its
 * canonical form below reuses the untouched Phase 1 validator. Legacy
 * `sourcePath` values may be local machine paths; they are preserved as
 * historical evidence and never feed snapshotCoreId, sourceObjectId or
 * normalizedObjectId.
 */

import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import { DATASET_MANIFEST_SCHEMA_VERSION, datasetManifestProblems } from './datasetManifestV1.mjs';
import {
  checkFieldSet,
  checkNonEmptyString,
  checkNullableObjectId,
  checkObjectId,
  checkObjectIdArray,
  isPlainObject,
  jsonPayloadProblems,
  normalizeJsonPayload,
  sortedUniqueStrings,
  throwForProblems,
} from './contractPrimitivesV1.mjs';

export const SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION = 'SnapshotDatasetManifestV1';
export const LEGACY_DATASET_MANIFEST_SCHEMA_VERSION = DATASET_MANIFEST_SCHEMA_VERSION;

const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion', 'snapshotCoreId', 'snapshotRecordId', 'legacyManifestObjectId',
  'materializationVerificationIds', 'qualityAssessmentRecordIds', 'createdByVersion',
]);

/** Exact Phase 1 field set (see the untouched datasetManifestV1.mjs typedef). */
export const LEGACY_DATASET_MANIFEST_FIELDS = Object.freeze([
  'schemaVersion', 'symbol', 'sourcePath', 'sourceGitStatus', 'sourceFormat', 'contentHash',
  'firstDate', 'lastDate', 'barCount', 'coverageVersion',
  'rawOhlcValidBars', 'rawOhlcCoveragePct', 'rawOhlcAvailable', 'rawOhlcComplete',
  'adjustedOhlcValidBars', 'adjustedOhlcCoveragePct', 'adjustedOhlcAvailable', 'adjustedOhlcComplete',
  'volumeValidBars', 'volumeCoveragePct', 'volumeAvailable', 'volumeComplete',
  'adjustedCloseAvailable', 'nativeAdjustmentType', 'splitsDocumented',
  'qualityFlags', 'warnings', 'gapStats', 'lineage',
]);

export class SnapshotDatasetManifestError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'SnapshotDatasetManifestError';
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} value @returns {string[]} */
export function snapshotDatasetManifestProblems(value) {
  if (!isPlainObject(value)) return ['manifest must be a plain object'];
  const manifest = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(manifest, MANIFEST_FIELDS, problems);
  if (manifest.schemaVersion !== SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION}`);
  }
  checkObjectId(manifest.snapshotCoreId, 'snapshotCoreId', problems);
  checkObjectId(manifest.snapshotRecordId, 'snapshotRecordId', problems);
  checkNullableObjectId(manifest.legacyManifestObjectId, 'legacyManifestObjectId', problems);
  checkObjectIdArray(manifest.materializationVerificationIds, 'materializationVerificationIds', problems);
  checkObjectIdArray(manifest.qualityAssessmentRecordIds, 'qualityAssessmentRecordIds', problems);
  checkNonEmptyString(manifest.createdByVersion, 'createdByVersion', problems);
  return problems;
}

/** @param {unknown} value */
export function normalizeSnapshotDatasetManifestV1(value) {
  const problems = snapshotDatasetManifestProblems(value);
  throwForProblems(problems, (all) => new SnapshotDatasetManifestError(
    'SNAPSHOT_DATASET_MANIFEST_INVALID', all.join('; '), { problems: all },
  ));
  const manifest = /** @type {any} */ (value);
  return {
    schemaVersion: SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
    snapshotCoreId: manifest.snapshotCoreId,
    snapshotRecordId: manifest.snapshotRecordId,
    legacyManifestObjectId: manifest.legacyManifestObjectId,
    materializationVerificationIds: sortedUniqueStrings(manifest.materializationVerificationIds),
    qualityAssessmentRecordIds: sortedUniqueStrings(manifest.qualityAssessmentRecordIds),
    createdByVersion: manifest.createdByVersion,
  };
}

/** @param {unknown} value */
export function validateSnapshotDatasetManifest(value) {
  const problems = snapshotDatasetManifestProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function snapshotDatasetManifestId(value) {
  const normalized = normalizeSnapshotDatasetManifestV1(value);
  return canonicalHash(SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION, normalized);
}

/**
 * Canonical form of an already-valid Phase 1 DatasetManifestV1. Reuses the
 * untouched Phase 1 validator, refuses unknown fields, preserves every V1
 * field (including sourcePath and list order) and invents nothing.
 * @param {unknown} value
 */
export function normalizeLegacyDatasetManifestV1(value) {
  if (!isPlainObject(value)) {
    throw new SnapshotDatasetManifestError('LEGACY_MANIFEST_INVALID', 'legacy manifest must be a plain object');
  }
  const manifest = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(manifest, LEGACY_DATASET_MANIFEST_FIELDS, problems);
  problems.push(...datasetManifestProblems(value));
  for (const field of LEGACY_DATASET_MANIFEST_FIELDS) {
    if (Object.hasOwn(manifest, field)) problems.push(...jsonPayloadProblems(manifest[field], `legacy.${field}`));
  }
  throwForProblems(problems, (all) => new SnapshotDatasetManifestError(
    'LEGACY_MANIFEST_INVALID', all.join('; '), { problems: all },
  ));
  /** @type {Record<string, unknown>} */
  const normalized = {};
  for (const field of LEGACY_DATASET_MANIFEST_FIELDS) {
    normalized[field] = normalizeJsonPayload(manifest[field], `legacy.${field}`);
  }
  return normalized;
}

/** @param {unknown} value */
export function legacyDatasetManifestObjectId(value) {
  const normalized = normalizeLegacyDatasetManifestV1(value);
  return canonicalHash(LEGACY_DATASET_MANIFEST_SCHEMA_VERSION, normalized);
}
