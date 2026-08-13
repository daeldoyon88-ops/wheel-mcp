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
    ownerKeyId: KEY_ID, expiresAtUtc: '2026-08-13T12:00:00.000Z', maxUse: 1,
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

test('pre-START live GATE14 cannot execute and real state remains absent', () => {
  const resolved = createWheelGateAuthoritySource(ROOT).resolveWorkUnitAuthority('GATE14');
  assert.equal(resolved.status, 'AUTHORIZED_NOT_STARTED');
  assert.equal(resolved.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
  assert.equal(resolved.proofs.WORK_UNIT_EXECUTABLE.reason, 'START authority cannot grant pre-START execution');
  assert.equal(fs.existsSync(path.join(ROOT, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json')), false);
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

test('P02-P09 isolated GATE14 future event 58 validates without touching the real repository', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-start-future-'));
  fs.cpSync(ROOT, scratch, { recursive: true, force: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`) });
  const facts = deriveGateStartReadinessFacts(ROOT, 'GATE14');
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const common = {
    schemaVersion: 1, projectId: 'WHEEL', gateId: 'GATE14', purpose: 'START_PLUS_EXECUTION_AUTHORITY', eventId: 'GATE14_START_R1',
    transitionType: 'START', fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS', recordedAt: '2026-08-12T12:00:00.000Z',
    baseCommit: 'd5b5cee6710dfcc4a3f7af23835180f8091ccee3', preStartLedgerSha256: facts.preStartLedgerSha256,
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
  const revisionReport = validateStateRevision({ root: scratch, gateId: 'GATE14', currentStatePath: path.join(scratch, 'governance/gates/GATE14/state/CURRENT_STATE.json') });
  assert.equal(revisionReport.valid, true, JSON.stringify(revisionReport.findings, null, 2));
  const report = validateLedger({ root: scratch, ledgerPath, policy: { ...WHEEL_EXTERNAL_AUTHORITY_POLICY, gateStartOwnerKeyPath: 'governance/authority/TEST_GATE_START_KEY.json' } });
  assert.equal(report.valid, true, JSON.stringify(report.findings.filter((f) => f.severity === 'BLOCKING'), null, 2));
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
  assert.equal(approve.status, 0, approve.stderr);
  assert.equal(JSON.parse(approve.stdout).selfVerified, true);
  assert.equal(fs.existsSync(authorityPath), true);
  fs.rmSync(temp, { recursive: true, force: true });
});
