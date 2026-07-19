/**
 * Shared closed primitives for the L3 market-data contracts.
 *
 * These helpers contain no market-session inference and never consult the wall
 * clock, ICU, the network or a physical path supplied by a caller.
 */

import { createHash } from 'node:crypto';
import {
  assertValidUnicode,
  canonicalJsonBytes,
  parseCanonicalJsonBytes,
} from '../canonical/canonicalJsonV1.mjs';
import { isStrictUtcIsoInstant } from './dailyBarV1.mjs';
import { isValidCivilDate } from '../time/civilDate.mjs';
import { SHA256_OBJECT_ID_PATTERN } from './datasetSnapshotV1.mjs';
import { isPlainObject } from './contractPrimitivesV1.mjs';

export class MarketDataL3Error extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'MarketDataL3Error';
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} error @param {string} [code] */
export function asMarketDataL3Error(error, code = 'MARKET_DATA_INPUT_INVALID') {
  if (error instanceof MarketDataL3Error) return error;
  return new MarketDataL3Error(code, 'market-data operation failed', { cause: error });
}

/** @param {unknown} value @param {string} label */
export function assertPlainObject(value, label = 'input') {
  if (!isPlainObject(value)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a plain object`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {readonly string[]} allowed */
export function assertApiInput(value, allowed) {
  const input = assertPlainObject(value);
  const accepted = new Set(['store', ...allowed]);
  for (const field of Object.keys(input)) {
    if (!accepted.has(field)) {
      throw new MarketDataL3Error('MARKET_DATA_UNKNOWN_FIELD', `unknown field: ${field}`, { field });
    }
  }
  for (const field of allowed) {
    if (!Object.hasOwn(input, field)) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${field} is required`, { field });
    }
  }
  return input;
}

/** @param {Record<string, any>} value @param {readonly string[]} fields */
export function assertExactFields(value, fields) {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) {
      throw new MarketDataL3Error('MARKET_DATA_UNKNOWN_FIELD', `unknown field: ${field}`, { field });
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${field} is required`, { field });
    }
  }
}

/** @param {Record<string, any>} value @param {string} schemaVersion */
export function assertSchemaVersion(value, schemaVersion) {
  if (value.schemaVersion !== schemaVersion) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED',
      `schemaVersion must be ${schemaVersion}`,
      { expected: schemaVersion, actual: value.schemaVersion },
    );
  }
}

/** @param {unknown} value @param {string} label @param {{nullable?: boolean, physicalLocationForbidden?: boolean}} [options] */
export function assertNonEmptyString(value, label, options = {}) {
  if (options.nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a non-empty trimmed string`);
  }
  try { assertValidUnicode(value); } catch (cause) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} contains invalid Unicode`, { cause });
  }
  if (options.physicalLocationForbidden !== false) assertNoPhysicalLocation(value, label);
}

/** @param {unknown} value @param {string} label @param {boolean} [nullable] */
export function assertCasId(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a CAS object ID`, { label });
  }
}

/** @param {unknown} value @param {string} label */
export function assertCivilDate(value, label) {
  if (typeof value !== 'string' || !isValidCivilDate(value)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a valid YYYY-MM-DD civil date`);
  }
}

/** @param {unknown} value @param {string} label @param {boolean} [nullable] */
export function assertUtcInstant(value, label, nullable = false) {
  if (nullable && value === null) return;
  if (!isStrictUtcIsoInstant(value)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a strict UTC instant`);
  }
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} label @param {string} [code] */
export function assertEnum(value, allowed, label, code = 'MARKET_DATA_INPUT_INVALID') {
  if (!allowed.includes(/** @type {string} */ (value))) {
    throw new MarketDataL3Error(code, `${label} is invalid`, { allowed, actual: value });
  }
}

/** @param {unknown} value @param {string} label @param {{positive?: boolean, nonNegative?: boolean}} [options] */
export function assertSafeInteger(value, label, options = {}) {
  if (!Number.isSafeInteger(value)
      || (options.positive && value <= 0)
      || (options.nonNegative && value < 0)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a safe integer`, { value });
  }
}

/** @param {unknown} value @param {string} label */
export function assertNonNegativeDecimalString(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a non-negative decimal string`);
  }
}

/** @param {unknown} value @param {string} label @param {{nonEmpty?: boolean, code?: string}} [options] */
export function assertSortedUniqueStrings(value, label, options = {}) {
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)) {
    throw new MarketDataL3Error(options.code ?? 'MARKET_DATA_INPUT_INVALID', `${label} must be${options.nonEmpty ? ' a non-empty' : ' an'} array`);
  }
  for (let i = 0; i < value.length; i += 1) {
    assertNonEmptyString(value[i], `${label}[${i}]`);
    if (i > 0 && value[i - 1] >= value[i]) {
      throw new MarketDataL3Error(options.code ?? 'MARKET_DATA_INPUT_INVALID', `${label} must be sorted and unique`);
    }
  }
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} label @param {{nonEmpty?: boolean, code?: string}} [options] */
export function assertSortedUniqueEnum(value, allowed, label, options = {}) {
  assertSortedUniqueStrings(value, label, options);
  for (const item of /** @type {string[]} */ (value)) assertEnum(item, allowed, label, options.code);
}

