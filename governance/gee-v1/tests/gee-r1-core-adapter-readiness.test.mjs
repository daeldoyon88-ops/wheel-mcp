import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectSession, EXTENSION_POINTS, assertNoEngineImplementation } from '../core/index.mjs';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { createSyntheticAdapter } from '../fixtures/synthetic-non-wheel-adapter.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { sealExecutionContract } from '../contracts/seal-execution-contract.mjs';
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const CORE_PATH = path.join(HERE, '..', 'core', 'work-unit-core.mjs');

test('H06: core accepts unknown WORK_UNIT_ID via synthetic adapter without core modification', () => {
  const session = createProjectSession(createSyntheticAdapter());
  const view = session.getWorkUnit('WU_NEVER_HARDCODED_IN_CORE');
  assert.equal(view.projectId, 'SYNTHETIC_LAB');
  assert.equal(view.workUnitId, 'WU_NEVER_HARDCODED_IN_CORE');
  assert.equal(view.status, 'NOT_STARTED');
});

test('H07: Wheel adapter locates GATE13 as COMPLETE_CONFIRMED', () => {
  const session = createProjectSession(createWheelProjectAdapter(REPO_ROOT));
  const view = session.getWorkUnit('GATE13');
  assert.equal(view.projectId, 'WHEEL');
  assert.equal(view.workUnitType, 'GATE');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.sources.copiedAuthority, false);
  assert.ok(view.evidence.some((e) => e.kind === 'STATE_SEAL'));
});

test('historical COMPLETE_CONFIRMED gate (GATE12) visible through generic session', () => {
  const session = createProjectSession(createWheelProjectAdapter(REPO_ROOT));
  const view = session.getWorkUnit('GATE12');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
});

test('future/strategic-only GATE14 returns NOT_STARTED without core knowing gate numbers', () => {
  const session = createProjectSession(createWheelProjectAdapter(REPO_ROOT));
  const view = session.getWorkUnit('GATE14');
  assert.equal(view.status, 'NOT_STARTED');
  assert.equal(view.compatibility.legacyContractPresent, false);
});

// H08 replacement — RC-7 adapter-boundary repair (CT-F):
// OLD_TEST_ASSUMPTION: contract.compatibility / contract.sourcePath live on the canonical
//   execution-contract object returned by loadExecutionContract.
// WHY_INVALID: CT-F showed that shape makes the canonical object fail its own JSON Schema
//   (additionalProperties:false rejects /compatibility, /sourcePath, /sourceSha256) — the very
//   object handed to validateExecutionContract in the readiness path was invalid by construction.
// NEW_ARCHITECTURE_RULE: the canonical contract carries ONLY schema fields and always validates;
//   adapter provenance (sourceKind, sourcePath, sourceSha256, fidelity, mappingId) travels beside
//   it as getWorkUnitView(...).provenance / (contract, provenance) from map-gate-contract.mjs.
// NEW_TEST: assert the canonical contract is schema-valid AND provenance carries the same facts.
// EVIDENCE: 08_ADAPTER_BOUNDARY_MODEL.md (RUN_ROOT 20260808_145613), CT-F/CT-F2.
test('H08: legacy Wheel contract is interpreted, not migrated, and validates against its own schema', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const contract = adapter.loadExecutionContract('GATE13');
  assert.ok(contract);
  assert.equal(validateExecutionContract(contract).valid, true);
  assert.equal('compatibility' in contract, false);
  assert.equal('sourcePath' in contract, false);
  assert.equal('sourceSha256' in contract, false);

  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.provenance.sourceKind, 'LEGACY_MAPPED');
  assert.equal(view.provenance.fidelity, 'MAPPED');
  assert.equal(view.provenance.sourcePath, 'governance/gates/GATE13/contracts/EXECUTION_CONTRACT_R0001.json');
  const onDisk = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, view.provenance.sourcePath), 'utf8'));
  assert.equal(onDisk.gateId, 'GATE13');
  assert.ok(Array.isArray(onDisk.closureConditions));
});

test('H10: Wheel-specific tokens absent from generic core source', () => {
  const source = fs.readFileSync(CORE_PATH, 'utf8');
  for (const token of ['GATE13', 'GATE14', 'GATE15', 'TQQQ', 'SOXL', 'IBKR', 'wheelScanner', 'Cash Secured']) {
    assert.equal(source.includes(token), false, `core must not contain ${token}`);
  }
  assert.equal(source.includes('if gate13'), false);
});

test('extension points declared but engines not implemented', () => {
  assert.equal(EXTENSION_POINTS.contextCompilation.status, 'DECLARED_NOT_IMPLEMENTED');
  assert.equal(EXTENSION_POINTS.delta.status, 'DECLARED_NOT_IMPLEMENTED');
  assertNoEngineImplementation({});
});

test('Wheel GATE13 prerequisite resolves SATISFIED for GEE readiness input', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const resolved = adapter.resolvePrerequisite('GOVERNANCE_EXECUTION_EFFICIENCY_V1_R1', { id: 'GATE13', critical: true });
  assert.equal(resolved.status, 'SATISFIED');
  assert.equal(resolved.observedStatus, 'COMPLETE_CONFIRMED');
});

test('readiness rejects probably_ready style — only READY|BLOCKED', () => {
  const strategic = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'valid-strategic-contract.json'), 'utf8'));
  const execution = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'valid-execution-contract.json'), 'utf8'));
  const sealed = sealExecutionContract(execution, { sealedAt: '2026-08-08T00:00:00.000Z' });
  const result = evaluateReadiness({
    workUnitId: 'ENUM',
    strategicContract: strategic,
    executionContract: execution,
    executionSeal: sealed.seal,
    prerequisiteStatuses: { PREREQ_CORE: 'SATISFIED' },
    authorityState: { consistent: true },
    preflightOk: true
  });
  assert.ok(result.verdict === 'READY' || result.verdict === 'BLOCKED');
  assert.equal(['probably_ready', 'looks_good'].includes(result.verdict), false);
});
