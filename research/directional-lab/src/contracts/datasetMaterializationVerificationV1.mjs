/**
 * DatasetMaterializationVerification/1 — deterministic fact stating whether
 * the stored source bytes, replayed through a declared pipeline with the
 * snapshot core's own options, reproduce the snapshot's normalizedObjectId.
 * A source→normalized incoherence is always FAIL, never WARN, and the
 * verification never repairs any stored object.
 */

import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import {
  checkFieldSet,
  checkNonEmptyString,
  checkNullableObjectId,
  checkObjectId,
  isPlainObject,
  sortedUniqueStrings,
  throwForProblems,
} from './contractPrimitivesV1.mjs';

export const DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION = 'DatasetMaterializationVerification/1';

export const MATERIALIZATION_VERIFICATION_STATUSES = Object.freeze(['FAIL', 'PASS']);

export const MATERIALIZATION_VERIFICATION_REASONS = Object.freeze([
  'ADAPTER_FAILED',
  'MATERIALIZATION_MATCH',
  'NORMALIZED_OBJECT_MISMATCH',
  'NORMALIZER_FAILED',
  'PIPELINE_PROFILE_UNKNOWN',
  'SNAPSHOT_CORE_MISMATCH',
  'SOURCE_OBJECT_HASH_MISMATCH',
  'SOURCE_OBJECT_MISSING',
  'TRANSFORM_MANIFEST_MISSING_ROLE',
  'TRANSFORM_MANIFEST_MODULE_HASH_MISMATCH',
  'TRANSFORM_MANIFEST_MODULE_MISSING',
]);

const FIELDS = Object.freeze([
  'schemaVersion', 'snapshotCoreId', 'pipelineProfileId', 'pipelineProfileHash',
  'transformImplementationHash', 'sourceObjectId', 'expectedNormalizedObjectId',
  'recomputedNormalizedObjectId', 'status', 'reasons',
]);

export class MaterializationVerificationError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'MaterializationVerificationError';
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} value @returns {string[]} */
export function datasetMaterializationVerificationProblems(value) {
  if (!isPlainObject(value)) return ['verification must be a plain object'];
  const verification = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(verification, FIELDS, problems);
  if (verification.schemaVersion !== DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION}`);
  }
  checkObjectId(verification.snapshotCoreId, 'snapshotCoreId', problems);
  checkNonEmptyString(verification.pipelineProfileId, 'pipelineProfileId', problems);
  checkObjectId(verification.pipelineProfileHash, 'pipelineProfileHash', problems);
  checkObjectId(verification.transformImplementationHash, 'transformImplementationHash', problems);
  checkObjectId(verification.sourceObjectId, 'sourceObjectId', problems);
  checkObjectId(verification.expectedNormalizedObjectId, 'expectedNormalizedObjectId', problems);
  checkNullableObjectId(verification.recomputedNormalizedObjectId, 'recomputedNormalizedObjectId', problems);
  if (!MATERIALIZATION_VERIFICATION_STATUSES.includes(/** @type {any} */ (verification.status))) {
    problems.push('status must be PASS or FAIL');
  }
  if (!Array.isArray(verification.reasons) || verification.reasons.length === 0) {
    problems.push('reasons must be a non-empty array');
    return problems;
  }
  for (const reason of verification.reasons) {
    if (!MATERIALIZATION_VERIFICATION_REASONS.includes(/** @type {any} */ (reason))) {
      problems.push(`unknown reason: ${String(reason)}`);
    }
  }
  const reasons = sortedUniqueStrings(/** @type {string[]} */ (verification.reasons));
  if (verification.status === 'PASS') {
    if (reasons.length !== 1 || reasons[0] !== 'MATERIALIZATION_MATCH') {
      problems.push('a PASS verification must carry exactly MATERIALIZATION_MATCH');
    }
    if (verification.recomputedNormalizedObjectId !== verification.expectedNormalizedObjectId) {
      problems.push('a PASS verification requires recomputedNormalizedObjectId === expectedNormalizedObjectId');
    }
  }
  if (verification.status === 'FAIL' && reasons.includes('MATERIALIZATION_MATCH')) {
    problems.push('a FAIL verification cannot carry MATERIALIZATION_MATCH');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeDatasetMaterializationVerificationV1(value) {
  const problems = datasetMaterializationVerificationProblems(value);
  throwForProblems(problems, (all) => new MaterializationVerificationError(
    'MATERIALIZATION_VERIFICATION_INVALID', all.join('; '), { problems: all },
  ));
  const verification = /** @type {any} */ (value);
  return {
    schemaVersion: DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION,
    snapshotCoreId: verification.snapshotCoreId,
    pipelineProfileId: verification.pipelineProfileId,
    pipelineProfileHash: verification.pipelineProfileHash,
    transformImplementationHash: verification.transformImplementationHash,
    sourceObjectId: verification.sourceObjectId,
    expectedNormalizedObjectId: verification.expectedNormalizedObjectId,
    recomputedNormalizedObjectId: verification.recomputedNormalizedObjectId,
    status: verification.status,
    reasons: sortedUniqueStrings(verification.reasons),
  };
}

/** @param {unknown} value */
export function validateDatasetMaterializationVerification(value) {
  const problems = datasetMaterializationVerificationProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function datasetMaterializationVerificationId(value) {
  const normalized = normalizeDatasetMaterializationVerificationV1(value);
  return canonicalHash(DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION, normalized);
}
