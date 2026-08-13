import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateStrategicContract } from '../contracts/validate-strategic-contract.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { sealExecutionContract } from '../contracts/seal-execution-contract.mjs';
import { detectSealedMutation } from '../contracts/detect-sealed-mutation.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { resolveOpenDefectsKnowledge, resolveOpenDefectsKnowledgeFromJsonText } from '../contracts/validate-open-defects-knowledge.mjs';
import { createActivationAuthority } from '../contracts/activation-anchor.mjs';
import { validateActivationAnchor } from '../contracts/validate-activation-anchor.mjs';
import { writeSyntheticStateSealAuthority } from './helpers/synthetic-state-seal-authority.mjs';
import { sha256Bytes, sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateStateSeal } from '../../tools/validate-state-seal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const STRATEGIC_SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'work-unit-strategic-contract.schema.json'), 'utf8'));
const CLI = path.join(HERE, '..', 'tools', 'evaluate-work-unit-readiness.mjs');

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function baseReady(overrides = {}) {
  const strategic = read('valid-strategic-contract.json');
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  return {
    workUnitId: 'R1R2',
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

function stripMeta(input) {
  const { _execution, _sealed, ...ready } = input;
  return ready;
}

function writeMinimalGate(tmp, gateId, {
  sealPayload = { executionStatus: 'AUTHORIZED_NOT_STARTED' },
  sealWrapper = null,
  defects = undefined,
  defectsRaw = undefined,
  skipDefects = false,
  skipSeal = false
} = {}) {
  const rev = 'R0001';
  const gov = path.join(tmp, 'governance');
  fs.mkdirSync(path.join(gov, 'gates', gateId, 'state', 'revisions', rev), { recursive: true });
  fs.writeFileSync(path.join(gov, 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1,
    gates: [{ gateId, canonicalObjective: `${gateId} objective`, dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  fs.writeFileSync(path.join(gov, 'gates', gateId, 'state', 'CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1,
    gateId,
    stateRevision: rev,
    revisionPath: `governance/gates/${gateId}/state/revisions/${rev}`
  }, null, 2));
  if (!skipSeal) {
    const seal = sealWrapper || { schemaVersion: 1, payload: sealPayload };
    fs.writeFileSync(path.join(gov, 'gates', gateId, 'state', 'revisions', rev, 'STATE_SEAL.json'), JSON.stringify(seal, null, 2));
  }
  if (!skipDefects) {
    const body = defectsRaw !== undefined ? defectsRaw : JSON.stringify(defects !== undefined ? defects : { gateId, stateRevision: rev, defects: [] }, null, 2);
    fs.writeFileSync(path.join(gov, 'gates', gateId, 'state', 'revisions', rev, 'OPEN_DEFECTS.json'), body);
  }
  return { rev, gov };
}

function resealVerifiedOpenDefectsFixture(tmp, gateId) {
  const rev = 'R0001';
  const revRel = `governance/gates/${gateId}/state/revisions/${rev}`;
  const revDir = path.join(tmp, ...revRel.split('/'));
  const contractsDir = path.join(tmp, 'governance', 'gates', gateId, 'contracts');
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(contractsDir, { recursive: true });

  const checkpointPath = path.join(revDir, 'CHECKPOINT.json');
  const defectsPath = path.join(revDir, 'OPEN_DEFECTS.json');
  const currentContractPath = path.join(contractsDir, 'CURRENT_CONTRACT.json');
  const executionContractPath = path.join(contractsDir, 'EXECUTION_CONTRACT_R0001.json');
  const sealPath = path.join(revDir, 'STATE_SEAL.json');
  fs.writeFileSync(checkpointPath, JSON.stringify({
    gateId, stateRevision: rev, milestone: 'SEALED_OPEN_DEFECTS_FIXTURE', resumePoint: 'fixture',
    completedTasks: [], openTasks: [], reusableEvidence: [], invalidatedEvidence: [],
    requiredNextActions: [], protectedHashes: [], createdAt: '2026-08-08T00:00:00.000Z'
  }, null, 2));
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
  const payload = { executionStatus: 'AUTHORIZED_NOT_STARTED' };
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
  fs.writeFileSync(path.join(tmp, 'governance', 'gates', gateId, 'state', 'CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1, gateId, stateRevision: rev, revisionPath: revRel,
    stateSealSha256: sha256Bytes(fs.readFileSync(sealPath)), committedByTransactionId: `${gateId}-SEALED-FIXTURE`
  }, null, 2));
}

function buildActivatedAnchor(tmp, execution, seal) {
  const auth = createActivationAuthority({
    workUnitId: 'ACTIVATED_WU',
    executionContractId: execution.id,
    executionContractVersion: execution.version,
    expectedContractSha256: sha256Canonical(execution),
    expectedSealSha256: seal.sealSha256,
    activatedAt: '2026-08-08T00:00:00.000Z'
  });
  const synth = writeSyntheticStateSealAuthority(tmp, {
    gateId: 'GATE80',
    activationRecord: auth.record
  });
  return {
    activationState: 'ACTIVATED',
    activationAnchor: {
      record: auth.record,
      activationId: auth.activationId,
      authority: {
        kind: 'STATE_SEAL_MEMBER',
        repoRoot: tmp,
        sealPath: synth.sealPath,
        memberRepoRelativePath: synth.memberRepoRelativePath
      }
    },
    synth,
    auth
  };
}

// ----- R1R2-001 -----
test('H27: Strategic Contract additional property -> INVALID', () => {
  const bad = structuredClone(read('valid-strategic-contract.json'));
  bad.forbiddenExtra = true;
  assert.equal(validateAgainstJsonSchema(bad, STRATEGIC_SCHEMA).valid, false);
  assert.equal(validateStrategicContract(bad).valid, false);
  assert.equal(validateStrategicContract(bad).schemaValid, false);
});

test('H28: Strategic malformed prerequisite -> INVALID', () => {
  const bad = structuredClone(read('valid-strategic-contract.json'));
  bad.prerequisites = [{ id: 'ONLY_ID' }];
  assert.equal(validateAgainstJsonSchema(bad, STRATEGIC_SCHEMA).valid, false);
  assert.equal(validateStrategicContract(bad).valid, false);
});

test('H29: Strategic wrong type -> INVALID', () => {
  const bad = structuredClone(read('valid-strategic-contract.json'));
  bad.objective = 123;
  assert.equal(validateAgainstJsonSchema(bad, STRATEGIC_SCHEMA).valid, false);
  assert.equal(validateStrategicContract(bad).valid, false);
});

test('H30: Strategic canonical valid -> VALID', () => {
  const good = read('valid-strategic-contract.json');
  assert.equal(validateAgainstJsonSchema(good, STRATEGIC_SCHEMA).valid, true);
  assert.equal(validateStrategicContract(good).valid, true);
});

test('H31: Strategic schema-invalid in readiness -> BLOCKED', () => {
  const bad = structuredClone(read('valid-strategic-contract.json'));
  bad.sneaky = 'no';
  const result = evaluateReadiness(stripMeta(baseReady({ strategicContract: bad })));
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'STRATEGIC_CONTRACT' && c.status === 'FAIL'));
});

// ----- R1R2-002 -----
test('H32: no defectsOpenCount/knowledge -> BLOCKED', () => {
  const input = stripMeta(baseReady());
  delete input.defectsOpenCount;
  delete input.defectsOpenKnowledge;
  const result = evaluateReadiness(input);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'OPEN_DEFECTS' && c.status === 'FAIL'));
});

