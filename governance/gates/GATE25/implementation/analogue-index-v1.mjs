/**
 * GATE25 analogue index: D4 GATE25_ANALOGUE_INDEX_V1.
 *
 * Append-only, keyed by analogueIdentityId. An identical replay is idempotent; a
 * divergent record under an existing key is refused, so a later vintage or
 * restatement can never rewrite a persisted analogue record.
 *
 * Query results are ranked by finalDistance ASC, sessionDate ASC, then
 * analogueIdentityId in code-unit order, and paged at 100 after ranking. Storage
 * is ordered by analogueIdentityId in code-unit order. Persisted bytes are exactly
 * the CanonicalJSON/1 serialization; there is no locale collation, no filesystem
 * order and no directory wildcard anywhere in this module.
 *
 * OFF_SCAN product: the live Wheel scan never rebuilds it.
 */

import { canonicalize, sha256Bytes } from '../../../tools/canonical-json.mjs';
import {
  assertClosedKeys,
  failClosed,
  identityMemberValue,
  isExactGovernedString,
  verifyAnalogueIdentity,
} from './analogue-identity-v1.mjs';
import { CORE_V1_DIMENSIONS_V1, INPUT_PROOF_KEYS_V1 } from './analogue-eligibility-v1.mjs';
import { DISTANCE_FEATURE_IDS_V1 } from './analogue-distance-v1.mjs';

export const ANALOGUE_INDEX_SCHEMA_V1 = 'GATE25_ANALOGUE_INDEX_V1';
export const ANALOGUE_INDEX_PRODUCT_PATH_V1 = 'data/jarvise/historical-analogue/GATE25/V1/ANALOGUE_INDEX.json';
export const ANALOGUE_INDEX_PRODUCT_CLASS_V1 = 'OFF_SCAN';
export const INDEX_PAGE_SIZE_V1 = 100;
export const ANALOGUE_INDEX_FIELDS_V1 = Object.freeze(['schema', 'datasetId', 'selectionPolicyVersionId', 'pageSize', 'recordCount', 'records']);
export const ANALOGUE_INDEX_RECORD_FIELDS_V1 = Object.freeze([
  'analogueIdentityId', 'orderedMembers', 'p3hKeyId', 'coreV1RegimeFactors', 'distanceFeatures', 'inputProofs',
]);
const DISTANCE_FEATURE_RECORD_FIELDS = Object.freeze(['featureId', 'featureRecordId', 'status', 'code', 'rawValue']);

export const QUERY_RESULT_ORDERING_V1 = Object.freeze([
  Object.freeze({ ordinal: 1, key: 'finalDistance', direction: 'ASC' }),
  Object.freeze({ ordinal: 2, key: 'sessionDate', direction: 'ASC' }),
  Object.freeze({ ordinal: 3, key: 'analogueIdentityId', direction: 'ASC', comparison: 'LEXICOGRAPHIC' }),
]);

/** UTF-16 code-unit order; never localeCompare. */
export const compareCodeUnits = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function compareQueryResults(left, right) {
  if (left.finalDistance !== right.finalDistance) return left.finalDistance < right.finalDistance ? -1 : 1;
  const bySession = compareCodeUnits(left.sessionDate, right.sessionDate);
  if (bySession !== 0) return bySession;
  return compareCodeUnits(left.analogueIdentityId, right.analogueIdentityId);
}

/** Total order over distinct analogueIdentityIds, so ranking never depends on input order. */
export function rankQueryResults(entries) {
  if (!Array.isArray(entries)) failClosed('QUERY_RESULTS_INVALID');
  const ids = new Set();
  for (const entry of entries) {
    if (typeof entry?.finalDistance !== 'number' || !Number.isFinite(entry.finalDistance)) failClosed('QUERY_RESULT_DISTANCE_NOT_FINITE');
    if (!isExactGovernedString(entry.sessionDate) || !isExactGovernedString(entry.analogueIdentityId)) failClosed('QUERY_RESULT_KEY_INVALID');
    if (ids.has(entry.analogueIdentityId)) failClosed('QUERY_RESULT_DUPLICATE_ANALOGUE_IDENTITY', { analogueIdentityId: entry.analogueIdentityId });
    ids.add(entry.analogueIdentityId);
  }
  return Object.freeze([...entries].sort(compareQueryResults).map((entry, index) => Object.freeze({ ...entry, rank: index + 1 })));
}

/** pageSize 100 applied after ranking; pageIndex is zero-based. */
export function paginateQueryResults(rankedEntries, pageIndex) {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) failClosed('PAGE_INDEX_INVALID', { pageIndex });
  const totalCount = rankedEntries.length;
  const pageCount = Math.ceil(totalCount / INDEX_PAGE_SIZE_V1);
  if (pageIndex >= Math.max(pageCount, 1)) failClosed('PAGE_INDEX_OUT_OF_RANGE', { pageIndex, pageCount });
  const start = pageIndex * INDEX_PAGE_SIZE_V1;
  return Object.freeze({
    pageIndex,
    pageSize: INDEX_PAGE_SIZE_V1,
    pageCount,
    totalCount,
    entries: Object.freeze(rankedEntries.slice(start, start + INDEX_PAGE_SIZE_V1)),
  });
}

