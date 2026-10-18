import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyProtectedHashLiveCheck,
  HISTORICAL_PROTECTED_HASH_SUPERSEDED,
  PROTECTED_HASH_MATCH,
  PROTECTED_HASH_MISMATCH,
  validateStateRevision
} from '../../tools/validate-state-revision.mjs';
import { computeSealedMembersDigest } from '../../tools/validate-state-seal.mjs';
import { canonicalize, sha256Bytes, sha256Canonical } from '../../tools/canonical-json.mjs';
const sha = (bytes) => sha256Bytes(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));

const abs = (root, relative) => path.join(root, ...relative.split('/'));

function writeBytes(root, relative, bytes) {
  const target = abs(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function writeJson(root, relative, value) {
  return writeBytes(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(abs(root, relative), 'utf8'));
}

function event(payload) {
  return { ...payload, eventPayloadSha256: sha256Canonical(payload) };
}

function member(root, relative) {
  const bytes = fs.readFileSync(abs(root, relative));
  return { repoRelativePath: relative, sha256: sha(bytes), byteLength: bytes.length };
}

const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const CROSS_SOURCE_GATE = 'GATE15';
const CROSS_PINNING_GATE = 'GATE21';
const CROSS_PROTECTED_PATH = 'governance/fixtures/fc02/cross-gate-resource.bin';

function writeCrossGateRevision({ root, gateId, protectedHashes, contractPin, sealedAt }) {
  const contractsRoot = `governance/gates/${gateId}/contracts`;
  const contractPath = `${contractsRoot}/EXECUTION_CONTRACT_R0001.json`;
  const currentContractPath = `${contractsRoot}/CURRENT_CONTRACT.json`;
  const contract = {
    gateId,
    contractRevision: 'R0001',
    requiredInputs: [{ path: contractPin.path, sha256: contractPin.sha256, role: 'PROTECTED_INPUT' }]
  };
  writeJson(root, contractPath, contract);
  const contractSha256 = sha(fs.readFileSync(abs(root, contractPath)));
  writeJson(root, currentContractPath, {
    schemaVersion: 1,
    gateId,
    contractRevision: 'R0001',
    contractPath,
    contractSha256,
    activatedByEventId: `${gateId}_COMPLETE_CONFIRMED`
  });
  const revisionRoot = `governance/gates/${gateId}/state/revisions/R0001`;
  const checkpointPath = `${revisionRoot}/CHECKPOINT.json`;
  const defectsPath = `${revisionRoot}/OPEN_DEFECTS.json`;
  const sealPath = `${revisionRoot}/STATE_SEAL.json`;
  writeJson(root, checkpointPath, {
    gateId,
    stateRevision: 'R0001',
    milestone: 'CROSS_GATE_PROTECTED_HASH_SUCCESSION',
    resumePoint: 'fixture',
    completedTasks: [],
    openTasks: [],
    reusableEvidence: [],
    invalidatedEvidence: [],
    requiredNextActions: [],
    protectedHashes,
    createdAt: sealedAt
  });
  writeJson(root, defectsPath, { gateId, stateRevision: 'R0001', defects: [] });
  const sealedMembers = [
    member(root, currentContractPath),
    member(root, checkpointPath),
    member(root, defectsPath)
  ];
  const payload = {
    gateId,
    stateRevision: 'R0001',
    executionStatus: 'COMPLETE_CONFIRMED',
    contractSha256,
    previousStateSealSha256: null,
    sealedMembersDigest: computeSealedMembersDigest(sealedMembers)
  };
  const seal = {
    schemaVersion: 1,
    gateId,
    stateRevision: 'R0001',
    sealedMembers,
    previousStateSealSha256: null,
    sealedAt,
    payload,
    payloadSha256: sha256Canonical(payload)
  };
  writeJson(root, sealPath, seal);
  const sealSha256 = sha(fs.readFileSync(abs(root, sealPath)));
  writeJson(root, `governance/gates/${gateId}/state/CURRENT_STATE.json`, {
    schemaVersion: 1,
    gateId,
    stateRevision: 'R0001',
    revisionPath: revisionRoot,
    stateSealSha256: sealSha256,
    committedByTransactionId: `${gateId}_FIXTURE`
  });
  return { contractPath, sealPath, sealSha256 };
}

function writeCrossLedger(root, specifications) {
  const events = [];
  let previousEventSha256 = null;
  for (const [index, specification] of specifications.entries()) {
    const next = event({
      schemaVersion: 1,
      ordinal: index + 1,
      eventId: specification.eventId,
      gateId: specification.gateId,
      fromStatus: specification.fromStatus,
      toStatus: specification.toStatus,
      transitionType: specification.transitionType,
      authorityPath: `governance/authority/${specification.eventId}.json`,
      authoritySha256: String(index + 1).repeat(64).slice(0, 64),
      previousEventSha256,
      recordedAt: `2026-09-02T00:0${index}:00.000Z`,
      stateRevision: 'R0001',
      stateRevisionSealSha256: specification.sealSha256
    });
    events.push(next);
    previousEventSha256 = next.eventPayloadSha256;
  }
  writeBytes(root, LEDGER_PATH, `${events.map(canonicalize).join('\n')}\n`);
}

function buildCrossGateFixture({
  pinningStatus = 'COMPLETE_CONFIRMED',
  omitLaterProof = false,
  duplicateLaterProof = false,
  proofBeforeSource = false,
  pinPath = CROSS_PROTECTED_PATH,
  pinLiveHash = true
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-fc02-cross-gate-'));
  const oldBytes = Buffer.from('cross-gate protected resource v1\n', 'utf8');
  const liveBytes = Buffer.from('cross-gate protected resource v2\n', 'utf8');
  const oldSha256 = sha(oldBytes);
  const liveSha256 = sha(liveBytes);
  writeBytes(root, CROSS_PROTECTED_PATH, liveBytes);
  const source = writeCrossGateRevision({
    root,
    gateId: CROSS_SOURCE_GATE,
    protectedHashes: [{ path: CROSS_PROTECTED_PATH, sha256: oldSha256 }],
    contractPin: { path: CROSS_PROTECTED_PATH, sha256: oldSha256 },
    sealedAt: '2026-09-02T00:00:00.000Z'
  });
  const pinning = writeCrossGateRevision({
    root,
    gateId: CROSS_PINNING_GATE,
    protectedHashes: [{ path: pinPath, sha256: pinLiveHash ? liveSha256 : oldSha256 }],
    contractPin: { path: pinPath, sha256: pinLiveHash ? liveSha256 : oldSha256 },
    sealedAt: '2026-09-02T00:01:00.000Z'
  });
  const sourceEvent = {
    eventId: 'CROSS_SOURCE_COMPLETE_CONFIRMED',
    gateId: CROSS_SOURCE_GATE,
    fromStatus: 'COMPLETE_AGENT',
    toStatus: 'COMPLETE_CONFIRMED',
    transitionType: 'EXTERNAL_CONFIRMATION',
    sealSha256: source.sealSha256
  };
  const proofEvent = {
    eventId: 'CROSS_PINNING_COMPLETE_CONFIRMED',
    gateId: CROSS_PINNING_GATE,
    fromStatus: 'COMPLETE_AGENT',
    toStatus: pinningStatus,
    transitionType: 'EXTERNAL_CONFIRMATION',
    sealSha256: pinning.sealSha256
  };
  const specifications = omitLaterProof
    ? [sourceEvent]
    : (proofBeforeSource ? [proofEvent, sourceEvent] : [sourceEvent, proofEvent]);
  if (duplicateLaterProof) specifications.push({ ...proofEvent, eventId: 'CROSS_PINNING_COMPLETE_CONFIRMED_DUPLICATE' });
  writeCrossLedger(root, specifications);
  return { root, oldSha256, liveSha256, source, pinning };
}

function classifyCross(fixture) {
  return classifyProtectedHashLiveCheck({
    root: fixture.root,
    gateId: CROSS_SOURCE_GATE,
    stateRevision: 'R0001',
    protectedHash: { path: CROSS_PROTECTED_PATH, sha256: fixture.oldSha256 }
  });
}

function crossHostile(name, options, mutate = null, expectedReason = null) {
  test(name, () => {
    const fixture = buildCrossGateFixture(options);
    try {
      if (mutate) mutate(fixture);
      const result = classifyCross(fixture);
      assert.equal(result.classification, PROTECTED_HASH_MISMATCH, JSON.stringify(result, null, 2));
      assert.equal(result.blocking, true);
      if (expectedReason) assert.ok(result.reasonCodes.includes(expectedReason), JSON.stringify(result, null, 2));
    } finally { cleanup(fixture); }
  });
}

test('FC02 cross-gate positive: earliest later sealed contract pin is completed and ledger-anchored', () => {
  const fixture = buildCrossGateFixture();
  try {
    const result = classifyCross(fixture);
    assert.equal(result.classification, HISTORICAL_PROTECTED_HASH_SUPERSEDED, JSON.stringify(result, null, 2));
    assert.equal(result.blocking, false);
  } finally { cleanup(fixture); }
});

crossHostile('FC02 cross-gate hostile: pinning gate is not COMPLETE_CONFIRMED', { pinningStatus: 'COMPLETE_AGENT' }, null, 'CROSS_GATE_LATER_PROOF_ABSENT');
crossHostile('FC02 cross-gate hostile: no later proof', { omitLaterProof: true }, null, 'CROSS_GATE_LATER_PROOF_ABSENT');
crossHostile('FC02 cross-gate hostile: multiple later proofs', { duplicateLaterProof: true }, null, 'CROSS_GATE_LATER_PROOF_AMBIGUOUS');
crossHostile('FC02 cross-gate hostile: proof event is not actually later', { proofBeforeSource: true }, null, 'CROSS_GATE_PROOF_NOT_LATER');
crossHostile('FC02 cross-gate hostile: later contract does not pin live hash', { pinLiveHash: false }, null, 'CROSS_GATE_LATER_PROOF_ABSENT');
crossHostile('FC02 cross-gate hostile: protected path mismatch', { pinPath: 'governance/fixtures/fc02/other-cross-gate-resource.bin' }, null, 'CROSS_GATE_LATER_PROOF_ABSENT');
crossHostile('FC02 cross-gate hostile: invalid ledger', {}, (fixture) => {
  fs.appendFileSync(abs(fixture.root, LEDGER_PATH), '{');
}, 'CROSS_GATE_LEDGER_INVALID');
crossHostile('FC02 cross-gate hostile: unsealed proof', {}, (fixture) => {
  fs.rmSync(abs(fixture.root, fixture.pinning.sealPath));
}, 'CROSS_GATE_EVENT_SEAL_MISSING_OR_MISMATCH');
crossHostile('FC02 cross-gate hostile: ambiguous proof contract identity', {}, (fixture) => {
  const duplicatePath = `governance/gates/${CROSS_PINNING_GATE}/contracts/EXECUTION_CONTRACT_R0002.json`;
  writeBytes(fixture.root, duplicatePath, fs.readFileSync(abs(fixture.root, fixture.pinning.contractPath)));
}, 'CROSS_GATE_EVENT_CONTRACT_IDENTITY_AMBIGUOUS');


test('FC02 reconciliation hostile: caller cannot substitute the checkpoint hash', () => { const f=buildCrossGateFixture(); try { const r=classifyProtectedHashLiveCheck({root:f.root,gateId:CROSS_SOURCE_GATE,stateRevision:'R0001',protectedHash:{path:CROSS_PROTECTED_PATH,sha256:'0'.repeat(64)}}); assert.equal(r.classification, PROTECTED_HASH_MISMATCH); assert.ok(r.reasonCodes.includes('PREDECESSOR_PROTECTED_HASH_BINDING_MISMATCH')); } finally { fs.rmSync(f.root,{recursive:true,force:true}); } });

function cleanup(fixture) { fs.rmSync(fixture.root,{recursive:true,force:true}); }