test('H33: knowledge=UNKNOWN -> BLOCKED', () => {
  const result = evaluateReadiness(stripMeta(baseReady({
    defectsOpenCount: null,
    defectsOpenKnowledge: 'UNKNOWN'
  })));
  assert.equal(result.verdict, 'BLOCKED');
});

test('H34: KNOWN_NONZERO -> BLOCKED', () => {
  const result = evaluateReadiness(stripMeta(baseReady({
    defectsOpenCount: 2,
    defectsOpenKnowledge: 'KNOWN_NONZERO'
  })));
  assert.equal(result.verdict, 'BLOCKED');
});

test('H35: KNOWN_ZERO -> PASS possible', () => {
  const result = evaluateReadiness(stripMeta(baseReady({
    defectsOpenCount: 0,
    defectsOpenKnowledge: 'KNOWN_ZERO'
  })));
  assert.equal(result.verdict, 'READY');
  assert.ok(result.checks.some((c) => c.id === 'OPEN_DEFECTS' && c.status === 'PASS'));
});

test('H36: CLI/tool receives adapter UNKNOWN -> BLOCKED', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h36-'));
  writeMinimalGate(tmp, 'GATE90', { skipDefects: true, sealWrapper: { schemaVersion: 1, payload: { executionStatus: 'AUTHORIZED_NOT_STARTED' } } });
  // Provide fixture contracts via CLI args to avoid needing full gate contract; use adapter work-unit for defects/authority
  const strategic = path.join(tmp, 'strategic.json');
  const execution = path.join(tmp, 'execution.json');
  fs.writeFileSync(strategic, JSON.stringify(read('valid-strategic-contract.json')));
  fs.writeFileSync(execution, JSON.stringify(read('valid-execution-contract.json')));
  const run = spawnSync(process.execPath, [
    CLI, '--root', tmp, '--work-unit', 'GATE90',
    '--strategic', strategic, '--execution', execution,
    '--no-require-seal', '--preflight-ok'
  ], { encoding: 'utf8' });
  const out = JSON.parse(run.stdout);
  assert.equal(out.verdict, 'BLOCKED');
  assert.ok(out.checks.some((c) => c.id === 'OPEN_DEFECTS' && c.status === 'FAIL'));
});

