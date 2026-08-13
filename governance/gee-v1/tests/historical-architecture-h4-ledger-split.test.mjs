/**
 * H4 — ledger integrity is not present consistency.
 *
 * H4-03 is the test that matters most: it proves the split is not cosmetic by
 * advancing a MUTABLE pointer and showing that history stays replayable while
 * the present-tense check notices. Before the split, advancing that pointer
 * would have made event 58 permanently unreplayable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateLedger,
  validateLedgerPrefix,
  validatePresentConsistency,
  reconstructLedgerPrefixBytes,
  MODE_LEDGER_INTEGRITY,
  MODE_FULL
} from '../../tools/validate-status-ledger.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY as policy } from '../adapters/wheel/external-authority-policy.mjs';
import { validateActiveGatePointer, evaluateActiveGateSuccession, ACTIVE_GATE_SUCCESSION_KIND } from '../core/active-gate-succession.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson');
const REPLAY_TOOL = path.join(REPO_ROOT, 'governance/tools/replay-governance-history.mjs');
const blocking = (findings) => findings.filter((f) => f.severity === 'BLOCKING');

/** A throwaway copy of the governed tree, so present-state mutations touch nothing real. */
function copyGovernanceTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h4-split-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}

test('H4-01: replay at 56, 57 and 58 all PASS in integrity mode', () => {
  for (const [ordinal, expectedPrefix] of [
    [56, '5cd7136a49b887f9a4ecd233588ec8907c82bbef588a741652f14dcffe963879'],
    [57, 'c4dfefd7790cfc30f3f13a5159362b03b9902273ac6b3d7db8ab5dba6ba6ab6b'],
    [58, '7289f3ef93823a2cc7a5494bb25f7d0a144e6481d3674aaaba7a7e5736a58bc1']
  ]) {
    const report = validateLedgerPrefix({ root: REPO_ROOT, ledgerPath: LEDGER, throughOrdinal: ordinal, expectedPrefixSha256: expectedPrefix, policy });
    assert.equal(report.mode, MODE_LEDGER_INTEGRITY, `${ordinal} must default to integrity`);
    assert.equal(report.matchesExpectedHistoricalDigest, true, `${ordinal} prefix digest`);
    assert.deepEqual(blocking(report.prefixFindings), [], `${ordinal}: ${JSON.stringify(blocking(report.prefixFindings))}`);
  }
});

test('H4-02: replay at 57 specifically — the defect this phase repairs', () => {
  // Under the fused validator this replay failed with
  // GATE_AUTHORIZATION_CURRENT_STATE_STATUS_MISMATCH, because it compared the
  // status replayed at 57 (AUTHORIZED_NOT_STARTED) with the CURRENT seal
  // written at 58 (IN_PROGRESS).
  const report = validateLedgerPrefix({ root: REPO_ROOT, ledgerPath: LEDGER, throughOrdinal: 57, policy });
  assert.deepEqual(blocking(report.prefixFindings), []);
  const fused = validateLedgerPrefix({ root: REPO_ROOT, ledgerPath: LEDGER, throughOrdinal: 57, policy, mode: MODE_FULL });
  assert.ok(blocking(fused.prefixFindings).some((f) => f.detectorId === 'GATE_AUTHORIZATION_CURRENT_STATE_STATUS_MISMATCH'),
    'FULL mode must still ask the present-tense question, and still disagree at a historical ordinal');
});

