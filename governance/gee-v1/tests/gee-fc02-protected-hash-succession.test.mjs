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

const GATE_ID = 'GATE14';
const PROTECTED_PATH = 'governance/fixtures/fc02/protected-resource.bin';
const AUTHORITY_PATH = `governance/authority/authorizations/${GATE_ID}/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY_R0002.json`;
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const REQUIRED_PROHIBITIONS = [
  'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED', 'ACTIVE_GATE_SWITCH', 'GIT_PUSH', 'HISTORY_REWRITE',
  'LEDGER_REWRITE'
];

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

function writeRevision({ root, revision, checkpoint, currentContractPointer, contractSha256, previousStateSealSha256 }) {
  const revisionRoot = `governance/gates/${GATE_ID}/state/revisions/${revision}`;
  const checkpointPath = `${revisionRoot}/CHECKPOINT.json`;
  const defectsPath = `${revisionRoot}/OPEN_DEFECTS.json`;
  const sealPath = `${revisionRoot}/STATE_SEAL.json`;
  const currentContractPath = `governance/gates/${GATE_ID}/contracts/CURRENT_CONTRACT.json`;
  writeJson(root, currentContractPath, currentContractPointer);
  writeJson(root, checkpointPath, checkpoint);
  writeJson(root, defectsPath, { gateId: GATE_ID, stateRevision: revision, defects: [] });
  const sealedMembers = [
    member(root, currentContractPath),
    member(root, checkpointPath),
    member(root, defectsPath)
  ];
  const payload = {
    gateId: GATE_ID,
    stateRevision: revision,
    executionStatus: 'IN_PROGRESS',
    contractSha256,
    previousStateSealSha256,
    sealedMembersDigest: computeSealedMembersDigest(sealedMembers)
  };
  const seal = {
    schemaVersion: 1,
    gateId: GATE_ID,
    stateRevision: revision,
    sealedMembers,
    previousStateSealSha256,
    sealedAt: revision === 'R0001' ? '2026-09-01T00:00:00.000Z' : '2026-09-01T00:02:00.000Z',
    payload,
    payloadSha256: sha256Canonical(payload)
  };
  writeJson(root, sealPath, seal);
  return { checkpointPath, defectsPath, sealPath, seal, sealSha256: sha(fs.readFileSync(abs(root, sealPath))) };
}