test('H37: CLI/tool receives adapter KNOWN_ZERO -> continues (not defects-blocked alone)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h37-'));
  // Use real GATE13 tree copied? Too heavy. Build a valid sealed empty OPEN_DEFECTS state;
  // the readiness run may still block for unrelated authority reasons, but OPEN_DEFECTS must PASS.
  writeMinimalGate(tmp, 'GATE91', {
    defects: { gateId: 'GATE91', stateRevision: 'R0001', defects: [] },
    skipSeal: true
  });
  resealVerifiedOpenDefectsFixture(tmp, 'GATE91');
  const strategic = path.join(tmp, 'strategic.json');
  const execution = path.join(tmp, 'execution.json');
  fs.writeFileSync(strategic, JSON.stringify(read('valid-strategic-contract.json')));
  fs.writeFileSync(execution, JSON.stringify(read('valid-execution-contract.json')));
  const run = spawnSync(process.execPath, [
    CLI, '--root', tmp, '--work-unit', 'GATE91',
    '--strategic', strategic, '--execution', execution,
    '--no-require-seal', '--preflight-ok'
  ], { encoding: 'utf8' });
  const out = JSON.parse(run.stdout);
  assert.ok(out.checks.some((c) => c.id === 'OPEN_DEFECTS' && c.status === 'PASS'));
});

// ----- R1R2-003 -----
test('H38: OPEN_DEFECTS file absent -> UNKNOWN', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h38-'));
  writeMinimalGate(tmp, 'GATE92', { skipDefects: true });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE92');
  assert.equal(view.defectsOpenKnowledge, 'UNKNOWN');
  assert.equal(view.defectsOpenCount, null);
});

test('H39: OPEN_DEFECTS JSON broken -> UNKNOWN', () => {
  assert.equal(resolveOpenDefectsKnowledgeFromJsonText('{not-json').defectsOpenKnowledge, 'UNKNOWN');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h39-'));
  writeMinimalGate(tmp, 'GATE93', { defectsRaw: '{broken' });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE93');
  assert.equal(view.defectsOpenKnowledge, 'UNKNOWN');
});

test('H40: object without defects -> UNKNOWN', () => {
  const r = resolveOpenDefectsKnowledge({ schemaVersion: 1, notDefects: 'oops' });
  assert.equal(r.defectsOpenKnowledge, 'UNKNOWN');
  assert.equal(r.defectsOpenCount, null);
});

