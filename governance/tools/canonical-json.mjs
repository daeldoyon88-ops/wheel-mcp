import { createHash } from 'node:crypto';

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

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