function dummyLedgerPrefix(root) {
  const dummyAuthorityPath = 'governance/authority/DUMMY_FC02_LEDGER_SOURCE.json';
  writeJson(root, dummyAuthorityPath, { document: 'FC02_DUMMY_LEDGER_SOURCE' });
  const dummyAuthoritySha = sha(fs.readFileSync(abs(root, dummyAuthorityPath)));
  const events = [];
  let previousEventSha256 = null;
  for (let ordinal = 1; ordinal <= 58; ordinal += 1) {
    const next = event({
      schemaVersion: 1,
      ordinal,
      eventId: `FC02_DUMMY_${String(ordinal).padStart(4, '0')}`,
      gateId: 'GATE1',
      fromStatus: ordinal === 1 ? null : 'IN_PROGRESS',
      toStatus: 'IN_PROGRESS',
      transitionType: ordinal === 1 ? 'GENESIS_IMPORT' : 'EXECUTION_PROGRESS',
      authorityPath: dummyAuthorityPath,
      authoritySha256: dummyAuthoritySha,
      previousEventSha256,
      recordedAt: `2026-08-31T00:${String(Math.floor((ordinal - 1) / 60)).padStart(2, '0')}:${String((ordinal - 1) % 60).padStart(2, '0')}.000Z`
    });
    events.push(next);
    previousEventSha256 = next.eventPayloadSha256;
  }
  const prefixBytes = Buffer.from(`${events.map(canonicalize).join('\n')}\n`, 'utf8');
  return { events, prefixBytes, prefixSha256: sha(prefixBytes) };
}

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-fc02-succession-'));
  const oldBytes = Buffer.from('generic protected resource v1\n', 'utf8');
  const newBytes = Buffer.from('generic protected resource v2\n', 'utf8');
  const oldSha256 = sha(oldBytes);
  const newSha256 = sha(newBytes);
  writeBytes(root, PROTECTED_PATH, newBytes);

  const contractsRoot = `governance/gates/${GATE_ID}/contracts`;
  const predecessorContractPath = `${contractsRoot}/EXECUTION_CONTRACT_R0001.json`;
  const successorContractPath = `${contractsRoot}/EXECUTION_CONTRACT_R0002.json`;
  const currentContractPath = `${contractsRoot}/CURRENT_CONTRACT.json`;
  const predecessorContract = {
    gateId: GATE_ID,
    contractRevision: 'R0001',
    requiredInputs: [{ path: PROTECTED_PATH, sha256: oldSha256, role: 'PROTECTED_INPUT' }]
  };
  writeJson(root, predecessorContractPath, predecessorContract);
  const predecessorContractSha256 = sha(fs.readFileSync(abs(root, predecessorContractPath)));
  const successorContract = {
    gateId: GATE_ID,
    contractRevision: 'R0002',
    previousContractPath: predecessorContractPath,
    previousContractSha256: predecessorContractSha256,
    requiredInputs: [{ path: PROTECTED_PATH, sha256: newSha256, role: 'PROTECTED_INPUT' }]
  };
  writeJson(root, successorContractPath, successorContract);
  const successorContractSha256 = sha(fs.readFileSync(abs(root, successorContractPath)));
  const predecessorPointer = {
    schemaVersion: 1,
    gateId: GATE_ID,
    contractRevision: 'R0001',
    contractPath: predecessorContractPath,
    contractSha256: predecessorContractSha256,
    activatedByEventId: 'FC02_PREDECESSOR'
  };
  const successorPointer = {
    schemaVersion: 1,
    gateId: GATE_ID,
    contractRevision: 'R0002',
    contractPath: successorContractPath,
    contractSha256: successorContractSha256,
    activatedByEventId: 'FC02_CONTRACT_SUCCESSION_R0002'
  };
  writeJson(root, currentContractPath, predecessorPointer);
  const predecessorPointerSha256 = sha(fs.readFileSync(abs(root, currentContractPath)));

  const checkpointBase = {
    gateId: GATE_ID,
    milestone: 'FC02_GENERIC_SUCCESSION',
    resumePoint: 'fixture',
    completedTasks: [],
    openTasks: [],
    reusableEvidence: [],
    invalidatedEvidence: [],
    requiredNextActions: [],
    createdAt: '2026-09-01T00:00:00.000Z'
  };
  const r1 = writeRevision({
    root,
    revision: 'R0001',
    checkpoint: { ...checkpointBase, stateRevision: 'R0001', protectedHashes: [{ path: PROTECTED_PATH, sha256: oldSha256 }] },
    currentContractPointer: predecessorPointer,
    contractSha256: predecessorContractSha256,
    previousStateSealSha256: null
  });
  const r2 = writeRevision({
    root,
    revision: 'R0002',
    checkpoint: { ...checkpointBase, stateRevision: 'R0002', protectedHashes: [{ path: PROTECTED_PATH, sha256: newSha256 }], createdAt: '2026-09-01T00:02:00.000Z' },
    currentContractPointer: successorPointer,
    contractSha256: successorContractSha256,
    previousStateSealSha256: r1.sealSha256
  });
  const successorPointerSha256 = sha(fs.readFileSync(abs(root, currentContractPath)));

  const prefix = dummyLedgerPrefix(root);
  const authority = {
    documentKind: 'GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY',
    schemaVersion: 1,
    authorityId: 'FC02_GENERIC_CONTRACT_SUCCESSION_LOCAL_AUTHORITY_R0002',
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    projectId: 'WHEEL',
    gateId: GATE_ID,
    reason: 'Generic protected-hash successor fixture.',
    baseHead: '1'.repeat(40),
    preLedgerEventCount: 58,
    preLedgerPrefixSha256: prefix.prefixSha256,
    predecessorContractPath,
    predecessorContractSha256,
    predecessorContractRevision: 'R0001',
    successorContractPath,
    successorContractSha256,
    successorContractRevision: 'R0002',
    currentContractPointerPath: currentContractPath,
    predecessorCurrentContractSha256: predecessorPointerSha256,
    successorCurrentContractSha256: successorPointerSha256,
    previousStateSealSha256: r1.sealSha256,
    successorStateRevision: 'R0002',
    successorStateSealSha256: null,
    successorStateSealBinding: 'UNBOUND_AT_APPLY',
    ledgerHeadEventId: prefix.events.at(-1).eventId,
    ledgerHeadEventPayloadSha256: prefix.events.at(-1).eventPayloadSha256,
    maxUse: 1,
    pushAuthorized: false,
    functionalBuildAuthorized: false,
    prohibitedOperations: REQUIRED_PROHIBITIONS
  };
  writeJson(root, AUTHORITY_PATH, authority);
  const authoritySha256 = sha(fs.readFileSync(abs(root, AUTHORITY_PATH)));
  const succession = event({
    schemaVersion: 1,
    ordinal: 59,
    eventId: 'FC02_CONTRACT_SUCCESSION_R0002',
    gateId: GATE_ID,
    fromStatus: 'IN_PROGRESS',
    toStatus: 'IN_PROGRESS',
    transitionType: 'CONTRACT_SUCCESSION',
    authorityPath: AUTHORITY_PATH,
    authoritySha256,
    previousEventSha256: prefix.events.at(-1).eventPayloadSha256,
    recordedAt: '2026-09-01T00:03:00.000Z',
    stateRevision: 'R0002',
    stateRevisionSealSha256: r2.sealSha256
  });
  writeBytes(root, LEDGER_PATH, `${[...prefix.events, succession].map(canonicalize).join('\n')}\n`);
  const currentStatePath = `governance/gates/${GATE_ID}/state/CURRENT_STATE.json`;
  writeJson(root, currentStatePath, {
    schemaVersion: 1,
    gateId: GATE_ID,
    stateRevision: 'R0002',
    revisionPath: `governance/gates/${GATE_ID}/state/revisions/R0002`,
    stateSealSha256: r2.sealSha256,
    committedByTransactionId: 'FC02_GENERIC_SUCCESSION'
  });
  return {
    root,
    oldSha256,
    newSha256,
    protectedHash: { path: PROTECTED_PATH, sha256: oldSha256 },
    r1,
    r2,
    paths: { predecessorContractPath, successorContractPath, currentContractPath, currentStatePath }
  };
}