/** Best-effort only: rejects common structured credential markers, not all secrets. @param {unknown} value */
export function containsStructuredSecret(value) {
  let text;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) text = Buffer.from(value).toString('utf8');
  else if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { return true; }
  }
  return /(?:authorization\s*[:=]\s*bearer\s+|api[_-]?key\s*[:=]|access[_-]?token\s*[:=]|secret\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(text);
}

/** @param {unknown} value @param {string} label @param {string} [code] */
export function assertNoStructuredSecret(value, label, code = 'MARKET_DATA_SOURCE_ARTIFACT_INVALID') {
  if (containsStructuredSecret(value)) {
    throw new MarketDataL3Error(code, `${label} contains a structured secret marker`);
  }
}

/** @param {unknown} value @param {string} label */
export function assertNoPhysicalLocation(value, label) {
  if (typeof value !== 'string') return;
  if (value.includes('\0') || value.includes('\\') || value.includes('://') || value.startsWith('/')
      || /^[A-Za-z]:[\\/]/.test(value) || /(?:^|\/)\.\.?(?:\/|$)/.test(value)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must not contain a physical path or URL`);
  }
}

/** @param {unknown} store @param {readonly string[]} methods */
export function assertStore(store, methods) {
  if (store === null || typeof store !== 'object') {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'store is required');
  }
  for (const method of methods) {
    if (typeof /** @type {any} */ (store)[method] !== 'function') {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `store.${method} is required`);
    }
  }
}

/**
 * Reads a typed canonical reference and distinguishes absence, corruption and
 * a valid object of the wrong schema.
 * @param {any} store @param {string} objectId @param {string} schemaVersion @param {string} label
 */
export function readTypedReference(store, objectId, schemaVersion, label) {
  assertStore(store, ['uriForObject', 'readObject', 'readCanonicalObject']);
  if (typeof objectId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(objectId)) {
    throw new MarketDataL3Error('MARKET_DATA_REFERENCE_CORRUPT', `${label} ID is corrupt`, { objectId });
  }
  const uri = store.uriForObject({ namespace: 'snapshots', objectId });
  let raw;
  try {
    raw = store.readObject({ uri, expectedObjectId: objectId });
  } catch (cause) {
    if (cause?.details?.fsCode === 'ENOENT') {
      throw new MarketDataL3Error('MARKET_DATA_REFERENCE_MISSING', `${label} is missing`, { objectId, cause });
    }
    throw new MarketDataL3Error('MARKET_DATA_REFERENCE_CORRUPT', `${label} is corrupt`, { objectId, cause });
  }
  let parsed;
  try { parsed = parseCanonicalJsonBytes(raw.bytes); } catch (cause) {
    throw new MarketDataL3Error('MARKET_DATA_REFERENCE_CORRUPT', `${label} is not canonical JSON`, { objectId, cause });
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== schemaVersion) {
    throw new MarketDataL3Error('MARKET_DATA_WRONG_REFERENCE_TYPE', `${label} has the wrong schema`, {
      objectId, expected: schemaVersion, actual: parsed?.schemaVersion,
    });
  }
  try {
    return store.readCanonicalObject({ uri, expectedObjectId: objectId, schemaVersion }).value;
  } catch (cause) {
    throw new MarketDataL3Error('MARKET_DATA_REFERENCE_CORRUPT', `${label} failed schema or hash verification`, { objectId, cause });
  }
}

/** @param {any} store @param {string} schemaVersion @param {unknown} value */
export function putCanonicalL3(store, schemaVersion, value) {
  assertStore(store, ['putCanonicalObject', 'readCanonicalObject']);
  try {
    const published = store.putCanonicalObject({ namespace: 'snapshots', schemaVersion, value });
    const reread = store.readCanonicalObject({
      uri: published.uri, expectedObjectId: published.objectId, schemaVersion,
    });
    return { ...published, value: reread.value };
  } catch (error) {
    throw asMarketDataL3Error(error);
  }
}

/** @param {Buffer|Uint8Array|string} value */
export function sha256Digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** @param {unknown} value */
export function canonicalDigest(value) {
  return sha256Digest(canonicalJsonBytes(value));
}

/** @param {unknown} left @param {unknown} right */
export function canonicalValuesEqual(left, right) {
  try { return canonicalJsonBytes(left).equals(canonicalJsonBytes(right)); } catch { return false; }
}
