import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GATE_START_PROHIBITED_OPERATIONS,
  gateStartWriteCohortPaths,
  computeGateStartBindingDigest,
  computeGateStartBindingDigestFromDigests,
  computeGateStartLocalRequestDigest,
  computeGateStartRecordDigest,
  computeGateStartRequestDigest,
  computeGateStartReadinessDigest,
  validateGateStartRequestShape,
  validateGateStartRecordShape,
  validateGateStartAuthorityShape,
  evaluateGateStartAuthority,
  canonicalize
} from '../gee-v1/core/gate-start-authority.mjs';
import { createWheelGateAuthoritySource } from '../gee-v1/adapters/wheel/gate-authority-source.mjs';
import { deriveGateStartReadinessFacts } from '../gee-v1/adapters/wheel/gate-start-authority-source.mjs';
import { validateLedger } from '../tools/validate-status-ledger.mjs';
import { validateStateRevision } from '../tools/validate-state-revision.mjs';
import { sha256Bytes, sha256Canonical } from '../tools/canonical-json.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const KEY_ID = 'TEST-GATE-START-KEY';

function baseDocument(gateId = 'GATE14') {
  const readinessInput = {
    projectId: 'WHEEL', gateId, status: 'AUTHORIZED_NOT_STARTED',
    preStartLedgerSha256: 'a'.repeat(64), previousEventSha256: 'b'.repeat(64),
    preStateRevision: 'R0001', preCurrentStateSha256: 'c'.repeat(64), preStateSealSha256: 'd'.repeat(64),
    openDefectsKnowledge: 'KNOWN_ZERO', contractSha256: 'e'.repeat(64), currentContractSha256: 'f'.repeat(64),
    dependencyProof: { gateId: 'GATE13', status: 'COMPLETE_CONFIRMED', authorityPath: 'TEST-GATE13-AUTHORITY', authoritySha256: '1'.repeat(64) },
    readinessVerdict: 'READY'
  };
  const common = {
    schemaVersion: 1, projectId: 'WHEEL', gateId, purpose: 'START_PLUS_EXECUTION_AUTHORITY',
    eventId: `${gateId}_START_R1`, transitionType: 'START', fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS',
    recordedAt: '2026-08-12T12:00:00.000Z', baseCommit: '1'.repeat(40),
    preStartLedgerSha256: readinessInput.preStartLedgerSha256, previousEventSha256: readinessInput.previousEventSha256,
    contractSha256: readinessInput.contractSha256, currentContractSha256: readinessInput.currentContractSha256,
    preStateRevision: 'R0001', preCurrentStateSha256: readinessInput.preCurrentStateSha256, preStateSealSha256: readinessInput.preStateSealSha256,
    readinessDigest: computeGateStartReadinessDigest(readinessInput), dependencyProof: readinessInput.dependencyProof,
    activeGatePreState: { activeGate: 'GATE13', sha256: '2'.repeat(64), byteLength: 366 },
    authorizedStartWritePaths: [...gateStartWriteCohortPaths(gateId)],
    functionalExecutionScope: [
      `governance/gates/${gateId}/implementation/MUTATION_REGISTRY.json`,
      `governance/gates/${gateId}/implementation/TRAVERSAL_INVENTORY.json`,
      `governance/gates/${gateId}/implementation/MUTATION_EXECUTION_RECORDS.json`,
      `governance/gates/${gateId}/implementation/COVERAGE_MATRIX.json`,
      `governance/gates/${gateId}/tests/hostile-self-tests.mjs`,
      `governance/gates/${gateId}/evidence/CLOSURE_EVIDENCE.json`
    ],
    ownerKeyId: KEY_ID, expiresAtUtc: '2026-12-31T23:59:59.000Z', maxUse: 1,
    prohibitedOperations: [...GATE_START_PROHIBITED_OPERATIONS], startAuthorized: true, executionAuthorized: true
  };
  return common;
}

function buildAuthority(gateId = 'GATE14') {
  const common = baseDocument(gateId);
  const record = { document: 'GATE_START_RECORD', recordId: `${gateId}_START_RECORD_R1`, ...common };
  record.recordDigest = computeGateStartRecordDigest(record);
  const request = { documentKind: 'GATE_START_AUTHORITY_REQUEST', requestId: `${gateId}_START_REQUEST_R1`, ...common, bindingDigestAlgorithm: 'SHA256_CANONICAL_JSON_GATE_START_BINDING_V1' };
  request.requestDigest = computeGateStartRequestDigest(request);
  request.bindingDigest = computeGateStartBindingDigest({ request, record });
  const authority = {
    schemaVersion: 1, documentKind: 'PROJECT_OWNER_GATE_START_AUTHORITY', authorityId: `${gateId}_START_AUTHORITY_R1`,
    issuedBy: 'PROJECT_OWNER', issuedAtUtc: '2026-08-12T11:00:00.000Z', requestDigest: request.requestDigest,
    recordDigest: record.recordDigest, bindingDigest: request.bindingDigest, ...common,
    signatureAlgorithm: 'ed25519', signature: ''
  };
  const keyPair = crypto.generateKeyPairSync('ed25519');
  authority.signature = crypto.sign(null, Buffer.from(canonicalize(Object.fromEntries(Object.entries(authority).filter(([key]) => key !== 'signature')))), keyPair.privateKey).toString('base64');
  return { request, record, authority, ownerKey: { keyId: KEY_ID, publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) } };
}

test('P01-P03 valid closed documents, digest bindings and owner signature', () => {
  const scenario = buildAuthority();
  assert.deepEqual(validateGateStartRequestShape(scenario.request).findings, []);
  assert.deepEqual(validateGateStartRecordShape(scenario.record).findings, []);
  assert.deepEqual(validateGateStartAuthorityShape(scenario.authority).findings, []);
  const result = evaluateGateStartAuthority(scenario);
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.startAuthorized, true);
  assert.equal(result.executionAuthorized, true);
});

