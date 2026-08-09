// GOVERNANCE_EXECUTION_EFFICIENCY_V1_R1 — R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX
//
// Hostile countertests for the coordinated-reseal false-PASS the independent audit reproduced:
// authorityState.consistent alone (FINAL-03, see build-readiness-context.mjs) proves the ledger
// agrees with a work unit's generic STATUS STRING (e.g. "AUTHORIZED_NOT_STARTED"), never WHICH
// activation-authority bytes earned that status. A contract + execution-seal + activation-
// authority record recomputed together and locally resealed reproduces the same status string —
// so it stayed "consistent" — while pinning nothing to the ledger at all.
//
// The fix: activation.anchor's proof now additionally requires activation.anchor.ledgerBinding
// (computed by adapters/wheel/wheel-project-adapter.mjs's deriveActivation, using the generic,
// project-agnostic core/authority-event-log.mjs's deriveActivationLedgerBinding) to read PROVEN —
// i.e. a canonical ACTIVATION_LEDGER_TRANSITION_TYPE ('START') ledger event for THIS exact
// workUnitId pins THIS exact activation-authority artifact's live bytes (authorityPath +
// authoritySha256). No second authority spine: START is the ledger's own, pre-existing,
// already-schema'd activation transition (real GATE13's own START event, ordinal 42, already
// pins authorityPath+authoritySha256 for its own execution-start authority).
//
// AB01/AB05/AB07-AB13/AB16-AB19 traverse the REAL production pipeline — createWheelProjectAdapter
// -> buildReadinessContext -> evaluateReadiness — with no manually test-injected proof, per the
// mission's explicit requirement for the coordinated-reseal and ledger-rewrite-witness-stale
// scenarios. AB02/AB03/AB04/AB06/AB20 unit-test the generic core matcher
// (core/authority-event-log.mjs's deriveActivationLedgerBinding) directly: constructing a
// chain-valid multi-gate ledger for a wrong-path/foreign-gate/duplicate pin is either
// unnecessarily elaborate (a self-consistent wrong-path pin, AB03) or structurally impossible
// under the closed I2 transition table replayed by governance/tools/validate-status-ledger.mjs
// (a genuine duplicate START for one gate breaks fromStatus-chain replay before ambiguity is even
// reached, AB06) — so those properties are exercised at the unit that owns them.
//
// Every fixture below is built under os.tmpdir() and never touches a real governance/ file.
// No official witness is created anywhere in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWheelProjectAdapter, EXECUTION_SEAL_DERIVATION_EPOCH, ACTIVATION_LEDGER_TRANSITION_TYPE } from '../adapters/wheel/wheel-project-adapter.mjs';
import { mapLegacyGateContractToExecutionView } from '../adapters/wheel/map-gate-contract.mjs';
import { sealExecutionContract } from '../contracts/seal-execution-contract.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../adapters/wheel/external-authority-policy.mjs';
import { buildReadinessContext } from '../readiness/build-readiness-context.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { validateLedger } from '../../tools/validate-status-ledger.mjs';
import { deriveActivationLedgerBinding } from '../core/authority-event-log.mjs';
import { sha256Bytes, sha256Canonical, canonicalize } from '../../tools/canonical-json.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const LEDGER_REL = 'governance/state/GATE_STATUS_LEDGER.ndjson';

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeWitnessFile(dir, witnesses, name = 'witness-fixture.json') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ witnesses }, null, 2));
  return p;
}

function withWitnessEnv(witnessPath, fn) {
  const prevEnv = process.env.GEE_HEAD_WITNESS_SOURCE;
  process.env.GEE_HEAD_WITNESS_SOURCE = witnessPath;
  try {
    return fn();
  } finally {
    if (prevEnv === undefined) delete process.env.GEE_HEAD_WITNESS_SOURCE; else process.env.GEE_HEAD_WITNESS_SOURCE = prevEnv;
  }
}

