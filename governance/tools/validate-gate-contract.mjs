import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';

const CONTRACT_FIELDS = [
  'gateId', 'contractRevision', 'strategicRegistryReference', 'canonicalRequirements',
  'requiredInputs', 'requiredOutputs', 'validators', 'positiveTests', 'negativeTests',
  'countertests', 'reuseRules', 'invalidationRules', 'forbiddenReplays',
  'packagingRequirements', 'closureConditions', 'nextGateAuthorizationConditions',
  'performanceBudget', 'checkpointPolicy', 'authorizedPaths', 'requiredPolicyIds',
  'sourceReferences'
];
const POINTER_FIELDS = [
  'schemaVersion', 'gateId', 'contractRevision', 'contractPath', 'contractSha256',
  'activatedByEventId'
];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveOptionPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function finding(findings, detectorId, jsonPointer, actualValue, expectedRule, message, requirementId) {
  findings.push({
    detectorId,
    severity: 'BLOCKING',
    jsonPointer,
    actualValue,
    expectedRule,
    message,
    requirementId
  });
}

function readJson(file, findings, requirementId) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    finding(findings, 'MISSING_REQUIRED_INPUT', '/', file, 'existing JSON file', 'Required JSON input is missing.', requirementId);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    finding(findings, 'INVALID_JSON', '/', file, 'valid JSON', error.message, requirementId);
    return null;
  }
}

function isSafeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  if (segments.at(-1) === '') segments.pop();
  return segments.length > 0 && !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveRepoPath(root, relativePath, findings, pointer, requirementId) {
  if (!isSafeRelative(relativePath)) {
    finding(findings, 'INVALID_NORMALIZED_PATH', pointer, relativePath, 'relative slash-separated path without traversal', 'Path is absolute, ambiguous, or escapes the governed root.', requirementId);
    return null;
  }
  const absolute = path.resolve(root, relativePath);
  const prefix = path.resolve(root) + path.sep;
  if (!absolute.startsWith(prefix)) {
    finding(findings, 'PATH_OUTSIDE_ROOT', pointer, relativePath, 'resolved path below repository root', 'Path resolves outside the governed root.', requirementId);
    return null;
  }
  return absolute;
}

function requireFields(value, fields, allowed, findings, requirementId, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    finding(findings, 'SCHEMA_VIOLATION', '/', value, 'object', `${label} must be an object.`, requirementId);
    return false;
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      finding(findings, 'SCHEMA_VIOLATION', '/', field, 'required property', `${label} is missing ${field}.`, requirementId);
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      finding(findings, 'SCHEMA_VIOLATION', `/${field}`, value[field], 'additionalProperties=false', `${label} contains unknown field ${field}.`, requirementId);
    }
  }
  return true;
}