/* ------------------------------------------------------------------------ records */

export function buildIndexRecord({ identity, p3hKeyId, regime, features, inputProofs }) {
  return verifyIndexRecord({
    analogueIdentityId: identity.analogueIdentityId,
    orderedMembers: identity.orderedMembers.map((entry) => ({ memberId: entry.memberId, value: entry.value })),
    p3hKeyId,
    coreV1RegimeFactors: CORE_V1_DIMENSIONS_V1.map((dimensionId) => ({ dimensionId, value: regime.coreV1[dimensionId] })),
    distanceFeatures: DISTANCE_FEATURE_IDS_V1.map((featureId) => {
      const record = features.records[featureId];
      return record === null
        ? { featureId, featureRecordId: null, status: 'ABSENT', code: null, rawValue: null }
        : { featureId, featureRecordId: record.featureRecordId, status: record.status, code: record.code, rawValue: record.rawValue };
    }),
    inputProofs: inputProofs.map((proof) => ({
      inputId: proof.inputId,
      sourceArtifactId: proof.sourceArtifactId,
      sourceArtifactSha256: proof.sourceArtifactSha256,
      availableAt: proof.availableAt,
    })),
  });
}

export function verifyIndexRecord(record) {
  assertClosedKeys(record, ANALOGUE_INDEX_RECORD_FIELDS_V1, 'INDEX_RECORD_NOT_CLOSED');
  verifyAnalogueIdentity(record);
  if (!isExactGovernedString(record.p3hKeyId)) failClosed('INDEX_RECORD_P3H_KEY_INVALID');
  if (!Array.isArray(record.coreV1RegimeFactors) || record.coreV1RegimeFactors.length !== CORE_V1_DIMENSIONS_V1.length) {
    failClosed('INDEX_RECORD_CORE_V1_FACTORS_INVALID');
  }
  record.coreV1RegimeFactors.forEach((factor, index) => {
    assertClosedKeys(factor, ['dimensionId', 'value'], 'INDEX_RECORD_CORE_V1_FACTOR_NOT_CLOSED', { index });
    if (factor.dimensionId !== CORE_V1_DIMENSIONS_V1[index] || !isExactGovernedString(factor.value)) {
      failClosed('INDEX_RECORD_CORE_V1_FACTOR_INVALID', { index });
    }
  });
  if (!Array.isArray(record.distanceFeatures) || record.distanceFeatures.length !== DISTANCE_FEATURE_IDS_V1.length) {
    failClosed('INDEX_RECORD_DISTANCE_FEATURES_INVALID');
  }
  record.distanceFeatures.forEach((feature, index) => {
    assertClosedKeys(feature, DISTANCE_FEATURE_RECORD_FIELDS, 'INDEX_RECORD_DISTANCE_FEATURE_NOT_CLOSED', { index });
    if (feature.featureId !== DISTANCE_FEATURE_IDS_V1[index]) failClosed('INDEX_RECORD_DISTANCE_FEATURE_ORDER_INVALID', { index });
    if (feature.rawValue !== null && (typeof feature.rawValue !== 'number' || !Number.isFinite(feature.rawValue))) {
      failClosed('INDEX_RECORD_DISTANCE_FEATURE_VALUE_INVALID', { index });
    }
  });
  if (!Array.isArray(record.inputProofs)) failClosed('INDEX_RECORD_INPUT_PROOFS_INVALID');
  record.inputProofs.forEach((proof, index) => assertClosedKeys(proof, INPUT_PROOF_KEYS_V1, 'INDEX_RECORD_INPUT_PROOF_NOT_CLOSED', { index }));
  return deepFreeze(record);
}

export const indexRecordSessionDate = (record) => identityMemberValue(record.orderedMembers, 'SessionDate');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/* -------------------------------------------------------------------------- store */

export function createAnalogueIndex({ datasetId, selectionPolicyVersionId }) {
  if (!isExactGovernedString(datasetId) || !isExactGovernedString(selectionPolicyVersionId)) failClosed('ANALOGUE_INDEX_BINDING_INVALID');
  return Object.freeze({ schema: ANALOGUE_INDEX_SCHEMA_V1, datasetId, selectionPolicyVersionId, records: Object.freeze(new Map()) });
}

