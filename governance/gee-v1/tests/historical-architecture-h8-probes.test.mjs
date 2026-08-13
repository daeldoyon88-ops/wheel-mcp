/**
 * H8 — the six original architecture probes, plus the generic future-Gate
 * fixture and the local-authority hostiles.
 *
 * These are the questions the whole program exists to answer. Each probe states
 * the property in its own name, and each is exercised against real artifacts or
 * a real isolated fixture — never against a mock of the thing being tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateLedger, validateLedgerPrefix, MODE_FULL, MODE_LEDGER_INTEGRITY } from '../../tools/validate-status-ledger.mjs';
import { validateStateSeal, computeSealedMembersDigest } from '../../tools/validate-state-seal.mjs';
import { resolveStateRevisionLineage } from '../core/state-revision-resolver.mjs';
import { evaluatePostFreezeMaintenanceAuthorityV2, PHASE_AUTHORIZE_PROGRAM_APPLY } from '../core/post-freeze-maintenance-authority.mjs';
import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY as policy } from '../adapters/wheel/external-authority-policy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readBytes = (rel) => fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')));
const readJson = (rel) => JSON.parse(readBytes(rel).toString('utf8'));
const blocking = (findings) => findings.filter((f) => f.severity === 'BLOCKING');

function copyTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h8-probe-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}

// ===========================================================================
// THE SIX ORIGINAL ARCHITECTURE PROBES
// ===========================================================================

test('PROBE-1: a contract succession does not invalidate prior history', () => {
  // The succession has already happened in this repository. Every prior ordinal
  // must still replay, including the two that pin contract pointer bytes.
  for (const ordinal of [41, 56, 57, 58, 59]) {
    const report = validateLedgerPrefix({ root: REPO_ROOT, ledgerPath: LEDGER, throughOrdinal: ordinal, policy });
    assert.deepEqual(blocking(report.prefixFindings), [], `replay --at ${ordinal}`);
  }
  assert.equal(sha(Buffer.from(fs.readFileSync(LEDGER, 'utf8').split('\n').filter((l) => l.trim()).slice(0, 58).join('\n') + '\n', 'utf8')),
    '7289f3ef93823a2cc7a5494bb25f7d0a144e6481d3674aaaba7a7e5736a58bc1');
});

test('PROBE-2: a future revision cannot weaken verification of a prior one', () => {
  const root = copyTree();
  try {
    const sealPath = path.join(root, 'governance/gates/GATE14/state/revisions/R0001/STATE_SEAL.json');
    const before = validateStateSeal({ root, sealPath });
    // Add a future revision directory, then a plausible-looking future seal.
    const future = path.join(root, 'governance/gates/GATE14/state/revisions/R9999');
    fs.mkdirSync(future, { recursive: true });
    const afterEmpty = validateStateSeal({ root, sealPath });
    fs.cpSync(path.join(root, 'governance/gates/GATE14/state/revisions/R0003'), future, { recursive: true });
    const afterFull = validateStateSeal({ root, sealPath });
    // The verdict on R0001 is identical in all three worlds.
    assert.equal(afterEmpty.valid, before.valid);
    assert.equal(afterFull.valid, before.valid);
    assert.deepEqual(afterFull.findings.map((f) => f.detectorId), before.findings.map((f) => f.detectorId));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PROBE-3: a forged historical binding BLOCKS', () => {
  const root = copyTree();
  try {
    // Forge a legacy binding that claims event 58 established a different revision.
    const bindingsPath = path.join(root, 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json');
    const document = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'));
    document.bindings[1].stateRevision = 'R0001';
    document.bindings[1].stateRevisionSealSha256 = document.bindings[0].stateRevisionSealSha256;
    fs.writeFileSync(bindingsPath, JSON.stringify(document, null, 2) + '\n');
    const out = execFileSync(process.execPath,
      [path.join(REPO_ROOT, 'governance/tools/validate-legacy-state-binding.mjs'), '--root', root,
        '--bindings', bindingsPath, '--ledger', path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson')],
      { encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.equal(report.valid, false, 'a forged binding must not validate');
    assert.ok(report.findings.length > 0);
  } catch (error) {
    // A non-zero exit is the expected BLOCK; parse whatever it printed.
    const report = JSON.parse(error.stdout);
    assert.equal(report.valid, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PROBE-4: a relocated or cross-Gate seal BLOCKS', () => {
  const root = copyTree();
  try {
    // Relocated within the Gate.
    const relocated = path.join(root, 'governance/gates/GATE14/state/revisions/R0007');
    fs.mkdirSync(relocated, { recursive: true });
    fs.copyFileSync(path.join(root, 'governance/gates/GATE14/state/revisions/R0003/STATE_SEAL.json'), path.join(relocated, 'STATE_SEAL.json'));
    const moved = validateStateSeal({ root, sealPath: path.join(relocated, 'STATE_SEAL.json') });
    assert.equal(moved.valid, false);
    assert.ok(moved.findings.some((f) => f.detectorId === 'SEAL_NOT_AT_CANONICAL_LOCATION'));

    // Relocated into a different Gate.
    const foreign = path.join(root, 'governance/gates/GATE15/state/revisions/R0003');
    fs.mkdirSync(foreign, { recursive: true });
    fs.copyFileSync(path.join(root, 'governance/gates/GATE14/state/revisions/R0003/STATE_SEAL.json'), path.join(foreign, 'STATE_SEAL.json'));
    const crossGate = validateStateSeal({ root, sealPath: path.join(foreign, 'STATE_SEAL.json') });
    assert.equal(crossGate.valid, false);
    assert.ok(crossGate.findings.some((f) => f.detectorId === 'SEAL_NOT_AT_CANONICAL_LOCATION'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PROBE-5: a fabricated new head cannot legitimize a forged predecessor', () => {
  const root = copyTree();
  try {
    const revisions = path.join(root, 'governance/gates/GATE14/state/revisions');
    // Forge a predecessor R0004 and a "head" R0005 that vouches for it.
    for (const [revision, previous] of [['R0004', null], ['R0005', 'R0004']]) {
      const dir = path.join(revisions, revision);
      fs.mkdirSync(dir, { recursive: true });
      const checkpoint = Buffer.from(`{"forged":"${revision}"}\n`, 'utf8');
      const defectsBytes = Buffer.from('{"defects":[]}\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'CHECKPOINT.json'), checkpoint);
      fs.writeFileSync(path.join(dir, 'OPEN_DEFECTS.json'), defectsBytes);
      const members = [
        { repoRelativePath: `governance/gates/GATE14/state/revisions/${revision}/CHECKPOINT.json`, sha256: sha(checkpoint), byteLength: checkpoint.length },
        { repoRelativePath: `governance/gates/GATE14/state/revisions/${revision}/OPEN_DEFECTS.json`, sha256: sha(defectsBytes), byteLength: defectsBytes.length },
        { repoRelativePath: 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json', sha256: sha(fs.readFileSync(path.join(root, 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json'))), byteLength: fs.readFileSync(path.join(root, 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json')).length }
      ];
      const previousSha = previous ? sha(fs.readFileSync(path.join(revisions, previous, 'STATE_SEAL.json'))) : null;
      const payload = { gateId: 'GATE14', stateRevision: revision, executionStatus: 'IN_PROGRESS', previousStateSealSha256: previousSha, sealedMembersDigest: computeSealedMembersDigest(members) };
      const seal = { schemaVersion: 1, gateId: 'GATE14', stateRevision: revision, sealedMembers: members, previousStateSealSha256: previousSha, sealedAt: '2026-08-13T00:00:00.000Z', payload, payloadSha256: sha256Canonical(payload) };
      fs.writeFileSync(path.join(dir, 'STATE_SEAL.json'), JSON.stringify(seal, null, 2) + '\n');
    }
    // The ledger never bound R0004 or R0005, so neither can become current no
    // matter how internally consistent the forged pair is.
    const events = fs.readFileSync(path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const legacy = JSON.parse(fs.readFileSync(path.join(root, 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json'), 'utf8'));
    const seals = new Map();
    for (const name of fs.readdirSync(revisions)) {
      const file = path.join(revisions, name, 'STATE_SEAL.json');
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      const json = JSON.parse(bytes.toString('utf8'));
      seals.set(name, { sha256: sha(bytes), gateId: json.gateId, stateRevision: json.stateRevision, previousStateSealSha256: json.previousStateSealSha256 });
    }
    const lineage = resolveStateRevisionLineage({
      gateId: 'GATE14', events, legacyBindings: legacy.bindings, legacyEraMaxOrdinal: legacy.legacyEraMaxOrdinal,
      seals, presentRevisions: [...seals.keys()]
    });
    assert.equal(lineage.resolved, 'R0003', 'the ledger still decides, not the forged head');
    assert.deepEqual(lineage.sealChain, ['R0001', 'R0002', 'R0003']);
    assert.ok(lineage.findings.some((f) => f.code === 'ORPHAN_REVISION'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PROBE-6: a case-variant path BLOCKS', () => {
  const root = copyTree();
  try {
    const sealPath = path.join(root, 'governance/gates/GATE14/state/revisions/R0003/STATE_SEAL.json');
    const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
    seal.sealedMembers[0].repoRelativePath = seal.sealedMembers[0].repoRelativePath.replace('/state/', '/State/');
    seal.payload.sealedMembersDigest = computeSealedMembersDigest(seal.sealedMembers);
    seal.payloadSha256 = sha256Canonical(seal.payload);
    fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2) + '\n');
    const report = validateStateSeal({ root, sealPath });
    assert.equal(report.valid, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ===========================================================================
// LOCAL AUTHORITY HOSTILES AGAINST THE REAL PROGRAM AUTHORITY
// ===========================================================================

test('H8-A1: the program authority is now SPENT and cannot authorize a second program', () => {
  // Its pre-state named ledger 58 / R0002 / contract R0001. That state no longer
  // exists, which is exactly what single-use means.
  const out = (() => {
    try {
      return execFileSync(process.execPath, [path.join(REPO_ROOT, 'governance/tools/validate-post-freeze-maintenance-authority.mjs'), '--program-id', 'GOVERNANCE_HISTORICAL_ARCHITECTURE_IMPLEMENTATION_PROGRAM_R1'], { encoding: 'utf8' });
    } catch (error) { return error.stdout; }
  })();
  const report = JSON.parse(out);
  assert.equal(report.verdict, 'BLOCKED');
  assert.ok(report.findings.some((f) => f.code === 'LEDGER_EVENT_COUNT_MISMATCH' || f.code === 'BASE_HEAD_MISMATCH' || f.code === 'PRE_STATE_MISMATCH'));
});

test('H8-A2: no R8 anywhere', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0008.json')), false);
  const authority = readJson('governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_HISTORICAL_ARCHITECTURE_IMPLEMENTATION_R1.json');
  assert.equal(authority.preState.R8ExpectedAbsent, true);
  assert.ok(authority.prohibitedOperations.includes('GEE_R8'));
});

test('H8-A3: GATE14 is not closed and ACTIVE_GATE was not switched', () => {
  const events = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const gate14 = events.filter((e) => e.gateId === 'GATE14');
  assert.equal(gate14.at(-1).toStatus, 'IN_PROGRESS');
  assert.equal(gate14.some((e) => ['AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION'].includes(e.transitionType)), false);
  assert.equal(readJson('governance/active/ACTIVE_GATE.json').activeGate, 'GATE13');
});

// ===========================================================================
// GENERIC FUTURE GATE FIXTURE — scratch only, proves the architecture is not
// GATE14-shaped.
// ===========================================================================

test('H8-F1: a generic future Gate supports multiple revisions, succession and replay', () => {
  const GATE = 'GATE21';
  const events = [];
  const seals = new Map();
  // Three revisions, chained, with the last two bound by native-era events.
  let previous = null;
  for (const [index, revision] of ['R0001', 'R0002', 'R0003'].entries()) {
    const digest = String(index + 1).padStart(64, '0');
    seals.set(revision, { sha256: digest, gateId: GATE, stateRevision: revision, previousStateSealSha256: previous });
    previous = digest;
  }
  events.push({ ordinal: 100, eventId: 'G21_START', gateId: GATE, toStatus: 'IN_PROGRESS', transitionType: 'START', stateRevision: 'R0001', stateRevisionSealSha256: seals.get('R0001').sha256 });
  events.push({ ordinal: 101, eventId: 'G21_CS1', gateId: GATE, toStatus: 'IN_PROGRESS', transitionType: 'CONTRACT_SUCCESSION', stateRevision: 'R0002', stateRevisionSealSha256: seals.get('R0002').sha256 });
  events.push({ ordinal: 102, eventId: 'G21_CS2', gateId: GATE, toStatus: 'IN_PROGRESS', transitionType: 'CONTRACT_SUCCESSION', stateRevision: 'R0003', stateRevisionSealSha256: seals.get('R0003').sha256 });

  const lineage = resolveStateRevisionLineage({ gateId: GATE, events, legacyBindings: [], seals, presentRevisions: ['R0001', 'R0002', 'R0003'] });
  assert.deepEqual(lineage.findings, []);
  assert.equal(lineage.resolved, 'R0003');
  assert.deepEqual(lineage.sealChain, ['R0001', 'R0002', 'R0003']);
  // Repeated succession is supported, and every binding is native — no legacy
  // record exists for this Gate and none is needed.
  assert.equal(lineage.bindings.length, 3);
  assert.ok(lineage.bindings.every((b) => b.decidedBy === 'NATIVE_EVENT_PIN'));
});

test('H8-F2: the generic future Gate uses no key material and no max-directory authority', () => {
  const GATE = 'GATE30';
  const seals = new Map([
    ['R0001', { sha256: '1'.repeat(64), gateId: GATE, stateRevision: 'R0001', previousStateSealSha256: null }],
    ['R0002', { sha256: '2'.repeat(64), gateId: GATE, stateRevision: 'R0002', previousStateSealSha256: '1'.repeat(64) }]
  ]);
  const events = [{ ordinal: 200, eventId: 'G30', gateId: GATE, toStatus: 'IN_PROGRESS', transitionType: 'CONTRACT_SUCCESSION', stateRevision: 'R0002', stateRevisionSealSha256: '2'.repeat(64) }];
  const base = resolveStateRevisionLineage({ gateId: GATE, events, legacyBindings: [], seals, presentRevisions: ['R0001', 'R0002'] });
  // Add a maximum-looking directory that the ledger never bound.
  const withIntruder = resolveStateRevisionLineage({ gateId: GATE, events, legacyBindings: [], seals, presentRevisions: ['R0001', 'R0002', 'R9999'] });
  assert.equal(withIntruder.resolved, base.resolved);
  assert.deepEqual(withIntruder.sealChain, base.sealChain);
  assert.ok(withIntruder.findings.some((f) => f.code === 'ORPHAN_REVISION'));
});

test('H8-F3: a future Gate cannot use a legacy migration record', () => {
  const GATE = 'GATE22';
  const result = resolveStateRevisionLineage({
    gateId: GATE,
    events: [{ ordinal: 300, eventId: 'G22', gateId: GATE, toStatus: 'IN_PROGRESS', transitionType: 'CONTRACT_SUCCESSION', stateRevision: 'R0001', stateRevisionSealSha256: '1'.repeat(64) }],
    legacyBindings: [{ eventOrdinal: 300, eventId: 'G22', gateId: GATE, toStatus: 'IN_PROGRESS', eventPayloadSha256: 'x', originalAuthorityPath: 'a', originalAuthoritySha256: 'b', stateRevision: 'R0001', stateRevisionSealSha256: '1'.repeat(64) }],
    seals: new Map([['R0001', { sha256: '1'.repeat(64), gateId: GATE, stateRevision: 'R0001', previousStateSealSha256: null }]]),
    presentRevisions: ['R0001']
  });
  assert.ok(result.findings.some((f) => f.code === 'NATIVE_ERA_MIGRATION_FORBIDDEN'));
});

// ===========================================================================
// F01-F34 CLASSIFICATION
// ===========================================================================

test('H8-C1: every catalogued audit item is classified with evidence', () => {
  const document = readJson('governance/historical-architecture/F01_F34_CLASSIFICATION.json');
  const allowed = new Set(['PROTECTED_BY_EXISTING_INVARIANT', 'NEW_TEST_ADDED', 'NOT_APPLICABLE_WITH_REASON']);
  assert.equal(document.classifications.length, document.summary.total);
  for (const item of document.classifications) {
    assert.ok(allowed.has(item.disposition), `${item.id}: ${item.disposition}`);
    if (item.disposition === 'NOT_APPLICABLE_WITH_REASON') assert.ok(item.reason && item.reason.length > 0, item.id);
    else assert.ok(item.evidence && item.evidence.length > 0, item.id);
  }
  // F01..F34 are all present.
  for (let index = 1; index <= 34; index += 1) {
    const id = `F${String(index).padStart(2, '0')}`;
    assert.ok(document.classifications.some((c) => c.id === id), `${id} missing`);
  }
});
