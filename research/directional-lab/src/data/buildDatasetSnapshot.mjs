import { canonicalHash, parseCanonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  normalizeCanonicalDailyBarsV1,
} from '../canonical/canonicalDailyBarsV1.mjs';
import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  DatasetSnapshotError,
  SHA256_OBJECT_ID_PATTERN,
  normalizeDatasetSnapshotCoreV1,
  normalizeDatasetSnapshotRecordV1,
} from '../contracts/datasetSnapshotV1.mjs';
import {
  MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
  normalizeMarketDataEodOhlcvCanonicalRowsV1,
} from '../contracts/marketDataSnapshotMaterializationL3V1.mjs';

/**
 * Normalize L1 snapshot content. CanonicalDailyBars/1 remains the historical
 * default. MarketDataEodOhlcvCanonicalRows/1 is the additive L3-I5 path that
 * preserves atom/scale numerics without IEEE float coercion.
 * @param {unknown} value
 */
function normalizeSnapshotNormalizedContent(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', 'normalized content must be an object');
  }
  const schemaVersion = /** @type {{schemaVersion?: unknown}} */ (value).schemaVersion;
  if (schemaVersion === CANONICAL_DAILY_BARS_SCHEMA_VERSION) {
    return {
      schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION,
      normalized: normalizeCanonicalDailyBarsV1(value),
    };
  }
  if (schemaVersion === MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION) {
    return {
      schemaVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
      normalized: normalizeMarketDataEodOhlcvCanonicalRowsV1(value),
    };
  }
  throw new DatasetSnapshotError(
    'SNAPSHOT_CONTRACT_INVALID',
    'normalized content schemaVersion must be CanonicalDailyBars/1 or MarketDataEodOhlcvCanonicalRows/1',
  );
}

/** @param {unknown} value */
function assertStore(value) {
  for (const method of ['putSourceBytes', 'putCanonicalObject', 'readObject', 'readCanonicalObject', 'uriForObject']) {
    if (!value || typeof value[method] !== 'function') {
      throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', `store.${method} is required`);
    }
  }
}

/** @param {Record<string, unknown>} value @param {string[]} forbidden @param {string} label */
function rejectDerivedFields(value, forbidden, label) {
  for (const field of forbidden) {
    if (Object.hasOwn(value, field)) {
      throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', `${label}.${field} is derived and must not be supplied`);
    }
  }
}

/** @param {unknown} value */
export function datasetSnapshotCoreId(value) {
  const normalized = normalizeDatasetSnapshotCoreV1(value);
  return canonicalHash(DATASET_SNAPSHOT_CORE_SCHEMA_VERSION, normalized);
}

/** @param {unknown} value */
export function datasetSnapshotRecordId(value) {
  const normalized = normalizeDatasetSnapshotRecordV1(value);
  return canonicalHash(DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION, normalized);
}

/**
 * Store exact source bytes, exact normalized bars, deterministic core and one
 * acquisition record. Human notes are returned only as caller metadata and
 * never enter any hashed contract.
 * @param {{
 *   store: any,
 *   sourceBytes: Buffer|Uint8Array,
 *   normalizedDailyBars: unknown,
 *   core: Record<string, unknown>,
 *   record: Record<string, unknown>,
 *   humanNotes?: unknown,
 * }} input
 */
export function buildDatasetSnapshot(input) {
  if (!input || typeof input !== 'object') {
    throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', 'snapshot build input is required');
  }
  assertStore(input.store);
  if (!input.core || typeof input.core !== 'object' || Array.isArray(input.core)) {
    throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', 'core identity fields must be an object');
  }
  if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) {
    throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', 'record identity fields must be an object');
  }
  rejectDerivedFields(input.core, ['schemaVersion', 'sourceObjectId', 'normalizedObjectId'], 'core');
  rejectDerivedFields(input.record, ['schemaVersion', 'snapshotCoreId'], 'record');

  const { schemaVersion: normalizedSchemaVersion, normalized: normalizedDailyBars } =
    normalizeSnapshotNormalizedContent(input.normalizedDailyBars);
  const sourceObject = input.store.putSourceBytes(input.sourceBytes);
  const normalizedObject = input.store.putCanonicalObject({
    namespace: 'normalized',
    schemaVersion: normalizedSchemaVersion,
    value: normalizedDailyBars,
  });
  const core = normalizeDatasetSnapshotCoreV1({
    schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    sourceObjectId: sourceObject.objectId,
    normalizedObjectId: normalizedObject.objectId,
    ...input.core,
  });
  const snapshotCore = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION, value: core,
  });
  const record = normalizeDatasetSnapshotRecordV1({
    schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
    snapshotCoreId: snapshotCore.objectId,
    ...input.record,
  });
  const snapshotRecord = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION, value: record,
  });

  const result = {
    sourceObject,
    normalizedObject,
    snapshotCore,
    snapshotRecord,
    core,
    record,
    humanNotes: input.humanNotes,
  };
  verifyDatasetSnapshot({ store: input.store, snapshotRecordId: snapshotRecord.objectId });
  return result;
}