/** Append-only: identical replay IDEMPOTENT, divergent replay REFUSED. */
export function appendIndexRecord(index, record) {
  if (index?.schema !== ANALOGUE_INDEX_SCHEMA_V1) failClosed('ANALOGUE_INDEX_INVALID');
  const verified = verifyIndexRecord(record);
  if (identityMemberValue(verified.orderedMembers, 'SelectionPolicyVersionId') !== index.selectionPolicyVersionId) {
    failClosed('INDEX_RECORD_SELECTION_POLICY_MISMATCH');
  }
  if (identityMemberValue(verified.orderedMembers, 'EligibleHistoryPinSetId') !== index.datasetId) {
    failClosed('INDEX_RECORD_DATASET_MISMATCH');
  }
  const existing = index.records.get(verified.analogueIdentityId);
  if (existing !== undefined) {
    if (canonicalize(existing) === canonicalize(verified)) return index;
    failClosed('INDEX_DIVERGENT_REPLACEMENT_REFUSED', { analogueIdentityId: verified.analogueIdentityId });
  }
  const records = new Map(index.records);
  records.set(verified.analogueIdentityId, verified);
  return Object.freeze({ ...index, records: Object.freeze(records) });
}

export const appendIndexRecords = (index, records) => records.reduce(appendIndexRecord, index);

export function readIndexRecord(index, analogueIdentityId) {
  return index.records.get(analogueIdentityId) ?? null;
}

function persistedIndexObject(index) {
  const records = [...index.records.values()].sort((left, right) => compareCodeUnits(left.analogueIdentityId, right.analogueIdentityId));
  return {
    schema: ANALOGUE_INDEX_SCHEMA_V1,
    datasetId: index.datasetId,
    selectionPolicyVersionId: index.selectionPolicyVersionId,
    pageSize: INDEX_PAGE_SIZE_V1,
    recordCount: records.length,
    records,
  };
}

/** Exact CanonicalJSON/1 bytes, UTF-8, no trailing newline. */
export function serializeAnalogueIndex(index) {
  return canonicalize(persistedIndexObject(index));
}

export const analogueIndexSha256 = (indexText) => sha256Bytes(Buffer.from(indexText, 'utf8'));

/** Parses persisted bytes and refuses anything that is not their own canonical form. */
export function parseAnalogueIndex(indexText) {
  if (typeof indexText !== 'string') failClosed('ANALOGUE_INDEX_BYTES_INVALID');
  let parsed;
  try {
    parsed = JSON.parse(indexText);
  } catch {
    failClosed('ANALOGUE_INDEX_NOT_JSON');
  }
  assertClosedKeys(parsed, ANALOGUE_INDEX_FIELDS_V1, 'ANALOGUE_INDEX_FIELDS_NOT_CLOSED');
  if (parsed.schema !== ANALOGUE_INDEX_SCHEMA_V1 || parsed.pageSize !== INDEX_PAGE_SIZE_V1) failClosed('ANALOGUE_INDEX_HEADER_INVALID');
  if (!Array.isArray(parsed.records) || parsed.recordCount !== parsed.records.length) failClosed('ANALOGUE_INDEX_RECORD_COUNT_MISMATCH');
  parsed.records.forEach((record, index) => {
    if (index > 0 && !(record.analogueIdentityId > parsed.records[index - 1].analogueIdentityId)) {
      failClosed('ANALOGUE_INDEX_STORAGE_ORDER_INVALID', { index });
    }
  });
  const index = appendIndexRecords(createAnalogueIndex(parsed), parsed.records);
  if (serializeAnalogueIndex(index) !== indexText) failClosed('ANALOGUE_INDEX_NOT_CANONICAL');
  return index;
}

/**
 * Append-only merge onto previously persisted bytes. The dataset and selection
 * policy bindings may not change; existing records may not be rewritten.
 */
export function mergeAnalogueIndexBytes({ existingText, index }) {
  if (existingText === null) return serializeAnalogueIndex(index);
  const existing = parseAnalogueIndex(existingText);
  if (existing.datasetId !== index.datasetId || existing.selectionPolicyVersionId !== index.selectionPolicyVersionId) {
    failClosed('ANALOGUE_INDEX_BINDING_CHANGE_REFUSED');
  }
  return serializeAnalogueIndex(appendIndexRecords(existing, [...index.records.values()]));
}

export function describeAnalogueIndex() {
  return Object.freeze({
    schema: ANALOGUE_INDEX_SCHEMA_V1,
    primaryKey: 'analogueIdentityId (GATE25_ANALOGUE_IDENTITY_V1)',
    storageSemantics: { appendOnly: true, identicalReplay: 'IDEMPOTENT', divergentReplay: 'REFUSED' },
    queryResultOrdering: QUERY_RESULT_ORDERING_V1,
    pageSize: INDEX_PAGE_SIZE_V1,
    persistedProductPath: ANALOGUE_INDEX_PRODUCT_PATH_V1,
    productClass: ANALOGUE_INDEX_PRODUCT_CLASS_V1,
    serialization: 'CanonicalJSON/1',
    liveWheelScanRebuild: 'FORBIDDEN',
  });
}
