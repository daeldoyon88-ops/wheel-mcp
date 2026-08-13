// GEE_V1_R1_ARCHITECTURE_REPAIR_IMPLEMENTATION_R1
// Root-cause (RC-1..RC-7) and hostile-architecture (ACT-01..12, per
// 13_R1_FINAL_CLOSURE_REQUIREMENTS.json in RUN_ROOT 20260808_145613) countertests.
// Each test names the specific requirement it closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertIdentityBinding, BOUND, VIOLATION } from '../core/identity-binding.mjs';
import { createAuthoritativeState, requireVerifiedState, TRUST_LEVELS } from '../core/authoritative-state.mjs';
import { verifyHeadWitness } from '../core/head-witness.mjs';
import { deriveAuthoritativeStateFromLedger, hasNonGenesisTransition } from '../core/authority-event-log.mjs';
import { validateDefectDocument, countActiveDefects, resolveDefectKnowledge, ACTIVE_DEFECT_STATUSES } from '../core/defect-status.mjs';
import { resolveOpenDefectsKnowledge } from '../contracts/validate-open-defects-knowledge.mjs';
import { mapLegacyGateContractToExecutionView } from '../adapters/wheel/map-gate-contract.mjs';
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { buildReadinessContext, READINESS_CONTEXT_BRAND } from '../readiness/build-readiness-context.mjs';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { writeSyntheticStateSealAuthority } from './helpers/synthetic-state-seal-authority.mjs';
import { sha256Bytes, sha256Canonical, canonicalize } from '../../tools/canonical-json.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const LEDGER_CLI = path.join(REPO_ROOT, 'governance', 'tools', 'validate-status-ledger.mjs');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// RC-1: no trust root — head witness must grade, never silently trust.
// ---------------------------------------------------------------------------

test('RC-1: BROKEN chain never yields a usable trust level regardless of witnesses', () => {
  const result = verifyHeadWitness({
    ledgerSha256: 'a'.repeat(64),
    chainValid: false,
    hasNonGenesisTransition: true,
    witnesses: [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256: 'a'.repeat(64) }]
  });
  assert.equal(result.trustLevel, 'BROKEN');
});

test('RC-1: absent witness never upgrades trust — real transitions grade ANCHORED_APPEND_ONLY, not EXTERNAL', () => {
  const result = verifyHeadWitness({ ledgerSha256: 'b'.repeat(64), chainValid: true, hasNonGenesisTransition: true, witnesses: [] });
  assert.equal(result.trustLevel, 'ANCHORED_APPEND_ONLY');
});

test('RC-1: mismatching or unverified witness never counts as a match (stale/unknown witness != PASS)', () => {
  const stale = verifyHeadWitness({
    ledgerSha256: 'c'.repeat(64), chainValid: true, hasNonGenesisTransition: true,
    witnesses: [{ kind: 'GIT_OBJECT', verified: true, pinnedLedgerSha256: 'd'.repeat(64) }]
  });
  assert.equal(stale.trustLevel, 'ANCHORED_APPEND_ONLY');
  const unverified = verifyHeadWitness({
    ledgerSha256: 'c'.repeat(64), chainValid: true, hasNonGenesisTransition: true,
    witnesses: [{ kind: 'GIT_OBJECT', verified: false, pinnedLedgerSha256: 'c'.repeat(64) }]
  });
  assert.equal(unverified.trustLevel, 'ANCHORED_APPEND_ONLY');
});

test('RC-1: a real out-of-repo witness that matches upgrades to ANCHORED_EXTERNAL', () => {
  const result = verifyHeadWitness({
    ledgerSha256: 'e'.repeat(64), chainValid: true, hasNonGenesisTransition: true,
    witnesses: [{ kind: 'INDEPENDENT_AUDIT_RUN_ROOT', verified: true, pinnedLedgerSha256: 'e'.repeat(64) }]
  });
  assert.equal(result.trustLevel, 'ANCHORED_EXTERNAL');
});

