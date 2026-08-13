/**
 * H3 — a state seal must be evidence about the exact bytes at the exact path it
 * names, in the exact revision it claims.
 *
 * Each hostile below is a way of satisfying the OLD seal validator while the
 * bytes being hashed are not the bytes the seal appears to bind: a case-variant
 * path, a seal moved to another revision or Gate, a member reached through a
 * junction, or a member list quietly edited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateStateSeal, computeSealedMembersDigest } from '../../tools/validate-state-seal.mjs';
import { sha256Canonical } from '../../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = 'GATE14';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const codes = (report) => [...new Set(report.findings.map((f) => f.detectorId))];

/**
 * A minimal but REAL gate tree: two revisions, a chained seal pair, and a
 * current-contract projection, so the hardened rules are exercised against
 * files rather than mocks.
 */
function makeGateTree({ revision = 'R0002', members = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-seal-'));
  const gateDir = path.join(root, 'governance', 'gates', GATE);
  const revDir = path.join(gateDir, 'state', 'revisions', revision);
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(path.join(gateDir, 'contracts'), { recursive: true });

  // A non-root revision needs a REAL predecessor seal on disk, because the
  // chain check requires the previous seal's bytes to exist and to hash to the
  // declared link. Fabricating the link would only test the fixture.
  let previousStateSealSha256 = null;
  if (revision !== 'R0001') {
    const rootRevDir = path.join(gateDir, 'state', 'revisions', 'R0001');
    fs.mkdirSync(rootRevDir, { recursive: true });
    const rootCheckpoint = Buffer.from('{"checkpoint":"root"}\n', 'utf8');
    const rootDefects = Buffer.from('{"defects":[]}\n', 'utf8');
    fs.writeFileSync(path.join(rootRevDir, 'CHECKPOINT.json'), rootCheckpoint);
    fs.writeFileSync(path.join(rootRevDir, 'OPEN_DEFECTS.json'), rootDefects);
    const rootContract = Buffer.from('{"contractRevision":"R0001"}\n', 'utf8');
    fs.writeFileSync(path.join(gateDir, 'contracts', 'CURRENT_CONTRACT.json'), rootContract);
    const rootMembers = [
      { repoRelativePath: `governance/gates/${GATE}/state/revisions/R0001/CHECKPOINT.json`, sha256: sha(rootCheckpoint), byteLength: rootCheckpoint.length },
      { repoRelativePath: `governance/gates/${GATE}/state/revisions/R0001/OPEN_DEFECTS.json`, sha256: sha(rootDefects), byteLength: rootDefects.length },
      { repoRelativePath: `governance/gates/${GATE}/contracts/CURRENT_CONTRACT.json`, sha256: sha(rootContract), byteLength: rootContract.length }
    ];
    const rootPayload = { gateId: GATE, stateRevision: 'R0001', executionStatus: 'AUTHORIZED_NOT_STARTED', sealedMembersDigest: computeSealedMembersDigest(rootMembers) };
    const rootSeal = {
      schemaVersion: 1, gateId: GATE, stateRevision: 'R0001', sealedMembers: rootMembers,
      previousStateSealSha256: null, sealedAt: '2026-08-12T00:00:00.000Z',
      payload: rootPayload, payloadSha256: sha256Canonical(rootPayload)
    };
    const rootSealBytes = Buffer.from(JSON.stringify(rootSeal, null, 2), 'utf8');
    fs.writeFileSync(path.join(rootRevDir, 'STATE_SEAL.json'), rootSealBytes);
    previousStateSealSha256 = sha(rootSealBytes);
  }

  const checkpoint = Buffer.from('{"checkpoint":true}\n', 'utf8');
  const defects = Buffer.from('{"defects":[]}\n', 'utf8');
  const contract = Buffer.from('{"contractRevision":"R0001"}\n', 'utf8');
  fs.writeFileSync(path.join(revDir, 'CHECKPOINT.json'), checkpoint);
  fs.writeFileSync(path.join(revDir, 'OPEN_DEFECTS.json'), defects);
  fs.writeFileSync(path.join(gateDir, 'contracts', 'CURRENT_CONTRACT.json'), contract);

  const sealedMembers = members ?? [
    { repoRelativePath: `governance/gates/${GATE}/state/revisions/${revision}/CHECKPOINT.json`, sha256: sha(checkpoint), byteLength: checkpoint.length },
    { repoRelativePath: `governance/gates/${GATE}/state/revisions/${revision}/OPEN_DEFECTS.json`, sha256: sha(defects), byteLength: defects.length },
    { repoRelativePath: `governance/gates/${GATE}/contracts/CURRENT_CONTRACT.json`, sha256: sha(contract), byteLength: contract.length }
  ];
  const payload = { gateId: GATE, stateRevision: revision, executionStatus: 'IN_PROGRESS', sealedMembersDigest: computeSealedMembersDigest(sealedMembers) };
  const seal = {
    schemaVersion: 1, gateId: GATE, stateRevision: revision, sealedMembers,
    previousStateSealSha256,
    sealedAt: '2026-08-13T00:00:00.000Z', payload, payloadSha256: sha256Canonical(payload)
  };
  const sealPath = path.join(revDir, 'STATE_SEAL.json');
  fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));
  return { root, sealPath, seal, revDir, gateDir };
}

