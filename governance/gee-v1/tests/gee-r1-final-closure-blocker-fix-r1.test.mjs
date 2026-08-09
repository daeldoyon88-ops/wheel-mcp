// GOVERNANCE_EXECUTION_EFFICIENCY_V1 — R1_FINAL_CLOSURE_BLOCKER_FIX_R1
// Hostile countertests for the five independently-reproduced blockers:
//  FC-01 self-witness externality enforcement (witness-source.mjs / wheel-project-adapter.mjs)
//  FC-02 PROTECTED_HASH_MISMATCH blocking-by-default policy (wheel-project-adapter.mjs)
//  FC-03 real activation anchor construction (wheel-project-adapter.mjs)
//  FC-04 WorkUnitView schema hardening (work-unit-view.schema.json)
//  FC-05 audit source manifest completeness (verified in the mission's proof package, not here)
// Every fixture below is built under os.tmpdir() and never touches a real governance/ file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createWheelProjectAdapter, ACTIVATION_LEDGER_TRANSITION_TYPE } from '../adapters/wheel/wheel-project-adapter.mjs';
import { mapLegacyGateContractToExecutionView } from '../adapters/wheel/map-gate-contract.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../adapters/wheel/external-authority-policy.mjs';
import { validateLedger, validateLedgerPrefix } from '../../tools/validate-status-ledger.mjs';
import { validateStateRevision } from '../../tools/validate-state-revision.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { loadExternalWitnesses, resolveWitnessSourcePath, isWithinGovernedRoots } from '../core/witness-source.mjs';
import { buildReadinessContext, deriveActivationProof } from '../readiness/build-readiness-context.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
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

function writeWitnessFile(dir, witnesses) {
  const p = path.join(dir, 'witness-fixture.json');
  fs.writeFileSync(p, JSON.stringify({ witnesses }, null, 2));
  return p;
}

function copyRealGovernance(tmpRoot) {
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(tmpRoot, 'governance'), { recursive: true });
}

// =============================================================================
// FC-01 (B01-B04): witness externality — a self-witness can never reach ANCHORED_EXTERNAL.
// =============================================================================

test('FC01-A / B03: a real external TEMP witness still reaches ANCHORED_EXTERNAL through the real adapter', () => {
  const tmp = mkTmp('fc01a-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const witnessDir = mkTmp('fc01a-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'FC01A_EXTERNAL' }]);
  const prevEnv = process.env.GEE_HEAD_WITNESS_SOURCE;
  process.env.GEE_HEAD_WITNESS_SOURCE = witnessPath;
  try {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.equal(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  } finally {
    if (prevEnv === undefined) delete process.env.GEE_HEAD_WITNESS_SOURCE; else process.env.GEE_HEAD_WITNESS_SOURCE = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(witnessDir, { recursive: true, force: true });
  }
});