/** @param {unknown} error @param {string} label @param {string} objectId */
function mapReferenceError(error, label, objectId) {
  if (error?.code === 'CAS_OBJECT_CORRUPT' && error?.details?.fsCode === 'ENOENT') {
    return new DatasetSnapshotError('SNAPSHOT_REFERENCE_MISSING', `${label} object is missing`, { objectId, cause: error });
  }
  if (error?.code === 'CAS_OBJECT_CORRUPT' || error?.code === 'CAS_EXISTING_CONTENT_MISMATCH') {
    return new DatasetSnapshotError('SNAPSHOT_REFERENCE_HASH_MISMATCH', `${label} object failed hash verification`, { objectId, cause: error });
  }
  return error;
}

/**
 * Recover and verify a complete snapshot using only its record ID and CAS.
 * @param {{store: any, snapshotRecordId: string}} input
 */
export function verifyDatasetSnapshot(input) {
  assertStore(input?.store);
  if (typeof input?.snapshotRecordId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(input.snapshotRecordId)) {
    throw new DatasetSnapshotError('SNAPSHOT_CONTRACT_INVALID', 'snapshotRecordId is invalid');
  }
  let recordRead;
  const recordUri = input.store.uriForObject({ namespace: 'snapshots', objectId: input.snapshotRecordId });
  try {
    recordRead = input.store.readCanonicalObject({
      uri: recordUri, expectedObjectId: input.snapshotRecordId, schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
    });
  } catch (error) { throw mapReferenceError(error, 'snapshot record', input.snapshotRecordId); }
  const record = recordRead.value;

  let coreRead;
  const coreUri = input.store.uriForObject({ namespace: 'snapshots', objectId: record.snapshotCoreId });
  try {
    coreRead = input.store.readCanonicalObject({
      uri: coreUri, expectedObjectId: record.snapshotCoreId, schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    });
  } catch (error) { throw mapReferenceError(error, 'snapshot core', record.snapshotCoreId); }
  const core = coreRead.value;

  let sourceRead;
  const sourceUri = input.store.uriForObject({ namespace: 'source', objectId: core.sourceObjectId });
  try {
    sourceRead = input.store.readObject({ uri: sourceUri, expectedObjectId: core.sourceObjectId });
  } catch (error) { throw mapReferenceError(error, 'source', core.sourceObjectId); }

  let normalizedRead;
  const normalizedUri = input.store.uriForObject({ namespace: 'normalized', objectId: core.normalizedObjectId });
  try {
    const normalizedRaw = input.store.readObject({
      uri: normalizedUri, expectedObjectId: core.normalizedObjectId,
    });
    const parsed = parseCanonicalJsonBytes(normalizedRaw.bytes);
    const normalizedSchemaVersion = parsed?.schemaVersion;
    if (normalizedSchemaVersion !== CANONICAL_DAILY_BARS_SCHEMA_VERSION
        && normalizedSchemaVersion !== MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION) {
      throw new DatasetSnapshotError(
        'SNAPSHOT_CONTRACT_INVALID',
        'normalized object schemaVersion is not an accepted L1 content schema',
        { normalizedObjectId: core.normalizedObjectId, schemaVersion: normalizedSchemaVersion },
      );
    }
    normalizedRead = input.store.readCanonicalObject({
      uri: normalizedUri,
      expectedObjectId: core.normalizedObjectId,
      schemaVersion: normalizedSchemaVersion,
    });
  } catch (error) {
    if (error instanceof DatasetSnapshotError) throw error;
    throw mapReferenceError(error, 'normalized', core.normalizedObjectId);
  }

  return {
    snapshotRecordId: input.snapshotRecordId,
    record,
    core,
    sourceBytes: sourceRead.bytes,
    normalizedDailyBars: normalizedRead.value,
    references: {
      snapshotRecord: { objectId: input.snapshotRecordId, uri: recordUri },
      snapshotCore: { objectId: record.snapshotCoreId, uri: coreUri },
      source: { objectId: core.sourceObjectId, uri: sourceUri },
      normalized: { objectId: core.normalizedObjectId, uri: normalizedUri },
    },
  };
}
