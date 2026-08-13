// GOVERNANCE_EXECUTION_EFFICIENCY_V1 — R1_FINAL_TWO_JUNCTIONS_FIX
// Hostile countertests for the last two physical junctions:
//   TJ-01 witness externality must mean outside the ENTIRE mutable repository, not merely
//         outside governance/ (governance/gee-v1/core/witness-source.mjs's generic
//         isWithinGovernedRoots was already correct; the bug was which root the Wheel adapter
//         fed it — see governance/gee-v1/adapters/wheel/wheel-project-adapter.mjs).
//   TJ-02 activation proof must traverse the REAL production pipeline (adapter -> WorkUnitView
//         -> buildReadinessContext -> evaluateReadiness) without a manually test-injected
//         executionSeal — build-readiness-context.mjs no longer hardcodes executionSeal:null.
// Every fixture below is built under os.tmpdir() and never touches a real governance/ file.
// No official witness is created anywhere in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createWheelProjectAdapter, EXECUTION_SEAL_DERIVATION_EPOCH, ACTIVATION_LEDGER_TRANSITION_TYPE } from '../adapters/wheel/wheel-project-adapter.mjs';
import { mapLegacyGateContractToExecutionView } from '../adapters/wheel/map-gate-contract.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../adapters/wheel/external-authority-policy.mjs';
import { sealExecutionContract } from '../contracts/seal-execution-contract.mjs';
import { validateLedger } from '../../tools/validate-status-ledger.mjs';
import { loadExternalWitnesses, resolveWitnessSourcePath, isWithinGovernedRoots } from '../core/witness-source.mjs';
import { buildReadinessContext, deriveActivationProof } from '../readiness/build-readiness-context.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { sha256Bytes, sha256Canonical, canonicalize } from '../../tools/canonical-json.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'work-unit-view.schema.json'), 'utf8'));
const LEDGER_REL = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const CLI = path.join(REPO_ROOT, 'governance', 'gee-v1', 'tools', 'evaluate-work-unit-readiness.mjs');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function realLedgerSha256(root = REPO_ROOT) {
  const report = validateLedger({ root, ledgerPath: path.join(root, LEDGER_REL), policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  return report.ledgerSha256;
}

function writeWitnessFile(dir, witnesses, name = 'witness-fixture.json') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ witnesses }, null, 2));
  return p;
}

function copyRealGovernance(tmpRoot) {
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(tmpRoot, 'governance'), { recursive: true });
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

// =============================================================================
// TJ-01 (A-K): witness externality must mean outside the ENTIRE repository.
// =============================================================================