test('H41: defects wrong type -> UNKNOWN', () => {
  const r = resolveOpenDefectsKnowledge({ defects: 'nope' });
  assert.equal(r.defectsOpenKnowledge, 'UNKNOWN');
});

test('H42: valid empty list -> KNOWN_ZERO', () => {
  const r = resolveOpenDefectsKnowledge({ gateId: 'GATE13', stateRevision: 'R0001', defects: [] });
  assert.equal(r.defectsOpenKnowledge, 'KNOWN_ZERO');
  assert.equal(r.defectsOpenCount, 0);
});

test('H43: valid with 2 OPEN -> KNOWN_NONZERO count=2', () => {
  const r = resolveOpenDefectsKnowledge({
    defects: [
      { status: 'OPEN' },
      { status: 'IN_REPAIR' },
      { status: 'CLOSED' }
    ]
  });
  assert.equal(r.defectsOpenKnowledge, 'KNOWN_NONZERO');
  assert.equal(r.defectsOpenCount, 2);
});

test('H44: invalid defects file to readiness -> BLOCKED', () => {
  const result = evaluateReadiness(stripMeta(baseReady({
    defectsOpenCount: null,
    defectsOpenKnowledge: 'UNKNOWN'
  })));
  assert.equal(result.verdict, 'BLOCKED');
});

// ----- R1R2-004 -----
test('H45: STATE_SEAL schema-invalid -> authority UNKNOWN/INVALID', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h45-'));
  writeMinimalGate(tmp, 'GATE94', {
    sealWrapper: { schemaVersion: 999, payload: { executionStatus: 'COMPLETE_CONFIRMED' } },
    defects: { gateId: 'GATE94', stateRevision: 'R0001', defects: [] }
  });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE94');
  assert.notEqual(view.status, 'COMPLETE_CONFIRMED');
  assert.ok(view.status === 'UNVERIFIED' || view.status === 'UNKNOWN');
  assert.equal(view.authorityState.consistent, false);
  assert.equal(view.authorityState.sealValid, false);
});

test('H46: STATE_SEAL fake executionStatus never COMPLETE_CONFIRMED', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h46-'));
  writeMinimalGate(tmp, 'GATE95', {
    sealWrapper: { schemaVersion: 1, payload: { executionStatus: 'COMPLETE_CONFIRMED' } }
  });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE95');
  assert.notEqual(view.status, 'COMPLETE_CONFIRMED');
});

test('H47: STATE_SEAL hash/tamper invalid -> authority rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h47-'));
  const auth = createActivationAuthority({
    workUnitId: 'X',
    executionContractId: 'X',
    executionContractVersion: 'R0001',
    expectedContractSha256: 'a'.repeat(64),
    expectedSealSha256: 'b'.repeat(64),
    activatedAt: '2026-08-08T00:00:00.000Z'
  });
  const synth = writeSyntheticStateSealAuthority(tmp, { gateId: 'GATE96', activationRecord: auth.record });
  // Tamper CHECKPOINT after sealing
  fs.appendFileSync(path.join(tmp, synth.sealPath.replace('STATE_SEAL.json', 'CHECKPOINT.json')), '\n');
  const report = validateStateSeal({ root: tmp, sealPath: path.join(tmp, synth.sealPath) });
  assert.equal(report.valid, false);

  // Wire CURRENT_STATE to this tampered seal for adapter
  fs.writeFileSync(path.join(tmp, 'governance', 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1,
    gates: [{ gateId: 'GATE96', canonicalObjective: 'tamper', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  fs.mkdirSync(path.join(tmp, 'governance', 'gates', 'GATE96', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance', 'gates', 'GATE96', 'state', 'CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1,
    gateId: 'GATE96',
    stateRevision: 'R0001',
    revisionPath: 'governance/gates/GATE96/state/revisions/R0001'
  }, null, 2));
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE96');
  assert.notEqual(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.authorityState.sealValid, false);
});

test('H48: STATE_SEAL valide historique GATE13 -> état réel accepté', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.authorityState.consistent, true);
  assert.equal(view.authorityState.sealValid, true);
  const sealReport = validateStateSeal({
    root: REPO_ROOT,
    sealPath: path.join(REPO_ROOT, 'governance/gates/GATE13/state/revisions/R0002/STATE_SEAL.json')
  });
  assert.equal(sealReport.valid, true);
});