function validateContract({ root, contractPath, pointerPath, registryPath, constitutionPath }) {
  const findings = [];
  const contract = readJson(contractPath, findings, 'REQ-CTR-01');
  const pointer = readJson(pointerPath, findings, 'REQ-CTR-02');
  const registry = readJson(registryPath, findings, 'REQ-CTR-01');
  const constitution = readJson(constitutionPath, findings, 'REQ-CTR-01');

  if (contract) {
    requireFields(contract, [
      'gateId', 'contractRevision', 'strategicRegistryReference', 'canonicalRequirements',
      'requiredOutputs', 'validators', 'closureConditions', 'nextGateAuthorizationConditions',
      'performanceBudget', 'checkpointPolicy', 'authorizedPaths', 'requiredPolicyIds',
      'sourceReferences'
    ], CONTRACT_FIELDS, findings, 'REQ-CTR-01', 'Execution contract');
    if (typeof contract.gateId !== 'string' || !/^GATE(0[0-9]|[1-3][0-9]|40)$/.test(contract.gateId)) {
      finding(findings, 'INVALID_GATE_ID', '/gateId', contract.gateId, 'declared GATE00..GATE40', 'Contract gateId is invalid.', 'REQ-CTR-01');
    }
    if (typeof contract.contractRevision !== 'string' || !/^R[0-9]{4}$/.test(contract.contractRevision)) {
      finding(findings, 'INVALID_CONTRACT_REVISION', '/contractRevision', contract.contractRevision, 'Rxxxx', 'Contract revision is not versioned.', 'REQ-CTR-01');
    }
    const strategic = contract.strategicRegistryReference;
    if (strategic) {
      requireFields(strategic, ['registryPath', 'registrySha256', 'gateId', 'canonicalObjectiveSha256'], ['registryPath', 'registrySha256', 'gateId', 'canonicalObjectiveSha256'], findings, 'REQ-CTR-01', 'Strategic registry reference');
      if (contract.gateId && strategic.gateId !== contract.gateId) {
        finding(findings, 'CONTRACT_GATE_MISMATCH', '/strategicRegistryReference/gateId', strategic.gateId, contract.gateId, 'Strategic reference points to another gate.', 'REQ-CTR-01');
      }
      const strategicPath = resolveRepoPath(root, strategic.registryPath, findings, '/strategicRegistryReference/registryPath', 'REQ-CTR-01');
      if (strategicPath && fs.existsSync(strategicPath)) {
        const bytes = fs.readFileSync(strategicPath);
        if (sha256Bytes(bytes) !== strategic.registrySha256) {
          finding(findings, 'REGISTRY_HASH_MISMATCH', '/strategicRegistryReference/registrySha256', strategic.registrySha256, sha256Bytes(bytes), 'Registry hash is recalculated from real bytes.', 'REQ-CTR-01');
        }
      }
    }
    const budget = contract.performanceBudget;
    if (!budget || typeof budget !== 'object' || budget.absoluteMaximumMinutes > 480 || budget.expectedMaximumMinutes > budget.absoluteMaximumMinutes || budget.targetMinutes > budget.expectedMaximumMinutes) {
      finding(findings, 'UNBOUNDED_MISSION', '/performanceBudget', budget, 'target <= expectedMaximum <= absoluteMaximum <= 480', 'Performance budget is missing or unbounded.', 'REQ-CTR-01');
    }
    if (!Array.isArray(contract.authorizedPaths) || contract.authorizedPaths.some((entry) => !isSafeRelative(entry))) {
      finding(findings, 'UNAUTHORIZED_PATH_WRITE', '/authorizedPaths', contract.authorizedPaths, 'normalized relative paths', 'Contract contains an unsafe authorized path.', 'REQ-CTR-01');
    }
  }

  if (pointer) {
    requireFields(pointer, POINTER_FIELDS, POINTER_FIELDS, findings, 'REQ-CTR-02', 'CURRENT_CONTRACT pointer');
    if (pointer.contractPath && !/\/EXECUTION_CONTRACT_R[0-9]{4}\.json$/.test(pointer.contractPath)) {
      finding(findings, 'POINTER_TARGET_NOT_VERSIONED', '/contractPath', pointer.contractPath, '.../EXECUTION_CONTRACT_Rxxxx.json', 'CURRENT_CONTRACT does not target a versioned contract.', 'REQ-CTR-02');
    }
    if (contract && pointer.gateId !== contract.gateId) finding(findings, 'POINTER_TARGET_MISMATCH', '/gateId', pointer.gateId, contract.gateId, 'Pointer gateId differs from the contract.', 'REQ-CTR-02');
    if (contract && pointer.contractRevision !== contract.contractRevision) finding(findings, 'POINTER_TARGET_MISMATCH', '/contractRevision', pointer.contractRevision, contract.contractRevision, 'Pointer revision differs from the contract.', 'REQ-CTR-02');
    const target = resolveRepoPath(root, pointer.contractPath, findings, '/contractPath', 'REQ-CTR-02');
    if (target && (!fs.existsSync(target) || !fs.statSync(target).isFile())) {
      finding(findings, 'POINTER_TARGET_MISSING', '/contractPath', pointer.contractPath, 'existing versioned contract', 'CURRENT_CONTRACT target is absent.', 'REQ-CTR-02');
    } else if (target && fs.existsSync(target)) {
      const actual = sha256Bytes(fs.readFileSync(target));
      if (actual !== pointer.contractSha256) finding(findings, 'POINTER_HASH_MISMATCH', '/contractSha256', pointer.contractSha256, actual, 'Pointer hash equals target bytes.', 'REQ-CTR-02');
      const targetContract = readJson(target, findings, 'REQ-CTR-02');
      if (targetContract && contract && sha256Canonical(targetContract) !== sha256Canonical(contract)) finding(findings, 'CONTRACT_TARGET_DIVERGENCE', '/contractPath', pointer.contractPath, 'target bytes equal active contract', 'Pointer target and supplied contract differ.', 'REQ-CTR-02');
    }
    const duplicated = Object.keys(pointer).some((field) => CONTRACT_FIELDS.includes(field) && !POINTER_FIELDS.includes(field));
    if (duplicated) finding(findings, 'POINTER_CONTENT_DUPLICATION', '/', pointer, 'pointer fields only', 'CURRENT_CONTRACT duplicates contract content.', 'REQ-CTR-02');
  }

  if (contract?.strategicRegistryReference && registry) {
    const strategic = contract.strategicRegistryReference;
    const gate = (registry.gates || []).find((entry) => entry.gateId === contract.gateId);
    if (!gate) finding(findings, 'UNKNOWN_GATE_ID', '/gateId', contract.gateId, 'gate present in registry', 'Contract gate is absent from the registry.', 'REQ-CTR-01');
    else if (gate.canonicalObjective === null || gate.canonicalObjective === undefined) finding(findings, 'CONTRACT_STRATEGY_DIVERGENCE', '/strategicRegistryReference/canonicalObjectiveSha256', strategic.canonicalObjectiveSha256, 'hash of a documented canonicalObjective', 'Registry has no canonical objective to bind to this contract.', 'REQ-CTR-01');
    else if (sha256Canonical(gate.canonicalObjective) !== strategic.canonicalObjectiveSha256) finding(findings, 'CONTRACT_STRATEGY_DIVERGENCE', '/strategicRegistryReference/canonicalObjectiveSha256', strategic.canonicalObjectiveSha256, sha256Canonical(gate.canonicalObjective), 'Contract objective hash matches the current registry objective.', 'REQ-CTR-01');
  }

  if (contract && constitution) {
    const policyIds = new Set((constitution.rules || []).map((rule) => rule.ruleId));
    for (const policyId of contract.requiredPolicyIds || []) if (!policyIds.has(policyId)) finding(findings, 'UNKNOWN_POLICY_ID', '/requiredPolicyIds', policyId, 'ruleId declared by constitution', 'Contract references an unknown policy id.', 'REQ-CTR-01');
  }

  return {
    valid: findings.length === 0,
    blockingCount: findings.length,
    findings,
    contractPath,
    pointerPath
  };
}

export { validateContract };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const report = validateContract({
    root,
    contractPath: resolveOptionPath(root, option('--contract', path.join(root, 'governance/gates/GATE13/contracts/EXECUTION_CONTRACT_R0001.json'))),
    pointerPath: resolveOptionPath(root, option('--pointer', path.join(root, 'governance/gates/GATE13/contracts/CURRENT_CONTRACT.json'))),
    registryPath: resolveOptionPath(root, option('--registry', path.join(root, 'governance/GATE_REGISTRY_00_40.json'))),
    constitutionPath: resolveOptionPath(root, option('--constitution', path.join(root, 'governance/PROJECT_CONSTITUTION.json')))
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
