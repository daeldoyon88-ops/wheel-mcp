import { ADJUSTMENT_TYPES, isStrictUtcIsoInstant } from './dailyBarV1.mjs';
import { CanonicalizationError, assertValidUnicode } from '../canonical/canonicalJsonV1.mjs';

export const DATASET_SNAPSHOT_CORE_SCHEMA_VERSION = 'DatasetSnapshotCore/1';
export const DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION = 'DatasetSnapshotRecord/1';

export const SHA256_OBJECT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

const CORE_FIELDS = Object.freeze([
  'schemaVersion', 'sourceObjectId', 'normalizedObjectId', 'canonicalSymbol', 'providerId',
  'providerSymbol', 'sourceFormat', 'adapterVersion', 'adapterOptions', 'normalizerVersion',
  'normalizationOptions', 'canonicalSerializationVersion', 'priceBasis',
  'corporateActionPolicyHash', 'calendarId', 'calendarVersion', 'transformImplementationHash',
]);
const RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'snapshotCoreId', 'sourceAcquiredAt', 'ingestedIntoLabAt',
  'acquisitionMethod', 'acquisitionToolVersion', 'acquisitionRequestIdentity',
  'acquisitionEvidenceIds',
]);

export class DatasetSnapshotError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'DatasetSnapshotError';
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
function checkNonEmptyString(value, label, problems) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    problems.push(`${label} must be a non-empty trimmed string`);
    return;
  }
  try { assertValidUnicode(value); } catch { problems.push(`${label} contains invalid Unicode`); }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
function checkObjectId(value, label, problems) {
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) {
    problems.push(`${label} must use sha256:<64 lowercase hex>`);
  }
}

/** @param {Record<string, unknown>} value @param {readonly string[]} fields @param {string[]} problems */
function checkFieldSet(value, fields, problems) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) problems.push(`${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) problems.push(`unknown field: ${field}`);
  }
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Schema-owned normalization for extensible JSON option/request objects.
 * Array order is semantic and is preserved; object keys are data-map keys and
 * will be sorted later by CanonicalJSON/1.
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown}
 */
function normalizeJsonDomainValue(value, label) {
  if (value === undefined) throw new CanonicalizationError('CANONICAL_UNDEFINED', `${label} contains undefined`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalizationError('CANONICAL_NON_FINITE_NUMBER', `${label} contains a non-finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError('CANONICAL_UNSAFE_INTEGER', `${label} contains an unsafe integer`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJsonDomainValue(item, `${label}[${index}]`));
  if (!isPlainObject(value)) throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', `${label} must contain only JSON values`);
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of Object.keys(value)) {
    assertValidUnicode(key);
    result[key] = normalizeJsonDomainValue(/** @type {Record<string, unknown>} */ (value)[key], `${label}.${key}`);
  }
  return result;
}

