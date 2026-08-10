import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../adapters/wheel/external-authority-policy.mjs';
import { validateLedger, validateLedgerPrefix } from '../../tools/validate-status-ledger.mjs';
import { validateStateRevision } from '../../tools/validate-state-revision.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { validateActivationAnchor } from '../contracts/validate-activation-anchor.mjs';
import { createActivationAuthority } from '../contracts/activation-anchor.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { buildReadinessContext, deriveActivationProof } from '../readiness/build-readiness-context.mjs';
import { requireVerifiedState } from '../core/authoritative-state.mjs';
import { loadExternalWitnesses, resolveWitnessSourcePath } from '../core/witness-source.mjs';
import { verifyHeadWitness } from '../core/head-witness.mjs';
import { resolveOpenDefectsKnowledgeFromJsonText } from '../contracts/validate-open-defects-knowledge.mjs';
import { writeSyntheticStateSealAuthority } from './helpers/synthetic-state-seal-authority.mjs';
import { sha256Canonical, sha256Bytes, canonicalize } from '../../tools/canonical-json.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schemas', 'work-unit-view.schema.json'), 'utf8'));
const LEDGER_REL = 'governance/state/GATE_STATUS_LEDGER.ndjson';

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function realLedgerSha256() {
  const report = validateLedger({ root: REPO_ROOT, ledgerPath: path.join(REPO_ROOT, LEDGER_REL), policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  return report.ledgerSha256;
}

function writeWitnessFile(tmpDir, witnesses) {
  const p = path.join(tmpDir, 'witness-fixture.json');
  fs.writeFileSync(p, JSON.stringify({ witnesses }, null, 2));
  return p;
}

// ----- HF01: no witness configured -> ANCHORED_EXTERNAL impossible -----
test('HF01: adapter with no witness source configured never reaches ANCHORED_EXTERNAL', () => {
  const loaded = loadExternalWitnesses(resolveWitnessSourcePath({ env: {}, explicitPath: null }));
  assert.deepEqual(loaded, []);
  const trust = verifyHeadWitness({ ledgerSha256: 'a'.repeat(64), chainValid: true, hasNonGenesisTransition: true, witnesses: loaded });
  assert.equal(trust.trustLevel, 'ANCHORED_APPEND_ONLY');

  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.notEqual(view.state.trustLevel, 'ANCHORED_EXTERNAL');
});

// ----- HF02: valid external witness fixture -> ANCHORED_EXTERNAL -----
test('HF02: a real, valid external witness fixture upgrades trust to ANCHORED_EXTERNAL', () => {
  const tmp = mkTmp('hf02-');
  const ledgerSha256 = realLedgerSha256();
  const witnessPath = writeWitnessFile(tmp, [
    { kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'TEST_FIXTURE_ONLY' }
  ]);
  const loaded = loadExternalWitnesses(witnessPath);
  assert.equal(loaded.length, 1);
  const trust = verifyHeadWitness({ ledgerSha256, chainValid: true, hasNonGenesisTransition: true, witnesses: loaded });
  assert.equal(trust.trustLevel, 'ANCHORED_EXTERNAL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF03: stale witness -> rejected -----
test('HF03: a stale witness (wrong pinned hash) never upgrades trust', () => {
  const tmp = mkTmp('hf03-');
  const witnessPath = writeWitnessFile(tmp, [
    { kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: 'f'.repeat(64), ref: 'STALE' }
  ]);
  const loaded = loadExternalWitnesses(witnessPath);
  const trust = verifyHeadWitness({ ledgerSha256: realLedgerSha256(), chainValid: true, hasNonGenesisTransition: true, witnesses: loaded });
  assert.equal(trust.trustLevel, 'ANCHORED_APPEND_ONLY');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF04: wrong-shaped / unverified witness -> rejected -----
test('HF04: a structurally invalid or unverified witness never upgrades trust', () => {
  const tmp = mkTmp('hf04-');
  const ledgerSha256 = realLedgerSha256();
  const witnessPath = writeWitnessFile(tmp, [
    { kind: 'GIT_OBJECT', verified: false, pinnedLedgerSha256: ledgerSha256, ref: 'UNVERIFIED' },
    { kind: 'NOT_A_REAL_KIND', verified: true, pinnedLedgerSha256: ledgerSha256, ref: 'BAD_KIND' },
    { verified: true, pinnedLedgerSha256: ledgerSha256 } // missing kind/ref
  ]);
  const loaded = loadExternalWitnesses(witnessPath);
  assert.deepEqual(loaded, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF05 / HF06: closure trust gate -----
test('HF05: modern closure at ANCHORED_APPEND_ONLY only is never final-authoritative', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.state.value, 'COMPLETE_CONFIRMED');
  assert.equal(view.state.trustLevel, 'ANCHORED_APPEND_ONLY');
  assert.equal(view.closure.gateCompleteConfirmed, false);
});

test('HF06: modern closure becomes final-authoritative once ANCHORED_EXTERNAL is reached', () => {
  const tmp = mkTmp('hf06-');
  const witnessPath = writeWitnessFile(tmp, [
    { kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: realLedgerSha256(), ref: 'TEST_FIXTURE_ONLY' }
  ]);
  const prevEnv = process.env.GEE_HEAD_WITNESS_SOURCE;
  process.env.GEE_HEAD_WITNESS_SOURCE = witnessPath;
  try {
    const adapter = createWheelProjectAdapter(REPO_ROOT);
    const view = adapter.getWorkUnitView('GATE13');
    assert.equal(view.state.trustLevel, 'ANCHORED_EXTERNAL');
    assert.equal(view.closure.gateCompleteConfirmed, true);
  } finally {
    if (prevEnv === undefined) delete process.env.GEE_HEAD_WITNESS_SOURCE;
    else process.env.GEE_HEAD_WITNESS_SOURCE = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ----- HF07: coordinated reseal cannot restore authoritative INTACT -----
test('HF07: a coordinated local reseal is locally INTACT but FAILS the activation proof when the ledger authority disagrees', () => {
  const tmp = mkTmp('hf07-');
  const execution = { schemaVersion: 1, id: 'HF07_WU', version: 'R0002', contractKind: 'EXECUTION' };
  const seal = { schemaVersion: 1, sealSha256: sha256Canonical({ resealed: true }) };
  const auth = createActivationAuthority({
    workUnitId: 'HF07_WU',
    executionContractId: execution.id,
    executionContractVersion: execution.version,
    expectedContractSha256: sha256Canonical(execution),
    expectedSealSha256: seal.sealSha256,
    activatedAt: '2026-08-08T00:00:00.000Z'
  });
  const synth = writeSyntheticStateSealAuthority(tmp, { gateId: 'GATE82', activationRecord: auth.record });
  const activationAnchor = {
    record: auth.record,
    activationId: auth.activationId,
    authority: { kind: 'STATE_SEAL_MEMBER', repoRoot: tmp, sealPath: synth.sealPath, memberRepoRelativePath: synth.memberRepoRelativePath }
  };

  const localAnchorResult = validateActivationAnchor({ contract: execution, seal, activationAnchor, activationState: 'ACTIVATED', requireActivationAnchor: true });
  assert.equal(localAnchorResult.status, 'INTACT');

  // R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: a real ledgerBinding=PROVEN (a canonical ledger
  // transition actually pinning this exact activation-authority artifact) must ALSO be present —
  // authorityState.consistent alone (the FINAL-03 check) is necessary but no longer sufficient.
  const provenLedgerBinding = { state: 'PROVEN', eventOrdinal: 3, eventId: 'START_HF07_WU', authorityPath: synth.memberRepoRelativePath, authoritySha256: sha256Bytes(fs.readFileSync(path.join(tmp, synth.memberRepoRelativePath))) };

  const consistentProof = deriveActivationProof({
    view: { activation: { activated: true, anchor: activationAnchor, source: 'test', ledgerBinding: provenLedgerBinding }, authorityState: { consistent: true } },
    executionContract: execution,
    executionSeal: seal
  });
  assert.equal(consistentProof.state, 'PROVEN');

  const resealedProof = deriveActivationProof({
    view: { activation: { activated: true, anchor: activationAnchor, source: 'test', ledgerBinding: provenLedgerBinding }, authorityState: { consistent: false, reason: 'NO_MATCHING_LEDGER_TRANSITION_FOR_RESEALED_REVISION' } },
    executionContract: execution,
    executionSeal: seal
  });
  assert.equal(resealedProof.state, 'FAILED');
  assert.equal(resealedProof.reason, 'ACTIVATION_ANCHOR_INTACT_BUT_LEDGER_AUTHORITY_NOT_CONSISTENT');

  // HF07b: this is the exact residual gap the independent audit reproduced — authorityState stays
  // "consistent" (same generic status string, e.g. because only the seal/activation-authority were
  // coordinately rewritten) while the ledger STILL pins the OLD (pre-reseal) activation-authority
  // bytes. Status-string consistency alone must never be read as PROVEN.
  const mismatchedLedgerBinding = { state: 'FAILED', reason: 'ACTIVATION_LEDGER_BINDING_AUTHORITY_SHA_MISMATCH', eventOrdinal: 3, eventId: 'START_HF07_WU' };
  const coordinatedResealProof = deriveActivationProof({
    view: { activation: { activated: true, anchor: activationAnchor, source: 'test', ledgerBinding: mismatchedLedgerBinding }, authorityState: { consistent: true } },
    executionContract: execution,
    executionSeal: seal
  });
  assert.equal(coordinatedResealProof.state, 'FAILED', 'authorityState.consistent===true must never rescue a ledger-binding mismatch');
  assert.equal(coordinatedResealProof.reason, 'ACTIVATION_LEDGER_BINDING_AUTHORITY_SHA_MISMATCH');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF08 / HF09: canonical revision structural checks -----
test('HF08: stateRevision/revisionPath mismatch is rejected by the canonical validator', () => {
  const tmp = mkTmp('hf08-');
  const gateId = 'GATE83';
  fs.mkdirSync(path.join(tmp, 'governance', 'gates', gateId, 'state', 'revisions', 'R0001'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance', 'gates', gateId, 'state', 'CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1, gateId, stateRevision: 'R0009', revisionPath: `governance/gates/${gateId}/state/revisions/R0009`, stateSealSha256: 'a'.repeat(64), committedByTransactionId: 'X'
  }));
  const checkpoint = { gateId, stateRevision: 'R0001', milestone: 'M', resumePoint: 'x', completedTasks: [], openTasks: [], reusableEvidence: [], invalidatedEvidence: [], requiredNextActions: [], protectedHashes: [], createdAt: '2026-01-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(tmp, 'governance', 'gates', gateId, 'state', 'revisions', 'R0001', 'CHECKPOINT.json'), JSON.stringify(checkpoint));
  fs.writeFileSync(path.join(tmp, 'governance', 'gates', gateId, 'state', 'revisions', 'R0001', 'OPEN_DEFECTS.json'), JSON.stringify({ gateId, stateRevision: 'R0001', defects: [] }));

  const report = validateStateRevision({ root: tmp, gateId });
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.detectorId === 'POINTER_TARGET_MISSING'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('HF09: a foreign revision path outside the gate own subtree is rejected by adapter identity binding', () => {
  const tmp = mkTmp('hf09-');
  const gateId = 'GATE84';
  const otherGateId = 'GATE85';
  fs.mkdirSync(path.join(tmp, 'governance', 'gates', otherGateId, 'state', 'revisions', 'R0001'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'governance', 'gates', gateId, 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance', 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1, gates: [{ gateId, canonicalObjective: 'x', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }));
  fs.writeFileSync(path.join(tmp, 'governance', 'gates', gateId, 'state', 'CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1, gateId, stateRevision: 'R0001', revisionPath: `governance/gates/${otherGateId}/state/revisions/R0001`, stateSealSha256: 'a'.repeat(64)
  }));
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.authorityState.statusKnowledge, 'IDENTITY_BINDING_VIOLATION');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF10 / HF11: WorkUnitView schema -----
test('HF10: the real GATE13 WorkUnitView validates against the canonical schema', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  const result = validateAgainstJsonSchema(view, SCHEMA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('HF11: an unknown top-level property and an invalid authorityState/activation are both schema-invalid', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(validateAgainstJsonSchema({ ...view, unexpectedField: 'x' }, SCHEMA).valid, false);
  assert.equal(validateAgainstJsonSchema({ ...view, authorityState: { ...view.authorityState, consistent: 'yes' } }, SCHEMA).valid, false);
  assert.equal(validateAgainstJsonSchema({ ...view, activation: { ...view.activation, activated: 'true' } }, SCHEMA).valid, false);
});

// ----- HF12: single closure authority -----
test('HF12: ledger not complete + seal complete -> closure is not complete', () => {
  const tmp = mkTmp('hf12-');
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(tmp, 'governance'), { recursive: true });
  const ledgerPath = path.join(tmp, LEDGER_REL);
  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 56);
  const historicalPrefix = lines.slice(0, 44).join('\n') + '\n';
  assert.equal(
    sha256Bytes(Buffer.from(historicalPrefix, 'utf8')),
    '304a75d6675690e722a84d30fb576007dd34cad9cf0a72052cc338e579077478'
  );
  // Drop the final EXTERNAL_CONFIRMATION event: GATE13 stays at COMPLETE_AGENT on the ledger,
  // while STATE_SEAL R0002 (untouched) still declares COMPLETE_CONFIRMED.
  fs.writeFileSync(ledgerPath, lines.slice(0, 43).join('\n') + '\n');

  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.state.value, 'COMPLETE_AGENT');
  assert.equal(view.authorityState.consistent, false);
  assert.equal(view.closure.gateCompleteConfirmed, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF13 / HF14: generic ledger policy vs Wheel policy -----
test('HF13: the generic core ledger validator source contains no GATE12-specific report literal', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'governance', 'tools', 'validate-status-ledger.mjs'), 'utf8');
  assert.equal(src.includes('GATE12_L3_RECLOSURE_R1_EXTERNAL_REINSPECTION_REPORT'), false);
});

test('HF13b: without any policy, COMPLETE_CONFIRMED can never be independently verified (fail-closed default)', () => {
  const report = validateLedger({ root: REPO_ROOT, ledgerPath: path.join(REPO_ROOT, LEDGER_REL) });
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.detectorId === 'COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION'));
});

test('HF14: the Wheel-specific policy still enforces the applicable Wheel requirement end to end', () => {
  const report = validateLedger({ root: REPO_ROOT, ledgerPath: path.join(REPO_ROOT, LEDGER_REL), policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  assert.equal(report.valid, true);
  const prefix = validateLedgerPrefix({
    root: REPO_ROOT,
    ledgerPath: path.join(REPO_ROOT, LEDGER_REL),
    throughOrdinal: 44,
    expectedPrefixSha256: '304a75d6675690e722a84d30fb576007dd34cad9cf0a72052cc338e579077478',
    policy: WHEEL_EXTERNAL_AUTHORITY_POLICY
  });
  assert.equal(prefix.matchesExpectedHistoricalDigest, true);
  assert.equal(prefix.prefixChainValid, true);
});

// ----- HF15 / HF16: historical prefix vs current authority -----
test('HF15: the historical ledger prefix at ordinal 41 reproduces the exact pinned historical digest', () => {
  const result = validateLedgerPrefix({
    root: REPO_ROOT,
    ledgerPath: path.join(REPO_ROOT, LEDGER_REL),
    throughOrdinal: 41,
    expectedPrefixSha256: 'a39591873658989062cedfc96f2acd9415311950b94ee98ffb0d65575e3ecec5',
    policy: WHEEL_EXTERNAL_AUTHORITY_POLICY
  });
  assert.equal(result.matchesExpectedHistoricalDigest, true);
  assert.equal(result.prefixChainValid, true);
});

test('HF16: the current ledger preserves the frozen GATE13 closure prefix and derives GATE13 = COMPLETE_CONFIRMED', () => {
  const report = validateLedger({ root: REPO_ROOT, ledgerPath: path.join(REPO_ROOT, LEDGER_REL), policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  const prefix = validateLedgerPrefix({
    root: REPO_ROOT,
    ledgerPath: path.join(REPO_ROOT, LEDGER_REL),
    throughOrdinal: 44,
    expectedPrefixSha256: '304a75d6675690e722a84d30fb576007dd34cad9cf0a72052cc338e579077478',
    policy: WHEEL_EXTERNAL_AUTHORITY_POLICY
  });
  assert.equal(prefix.matchesExpectedHistoricalDigest, true);
  assert.equal(prefix.prefixChainValid, true);
  const gate13 = report.gates.find((g) => g.gateId === 'GATE13');
  assert.equal(gate13.currentStatus, 'COMPLETE_CONFIRMED');
});

// ----- HF17 / HF18: readiness context isolation -----
test('HF17: legacy readiness invocation can never yield an authoritative modern READY', () => {
  const result = evaluateReadiness({
    workUnitId: 'HF17_FAKE',
    strategicContract: { schemaVersion: 1, contractKind: 'STRATEGIC', id: 'HF17_FAKE', type: 'GATE', version: 'R0001', objective: 'fake', prerequisites: [], invariants: [], authorizedVerdicts: ['NOT_STARTED'] },
    executionContract: null,
    requireSeal: false,
    authorityState: { consistent: true },
    preflightOk: true,
    defectsOpenCount: 0,
    defectsOpenKnowledge: 'KNOWN_ZERO'
  });
  assert.equal(result.authoritative, false);
  assert.equal(result.contextKind, 'LEGACY_NON_AUTHORITATIVE');
});

test('HF18: the strict ReadinessContext path is the only one that yields authoritative:true', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const context = buildReadinessContext({ adapter, workUnitId: 'GATE13', preflightOk: true });
  const result = evaluateReadiness(context);
  assert.equal(result.authoritative, true);
  assert.equal(result.contextKind, 'STRICT');
});

// ----- HF19 / HF20: defect enum + raw status regressions -----
test('HF19: an unknown/unmapped defect status yields UNKNOWN, never KNOWN_ZERO', () => {
  const resolved = resolveOpenDefectsKnowledgeFromJsonText(JSON.stringify({ gateId: 'X', stateRevision: 'R0001', defects: [{ defectId: 'D1', status: 'resolved-ish', severity: 'LOW' }] }));
  assert.equal(resolved.defectsOpenKnowledge, 'UNKNOWN');
});

test('HF20: raw COMPLETE_CONFIRMED without verified authority never satisfies a prerequisite', () => {
  const fakeState = { value: 'COMPLETE_CONFIRMED', verified: false, trustLevel: 'ANCHORED_EXTERNAL', identityBinding: 'BOUND' };
  const result = requireVerifiedState(fakeState, { allow: ['COMPLETE_CONFIRMED'], minTrustLevel: 'ANCHORED_APPEND_ONLY' });
  assert.equal(result.satisfied, false);
  assert.equal(result.value, 'UNKNOWN');
});

// ----- HF21: future GATE41-class fixture -----
test('HF21: a future, non-hardcoded work unit id traverses the real adapter with no core edits', () => {
  const tmp = mkTmp('hf21-');
  const gateId = 'GATE41';
  fs.mkdirSync(path.join(tmp, 'governance', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'governance', 'authority'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance', 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1, gates: [{ gateId, canonicalObjective: 'future gate', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }));
  const sourceMap = { gates: [{ gateId, importedStatus: 'NOT_STARTED', historicalDetailCompleteness: 'PARTIAL', fabricatedTransitionCount: 0 }] };
  fs.writeFileSync(path.join(tmp, 'governance', 'authority', 'GENESIS_IMPORT_SOURCE_MAP.json'), JSON.stringify(sourceMap));
  const authorityBytes = fs.readFileSync(path.join(tmp, 'governance', 'GATE_REGISTRY_00_40.json'));
  const event0 = {
    schemaVersion: 1, ordinal: 1, eventId: `GENESIS_IMPORT_${gateId}`, gateId, fromStatus: null, toStatus: 'NOT_STARTED',
    transitionType: 'GENESIS_IMPORT', authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256: sha256Bytes(authorityBytes),
    previousEventSha256: null, recordedAt: '2026-08-08T00:00:00.000Z'
  };
  const eventPayloadSha256 = sha256Canonical(event0);
  const finalEvent = { ...event0, eventPayloadSha256 };
  fs.writeFileSync(path.join(tmp, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'), `${canonicalize(finalEvent)}\n`);

  const adapter = createWheelProjectAdapter(tmp);
  assert.deepEqual(adapter.listWorkUnitIds(), [gateId]);
  const view = adapter.getWorkUnitView(gateId);
  assert.equal(view.workUnitId, gateId);
  assert.equal(view.state.value, 'NOT_STARTED');
  const result = validateAgainstJsonSchema(view, SCHEMA);
  assert.deepEqual(result.errors, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF22: cross-gate STATE_SEAL / revision -----
test('HF22: a valid STATE_SEAL belonging to a foreign gate is rejected, not silently trusted', () => {
  const tmp = mkTmp('hf22-');
  const gateId = 'GATE86';
  const revDir = path.join(tmp, 'governance', 'gates', gateId, 'state', 'revisions', 'R0001');
  fs.mkdirSync(revDir, { recursive: true });
  const foreignSeal = { schemaVersion: 1, gateId: 'GATE99_NOT_THIS_GATE', stateRevision: 'R0001', payload: { executionStatus: 'COMPLETE_CONFIRMED' } };
  fs.writeFileSync(path.join(revDir, 'STATE_SEAL.json'), JSON.stringify(foreignSeal));
  fs.writeFileSync(path.join(tmp, 'governance', 'GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1, gates: [{ gateId, canonicalObjective: 'x', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }));
  fs.writeFileSync(path.join(tmp, 'governance', 'gates', gateId, 'state', 'CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1, gateId, stateRevision: 'R0001', revisionPath: `governance/gates/${gateId}/state/revisions/R0001`, stateSealSha256: sha256Bytes(fs.readFileSync(path.join(revDir, 'STATE_SEAL.json')))
  }));
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView(gateId);
  assert.notEqual(view.authorityState.statusKnowledge, 'SEAL_VERIFIED');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- HF23: witness absent -> never auto-generated/promoted -----
test('HF23: an absent witness source is never auto-generated or silently promoted', () => {
  const loaded = loadExternalWitnesses(null);
  assert.deepEqual(loaded, []);
  const loadedMissingFile = loadExternalWitnesses(path.join(os.tmpdir(), 'this-file-does-not-exist-hf23.json'));
  assert.deepEqual(loadedMissingFile, []);
  const trust = verifyHeadWitness({ ledgerSha256: realLedgerSha256(), chainValid: true, hasNonGenesisTransition: true, witnesses: loaded });
  assert.equal(trust.trustLevel, 'ANCHORED_APPEND_ONLY');
});

// HF24 (proof bundle manifest completeness) is verified operationally against the RUN_ROOT
// package for this mission (every declared artifact exists, SHA256SUMS recomputes) rather than
// as a unit test here, since it has no repo-code counterpart to exercise.
