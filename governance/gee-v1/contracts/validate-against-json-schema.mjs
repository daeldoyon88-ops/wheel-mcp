/**
 * Minimal JSON Schema (draft-07 subset) validator for GEE V1 canonical schemas.
 * No external npm dependency. Supports the constructs used by gee-v1 schemas:
 * type, const, enum, pattern, minLength, minimum, minItems, uniqueItems,
 * required, properties, additionalProperties=false, items.
 */

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(actual, expected) {
  if (expected === 'number' && actual === 'integer') return true;
  return actual === expected;
}

/**
 * @returns {{ valid: boolean, errors: Array<{ jsonPointer: string, reason: string, message: string }> }}
 */
export function validateAgainstJsonSchema(instance, schema, pointer = '') {
  const errors = [];
  if (!schema || typeof schema !== 'object') {
    return { valid: false, errors: [{ jsonPointer: pointer || '/', reason: 'INVALID_SCHEMA', message: 'schema must be an object' }] };
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (JSON.stringify(instance) !== JSON.stringify(schema.const)) {
      errors.push({ jsonPointer: pointer || '/', reason: 'CONST_MISMATCH', message: `must equal const ${JSON.stringify(schema.const)}` });
      return { valid: false, errors };
    }
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = actualType(instance);
    if (!types.some((t) => typeMatches(actual, t))) {
      errors.push({
        jsonPointer: pointer || '/',
        reason: 'TYPE_MISMATCH',
        message: `expected type ${types.join('|')}, got ${actual}`
      });
      return { valid: false, errors };
    }
  }

  if (schema.enum) {
    const ok = schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(instance));
    if (!ok) {
      errors.push({ jsonPointer: pointer || '/', reason: 'ENUM_MISMATCH', message: 'value not in enum' });
    }
  }

  if (typeof instance === 'string') {
    if (typeof schema.minLength === 'number' && instance.length < schema.minLength) {
      errors.push({ jsonPointer: pointer || '/', reason: 'MIN_LENGTH', message: `minLength ${schema.minLength}` });
    }
    if (typeof schema.pattern === 'string') {
      const re = new RegExp(schema.pattern);
      if (!re.test(instance)) {
        errors.push({ jsonPointer: pointer || '/', reason: 'PATTERN_MISMATCH', message: `must match ${schema.pattern}` });
      }
    }
  }

  if (typeof instance === 'number') {
    if (typeof schema.minimum === 'number' && instance < schema.minimum) {
      errors.push({ jsonPointer: pointer || '/', reason: 'MINIMUM', message: `minimum ${schema.minimum}` });
    }
  }

  if (Array.isArray(instance)) {
    if (typeof schema.minItems === 'number' && instance.length < schema.minItems) {
      errors.push({ jsonPointer: pointer || '/', reason: 'MIN_ITEMS', message: `minItems ${schema.minItems}` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const [i, item] of instance.entries()) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push({ jsonPointer: `${pointer}/${i}`, reason: 'UNIQUE_ITEMS', message: 'duplicate array item' });
        }
        seen.add(key);
      }
    }
    if (schema.items) {
      for (const [i, item] of instance.entries()) {
        const child = validateAgainstJsonSchema(item, schema.items, `${pointer}/${i}`);
        errors.push(...child.errors);
      }
    }
  }

  if (instance && typeof instance === 'object' && !Array.isArray(instance)) {
    for (const req of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(instance, req)) {
        errors.push({ jsonPointer: `${pointer}/${req}`, reason: 'MISSING_REQUIRED', message: `required property ${req}` });
      }
    }
    for (const [key, value] of Object.entries(instance)) {
      const sub = schema.properties?.[key];
      if (sub) {
        const child = validateAgainstJsonSchema(value, sub, `${pointer}/${key}`);
        errors.push(...child.errors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          jsonPointer: `${pointer}/${key}`,
          reason: 'ADDITIONAL_PROPERTY_FORBIDDEN',
          message: `additional property ${key} forbidden`
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