test('TJ01-A: a witness under repoRoot/governance/ is rejected through the real adapter', () => {
  const tmp = mkTmp('tj01a-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const witnessPath = path.join(tmp, 'governance', 'SELF_WITNESS.json');
  fs.writeFileSync(witnessPath, JSON.stringify({ witnesses: [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TJ01A' }] }, null, 2));
  withWitnessEnv(witnessPath, () => {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ01-B: a witness placed DIRECTLY under repoRoot (outside governance/ entirely) is rejected through the real adapter', () => {
  const tmp = mkTmp('tj01b-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const witnessPath = path.join(tmp, 'SELF_WITNESS_REPOROOT.json');
  fs.writeFileSync(witnessPath, JSON.stringify({ witnesses: [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TJ01B_REPOROOT_SELF_WITNESS' }] }, null, 2));
  withWitnessEnv(witnessPath, () => {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL', 'a witness merely outside governance/ but still inside repoRoot must never be honored');
    assert.equal(view.closure.gateCompleteConfirmed, false);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ01-C: a witness under an arbitrary nested repo directory (not governance/) is rejected', () => {
  const tmp = mkTmp('tj01c-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const witnessPath = path.join(tmp, 'some', 'unrelated', 'nested', 'dir', 'WITNESS.json');
  fs.mkdirSync(path.dirname(witnessPath), { recursive: true });
  fs.writeFileSync(witnessPath, JSON.stringify({ witnesses: [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TJ01C' }] }, null, 2));
  withWitnessEnv(witnessPath, () => {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ01-D: a relative witness path that traverses back into repoRoot is rejected', () => {
  const tmp = mkTmp('tj01d-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const hostilePath = path.join(tmp, 'SELF_WITNESS_TRAVERSAL_TARGET.json');
  fs.writeFileSync(hostilePath, JSON.stringify({ witnesses: [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TJ01D_TRAVERSAL' }] }, null, 2));
  const outsideDir = path.join(os.tmpdir(), `tj01d-outside-${process.pid}-${Date.now()}`);
  fs.mkdirSync(outsideDir, { recursive: true });
  const relativeTraversal = path.relative(outsideDir, hostilePath);
  const cwdBefore = process.cwd();
  process.chdir(outsideDir);
  try {
    const loaded = loadExternalWitnesses(relativeTraversal, { governedRoots: [tmp] });
    assert.deepEqual(loaded, []);
  } finally {
    process.chdir(cwdBefore);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('TJ01-E: a symlink physically outside repoRoot whose real target resolves inside repoRoot is rejected (skipped if the platform forbids symlink creation)', (t) => {
  const tmp = mkTmp('tj01e-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  // Target lives directly under repoRoot, OUTSIDE governance/ — the exact TJ-01 shape.
  const insideTarget = path.join(tmp, 'SELF_WITNESS_TARGET_REPOROOT.json');
  fs.writeFileSync(insideTarget, JSON.stringify({ witnesses: [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TJ01E_SYMLINK' }] }, null, 2));
  const outsideLink = path.join(os.tmpdir(), `tj01e-link-${process.pid}-${Date.now()}.json`);
  try {
    fs.symlinkSync(insideTarget, outsideLink, 'file');
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    t.skip(`symlink creation not permitted on this platform/account: ${error.code || error.message}`);
    return;
  }
  try {
    const loaded = loadExternalWitnesses(outsideLink, { governedRoots: [tmp] });
    assert.deepEqual(loaded, []);
  } finally {
    fs.rmSync(outsideLink, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TJ01-F: the realpath-containment helper itself rejects any repoRoot-resolved path, proving the property even without symlink permission', () => {
  const tmp = mkTmp('tj01f-');
  const repoRootDir = path.join(tmp, 'repo');
  const governanceDir = path.join(repoRootDir, 'governance');
  fs.mkdirSync(governanceDir, { recursive: true });
  const realRepoRootDir = fs.realpathSync(repoRootDir);
  try {
    // The repo root itself.
    assert.equal(isWithinGovernedRoots(realRepoRootDir, [repoRootDir]), true);
    // Directly under repo root, OUTSIDE governance/ — this is the exact bug shape.
    assert.equal(isWithinGovernedRoots(path.join(realRepoRootDir, 'SELF_WITNESS_REPOROOT.json'), [repoRootDir]), true);
    // Nested arbitrary directory under repo root, still outside governance/.
    assert.equal(isWithinGovernedRoots(path.join(realRepoRootDir, 'a', 'b', 'c', 'WITNESS.json'), [repoRootDir]), true);
    // Still under governance/ (subset of repoRoot) — must remain contained too.
    assert.equal(isWithinGovernedRoots(path.join(realRepoRootDir, 'governance', 'SELF_WITNESS.json'), [repoRootDir]), true);
    // A sibling directory that merely SHARES A STRING PREFIX with repoRoot ("repo-other" vs
    // "repo") must never be treated as contained — guards against a naive startsWith().
    const siblingDir = path.join(tmp, 'repo-other');
    fs.mkdirSync(siblingDir, { recursive: true });
    assert.equal(isWithinGovernedRoots(fs.realpathSync(siblingDir), [repoRootDir]), false);
    // A genuinely external resolved path is never contained.
    assert.equal(isWithinGovernedRoots(fs.realpathSync(os.tmpdir()), [repoRootDir]), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TJ01-G: a real witness under an independent TEMP directory outside repoRoot is accepted (ANCHORED_EXTERNAL)', () => {
  const tmp = mkTmp('tj01g-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const witnessDir = mkTmp('tj01g-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TJ01G_EXTERNAL' }]);
  withWitnessEnv(witnessPath, () => {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.equal(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

test('TJ01-H: a stale external TEMP witness (wrong pinned hash) is never honored even though it is genuinely external', () => {
  const tmp = mkTmp('tj01h-');
  copyRealGovernance(tmp);
  const witnessDir = mkTmp('tj01h-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: 'e'.repeat(64), ref: 'TJ01H_STALE' }]);
  withWitnessEnv(witnessPath, () => {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

test('TJ01-I: the real adapter never reaches ANCHORED_EXTERNAL for any in-repo witness placement (governance/, repo root, or nested)', () => {
  const placements = ['governance/NESTED/SELF_WITNESS.json', 'SELF_WITNESS.json', 'deeply/nested/unrelated/dir/SELF_WITNESS.json'];
  for (const rel of placements) {
    const tmp = mkTmp('tj01i-');
    copyRealGovernance(tmp);
    const ledgerSha256 = realLedgerSha256(tmp);
    const witnessPath = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(witnessPath), { recursive: true });
    fs.writeFileSync(witnessPath, JSON.stringify({ witnesses: [{ kind: 'INDEPENDENT_AUDIT_RUN_ROOT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: `TJ01I_${rel}` }] }, null, 2));
    withWitnessEnv(witnessPath, () => {
      const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
      assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL', `placement ${rel} must never reach ANCHORED_EXTERNAL`);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('TJ01-J: the real production CLI with an in-repo (repo-root) witness never grants authoritative modern READY on witness trust alone', () => {
  const tmp = mkTmp('tj01j-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const selfWitnessPath = path.join(tmp, 'SELF_WITNESS_REPOROOT.json');
  fs.writeFileSync(selfWitnessPath, JSON.stringify({ witnesses: [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TJ01J_SELF_WITNESS' }] }, null, 2));
  const run = spawnSync(process.execPath, [CLI, '--root', tmp, '--work-unit', 'GATE13', '--preflight-ok'], {
    encoding: 'utf8', env: { ...process.env, GEE_HEAD_WITNESS_SOURCE: selfWitnessPath }
  });
  const out = JSON.parse(run.stdout);
  // The CLI stays on the strict/authoritative calling convention either way (contextKind never
  // silently downgrades) but the underlying trust must never have been upgraded by the self-witness.
  assert.equal(out.authoritative, true);
  assert.equal(out.contextKind, 'STRICT');
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
  assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  assert.equal(view.closure.gateCompleteConfirmed, false, 'closure must never be granted on a repo-root self-witness');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ01-K: the real production CLI with a genuinely external TEMP witness may achieve ANCHORED_EXTERNAL trust', () => {
  const witnessDir = mkTmp('tj01k-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: realLedgerSha256(REPO_ROOT), ref: 'TJ01K_EXTERNAL_CLI' }]);
  const run = spawnSync(process.execPath, [CLI, '--root', REPO_ROOT, '--work-unit', 'GATE13', '--preflight-ok'], {
    encoding: 'utf8', env: { ...process.env, GEE_HEAD_WITNESS_SOURCE: witnessPath }
  });
  assert.ok(run.status === 0 || run.status === 2, `CLI must exit 0 (READY) or 2 (BLOCKED), got ${run.status}: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.authoritative, true);
  assert.equal(out.contextKind, 'STRICT');
  withWitnessEnv(witnessPath, () => {
    const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
    assert.equal(view.state.trustLevel, 'ANCHORED_EXTERNAL', 'a real, genuinely external TEMP witness must still be able to achieve ANCHORED_EXTERNAL trust');
  });
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

// =============================================================================
// TJ-02 (A-J): activation proof must traverse the REAL production pipeline —
// adapter -> WorkUnitView -> buildReadinessContext -> evaluateReadiness — with
// NO manually test-injected executionSeal.
// =============================================================================

/**
 * Builds a fully self-contained, isolated future work unit whose execution contract genuinely
 * validates (so sealExecutionContract actually produces a seal, exercising the real TJ-02 path
 * rather than short-circuiting on an invalid contract), with a real sealed activation authority
 * record and a ledger that corroborates it (GENESIS_IMPORT to AUTHORIZED_NOT_STARTED + START => ANCHORED_APPEND_ONLY,
 * sufficient for SATISFY_PREREQUISITE / authorityState.consistent).
 *
 * `mutateContract`/`mutateRecord` let individual tests corrupt exactly one dimension (contract
 * validity, activation-record identity/digests) while everything else stays realistic.
 */
function buildTj02Fixture(repoRoot, {
  gateId,
  includeStartEvent = true,
  mutateContractBody = (c) => c,
  mutateActivationRecord = (r) => r,
  activationExpectedSealSha256 = null,
  activationExpectedContractSha256 = null
} = {}) {
  const revRel = `governance/gates/${gateId}/state/revisions/R0001`;
  const revDir = path.join(repoRoot, revRel);
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/contracts`), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'governance/authority'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'governance/state'), { recursive: true });

  const registryPath = path.join(repoRoot, 'governance/GATE_REGISTRY_00_40.json');
  const registry = { schemaVersion: 1, gates: [{ gateId, canonicalObjective: 'TJ-02 fixture', dependencies: [], definitionCompleteness: 'PARTIAL' }] };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  const contractPtr = { schemaVersion: 1, gateId, contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json` };
  const contractBody = mutateContractBody({
    gateId, contractRevision: 'R0001',
    positiveTests: ['t1'], negativeTests: ['n1'], countertests: ['c1'],
    canonicalRequirements: [{ requirementId: 'REQ-1' }],
    requiredOutputs: [{ path: `governance/gates/${gateId}/OUTPUT.json` }],
    closureConditions: ['done'],
    authorizedPaths: [`governance/gates/${gateId}/**`]
  });
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`), JSON.stringify(contractPtr, null, 2));
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`), JSON.stringify(contractBody, null, 2));

  // Compute exactly as the real adapter would (same mapping function, same inputs, same pinned
  // seal-derivation epoch) so the activation record can pin against the REAL production values.
  const mapped = mapLegacyGateContractToExecutionView(contractBody, { objective: registry.gates[0].canonicalObjective, prerequisites: [] });
  const realSeal = sealExecutionContract(mapped.contract, { sealedAt: EXECUTION_SEAL_DERIVATION_EPOCH }).seal;
  const expectedContractSha256 = activationExpectedContractSha256 || sha256Canonical(mapped.contract);
  const expectedSealSha256 = activationExpectedSealSha256 || (realSeal ? realSeal.sealSha256 : 'f'.repeat(64));

  const activationRecord = mutateActivationRecord({
    schemaVersion: 1, authorityKind: 'EXECUTION_CONTRACT_ACTIVATION', workUnitId: gateId,
    executionContractId: mapped.contract.id, executionContractVersion: mapped.contract.version,
    expectedContractSha256, expectedSealSha256, activatedAt: '2026-08-08T00:00:00.000Z'
  });
  const activationRel = `${revRel}/ACTIVATION_AUTHORITY.json`;
  fs.writeFileSync(path.join(repoRoot, activationRel), JSON.stringify(activationRecord, null, 2));

  const checkpoint = {
    gateId, stateRevision: 'R0001', milestone: 'M', resumePoint: 'x', completedTasks: [], openTasks: [],
    reusableEvidence: [], invalidatedEvidence: [], requiredNextActions: [], protectedHashes: [], createdAt: '2026-08-08T00:00:00.000Z'
  };
  const defects = { gateId, stateRevision: 'R0001', defects: [] };
  fs.writeFileSync(path.join(revDir, 'CHECKPOINT.json'), JSON.stringify(checkpoint, null, 2));
  fs.writeFileSync(path.join(revDir, 'OPEN_DEFECTS.json'), JSON.stringify(defects, null, 2));

  function member(repoRelativePath, abs) {
    const bytes = fs.readFileSync(abs);
    return { repoRelativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
  }
  // R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: an "activated" fixture's ledger must actually reach
  // IN_PROGRESS via a real START event (see below) that pins this exact activation-authority
  // file, so STATE_SEAL's claimed executionStatus must agree — otherwise authorityState.consistent
  // itself would (correctly) go false before the ledger-binding check is even reached.
  const payload = { gateId, stateRevision: 'R0001', executionStatus: includeStartEvent ? 'IN_PROGRESS' : 'AUTHORIZED_NOT_STARTED', purpose: 'TJ02_FIXTURE' };
  const seal = {
    schemaVersion: 1, gateId, stateRevision: 'R0001',
    sealedMembers: [
      member(`${revRel}/CHECKPOINT.json`, path.join(revDir, 'CHECKPOINT.json')),
      member(`${revRel}/OPEN_DEFECTS.json`, path.join(revDir, 'OPEN_DEFECTS.json')),
      member(`governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`, path.join(repoRoot, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`)),
      member(activationRel, path.join(repoRoot, activationRel))
    ],
    previousStateSealSha256: null, sealedAt: '2026-08-08T00:00:00.000Z', payload, payloadSha256: sha256Canonical(payload)
  };
  const sealPath = path.join(revDir, 'STATE_SEAL.json');
  fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));

  const currentState = {
    schemaVersion: 1, gateId, stateRevision: 'R0001', revisionPath: revRel,
    stateSealSha256: sha256Bytes(fs.readFileSync(sealPath)), committedByTransactionId: 'TJ02_FIXTURE'
  };
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/state`), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/state/CURRENT_STATE.json`), JSON.stringify(currentState, null, 2));

  const sourceMap = { gates: [{ gateId, importedStatus: 'AUTHORIZED_NOT_STARTED', historicalDetailCompleteness: 'PARTIAL', fabricatedTransitionCount: 0 }] };
  fs.writeFileSync(path.join(repoRoot, 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json'), JSON.stringify(sourceMap, null, 2));

  const authoritySha256 = sha256Bytes(fs.readFileSync(registryPath));
  const event1 = {
    schemaVersion: 1, ordinal: 1, eventId: `GENESIS_IMPORT_${gateId}`, gateId, fromStatus: null, toStatus: 'AUTHORIZED_NOT_STARTED',
    transitionType: 'GENESIS_IMPORT', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256,
    previousEventSha256: null, recordedAt: '2026-08-08T00:00:00.000Z'
  };
  const event1Final = { ...event1, eventPayloadSha256: sha256Canonical(event1) };
  const lines = [canonicalize(event1Final)];
  if (includeStartEvent) {
    // R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: the canonical activation transition (START) must
    // pin the EXACT live bytes of the activation-authority artifact this fixture just wrote —
    // this is what deriveActivationLedgerBinding (core/authority-event-log.mjs) looks for.
    const activationAuthorityAbs = path.join(repoRoot, activationRel);
    const event3 = {
      schemaVersion: 1, ordinal: 2, eventId: `${ACTIVATION_LEDGER_TRANSITION_TYPE}_${gateId}`, gateId,
      fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS',
      transitionType: ACTIVATION_LEDGER_TRANSITION_TYPE, authorityPath: activationRel,
      authoritySha256: sha256Bytes(fs.readFileSync(activationAuthorityAbs)),
      previousEventSha256: event1Final.eventPayloadSha256, recordedAt: '2026-08-08T00:02:00.000Z'
    };
    const event3Final = { ...event3, eventPayloadSha256: sha256Canonical(event3) };
    lines.push(canonicalize(event3Final));
  }
  fs.writeFileSync(path.join(repoRoot, LEDGER_REL), lines.join('\n') + '\n');

  return { repoRoot, gateId, sealPath, mappedContract: mapped.contract, realSeal };
}

test('TJ02-A: the real adapter loads execution contract, execution seal, and activation authority', () => {
  const tmp = mkTmp('tj02a-');
  const gateId = 'GATE201_TJ02A';
  buildTj02Fixture(tmp, { gateId });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView(gateId);
  assert.ok(view.contract, 'execution contract must load');
  assert.ok(view.execution, 'view.execution must be present');
  assert.ok(view.execution.contract, 'view.execution.contract must load');
  assert.ok(view.execution.seal, 'view.execution.seal must load (contract validates)');
  assert.equal(view.activation.activated, true);
  assert.ok(view.activation.anchor, 'activation authority must load a real anchor');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-B: the real WorkUnitView exposes the canonical execution-seal evidence in a schema-valid shape', () => {
  const tmp = mkTmp('tj02b-');
  const gateId = 'GATE202_TJ02B';
  buildTj02Fixture(tmp, { gateId });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView(gateId);
  assert.equal(view.execution.seal.sealKind, 'EXECUTION_CONTRACT_SEAL');
  assert.match(view.execution.seal.sealSha256, /^[a-f0-9]{64}$/);
  assert.match(view.execution.seal.payloadSha256, /^[a-f0-9]{64}$/);
  const result = validateAgainstJsonSchema(view, SCHEMA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-C: real buildReadinessContext through the real adapter reaches ACTIVATION_ANCHOR=PROVEN with NO manual deriveActivationProof call', () => {
  const tmp = mkTmp('tj02c-');
  const gateId = 'GATE203_TJ02C';
  buildTj02Fixture(tmp, { gateId });
  const adapter = createWheelProjectAdapter(tmp);
  // Acceptance rule: only adapter -> buildReadinessContext -> evaluateReadiness is exercised here.
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-D: real evaluateReadiness(strict context) uses the PROVEN activation proof end to end', () => {
  const tmp = mkTmp('tj02d-');
  const gateId = 'GATE204_TJ02D';
  buildTj02Fixture(tmp, { gateId });
  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  const result = evaluateReadiness(context);
  assert.equal(result.authoritative, true);
  assert.equal(result.contextKind, 'STRICT');
  const activationCheck = result.checks.find((c) => c.id === 'ACTIVATION_ANCHOR');
  assert.equal(activationCheck.status, 'PASS');
  const sealCheck = result.checks.find((c) => c.id === 'EXECUTION_SEAL');
  assert.equal(sealCheck.status, 'PASS', 'the real, non-null execution seal must be checked, not skipped');
  assert.equal(result.verdict, 'READY');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-E: activation authority expectedSealSha256 mismatch blocks (FAILED, never PROVEN)', () => {
  const tmp = mkTmp('tj02e-');
  const gateId = 'GATE205_TJ02E';
  buildTj02Fixture(tmp, { gateId, activationExpectedSealSha256: 'a'.repeat(64) });
  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'FAILED');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-F: execution contract hash mismatch blocks (FAILED, never PROVEN)', () => {
  const tmp = mkTmp('tj02f-');
  const gateId = 'GATE206_TJ02F';
  buildTj02Fixture(tmp, { gateId, activationExpectedContractSha256: 'b'.repeat(64) });
  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'FAILED');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-G: an activation authority record identifying a foreign work unit/contract blocks (FAILED, never PROVEN)', () => {
  const tmp = mkTmp('tj02g-');
  const gateId = 'GATE207_TJ02G';
  buildTj02Fixture(tmp, {
    gateId,
    mutateActivationRecord: (r) => ({
      ...r,
      workUnitId: 'GATE_FOREIGN_UNIT',
      executionContractId: 'GATE_FOREIGN_UNIT:R0001'
    })
  });
  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'FAILED');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-H: a coordinated local reseal (contract+seal+activation authority) without corresponding authority-spine corroboration blocks', () => {
  const tmp = mkTmp('tj02h-');
  const gateId = 'GATE208_TJ02H';
  // No START event: the ledger stays genesis-only (UNANCHORED_LEGACY), below the trust
  // required to satisfy authority, even though the local seal/activation authority is internally
  // self-consistent (INTACT on its own).
  buildTj02Fixture(tmp, { gateId, includeStartEvent: false });
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.activation.activated, true);
  assert.ok(view.activation.anchor);
  assert.equal(view.authorityState.consistent, false, 'a genesis-only ledger must never corroborate a local reseal');
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'FAILED');
  assert.equal(context.proofs.ACTIVATION_ANCHOR.reason, 'ACTIVATION_ANCHOR_INTACT_BUT_LEDGER_AUTHORITY_NOT_CONSISTENT');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-I: an activation member exists but the execution seal is unavailable (invalid contract) — never PROVEN', () => {
  const tmp = mkTmp('tj02i-');
  const gateId = 'GATE209_TJ02I';
  // requiredOutputs:[] => requiredArtifacts is empty => validateExecutionContract fails =>
  // sealExecutionContract returns seal:null => view.execution.seal is genuinely unavailable.
  buildTj02Fixture(tmp, {
    gateId,
    mutateContractBody: (c) => ({ ...c, requiredOutputs: [] }),
    activationExpectedSealSha256: 'c'.repeat(64)
  });
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.execution.seal, null, 'fixture bug: the seal must genuinely be unavailable for this test to be meaningful');
  assert.equal(view.activation.activated, true);
  assert.ok(view.activation.anchor, 'a sealed activation member is still structurally present');
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  assert.ok(['FAILED', 'UNKNOWN'].includes(context.proofs.ACTIVATION_ANCHOR.state));
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TJ02-J: the real GATE13 (no activation member) remains an explicit, unchanged NOT_APPLICABLE through the real pipeline', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.activation.activated, false);
  assert.equal(view.activation.anchor, null);
  const context = buildReadinessContext({ adapter, workUnitId: 'GATE13', preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'NOT_APPLICABLE');
  const checks = evaluateReadiness(context).checks;
  const activationCheck = checks.find((c) => c.id === 'ACTIVATION_ANCHOR');
  assert.equal(activationCheck.status, 'SKIP');
});

// =============================================================================
// Cross-cutting: buildReadinessContext's executionSeal is now real/derived, never test-injected.
// =============================================================================

test('CROSS-01: deriveActivationProof called manually with a hand-injected seal is NOT how buildReadinessContext gets its proof (sanity: the two must agree for a real fixture)', () => {
  const tmp = mkTmp('cross01-');
  const gateId = 'GATE210_CROSS01';
  const fixture = buildTj02Fixture(tmp, { gateId });
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  const manualProof = deriveActivationProof({ view, executionContract: view.contract, executionSeal: fixture.realSeal });
  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.equal(manualProof.state, 'PROVEN');
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'PROVEN');
  assert.equal(context.executionSeal.sealSha256, fixture.realSeal.sealSha256, 'the context must derive the SAME seal the adapter computed, never a different/injected one');
  fs.rmSync(tmp, { recursive: true, force: true });
});