test('FC01-B / B02: a witness file placed directly under governance/ (self-witness) is never honored', () => {
  const tmp = mkTmp('fc01b-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const selfWitnessPath = path.join(tmp, 'governance', 'SELF_WITNESS.json');
  fs.writeFileSync(selfWitnessPath, JSON.stringify({ witnesses: [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'HOSTILE_SELF_WITNESS' }] }, null, 2));
  const prevEnv = process.env.GEE_HEAD_WITNESS_SOURCE;
  process.env.GEE_HEAD_WITNESS_SOURCE = selfWitnessPath;
  try {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
    assert.equal(view.closure.gateCompleteConfirmed, false);
  } finally {
    if (prevEnv === undefined) delete process.env.GEE_HEAD_WITNESS_SOURCE; else process.env.GEE_HEAD_WITNESS_SOURCE = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FC01-C: a relative witness path that resolves under governance/ (traversal) is never honored', () => {
  const tmp = mkTmp('fc01c-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const hostilePath = path.join(tmp, 'governance', 'gates', 'HOSTILE_WITNESS.json');
  fs.writeFileSync(hostilePath, JSON.stringify({ witnesses: [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TRAVERSAL' }] }, null, 2));
  // A relative path that traverses out of a sibling tmp dir and back into governance/gates/.
  const relativeTraversal = path.relative(path.join(tmp, 'unrelated', 'dir'), hostilePath);
  fs.mkdirSync(path.join(tmp, 'unrelated', 'dir'), { recursive: true });
  const cwdBefore = process.cwd();
  process.chdir(path.join(tmp, 'unrelated', 'dir'));
  try {
    const loaded = loadExternalWitnesses(relativeTraversal, { governedRoots: [path.join(tmp, 'governance')] });
    assert.deepEqual(loaded, []);
  } finally {
    process.chdir(cwdBefore);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FC01-D / B02: a symlink outside governance/ pointing back inside governance/ is never honored (skipped if the platform forbids symlink creation)', (t) => {
  const tmp = mkTmp('fc01d-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const insideTarget = path.join(tmp, 'governance', 'SELF_WITNESS_TARGET.json');
  fs.writeFileSync(insideTarget, JSON.stringify({ witnesses: [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'SYMLINK_INDIRECTION' }] }, null, 2));
  const outsideLink = path.join(os.tmpdir(), `fc01d-link-${process.pid}-${Date.now()}.json`);
  try {
    fs.symlinkSync(insideTarget, outsideLink, 'file');
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    t.skip(`symlink creation not permitted on this platform/account: ${error.code || error.message}`);
    return;
  }
  try {
    const loaded = loadExternalWitnesses(outsideLink, { governedRoots: [path.join(tmp, 'governance')] });
    assert.deepEqual(loaded, []);
  } finally {
    fs.rmSync(outsideLink, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FC01-D-unit: the realpath containment helper itself rejects a governance-resolved path without needing an actual symlink', () => {
  // fs.symlinkSync requires elevated privileges on this Windows account (see the skipped FC01-D
  // test above), so a real symlink cannot be created here. isWithinGovernedRoots is the pure,
  // already-resolved-path comparison FC-01 relies on AFTER fs.realpathSync has followed any
  // symlink chain — exercising it directly with fixtures that model what a symlink's resolved
  // target would look like proves the boundary logic itself, independent of the OS symlink
  // permission gap.
  const tmp = mkTmp('fc01d-unit-');
  const governanceDir = path.join(tmp, 'governance');
  fs.mkdirSync(governanceDir, { recursive: true });
  const realGovernanceDir = fs.realpathSync(governanceDir);
  try {
    // A resolved path that IS the governed root itself.
    assert.equal(isWithinGovernedRoots(realGovernanceDir, [governanceDir]), true);
    // A resolved path nested under the governed root (what a symlink pointing deep inside
    // governance/ would resolve to after fs.realpathSync).
    assert.equal(isWithinGovernedRoots(path.join(realGovernanceDir, 'nested', 'SELF_WITNESS.json'), [governanceDir]), true);
    // A sibling directory that merely SHARES A STRING PREFIX with the governed root
    // ("governance-other" vs "governance") must never be treated as contained — this guards
    // against a naive startsWith() without the path.sep boundary.
    const siblingDir = path.join(tmp, 'governance-other');
    fs.mkdirSync(siblingDir, { recursive: true });
    assert.equal(isWithinGovernedRoots(fs.realpathSync(siblingDir), [governanceDir]), false);
    // A genuinely external resolved path (outside tmp entirely) is never contained.
    assert.equal(isWithinGovernedRoots(fs.realpathSync(os.tmpdir()), [governanceDir]), false);
    // A governed root that does not exist on disk still participates (literal absolute fallback).
    const missingRoot = path.join(tmp, 'governance-does-not-exist');
    assert.equal(isWithinGovernedRoots(path.join(missingRoot, 'x.json'), [missingRoot]), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('FC01-E: a missing witness source never exceeds ANCHORED_APPEND_ONLY', () => {
  const loaded = loadExternalWitnesses(resolveWitnessSourcePath({ env: {}, explicitPath: null }), { governedRoots: [path.join(REPO_ROOT, 'governance')] });
  assert.deepEqual(loaded, []);
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
});

test('FC01-F / B04: a stale external witness (wrong pinned hash) is never honored even though it is genuinely external', () => {
  const tmp = mkTmp('fc01f-');
  copyRealGovernance(tmp);
  const witnessDir = mkTmp('fc01f-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: 'f'.repeat(64), ref: 'STALE_EXTERNAL' }]);
  const prevEnv = process.env.GEE_HEAD_WITNESS_SOURCE;
  process.env.GEE_HEAD_WITNESS_SOURCE = witnessPath;
  try {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  } finally {
    if (prevEnv === undefined) delete process.env.GEE_HEAD_WITNESS_SOURCE; else process.env.GEE_HEAD_WITNESS_SOURCE = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(witnessDir, { recursive: true, force: true });
  }
});

test('B01: self-witness placed inside governance/ is rejected while the real GATE13 view stays schema-valid throughout', () => {
  const tmp = mkTmp('b01-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const selfWitnessPath = path.join(tmp, 'governance', 'nested', 'deep', 'SELF_WITNESS.json');
  fs.mkdirSync(path.dirname(selfWitnessPath), { recursive: true });
  fs.writeFileSync(selfWitnessPath, JSON.stringify({ witnesses: [{ kind: 'INDEPENDENT_AUDIT_RUN_ROOT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'NESTED_SELF_WITNESS' }] }, null, 2));
  const prevEnv = process.env.GEE_HEAD_WITNESS_SOURCE;
  process.env.GEE_HEAD_WITNESS_SOURCE = selfWitnessPath;
  try {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
    assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
    const result = validateAgainstJsonSchema(view, SCHEMA);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  } finally {
    if (prevEnv === undefined) delete process.env.GEE_HEAD_WITNESS_SOURCE; else process.env.GEE_HEAD_WITNESS_SOURCE = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// FC-02 (B05-B08): PROTECTED_HASH_MISMATCH is blocking by default.
// =============================================================================

function buildProtectedHashFixture(repoRoot, { gateId, extraFiles = {}, protectedHashes }) {
  const stateRevision = 'R0001';
  const revRel = `governance/gates/${gateId}/state/revisions/${stateRevision}`;
  const revDir = path.join(repoRoot, revRel);
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/contracts`), { recursive: true });

  for (const [relPath, content] of Object.entries(extraFiles)) {
    const abs = path.join(repoRoot, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const checkpoint = {
    gateId, stateRevision, milestone: 'FC02_FIXTURE', resumePoint: 'fixture', completedTasks: [], openTasks: [],
    reusableEvidence: [], invalidatedEvidence: [], requiredNextActions: [],
    protectedHashes: typeof protectedHashes === 'function' ? protectedHashes() : protectedHashes,
    createdAt: '2026-08-08T00:00:00.000Z'
  };
  const defects = { gateId, stateRevision, defects: [] };
  const contractPtr = { schemaVersion: 1, gateId, contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json` };
  const contractBody = { schemaVersion: 1, gateId, contractId: `${gateId}_SYNTHETIC`, version: 'R0001' };

  const checkpointPath = path.join(revDir, 'CHECKPOINT.json');
  const defectsPath = path.join(revDir, 'OPEN_DEFECTS.json');
  const contractPath = path.join(repoRoot, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`);
  const contractBodyPath = path.join(repoRoot, `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`);

  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
  fs.writeFileSync(defectsPath, JSON.stringify(defects, null, 2));
  fs.writeFileSync(contractPath, JSON.stringify(contractPtr, null, 2));
  fs.writeFileSync(contractBodyPath, JSON.stringify(contractBody, null, 2));

  function member(repoRelativePath, abs) {
    const bytes = fs.readFileSync(abs);
    return { repoRelativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
  }
  const payload = { gateId, stateRevision, purpose: 'FC02_FIXTURE', sealedAt: '2026-08-08T00:00:00.000Z' };
  const seal = {
    schemaVersion: 1, gateId, stateRevision,
    sealedMembers: [
      member(`${revRel}/CHECKPOINT.json`, checkpointPath),
      member(`${revRel}/OPEN_DEFECTS.json`, defectsPath),
      member(`governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`, contractPath)
    ],
    previousStateSealSha256: null, sealedAt: '2026-08-08T00:00:00.000Z', payload, payloadSha256: sha256Canonical(payload)
  };
  const sealPath = path.join(revDir, 'STATE_SEAL.json');
  fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));

  const currentState = {
    schemaVersion: 1, gateId, stateRevision, revisionPath: revRel,
    stateSealSha256: sha256Bytes(fs.readFileSync(sealPath)), committedByTransactionId: 'FC02_FIXTURE'
  };
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/state`), { recursive: true });
  const currentStatePath = path.join(repoRoot, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  fs.writeFileSync(currentStatePath, JSON.stringify(currentState, null, 2));

  const registryPath = path.join(repoRoot, 'governance/GATE_REGISTRY_00_40.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (!registry.gates.some((g) => g.gateId === gateId)) {
    registry.gates.push({ gateId, canonicalObjective: 'FC02 fixture', dependencies: [], definitionCompleteness: 'PARTIAL' });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  }

  return { repoRoot, gateId, currentStatePath };
}

/**
 * FC02-C/FC02-E need a REAL, reproducible historical ledger-prefix pin to prove the downgrade
 * mechanism. Reusing a copy of the real governance/ tree here would require mutating its shared
 * GATE_REGISTRY_00_40.json to register the fixture gate, and validateLedger's FABRICATED_HISTORY
 * check reads that SAME live registry for every ordinal validateLedgerPrefix probes (the fixture
 * gate would have zero GENESIS_IMPORT events within any prefix that doesn't itself append one) —
 * poisoning prefixChainValid for every ordinal regardless of the protected-hash logic under test.
 * A fully self-contained registry+ledger (mirroring buildActivationFixture's approach for FC-03)
 * sidesteps that entirely: the fixture gate's own 2-event ledger is intrinsically consistent with
 * its own registry, so a real, chain-valid, reproducible historical prefix (ordinal 1) exists to
 * pin against. This does not reuse the well-known real-repo a39591... digest (that value is
 * already independently exercised against the live 44-event ledger by HF15/B17/B18) — it proves
 * the same downgrade mechanism generically, against a ledger this test fully owns and controls.
 */
function buildIsolatedProtectedLedgerFixture(repoRoot, { gateId, extraFiles = {}, protectedHashesFactory }) {
  fs.mkdirSync(path.join(repoRoot, 'governance/authority'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'governance/state'), { recursive: true });
  const registryPath = path.join(repoRoot, 'governance/GATE_REGISTRY_00_40.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1, gates: [{ gateId, canonicalObjective: 'FC02 isolated ledger fixture', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  fs.writeFileSync(path.join(repoRoot, 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json'), JSON.stringify({
    gates: [{ gateId, importedStatus: 'NOT_STARTED', historicalDetailCompleteness: 'PARTIAL', fabricatedTransitionCount: 0 }]
  }, null, 2));

  const authoritySha256 = sha256Bytes(fs.readFileSync(registryPath));
  const event1 = {
    schemaVersion: 1, ordinal: 1, eventId: `GENESIS_IMPORT_${gateId}`, gateId, fromStatus: null, toStatus: 'NOT_STARTED',
    transitionType: 'GENESIS_IMPORT', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256,
    previousEventSha256: null, recordedAt: '2026-08-08T00:00:00.000Z'
  };
  const event1Final = { ...event1, eventPayloadSha256: sha256Canonical(event1) };
  const event2 = {
    schemaVersion: 1, ordinal: 2, eventId: `AUTHORIZATION_${gateId}`, gateId, fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED',
    transitionType: 'AUTHORIZATION', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256,
    previousEventSha256: event1Final.eventPayloadSha256, recordedAt: '2026-08-08T00:01:00.000Z'
  };
  const event2Final = { ...event2, eventPayloadSha256: sha256Canonical(event2) };
  const ledgerPath = path.join(repoRoot, LEDGER_REL);
  fs.writeFileSync(ledgerPath, [canonicalize(event1Final), canonicalize(event2Final)].join('\n') + '\n');

  const prefixProbe = validateLedgerPrefix({ root: repoRoot, ledgerPath, throughOrdinal: 1, policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  assert.equal(prefixProbe.prefixChainValid, true, 'fixture bug: the isolated ledger ordinal-1 prefix must itself be chain-valid');
  const historicalPrefixSha256AtOrdinal1 = prefixProbe.prefixSha256;

  const fixture = buildProtectedHashFixture(repoRoot, { gateId, extraFiles, protectedHashes: protectedHashesFactory(historicalPrefixSha256AtOrdinal1) });
  return { ...fixture, historicalPrefixSha256AtOrdinal1 };
}

test('FC02-A / B05: an arbitrary gate-local protected-hash mismatch blocks structurally, even with a valid external witness', () => {
  const tmp = mkTmp('fc02a-');
  copyRealGovernance(tmp);
  const gateId = 'GATE94_FC02A';
  const arbitraryRel = `governance/gates/${gateId}/state/revisions/R0001/ARBITRARY_PROTECTED.json`;
  const fixture = buildProtectedHashFixture(tmp, {
    gateId, extraFiles: { [arbitraryRel]: JSON.stringify({ note: 'arbitrary' }) },
    protectedHashes: [{ path: arbitraryRel, sha256: 'f'.repeat(64) }]
  });
  const canonicalReport = validateStateRevision({ root: tmp, gateId, currentStatePath: fixture.currentStatePath });
  assert.equal(canonicalReport.valid, false);
  assert.ok(canonicalReport.findings.some((f) => f.detectorId === 'PROTECTED_HASH_MISMATCH'));

  // Even with a valid external witness present, the structural violation must still block.
  const ledgerSha256 = realLedgerSha256(tmp);
  const witnessDir = mkTmp('fc02a-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'FC02A_WITNESS' }]);
  const prevEnv = process.env.GEE_HEAD_WITNESS_SOURCE;
  process.env.GEE_HEAD_WITNESS_SOURCE = witnessPath;
  try {
    const view = createWheelProjectAdapter(tmp).getWorkUnitView(gateId);
    assert.equal(view.authorityState.canonicalRevisionStructurallyValid, false);
    assert.equal(view.closure?.gateCompleteConfirmed ?? false, false);
  } finally {
    if (prevEnv === undefined) delete process.env.GEE_HEAD_WITNESS_SOURCE; else process.env.GEE_HEAD_WITNESS_SOURCE = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(witnessDir, { recursive: true, force: true });
  }
});

test('FC02-B / B06: an unknown (non-ledger) protected path mismatch always blocks — no path-based allowlist', () => {
  const tmp = mkTmp('fc02b-');
  copyRealGovernance(tmp);
  const gateId = 'GATE95_FC02B';
  // Point at a real, legitimately-growing shared spine file (the registry) rather than the ledger —
  // this must still block: only the ledger's own historical-prefix proof is ever accepted.
  const fixture = buildProtectedHashFixture(tmp, {
    gateId, protectedHashes: [{ path: 'governance/GATE_REGISTRY_00_40.json', sha256: 'a'.repeat(64) }]
  });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView(gateId);
  assert.equal(view.authorityState.canonicalRevisionStructurallyValid, false);
});

test('FC02-C / B07: a historical ledger-prefix pin that exactly reproduces a real earlier head is downgraded to non-blocking drift', () => {
  const tmp = mkTmp('fc02c-');
  const gateId = 'GATE96_FC02C';
  const fixture = buildIsolatedProtectedLedgerFixture(tmp, {
    gateId,
    protectedHashesFactory: (historicalPrefixSha256) => [{ path: LEDGER_REL, sha256: historicalPrefixSha256 }]
  });
  const canonicalReport = validateStateRevision({ root: tmp, gateId, currentStatePath: fixture.currentStatePath });
  assert.equal(canonicalReport.valid, false, 'canonical validator must still surface the raw mismatch as a finding');
  assert.ok(canonicalReport.findings.some((f) => f.detectorId === 'PROTECTED_HASH_MISMATCH'));

  const view = createWheelProjectAdapter(tmp).getWorkUnitView(gateId);
  assert.equal(view.authorityState.canonicalRevisionStructurallyValid, true, 'a proven historical ledger-prefix pin must downgrade to drift');
  assert.equal(view.authorityState.canonicalRevisionDriftFindingCount, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('FC02-D / B08: a ledger-path protected pin whose expected digest does NOT reproduce any real prefix still blocks', () => {
  const tmp = mkTmp('fc02d-');
  copyRealGovernance(tmp);
  const gateId = 'GATE97_FC02D';
  const fixture = buildProtectedHashFixture(tmp, {
    gateId, protectedHashes: [{ path: LEDGER_REL, sha256: 'b'.repeat(64) }]
  });
  const view = createWheelProjectAdapter(tmp).getWorkUnitView(gateId);
  assert.equal(view.authorityState.canonicalRevisionStructurallyValid, false);
  assert.equal(view.authorityState.canonicalRevisionDriftFindingCount, 0);
});

test('FC02-E: one proven historical drift finding plus one unrelated protected mismatch still blocks overall', () => {
  const tmp = mkTmp('fc02e-');
  const gateId = 'GATE98_FC02E';
  const arbitraryRel = `governance/gates/${gateId}/state/revisions/R0001/ARBITRARY_PROTECTED.json`;
  const fixture = buildIsolatedProtectedLedgerFixture(tmp, {
    gateId,
    extraFiles: { [arbitraryRel]: JSON.stringify({ note: 'arbitrary' }) },
    protectedHashesFactory: (historicalPrefixSha256) => [
      { path: LEDGER_REL, sha256: historicalPrefixSha256 },
      { path: arbitraryRel, sha256: 'f'.repeat(64) }
    ]
  });

  const view = createWheelProjectAdapter(tmp).getWorkUnitView(gateId);
  assert.equal(view.authorityState.canonicalRevisionStructurallyValid, false, 'the unrelated mismatch must still block despite the proven drift finding');
  assert.equal(view.authorityState.canonicalRevisionDriftFindingCount, 1, 'the proven ledger-prefix finding is still separately disclosed as drift');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('B18: the real GATE13 view still reports zero canonical-revision drift and structurally valid', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.equal(view.authorityState.canonicalRevisionStructurallyValid, true);
  assert.equal(view.authorityState.canonicalRevisionDriftFindingCount, 0);
});

// =============================================================================
// FC-03 (B09-B10): real activation anchor construction, adapter -> strict readiness.
// =============================================================================

// R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: default status is IN_PROGRESS because
// includeAuthorizationEvent=true now also appends a real START event (see below) that pins the
// activation-authority artifact — STATE_SEAL's claimed executionStatus must agree with where that
// START event actually leaves the ledger, or authorityState.consistent goes false first.
function buildActivationFixture(repoRoot, { gateId, includeAuthorizationEvent = true, sealExecutionStatus = 'IN_PROGRESS' }) {
  const revRel = `governance/gates/${gateId}/state/revisions/R0001`;
  const revDir = path.join(repoRoot, revRel);
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/contracts`), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'governance/authority'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'governance/state'), { recursive: true });

  const registryPath = path.join(repoRoot, 'governance/GATE_REGISTRY_00_40.json');
  const registry = { schemaVersion: 1, gates: [{ gateId, canonicalObjective: 'FC-03 activation fixture', dependencies: [], definitionCompleteness: 'PARTIAL' }] };
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  const contractPtr = { schemaVersion: 1, gateId, contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json` };
  const contractBody = {
    gateId, contractRevision: 'R0001',
    positiveTests: ['t1'], negativeTests: ['n1'], countertests: ['c1'],
    canonicalRequirements: [{ requirementId: 'REQ-1' }], requiredOutputs: [], closureConditions: ['done']
  };
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`), JSON.stringify(contractPtr, null, 2));
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`), JSON.stringify(contractBody, null, 2));

  // Compute the contract exactly as the real adapter would (same mapping function, same inputs).
  const mapped = mapLegacyGateContractToExecutionView(contractBody, { objective: registry.gates[0].canonicalObjective, prerequisites: [] });
  const expectedContractSha256 = sha256Canonical(mapped.contract);

  // Stand-in for the "sealed execution contract" type build-readiness-context.mjs documents as not
  // yet existing for legacy Wheel gates (its own executionSeal is hardcoded null). This is what lets
  // the generic, already-correct deriveActivationProof/validateActivationAnchor be proven end to end.
  const executionSeal = { schemaVersion: 1, sealSha256: sha256Canonical({ fixture: 'FC03_EXECUTION_SEAL', gateId }) };

  const activationRecord = {
    schemaVersion: 1, authorityKind: 'EXECUTION_CONTRACT_ACTIVATION', workUnitId: gateId,
    executionContractId: mapped.contract.id, executionContractVersion: mapped.contract.version,
    expectedContractSha256, expectedSealSha256: executionSeal.sealSha256, activatedAt: '2026-08-08T00:00:00.000Z'
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

  function member(repoRelativePath, abs) {
    const bytes = fs.readFileSync(abs);
    return { repoRelativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
  }
  const payload = { gateId, stateRevision: 'R0001', executionStatus: sealExecutionStatus, purpose: 'FC03_FIXTURE' };
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
    stateSealSha256: sha256Bytes(fs.readFileSync(sealPath)), committedByTransactionId: 'FC03_FIXTURE'
  };
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/state`), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, `governance/gates/${gateId}/state/CURRENT_STATE.json`), JSON.stringify(currentState, null, 2));

  const sourceMap = { gates: [{ gateId, importedStatus: 'NOT_STARTED', historicalDetailCompleteness: 'PARTIAL', fabricatedTransitionCount: 0 }] };
  fs.writeFileSync(path.join(repoRoot, 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json'), JSON.stringify(sourceMap, null, 2));

  const authoritySha256 = sha256Bytes(fs.readFileSync(registryPath));
  const event1 = {
    schemaVersion: 1, ordinal: 1, eventId: `GENESIS_IMPORT_${gateId}`, gateId, fromStatus: null, toStatus: 'NOT_STARTED',
    transitionType: 'GENESIS_IMPORT', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256,
    previousEventSha256: null, recordedAt: '2026-08-08T00:00:00.000Z'
  };
  const event1Final = { ...event1, eventPayloadSha256: sha256Canonical(event1) };
  const lines = [canonicalize(event1Final)];
  if (includeAuthorizationEvent) {
    const event2 = {
      schemaVersion: 1, ordinal: 2, eventId: `AUTHORIZATION_${gateId}`, gateId, fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED',
      transitionType: 'AUTHORIZATION', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256,
      previousEventSha256: event1Final.eventPayloadSha256, recordedAt: '2026-08-08T00:01:00.000Z'
    };
    const event2Final = { ...event2, eventPayloadSha256: sha256Canonical(event2) };
    lines.push(canonicalize(event2Final));

    // R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: pin the canonical activation transition (START) to
    // the EXACT live bytes of the activation-authority artifact this fixture just wrote.
    const event3 = {
      schemaVersion: 1, ordinal: 3, eventId: `${ACTIVATION_LEDGER_TRANSITION_TYPE}_${gateId}`, gateId,
      fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS',
      transitionType: ACTIVATION_LEDGER_TRANSITION_TYPE, authorityPath: activationRel,
      authoritySha256: sha256Bytes(fs.readFileSync(path.join(repoRoot, activationRel))),
      previousEventSha256: event2Final.eventPayloadSha256, recordedAt: '2026-08-08T00:02:00.000Z'
    };
    const event3Final = { ...event3, eventPayloadSha256: sha256Canonical(event3) };
    lines.push(canonicalize(event3Final));
  }
  fs.writeFileSync(path.join(repoRoot, LEDGER_REL), lines.join('\n') + '\n');

  return { repoRoot, gateId, sealPath, executionSeal, mappedContract: mapped.contract };
}

function resealWithDifferentStatus(repoRoot, gateId, newExecutionStatus) {
  const revRel = `governance/gates/${gateId}/state/revisions/R0001`;
  const sealPath = path.join(repoRoot, revRel, 'STATE_SEAL.json');
  const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  seal.payload = { ...seal.payload, executionStatus: newExecutionStatus };
  seal.payloadSha256 = sha256Canonical(seal.payload);
  fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));
  const currentStatePath = path.join(repoRoot, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  const currentState = JSON.parse(fs.readFileSync(currentStatePath, 'utf8'));
  currentState.stateSealSha256 = sha256Bytes(fs.readFileSync(sealPath));
  fs.writeFileSync(currentStatePath, JSON.stringify(currentState, null, 2));
}

test('FC03-A / B09: real adapter fixture with a validated activation member and matching ledger authority proves PROVEN', () => {
  const tmp = mkTmp('fc03a-');
  const gateId = 'GATE99_FC03A';
  const fixture = buildActivationFixture(tmp, { gateId });
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.activation.activated, true);
  assert.ok(view.activation.anchor, 'the real adapter must populate a real anchor, not null, for a genuine sealed member');
  assert.equal(view.authorityState.consistent, true, 'the real ledger must corroborate this fixture');

  const proof = deriveActivationProof({ view, executionContract: view.contract, executionSeal: fixture.executionSeal });
  assert.equal(proof.state, 'PROVEN');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('FC03-B / B10: a coordinated local reseal that disagrees with the unchanged ledger blocks (INTACT locally, FAILED overall)', () => {
  const tmp = mkTmp('fc03b-');
  const gateId = 'GATE100_FC03B';
  const fixture = buildActivationFixture(tmp, { gateId });
  // The fixture's real ledger (via its START event) now ends at IN_PROGRESS, so the disagreement
  // this test needs must target a DIFFERENT claimed status.
  resealWithDifferentStatus(tmp, gateId, 'REPAIR_REQUIRED');
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.activation.activated, true);
  assert.ok(view.activation.anchor);
  assert.equal(view.authorityState.consistent, false, 'the ledger still says IN_PROGRESS while the reseal claims REPAIR_REQUIRED');

  const proof = deriveActivationProof({ view, executionContract: view.contract, executionSeal: fixture.executionSeal });
  assert.equal(proof.state, 'FAILED');
  assert.equal(proof.reason, 'ACTIVATION_ANCHOR_INTACT_BUT_LEDGER_AUTHORITY_NOT_CONSISTENT');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('FC03-C: an activation member exists but the ledger carries no corroborating (non-genesis) authority — BLOCKED', () => {
  const tmp = mkTmp('fc03c-');
  const gateId = 'GATE101_FC03C';
  const fixture = buildActivationFixture(tmp, { gateId, includeAuthorizationEvent: false });
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.activation.activated, true);
  assert.ok(view.activation.anchor);
  assert.equal(view.authorityState.consistent, false, 'a genesis-only ledger entry is UNANCHORED_LEGACY, below the trust required to satisfy authority');

  const proof = deriveActivationProof({ view, executionContract: view.contract, executionSeal: fixture.executionSeal });
  assert.equal(proof.state, 'FAILED');

  const context = buildReadinessContext({ adapter, workUnitId: gateId, preflightOk: true });
  assert.notEqual(context.proofs.ACTIVATION_ANCHOR.state, 'NOT_APPLICABLE');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('FC03-D: GATE13 with no activation member remains an explicit, unchanged NOT_APPLICABLE', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.activation.activated, false);
  assert.equal(view.activation.anchor, null);
  const context = buildReadinessContext({ adapter, workUnitId: 'GATE13', preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'NOT_APPLICABLE');
});

// =============================================================================
// FC-04 (B11-B13): WorkUnitView schema hardening.
// =============================================================================

test('FC04-A / B11: the real GATE13 WorkUnitView validates against the hardened schema', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  const result = validateAgainstJsonSchema(view, SCHEMA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('FC04-B / B12: closure.gateCompleteConfirmed="yes" (and other malformed closure shapes) are schema-INVALID', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.equal(validateAgainstJsonSchema({ ...view, closure: { gateCompleteConfirmed: 'yes' } }, SCHEMA).valid, false);
  assert.equal(validateAgainstJsonSchema({ ...view, closure: { ...view.closure, finalClosureTrustLevel: 'NOT_A_REAL_LEVEL' } }, SCHEMA).valid, false);
  assert.equal(validateAgainstJsonSchema({ ...view, closure: { ...view.closure, extraUnknownField: 1 } }, SCHEMA).valid, false);
});

test('FC04-C / B13: evidence=[123] and malformed evidence items are schema-INVALID', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.equal(validateAgainstJsonSchema({ ...view, evidence: [123] }, SCHEMA).valid, false);
  assert.equal(validateAgainstJsonSchema({ ...view, evidence: [{ kind: 'STATE_SEAL', verified: 'yes' }] }, SCHEMA).valid, false);
  assert.equal(validateAgainstJsonSchema({ ...view, evidence: [{ path: 'x', verified: true }] }, SCHEMA).valid, false);
});

test('FC04-D: an invalid trust enum value anywhere in the view is schema-INVALID', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.equal(validateAgainstJsonSchema({ ...view, authorityState: { ...view.authorityState, trustLevel: 'MADE_UP' } }, SCHEMA).valid, false);
});

test('FC04-E: an unknown top-level normative field is schema-INVALID', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.equal(validateAgainstJsonSchema({ ...view, unexpectedField: 'x' }, SCHEMA).valid, false);
});

// =============================================================================
// B14: the production strict CLI remains authoritative with a valid external witness fixture.
// =============================================================================

test('B14: the real production CLI stays authoritative:true / contextKind:STRICT for GATE13 with a valid external witness configured', () => {
  const witnessDir = mkTmp('b14-witness-');
  const witnessPath = writeWitnessFile(witnessDir, [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: realLedgerSha256(REPO_ROOT), ref: 'B14_CLI_WITNESS' }]);
  const run = spawnSync(process.execPath, [CLI, '--root', REPO_ROOT, '--work-unit', 'GATE13'], {
    encoding: 'utf8',
    env: { ...process.env, GEE_HEAD_WITNESS_SOURCE: witnessPath }
  });
  assert.ok(run.status === 0 || run.status === 2, `CLI must exit 0 (READY) or 2 (BLOCKED), got ${run.status}: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.authoritative, true);
  assert.equal(out.contextKind, 'STRICT');
  fs.rmSync(witnessDir, { recursive: true, force: true });
});

test('B14b: a self-witness supplied to the real production CLI never grants authoritative closure', () => {
  const tmp = mkTmp('b14b-');
  copyRealGovernance(tmp);
  const ledgerSha256 = realLedgerSha256(tmp);
  const selfWitnessPath = path.join(tmp, 'governance', 'SELF_WITNESS.json');
  fs.writeFileSync(selfWitnessPath, JSON.stringify({ witnesses: [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'B14B_SELF_WITNESS' }] }, null, 2));
  const run = spawnSync(process.execPath, [CLI, '--root', tmp, '--work-unit', 'GATE13'], {
    encoding: 'utf8',
    env: { ...process.env, GEE_HEAD_WITNESS_SOURCE: selfWitnessPath }
  });
  const out = JSON.parse(run.stdout);
  assert.equal(out.authoritative, true);
  assert.equal(out.contextKind, 'STRICT');
  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATE13');
  assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
  fs.rmSync(tmp, { recursive: true, force: true });
});