test('RC-1: a gate frozen at genesis (no real transition) is UNANCHORED_LEGACY, not ANCHORED_APPEND_ONLY', () => {
  const result = verifyHeadWitness({ ledgerSha256: 'f'.repeat(64), chainValid: true, hasNonGenesisTransition: false, witnesses: [] });
  assert.equal(result.trustLevel, 'UNANCHORED_LEGACY');
});

// ---------------------------------------------------------------------------
// RC-2 / ACT-06: competing authority — the ledger wins, a generated snapshot never authorizes.
// ---------------------------------------------------------------------------

test('RC-2/ACT-06: STATE_SEAL says COMPLETE_CONFIRMED but ledger disagrees -> ledger authority wins (via the real adapter)', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  // Ledger IS the source of `status` now (RC-2/RC-6), not the seal payload directly.
  assert.equal(view.statusAuthority, 'gate-status-ledger:GATE13');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.state.authority.kind, 'GATE_STATUS_LEDGER');
});

test('RC-2/ACT-06: editing the non-canonical GATE_STATUS_SNAPSHOT.json never changes the adapter status', () => {
  const before = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE14').status;
  const snapshotPath = path.join(REPO_ROOT, 'governance/state/generated/GATE_STATUS_SNAPSHOT.json');
  const original = fs.readFileSync(snapshotPath, 'utf8');
  try {
    const mutated = JSON.parse(original);
    mutated.gates = (mutated.gates || []).map((g) => (g.gateId === 'GATE14' ? { ...g, currentStatus: 'COMPLETE_CONFIRMED' } : g));
    fs.writeFileSync(snapshotPath, JSON.stringify(mutated, null, 2));
    const after = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE14').status;
    assert.equal(after, before, 'generated snapshot must never be able to move status toward COMPLETE_CONFIRMED');
    assert.notEqual(after, 'COMPLETE_CONFIRMED');
  } finally {
    fs.writeFileSync(snapshotPath, original);
  }
});

// ---------------------------------------------------------------------------
// RC-2/RC-6/ACT-05: no raw status — verified=false forces UNKNOWN, never satisfies a prerequisite.
// ---------------------------------------------------------------------------

test('RC-6/ACT-05: verified=false forces value UNKNOWN and requireVerifiedState refuses it', () => {
  const state = createAuthoritativeState({
    value: 'COMPLETE_CONFIRMED', verified: false, trustLevel: 'ANCHORED_EXTERNAL',
    authority: { kind: 'FORGED' }, identityBinding: 'BOUND'
  });
  assert.equal(state.value, 'UNKNOWN');
  const result = requireVerifiedState(state, { allow: ['COMPLETE_CONFIRMED', 'UNKNOWN'], minTrustLevel: 'ANCHORED_APPEND_ONLY' });
  assert.equal(result.satisfied, false);
});

test('RC-6/ACT-05: identityBinding VIOLATION refuses regardless of value/trust level', () => {
  const state = createAuthoritativeState({
    value: 'COMPLETE_CONFIRMED', verified: true, trustLevel: 'ANCHORED_EXTERNAL',
    authority: { kind: 'REAL' }, identityBinding: VIOLATION
  });
  const result = requireVerifiedState(state, { allow: ['COMPLETE_CONFIRMED'], minTrustLevel: 'ANCHORED_APPEND_ONLY' });
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'IDENTITY_NOT_BOUND');
});

test('ACT-05: a real gate whose only trust level is UNANCHORED_LEGACY never satisfies resolvePrerequisite', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE12');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.state.trustLevel, 'UNANCHORED_LEGACY');
  const resolved = adapter.resolvePrerequisite('GATE13', 'GATE12');
  assert.equal(resolved.status, 'UNSATISFIED', 'raw COMPLETE_CONFIRMED string must never be enough — trust level is required too');
});

test('ACT-05: GATE13 itself, now ANCHORED_APPEND_ONLY with real transitions, DOES satisfy a prerequisite check', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.state.verified, true);
  assert.equal(view.state.trustLevel, 'ANCHORED_APPEND_ONLY');
  assert.equal(view.authorityState.consistent, true);
  const resolved = adapter.resolvePrerequisite('SOME_FUTURE_GATE', 'GATE13');
  assert.equal(resolved.status, 'SATISFIED');
});

