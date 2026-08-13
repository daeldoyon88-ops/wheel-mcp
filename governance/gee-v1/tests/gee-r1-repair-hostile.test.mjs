import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { sealExecutionContract } from '../contracts/seal-execution-contract.mjs';
import { detectSealedMutation } from '../contracts/detect-sealed-mutation.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { canonicalize, sha256Bytes, sha256Canonical } from '../../tools/canonical-json.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'work-unit-execution-contract.schema.json'), 'utf8'));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function baseReadyInput(overrides = {}) {
  const strategic = read('valid-strategic-contract.json');
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  return {
    workUnitId: 'REPAIR',
    strategicContract: strategic,
    executionContract: execution,
    executionSeal: sealed.seal,
    prerequisiteStatuses: { PREREQ_CORE: 'SATISFIED' },
    authorityState: { consistent: true },
    preflightOk: true,
    defectsOpenCount: 0,
    defectsOpenKnowledge: 'KNOWN_ZERO',
    ...overrides,
    _execution: execution,
    _sealed: sealed
  };
}

function writeSealedOpenDefectsFixture(tmp, gateId, defects) {
  const rev = 'R0001';
  const gateRoot = path.join(tmp, 'governance', 'gates', gateId);
  const revRel = `governance/gates/${gateId}/state/revisions/${rev}`;
  const revDir = path.join(tmp, ...revRel.split('/'));
  const contractsDir = path.join(gateRoot, 'contracts');
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(contractsDir, { recursive: true });

  fs.writeFileSync(path.join(tmp, 'governance', 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1,
    gates: [{ gateId, canonicalObjective: `${gateId} sealed defects fixture`, dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));

  const checkpointPath = path.join(revDir, 'CHECKPOINT.json');
  const defectsPath = path.join(revDir, 'OPEN_DEFECTS.json');
  const currentContractPath = path.join(contractsDir, 'CURRENT_CONTRACT.json');
  const executionContractPath = path.join(contractsDir, 'EXECUTION_CONTRACT_R0001.json');
  const currentStatePath = path.join(gateRoot, 'state', 'CURRENT_STATE.json');
  const sealPath = path.join(revDir, 'STATE_SEAL.json');

  fs.writeFileSync(checkpointPath, JSON.stringify({
    gateId, stateRevision: rev, milestone: 'SEALED_OPEN_DEFECTS_FIXTURE', resumePoint: 'fixture',
    completedTasks: [], openTasks: [], reusableEvidence: [], invalidatedEvidence: [],
    requiredNextActions: [], protectedHashes: [], createdAt: '2026-08-08T00:00:00.000Z'
  }, null, 2));
  fs.writeFileSync(defectsPath, JSON.stringify({ gateId, stateRevision: rev, defects }, null, 2));
  fs.writeFileSync(currentContractPath, JSON.stringify({
    schemaVersion: 1, gateId, contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`
  }, null, 2));
  fs.writeFileSync(executionContractPath, JSON.stringify({
    gateId, contractRevision: rev, positiveTests: ['fixture'], negativeTests: ['fixture'], countertests: ['fixture'],
    canonicalRequirements: [{ requirementId: 'SEALED_OPEN_DEFECTS' }], requiredOutputs: [],
    closureConditions: ['fixture'], authorizedPaths: [`governance/gates/${gateId}/**`]
  }, null, 2));

  const member = (repoRelativePath, absolutePath) => {
    const bytes = fs.readFileSync(absolutePath);
    return { repoRelativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
  };
  const payload = { gateId, stateRevision: rev, executionStatus: 'AUTHORIZED_NOT_STARTED', purpose: 'SEALED_OPEN_DEFECTS_FIXTURE' };
  fs.writeFileSync(sealPath, JSON.stringify({
    schemaVersion: 1, gateId, stateRevision: rev,
    sealedMembers: [
      member(`${revRel}/CHECKPOINT.json`, checkpointPath),
      member(`${revRel}/OPEN_DEFECTS.json`, defectsPath),
      member(`governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`, currentContractPath)
    ],
    previousStateSealSha256: null, sealedAt: '2026-08-08T00:00:00.000Z', payload,
    payloadSha256: sha256Canonical(payload)
  }, null, 2));
  fs.writeFileSync(currentStatePath, JSON.stringify({
    schemaVersion: 1, gateId, stateRevision: rev, revisionPath: revRel,
    stateSealSha256: sha256Bytes(fs.readFileSync(sealPath)), committedByTransactionId: `${gateId}-SEALED-FIXTURE`
  }, null, 2));
}

test('H11: authorityState absent -> BLOCKED', () => {
  const input = baseReadyInput();
  delete input.authorityState;
  const { _execution, _sealed, ...ready } = input;
  const result = evaluateReadiness(ready);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'AUTHORITY_STATE' && c.status === 'FAIL'));
});

test('H12: authorityState inconsistent/unknown -> BLOCKED', () => {
  const { _execution, _sealed, ...ready } = baseReadyInput({
    authorityState: { consistent: false, reason: 'ledger/registry conflict' }
  });
  const result = evaluateReadiness(ready);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'AUTHORITY_STATE' && c.status === 'FAIL'));

  const unknown = evaluateReadiness({
    ...ready,
    authorityState: { consistent: 'maybe' }
  });
  assert.equal(unknown.verdict, 'BLOCKED');
});

test('H13: preflight absent -> BLOCKED', () => {
  const input = baseReadyInput();
  delete input.preflightOk;
  const { _execution, _sealed, ...ready } = input;
  const result = evaluateReadiness(ready);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'PREFLIGHT' && c.status === 'FAIL'));
});

test('H14: preflight false -> BLOCKED', () => {
  const { _execution, _sealed, ...ready } = baseReadyInput({ preflightOk: false });
  const result = evaluateReadiness(ready);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'PREFLIGHT' && c.status === 'FAIL'));
});

test('H15: preflight explicit true + authority valid -> may continue READY', () => {
  const { _execution, _sealed, ...ready } = baseReadyInput({
    authorityState: { consistent: true },
    preflightOk: true
  });
  const result = evaluateReadiness(ready);
  assert.equal(result.verdict, 'READY');
  assert.ok(result.checks.some((c) => c.id === 'AUTHORITY_STATE' && c.status === 'PASS'));
  assert.ok(result.checks.some((c) => c.id === 'PREFLIGHT' && c.status === 'PASS'));
});

test('H16: contract + seal payload falsified together -> NOT INTACT', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const contract2 = structuredClone(execution);
  contract2.objective = `${contract2.objective} TAMPER`;
  const seal2 = structuredClone(sealed.seal);
  seal2.payload.contractSha256 = sha256Canonical(contract2);
  seal2.payload.closureConditionsSha256 = sha256Canonical(contract2.closureConditions);
  seal2.payload.authorizedVerdictsSha256 = sha256Canonical(contract2.authorizedVerdicts);
  // stale payloadSha256 + sealSha256 intentionally retained
  const detection = detectSealedMutation(contract2, seal2);
  assert.notEqual(detection.status, 'INTACT');
  assert.equal(detection.mutated, true);
  assert.ok(detection.findings.includes('PAYLOAD_SHA256_MISMATCH') || detection.findings.includes('SEAL_SHA256_MISMATCH'));
});

test('H17: payloadSha256 falsified -> NOT INTACT', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const seal2 = structuredClone(sealed.seal);
  seal2.payloadSha256 = '0'.repeat(64);
  // Keep sealSha256 matching the falsified body so only payload integrity fails first...
  // Actually detector checks payloadSha vs payload content first; sealSha may also fail.
  const detection = detectSealedMutation(execution, seal2);
  assert.notEqual(detection.status, 'INTACT');
  assert.ok(detection.findings.includes('PAYLOAD_SHA256_MISMATCH'));
});

test('H18: sealSha256 falsified -> NOT INTACT', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const seal2 = structuredClone(sealed.seal);
  seal2.sealSha256 = 'f'.repeat(64);
  const detection = detectSealedMutation(execution, seal2);
  assert.notEqual(detection.status, 'INTACT');
  assert.ok(detection.findings.includes('SEAL_SHA256_MISMATCH'));
});

test('H19: schema-invalid closureConditions -> INVALID/BLOCKED', () => {
  const bad = structuredClone(read('valid-execution-contract.json'));
  bad.closureConditions = [123];
  const schema = validateAgainstJsonSchema(bad, SCHEMA);
  const layer = validateExecutionContract(bad);
  assert.equal(schema.valid, false);
  assert.equal(layer.valid, false);
  assert.equal(layer.schemaValid, false);
  const result = evaluateReadiness({
    workUnitId: 'H19',
    strategicContract: read('valid-strategic-contract.json'),
    executionContract: bad,
    requireSeal: false,
    authorityState: { consistent: true },
    preflightOk: true
  });
  assert.equal(result.verdict, 'BLOCKED');
});

test('H20: schema-invalid authorizedPaths -> INVALID/BLOCKED', () => {
  const bad = structuredClone(read('valid-execution-contract.json'));
  bad.authorizedPaths = [null];
  assert.equal(validateAgainstJsonSchema(bad, SCHEMA).valid, false);
  assert.equal(validateExecutionContract(bad).valid, false);
  const result = evaluateReadiness({
    workUnitId: 'H20',
    strategicContract: read('valid-strategic-contract.json'),
    executionContract: bad,
    requireSeal: false,
    authorityState: { consistent: true },
    preflightOk: true
  });
  assert.equal(result.verdict, 'BLOCKED');
});

test('H21: extra property forbidden by schema -> INVALID/BLOCKED', () => {
  const bad = structuredClone(read('valid-execution-contract.json'));
  bad.sneakyExtra = 'nope';
  assert.equal(validateAgainstJsonSchema(bad, SCHEMA).valid, false);
  assert.equal(validateExecutionContract(bad).valid, false);
});

test('H22: future GATE41 present in fixture registry -> recognized without core change', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r1r1-h22-'));
  const gov = path.join(tmp, 'governance');
  fs.mkdirSync(gov, { recursive: true });
  fs.writeFileSync(path.join(gov, 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1,
    gates: [
      { gateId: 'GATE13', canonicalObjective: 'past', dependencies: [], definitionCompleteness: 'COMPLETE' },
      { gateId: 'GATE41', canonicalObjective: 'future fixture', dependencies: ['GATE13'], definitionCompleteness: 'PARTIAL' }
    ]
  }, null, 2));
  // Provide GATE13 COMPLETE via minimal state tree so GATE41 dep can be evaluated if needed
  const adapter = createWheelProjectAdapter(tmp);
  const resolved = adapter.resolvePrerequisite('GATE41', { id: 'GATE41', critical: true });
  assert.notEqual(resolved.status, 'UNKNOWN');
  assert.ok(resolved.status === 'SATISFIED' || resolved.status === 'UNSATISFIED');
  assert.equal(resolved.observedStatus === 'NOT_STARTED' || resolved.observedStatus === 'UNKNOWN' || typeof resolved.observedStatus === 'string', true);
  // Core source must remain free of GATE41 hardcoding for this feature
  const core = fs.readFileSync(path.join(HERE, '..', 'core', 'work-unit-core.mjs'), 'utf8');
  assert.equal(core.includes('GATE41'), false);
  assert.equal(fs.readFileSync(path.join(HERE, '..', 'adapters', 'wheel', 'wheel-project-adapter.mjs'), 'utf8').includes('GATE(0[0-9]|[1-3][0-9]|40)'), false);
});

test('H23: work unit absent from registry -> UNKNOWN', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const resolved = adapter.resolvePrerequisite('X', { id: 'GATE99', critical: true });
  assert.equal(resolved.status, 'UNKNOWN');
  assert.ok(resolved.reason === 'WORK_UNIT_NOT_IN_REGISTRY' || resolved.reason);
});

test('H24: OPEN_DEFECTS absent -> UNKNOWN, never zero', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r1r1-h24-'));
  const gov = path.join(tmp, 'governance');
  fs.mkdirSync(gov, { recursive: true });
  fs.writeFileSync(path.join(gov, 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1,
    gates: [{ gateId: 'GATE50', canonicalObjective: 'defects unknown', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  // Create stateRevision but omit OPEN_DEFECTS.json
  const rev = 'R0001';
  const gateDir = path.join(gov, 'gates', 'GATE50', 'state');
  fs.mkdirSync(path.join(gateDir, 'revisions', rev), { recursive: true });
  fs.writeFileSync(path.join(gateDir, 'CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1,
    gateId: 'GATE50',
    stateRevision: rev,
    revisionPath: `governance/gates/GATE50/state/revisions/${rev}`
  }, null, 2));
  fs.writeFileSync(path.join(gateDir, 'revisions', rev, 'STATE_SEAL.json'), JSON.stringify({
    schemaVersion: 1,
    payload: { executionStatus: 'AUTHORIZED_NOT_STARTED' }
  }, null, 2));

  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView('GATE50');
  assert.equal(view.defectsOpenKnowledge, 'UNKNOWN');
  assert.equal(view.defectsOpenCount, null);
  assert.notEqual(view.defectsOpenCount, 0);
});

test('H25: OPEN_DEFECTS present empty -> KNOWN ZERO', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r1r1-h25-'));
  writeSealedOpenDefectsFixture(tmp, 'GATE51', []);

  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE51');
  assert.equal(view.defectsOpenKnowledge, 'KNOWN_ZERO');
  assert.equal(view.defectsOpenCount, 0);
});

test('H26: OPEN_DEFECTS present with defects -> real count', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r1r1-h26-'));
  writeSealedOpenDefectsFixture(tmp, 'GATE52', [
    { id: 'D1', status: 'OPEN' },
    { id: 'D2', status: 'IN_REPAIR' },
    { id: 'D3', status: 'CLOSED' }
  ]);

  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE52');
  assert.equal(view.defectsOpenKnowledge, 'KNOWN_NONZERO');
  assert.equal(view.defectsOpenCount, 2);
});

test('extra: truncated seal -> SEAL_INVALID not INTACT', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const truncated = { schemaVersion: 1, sealKind: 'EXECUTION_CONTRACT_SEAL' };
  const detection = detectSealedMutation(execution, truncated);
  assert.equal(detection.status, 'SEAL_INVALID');
  assert.notEqual(detection.status, 'INTACT');
});

test('extra: valid seal unchanged still INTACT', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  assert.equal(detectSealedMutation(execution, sealed.seal).status, 'INTACT');
});

test('extra: authorizedVerdicts wrong type INVALID', () => {
  const bad = structuredClone(read('valid-execution-contract.json'));
  bad.authorizedVerdicts = [42];
  assert.equal(validateExecutionContract(bad).valid, false);
});

test('extra: invalid prerequisite shape INVALID', () => {
  const bad = structuredClone(read('valid-execution-contract.json'));
  bad.prerequisites = [{ id: 'X' }];
  assert.equal(validateExecutionContract(bad).valid, false);
});

test('extra: readiness UNKNOWN defects -> BLOCKED', () => {
  const { _execution, _sealed, ...ready } = baseReadyInput({
    defectsOpenCount: null,
    defectsOpenKnowledge: 'UNKNOWN'
  });
  const result = evaluateReadiness(ready);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'OPEN_DEFECTS' && c.status === 'FAIL'));
});

// silence unused import lint for createHash in environments that tree-shake
void createHash;
void canonicalize;
