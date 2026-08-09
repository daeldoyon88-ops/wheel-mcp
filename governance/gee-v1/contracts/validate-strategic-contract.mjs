import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstJsonSchema } from './validate-against-json-schema.mjs';

const VERSION_RE = /^R[0-9]{4}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STRATEGIC_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'schemas', 'work-unit-strategic-contract.schema.json'), 'utf8')
);

function push(findings, detectorId, message, jsonPointer = '/') {
  findings.push({ detectorId, severity: 'BLOCKING', message, jsonPointer });
}

/**
 * Canonical Strategic Contract validation.
 * JSON Schema is the authoritative structural truth; semantic checks are additive only.
 */
export function validateStrategicContract(contract) {
  const findings = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    push(findings, 'SCHEMA_VIOLATION', 'Strategic contract must be an object.');
    return { valid: false, findings, schemaValid: false };
  }

  const schemaResult = validateAgainstJsonSchema(contract, STRATEGIC_SCHEMA);
  for (const err of schemaResult.errors) {
    push(
      findings,
      'SCHEMA_VIOLATION',
      `JSON Schema: ${err.message} (${err.reason})`,
      err.jsonPointer || '/'
    );
  }

  // Additive semantic checks (never weaken schema).
  if (contract.schemaVersion !== 1) push(findings, 'INVALID_VERSION', 'schemaVersion must be 1.', '/schemaVersion');
  if (contract.contractKind !== 'STRATEGIC') push(findings, 'SCHEMA_VIOLATION', 'contractKind must be STRATEGIC.', '/contractKind');
  if (typeof contract.id !== 'string' || !contract.id) push(findings, 'SCHEMA_VIOLATION', 'id required.', '/id');
  if (typeof contract.type !== 'string' || !contract.type) push(findings, 'SCHEMA_VIOLATION', 'type required.', '/type');
  if (typeof contract.version !== 'string' || !VERSION_RE.test(contract.version)) {
    push(findings, 'INVALID_VERSION', 'version must match R0000 pattern.', '/version');
  }
  if (typeof contract.objective === 'string' && contract.objective.trim().length === 0) {
    push(findings, 'MISSING_OBJECTIVE', 'objective required.', '/objective');
  } else if (typeof contract.objective !== 'string') {
    if (!schemaResult.errors.some((e) => (e.jsonPointer || '').startsWith('/objective'))) {
      push(findings, 'MISSING_OBJECTIVE', 'objective required.', '/objective');
    }
  }
  if (!Array.isArray(contract.invariants) || contract.invariants.length === 0) {
    push(findings, 'SCHEMA_VIOLATION', 'invariants required.', '/invariants');
  }
  if (!Array.isArray(contract.authorizedVerdicts) || contract.authorizedVerdicts.length === 0) {
    push(findings, 'SCHEMA_VIOLATION', 'authorizedVerdicts required.', '/authorizedVerdicts');
  } else if (contract.authorizedVerdicts.some((v) => typeof v !== 'string' || !v.trim())) {
    push(findings, 'UNKNOWN_VERDICT', 'authorizedVerdicts entries must be non-empty strings.', '/authorizedVerdicts');
  }
  if (Array.isArray(contract.prerequisites)) {
    for (const [index, prereq] of contract.prerequisites.entries()) {
      if (!prereq || typeof prereq.id !== 'string' || typeof prereq.statement !== 'string' || typeof prereq.critical !== 'boolean') {
        push(findings, 'SCHEMA_VIOLATION', 'prerequisite shape invalid.', `/prerequisites/${index}`);
      }
    }
  }

  return { valid: findings.length === 0, findings, schemaValid: schemaResult.valid };
}
