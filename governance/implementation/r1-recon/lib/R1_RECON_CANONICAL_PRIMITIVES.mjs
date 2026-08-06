// R1_RECON_CANONICAL_PRIMITIVES
// artifactClass : DETERMINISTIC_RECONSTRUCTION_IMPLEMENTATION_AUTHORITY
// historicalOriginal : false
// canonicalAdoptionPath : false
//
// SINGLE canonical definition of primitive-leaf enumeration, JSON canonicalization,
// hashing and JSON Pointer resolution for the R1_RECON reconstruction.
//
// The generator, the validator, the test runner and the terminal verifier all load
// THIS module and no other copy. The module is hash-pinned by
// GENESIS_IMPORT_SOURCE_MAP_DETERMINISTIC_RECONSTRUCTION_RULE at
// /implementationAuthorities/primitiveLibSha256 and every consumer verifies that
// hash before importing it.
//
// collectPrimitiveLeaves MUST NOT filter any pointer. Filtering
// /unresolvedHistoricalDetails/ was defect B04 of the R1 package.

export const PRIMITIVE_LEAF_FILTERING_FORBIDDEN = true;

export function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('NON_FINITE_NUMBER_FORBIDDEN');
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return '{' + keys.map((key) => JSON.stringify(key.normalize('NFC')) + ':' + canonicalize(value[key])).join(',') + '}';
  }
  throw new Error('UNSUPPORTED_JSON_VALUE:' + typeof value);
}

export const escapePointerToken = (token) => String(token).replace(/~/g, '~0').replace(/\//g, '~1');
export const unescapePointerToken = (token) => String(token).replace(/~1/g, '/').replace(/~0/g, '~');

// Enumerates EVERY primitive leaf of the document. No pointer class is excluded.
export function collectPrimitiveLeaves(value, pointer = '', out = []) {
  if (value === null || typeof value !== 'object') {
    out.push({ pointer: pointer === '' ? '/' : pointer, value });
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.push({ pointer: pointer === '' ? '/' : pointer, value: [], emptyContainer: true });
    else value.forEach((item, index) => collectPrimitiveLeaves(item, pointer + '/' + index, out));
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) out.push({ pointer: pointer === '' ? '/' : pointer, value: {}, emptyContainer: true });
  else for (const key of keys) collectPrimitiveLeaves(value[key], pointer + '/' + escapePointerToken(key), out);
  return out;
}

export function countPrimitiveLeaves(document) {
  return collectPrimitiveLeaves(document).length;
}

const MISSING = Symbol('POINTER_NOT_RESOLVED');
export const POINTER_NOT_RESOLVED = MISSING;

// Strict RFC 6901 resolution. Returns POINTER_NOT_RESOLVED when any token is absent,
// so that "value is undefined" and "pointer does not exist" cannot be confused.
export function resolveJsonPointer(root, pointer) {
  if (pointer === '' || pointer === '/') return root;
  if (typeof pointer !== 'string' || pointer[0] !== '/') return MISSING;
  let current = root;
  for (const rawToken of pointer.split('/').slice(1)) {
    const token = unescapePointerToken(rawToken);
    if (current === null || typeof current !== 'object') return MISSING;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return MISSING;
      const index = Number(token);
      if (index >= current.length) return MISSING;
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, token)) return MISSING;
    current = current[token];
  }
  return current;
}

export function valueHash(shaFn, value) {
  return shaFn(Buffer.from(canonicalize(value)));
}