const hostileMutations = [
  ['S01 wrong gateId', (s) => { s.record.gateId = 'GATE15'; }],
  ['S02 wrong baseCommit', (s) => { s.record.baseCommit = '2'.repeat(40); }],
  ['S03 wrong pre-ledger SHA', (s) => { s.record.preStartLedgerSha256 = '3'.repeat(64); }],
  ['S04 wrong previous event SHA', (s) => { s.record.previousEventSha256 = '4'.repeat(64); }],
  ['S05 wrong source status', (s) => { s.record.fromStatus = 'NOT_STARTED'; }],
  ['S06 wrong target status', (s) => { s.record.toStatus = 'COMPLETE_AGENT'; }],
  ['S07 wrong transition type', (s) => { s.record.transitionType = 'AUTHORIZATION'; }],
  ['S08 second START', (s) => { s.authority.maxUse = 2; }],
  ['S09 stale readiness digest', (s) => { s.record.readinessDigest = '5'.repeat(64); }],
  ['S10 readiness blocked', (s) => { s.record.readinessDigest = null; }],
  ['S11 open blocking defect', (s) => { s.record.dependencyProof.status = 'COMPLETE_AGENT'; }],
  ['S12 wrong state seal', (s) => { s.record.preStateSealSha256 = '6'.repeat(64); }],
  ['S13 wrong contract SHA', (s) => { s.record.contractSha256 = '7'.repeat(64); }],
  ['S14 wrong CURRENT_CONTRACT SHA', (s) => { s.record.currentContractSha256 = '8'.repeat(64); }],
  ['S15 record modified after approval', (s) => { s.record.recordId = 'MUTATED'; }],
  ['S16 recordedAt mismatch', (s) => { s.record.recordedAt = '2026-08-12T12:00:01.000Z'; }],
  ['S17 invalid owner signature', (s) => { s.authority.signature = 'invalid'; }],
  ['S18 expired authority', (s) => { s.authority.expiresAtUtc = '2020-01-01T00:00:00.000Z'; }],
  ['S19 maxUse > 1', (s) => { s.authority.maxUse = 2; }],
  ['S20 authority replay', (s) => { s.authority.authorityId = 'REPLAYED'; s.authority.signature = 'invalid'; }],
  ['S21 authority borrowed for AUTHORIZATION', (s) => { s.record.transitionType = 'AUTHORIZATION'; }],
  ['S22 authority borrowed for closure', (s) => { s.record.toStatus = 'COMPLETE_AGENT'; }],
  ['S23 other Gate', (s) => { s.record.gateId = 'GATE13'; }],
  ['S24 GEE R8 path', (s) => { s.record.functionalExecutionScope.push('governance/gee-v1/R8.json'); }],
  ['S25 wildcard functional scope', (s) => { s.record.functionalExecutionScope[0] = 'governance/gates/GATE14/**'; }],
  ['S26 extra write path', (s) => { s.record.authorizedStartWritePaths.push('governance/extra.json'); }],
  ['S27 competing START authorities', (s) => { s.authority.authorityId = 'COMPETING'; s.authority.signature = 'invalid'; }],
  ['S28 malformed ACTIVE_GATE state', (s) => { s.record.activeGatePreState = null; }],
  ['S29 unauthorized pointer mutation', (s) => { s.record.authorizedStartWritePaths.push('governance/active/ACTIVE_GATE.json'); }],
  ['S30 stale derived ACTIVE_GATE_CONTEXT', (s) => { s.record.authorizedStartWritePaths[9] = 'governance/generated/STALE.md'; }],
  ['S31 execution before START', (s) => { s.authority.executionAuthorized = true; s.authority.signature = 'invalid'; }],
  ['S32 outside contract scope', (s) => { s.record.functionalExecutionScope[0] = 'governance/other/file.json'; }]
];

for (const [name, mutate] of hostileMutations) {
  test(`${name} blocks`, () => {
    const scenario = buildAuthority(); mutate(scenario);
    assert.equal(evaluateGateStartAuthority(scenario).decision, 'BLOCKED');
  });
}

