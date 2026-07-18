/**
 * Dataset quality contracts:
 * - DatasetQualityPolicyV1: versioned declaration of which checks run and
 *   with which diagnostic thresholds (an initial policy, not scientific truth);
 * - DatasetQualityAssessmentCore/1: deterministic facts of one evaluation
 *   (no wall clock, no hostname, no local path, no human note);
 * - DatasetQualityAssessmentRecord/1: one timestamped execution of a core.
 *
 * Statuses PASS/WARN/FAIL are technical outcomes of the executed checks.
 * No contract here decides scientific admissibility (no admissibleFor, no
 * productionReady, no score out of 100).
 */

import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import { isStrictUtcIsoInstant } from './dailyBarV1.mjs';
import {
  checkFieldSet,
  checkNonEmptyString,
  checkNullableObjectId,
  checkObjectId,
  isPlainObject,
  jsonPayloadProblems,
  normalizeJsonPayload,
  sortedUniqueStrings,
  throwForProblems,
} from './contractPrimitivesV1.mjs';

export const DATASET_QUALITY_POLICY_SCHEMA_VERSION = 'DatasetQualityPolicyV1';
export const DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION = 'DatasetQualityAssessmentCore/1';
export const DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION = 'DatasetQualityAssessmentRecord/1';

/** L2A observes only the stored series; it never invents an official market calendar. */
export const QUALITY_ASSESSMENT_BASIS_OBSERVED = 'OBSERVED_SERIES_ONLY';

export const QUALITY_CHECK_STATUSES = Object.freeze(['FAIL', 'PASS', 'WARN']);
export const EXECUTION_IDENTITY_ENVIRONMENTS = Object.freeze(['CI', 'LOCAL_MANUAL', 'LOCAL_TEST']);

export const DATASET_QUALITY_CHECK_CODES = Object.freeze([
  'BARS_CHRONOLOGICAL',
  'DUPLICATE_SESSION_DATES',
  'LARGE_OBSERVED_MOVES',
  'NORMALIZED_OBJECT_VALID',
  'NULL_FIELD_COUNTS',
  'OBSERVED_COVERAGE',
  'PRICE_BASIS_DECLARED',
  'QUALITY_FLAG_COUNTS',
  'SNAPSHOT_REFERENCES_VALID',
  'SOURCE_OBJECT_VALID',
  'SOURCE_TO_NORMALIZED_COHERENCE',
  'TRANSFORM_PIPELINE_COVERAGE',
]);

const POLICY_FIELDS = Object.freeze(['schemaVersion', 'policyVersion', 'assessmentBasis', 'checkCodes', 'thresholds']);
const THRESHOLD_FIELDS = Object.freeze(['largeObservedMoveWarningPct', 'maxReportedLargeMoveDates']);
const CORE_FIELDS = Object.freeze([
  'schemaVersion', 'snapshotCoreId', 'qualityPolicyVersion', 'qualityPolicyHash',
  'assessmentBasis', 'materializationVerificationId', 'checks', 'summary',
]);
const CHECK_FIELDS = Object.freeze(['code', 'status', 'metrics', 'reasons']);
const SUMMARY_FIELDS = Object.freeze(['status', 'passCount', 'warnCount', 'failCount', 'checkCount']);
const RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'qualityAssessmentCoreId', 'assessedAt', 'assessmentToolVersion',
  'nodeVersion', 'executionIdentity',
]);
const EXECUTION_IDENTITY_FIELDS = Object.freeze(['runnerId', 'runId', 'environment']);

