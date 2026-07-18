/**
 * Shared CAS helpers for L2B instrument identity builders/verifiers.
 */

import { InstrumentIdentityError } from '../contracts/instrumentIdentityV1.mjs';
import { SHA256_OBJECT_ID_PATTERN } from '../contracts/datasetSnapshotV1.mjs';
import { isPlainObject } from '../contracts/contractPrimitivesV1.mjs';

/**
 * @param {unknown} input
 * @param {string} [code]
 */
export function assertBuildInput(input, code = 'INSTRUMENT_INPUT_INVALID') {
  if (input === undefined || input === null || !isPlainObject(input)) {
    throw new InstrumentIdentityError(code, 'input must be a plain object');
  }
}

/** @param {unknown} store @param {string[]} methods */
export function assertStore(store, methods) {
  if (store === undefined || store === null || typeof store !== 'object') {
    throw new InstrumentIdentityError('INSTRUMENT_STORE_REQUIRED', 'store is required');
  }
  for (const method of methods) {
    if (typeof (/** @type {any} */ (store))[method] !== 'function') {
      throw new InstrumentIdentityError('INSTRUMENT_STORE_REQUIRED', `store.${method} is required`);
    }
  }
}

/** @param {unknown} value @param {string} label */
export function assertObjectId(value, label) {
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) {
    throw new InstrumentIdentityError('INSTRUMENT_REFERENCE_INVALID', `${label} is invalid`);
  }
}

/**
 * @param {any} store
 * @param {string} objectId
 * @param {string} schemaVersion
 * @param {string} label
 */
export function readSnapshotObject(store, objectId, schemaVersion, label) {
  const uri = store.uriForObject({ namespace: 'snapshots', objectId });
  try {
    return store.readCanonicalObject({ uri, expectedObjectId: objectId, schemaVersion }).value;
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === 'CAS_OBJECT_CORRUPT' && /** @type {any} */ (error)?.details?.fsCode === 'ENOENT') {
      throw new InstrumentIdentityError('INSTRUMENT_REFERENCE_MISSING',
        `${label} object is missing from the CAS`, { objectId, cause: error });
    }
    if (code === 'CAS_OBJECT_CORRUPT' || code === 'CAS_EXISTING_CONTENT_MISMATCH') {
      throw new InstrumentIdentityError('INSTRUMENT_REFERENCE_MISMATCH',
        `${label} object failed hash or schema verification`, { objectId, cause: error });
    }
    if (error instanceof InstrumentIdentityError) throw error;
    throw new InstrumentIdentityError('INSTRUMENT_REFERENCE_MISMATCH',
      `${label} object could not be read`, { objectId, cause: error });
  }
}

/**
 * @param {any} store
 * @param {string} schemaVersion
 * @param {unknown} value
 */
export function putCanonical(store, schemaVersion, value) {
  const published = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion,
    value,
  });
  const reread = store.readCanonicalObject({
    uri: published.uri,
    expectedObjectId: published.objectId,
    schemaVersion,
  });
  return { ...published, value: reread.value };
}
