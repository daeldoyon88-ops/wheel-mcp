/**
 * GATE14 CURRENT_STATE LINEAGE, against the ledger validator.
 *
 * WHAT THIS SUITE IS FOR. `validate-status-ledger` treats the four
 * AUTHORIZATION state-cohort roles differently on purpose: CHECKPOINT,
 * OPEN_DEFECTS and STATE_SEAL are byte-pinned forever, while CURRENT_STATE is a
 * MUTABLE_PROJECTION whose pin is re-imposed only while the pointer still names
 * the authorization-time revision. P01 proves the pointer may advance; CS-H01..03
 * prove the immutable members may not move; the rest fence the lineage.
 *
 * TWO DEFECTS IN THE PREDECESSOR OF THIS FILE, both now repaired.
 *
 * 1. THE FIXTURE WAS NOT SELF-CONTAINED. It cloned an absolute path outside the
 *    repository, so the evidence could not be reproduced anywhere else and was
 *    silently coupled to bytes nobody versioned. The same snapshot now lives in
 *    the repository as a single archive and is expanded per test.
 *
 * 2. EVERY POSITIVE CONTROL WAS FAILING, AND SILENTLY. `run` overrode the policy
 *    to verify the START authority with `TEST_GATE_START_KEY.json`. That key is
 *    not what signed this fixture's START authority — the real PROJECT_OWNER key
 *    is — but it carries THE SAME `keyId`, so the key-identity check passed and
 *    verification failed one step later as a bare "signature invalid". P01, P02,
 *    CS-H13 and CS-H14 had therefore been failing while the twelve hostile cases
 *    still "passed", which is the exact shape of a suite that refuses everything
 *    and proves nothing. The override is gone; the default owner key is used, and
 *    the archive no longer carries the colliding TEST key at all.
 *
 * TEST IDENTITIES ARE UNCHANGED. All sixteen keep their names and their subjects;
 * only the fixture source and the verification key were repaired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { validateLedger } from '../tools/validate-status-ledger.mjs';
import { validateStateRevision } from '../tools/validate-state-revision.mjs';
import { validateStateSeal } from '../tools/validate-state-seal.mjs';
import { sha256Canonical, sha256Bytes } from '../tools/canonical-json.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

/**
 * The governed repository as it stood at the GATE14 START R2 boundary — ledger
 * ordinal 58 — stored as one gzipped path-to-content archive. Data only: no
 * validators and no tests are carried, so this snapshot can never be mistaken
 * for a second copy of the code under test.
 */
const FIXTURE_ARCHIVE = path.resolve(import.meta.dirname, 'fixtures/gate14-start-r2-fixture.json.gz');
const FIXTURE_FILE_COUNT = 97;
const GATE = 'GATE14';
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const CURRENT = 'governance/gates/GATE14/state/CURRENT_STATE.json';
const R1 = 'governance/gates/GATE14/state/revisions/R0001';
const R2 = 'governance/gates/GATE14/state/revisions/R0002';

function cloneFuture() {
  assert.equal(fs.existsSync(FIXTURE_ARCHIVE), true, 'the GATE14_START_R2 fixture archive is required');
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE_ARCHIVE)).toString('utf8'));
  assert.equal(archive.documentKind, 'GATE14_CURRENT_STATE_LINEAGE_FIXTURE_ARCHIVE');
  // The archive must expand completely. A truncated expansion would make every
  // hostile case "block" for want of files rather than for the invariant.
  assert.equal(Object.keys(archive.files).length, FIXTURE_FILE_COUNT, 'fixture archive is incomplete');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate14-current-state-lineage-'));
  for (const [relative, contents] of Object.entries(archive.files)) {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
  }
  return root;
}