test('H4-03: advancing a MUTABLE pointer does not destroy replayable history', () => {
  const root = copyGovernanceTree();
  const ledger = path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const pointer = path.join(root, 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json');
  // Event 58 pins currentContractSha256 — the bytes of this pointer.
  const before = validateLedgerPrefix({ root, ledgerPath: ledger, throughOrdinal: 58, policy });
  assert.deepEqual(blocking(before.prefixFindings), []);
  // Advance the pointer again, exactly as a further contract succession would.
  const current = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  current.contractRevision = 'R0003';
  current.contractPath = 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0003.json';
  fs.writeFileSync(pointer, JSON.stringify(current, null, 2) + '\n');

  const after = validateLedgerPrefix({ root, ledgerPath: ledger, throughOrdinal: 58, policy });
  assert.deepEqual(blocking(after.prefixFindings), [], 'history must remain replayable after lawful forward progress');

  // The present-tense question still notices, which is the point of splitting
  // rather than deleting the check. Note WHICH mechanism catches it: the pointer
  // is protected by the state seal that currently seals it, not by a stale pin
  // inside a superseded historical event. That is the stronger guarantee — it
  // keeps working no matter how many successions have happened since.
  const fused = validateLedger({ root, ledgerPath: ledger, policy, mode: MODE_FULL });
  const blockingFull = fused.findings.filter((f) => f.severity === 'BLOCKING');
  assert.ok(blockingFull.length > 0, 'FULL mode must notice that a sealed pointer drifted');
  assert.ok(blockingFull.some((f) => f.detectorId === 'GATE_AUTHORIZATION_STATE_LINEAGE_INVALID'), JSON.stringify([...new Set(blockingFull.map((f) => f.detectorId))]));
  fs.rmSync(root, { recursive: true, force: true });
});

test('H4-04: an IMMUTABLE artifact is still byte-checked in integrity mode', () => {
  const root = copyGovernanceTree();
  const ledger = path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const seal = path.join(root, 'governance/gates/GATE14/state/revisions/R0001/STATE_SEAL.json');
  fs.writeFileSync(seal, fs.readFileSync(seal, 'utf8').replace('"schemaVersion": 1', '"schemaVersion": 1 '));
  const report = validateLedgerPrefix({ root, ledgerPath: ledger, throughOrdinal: 58, policy });
  assert.ok(blocking(report.prefixFindings).length > 0, 'tampering an immutable sealed artifact must still block');
  fs.rmSync(root, { recursive: true, force: true });
});

test('H4-05: present consistency is reported separately and is currently true', () => {
  const report = validatePresentConsistency({ root: REPO_ROOT, ledgerPath: LEDGER, policy });
  assert.equal(report.ledgerIntegrityValid, true);
  assert.equal(report.presentConsistent, true);
  assert.equal(report.eventCount, fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length);
});

test('H4-06: the replay tool replays every standalone-meaningful ordinal', () => {
  const out = execFileSync(process.execPath, [REPLAY_TOOL, '--root', REPO_ROOT, '--all'], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.verdict, 'PASS', JSON.stringify(report.replays.filter((r) => r.verdict !== 'PASS')));
  assert.equal(report.mode, MODE_LEDGER_INTEGRITY);
  // The GENESIS_IMPORT cohort is atomic, so replay starts at its completion.
  assert.equal(report.firstReplayableOrdinal, 41);
});

test('H4-07: a reconstructed prefix reproduces the digest pinned by historical authority', () => {
  const prefix57 = reconstructLedgerPrefixBytes(LEDGER, 57);
  const startAuthority = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json'), 'utf8'));
  assert.equal(crypto.createHash('sha256').update(prefix57).digest('hex'), startAuthority.preStartLedgerSha256);
});

// --- ACTIVE_GATE pointer ----------------------------------------------------

test('H4-08: ACTIVE_GATE no longer pins the reconstructable snapshot', () => {
  const pointer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/active/ACTIVE_GATE.json'), 'utf8'));
  assert.equal(pointer.currentStateSha256, null);
  assert.deepEqual(validateActiveGatePointer(pointer).findings, []);
  // Lifecycle ownership is unchanged by this program.
  assert.equal(pointer.activeGate, 'GATE13');
  // Stable identity is still bound.
  assert.equal(typeof pointer.activationEventId, 'string');
  assert.ok(Number.isInteger(pointer.activationEventOrdinal));
  assert.match(pointer.activationEventSha256, /^[a-f0-9]{64}$/);
});

test('H4-09: a pointer that pins a mutable projection is rejected', () => {
  const pointer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/active/ACTIVE_GATE.json'), 'utf8'));
  const result = validateActiveGatePointer({ ...pointer, currentStateSha256: 'a'.repeat(64) });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((f) => f.code === 'ACTIVE_GATE_PINS_MUTABLE_PROJECTION'));
});

// --- succession primitive ---------------------------------------------------

function successionFixture() {
  const record = {
    documentKind: ACTIVE_GATE_SUCCESSION_KIND,
    schemaVersion: 1,
    recordId: 'ACTIVE_GATE_SUCCESSION_GATE13_GATE14_R1',
    programId: 'GOVERNANCE_HISTORICAL_ARCHITECTURE_IMPLEMENTATION_PROGRAM_R1',
    preHead: '1'.repeat(40),
    previousActiveGate: 'GATE13',
    nextActiveGate: 'GATE14',
    activationEventId: 'GATE14_ACTIVATION',
    activationEventOrdinal: 59,
    activationEventSha256: '2'.repeat(64),
    ledgerEventCount: 59,
    ledgerPrefixSha256: '3'.repeat(64),
    authorityId: 'GOVERNANCE_HISTORICAL_ARCHITECTURE_IMPLEMENTATION_AUTHORITY_R1',
    maxUse: 1
  };
  const observed = {
    head: record.preHead, activeGate: 'GATE13', ledgerEventCount: 59,
    ledgerPrefixSha256: record.ledgerPrefixSha256, activationEventSha256: record.activationEventSha256,
    alreadyConsumed: false
  };
  return { record, observed, authorityAuthorized: true };
}

test('H4-10: a fully bound succession is authorized without any signature', () => {
  const result = evaluateActiveGateSuccession(successionFixture());
  assert.deepEqual(result.findings, []);
  assert.equal(result.decision, 'AUTHORIZED');
});

for (const [name, mutate] of [
  ['H4-11 wrong pre-head', (f) => { f.observed.head = '9'.repeat(40); }],
  ['H4-12 wrong previous ACTIVE_GATE', (f) => { f.observed.activeGate = 'GATE12'; }],
  ['H4-13 wrong ledger count', (f) => { f.observed.ledgerEventCount = 58; }],
  ['H4-14 wrong ledger prefix', (f) => { f.observed.ledgerPrefixSha256 = '9'.repeat(64); }],
  ['H4-15 wrong activation event', (f) => { f.observed.activationEventSha256 = '9'.repeat(64); }],
  ['H4-16 already consumed', (f) => { f.observed.alreadyConsumed = true; }],
  ['H4-17 not authorized by the program authority', (f) => { f.authorityAuthorized = false; }],
  ['H4-18 maxUse not 1', (f) => { f.record.maxUse = 2; }],
  ['H4-19 not actually a transition', (f) => { f.record.nextActiveGate = 'GATE13'; }]
]) {
  test(`${name} blocks`, () => {
    const fixture = successionFixture();
    mutate(fixture);
    assert.equal(evaluateActiveGateSuccession(fixture).decision, 'BLOCKED');
  });
}

test('H4-20: ACTIVE_GATE succession is NOT performed by this program', () => {
  // The mission forbids switching ACTIVE_GATE during GATE14. The primitive
  // exists and is tested; it is deliberately not exercised against the repo.
  const pointer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/active/ACTIVE_GATE.json'), 'utf8'));
  assert.equal(pointer.activeGate, 'GATE13');
});