function classify(fixture, overrides = {}) {
  return classifyProtectedHashLiveCheck({
    root: fixture.root,
    gateId: GATE_ID,
    stateRevision: 'R0001',
    protectedHash: fixture.protectedHash,
    ...overrides
  });
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function hostile(name, mutate, expectedReason = null, overrides = null) {
  test(name, () => {
    const fixture = buildFixture();
    try {
      mutate(fixture);
      const result = classify(fixture, typeof overrides === 'function' ? overrides(fixture) : (overrides || {}));
      assert.equal(result.classification, PROTECTED_HASH_MISMATCH, JSON.stringify(result, null, 2));
      assert.equal(result.blocking, true);
      if (expectedReason) assert.ok(result.reasonCodes.some((code) => code.startsWith(expectedReason)), JSON.stringify(result, null, 2));
    } finally { cleanup(fixture); }
  });
}

test('FC02 successor positive: generic sealed R0001 old pin -> ledger-anchored CURRENT R0002 new pin', () => {
  const fixture = buildFixture();
  try {
    const historical = classify(fixture);
    assert.equal(historical.classification, HISTORICAL_PROTECTED_HASH_SUPERSEDED, JSON.stringify(historical, null, 2));
    assert.equal(historical.blocking, false);
    const current = classifyProtectedHashLiveCheck({
      root: fixture.root,
      gateId: GATE_ID,
      stateRevision: 'R0002',
      protectedHash: { path: PROTECTED_PATH, sha256: fixture.newSha256 }
    });
    assert.equal(current.classification, PROTECTED_HASH_MATCH);
    const report = validateStateRevision({ root: fixture.root, gateId: GATE_ID });
    assert.equal(report.valid, true, JSON.stringify(report.findings, null, 2));
    assert.equal(report.blockingCount, 0);
    assert.ok(report.findings.some((finding) => finding.detectorId === HISTORICAL_PROTECTED_HASH_SUPERSEDED && finding.severity === 'DISCLOSED'));
  } finally { cleanup(fixture); }
});

hostile('FC02 hostile: no successor', (fixture) => {
  fs.rmSync(abs(fixture.root, `governance/gates/${GATE_ID}/state/revisions/R0002`), { recursive: true, force: true });
}, 'CURRENT_REVISION_ABSENT');

hostile('FC02 hostile: other protected path', () => {}, 'PREDECESSOR_PROTECTED_PATH_MISSING', (fixture) => ({
  protectedHash: { path: 'governance/fixtures/fc02/other-resource.bin', sha256: fixture.oldSha256 }
}));

hostile('FC02 hostile: wrong predecessor hash', () => {}, 'PREDECESSOR_PROTECTED_HASH_BINDING_MISMATCH', () => ({
  protectedHash: { path: PROTECTED_PATH, sha256: 'f'.repeat(64) }
}));

hostile('FC02 hostile: wrong successor hash', (fixture) => {
  writeBytes(fixture.root, PROTECTED_PATH, 'unexpected third identity\n');
}, 'CURRENT_PROTECTED_HASH_LIVE_MISMATCH');

hostile('FC02 hostile: successor not CURRENT', (fixture) => {
  writeJson(fixture.root, fixture.paths.currentStatePath, {
    schemaVersion: 1,
    gateId: GATE_ID,
    stateRevision: 'R0001',
    revisionPath: `governance/gates/${GATE_ID}/state/revisions/R0001`,
    stateSealSha256: fixture.r1.sealSha256,
    committedByTransactionId: 'ROLLBACK'
  });
}, 'SUCCESSOR_NOT_CURRENT');

hostile('FC02 hostile: invalid successor checkpoint', (fixture) => {
  const checkpoint = readJson(fixture.root, fixture.r2.checkpointPath);
  checkpoint.gateId = 'GATE83';
  writeJson(fixture.root, fixture.r2.checkpointPath, checkpoint);
}, 'CHECKPOINT_IDENTITY_INVALID:R0002');

hostile('FC02 hostile: unsealed successor', (fixture) => {
  fs.rmSync(abs(fixture.root, fixture.r2.sealPath));
}, 'SUCCESSOR_UNSEALED');

hostile('FC02 hostile: unsealed predecessor', (fixture) => {
  fs.rmSync(abs(fixture.root, fixture.r1.sealPath));
}, 'PREDECESSOR_UNSEALED');

hostile('FC02 hostile: broken predecessor seal', (fixture) => {
  const seal = readJson(fixture.root, fixture.r1.sealPath);
  seal.payloadSha256 = '0'.repeat(64);
  writeJson(fixture.root, fixture.r1.sealPath, seal);
}, 'PREDECESSOR_SEAL_INVALID');

hostile('FC02 hostile: mutated predecessor checkpoint', (fixture) => {
  fs.appendFileSync(abs(fixture.root, fixture.r1.checkpointPath), ' ');
}, 'PREDECESSOR_SEAL_INVALID');

hostile('FC02 hostile: broken previous-state link', (fixture) => {
  const seal = readJson(fixture.root, fixture.r2.sealPath);
  seal.previousStateSealSha256 = '0'.repeat(64);
  writeJson(fixture.root, fixture.r2.sealPath, seal);
}, 'STATE_SEAL_PREVIOUS_LINK_INVALID:R0002');

hostile('FC02 hostile: skipped revision', (fixture) => {
  fs.renameSync(
    abs(fixture.root, `governance/gates/${GATE_ID}/state/revisions/R0002`),
    abs(fixture.root, `governance/gates/${GATE_ID}/state/revisions/R0003`)
  );
}, 'REVISION_SEQUENCE_GAP');

hostile('FC02 hostile: competing successor', (fixture) => {
  const competingRoot = `governance/gates/${GATE_ID}/state/revisions/R0003`;
  fs.mkdirSync(abs(fixture.root, competingRoot), { recursive: true });
  const seal = readJson(fixture.root, fixture.r2.sealPath);
  seal.stateRevision = 'R0003';
  seal.previousStateSealSha256 = fixture.r1.sealSha256;
  writeJson(fixture.root, `${competingRoot}/STATE_SEAL.json`, seal);
}, 'COMPETING_STATE_SUCCESSOR');

hostile('FC02 hostile: duplicate protected path', (fixture) => {
  const checkpoint = readJson(fixture.root, fixture.r1.checkpointPath);
  checkpoint.protectedHashes.push({ ...checkpoint.protectedHashes[0] });
  writeJson(fixture.root, fixture.r1.checkpointPath, checkpoint);
}, 'DUPLICATE_PROTECTED_PATH');

hostile('FC02 hostile: parallel CURRENT pointer', (fixture) => {
  writeJson(fixture.root, `governance/gates/${GATE_ID}/parallel/CURRENT_STATE.json`, readJson(fixture.root, fixture.paths.currentStatePath));
}, 'PARALLEL_CURRENT_STATE_POINTER');

hostile('FC02 hostile: missing succession authority', (fixture) => {
  fs.rmSync(abs(fixture.root, AUTHORITY_PATH));
}, 'CONTRACT_SUCCESSION_AUTHORITY_MISSING_OR_MISMATCH');

hostile('FC02 hostile: missing CONTRACT_SUCCESSION event', (fixture) => {
  const lines = fs.readFileSync(abs(fixture.root, LEDGER_PATH), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  const last = { ...lines.at(-1), transitionType: 'EXECUTION_PROGRESS' };
  delete last.eventPayloadSha256;
  lines[lines.length - 1] = event(last);
  writeBytes(fixture.root, LEDGER_PATH, `${lines.map(canonicalize).join('\n')}\n`);
}, 'CONTRACT_SUCCESSION_EVENT_MISSING_OR_COMPETING');

hostile('FC02 hostile: wrong gate', (fixture) => {
  const checkpoint = readJson(fixture.root, fixture.r1.checkpointPath);
  checkpoint.gateId = 'GATE83';
  writeJson(fixture.root, fixture.r1.checkpointPath, checkpoint);
}, 'PREDECESSOR_CHECKPOINT_IDENTITY_INVALID');

hostile('FC02 hostile: contract lineage mismatch', (fixture) => {
  const contract = readJson(fixture.root, fixture.paths.successorContractPath);
  contract.previousContractSha256 = '0'.repeat(64);
  writeJson(fixture.root, fixture.paths.successorContractPath, contract);
});

hostile('FC02 hostile: unauthorized .gitattributes mutation is never special-cased', (fixture) => {
  writeBytes(fixture.root, '.gitattributes', 'changed without succession\n');
}, 'PREDECESSOR_PROTECTED_PATH_MISSING', (fixture) => ({
  protectedHash: { path: '.gitattributes', sha256: fixture.oldSha256 }
}));

hostile('FC02 hostile: successor omits protected path', (fixture) => {
  const checkpoint = readJson(fixture.root, fixture.r2.checkpointPath);
  checkpoint.protectedHashes = [];
  writeJson(fixture.root, fixture.r2.checkpointPath, checkpoint);
}, 'SUCCESSOR_PROTECTED_PATH_MISSING');