// ---------------------------------------------------------------------------
// RC-1/RC-2/ACT-02/ACT-03: identity binding — cross-work-unit spoof is rejected before interpretation.
// ---------------------------------------------------------------------------

test('ACT-02: CURRENT_STATE.revisionPath pointing into another work unit is rejected (CT-B)', () => {
  const tmp = tmpDir('gee-act02-');
  const real = writeSyntheticStateSealAuthority(tmp, { gateId: 'GATEA' });
  fs.writeFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1,
    gates: [
      { gateId: 'GATEA', canonicalObjective: 'real', dependencies: [], definitionCompleteness: 'PARTIAL' },
      { gateId: 'GATEB', canonicalObjective: 'spoofer', dependencies: [], definitionCompleteness: 'PARTIAL' }
    ]
  }, null, 2));
  const realSealSha = sha256Bytes(fs.readFileSync(path.join(tmp, real.sealPath)));
  fs.mkdirSync(path.join(tmp, 'governance/gates/GATEB/state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance/gates/GATEB/state/CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1,
    gateId: 'GATEB',
    stateRevision: 'R0001',
    revisionPath: 'governance/gates/GATEA/state/revisions/R0001', // cross-gate spoof
    stateSealSha256: realSealSha,
    committedByTransactionId: 'ATTACK'
  }, null, 2));

  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATEB');
  assert.notEqual(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.authorityState.consistent, false);
  assert.equal(view.authorityState.statusKnowledge, 'IDENTITY_BINDING_VIOLATION');
});

