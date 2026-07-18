import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const CANONICAL_JSON_VERSION = 'CanonicalJSON/1';

export class CanonicalizationError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'CanonicalizationError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} value */
export function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError('CANONICAL_INVALID_UNICODE', `isolated high surrogate at UTF-16 index ${index}`);
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalizationError('CANONICAL_INVALID_UNICODE', `isolated low surrogate at UTF-16 index ${index}`);
    }
  }
}

/**
 * Validate a JSON-domain value and rebuild it with UTF-16-sorted object keys.
 * JSON.stringify supplies ECMAScript shortest-round-trip number rendering,
 * which is the number profile used by JCS/RFC 8785.
 * @param {unknown} value
 * @param {Set<object>} ancestors
 * @returns {unknown}
 */
function sortCanonicalValue(value, ancestors) {
  if (value === undefined) {
    throw new CanonicalizationError('CANONICAL_UNDEFINED', 'undefined is not part of the JSON data model');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError('CANONICAL_NON_FINITE_NUMBER', `non-finite number refused: ${String(value)}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError('CANONICAL_UNSAFE_INTEGER', `unsafe integer refused: ${String(value)}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new CanonicalizationError('CANONICAL_TYPE_UNSUPPORTED', `unsupported JSON type: ${typeof value}`);
  }
  if (ancestors.has(/** @type {object} */ (value))) {
    throw new CanonicalizationError('CANONICAL_CYCLE', 'cyclic structures cannot be canonicalized');
  }
  ancestors.add(/** @type {object} */ (value));
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sortCanonicalValue(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError('CANONICAL_TYPE_UNSUPPORTED', 'only plain objects are canonical JSON objects');
    }
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      assertValidUnicode(key);
      sorted[key] = sortCanonicalValue(/** @type {Record<string, unknown>} */ (value)[key], ancestors);
    }
    return sorted;
  } finally {
    ancestors.delete(/** @type {object} */ (value));
  }
}

/** @param {unknown} normalizedValue @returns {Buffer} */
export function canonicalJsonBytes(normalizedValue) {
  const sorted = sortCanonicalValue(normalizedValue, new Set());
  const text = `${JSON.stringify(sorted)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new CanonicalizationError('CANONICAL_BOM_FORBIDDEN', 'UTF-8 BOM is forbidden');
  }
  return bytes;
}

/** @param {unknown} normalizedValue @returns {string} */
export function canonicalJsonText(normalizedValue) {
  return canonicalJsonBytes(normalizedValue).toString('utf8');
}

/**
 * Parse bytes only when they are already the exact CanonicalJSON/1 encoding.
 * @param {Buffer|Uint8Array} input
 * @returns {unknown}
 */
export function parseCanonicalJsonBytes(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new CanonicalizationError('CANONICAL_TYPE_UNSUPPORTED', 'canonical JSON input must be bytes');
  }
  const bytes = Buffer.from(input);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new CanonicalizationError('CANONICAL_BOM_FORBIDDEN', 'UTF-8 BOM is forbidden');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CanonicalizationError('CANONICAL_INVALID_UNICODE', 'input is not valid UTF-8', { cause: error });
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
    throw new CanonicalizationError('CANONICAL_NON_CANONICAL_INPUT', 'exactly one LF terminator is required');
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch (error) {
    throw new CanonicalizationError('CANONICAL_NON_CANONICAL_INPUT', 'invalid JSON', { cause: error });
  }
  const regenerated = canonicalJsonBytes(value);
  if (!regenerated.equals(bytes)) {
    throw new CanonicalizationError('CANONICAL_NON_CANONICAL_INPUT', 'input bytes are valid JSON but not CanonicalJSON/1');
  }
  return value;
}

/**
 * Hash an already-normalized schema object. The schema version is required to
 * prevent accidental calls that omit the contract binding; it is also
 * expected to be present in the normalized object itself.
 * @param {string} schemaVersion
 * @param {unknown} normalizedValue
 */
export function canonicalHash(schemaVersion, normalizedValue) {
  if (typeof schemaVersion !== 'string' || schemaVersion.length === 0) {
    throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', 'schemaVersion is required');
  }
  if (
    normalizedValue === null
    || typeof normalizedValue !== 'object'
    || /** @type {{schemaVersion?: unknown}} */ (normalizedValue).schemaVersion !== schemaVersion
  ) {
    throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `value is not bound to schema ${schemaVersion}`);
  }
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(normalizedValue)).digest('hex')}`;
}
