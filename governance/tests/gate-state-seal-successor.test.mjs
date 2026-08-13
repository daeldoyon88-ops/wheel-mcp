import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Bytes, sha256Canonical } from '../tools/canonical-json.mjs';
import { validateStateSeal } from '../tools/validate-state-seal.mjs';
import { validateStateRevision } from '../tools/validate-state-revision.mjs';

const GATE_ID = 'GATE15';
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  fs.writeFileSync(file, bytes);
  return sha256Bytes(bytes);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeCurrentPointer = (fixture, revision, contractSha) => writeJson(fixture.currentContractPath, {
  schemaVersion: 1,
  gateId: GATE_ID,
  contractRevision: revision,
  contractPath: `governance/gates/${GATE_ID}/contracts/EXECUTION_CONTRACT_${revision}.json`,
  contractSha256: contractSha,
  activatedByEventId: null
});

function revisionPaths(fixture, revision) {
  const directory = path.join(fixture.revisionRoot, revision);
  return {
    directory,
    checkpoint: path.join(directory, 'CHECKPOINT.json'),
    defects: path.join(directory, 'OPEN_DEFECTS.json'),
    seal: path.join(directory, 'STATE_SEAL.json')
  };
}

function writeRevisionInputs(fixture, revision) {
  const paths = revisionPaths(fixture, revision);
  writeJson(paths.checkpoint, {
    gateId: GATE_ID,
    stateRevision: revision,
    milestone: 'SUCCESSOR_VALIDATION',
    resumePoint: 'Continue with the next state-seal validation.',
    completedTasks: [],
    openTasks: ['Continue with the next state-seal validation.'],
    reusableEvidence: [],
    invalidatedEvidence: [],
    requiredNextActions: [],
    protectedHashes: [],
    createdAt: '2026-08-12T00:00:00.000Z'
  });
  writeJson(paths.defects, { gateId: GATE_ID, stateRevision: revision, defects: [] });
  return paths;
}

function makeSeal(fixture, revision, previousSealSha256) {
  const paths = revisionPaths(fixture, revision);
  const currentContractRelativePath = `governance/gates/${GATE_ID}/contracts/CURRENT_CONTRACT.json`;
  const currentContractBytes = fs.readFileSync(fixture.currentContractPath);
  const payload = { stateRevision: revision, purpose: 'successor state seal test' };
  return {
    schemaVersion: 1,
    gateId: GATE_ID,
    stateRevision: revision,
    sealedMembers: [
      { repoRelativePath: `governance/gates/${GATE_ID}/state/revisions/${revision}/CHECKPOINT.json`, sha256: sha256Bytes(fs.readFileSync(paths.checkpoint)), byteLength: fs.statSync(paths.checkpoint).size },
      { repoRelativePath: `governance/gates/${GATE_ID}/state/revisions/${revision}/OPEN_DEFECTS.json`, sha256: sha256Bytes(fs.readFileSync(paths.defects)), byteLength: fs.statSync(paths.defects).size },
      { repoRelativePath: currentContractRelativePath, sha256: sha256Bytes(currentContractBytes), byteLength: currentContractBytes.length }
    ],
    previousStateSealSha256: previousSealSha256,
    sealedAt: '2026-08-12T00:00:00.000Z',
    payload,
    payloadSha256: sha256Canonical(payload)
  };
}

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-state-seal-successor-'));
  const gateRoot = path.join(root, 'governance', 'gates', GATE_ID);
  const contractRoot = path.join(gateRoot, 'contracts');
  const revisionRoot = path.join(gateRoot, 'state', 'revisions');
  const currentContractPath = path.join(contractRoot, 'CURRENT_CONTRACT.json');
  const currentStatePath = path.join(gateRoot, 'state', 'CURRENT_STATE.json');
  const fixture = { root, gateRoot, contractRoot, revisionRoot, currentContractPath, currentStatePath };
  const contract1 = writeJson(path.join(contractRoot, 'EXECUTION_CONTRACT_R0001.json'), { gateId: GATE_ID, contractRevision: 'R0001', policy: 'predecessor' });
  const contract2 = writeJson(path.join(contractRoot, 'EXECUTION_CONTRACT_R0002.json'), { gateId: GATE_ID, contractRevision: 'R0002', policy: 'successor' });
  writeCurrentPointer(fixture, 'R0001', contract1);

  let previousSealSha256 = null;
  for (const revision of ['R0001', 'R0002']) {
    writeRevisionInputs(fixture, revision);
    const seal = makeSeal(fixture, revision, previousSealSha256);
    previousSealSha256 = writeJson(revisionPaths(fixture, revision).seal, seal);
  }

  writeCurrentPointer(fixture, 'R0002', contract2);
  writeRevisionInputs(fixture, 'R0003');
  const seal3 = makeSeal(fixture, 'R0003', previousSealSha256);
  const seal3Sha256 = writeJson(revisionPaths(fixture, 'R0003').seal, seal3);
  writeJson(currentStatePath, {
    schemaVersion: 1,
    gateId: GATE_ID,
    stateRevision: 'R0003',
    revisionPath: `governance/gates/${GATE_ID}/state/revisions/R0003`,
    stateSealSha256: seal3Sha256,
    committedByTransactionId: null
  });
  return fixture;
}

function validateFixture(fixture) {
  return validateStateRevision({ root: fixture.root, gateId: GATE_ID, currentStatePath: fixture.currentStatePath });
}

function mutateJson(file, mutator) {
  const value = readJson(file);
  mutator(value);
  writeJson(file, value);
}