test('H49: workUnitId résolu but authority not proven -> consistent != true', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h49-'));
  writeMinimalGate(tmp, 'GATE97', {
    sealWrapper: { schemaVersion: 1, payload: { executionStatus: 'COMPLETE_CONFIRMED' } }
  });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE97');
  assert.ok(view.workUnitId === 'GATE97');
  assert.notEqual(view.authorityState.consistent, true);
});

test('H50: readiness with invalid authority seal -> BLOCKED', () => {
  const result = evaluateReadiness(stripMeta(baseReady({
    authorityState: { consistent: false, reason: 'state-seal-invalid' }
  })));
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'AUTHORITY_STATE' && c.status === 'FAIL'));
});

// ----- R1R2-005 -----
test('H51: activated unchanged contract+seal+valid anchor -> INTACT', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h51-'));
  const { activationState, activationAnchor } = buildActivatedAnchor(tmp, execution, sealed.seal);
  const detection = detectSealedMutation(execution, sealed.seal, { activationState, activationAnchor });
  assert.equal(detection.status, 'INTACT');
  const result = evaluateReadiness(stripMeta(baseReady({
    executionContract: execution,
    executionSeal: sealed.seal,
    activationState,
    activationAnchor
  })));
  assert.equal(result.verdict, 'READY');
  assert.ok(result.checks.some((c) => c.id === 'ACTIVATION_ANCHOR' && c.status === 'PASS'));
});

test('H52: contract modified alone -> BLOCKED', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h52-'));
  const { activationState, activationAnchor } = buildActivatedAnchor(tmp, execution, sealed.seal);
  const mutated = structuredClone(execution);
  mutated.objective = `${mutated.objective} CHANGED`;
  const detection = detectSealedMutation(mutated, sealed.seal, { activationState, activationAnchor });
  assert.notEqual(detection.status, 'INTACT');
  const result = evaluateReadiness(stripMeta(baseReady({
    executionContract: mutated,
    executionSeal: sealed.seal,
    activationState,
    activationAnchor,
    requireSeal: true
  })));
  assert.equal(result.verdict, 'BLOCKED');
});

test('H53: seal modified alone -> BLOCKED', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h53-'));
  const { activationState, activationAnchor } = buildActivatedAnchor(tmp, execution, sealed.seal);
  const seal2 = structuredClone(sealed.seal);
  seal2.sealSha256 = 'f'.repeat(64);
  const detection = detectSealedMutation(execution, seal2, { activationState, activationAnchor });
  assert.notEqual(detection.status, 'INTACT');
  assert.equal(evaluateReadiness(stripMeta(baseReady({
    executionContract: execution,
    executionSeal: seal2,
    activationState,
    activationAnchor
  }))).verdict, 'BLOCKED');
});

test('H54: coordinated reseal with historical anchor unchanged -> BLOCKED', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h54-'));
  const { activationState, activationAnchor } = buildActivatedAnchor(tmp, execution, sealed.seal);
  const contract2 = structuredClone(execution);
  contract2.objective = `${contract2.objective} RESEAL`;
  const resealed = sealExecutionContract(contract2, { sealedAt: '2026-08-08T12:00:00.000Z' });
  // Internal seal self-consistent:
  assert.equal(detectSealedMutation(contract2, resealed.seal).status, 'INTACT');
  // With historical anchor:
  const detection = detectSealedMutation(contract2, resealed.seal, { activationState, activationAnchor });
  assert.ok(['RESEALED_AFTER_ACTIVATION', 'ANCHOR_MISMATCH'].includes(detection.status));
  const result = evaluateReadiness(stripMeta(baseReady({
    executionContract: contract2,
    executionSeal: resealed.seal,
    activationState,
    activationAnchor
  })));
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'ACTIVATION_ANCHOR' && c.status === 'FAIL'));
});