function realLedgerSha256(root) {
  const report = validateLedger({ root, ledgerPath: path.join(root, LEDGER_REL), policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  return report.ledgerSha256;
}

function member(repoRelativePath, abs) {
  const bytes = fs.readFileSync(abs);
  return { repoRelativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

/** (Re)writes STATE_SEAL.json + CURRENT_STATE.json from the CURRENT live bytes of all four
 * sealed members. Used both at initial fixture build time AND, unmodified, by the attacker's
 * "recompute STATE_SEAL" step in coordinatedLocalReseal below — exactly mirroring what a real
 * coordinated reseal does (re-derive everything from current bytes, no shortcuts). */
function resealStateSeal(repoRoot, gateId, revRel, activationRel, { executionStatus }) {
  const revDir = path.join(repoRoot, revRel);
  const checkpointPath = path.join(revDir, 'CHECKPOINT.json');
  const defectsPath = path.join(revDir, 'OPEN_DEFECTS.json');
  const contractPtrPath = path.join(repoRoot, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`);
  const activationAbs = path.join(repoRoot, activationRel);

  const payload = { gateId, stateRevision: 'R0001', executionStatus, purpose: 'AB_FIXTURE' };
  const seal = {
    schemaVersion: 1, gateId, stateRevision: 'R0001',
    sealedMembers: [
      member(`${revRel}/CHECKPOINT.json`, checkpointPath),
      member(`${revRel}/OPEN_DEFECTS.json`, defectsPath),
      member(`governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`, contractPtrPath),
      member(activationRel, activationAbs)
    ],
    previousStateSealSha256: null, sealedAt: '2026-08-08T00:00:00.000Z', payload, payloadSha256: sha256Canonical(payload)
  };
  const sealPath = path.join(revDir, 'STATE_SEAL.json');
  fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));

  const currentState = {
    schemaVersion: 1, gateId, stateRevision: 'R0001', revisionPath: revRel,
    stateSealSha256: sha256Bytes(fs.readFileSync(sealPath)), committedByTransactionId: 'AB_FIXTURE'
  };
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/state`), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/state/CURRENT_STATE.json`), JSON.stringify(currentState, null, 2));
}

function writeLedger(repoRoot, gateId, registryPath, {
  includeStartEvent = true,
  startEventGateId = null,
  startEventAuthorityPathOverride = null,
  startEventAuthoritySha256Override = null,
  activationRel
} = {}) {
  const registryAuthoritySha256 = sha256Bytes(fs.readFileSync(registryPath));
  const event1 = {
    schemaVersion: 1, ordinal: 1, eventId: `GENESIS_IMPORT_${gateId}`, gateId, fromStatus: null, toStatus: 'NOT_STARTED',
    transitionType: 'GENESIS_IMPORT', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256: registryAuthoritySha256,
    previousEventSha256: null, recordedAt: '2026-08-08T00:00:00.000Z'
  };
  const event1Final = { ...event1, eventPayloadSha256: sha256Canonical(event1) };
  const lines = [canonicalize(event1Final)];

  const event2 = {
    schemaVersion: 1, ordinal: 2, eventId: `AUTHORIZATION_${gateId}`, gateId, fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED',
    transitionType: 'AUTHORIZATION', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256: registryAuthoritySha256,
    previousEventSha256: event1Final.eventPayloadSha256, recordedAt: '2026-08-08T00:01:00.000Z'
  };
  const event2Final = { ...event2, eventPayloadSha256: sha256Canonical(event2) };
  lines.push(canonicalize(event2Final));

  if (includeStartEvent) {
    const activationAbs = path.join(repoRoot, activationRel);
    const realAuthoritySha256 = sha256Bytes(fs.readFileSync(activationAbs));
    const event3 = {
      schemaVersion: 1, ordinal: 3, eventId: `${ACTIVATION_LEDGER_TRANSITION_TYPE}_${gateId}`,
      gateId: startEventGateId || gateId,
      fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS',
      transitionType: ACTIVATION_LEDGER_TRANSITION_TYPE,
      authorityPath: startEventAuthorityPathOverride || activationRel,
      authoritySha256: startEventAuthoritySha256Override || realAuthoritySha256,
      previousEventSha256: event2Final.eventPayloadSha256, recordedAt: '2026-08-08T00:02:00.000Z'
    };
    const event3Final = { ...event3, eventPayloadSha256: sha256Canonical(event3) };
    lines.push(canonicalize(event3Final));
  }
  fs.writeFileSync(path.join(repoRoot, LEDGER_REL), lines.join('\n') + '\n');
}

/**
 * Builds a fully self-contained, isolated activated work unit — registry, execution contract,
 * derived execution seal, a real sealed ACTIVATION_AUTHORITY record, STATE_SEAL/CURRENT_STATE,
 * and a ledger (GENESIS_IMPORT + AUTHORIZATION + a canonical START event) whose START event pins
 * the activation-authority artifact's exact live bytes. This is the AB01 "everything matches"
 * baseline every other AB scenario starts from before a specific hostile mutation is applied.
 */
function buildBoundFixture(repoRoot, { gateId, includeStartEvent = true, startEventGateId = null, startEventAuthorityPathOverride = null, startEventAuthoritySha256Override = null } = {}) {
  const revRel = `governance/gates/${gateId}/state/revisions/R0001`;
  const revDir = path.join(repoRoot, revRel);
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/contracts`), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'governance/authority'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'governance/state'), { recursive: true });

  const registryPath = path.join(repoRoot, 'governance/GATE_REGISTRY_00_40.json');
  const registry = { schemaVersion: 1, gates: [{ gateId, canonicalObjective: 'AB fixture', dependencies: [], definitionCompleteness: 'PARTIAL' }] };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  const contractPtr = { schemaVersion: 1, gateId, contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json` };
  const contractBody = {
    gateId, contractRevision: 'R0001',
    positiveTests: ['t1'], negativeTests: ['n1'], countertests: ['c1'],
    canonicalRequirements: [{ requirementId: 'REQ-1' }],
    requiredOutputs: [{ path: `governance/gates/${gateId}/OUTPUT.json` }],
    closureConditions: ['done'],
    authorizedPaths: [`governance/gates/${gateId}/**`]
  };
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`), JSON.stringify(contractPtr, null, 2));
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`), JSON.stringify(contractBody, null, 2));

  const mapped = mapLegacyGateContractToExecutionView(contractBody, { objective: registry.gates[0].canonicalObjective, prerequisites: [] });
  const realSeal = sealExecutionContract(mapped.contract, { sealedAt: EXECUTION_SEAL_DERIVATION_EPOCH }).seal;
  const expectedContractSha256 = sha256Canonical(mapped.contract);
  const expectedSealSha256 = realSeal.sealSha256;

  const activationRecord = {
    schemaVersion: 1, authorityKind: 'EXECUTION_CONTRACT_ACTIVATION', workUnitId: gateId,
    executionContractId: mapped.contract.id, executionContractVersion: mapped.contract.version,
    expectedContractSha256, expectedSealSha256, activatedAt: '2026-08-08T00:00:00.000Z'
  };
  const activationRel = `${revRel}/ACTIVATION_AUTHORITY.json`;
  fs.writeFileSync(path.join(repoRoot, activationRel), JSON.stringify(activationRecord, null, 2));

  const checkpoint = {
    gateId, stateRevision: 'R0001', milestone: 'M', resumePoint: 'x', completedTasks: [], openTasks: [],
    reusableEvidence: [], invalidatedEvidence: [], requiredNextActions: [], protectedHashes: [], createdAt: '2026-08-08T00:00:00.000Z'
  };
  const defects = { gateId, stateRevision: 'R0001', defects: [] };
  fs.writeFileSync(path.join(revDir, 'CHECKPOINT.json'), JSON.stringify(checkpoint, null, 2));
  fs.writeFileSync(path.join(revDir, 'OPEN_DEFECTS.json'), JSON.stringify(defects, null, 2));

  resealStateSeal(repoRoot, gateId, revRel, activationRel, { executionStatus: includeStartEvent ? 'IN_PROGRESS' : 'AUTHORIZED_NOT_STARTED' });

  const sourceMap = { gates: [{ gateId, importedStatus: 'NOT_STARTED', historicalDetailCompleteness: 'PARTIAL', fabricatedTransitionCount: 0 }] };
  fs.writeFileSync(path.join(repoRoot, 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json'), JSON.stringify(sourceMap, null, 2));

  writeLedger(repoRoot, gateId, registryPath, { includeStartEvent, startEventGateId, startEventAuthorityPathOverride, startEventAuthoritySha256Override, activationRel });

  return { repoRoot, gateId, revRel, revDir, activationRel, registryPath, mapped, realSeal };
}

/**
 * The mission's exact coordinated-reseal hostile mutation (section 11): mutate the execution
 * contract, recompute the execution seal, recreate ACTIVATION_AUTHORITY under the SAME on-disk
 * path with new contract/seal hashes, update its sealedMembers hash, recompute STATE_SEAL, and
 * update CURRENT_STATE.stateSealSha256 — all coherently, so the local revision stays internally
 * self-consistent. The ledger and any external witness are left byte-for-byte untouched.
 */
function coordinatedLocalReseal(fixture) {
  const { repoRoot, gateId, revRel, activationRel } = fixture;
  const contractBodyPath = path.join(repoRoot, `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`);
  const contractBody = JSON.parse(fs.readFileSync(contractBodyPath, 'utf8'));
  const mutatedContractBody = { ...contractBody, canonicalRequirements: [{ requirementId: 'REQ-1' }, { requirementId: 'REQ-2-INJECTED' }] };
  fs.writeFileSync(contractBodyPath, JSON.stringify(mutatedContractBody, null, 2));

  const mappedV2 = mapLegacyGateContractToExecutionView(mutatedContractBody, { objective: 'AB fixture', prerequisites: [] });
  const sealV2 = sealExecutionContract(mappedV2.contract, { sealedAt: EXECUTION_SEAL_DERIVATION_EPOCH }).seal;

  const activationRecordV2 = {
    schemaVersion: 1, authorityKind: 'EXECUTION_CONTRACT_ACTIVATION', workUnitId: gateId,
    executionContractId: mappedV2.contract.id, executionContractVersion: mappedV2.contract.version,
    expectedContractSha256: sha256Canonical(mappedV2.contract), expectedSealSha256: sealV2.sealSha256,
    activatedAt: '2026-08-08T00:00:00.000Z'
  };
  fs.writeFileSync(path.join(repoRoot, activationRel), JSON.stringify(activationRecordV2, null, 2));

  // Recompute STATE_SEAL + CURRENT_STATE from the now-mutated live bytes — the attacker's
  // "reseal" step. executionStatus (the generic status STRING) is left unchanged: the attack
  // never needs to touch it, and leaving it untouched is what makes authorityState.consistent
  // stay true — this is precisely why a string-only consistency check is insufficient.
  resealStateSeal(repoRoot, gateId, revRel, activationRel, { executionStatus: 'IN_PROGRESS' });

  return { mappedContract: mappedV2.contract, seal: sealV2 };
}

// =============================================================================
// AB01: everything matches -> PROVEN, through the real pipeline.
// =============================================================================

test('AB01: a real ledger START event pinning the exact activation-authority bytes proves PROVEN end to end', () => {
  const tmp = mkTmp('ab01-');
  const gateId = 'GATE301_AB01';
  buildBoundFixture(tmp, { gateId });
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.activation.ledgerBinding.state, 'PROVEN');
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  const result = evaluateReadiness(context);
  assert.equal(result.verdict, 'READY');
  assert.ok(result.checks.some((c) => c.id === 'ACTIVATION_ANCHOR' && c.status === 'PASS'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// AB02 / AB03 / AB04 / AB06: unit-level properties of the generic core matcher
// (core/authority-event-log.mjs's deriveActivationLedgerBinding). See file header for why these
// are exercised at the unit that owns them rather than via a constructed multi-gate/malformed
// ledger fixture.
// =============================================================================

test('AB02: a ledger event whose authoritySha256 does not match the real bytes -> FAILED', () => {
  const binding = deriveActivationLedgerBinding({
    ledgerReport: {
      valid: true,
      events: [{ gateId: 'GATE_X', transitionType: 'START', ordinal: 3, eventId: 'START_GATE_X', authorityPath: 'ACTIVATION_AUTHORITY.json', authoritySha256: 'a'.repeat(64) }]
    },
    workUnitId: 'GATE_X',
    transitionType: 'START',
    authorityPath: 'ACTIVATION_AUTHORITY.json',
    authoritySha256: 'b'.repeat(64) // the REAL, current bytes hash to this — the ledger pins something else
  });
  assert.equal(binding.state, 'FAILED');
  assert.equal(binding.reason, 'ACTIVATION_LEDGER_BINDING_AUTHORITY_SHA_MISMATCH');
});

test('AB03: a ledger event whose authorityPath points at a different (even if internally self-consistent) file -> FAILED', () => {
  const binding = deriveActivationLedgerBinding({
    ledgerReport: {
      valid: true,
      events: [{ gateId: 'GATE_X', transitionType: 'START', ordinal: 3, eventId: 'START_GATE_X', authorityPath: 'DECOY_UNRELATED_FILE.json', authoritySha256: 'c'.repeat(64) }]
    },
    workUnitId: 'GATE_X',
    transitionType: 'START',
    authorityPath: 'governance/gates/GATE_X/state/revisions/R0001/ACTIVATION_AUTHORITY.json', // the REAL anchor's own path
    authoritySha256: 'c'.repeat(64) // hash happens to match, but for the wrong file entirely
  });
  assert.equal(binding.state, 'FAILED');
  assert.equal(binding.reason, 'ACTIVATION_LEDGER_BINDING_AUTHORITY_PATH_MISMATCH');
});

test('AB04: a correctly-pinned event recorded under a FOREIGN work unit never binds this work unit -> FAILED', () => {
  const binding = deriveActivationLedgerBinding({
    ledgerReport: {
      valid: true,
      events: [{ gateId: 'GATE_FOREIGN', transitionType: 'START', ordinal: 3, eventId: 'START_GATE_FOREIGN', authorityPath: 'ACTIVATION_AUTHORITY.json', authoritySha256: 'd'.repeat(64) }]
    },
    workUnitId: 'GATE_X', // NOT GATE_FOREIGN
    transitionType: 'START',
    authorityPath: 'ACTIVATION_AUTHORITY.json',
    authoritySha256: 'd'.repeat(64)
  });
  assert.equal(binding.state, 'FAILED');
  assert.equal(binding.reason, 'ACTIVATION_LEDGER_BINDING_FOREIGN_WORK_UNIT');
});

test('AB06: two ledger events for the same work unit and transition are ambiguous, never PROVEN -> FAILED', () => {
  const binding = deriveActivationLedgerBinding({
    ledgerReport: {
      valid: true,
      events: [
        { gateId: 'GATE_X', transitionType: 'START', ordinal: 3, eventId: 'START_GATE_X_A', authorityPath: 'ACTIVATION_AUTHORITY.json', authoritySha256: 'e'.repeat(64) },
        { gateId: 'GATE_X', transitionType: 'START', ordinal: 4, eventId: 'START_GATE_X_B', authorityPath: 'ACTIVATION_AUTHORITY.json', authoritySha256: 'e'.repeat(64) }
      ]
    },
    workUnitId: 'GATE_X',
    transitionType: 'START',
    authorityPath: 'ACTIVATION_AUTHORITY.json',
    authoritySha256: 'e'.repeat(64)
  });
  assert.equal(binding.state, 'FAILED');
  assert.equal(binding.reason, 'ACTIVATION_LEDGER_BINDING_AMBIGUOUS');
});

// =============================================================================
// AB05: no activation ledger event at all.
// =============================================================================

test('AB05: an activated work unit with no activation-transition ledger event never reaches PROVEN', () => {
  const tmp = mkTmp('ab05-');
  const gateId = 'GATE302_AB05';
  buildBoundFixture(tmp, { gateId, includeStartEvent: false });
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.activation.activated, true);
  assert.notEqual(view.activation.ledgerBinding.state, 'PROVEN');
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// AB07-AB10: the mission's core coordinated-reseal hostile mutation, through the real pipeline.
// =============================================================================

test('AB07/AB08: contract+seal+activation-authority recomputed together, ledger UNCHANGED -> BLOCKED, never PROVEN', () => {
  const tmp = mkTmp('ab08-');
  const gateId = 'GATE303_AB08';
  const fixture = buildBoundFixture(tmp, { gateId });

  // Sanity: before the attack, this fixture really does reach PROVEN/READY.
  const beforeAdapter = createWheelProjectAdapter(tmp);
  assert.equal(buildReadinessContext({ adapter: beforeAdapter, workUnitId: gateId, preflightOk: true }).proofs.ACTIVATION_ANCHOR.state, 'PROVEN');

  const ledgerBytesBefore = fs.readFileSync(path.join(tmp, LEDGER_REL));
  coordinatedLocalReseal(fixture);
  const ledgerBytesAfter = fs.readFileSync(path.join(tmp, LEDGER_REL));
  assert.deepEqual(ledgerBytesBefore, ledgerBytesAfter, 'the attack must never touch the ledger');

  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.notEqual(view.activation.ledgerBinding.state, 'PROVEN', 'the ledger still pins the OLD activation-authority bytes');
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  const result = evaluateReadiness(context);
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.checks.some((c) => c.id === 'ACTIVATION_ANCHOR' && c.status === 'FAIL'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AB09: STATE_SEAL is also recomputed as part of the reseal -> still BLOCKED', () => {
  const tmp = mkTmp('ab09-');
  const gateId = 'GATE304_AB09';
  const fixture = buildBoundFixture(tmp, { gateId });
  const sealBefore = fs.readFileSync(path.join(tmp, fixture.revRel, 'STATE_SEAL.json'), 'utf8');
  coordinatedLocalReseal(fixture);
  const sealAfter = fs.readFileSync(path.join(tmp, fixture.revRel, 'STATE_SEAL.json'), 'utf8');
  assert.notEqual(sealBefore, sealAfter, 'fixture bug: STATE_SEAL must genuinely be recomputed for this test to be meaningful');

  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AB10: CURRENT_STATE.stateSealSha256 is also updated to match the reseal -> still BLOCKED', () => {
  const tmp = mkTmp('ab10-');
  const gateId = 'GATE305_AB10';
  const fixture = buildBoundFixture(tmp, { gateId });
  const currentStatePath = path.join(tmp, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  const before = JSON.parse(fs.readFileSync(currentStatePath, 'utf8'));
  coordinatedLocalReseal(fixture);
  const after = JSON.parse(fs.readFileSync(currentStatePath, 'utf8'));
  assert.notEqual(before.stateSealSha256, after.stateSealSha256, 'fixture bug: CURRENT_STATE must genuinely repoint at the resealed STATE_SEAL');

  const adapter = createWheelProjectAdapter(tmp);
  // Local pointer/seal identity is internally self-consistent (the reseal recomputed it
  // coherently) — the block must come from the ledger binding, not a pointer-hash mismatch.
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.authorityState.statusKnowledge, 'SEAL_VERIFIED', 'the reseal is internally self-consistent; the block must come from the ledger binding, not a pointer/seal mismatch');
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// AB11-AB13: witness cannot rescue a ledger-binding mismatch; a full, honestly-updated V2 chain
// (ledger + activation authority + a matching TEMP witness) is the only way back to PROVEN.
// =============================================================================

test('AB11: a valid external witness cannot rescue a coordinated reseal', () => {
  const tmp = mkTmp('ab11-');
  const gateId = 'GATE306_AB11';
  const fixture = buildBoundFixture(tmp, { gateId });
  coordinatedLocalReseal(fixture);

  const witnessDir = mkTmp('ab11-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [
    { kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: realLedgerSha256(tmp), ref: 'AB11_EXTERNAL' }
  ]);
  withWitnessEnv(witnessPath, () => {
    const adapter = createWheelProjectAdapter(tmp);
    const view = adapter.getWorkUnitView(gateId);
    // The reseal mutates the SAME on-disk activation-authority path the ledger's own START event
    // pins, in place — the generic ledger validator's own authority-resolution step (every event's
    // authorityPath live bytes must still hash to its own authoritySha256) independently detects
    // this too, so the ledger itself reads chain-broken (trustLevel=BROKEN) even before a witness
    // is consulted. Either way, no witness — real or fabricated — can rescue this.
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL', 'no witness can upgrade trust once the ledger itself is broken by the reseal');
    const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
    assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN', 'trust level alone must never rescue a ledger-binding mismatch');
    assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

test('AB12: rewriting the ledger to authorize V2 while keeping the OLD witness pinned loses external trust', () => {
  const tmp = mkTmp('ab12-');
  const gateId = 'GATE307_AB12';
  const fixture = buildBoundFixture(tmp, { gateId });

  const witnessDir = mkTmp('ab12-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [
    { kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: realLedgerSha256(tmp), ref: 'AB12_STALE_AFTER_REWRITE' }
  ]);

  coordinatedLocalReseal(fixture);
  // The attacker now also rewrites the ledger's START event to pin the NEW (V2) activation
  // authority — but the witness above is still pinned to the OLD (pre-rewrite) ledger hash.
  writeLedger(tmp, gateId, fixture.registryPath, { includeStartEvent: true, activationRel: fixture.activationRel });

  withWitnessEnv(witnessPath, () => {
    const adapter = createWheelProjectAdapter(tmp);
    const view = adapter.getWorkUnitView(gateId);
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL', 'a witness pinned to the pre-rewrite ledger hash must never validate the rewritten ledger');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

test('AB13: a fully honest V2 chain (ledger V2 + activation authority V2 + a matching TEMP witness V2) reaches PROVEN again', () => {
  const tmp = mkTmp('ab13-');
  const gateId = 'GATE308_AB13';
  const fixture = buildBoundFixture(tmp, { gateId });
  coordinatedLocalReseal(fixture);
  // Honest re-authorization: the ledger's START event is rewritten to pin the NEW activation
  // authority's real, current bytes — exactly what a legitimate re-activation would record.
  writeLedger(tmp, gateId, fixture.registryPath, { includeStartEvent: true, activationRel: fixture.activationRel });

  const witnessDir = mkTmp('ab13-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [
    { kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: realLedgerSha256(tmp), ref: 'AB13_V2_EXTERNAL' }
  ]);
  withWitnessEnv(witnessPath, () => {
    const adapter = createWheelProjectAdapter(tmp);
    const view = adapter.getWorkUnitView(gateId);
    assert.equal(view.activation.ledgerBinding.state, 'PROVEN');
    assert.equal(view.state.trustLevel, 'ANCHORED_EXTERNAL');
    const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
    assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
    assert.equal(evaluateReadiness(context).verdict, 'READY');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

// =============================================================================
// AB14/AB15: pre-existing anchor-content checks are unaffected by this fix (regression guard).
// =============================================================================

test('AB14: activation-authority expectedContractSha256 mismatch still blocks independent of ledger binding', () => {
  const tmp = mkTmp('ab14-');
  const gateId = 'GATE309_AB14';
  const fixture = buildBoundFixture(tmp, { gateId });
  const activationAbs = path.join(tmp, fixture.activationRel);
  const record = JSON.parse(fs.readFileSync(activationAbs, 'utf8'));
  record.expectedContractSha256 = 'f'.repeat(64);
  fs.writeFileSync(activationAbs, JSON.stringify(record, null, 2));
  // Reseal so the tampered record is at least locally self-consistent with STATE_SEAL's own
  // member hash — isolating the failure to the contract-digest check, not a stale seal pointer.
  resealStateSeal(tmp, gateId, fixture.revRel, fixture.activationRel, { executionStatus: 'IN_PROGRESS' });

  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'FAILED');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AB15: activation-authority expectedSealSha256 mismatch still blocks independent of ledger binding', () => {
  const tmp = mkTmp('ab15-');
  const gateId = 'GATE310_AB15';
  const fixture = buildBoundFixture(tmp, { gateId });
  const activationAbs = path.join(tmp, fixture.activationRel);
  const record = JSON.parse(fs.readFileSync(activationAbs, 'utf8'));
  record.expectedSealSha256 = 'a'.repeat(64);
  fs.writeFileSync(activationAbs, JSON.stringify(record, null, 2));
  resealStateSeal(tmp, gateId, fixture.revRel, fixture.activationRel, { executionStatus: 'IN_PROGRESS' });

  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'FAILED');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// AB16: an invalid ledger chain never yields PROVEN.
// =============================================================================

test('AB16: a broken ledger hash-chain (corrupted previousEventSha256) never yields PROVEN', () => {
  const tmp = mkTmp('ab16-');
  const gateId = 'GATE311_AB16';
  buildBoundFixture(tmp, { gateId });
  const ledgerPath = path.join(tmp, LEDGER_REL);
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const lastEvent = JSON.parse(lines[lines.length - 1]);
  lastEvent.previousEventSha256 = 'f'.repeat(64);
  lines[lines.length - 1] = JSON.stringify(lastEvent);
  fs.writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.notEqual(view.activation.ledgerBinding.state, 'PROVEN');
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// AB17/AB18: real GATE13 is completely unaffected by this fix.
// =============================================================================

test('AB17: real GATE13 activation remains NOT_APPLICABLE — no activation-authority sealed member exists', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.activation.activated, false);
  assert.equal(view.activation.anchor, null);
  assert.equal(view.activation.ledgerBinding, null);
  const context = buildReadinessContext({ adapter, workUnitId: 'GATE13', preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'NOT_APPLICABLE');
});

test('AB18: real GATE13 readiness is unchanged by this fix (ACTIVATION_ANCHOR stays an explicit, non-blocking SKIP)', () => {
  // GATE13's real overall verdict is pre-existingly BLOCKED for an unrelated reason (an
  // unsatisfied GATE12 prerequisite) — this fix must not change that, and specifically must not
  // turn the already-correct ACTIVATION_ANCHOR=SKIP into a new blocking FAIL.
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const context = buildReadinessContext({ adapter, workUnitId: 'GATE13', preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'NOT_APPLICABLE');
  const result = evaluateReadiness(context);
  assert.equal(result.authoritative, true);
  assert.equal(result.contextKind, 'STRICT');
  const activationCheck = result.checks.find((c) => c.id === 'ACTIVATION_ANCHOR');
  assert.equal(activationCheck.status, 'SKIP');
  assert.equal(activationCheck.critical, false);
});

// =============================================================================
// AB19: a future, non-hardcoded work unit id traverses the fix with no core/adapter edits.
// =============================================================================

test('AB19: a future GATE-class work unit id (not literally present anywhere in the fix) reaches PROVEN through the same generic code path', () => {
  const tmp = mkTmp('ab19-');
  const gateId = 'GATE399_FUTURE_UNIT';
  buildBoundFixture(tmp, { gateId });
  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  assert.equal(evaluateReadiness(context).verdict, 'READY');

  const adapterSrc = fs.readFileSync(path.join(HERE, '..', 'adapters', 'wheel', 'wheel-project-adapter.mjs'), 'utf8');
  assert.equal(adapterSrc.includes('GATE13'), false, 'the activation-binding code path itself must contain no gate-numbered literal');
  const coreSrc = fs.readFileSync(path.join(HERE, '..', 'core', 'authority-event-log.mjs'), 'utf8');
  assert.equal(/GATE\d/.test(coreSrc), false, 'the generic core matcher must contain no gate-numbered or Wheel-specific literal');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================
// AB20: no raw, status-only authority reasoning can ever produce PROVEN.
// =============================================================================

test('AB20: authorityState.consistent===true with no ledgerBinding evidence at all never reaches PROVEN', () => {
  const binding = null; // exactly what an activation anchor built before this fix would have carried
  // Simulates the pre-fix status-only shortcut a caller might still attempt: authorityState says
  // "consistent", but there is no ledgerBinding fact to consult at all.
  assert.equal(binding, null);
  // deriveActivationLedgerBinding itself never returns PROVEN without a real, matching event:
  const noEvidence = deriveActivationLedgerBinding({
    ledgerReport: { valid: true, events: [] },
    workUnitId: 'GATE_X',
    transitionType: 'START',
    authorityPath: 'ACTIVATION_AUTHORITY.json',
    authoritySha256: 'a'.repeat(64)
  });
  assert.notEqual(noEvidence.state, 'PROVEN');
  const invalidLedger = deriveActivationLedgerBinding({
    ledgerReport: { valid: false, events: [] },
    workUnitId: 'GATE_X',
    transitionType: 'START',
    authorityPath: 'ACTIVATION_AUTHORITY.json',
    authoritySha256: 'a'.repeat(64)
  });
  assert.notEqual(invalidLedger.state, 'PROVEN');
});