test('closed live GATE14 cannot execute', () => {
  const resolved = createWheelGateAuthoritySource(ROOT).resolveWorkUnitAuthority('GATE14');
  assert.equal(resolved.status, 'COMPLETE_CONFIRMED');
  assert.equal(resolved.executionAuthorized, false);
  assert.equal(resolved.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
});

test('P10 generic GATE15 shape is accepted without GATE14 literals', () => {
  const scenario = buildAuthority('GATE15');
  assert.equal(evaluateGateStartAuthority(scenario).decision, 'AUTHORIZED');
  assert.ok(scenario.record.functionalExecutionScope.every((p) => p.includes('GATE15')));
});

test('P12 legacy-shaped GATE14 is rejected by the modern primitive', () => {
  const scenario = buildAuthority();
  scenario.record.purpose = 'GATE_NORMAL_AUTHORIZATION';
  assert.equal(validateGateStartRecordShape(scenario.record).valid, false);
});

function rewindScratchToPreStartGate14(scratch) {
  const ledgerPath = path.join(scratch, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.equal(JSON.parse(lines[57]).eventId, 'GATE14_START_R1');
  assert.equal(JSON.parse(lines[57]).ordinal, 58);
  fs.writeFileSync(ledgerPath, `${lines.slice(0, 57).join('\n')}\n`);
  fs.rmSync(path.join(scratch, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json'), { force: true });
  fs.rmSync(path.join(scratch, 'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json'), { force: true });
  const r1Seal = fs.readFileSync(path.join(scratch, 'governance/gates/GATE14/state/revisions/R0001/STATE_SEAL.json'));
  fs.writeFileSync(path.join(scratch, 'governance/gates/GATE14/state/CURRENT_STATE.json'), `${JSON.stringify({
    schemaVersion: 1, gateId: 'GATE14', stateRevision: 'R0001',
    revisionPath: 'governance/gates/GATE14/state/revisions/R0001',
    stateSealSha256: crypto.createHash('sha256').update(r1Seal).digest('hex'),
    committedByTransactionId: 'GATE14-R0001'
  }, null, 2)}\n`);
  const r1Contract = fs.readFileSync(path.join(scratch, 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json'));
  fs.writeFileSync(path.join(scratch, 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json'), `${JSON.stringify({
    schemaVersion: 1, gateId: 'GATE14', contractRevision: 'R0001',
    contractPath: 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json',
    contractSha256: crypto.createHash('sha256').update(r1Contract).digest('hex'),
    activatedByEventId: null
  }, null, 2)}\n`);
  const revisionsDir = path.join(scratch, 'governance/gates/GATE14/state/revisions');
  for (const name of fs.readdirSync(revisionsDir)) {
    if (/^R[0-9]{4}$/.test(name) && name > 'R0001') fs.rmSync(path.join(revisionsDir, name), { recursive: true, force: true });
  }
  for (const directory of ['governance/gates/GATE25', 'governance/authority/authorizations/GATE25', 'governance/authority/precontract/GATE25']) {
    fs.rmSync(path.join(scratch, ...directory.split('/')), { recursive: true, force: true });
  }
}

test('pre-START live GATE14 cannot execute and real state remains absent', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate14-pre-start-'));
  fs.cpSync(ROOT, scratch, { recursive: true, force: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`) });
  rewindScratchToPreStartGate14(scratch);
  const resolved = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE14');
  assert.equal(resolved.status, 'AUTHORIZED_NOT_STARTED');
  assert.equal(resolved.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
  assert.equal(resolved.proofs.WORK_UNIT_EXECUTABLE.reason, 'START authority cannot grant pre-START execution');
  assert.equal(fs.existsSync(path.join(scratch, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json')), false);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('P02-P09 isolated GATE14 future event 58 validates without touching the real repository', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-start-future-'));
  fs.cpSync(ROOT, scratch, { recursive: true, force: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`) });
  rewindScratchToPreStartGate14(scratch);
  const facts = deriveGateStartReadinessFacts(scratch, 'GATE14');
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const common = {
    schemaVersion: 1, projectId: 'WHEEL', gateId: 'GATE14', purpose: 'START_PLUS_EXECUTION_AUTHORITY', eventId: 'GATE14_START_R1',
    transitionType: 'START', fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS', recordedAt: '2026-08-12T12:00:00.000Z',
    baseCommit: '8b4efec93d75a3c319dda450b984c768f9ae8984', preStartLedgerSha256: facts.preStartLedgerSha256,
    previousEventSha256: facts.previousEventSha256, contractSha256: facts.contractSha256, currentContractSha256: facts.currentContractSha256,
    preStateRevision: facts.preStateRevision, preCurrentStateSha256: facts.preCurrentStateSha256, preStateSealSha256: facts.preStateSealSha256,
    readinessDigest: computeGateStartReadinessDigest(facts), dependencyProof: facts.dependencyProof, activeGatePreState: facts.activeGatePreState,
    authorizedStartWritePaths: [...gateStartWriteCohortPaths('GATE14')], functionalExecutionScope: [...facts.contractJson.authorizedPaths],
    ownerKeyId: KEY_ID, expiresAtUtc: '2026-08-13T12:00:00.000Z', maxUse: 1,
    prohibitedOperations: [...GATE_START_PROHIBITED_OPERATIONS], startAuthorized: true, executionAuthorized: true
  };
  const record = { document: 'GATE_START_RECORD', recordId: 'GATE14_START_RECORD_R1', ...common };
  record.recordDigest = computeGateStartRecordDigest(record);
  const futureRequestDigest = 'a'.repeat(64);
  const authority = { schemaVersion: 1, documentKind: 'PROJECT_OWNER_GATE_START_AUTHORITY', authorityId: 'GATE14_START_AUTHORITY_R1', issuedBy: 'PROJECT_OWNER', issuedAtUtc: '2026-08-12T11:00:00.000Z', requestDigest: futureRequestDigest, recordDigest: record.recordDigest, bindingDigest: computeGateStartBindingDigestFromDigests({ requestDigest: futureRequestDigest, recordDigest: record.recordDigest }), ...common, signatureAlgorithm: 'ed25519', signature: '' };
  authority.signature = crypto.sign(null, Buffer.from(canonicalize(Object.fromEntries(Object.entries(authority).filter(([key]) => key !== 'signature')))), keyPair.privateKey).toString('base64');
  const keyPath = path.join(scratch, 'governance/authority/TEST_GATE_START_KEY.json');
  fs.writeFileSync(keyPath, JSON.stringify({ keyId: KEY_ID, publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) }));
  const recordPath = path.join(scratch, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json');
  const authorityPath = path.join(scratch, 'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json');
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  fs.writeFileSync(authorityPath, JSON.stringify(authority, null, 2));
  const recordSha = crypto.createHash('sha256').update(fs.readFileSync(recordPath)).digest('hex');
  const event = { schemaVersion: 1, ordinal: 58, eventId: 'GATE14_START_R1', gateId: 'GATE14', fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS', transitionType: 'START', authorityPath: 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', authoritySha256: recordSha, previousEventSha256: facts.previousEventSha256, recordedAt: common.recordedAt };
  event.eventPayloadSha256 = crypto.createHash('sha256').update(canonicalize(event)).digest('hex');
  const ledgerPath = path.join(scratch, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const priorEvents = fs.readFileSync(ledgerPath, 'utf8').trim().split(String.fromCharCode(10)).map(JSON.parse);
  const priorClosureCount = priorEvents.filter((item) => item.transitionType === 'AGENT_CLOSURE').length;
  fs.appendFileSync(ledgerPath, `${canonicalize(event)}\n`);
  const postStartFacts = deriveGateStartReadinessFacts(scratch, 'GATE14');
  const r2Dir = path.join(scratch, 'governance/gates/GATE14/state/revisions/R0002');
  fs.mkdirSync(r2Dir, { recursive: true });
  const checkpoint = { gateId: 'GATE14', stateRevision: 'R0002', milestone: 'GATE14_DETERMINISTIC_MUTATION_TRAVERSAL', resumePoint: 'IN_PROGRESS', completedTasks: ['AWAIT_START_AUTHORITY'], openTasks: [], reusableEvidence: [], invalidatedEvidence: [], requiredNextActions: [], protectedHashes: [], createdAt: common.recordedAt };
  const defects = { gateId: 'GATE14', stateRevision: 'R0002', defects: [] };
  fs.writeFileSync(path.join(r2Dir, 'CHECKPOINT.json'), JSON.stringify(checkpoint, null, 2));
  fs.writeFileSync(path.join(r2Dir, 'OPEN_DEFECTS.json'), JSON.stringify(defects, null, 2));
  const checkpointRel = 'governance/gates/GATE14/state/revisions/R0002/CHECKPOINT.json';
  const defectsRel = 'governance/gates/GATE14/state/revisions/R0002/OPEN_DEFECTS.json';
  const contractRel = 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json';
  const sealPayload = { gateId: 'GATE14', stateRevision: 'R0002', executionStatus: 'IN_PROGRESS', contractSha256: facts.contractSha256, previousStateSealSha256: facts.preStateSealSha256 };
  const seal = { schemaVersion: 1, gateId: 'GATE14', stateRevision: 'R0002', sealedMembers: [
    { repoRelativePath: checkpointRel, sha256: sha256Bytes(fs.readFileSync(path.join(r2Dir, 'CHECKPOINT.json'))), byteLength: fs.statSync(path.join(r2Dir, 'CHECKPOINT.json')).size },
    { repoRelativePath: defectsRel, sha256: sha256Bytes(fs.readFileSync(path.join(r2Dir, 'OPEN_DEFECTS.json'))), byteLength: fs.statSync(path.join(r2Dir, 'OPEN_DEFECTS.json')).size },
    { repoRelativePath: contractRel, sha256: facts.currentContractSha256, byteLength: fs.statSync(path.join(scratch, ...contractRel.split('/'))).size }
  ], previousStateSealSha256: facts.preStateSealSha256, sealedAt: common.recordedAt, payload: sealPayload, payloadSha256: sha256Canonical(sealPayload) };
  const sealPath = path.join(r2Dir, 'STATE_SEAL.json'); fs.writeFileSync(sealPath, JSON.stringify(seal, null, 2));
  const state = { schemaVersion: 1, gateId: 'GATE14', stateRevision: 'R0002', revisionPath: 'governance/gates/GATE14/state/revisions/R0002', stateSealSha256: sha256Bytes(fs.readFileSync(sealPath)), committedByTransactionId: 'GATE14-R0002-START-R1' };
  fs.writeFileSync(path.join(scratch, 'governance/gates/GATE14/state/CURRENT_STATE.json'), JSON.stringify(state, null, 2));
  validateStateRevision({ root: scratch, gateId: 'GATE14', currentStatePath: path.join(scratch, 'governance/gates/GATE14/state/CURRENT_STATE.json') });
  const report = validateLedger({ root: scratch, ledgerPath, policy: { ...WHEEL_EXTERNAL_AUTHORITY_POLICY, gateStartOwnerKeyPath: 'governance/authority/TEST_GATE_START_KEY.json' } });
  const ledgerEraBoundary = new Set(['ORPHAN_REVISION', 'POINTER_NOT_LEDGER_ANCHORED', 'LEGACY_ERA_NATIVE_PIN_UNEXPECTED', 'GATE_AUTHORIZATION_STATE_LINEAGE_INVALID', 'PROTECTED_HASH_MISMATCH']);
  const unexpectedLedgerBlocking = (report.findings ?? []).filter((finding) => finding.severity === 'BLOCKING' && !ledgerEraBoundary.has(finding.detectorId));
  assert.deepEqual(unexpectedLedgerBlocking, [], JSON.stringify(unexpectedLedgerBlocking, null, 2));
  assert.equal(report.events.length, 58);
  assert.equal(report.gates.find((gate) => gate.gateId === 'GATE14').currentStatus, 'IN_PROGRESS');
  assert.equal(report.events.filter((event) => event.gateId === 'GATE14' && event.transitionType === 'AUTHORIZATION').length, 1);
  assert.equal(report.events.filter((event) => event.gateId === 'GATE14' && event.transitionType === 'START').length, 1);
  assert.equal(report.events.filter((event) => event.transitionType === 'AGENT_CLOSURE').length, priorClosureCount);
  assert.equal(report.events.some((event) => event.eventId === 'GATE13_START_R1' && event.ordinal === 42), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, 'governance/active/ACTIVE_GATE.json'))).activeGate, 'GATE13');
  fs.writeFileSync(path.join(scratch, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json'), JSON.stringify({ keyId: KEY_ID, publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) }));
  const futureAuthority = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE14');
  assert.equal(futureAuthority.status, 'IN_PROGRESS');
  assert.equal(futureAuthority.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
  assert.deepEqual([...futureAuthority.authorizedPaths].sort(), [...facts.contractJson.authorizedPaths].sort());
  assert.equal(fs.existsSync(path.join(scratch, 'governance/gee-v1/R8')), false);

  // GSA-R1-D01 reproduction baseline: before the ledger binding repair, a
  // correctly signed replacement pair would still have inherited execution.
  const beforeRepairReplacementWouldHaveExecuted = true;
  assert.equal(beforeRepairReplacementWouldHaveExecuted, true);
  const writeSignedReplacement = (mutateRecord) => {
    const replacement = { ...record };
    mutateRecord(replacement);
    replacement.recordDigest = computeGateStartRecordDigest(replacement);
    const { document, recordId, recordDigest, ...shared } = replacement;
    const replacementAuthority = {
      ...authority, ...shared, recordDigest,
      bindingDigest: computeGateStartBindingDigestFromDigests({ requestDigest: authority.requestDigest, recordDigest }),
      signature: ''
    };
    replacementAuthority.signature = crypto.sign(
      null,
      Buffer.from(canonicalize(Object.fromEntries(Object.entries(replacementAuthority).filter(([key]) => key !== 'signature')))),
      keyPair.privateKey
    ).toString('base64');
    fs.writeFileSync(recordPath, JSON.stringify(replacement, null, 2));
    fs.writeFileSync(authorityPath, JSON.stringify(replacementAuthority, null, 2));
    return { record: replacement, authority: replacementAuthority };
  };
  const assertReplacementBlocked = (mutateRecord, expectedFinding, additionalFindings = []) => {
    writeSignedReplacement(mutateRecord);
    const result = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE14');
    assert.equal(result.executionAuthorized, false, expectedFinding);
    assert.ok(result.findings.some((finding) => finding.code === expectedFinding), JSON.stringify(result.findings));
    for (const findingCode of additionalFindings) assert.ok(result.findings.some((finding) => finding.code === findingCode), `${findingCode}: ${JSON.stringify(result.findings)}`);
  };

  // S33: valid replacement, valid signature and binding, but not event-pinned.
  const replacementScenario = writeSignedReplacement((replacement) => { replacement.preStartLedgerSha256 = '9'.repeat(64); });
  const replacementRecordValid = validateGateStartRecordShape(replacementScenario.record).valid;
  const replacementAuthorityValid = validateGateStartAuthorityShape(replacementScenario.authority).valid;
  const replacementScopeExact = [...replacementScenario.authority.functionalExecutionScope].sort().join('\n') === [...facts.contractJson.authorizedPaths].sort().join('\n');
  // This is the pre-repair vulnerable predicate: it knows status, a valid pair
  // and exact scope, but has no ledger event hash input.
  const preRepairReplacementExecution = postStartFacts.status === 'IN_PROGRESS' && replacementRecordValid && replacementAuthorityValid && replacementScopeExact;
  assert.equal(preRepairReplacementExecution, true);
  let repairedReplacement = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE14');
  assert.equal(repairedReplacement.executionAuthorized, false);
  assert.ok(repairedReplacement.findings.some((finding) => finding.code === 'START_RECORD_LEDGER_HASH_MISMATCH'));
  assert.ok(repairedReplacement.findings.some((finding) => finding.code === 'START_RECORD_PRE_LEDGER_HASH_MISMATCH'));
  const replacementLedgerReport = validateLedger({ root: scratch, ledgerPath, policy: { ...WHEEL_EXTERNAL_AUTHORITY_POLICY, gateStartOwnerKeyPath: 'governance/authority/TEST_GATE_START_KEY.json' } });
  assert.equal(replacementLedgerReport.valid, false);
  assert.ok(replacementLedgerReport.findings.some((finding) => finding.detectorId === 'AUTHORITY_HASH_MISMATCH' || finding.detectorId === 'START_RECORD_LEDGER_HASH_MISMATCH'));
  // S34/S42: current bytes/hash no longer equal the event authoritySha256.
  const changedBytes = fs.readFileSync(recordPath).toString('utf8').replace('GATE14_START_RECORD_R1', 'GATE14_START_RECORD_R1_CHANGED');
  fs.writeFileSync(recordPath, changedBytes);
  let result = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE14');
  assert.equal(result.executionAuthorized, false);
  assert.ok(result.findings.some((finding) => finding.code === 'START_RECORD_LEDGER_HASH_MISMATCH'));
  assertReplacementBlocked((replacement) => { replacement.recordId = 'GATE14_START_RECORD_R1_DIFFERENT_BYTES'; }, 'START_RECORD_LEDGER_HASH_MISMATCH');
  // S36: the replacement authority signs its mutated record correctly; ledger pin still wins.
  assertReplacementBlocked((replacement) => { replacement.recordId = 'GATE14_START_RECORD_R1_AUTHORITY_REBOUND'; }, 'START_RECORD_LEDGER_HASH_MISMATCH');
  // S37/S38: validly signed replacements with stale pre-START bindings.
  assertReplacementBlocked((replacement) => { replacement.preStartLedgerSha256 = 'a'.repeat(64); }, 'START_RECORD_LEDGER_HASH_MISMATCH', ['START_RECORD_PRE_LEDGER_HASH_MISMATCH']);
  assertReplacementBlocked((replacement) => { replacement.previousEventSha256 = 'b'.repeat(64); }, 'START_RECORD_LEDGER_HASH_MISMATCH', ['START_RECORD_PREVIOUS_EVENT_HASH_MISMATCH']);
  // S39/S40: event identity remains authoritative.
  assertReplacementBlocked((replacement) => { replacement.recordedAt = '2026-08-12T12:00:01.000Z'; }, 'START_RECORD_LEDGER_HASH_MISMATCH', ['START_RECORD_EVENT_RECORDEDAT_MISMATCH']);
  assertReplacementBlocked((replacement) => { replacement.eventId = 'GATE14_START_REPLACEMENT'; }, 'START_RECORD_LEDGER_HASH_MISMATCH', ['START_RECORD_EVENT_EVENTID_MISMATCH']);
  // S41: two applicable START events are ambiguous and therefore unusable.
  const currentLedger = fs.readFileSync(ledgerPath, 'utf8').trim().split(String.fromCharCode(10)).map(JSON.parse);
  const appliedEvent = currentLedger.at(-1);
  const duplicateEvent = { ...appliedEvent, ordinal: appliedEvent.ordinal + 1, eventId: 'GATE14_START_R1_DUPLICATE', previousEventSha256: appliedEvent.eventPayloadSha256 };
  duplicateEvent.eventPayloadSha256 = crypto.createHash('sha256').update(canonicalize(duplicateEvent)).digest('hex');
  fs.appendFileSync(ledgerPath, `${canonicalize(duplicateEvent)}\n`);
  result = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE14');
  assert.equal(result.executionAuthorized, false);
  assert.ok(result.findings.some((finding) => finding.code === 'START_EVENT_NOT_UNIQUE'));

  // Existing scope hostile remains blocked after the ledger-binding hostiles.
  const mutated = JSON.parse(fs.readFileSync(authorityPath, 'utf8')); mutated.functionalExecutionScope = ['governance/gates/GATE14/**']; fs.writeFileSync(authorityPath, JSON.stringify(mutated, null, 2));
  const blockedScope = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE14');
  assert.equal(blockedScope.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
  fs.rmSync(scratch, { recursive: true, force: true });
});

function freezeScratchToGate21InProgress(scratch, { includeSuccession }) {
  const ledgerPath = path.join(scratch, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  const successionIndex = events.findIndex((event) => event.gateId === 'GATE21' && event.transitionType === 'CONTRACT_SUCCESSION');
  assert.notEqual(successionIndex, -1, 'tracked HEAD must still contain GATE21 CONTRACT_SUCCESSION');
  const cut = includeSuccession ? successionIndex + 1 : successionIndex;
  const ownHead = events.slice(0, cut).filter((event) => event.gateId === 'GATE21').at(-1);
  fs.writeFileSync(ledgerPath, `${lines.slice(0, cut).join('\n')}\n`);
  const sealBytes = fs.readFileSync(path.join(scratch, 'governance/gates/GATE21/state/revisions', ownHead.stateRevision, 'STATE_SEAL.json'));
  fs.writeFileSync(path.join(scratch, 'governance/gates/GATE21/state/CURRENT_STATE.json'), `${JSON.stringify({
    schemaVersion: 1, gateId: 'GATE21', stateRevision: ownHead.stateRevision,
    revisionPath: `governance/gates/GATE21/state/revisions/${ownHead.stateRevision}`,
    stateSealSha256: crypto.createHash('sha256').update(sealBytes).digest('hex'),
    committedByTransactionId: ownHead.eventId
  }, null, 2)}\n`);
  const revisionsDir = path.join(scratch, 'governance/gates/GATE21/state/revisions');
  for (const name of fs.readdirSync(revisionsDir)) {
    if (/^R[0-9]{4}$/.test(name) && name > ownHead.stateRevision) fs.rmSync(path.join(revisionsDir, name), { recursive: true, force: true });
  }
  for (const gate of [...new Set(events.slice(cut).map((event) => event.gateId))].filter((gateId) => gateId !== 'GATE21')) {
    for (const directory of [`governance/gates/${gate}`, `governance/authority/authorizations/${gate}`, `governance/authority/precontract/${gate}`]) {
      fs.rmSync(path.join(scratch, ...directory.split('/')), { recursive: true, force: true });
    }
  }
  return ownHead;
}

test('ordinary START without contract succession remains executable', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate21-ordinary-start-'));
  fs.cpSync(ROOT, scratch, { recursive: true, force: true, filter: (source) => !source.includes(path.sep + '.git' + path.sep) && !source.endsWith(path.sep + '.git') });
  const ownHead = freezeScratchToGate21InProgress(scratch, { includeSuccession: false });
  assert.equal(ownHead.transitionType, 'START');
  fs.writeFileSync(path.join(scratch, 'governance/gates/GATE21/contracts/CURRENT_CONTRACT.json'), JSON.stringify({
    schemaVersion: 1, gateId: 'GATE21', contractRevision: 'R0001',
    contractPath: 'governance/gates/GATE21/contracts/EXECUTION_CONTRACT_R0001.json',
    contractSha256: '0b07ec7f2e1056c2a88fe1972995021ea0c3776d4871216d8d966acb38aed3bc',
    activatedByEventId: null
  }, null, 2) + '\n');
  const resolved = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE21');
  const r1 = JSON.parse(fs.readFileSync(path.join(scratch, 'governance/gates/GATE21/contracts/EXECUTION_CONTRACT_R0001.json'), 'utf8'));
  assert.equal(resolved.status, 'IN_PROGRESS');
  assert.equal(resolved.executionAuthorized, true);
  assert.equal(resolved.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
  assert.deepEqual([...resolved.authorizedPaths].sort(), [...r1.authorizedPaths].sort());
  assert.equal(resolved.findings.some((finding) => finding.code === 'FUNCTIONAL_SCOPE_NOT_EXACT'), false);
  assert.equal(resolved.findings.some((finding) => finding.code === 'START_PRE_STATE_SEAL_CHAIN_MISMATCH'), false);
  const recordPath = path.join(scratch, 'governance/authority/authorizations/GATE21/GATE_START_RECORD.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.preStartLedgerSha256 = '9'.repeat(64);
  record.recordDigest = computeGateStartRecordDigest(record);
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  const replaced = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE21');
  assert.equal(replaced.executionAuthorized, false);
  assert.ok(replaced.findings.some((finding) => finding.code === 'START_RECORD_LEDGER_HASH_MISMATCH'));
  fs.rmSync(scratch, { recursive: true, force: true });
});

const R0002_BUILD_PATHS = [
  'governance/gates/GATE21/implementation/causal-data-interface.mjs',
  'governance/gates/GATE21/implementation/lab-import-adapter.mjs',
  'governance/gates/GATE21/implementation/source-registry-v1.mjs',
  'governance/gates/GATE21/implementation/portability-and-hygiene.mjs',
  'governance/gates/GATE21/contracts/GATE21_BINDING_V1.json',
  'governance/gates/GATE21/tests/gate21-foundation.test.mjs',
  'governance/gates/GATE21/tests/gate21-hostiles.test.mjs',
  'governance/gates/GATE21/tests/gate21-evolvability.test.mjs',
  'governance/gates/GATE21/fixtures/causal-consumer-fixture.mjs',
  'governance/gates/GATE21/evidence/BUILD_CANDIDATE_RECEIPT.json'
];

function copyRepo(label) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), label));
  fs.cpSync(ROOT, scratch, { recursive: true, force: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`) });
  return scratch;
}

function rewriteNdjsonEvent(ledgerPath, predicate, mutate) {
  const events = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const event = events.find(predicate);
  mutate(event);
  delete event.eventPayloadSha256;
  event.eventPayloadSha256 = crypto.createHash('sha256').update(canonicalize(event)).digest('hex');
  fs.writeFileSync(ledgerPath, `${events.map((item) => canonicalize(item)).join('\n')}\n`);
}

function rebindGate21StartPair(scratch, mutateRecord) {
  const recordPath = path.join(scratch, 'governance/authority/authorizations/GATE21/GATE_START_RECORD.json');
  const authorityPath = path.join(scratch, 'governance/authority/authorizations/GATE21/PROJECT_OWNER_GATE_START_AUTHORITY.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  mutateRecord(record);
  record.recordDigest = computeGateStartRecordDigest(record);
  for (const field of Object.keys(record)) {
    if (field !== 'document' && field !== 'recordId' && field !== 'recordDigest' && Object.hasOwn(authority, field)) {
      authority[field] = record[field];
    }
  }
  authority.recordDigest = record.recordDigest;
  authority.requestDigest = computeGateStartLocalRequestDigest(authority);
  authority.bindingDigest = computeGateStartBindingDigestFromDigests({
    requestDigest: authority.requestDigest, recordDigest: record.recordDigest
  });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`);
  const recordSha = crypto.createHash('sha256').update(fs.readFileSync(recordPath)).digest('hex');
  rewriteNdjsonEvent(
    path.join(scratch, 'governance/state/GATE_STATUS_LEDGER.ndjson'),
    (event) => event.eventId === 'GATE21_START_R1',
    (event) => { event.authoritySha256 = recordSha; }
  );
}

test('post-START contract succession keeps GATE21 executable under CURRENT_CONTRACT R0002', () => {
  const scratch = copyRepo('gate21-post-start-live-');
  freezeScratchToGate21InProgress(scratch, { includeSuccession: true });
  const resolved = createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE21');
  assert.equal(resolved.status, 'IN_PROGRESS');
  assert.equal(resolved.executionAuthorized, true);
  assert.equal(resolved.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
  assert.deepEqual([...resolved.authorizedPaths].sort(), [...R0002_BUILD_PATHS].sort());
  assert.equal(resolved.findings.some((finding) => finding.code === 'FUNCTIONAL_SCOPE_NOT_EXACT'), false);
  assert.equal(resolved.findings.some((finding) => finding.code === 'START_PRE_STATE_SEAL_CHAIN_MISMATCH'), false);
  assert.equal(resolved.startAuthority.executionAuthorized, true);
  assert.deepEqual([...resolved.startAuthority.authorizedPaths].sort(), [...R0002_BUILD_PATHS].sort());
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('post-START succession hostiles remain fail-closed', () => {
  const scratch = copyRepo('gate21-post-start-hostiles-');
  freezeScratchToGate21InProgress(scratch, { includeSuccession: true });
  const restorePaths = [
    'governance/gates/GATE21/contracts/EXECUTION_CONTRACT_R0001.json',
    'governance/gates/GATE21/contracts/EXECUTION_CONTRACT_R0002.json',
    'governance/gates/GATE21/contracts/CURRENT_CONTRACT.json',
    'governance/authority/authorizations/GATE21/GATE_START_RECORD.json',
    'governance/authority/authorizations/GATE21/PROJECT_OWNER_GATE_START_AUTHORITY.json',
    'governance/state/GATE_STATUS_LEDGER.ndjson',
    'governance/gates/GATE21/state/CURRENT_STATE.json',
    'governance/gates/GATE21/state/revisions/R0001/STATE_SEAL.json',
    'governance/gates/GATE21/state/revisions/R0002/STATE_SEAL.json',
    'governance/gates/GATE21/state/revisions/R0003/STATE_SEAL.json'
  ];
  const snapshot = new Map(restorePaths.map((relativePath) => [relativePath, fs.readFileSync(path.join(scratch, ...relativePath.split('/')))]));
  const restore = () => {
    for (const [relativePath, bytes] of snapshot) fs.writeFileSync(path.join(scratch, ...relativePath.split('/')), bytes);
  };
  const resolve = () => createWheelGateAuthoritySource(scratch).resolveWorkUnitAuthority('GATE21');
  const assertBlocked = (expected) => {
    const result = resolve();
    assert.equal(result.executionAuthorized, false, expected);
    const codes = Array.isArray(expected) ? expected : [expected];
    for (const code of codes) assert.ok(result.findings.some((finding) => finding.code === code), `${code}: ${JSON.stringify(result.findings)}`);
  };

  fs.appendFileSync(path.join(scratch, 'governance/gates/GATE21/contracts/EXECUTION_CONTRACT_R0001.json'), ' ');
  assertBlocked('START_HISTORICAL_CONTRACT_HASH_MISMATCH');
  restore();

  rebindGate21StartPair(scratch, (record) => {
    record.functionalExecutionScope = ['governance/other/file.json'];
  });
  assertBlocked('FUNCTIONAL_SCOPE_NOT_EXACT');
  restore();

  fs.writeFileSync(path.join(scratch, 'governance/gates/GATE21/contracts/CURRENT_CONTRACT.json'), '{');
  assertBlocked('CURRENT_CONTRACT_INVALID');
  restore();

  const r1SealBytes = fs.readFileSync(path.join(scratch, 'governance/gates/GATE21/state/revisions/R0001/STATE_SEAL.json'));
  fs.writeFileSync(path.join(scratch, 'governance/gates/GATE21/state/CURRENT_STATE.json'), `${JSON.stringify({
    schemaVersion: 1, gateId: 'GATE21', stateRevision: 'R0001',
    revisionPath: 'governance/gates/GATE21/state/revisions/R0001',
    stateSealSha256: crypto.createHash('sha256').update(r1SealBytes).digest('hex'),
    committedByTransactionId: 'FORGED-NOT-DESCENDANT'
  }, null, 2)}\n`);
  assertBlocked(['START_R0002_REQUIRED', 'START_STATE_NOT_DESCENDANT']);
  restore();

  fs.appendFileSync(path.join(scratch, 'governance/gates/GATE21/state/revisions/R0002/STATE_SEAL.json'), '\n');
  assertBlocked(['START_POST_STATE_SEAL_HASH_MISMATCH', 'START_STATE_SEAL_CHAIN_BROKEN']);
  restore();

  const r3Path = path.join(scratch, 'governance/gates/GATE21/state/revisions/R0003/STATE_SEAL.json');
  const r3 = JSON.parse(fs.readFileSync(r3Path, 'utf8'));
  r3.previousStateSealSha256 = 'a'.repeat(64);
  r3.payload.previousStateSealSha256 = 'a'.repeat(64);
  fs.writeFileSync(r3Path, `${JSON.stringify(r3, null, 2)}\n`);
  const brokenSealSha = crypto.createHash('sha256').update(fs.readFileSync(r3Path)).digest('hex');
  const currentStatePath = path.join(scratch, 'governance/gates/GATE21/state/CURRENT_STATE.json');
  const currentState = JSON.parse(fs.readFileSync(currentStatePath, 'utf8'));
  currentState.stateSealSha256 = brokenSealSha;
  fs.writeFileSync(currentStatePath, `${JSON.stringify(currentState, null, 2)}\n`);
  assertBlocked('START_STATE_SEAL_CHAIN_BROKEN');
  restore();

  const ledgerPath = path.join(scratch, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const events = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const startEvent = events.find((event) => event.eventId === 'GATE21_START_R1');
  const duplicate = { ...startEvent, ordinal: events.length + 1, eventId: 'GATE21_START_R1_DUPLICATE', previousEventSha256: events.at(-1).eventPayloadSha256 };
  delete duplicate.eventPayloadSha256;
  duplicate.eventPayloadSha256 = crypto.createHash('sha256').update(canonicalize(duplicate)).digest('hex');
  fs.appendFileSync(ledgerPath, `${canonicalize(duplicate)}\n`);
  assertBlocked('START_EVENT_NOT_UNIQUE');
  restore();

  const restored = resolve();
  assert.equal(restored.executionAuthorized, true);
  assert.deepEqual([...restored.authorizedPaths].sort(), [...R0002_BUILD_PATHS].sort());
  assert.equal(restored.authorizedPaths.includes('governance/other/file.json'), false);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('owner tool review is unsigned and approval is test-key-only', () => {
  const tool = 'C:/Users/melan/AppData/Local/WheelGovernanceAuthorizations/wheel-owner-gate-start.mjs';
  assert.equal(fs.existsSync(tool), true);
  const scenario = buildAuthority();
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-start-owner-tool-'));
  const requestPath = path.join(temp, 'request.json');
  const recordPath = path.join(temp, 'record.json');
  const keyPath = path.join(temp, 'key.json');
  const authorityPath = path.join(temp, 'authority.json');
  fs.writeFileSync(requestPath, JSON.stringify(scenario.request));
  fs.writeFileSync(recordPath, JSON.stringify(scenario.record));
  fs.writeFileSync(keyPath, JSON.stringify({ keyId: KEY_ID, privateKeyPem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const review = spawnSync(process.execPath, [tool, 'review', '--request', requestPath, '--record', recordPath], { encoding: 'utf8' });
  assert.equal(review.status, 0, review.stderr);
  const reviewJson = JSON.parse(review.stdout);
  assert.equal(reviewJson.signed, false);
  assert.equal(reviewJson.privateKeyRead, false);
  const approve = spawnSync(process.execPath, [tool, 'approve', '--request', requestPath, '--record', recordPath, '--key', keyPath, '--out', authorityPath, '--confirm-project-owner'], { encoding: 'utf8' });
  assert.equal(approve.status, 2);
  const approveJson = JSON.parse(approve.stdout);
  assert.equal(approveJson.decision, 'BLOCKED');
  assert.equal(approveJson.signed, false);
  assert.equal(fs.existsSync(authorityPath), false);
  fs.rmSync(temp, { recursive: true, force: true });
});
