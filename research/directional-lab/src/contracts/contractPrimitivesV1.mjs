/**
 * Shared validation primitives for L2A contracts. These helpers own no
 * financial semantics: each schema module keeps its own field rules and only
 * reuses these small structural checks.
 */

import { CanonicalizationError, assertValidUnicode } from '../canonical/canonicalJsonV1.mjs';
import { SHA256_OBJECT_ID_PATTERN } from './datasetSnapshotV1.mjs';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
export function checkNonEmptyString(value, label, problems) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    problems.push(`${label} must be a non-empty trimmed string`);
    return;
  }
  try { assertValidUnicode(value); } catch { problems.push(`${label} contains invalid Unicode`); }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
export function checkObjectId(value, label, problems) {
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) {
    problems.push(`${label} must use sha256:<64 lowercase hex>`);
  }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
export function checkNullableObjectId(value, label, problems) {
  if (value === null) return;
  checkObjectId(value, label, problems);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} fields @param {string[]} problems */
export function checkFieldSet(value, fields, problems) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) problems.push(`${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) problems.push(`unknown field: ${field}`);
  }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
export function checkObjectIdArray(value, label, problems) {
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array`);
    return;
  }
  value.forEach((id, index) => checkObjectId(id, `${label}[${index}]`, problems));
}

/** Sorted unique copy of an already-validated string array. @param {string[]} values */
export function sortedUniqueStrings(values) {
  return [...new Set(values)].sort();
}

/**
 * Schema-owned normalization for extensible JSON payload objects (metrics,
 * execution identities, legacy evidence blocks). Array order is semantic and
 * preserved; object keys are sorted later by CanonicalJSON/1.
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown}
 */
export function normalizeJsonPayload(value, label) {
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
  if (Array.isArray(value)) return value.map((item, index) => normalizeJsonPayload(item, `${label}[${index}]`));
  if (!isPlainObject(value)) throw new CanonicalizationError('CANONICAL_TYPE_UNSUPPORTED', `${label} must contain only JSON values`);
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new CanonicalizationError('CANONICAL_TYPE_UNSUPPORTED', `${label} contains a symbol key`);
    }
    assertValidUnicode(key);
    result[key] = normalizeJsonPayload(/** @type {Record<string, unknown>} */ (value)[key], `${label}.${key}`);
  }
  return result;
}

/**
 * Recursive validation counterpart of normalizeJsonPayload. Keeping both on
 * the same JSON domain guarantees that a payload accepted by a L2A validator
 * can also be normalized.
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
export function jsonPayloadProblems(value, label) {
  const problems = [];
  function visit(current, currentLabel) {
    if (current === undefined) {
      problems.push(`${currentLabel} contains undefined`);
      return;
    }
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      try { assertValidUnicode(current); } catch { problems.push(`${currentLabel} contains invalid Unicode`); }
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) problems.push(`${currentLabel} contains a non-finite number`);
      else if (Number.isInteger(current) && !Number.isSafeInteger(current)) problems.push(`${currentLabel} contains an unsafe integer`);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentLabel}[${index}]`));
      return;
    }
    if (!isPlainObject(current)) {
      problems.push(`${currentLabel} must contain only JSON values`);
      return;
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') {
        problems.push(`${currentLabel} contains a symbol key`);
        continue;
      }
      try { assertValidUnicode(key); } catch { problems.push(`${currentLabel} contains an invalid Unicode key`); }
      visit(/** @type {Record<string, unknown>} */ (current)[key], `${currentLabel}.${key}`);
    }
  }
  visit(value, label);
  return problems;
}

/**
 * Uniform normalization failure: unknown fields keep the canonical error code,
 * everything else is delegated to the schema-owned error factory.
 * @param {string[]} problems
 * @param {(problems: string[]) => Error} makeError
 */
export function throwForProblems(problems, makeError) {
  const unknown = problems.find((problem) => problem.includes('unknown field:'));
  if (unknown) throw new CanonicalizationError('CANONICAL_UNKNOWN_FIELD', unknown);
  if (problems.length > 0) throw makeError(problems);
}

/** Portable relative logical path: no backslash, drive, scheme, traversal. @param {unknown} logicalPath */
export function isPortableLogicalPath(logicalPath) {
  if (typeof logicalPath !== 'string' || logicalPath.length === 0) return false;
  if (logicalPath.includes('\\') || logicalPath.includes('\0') || logicalPath.includes(':') || logicalPath.startsWith('/')) return false;
  const segments = logicalPath.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