function remove(root) { fs.rmSync(root, { recursive: true, force: true }); }
function absolute(root, relative) { return path.join(root, ...relative.split('/')); }
function readJson(root, relative) { return JSON.parse(fs.readFileSync(absolute(root, relative), 'utf8')); }
function writeJson(root, relative, value) { fs.writeFileSync(absolute(root, relative), `${JSON.stringify(value, null, 2)}\n`); }
function fileSha(root, relative) { return sha256Bytes(fs.readFileSync(absolute(root, relative))); }
function run(root) {
  // The canonical policy, unmodified. The fixture's authorities are signed by the
  // real PROJECT_OWNER key, so that is the key that must verify them.
  return validateLedger({ root, ledgerPath: absolute(root, LEDGER), policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
}
function blockingIds(report) { return report.findings.filter((finding) => finding.severity === 'BLOCKING').map((finding) => finding.detectorId); }
function assertBlocked(root, expected, label) {
  const report = run(root);
  assert.equal(report.valid, false, `${label} unexpectedly passed`);
  assert.ok(blockingIds(report).includes(expected), `${label}: ${JSON.stringify(blockingIds(report))}`);
}
function mutateFile(root, relative, mutate) {
  const file = absolute(root, relative);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(value);
  writeJson(root, relative, value);
}

test('P01 future R2 is a valid descendant and CURRENT_STATE may advance', () => {
  const root = cloneFuture();
  try {
    const report = run(root);
    assert.equal(report.valid, true, JSON.stringify(report.findings.filter((f) => f.severity === 'BLOCKING'), null, 2));
    assert.equal(report.events.length, 58);
    assert.equal(report.gates.find((gate) => gate.gateId === GATE).currentStatus, 'IN_PROGRESS');
    assert.equal(readJson(root, CURRENT).stateRevision, 'R0002');
    assert.equal(validateStateRevision({ root, gateId: GATE, currentStatePath: absolute(root, CURRENT), contractPath: absolute(root, 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json') }).valid, true);
    assert.equal(validateStateSeal({ root, sealPath: absolute(root, `${R2}/STATE_SEAL.json`) }).valid, true);
  } finally { remove(root); }
});

test('P02 derived views remain mutable projections, not permanent AUTHORIZATION byte pins', () => {
  const root = cloneFuture();
  try {
    writeJson(root, 'governance/state/generated/GATE_STATUS_SNAPSHOT.json', { generated: 'later-ledger-projection' });
    const report = run(root);
    assert.equal(report.valid, true, JSON.stringify(blockingIds(report)));
  } finally { remove(root); }
});

const immutableHostiles = [
  ['CS-H01', `${R1}/CHECKPOINT.json`],
  ['CS-H02', `${R1}/OPEN_DEFECTS.json`],
  ['CS-H03', `${R1}/STATE_SEAL.json`]
];
for (const [id, relative] of immutableHostiles) {
  test(`${id} mutation of immutable R0001 member blocks`, () => {
    const root = cloneFuture();
    try {
      fs.appendFileSync(absolute(root, relative), ' ');
      assertBlocked(root, 'GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', id);
    } finally { remove(root); }
  });
}

test('CS-H04 CURRENT_STATE points to nonexistent revision', () => {
  const root = cloneFuture();
  try {
    mutateFile(root, CURRENT, (state) => { state.stateRevision = 'R0009'; state.revisionPath = 'governance/gates/GATE14/state/revisions/R0009'; });
    assertBlocked(root, 'GATE_AUTHORIZATION_CURRENT_STATE_SEAL_MISSING', 'CS-H04');
  } finally { remove(root); }
});

test('CS-H05 R0002 seal has a broken previous-seal link', () => {
  const root = cloneFuture();
  try {
    mutateFile(root, `${R2}/STATE_SEAL.json`, (seal) => { seal.previousStateSealSha256 = '0'.repeat(64); });
    assertBlocked(root, 'GATE_AUTHORIZATION_STATE_LINEAGE_INVALID', 'CS-H05');
  } finally { remove(root); }
});

test('CS-H06 R0002 seal claims a foreign lineage', () => {
  const root = cloneFuture();
  try {
    const foreignSealSha = fileSha(root, 'governance/gates/GATE13/state/revisions/R0002/STATE_SEAL.json');
    mutateFile(root, `${R2}/STATE_SEAL.json`, (seal) => {
      seal.previousStateSealSha256 = foreignSealSha;
      seal.payload.previousStateSealSha256 = foreignSealSha;
      seal.payloadSha256 = sha256Canonical(seal.payload);
    });
    assertBlocked(root, 'GATE_AUTHORIZATION_STATE_LINEAGE_INVALID', 'CS-H06');
  } finally { remove(root); }
});

test('CS-H07 CURRENT_STATE seal hash mismatch blocks', () => {
  const root = cloneFuture();
  try {
    mutateFile(root, CURRENT, (state) => { state.stateSealSha256 = 'f'.repeat(64); });
    assertBlocked(root, 'GATE_AUTHORIZATION_CURRENT_STATE_SEAL_MISMATCH', 'CS-H07');
  } finally { remove(root); }
});

test('CS-H08 ledger IN_PROGRESS and current execution status AUTHORIZED_NOT_STARTED blocks', () => {
  const root = cloneFuture();
  try {
    mutateFile(root, `${R2}/STATE_SEAL.json`, (seal) => {
      seal.payload.executionStatus = 'AUTHORIZED_NOT_STARTED';
      seal.payloadSha256 = sha256Canonical(seal.payload);
    });
    mutateFile(root, CURRENT, (state) => { state.stateSealSha256 = fileSha(root, `${R2}/STATE_SEAL.json`); });
    assertBlocked(root, 'GATE_AUTHORIZATION_CURRENT_STATE_STATUS_MISMATCH', 'CS-H08');
  } finally { remove(root); }
});

test('CS-H09 ledger AUTHORIZED_NOT_STARTED and current execution status IN_PROGRESS blocks', () => {
  const root = cloneFuture();
  try {
    const lines = fs.readFileSync(absolute(root, LEDGER), 'utf8').trim().split(/\r?\n/);
    fs.writeFileSync(absolute(root, LEDGER), `${lines.slice(0, -1).join('\n')}\n`);
    assertBlocked(root, 'GATE_AUTHORIZATION_CURRENT_STATE_STATUS_MISMATCH', 'CS-H09');
  } finally { remove(root); }
});

test('CS-H10 CURRENT_STATE skips to malformed R0003', () => {
  const root = cloneFuture();
  try {
    mutateFile(root, CURRENT, (state) => { state.stateRevision = 'R0003'; state.revisionPath = 'governance/gates/GATE14/state/revisions/R0003'; });
    assertBlocked(root, 'GATE_AUTHORIZATION_STATE_LINEAGE_INVALID', 'CS-H10');
  } finally { remove(root); }
});

test('CS-H11 arbitrary sideways CURRENT_STATE projection blocks', () => {
  const root = cloneFuture();
  try {
    mutateFile(root, CURRENT, (state) => { state.revisionPath = 'governance/gates/GATE13/state/revisions/R0002'; });
    assertBlocked(root, 'GATE_AUTHORIZATION_CURRENT_STATE_SIDEWAYS', 'CS-H11');
  } finally { remove(root); }
});

test('CS-H12 mutation of the event-57 authorization record blocks', () => {
  const root = cloneFuture();
  try {
    mutateFile(root, 'governance/authority/authorizations/GATE14/GATE_AUTHORIZATION_RECORD.json', (record) => { record.authorizationId = 'MUTATED'; });
    assertBlocked(root, 'INVALID_GATE_AUTHORIZATION_RECORD', 'CS-H12');
  } finally { remove(root); }
});

test('CS-H13 exact valid R0002 descendant passes', () => {
  const root = cloneFuture();
  try { assert.equal(run(root).valid, true); } finally { remove(root); }
});

test('CS-H14 generic valid R0003 descendant passes', () => {
  const root = cloneFuture();
  try {
    const r3 = 'governance/gates/GATE14/state/revisions/R0003';
    const checkpoint = { ...readJson(root, `${R2}/CHECKPOINT.json`), stateRevision: 'R0003' };
    const defects = { ...readJson(root, `${R2}/OPEN_DEFECTS.json`), stateRevision: 'R0003' };
    fs.mkdirSync(absolute(root, r3), { recursive: true });
    writeJson(root, `${r3}/CHECKPOINT.json`, checkpoint);
    writeJson(root, `${r3}/OPEN_DEFECTS.json`, defects);
    const checkpointRel = `${r3}/CHECKPOINT.json`;
    const defectsRel = `${r3}/OPEN_DEFECTS.json`;
    const contractRel = 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json';
    const payload = {
      gateId: GATE,
      stateRevision: 'R0003',
      executionStatus: 'IN_PROGRESS',
      contractSha256: fileSha(root, 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json'),
      previousStateSealSha256: fileSha(root, `${R2}/STATE_SEAL.json`)
    };
    const seal = {
      schemaVersion: 1,
      gateId: GATE,
      stateRevision: 'R0003',
      sealedMembers: [
        { repoRelativePath: checkpointRel, sha256: fileSha(root, checkpointRel), byteLength: fs.statSync(absolute(root, checkpointRel)).size },
        { repoRelativePath: defectsRel, sha256: fileSha(root, defectsRel), byteLength: fs.statSync(absolute(root, defectsRel)).size },
        { repoRelativePath: contractRel, sha256: fileSha(root, contractRel), byteLength: fs.statSync(absolute(root, contractRel)).size }
      ],
      previousStateSealSha256: payload.previousStateSealSha256,
      sealedAt: '2026-08-12T12:00:00.000Z',
      payload,
      payloadSha256: sha256Canonical(payload)
    };
    writeJson(root, `${r3}/STATE_SEAL.json`, seal);
    mutateFile(root, CURRENT, (state) => {
      state.stateRevision = 'R0003';
      state.revisionPath = r3;
      state.stateSealSha256 = fileSha(root, `${r3}/STATE_SEAL.json`);
      state.committedByTransactionId = 'GATE14-R0003-TEST';
    });
    const report = run(root);
    assert.equal(report.valid, true, JSON.stringify(report.findings.filter((f) => f.severity === 'BLOCKING'), null, 2));
  } finally { remove(root); }
});