const rewrite = (sealPath, mutate) => {
  const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  mutate(seal);
  seal.payloadSha256 = sha256Canonical(seal.payload);
  fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));
};

test('H3-01: a well-formed seal at its canonical location validates', () => {
  const { root, sealPath } = makeGateTree();
  const report = validateStateSeal({ root, sealPath, currentRevision: 'R0002' });
  assert.deepEqual(report.findings, [], JSON.stringify(report.findings));
  fs.rmSync(root, { recursive: true, force: true });
});

test('H3-02: a case-variant member path is rejected before its bytes are hashed', () => {
  const { root, sealPath } = makeGateTree();
  rewrite(sealPath, (seal) => {
    seal.sealedMembers[0].repoRelativePath = `governance/Gates/${GATE}/state/revisions/R0002/CHECKPOINT.json`;
  });
  const report = validateStateSeal({ root, sealPath, currentRevision: 'R0002' });
  assert.ok(report.findings.length > 0);
  // On a case-insensitive filesystem the bytes would otherwise have hashed fine.
  assert.ok(codes(report).includes('SEALED_MEMBER_PATH_CASE_MISMATCH') || codes(report).includes('STATE_SEAL_MEMBER_MISMATCH'));
  assert.equal(report.valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('H3-03: a member reached through a directory junction is rejected', () => {
  const { root, sealPath, gateDir } = makeGateTree();
  const realDir = path.join(root, 'outside-evidence');
  fs.mkdirSync(realDir, { recursive: true });
  const decoy = Buffer.from('{"checkpoint":true}\n', 'utf8');
  fs.writeFileSync(path.join(realDir, 'CHECKPOINT.json'), decoy);
  const linkDir = path.join(gateDir, 'state', 'revisions', 'LINKED');
  let linked = true;
  try {
    fs.symlinkSync(realDir, linkDir, 'junction');
  } catch {
    linked = false; // unprivileged environments may refuse; the rule still holds
  }
  if (linked) {
    rewrite(sealPath, (seal) => {
      seal.sealedMembers[0] = { repoRelativePath: `governance/gates/${GATE}/state/revisions/LINKED/CHECKPOINT.json`, sha256: sha(decoy), byteLength: decoy.length };
    });
    const report = validateStateSeal({ root, sealPath, currentRevision: 'R0002' });
    assert.equal(report.valid, false);
    assert.ok(codes(report).includes('SEALED_MEMBER_REPARSE_POINT'), codes(report).join(','));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('H3-04: an edited sealed member set breaks sealedMembersDigest', () => {
  const { root, sealPath, revDir } = makeGateTree();
  const extra = Buffer.from('{"extra":true}\n', 'utf8');
  fs.writeFileSync(path.join(revDir, 'EXTRA.json'), extra);
  // Add a member and update ONLY its own hash, as a tamperer would.
  const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  seal.sealedMembers.push({ repoRelativePath: `governance/gates/${GATE}/state/revisions/R0002/EXTRA.json`, sha256: sha(extra), byteLength: extra.length });
  seal.payloadSha256 = sha256Canonical(seal.payload);
  fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));
  const report = validateStateSeal({ root, sealPath, currentRevision: 'R0002' });
  assert.equal(report.valid, false);
  assert.ok(codes(report).includes('SEALED_MEMBERS_DIGEST_MISMATCH'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('H3-05: a seal relocated to another revision directory is rejected', () => {
  const { root, sealPath, gateDir } = makeGateTree();
  const otherDir = path.join(gateDir, 'state', 'revisions', 'R0007');
  fs.mkdirSync(otherDir, { recursive: true });
  const relocated = path.join(otherDir, 'STATE_SEAL.json');
  fs.copyFileSync(sealPath, relocated);
  const report = validateStateSeal({ root, sealPath: relocated, currentRevision: 'R0002' });
  assert.equal(report.valid, false);
  assert.ok(codes(report).includes('SEAL_NOT_AT_CANONICAL_LOCATION'));
  assert.ok(codes(report).includes('SEAL_REVISION_DIRECTORY_MISMATCH'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('H3-06: a seal relocated into another Gate is rejected', () => {
  const { root, sealPath } = makeGateTree();
  const otherGateDir = path.join(root, 'governance', 'gates', 'GATE15', 'state', 'revisions', 'R0002');
  fs.mkdirSync(otherGateDir, { recursive: true });
  const relocated = path.join(otherGateDir, 'STATE_SEAL.json');
  fs.copyFileSync(sealPath, relocated);
  const report = validateStateSeal({ root, sealPath: relocated, currentRevision: 'R0002' });
  assert.equal(report.valid, false);
  assert.ok(codes(report).includes('SEAL_NOT_AT_CANONICAL_LOCATION'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('H3-07: planting a maximum-looking revision no longer changes how a seal is verified', () => {
  const { root, sealPath, gateDir } = makeGateTree();
  const before = validateStateSeal({ root, sealPath, currentRevision: 'R0002' });
  fs.mkdirSync(path.join(gateDir, 'state', 'revisions', 'R9999'), { recursive: true });
  const after = validateStateSeal({ root, sealPath, currentRevision: 'R0002' });
  // Identical verdict and identical findings: no readdir authority remains.
  assert.equal(after.valid, before.valid);
  assert.deepEqual(codes(after), codes(before));
  fs.rmSync(root, { recursive: true, force: true });
});

test('H3-08: a superseded revision keeps immutable members pinned but tolerates a moved projection', () => {
  const { root, sealPath, gateDir, revDir } = makeGateTree();
  // The mutable CURRENT_CONTRACT projection legitimately advances...
  fs.writeFileSync(path.join(gateDir, 'contracts', 'CURRENT_CONTRACT.json'), Buffer.from('{"contractRevision":"R0002"}\n', 'utf8'));
  const superseded = validateStateSeal({ root, sealPath, currentRevision: 'R0003' });
  assert.equal(superseded.valid, true, JSON.stringify(superseded.findings));
  // ...but an IMMUTABLE member never may, in any era.
  fs.writeFileSync(path.join(revDir, 'CHECKPOINT.json'), Buffer.from('{"checkpoint":"TAMPERED"}\n', 'utf8'));
  const tampered = validateStateSeal({ root, sealPath, currentRevision: 'R0003' });
  assert.equal(tampered.valid, false);
  assert.ok(codes(tampered).includes('STATE_SEAL_MEMBER_MISMATCH'));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- the real repository ----------------------------------------------------

test('H3-09: the real GATE14 R0001 and R0002 seals remain byte-identical and valid', () => {
  const pinned = {
    R0001: { sha256: 'c7004faf6368c46a96ec44a230cf594c4f7a4b09ad0f0901c15638071ca9c38d', byteLength: 1238 },
    R0002: { sha256: 'ca29d6ade22c0de9a9eeb18b9d2dfa4d48b202996951a4223e3fc13d3f04c5dd', byteLength: 1257 }
  };
  for (const [revision, expected] of Object.entries(pinned)) {
    const sealPath = path.join(REPO_ROOT, `governance/gates/${GATE}/state/revisions/${revision}/STATE_SEAL.json`);
    const bytes = fs.readFileSync(sealPath);
    assert.equal(sha(bytes), expected.sha256, revision);
    assert.equal(bytes.length, expected.byteLength, revision);
    const report = validateStateSeal({ root: REPO_ROOT, sealPath });
    assert.deepEqual(report.findings, [], `${revision}: ${JSON.stringify(report.findings)}`);
  }
});

test('H3-10: legacy seals carry no sealedMembersDigest and are not required to', () => {
  const seal = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, `governance/gates/${GATE}/state/revisions/R0001/STATE_SEAL.json`), 'utf8'));
  assert.equal(Object.hasOwn(seal.payload, 'sealedMembersDigest'), false);
  assert.deepEqual(validateStateSeal({ root: REPO_ROOT, sealPath: path.join(REPO_ROOT, `governance/gates/${GATE}/state/revisions/R0001/STATE_SEAL.json`) }).findings, []);
});