function appendSuccessorRevision(fixture) {
  const contract3 = writeJson(path.join(fixture.contractRoot, 'EXECUTION_CONTRACT_R0003.json'), { gateId: GATE_ID, contractRevision: 'R0003', policy: 'successor-2' });
  writeCurrentPointer(fixture, 'R0003', contract3);
  const paths = writeRevisionInputs(fixture, 'R0004');
  const priorSealSha256 = sha256Bytes(fs.readFileSync(revisionPaths(fixture, 'R0003').seal));
  const sealSha256 = writeJson(paths.seal, makeSeal(fixture, 'R0004', priorSealSha256));
  writeJson(fixture.currentStatePath, {
    schemaVersion: 1,
    gateId: GATE_ID,
    stateRevision: 'R0004',
    revisionPath: `governance/gates/${GATE_ID}/state/revisions/R0004`,
    stateSealSha256: sealSha256,
    committedByTransactionId: null
  });
}

test('P01-P07 historical seals, newest successor seal, generic gate and repeated succession', () => {
  const fixture = buildFixture();
  try {
    assert.equal(validateStateSeal({ root: fixture.root, sealPath: revisionPaths(fixture, 'R0001').seal }).valid, true);
    assert.equal(validateStateSeal({ root: fixture.root, sealPath: revisionPaths(fixture, 'R0002').seal }).valid, true);
    assert.equal(validateStateSeal({ root: fixture.root, sealPath: revisionPaths(fixture, 'R0003').seal }).valid, true);
    assert.equal(validateFixture(fixture).valid, true);
    appendSuccessorRevision(fixture);
    assert.equal(validateFixture(fixture).valid, true);
    assert.equal(validateStateSeal({ root: fixture.root, sealPath: revisionPaths(fixture, 'R0003').seal }).valid, true);
    assert.equal(validateStateSeal({ root: fixture.root, sealPath: revisionPaths(fixture, 'R0004').seal }).valid, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

const hostileCases = [
  ['SS01 current projection changed after newest seal', (f) => mutateJson(f.currentContractPath, (value) => { value.contractRevision = 'R9999'; })],
  ['SS02 historical projection path changed', (f) => mutateJson(revisionPaths(f, 'R0002').seal, (value) => { value.sealedMembers[2].repoRelativePath = `governance/gates/${GATE_ID}/contracts/OTHER_CURRENT_CONTRACT.json`; })],
  ['SS03 historical projection bytes unavailable', (f) => fs.unlinkSync(f.currentContractPath)],
  ['SS04 historical binding altered', (f) => mutateJson(revisionPaths(f, 'R0002').seal, (value) => { value.sealedMembers[2].sha256 = '0'.repeat(64); })],
  ['SS05 predecessor link altered', (f) => mutateJson(revisionPaths(f, 'R0003').seal, (value) => { value.previousStateSealSha256 = '1'.repeat(64); })],
  ['SS06 revision gap', (f) => fs.rmSync(path.dirname(revisionPaths(f, 'R0002').seal), { recursive: true, force: true })],
  ['SS07 successor pointer contract identity altered', (f) => mutateJson(f.currentContractPath, (value) => { value.contractSha256 = '2'.repeat(64); })],
  ['SS08 current pointer bytes altered', (f) => mutateJson(f.currentContractPath, (value) => { value.activatedByEventId = 'UNAUTHORIZED'; })],
  ['SS09 cross-gate historical target', (f) => mutateJson(revisionPaths(f, 'R0002').seal, (value) => { value.sealedMembers[2].repoRelativePath = 'governance/gates/GATE16/contracts/CURRENT_CONTRACT.json'; })],
  ['SS10 unrelated contract artifact substituted', (f) => mutateJson(revisionPaths(f, 'R0002').seal, (value) => { value.sealedMembers[2].repoRelativePath = `governance/gates/${GATE_ID}/contracts/EXECUTION_CONTRACT_R0002.json`; })],
  ['SS11 current projection changes without new revision', (f) => mutateJson(f.currentContractPath, (value) => { value.contractRevision = 'R0002'; value.contractSha256 = '3'.repeat(64); })],
  ['SS12 newest seal claims stale projection identity', (f) => mutateJson(revisionPaths(f, 'R0003').seal, (value) => { value.sealedMembers[2].sha256 = '4'.repeat(64); })],
  ['SS13 old revision mutated', (f) => mutateJson(revisionPaths(f, 'R0001').seal, (value) => { value.payload.purpose = 'tampered'; })],
  ['SS14 duplicate historical target', (f) => mutateJson(revisionPaths(f, 'R0002').seal, (value) => { value.sealedMembers.push({ ...value.sealedMembers[2] }); })],
  ['SS15 synthetic fallback path', (f) => mutateJson(revisionPaths(f, 'R0002').seal, (value) => { value.sealedMembers[2].repoRelativePath = `governance/gates/${GATE_ID}/contracts/CURRENT_CONTRACT_R9999.json`; })],
  ['SS16 GEE path dependency', (f) => mutateJson(revisionPaths(f, 'R0002').seal, (value) => { value.sealedMembers[2].repoRelativePath = 'governance/gee-v1/R8/CURRENT_CONTRACT.json'; })]
];

test('SS01-SS16 hostile state-seal successor inputs fail closed', () => {
  for (const [name, mutate] of hostileCases) {
    const fixture = buildFixture();
    try {
      mutate(fixture);
      assert.equal(validateFixture(fixture).valid, false, name);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