/** @param {unknown} value @returns {string[]} */
export function datasetSnapshotCoreProblems(value) {
  if (!isPlainObject(value)) return ['core must be a plain object'];
  const core = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(core, CORE_FIELDS, problems);
  if (core.schemaVersion !== DATASET_SNAPSHOT_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${DATASET_SNAPSHOT_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(core.sourceObjectId, 'sourceObjectId', problems);
  checkObjectId(core.normalizedObjectId, 'normalizedObjectId', problems);
  checkObjectId(core.corporateActionPolicyHash, 'corporateActionPolicyHash', problems);
  checkObjectId(core.transformImplementationHash, 'transformImplementationHash', problems);
  for (const field of [
    'canonicalSymbol', 'providerId', 'providerSymbol', 'sourceFormat', 'adapterVersion',
    'normalizerVersion', 'canonicalSerializationVersion', 'calendarId', 'calendarVersion',
  ]) checkNonEmptyString(core[field], field, problems);
  if (core.canonicalSerializationVersion !== 'CanonicalJSON/1') {
    problems.push('canonicalSerializationVersion must be CanonicalJSON/1');
  }
  if (!ADJUSTMENT_TYPES.includes(/** @type {any} */ (core.priceBasis))) problems.push('priceBasis is invalid');
  if (!isPlainObject(core.adapterOptions)) problems.push('adapterOptions must be a plain object');
  if (!isPlainObject(core.normalizationOptions)) problems.push('normalizationOptions must be a plain object');
  return problems;
}

/** @param {unknown} value @returns {string[]} */
export function datasetSnapshotRecordProblems(value) {
  if (!isPlainObject(value)) return ['record must be a plain object'];
  const record = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(record, RECORD_FIELDS, problems);
  if (record.schemaVersion !== DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION}`);
  }
  checkObjectId(record.snapshotCoreId, 'snapshotCoreId', problems);
  if (record.sourceAcquiredAt !== null && !isStrictUtcIsoInstant(record.sourceAcquiredAt)) {
    problems.push('sourceAcquiredAt must be null or a real UTC ISO instant');
  }
  if (!isStrictUtcIsoInstant(record.ingestedIntoLabAt)) problems.push('ingestedIntoLabAt must be a real UTC ISO instant');
  for (const field of ['acquisitionMethod', 'acquisitionToolVersion']) checkNonEmptyString(record[field], field, problems);
  if (!isPlainObject(record.acquisitionRequestIdentity)) problems.push('acquisitionRequestIdentity must be a plain object');
  if (!Array.isArray(record.acquisitionEvidenceIds)) {
    problems.push('acquisitionEvidenceIds must be an array');
  } else {
    record.acquisitionEvidenceIds.forEach((id, index) => checkObjectId(id, `acquisitionEvidenceIds[${index}]`, problems));
  }
  return problems;
}

/** @param {unknown} value */
export function validateDatasetSnapshotCore(value) {
  const problems = datasetSnapshotCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function validateDatasetSnapshotRecord(value) {
  const problems = datasetSnapshotRecordProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function normalizeDatasetSnapshotCoreV1(value) {
  const problems = datasetSnapshotCoreProblems(value);
  if (problems.some((problem) => problem.startsWith('unknown field:'))) {
    throw new CanonicalizationError('CANONICAL_UNKNOWN_FIELD', problems.find((problem) => problem.startsWith('unknown field:')));
  }
  if (problems.length > 0) throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', problems.join('; '), { problems });
  const core = /** @type {Record<string, unknown>} */ (value);
  return {
    schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    sourceObjectId: core.sourceObjectId,
    normalizedObjectId: core.normalizedObjectId,
    canonicalSymbol: core.canonicalSymbol,
    providerId: core.providerId,
    providerSymbol: core.providerSymbol,
    sourceFormat: core.sourceFormat,
    adapterVersion: core.adapterVersion,
    adapterOptions: normalizeJsonDomainValue(core.adapterOptions, 'adapterOptions'),
    normalizerVersion: core.normalizerVersion,
    normalizationOptions: normalizeJsonDomainValue(core.normalizationOptions, 'normalizationOptions'),
    canonicalSerializationVersion: core.canonicalSerializationVersion,
    priceBasis: core.priceBasis,
    corporateActionPolicyHash: core.corporateActionPolicyHash,
    calendarId: core.calendarId,
    calendarVersion: core.calendarVersion,
    transformImplementationHash: core.transformImplementationHash,
  };
}

/** @param {unknown} value */
export function normalizeDatasetSnapshotRecordV1(value) {
  const problems = datasetSnapshotRecordProblems(value);
  if (problems.some((problem) => problem.startsWith('unknown field:'))) {
    throw new CanonicalizationError('CANONICAL_UNKNOWN_FIELD', problems.find((problem) => problem.startsWith('unknown field:')));
  }
  if (problems.length > 0) throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', problems.join('; '), { problems });
  const record = /** @type {Record<string, unknown>} */ (value);
  const sourceAcquiredAt = record.sourceAcquiredAt === null ? null : new Date(/** @type {string} */ (record.sourceAcquiredAt)).toISOString();
  const ingestedIntoLabAt = new Date(/** @type {string} */ (record.ingestedIntoLabAt)).toISOString();
  const acquisitionEvidenceIds = [...new Set(/** @type {string[]} */ (record.acquisitionEvidenceIds))].sort();
  return {
    schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
    snapshotCoreId: record.snapshotCoreId,
    sourceAcquiredAt,
    ingestedIntoLabAt,
    acquisitionMethod: record.acquisitionMethod,
    acquisitionToolVersion: record.acquisitionToolVersion,
    acquisitionRequestIdentity: normalizeJsonDomainValue(record.acquisitionRequestIdentity, 'acquisitionRequestIdentity'),
    acquisitionEvidenceIds,
  };
}