test('H55: fake local anchor rewrite without historical authority -> cannot bypass', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const contract2 = structuredClone(execution);
  contract2.objective = `${contract2.objective} FAKE`;
  const resealed = sealExecutionContract(contract2, { sealedAt: '2026-08-08T12:00:00.000Z' });
  const fake = createActivationAuthority({
    workUnitId: 'ACTIVATED_WU',
    executionContractId: contract2.id,
    executionContractVersion: contract2.version,
    expectedContractSha256: sha256Canonical(contract2),
    expectedSealSha256: resealed.seal.sealSha256,
    activatedAt: '2026-08-08T12:00:00.000Z'
  });
  const localOnly = {
    record: fake.record,
    activationId: fake.activationId,
    authority: { kind: 'LOCAL_SIDECAR', path: 'activation-anchor.json' }
  };
  const anchor = validateActivationAnchor({
    contract: contract2,
    seal: resealed.seal,
    activationState: 'ACTIVATED',
    activationAnchor: localOnly
  });
  assert.notEqual(anchor.status, 'INTACT');
  assert.ok(anchor.findings.includes('ACTIVATION_AUTHORITY_KIND_REJECTED') || anchor.status === 'ANCHOR_INVALID');
  assert.equal(evaluateReadiness(stripMeta(baseReady({
    executionContract: contract2,
    executionSeal: resealed.seal,
    activationState: 'ACTIVATED',
    activationAnchor: localOnly
  }))).verdict, 'BLOCKED');
});

test('H56: anchor absent when activation requires freeze -> BLOCKED', () => {
  const result = evaluateReadiness(stripMeta(baseReady({
    activationState: 'ACTIVATED'
    // no activationAnchor
  })));
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'ACTIVATION_ANCHOR' && c.status === 'FAIL'));
});

test('H57: anchor invalid/tampered -> BLOCKED', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-h57-'));
  const built = buildActivatedAnchor(tmp, execution, sealed.seal);
  // Tamper activation id
  built.activationAnchor.activationId = '0'.repeat(64);
  assert.equal(evaluateReadiness(stripMeta(baseReady({
    executionContract: execution,
    executionSeal: sealed.seal,
    activationState: built.activationState,
    activationAnchor: built.activationAnchor
  }))).verdict, 'BLOCKED');
});

test('H58: work unit not yet activated -> explicit not sealed-activated', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const detection = detectSealedMutation(execution, sealed.seal);
  assert.equal(detection.status, 'INTACT');
  const result = evaluateReadiness(stripMeta(baseReady({
    executionContract: execution,
    executionSeal: sealed.seal
  })));
  assert.equal(result.verdict, 'READY');
  const anchorCheck = result.checks.find((c) => c.id === 'ACTIVATION_ANCHOR');
  assert.equal(anchorCheck.status, 'SKIP');
});

test('H59: historical artifact without activation invariant -> no false reject', () => {
  const result = evaluateReadiness(stripMeta(baseReady()));
  assert.equal(result.verdict, 'READY');
  assert.ok(result.checks.some((c) => c.id === 'ACTIVATION_ANCHOR' && c.status === 'SKIP'));
});

// Missing-argument hostility (critical readiness inputs)
test('hostile missing: authority absent not more permissive than UNKNOWN', () => {
  const input = stripMeta(baseReady());
  delete input.authorityState;
  assert.equal(evaluateReadiness(input).verdict, 'BLOCKED');
});

test('hostile missing: preflight absent not more permissive than UNKNOWN', () => {
  const input = stripMeta(baseReady());
  delete input.preflightOk;
  assert.equal(evaluateReadiness(input).verdict, 'BLOCKED');
});

test('hostile missing: seal absent when required', () => {
  const input = stripMeta(baseReady({ requireSeal: true }));
  delete input.executionSeal;
  assert.equal(evaluateReadiness(input).verdict, 'BLOCKED');
});

test('hostile missing: activationAnchor absent when ACTIVATED', () => {
  const input = stripMeta(baseReady({ activationState: 'ACTIVATED' }));
  delete input.activationAnchor;
  assert.equal(evaluateReadiness(input).verdict, 'BLOCKED');
});