test('ACT-03: a valid STATE_SEAL belonging to a different work unit is rejected even inside the right subtree', () => {
  const tmp = tmpDir('gee-act03-');
  const real = writeSyntheticStateSealAuthority(tmp, { gateId: 'GATEA' });
  fs.writeFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1,
    gates: [{ gateId: 'GATEC', canonicalObjective: 'foreign seal', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  // Copy GATEA's real, internally-valid seal bytes verbatim into GATEC's own subtree.
  const destDir = path.join(tmp, 'governance/gates/GATEC/state/revisions/R0001');
  fs.mkdirSync(destDir, { recursive: true });
  const sealBytes = fs.readFileSync(path.join(tmp, real.sealPath));
  fs.writeFileSync(path.join(destDir, 'STATE_SEAL.json'), sealBytes);
  const destSealSha = sha256Bytes(sealBytes);
  fs.mkdirSync(path.join(tmp, 'governance/gates/GATEC/state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance/gates/GATEC/state/CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1,
    gateId: 'GATEC',
    stateRevision: 'R0001',
    revisionPath: 'governance/gates/GATEC/state/revisions/R0001',
    stateSealSha256: destSealSha,
    committedByTransactionId: 'ATTACK'
  }, null, 2));

  const view = createWheelProjectAdapter(tmp).getWorkUnitView('GATEC');
  assert.equal(view.authorityState.consistent, false);
  // The spoof is rejected STRICTLY EARLIER than it used to be. H3 gave the seal
  // validator a canonical-location rule, so a seal declaring gateId GATEA while
  // sitting in GATEC's subtree is refused as an invalid seal before its bytes
  // are ever interpreted as state — rather than being parsed and only then
  // caught by the identity-binding layer. Both outcomes reject the attack; this
  // one rejects it sooner, so the reason code is now SEAL_INVALID.
  assert.equal(view.authorityState.statusKnowledge, 'SEAL_INVALID');
});

test('core assertIdentityBinding: unit-level BOUND/VIOLATION contract', () => {
  assert.equal(assertIdentityBinding({ workUnitId: 'X' }, []).status, BOUND);
  assert.equal(assertIdentityBinding({ workUnitId: 'X' }, [{ source: 's', workUnitId: 'Y' }]).status, VIOLATION);
  assert.equal(assertIdentityBinding({ workUnitId: 'X', subtreePrefix: 'governance/gates/X/' }, [{ source: 's', path: 'governance/gates/Y/state/CURRENT_STATE.json' }]).status, VIOLATION);
});

// ---------------------------------------------------------------------------
// RC-5/ACT-07: closed defect enum — unknown status is UNKNOWN, never KNOWN_ZERO.
// ---------------------------------------------------------------------------

test('ACT-07: unknown/case-variant/RESOLVED/BLOCKED defect statuses never resolve to KNOWN_ZERO', () => {
  for (const status of ['TOTALLY_UNKNOWN', 'RESOLVED', 'oPeN']) {
    const r = resolveOpenDefectsKnowledge({ defects: [{ status }] });
    assert.equal(r.defectsOpenKnowledge, 'UNKNOWN', status);
    assert.notEqual(r.defectsOpenKnowledge, 'KNOWN_ZERO', status);
  }
  // BLOCKED is a real canonical status, but it is ACTIVE, not terminal — never zero either.
  const blocked = resolveOpenDefectsKnowledge({ defects: [{ status: 'BLOCKED' }] });
  assert.equal(blocked.defectsOpenKnowledge, 'KNOWN_NONZERO');
  assert.ok(ACTIVE_DEFECT_STATUSES.includes('BLOCKED'));
});

test('RC-5: countActiveDefects is unreachable without a VALID document', () => {
  assert.throws(() => countActiveDefects({ valid: false }));
  assert.throws(() => countActiveDefects(validateDefectDocument({ defects: [{ status: 'NONSENSE' }] })));
  const ok = validateDefectDocument({ defects: [{ status: 'OPEN' }] });
  assert.equal(countActiveDefects(ok).count, 1);
});

test('RC-5: one unclassifiable entry makes the WHOLE document UNKNOWN, not a partial count', () => {
  const r = resolveDefectKnowledge({ defects: [{ status: 'OPEN' }, { status: 'NONSENSE' }] });
  assert.equal(r.defectsOpenKnowledge, 'UNKNOWN');
  assert.equal(r.defectsOpenCount, null);
});

// ---------------------------------------------------------------------------
// RC-7/ACT-10: adapter metadata never lives inside the canonical domain object.
// ---------------------------------------------------------------------------

test('ACT-10: legacy mapped contract validates against the canonical schema; provenance is separate', () => {
  const legacyContract = {
    gateId: 'GATEX', contractRevision: 'R0001',
    positiveTests: ['t1'], negativeTests: ['n1'], countertests: ['c1'],
    requiredOutputs: [{ path: 'out.json' }], closureConditions: ['done'],
    authorizedPaths: ['governance/gates/GATEX/**']
  };
  const mapped = mapLegacyGateContractToExecutionView(legacyContract, {
    objective: 'x', sourcePath: 'p.json', sourceSha256: 'a'.repeat(64), prerequisites: []
  });
  assert.equal(validateExecutionContract(mapped.contract).valid, true);
  assert.equal('compatibility' in mapped.contract, false);
  assert.equal('sourcePath' in mapped.contract, false);
  assert.equal(mapped.provenance.sourceKind, 'LEGACY_MAPPED');
  assert.equal(mapped.provenance.sourcePath, 'p.json');
});

test('ACT-10/CT-F2: an absent optional field is OMITTED, never materialized as undefined', () => {
  const mapped = mapLegacyGateContractToExecutionView(
    { gateId: 'GATEY', contractRevision: 'R0001' },
    { objective: null, prerequisites: [] } // no objective supplied
  );
  assert.equal(Object.prototype.hasOwnProperty.call(mapped.contract, 'objective'), false);
  const roundTripped = JSON.parse(JSON.stringify(mapped.contract));
  assert.equal(Object.prototype.hasOwnProperty.call(roundTripped, 'objective'), false);
});

// ---------------------------------------------------------------------------
// RC-4/ACT-08/ACT-09/ACT-12: mandatory readiness context — nothing optional, nothing forgettable.
// ---------------------------------------------------------------------------

test('ACT-08: missing OPEN_DEFECTS evidence yields UNKNOWN and blocks via the context builder', () => {
  const tmp = tmpDir('gee-act08-');
  fs.writeFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'.replace('governance/', '')), '');
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1, gates: [{ gateId: 'GATED', canonicalObjective: 'x', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  fs.mkdirSync(path.join(tmp, 'governance/gates/GATED/state/revisions/R0001'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance/gates/GATED/state/CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1, gateId: 'GATED', stateRevision: 'R0001', revisionPath: 'governance/gates/GATED/state/revisions/R0001'
  }, null, 2));
  fs.writeFileSync(path.join(tmp, 'governance/gates/GATED/state/revisions/R0001/STATE_SEAL.json'), JSON.stringify({
    schemaVersion: 1, payload: { executionStatus: 'AUTHORIZED_NOT_STARTED' }
  }, null, 2));
  // OPEN_DEFECTS.json intentionally absent.
  const adapter = createWheelProjectAdapter(tmp);
  const context = buildReadinessContext({ adapter, workUnitId: 'GATED', preflightOk: true });
  assert.equal(context.proofs.OPEN_DEFECTS.state, 'UNKNOWN');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
});

test('ACT-09: an activated work unit whose real anchor cannot be proven (no seal-bound authority) blocks through the real CLI path (not SKIP)', () => {
  // FC-03 (R1_FINAL_CLOSURE_BLOCKER_FIX_R1): the adapter now constructs a REAL activation anchor
  // from the sealed member's on-disk bytes whenever one is genuinely present (see deriveActivation
  // in adapters/wheel/wheel-project-adapter.mjs) — it no longer always returns anchor:null. This
  // fixture's sealed activation record IS real, so activation.anchor is now populated; the proof
  // still fails closed downstream because this fixture's activation record ({ placeholder: true })
  // is not a real EXECUTION_CONTRACT_ACTIVATION record (missing authorityKind/
  // expectedContractSha256/expectedSealSha256), so validateActivationAnchor rejects it as
  // ANCHOR_INVALID before it ever inspects the (TJ-02: now real, non-null) execution seal ->
  // FAILED, never PROVEN, never SKIP.
  const tmp = tmpDir('gee-act09-');
  const real = writeSyntheticStateSealAuthority(tmp, { gateId: 'GATEACT', activationRecord: { placeholder: true } });
  fs.writeFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1, gates: [{ gateId: 'GATEACT', canonicalObjective: 'activated no anchor', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  fs.writeFileSync(path.join(tmp, 'governance/gates/GATEACT/state/CURRENT_STATE.json'), JSON.stringify({
    schemaVersion: 1, gateId: 'GATEACT', stateRevision: 'R0001',
    revisionPath: 'governance/gates/GATEACT/state/revisions/R0001',
    stateSealSha256: sha256Bytes(fs.readFileSync(path.join(tmp, real.sealPath)))
  }, null, 2));
  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView('GATEACT');
  assert.equal(view.activation.activated, true, 'fixture must genuinely present an activation-shaped sealed member');
  assert.ok(view.activation.anchor, 'FC-03: a real sealed activation record must now produce a real anchor, not null');
  const context = buildReadinessContext({ adapter, workUnitId: 'GATEACT', preflightOk: true });
  assert.equal(context.proofs.ACTIVATION_ANCHOR.state, 'FAILED');
  assert.equal(evaluateReadiness(context).verdict, 'BLOCKED');
  const checks = evaluateReadiness(context).checks;
  assert.ok(checks.some((c) => c.id === 'ACTIVATION_ANCHOR' && c.status === 'FAIL'), 'an unproven anchor must never render as SKIP');
});

test('ACT-12: a hand-built context object is rejected by the brand check (only the factory may produce READY)', () => {
  const fake = { workUnitId: 'X', proofs: {}, [READINESS_CONTEXT_BRAND]: false };
  const result = evaluateReadiness(fake);
  // Without the brand, evaluateReadiness falls back to the legacy (non-context) path, which fails
  // closed on missing strategic/execution contracts -- it can never silently become READY.
  assert.equal(result.verdict, 'BLOCKED');
});

test('ACT-12: buildReadinessContext itself refuses to return a context missing a required proof slot', () => {
  const tmp = tmpDir('gee-act12-');
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1, gates: [{ gateId: 'GATEZ', canonicalObjective: 'x', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  const adapter = createWheelProjectAdapter(tmp);
  // No CURRENT_STATE.json at all -- exercises the ABSENT seal-layer branch end to end without throwing.
  const context = buildReadinessContext({ adapter, workUnitId: 'GATEZ' });
  for (const slot of ['AUTHORITY_STATE', 'OPEN_DEFECTS', 'ACTIVATION_ANCHOR', 'PREFLIGHT']) {
    assert.ok(context.proofs[slot] && typeof context.proofs[slot].state === 'string', slot);
  }
});

// ---------------------------------------------------------------------------
// ACT-11: future work unit (GATE41+) traverses the full pipeline with no hardcoded IDs.
// ---------------------------------------------------------------------------

test('ACT-11: GATE41 fixture traverses ledger + adapter + readiness with zero hardcoded gate-id patterns in the core', () => {
  const tmp = tmpDir('gee-act11-');
  fs.mkdirSync(path.join(tmp, 'governance/state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'governance/authority'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'), JSON.stringify({
    schemaVersion: 1, gates: [{ gateId: 'GATE41', canonicalObjective: 'future gate', dependencies: [], definitionCompleteness: 'PARTIAL' }]
  }, null, 2));
  const registryBytes = fs.readFileSync(path.join(tmp, 'governance/GATE_REGISTRY_00_40.json'));
  const registrySha = sha256Bytes(registryBytes);
  const event = {
    schemaVersion: 1, ordinal: 1, eventId: 'GENESIS_IMPORT_GATE41', gateId: 'GATE41',
    fromStatus: null, toStatus: 'NOT_STARTED', transitionType: 'GENESIS_IMPORT',
    authorityPath: 'governance/GATE_REGISTRY_00_40.json', authoritySha256: registrySha,
    previousEventSha256: null, recordedAt: '2026-08-08T00:00:00.000Z'
  };
  event.eventPayloadSha256 = sha256Canonical(event);
  fs.writeFileSync(path.join(tmp, 'governance/state/GATE_STATUS_LEDGER.ndjson'), canonicalize(event) + '\n');
  fs.writeFileSync(path.join(tmp, 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json'), JSON.stringify({
    externalAuthorities: [],
    gates: [{ gateId: 'GATE41', importedStatus: 'NOT_STARTED', historicalDetailCompleteness: 'UNKNOWN', fabricatedTransitionCount: 0 }]
  }, null, 2));

  const ledgerReport = spawnSync(process.execPath, [LEDGER_CLI, '--root', tmp], { encoding: 'utf8' });
  const parsed = JSON.parse(ledgerReport.stdout);
  assert.equal(parsed.valid, true, JSON.stringify(parsed.findings));

  const adapter = createWheelProjectAdapter(tmp);
  const view = adapter.getWorkUnitView('GATE41');
  assert.equal(view.status, 'NOT_STARTED');

  const coreLedgerSource = fs.readFileSync(path.join(REPO_ROOT, 'governance/tools/validate-status-ledger.mjs'), 'utf8');
  assert.equal(/GATE\(0\[0-9\]\|\[1-3\]\[0-9\]\|40\)/.test(coreLedgerSource), false, 'no GATE00-40 regex bound in the core ledger validator');
  const coreWorkUnit = fs.readFileSync(path.join(HERE, '..', 'core', 'work-unit-core.mjs'), 'utf8');
  assert.equal(coreWorkUnit.includes('GATE41'), false);
});

// ---------------------------------------------------------------------------
// GATE13 end-to-end (mission section 25).
// ---------------------------------------------------------------------------

test('GATE13 end-to-end: ledger -> witness -> identity binding -> authoritative state -> COMPLETE_CONFIRMED, verified, real evidence', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.state.verified, true);
  assert.equal(view.state.identityBinding, 'BOUND');
  assert.equal(view.state.trustLevel, 'ANCHORED_APPEND_ONLY');
  assert.equal(view.authorityState.consistent, true);
  assert.ok(view.state.evidenceRef.includes('governance/state/GATE_STATUS_LEDGER.ndjson'));
  assert.equal(hasNonGenesisTransition({ events: [{ gateId: 'GATE13', transitionType: 'EXTERNAL_CONFIRMATION' }] }, 'GATE13'), true);
});
