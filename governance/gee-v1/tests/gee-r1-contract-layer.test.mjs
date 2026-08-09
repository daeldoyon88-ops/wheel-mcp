import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStrategicContract } from '../contracts/validate-strategic-contract.mjs';
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { sealExecutionContract } from '../contracts/seal-execution-contract.mjs';
import { detectSealedMutation } from '../contracts/detect-sealed-mutation.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures');
const KNOWN = new Set(['R1_COMPLETE', 'R1_INCOMPLETE', 'R1_REPAIR_REQUIRED']);

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

test('POS: valid strategic + execution contracts accepted', () => {
  assert.equal(validateStrategicContract(read('valid-strategic-contract.json')).valid, true);
  assert.equal(validateExecutionContract(read('valid-execution-contract.json'), { knownVerdicts: KNOWN }).valid, true);
});

test('H01: missing objective -> strategic invalid and readiness BLOCKED', () => {
  const strategic = read('hostile-missing-objective.json');
  assert.equal(validateStrategicContract(strategic).valid, false);
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const result = evaluateReadiness({
    workUnitId: 'H01',
    strategicContract: strategic,
    executionContract: execution,
    executionSeal: sealed.seal,
    prerequisiteStatuses: { PREREQ_CORE: 'SATISFIED' }
  });
  assert.equal(result.verdict, 'BLOCKED');
});

test('H02: missing closure conditions -> BLOCKED', () => {
  const strategic = read('valid-strategic-contract.json');
  const execution = read('hostile-missing-closure.json');
  assert.equal(validateExecutionContract(execution).valid, false);
  const result = evaluateReadiness({
    workUnitId: 'H02',
    strategicContract: strategic,
    executionContract: execution,
    executionSeal: null,
    requireSeal: false,
    prerequisiteStatuses: {}
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'CLOSURE_CONDITIONS' && c.status === 'FAIL'));
});

test('H03: unsatisfied critical prerequisite -> BLOCKED', () => {
  const strategic = read('valid-strategic-contract.json');
  const execution = read('hostile-unsatisfied-prerequisite.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  assert.equal(sealed.sealed, true);
  const result = evaluateReadiness({
    workUnitId: 'H03',
    strategicContract: strategic,
    executionContract: execution,
    executionSeal: sealed.seal,
    prerequisiteStatuses: { MUST_EXIST: 'UNSATISFIED' }
  });
  assert.equal(result.verdict, 'BLOCKED');
});

test('H04: bad schema -> BLOCKED', () => {
  const bad = read('hostile-bad-schema.json');
  assert.equal(validateExecutionContract(bad).valid, false);
  const result = evaluateReadiness({
    workUnitId: 'H04',
    strategicContract: read('valid-strategic-contract.json'),
    executionContract: bad,
    requireSeal: false
  });
  assert.equal(result.verdict, 'BLOCKED');
});

test('unknown verdict rejected when known set provided', () => {
  const result = validateExecutionContract(read('hostile-unknown-verdict.json'), { knownVerdicts: KNOWN });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((f) => f.detectorId === 'UNKNOWN_VERDICT'));
});

test('invalid version rejected', () => {
  const result = validateExecutionContract(read('hostile-invalid-version.json'));
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((f) => f.detectorId === 'INVALID_VERSION'));
});

test('H05: valid contracts + satisfied prereqs + seal -> READY', () => {
  const strategic = read('valid-strategic-contract.json');
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const result = evaluateReadiness({
    workUnitId: 'H05',
    strategicContract: strategic,
    executionContract: execution,
    executionSeal: sealed.seal,
    prerequisiteStatuses: { PREREQ_CORE: 'SATISFIED' },
    authorityState: { consistent: true },
    preflightOk: true,
    defectsOpenCount: 0,
    defectsOpenKnowledge: 'KNOWN_ZERO'
  });
  assert.equal(result.verdict, 'READY');
  assert.equal(result.errors.length, 0);
});

test('H09: sealed contract mutation detected', () => {
  const execution = read('valid-execution-contract.json');
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  assert.equal(detectSealedMutation(execution, sealed.seal).status, 'INTACT');
  const mutated = structuredClone(execution);
  mutated.closureConditions = [...mutated.closureConditions, 'silent-extra-condition'];
  const detection = detectSealedMutation(mutated, sealed.seal);
  assert.equal(detection.status, 'MUTATED');
  assert.equal(detection.mutated, true);
});