export class QualityAssessmentError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'QualityAssessmentError';
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} value @returns {string[]} */
export function datasetQualityPolicyProblems(value) {
  if (!isPlainObject(value)) return ['policy must be a plain object'];
  const policy = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(policy, POLICY_FIELDS, problems);
  if (policy.schemaVersion !== DATASET_QUALITY_POLICY_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${DATASET_QUALITY_POLICY_SCHEMA_VERSION}`);
  }
  checkNonEmptyString(policy.policyVersion, 'policyVersion', problems);
  if (policy.assessmentBasis !== QUALITY_ASSESSMENT_BASIS_OBSERVED) {
    problems.push(`assessmentBasis must be ${QUALITY_ASSESSMENT_BASIS_OBSERVED}`);
  }
  if (!Array.isArray(policy.checkCodes) || policy.checkCodes.length === 0) {
    problems.push('checkCodes must be a non-empty array');
  } else {
    for (const code of policy.checkCodes) {
      if (!DATASET_QUALITY_CHECK_CODES.includes(/** @type {any} */ (code))) {
        problems.push(`unknown check code: ${String(code)}`);
      }
    }
    if (new Set(policy.checkCodes).size !== policy.checkCodes.length) problems.push('checkCodes must be unique');
  }
  if (!isPlainObject(policy.thresholds)) {
    problems.push('thresholds must be a plain object');
    return problems;
  }
  const thresholds = /** @type {Record<string, unknown>} */ (policy.thresholds);
  for (const field of THRESHOLD_FIELDS) {
    if (!Object.hasOwn(thresholds, field)) problems.push(`thresholds.${field} is required`);
  }
  for (const field of Object.keys(thresholds)) {
    if (!THRESHOLD_FIELDS.includes(field)) problems.push(`unknown field: thresholds.${field}`);
  }
  const movePct = thresholds.largeObservedMoveWarningPct;
  if (typeof movePct !== 'number' || !Number.isFinite(movePct) || movePct <= 0) {
    problems.push('thresholds.largeObservedMoveWarningPct must be a finite number > 0');
  }
  const maxDates = thresholds.maxReportedLargeMoveDates;
  if (!Number.isSafeInteger(maxDates) || /** @type {number} */ (maxDates) < 0) {
    problems.push('thresholds.maxReportedLargeMoveDates must be an integer >= 0');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeDatasetQualityPolicyV1(value) {
  const problems = datasetQualityPolicyProblems(value);
  throwForProblems(problems, (all) => new QualityAssessmentError('QUALITY_POLICY_INVALID', all.join('; '), { problems: all }));
  const policy = /** @type {any} */ (value);
  return {
    schemaVersion: DATASET_QUALITY_POLICY_SCHEMA_VERSION,
    policyVersion: policy.policyVersion,
    assessmentBasis: QUALITY_ASSESSMENT_BASIS_OBSERVED,
    checkCodes: sortedUniqueStrings(policy.checkCodes),
    thresholds: {
      largeObservedMoveWarningPct: policy.thresholds.largeObservedMoveWarningPct,
      maxReportedLargeMoveDates: policy.thresholds.maxReportedLargeMoveDates,
    },
  };
}

/** @param {unknown} value */
export function datasetQualityPolicyHash(value) {
  const normalized = normalizeDatasetQualityPolicyV1(value);
  return canonicalHash(DATASET_QUALITY_POLICY_SCHEMA_VERSION, normalized);
}

/**
 * Initial policy: every check enabled, diagnostic thresholds named as policy
 * choices (a large observed move is a diagnostic, never a confirmed split).
 */
export function defaultDatasetQualityPolicyV1() {
  return normalizeDatasetQualityPolicyV1({
    schemaVersion: DATASET_QUALITY_POLICY_SCHEMA_VERSION,
    policyVersion: 'dataset-quality-policy/1',
    assessmentBasis: QUALITY_ASSESSMENT_BASIS_OBSERVED,
    checkCodes: [...DATASET_QUALITY_CHECK_CODES],
    thresholds: {
      largeObservedMoveWarningPct: 50,
      maxReportedLargeMoveDates: 10,
    },
  });
}

/**
 * Derive the summary a set of checks must carry.
 * @param {{status: string}[]} checks
 */
export function computeQualityChecksSummary(checks) {
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  for (const check of checks) {
    if (check.status === 'PASS') passCount++;
    else if (check.status === 'WARN') warnCount++;
    else if (check.status === 'FAIL') failCount++;
  }
  const status = failCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'PASS';
  return { status, passCount, warnCount, failCount, checkCount: checks.length };
}

/** @param {unknown} value @returns {string[]} */
export function datasetQualityAssessmentCoreProblems(value) {
  if (!isPlainObject(value)) return ['quality core must be a plain object'];
  const core = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(core, CORE_FIELDS, problems);
  if (core.schemaVersion !== DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(core.snapshotCoreId, 'snapshotCoreId', problems);
  checkNonEmptyString(core.qualityPolicyVersion, 'qualityPolicyVersion', problems);
  checkObjectId(core.qualityPolicyHash, 'qualityPolicyHash', problems);
  if (core.assessmentBasis !== QUALITY_ASSESSMENT_BASIS_OBSERVED) {
    problems.push(`assessmentBasis must be ${QUALITY_ASSESSMENT_BASIS_OBSERVED}`);
  }
  checkNullableObjectId(core.materializationVerificationId, 'materializationVerificationId', problems);
  if (!Array.isArray(core.checks) || core.checks.length === 0) {
    problems.push('checks must be a non-empty array');
    return problems;
  }
  const seenCodes = new Set();
  core.checks.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`checks[${index}] must be an object`);
      return;
    }
    const check = /** @type {Record<string, unknown>} */ (entry);
    checkFieldSet(check, CHECK_FIELDS, problems);
    if (!DATASET_QUALITY_CHECK_CODES.includes(/** @type {any} */ (check.code))) {
      problems.push(`checks[${index}].code is unknown: ${String(check.code)}`);
    } else {
      if (seenCodes.has(check.code)) problems.push(`duplicate check code: ${String(check.code)}`);
      seenCodes.add(check.code);
    }
    if (!QUALITY_CHECK_STATUSES.includes(/** @type {any} */ (check.status))) {
      problems.push(`checks[${index}].status must be PASS, WARN or FAIL`);
    }
    if (!isPlainObject(check.metrics)) problems.push(`checks[${index}].metrics must be a plain object`);
    else problems.push(...jsonPayloadProblems(check.metrics, `checks[${index}].metrics`));
    if (!Array.isArray(check.reasons)) {
      problems.push(`checks[${index}].reasons must be an array`);
    } else {
      check.reasons.forEach((reason, reasonIndex) => {
        checkNonEmptyString(reason, `checks[${index}].reasons[${reasonIndex}]`, problems);
      });
    }
  });
  if (!isPlainObject(core.summary)) {
    problems.push('summary must be a plain object');
    return problems;
  }
  const summary = /** @type {Record<string, unknown>} */ (core.summary);
  for (const field of SUMMARY_FIELDS) {
    if (!Object.hasOwn(summary, field)) problems.push(`summary.${field} is required`);
  }
  for (const field of Object.keys(summary)) {
    if (!SUMMARY_FIELDS.includes(field)) problems.push(`unknown field: summary.${field}`);
  }
  const statusesValid = core.checks.every((entry) => isPlainObject(entry)
    && QUALITY_CHECK_STATUSES.includes(/** @type {any} */ (/** @type {Record<string, unknown>} */ (entry).status)));
  if (statusesValid) {
    const expected = computeQualityChecksSummary(/** @type {any} */ (core.checks));
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (summary[field] !== expectedValue) {
        problems.push(`summary mismatch: ${field} must be ${String(expectedValue)}`);
      }
    }
  }
  return problems;
}

/** @param {string[]} problems */
function coreErrorFor(problems) {
  const mismatch = problems.find((problem) => problem.startsWith('summary mismatch:'));
  if (mismatch) return new QualityAssessmentError('QUALITY_ASSESSMENT_SUMMARY_MISMATCH', mismatch, { problems });
  return new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', problems.join('; '), { problems });
}

/** @param {unknown} value */
export function normalizeDatasetQualityAssessmentCoreV1(value) {
  const problems = datasetQualityAssessmentCoreProblems(value);
  throwForProblems(problems, coreErrorFor);
  const core = /** @type {any} */ (value);
  const checks = core.checks
    .map((check) => ({
      code: check.code,
      status: check.status,
      metrics: normalizeJsonPayload(check.metrics, `checks.${check.code}.metrics`),
      reasons: sortedUniqueStrings(check.reasons),
    }))
    .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return {
    schemaVersion: DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
    snapshotCoreId: core.snapshotCoreId,
    qualityPolicyVersion: core.qualityPolicyVersion,
    qualityPolicyHash: core.qualityPolicyHash,
    assessmentBasis: QUALITY_ASSESSMENT_BASIS_OBSERVED,
    materializationVerificationId: core.materializationVerificationId,
    checks,
    summary: computeQualityChecksSummary(checks),
  };
}

/** @param {unknown} value */
export function validateDatasetQualityAssessmentCore(value) {
  const problems = datasetQualityAssessmentCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function datasetQualityAssessmentCoreId(value) {
  const normalized = normalizeDatasetQualityAssessmentCoreV1(value);
  return canonicalHash(DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION, normalized);
}

/** @param {unknown} value @returns {string[]} */
export function datasetQualityAssessmentRecordProblems(value) {
  if (!isPlainObject(value)) return ['quality record must be a plain object'];
  const record = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(record, RECORD_FIELDS, problems);
  if (record.schemaVersion !== DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION}`);
  }
  checkObjectId(record.qualityAssessmentCoreId, 'qualityAssessmentCoreId', problems);
  if (!isStrictUtcIsoInstant(record.assessedAt)) {
    problems.push('assessedAt must be a real UTC ISO instant supplied by the caller');
  }
  for (const field of ['assessmentToolVersion', 'nodeVersion']) checkNonEmptyString(record[field], field, problems);
  if (!isPlainObject(record.executionIdentity)) {
    problems.push('executionIdentity must be a plain object');
  } else {
    const identity = /** @type {Record<string, unknown>} */ (record.executionIdentity);
    checkFieldSet(identity, EXECUTION_IDENTITY_FIELDS, problems);
    checkNonEmptyString(identity.runnerId, 'executionIdentity.runnerId', problems);
    if (identity.runId !== null) checkNonEmptyString(identity.runId, 'executionIdentity.runId', problems);
    if (!EXECUTION_IDENTITY_ENVIRONMENTS.includes(/** @type {any} */ (identity.environment))) {
      problems.push('executionIdentity.environment must be LOCAL_TEST, LOCAL_MANUAL or CI');
    }
    for (const field of ['runnerId', 'runId']) {
      const text = identity[field];
      if (typeof text === 'string' && (text.includes('/') || text.includes('\\') || /^[A-Za-z]:/.test(text))) {
        problems.push(`executionIdentity.${field} must not contain a physical path`);
      }
    }
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeDatasetQualityAssessmentRecordV1(value) {
  const problems = datasetQualityAssessmentRecordProblems(value);
  throwForProblems(problems, (all) => new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', all.join('; '), { problems: all }));
  const record = /** @type {any} */ (value);
  return {
    schemaVersion: DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION,
    qualityAssessmentCoreId: record.qualityAssessmentCoreId,
    assessedAt: new Date(record.assessedAt).toISOString(),
    assessmentToolVersion: record.assessmentToolVersion,
    nodeVersion: record.nodeVersion,
    executionIdentity: {
      runnerId: record.executionIdentity.runnerId,
      runId: record.executionIdentity.runId,
      environment: record.executionIdentity.environment,
    },
  };
}

/** @param {unknown} value */
export function validateDatasetQualityAssessmentRecord(value) {
  const problems = datasetQualityAssessmentRecordProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function datasetQualityAssessmentRecordId(value) {
  const normalized = normalizeDatasetQualityAssessmentRecordV1(value);
  return canonicalHash(DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION, normalized);
}
