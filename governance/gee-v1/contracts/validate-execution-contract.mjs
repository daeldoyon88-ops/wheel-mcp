import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstJsonSchema } from './validate-against-json-schema.mjs';

const VERSION_RE = /^R[0-9]{4}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXECUTION_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'schemas', 'work-unit-execution-contract.schema.json'), 'utf8')
);

function push(findings, detectorId, message, jsonPointer = '/') {
  findings.push({ detectorId, severity: 'BLOCKING', message, jsonPointer });
}

function requireNonEmptyArray(findings, value, pointer, detectorId, label) {
  if (!Array.isArray(value) || value.length === 0) {
    push(findings, detectorId, `${label} required non-empty array.`, pointer);
    return false;
  }
  return true;
}

/**
 * Canonical Contract Layer validation.
 * Applies the JSON Schema first (authoritative structural truth),
 * then semantic checks that go beyond the schema (e.g. knownVerdicts).
 */
export function validateExecutionContract(contract, options = {}) {
  const findings = [];
  const knownVerdicts = options.knownVerdicts || null;

  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    push(findings, 'SCHEMA_VIOLATION', 'Execution contract must be an object.');
    return { valid: false, findings };
  }

  // JSON Schema is authoritative for structural validity.
  const schemaResult = validateAgainstJsonSchema(contract, EXECUTION_SCHEMA);
  for (const err of schemaResult.errors) {
    push(
      findings,
      'SCHEMA_VIOLATION',
      `JSON Schema: ${err.message} (${err.reason})`,
      err.jsonPointer || '/'
    );
  }

  // Semantic / policy checks (additive; never weaken schema).
  if (contract.schemaVersion !== 1) push(findings, 'INVALID_VERSION', 'schemaVersion must be 1.', '/schemaVersion');
  if (contract.contractKind !== 'EXECUTION') push(findings, 'SCHEMA_VIOLATION', 'contractKind must be EXECUTION.', '/contractKind');
  if (typeof contract.id !== 'string' || !contract.id) push(findings, 'SCHEMA_VIOLATION', 'id required.', '/id');
  if (typeof contract.type !== 'string' || !contract.type) push(findings, 'SCHEMA_VIOLATION', 'type required.', '/type');
  if (typeof contract.version !== 'string' || !VERSION_RE.test(contract.version)) {
    push(findings, 'INVALID_VERSION', 'version must match R0000 pattern.', '/version');
  }
  if (typeof contract.strategicContractId !== 'string' || !contract.strategicContractId) {
    push(findings, 'SCHEMA_VIOLATION', 'strategicContractId required.', '/strategicContractId');
  }
  if (typeof contract.objective === 'string' && contract.objective.trim().length === 0) {
    push(findings, 'MISSING_OBJECTIVE', 'objective required.', '/objective');
  } else if (typeof contract.objective !== 'string') {
    // schema already reports type; keep semantic detector for empty-string cases mainly
    if (!schemaResult.errors.some((e) => (e.jsonPointer || '').startsWith('/objective'))) {
      push(findings, 'MISSING_OBJECTIVE', 'objective required.', '/objective');
    }
  }
  if (!Array.isArray(contract.prerequisites)) {
    push(findings, 'SCHEMA_VIOLATION', 'prerequisites must be an array.', '/prerequisites');
  } else {
    for (const [index, prereq] of contract.prerequisites.entries()) {
      if (!prereq || typeof prereq.id !== 'string' || typeof prereq.statement !== 'string' || typeof prereq.critical !== 'boolean') {
        push(findings, 'SCHEMA_VIOLATION', 'prerequisite shape invalid.', `/prerequisites/${index}`);
      }
    }
  }
  requireNonEmptyArray(findings, contract.invariants, '/invariants', 'SCHEMA_VIOLATION', 'invariants');
  requireNonEmptyArray(findings, contract.requiredArtifacts, '/requiredArtifacts', 'SCHEMA_VIOLATION', 'requiredArtifacts');
  requireNonEmptyArray(findings, contract.requiredTests, '/requiredTests', 'SCHEMA_VIOLATION', 'requiredTests');
  requireNonEmptyArray(findings, contract.requiredNegativeTests, '/requiredNegativeTests', 'SCHEMA_VIOLATION', 'requiredNegativeTests');
  requireNonEmptyArray(findings, contract.requiredHostileOrCounterTests, '/requiredHostileOrCounterTests', 'SCHEMA_VIOLATION', 'requiredHostileOrCounterTests');
  requireNonEmptyArray(findings, contract.evidenceRequirements, '/evidenceRequirements', 'SCHEMA_VIOLATION', 'evidenceRequirements');
  if (!requireNonEmptyArray(findings, contract.closureConditions, '/closureConditions', 'MISSING_CLOSURE_CONDITIONS', 'closureConditions')) {
    // already recorded
  }
  if (!Array.isArray(contract.authorizedVerdicts) || contract.authorizedVerdicts.length === 0) {
    push(findings, 'SCHEMA_VIOLATION', 'authorizedVerdicts required.', '/authorizedVerdicts');
  } else {
    for (const [index, verdict] of contract.authorizedVerdicts.entries()) {
      if (typeof verdict !== 'string' || !verdict.trim()) {
        push(findings, 'UNKNOWN_VERDICT', 'empty verdict rejected.', `/authorizedVerdicts/${index}`);
      } else if (knownVerdicts && !knownVerdicts.has(verdict)) {
        push(findings, 'UNKNOWN_VERDICT', `verdict not in known set: ${verdict}`, `/authorizedVerdicts/${index}`);
      }
    }
  }
  requireNonEmptyArray(findings, contract.stateTransitionRules, '/stateTransitionRules', 'SCHEMA_VIOLATION', 'stateTransitionRules');
  requireNonEmptyArray(findings, contract.authorizedPaths, '/authorizedPaths', 'SCHEMA_VIOLATION', 'authorizedPaths');

  if (contract.activationPolicy && contract.activationPolicy.closureCriteriaMutableAfterActivation !== false) {
    push(findings, 'SCHEMA_VIOLATION', 'closureCriteriaMutableAfterActivation must be false.', '/activationPolicy/closureCriteriaMutableAfterActivation');
  }

  return { valid: findings.length === 0, findings, schemaValid: schemaResult.valid };
}
