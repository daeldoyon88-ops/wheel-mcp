import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUCCESSION_AUTHORITY_KIND,
  SUCCESSION_OPERATION,
  SUCCESSION_PURPOSE,
  SUCCESSION_LEGACY_AUTHORITY_MODE,
  SUCCESSION_LOCAL_AUTHORITY_KIND,
  SUCCESSION_LOCAL_AUTHORITY_MODE,
  SUCCESSION_LOCAL_REQUEST_DIGEST_ALGORITHM,
  SUCCESSION_LOCAL_REQUIRED_PROHIBITIONS,
  SUCCESSION_LOCAL_SHARED_FIELDS,
  SUCCESSION_LEDGER_PATH,
  SUCCESSION_ACTIVE_GATE_PATH,
  canonicalSuccessionSigningPayload,
  computeGateContractSuccessionBindingDigest,
  computeGateContractSuccessionLocalRequestDigest,
  computeGateContractSuccessionRecordDigest,
  computeGateContractSuccessionRequestDigest,
  diffContractSemantics,
  evaluateGateContractSuccessionAuthority,
  gateContractSuccessionAuthorityPath,
  gateContractSuccessionLocalAuthorityPath,
  isLedgerBoundGateContractSuccessionAuthority,
  isLocalGateContractSuccessionAuthority,
  validateGateContractSuccessionAuthorityShape,
  validateGateContractSuccessionLedgerBoundAuthorityShape,
  validateGateContractSuccessionLocalAuthorityShape,
  validateGateContractSuccessionRecordShape,
  validateGateContractSuccessionRequestShape,
  verifyGateContractSuccessionOwnerSignature
} from '../gee-v1/core/gate-contract-succession-authority.mjs';
import { FORBIDDEN_SIGNATURE_FIELDS } from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import { CONTRACT_SUCCESSION_TRANSITIONS, CONTRACT_SUCCESSION_TRANSITION_TYPE, MODE_FULL, validateLedger } from '../tools/validate-status-ledger.mjs';
import { canonicalize, sha256Canonical } from '../tools/canonical-json.mjs';
import { createWheelGateContractSuccessionAuthoritySource } from '../gee-v1/adapters/wheel/gate-contract-succession-authority-source.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY as policy } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

const KEY_ID = 'WHEEL-OWNER-RELEASE-2D441D1E';
const KEYS = crypto.generateKeyPairSync('ed25519');
const FUTURE = '2999-01-01T00:00:00.000Z';
const sha = (value) => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(value)).digest('hex');
const bytes = (value) => Buffer.from(JSON.stringify(value));
const clone = (value) => JSON.parse(JSON.stringify(value));

function sign(authority) {
  const signed = { ...authority, signature: '' };
  signed.signature = crypto.sign(null, Buffer.from(canonicalSuccessionSigningPayload(signed)), KEYS.privateKey).toString('base64');
  return signed;
}

function buildScenario(gateId = 'GATE15') {
  const predecessor = { gateId, contractRevision: 'R0001', closureConditions: ['old lifecycle condition'], stable: { purpose: 'fixed' } };
  const predecessorBytes = bytes(predecessor);
  const predecessorSha = sha(predecessorBytes);
  const successor = {
    gateId, contractRevision: 'R0002', closureConditions: ['new lifecycle condition'], stable: { purpose: 'fixed' },
    previousContractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`,
    previousContractSha256: predecessorSha
  };
  const successorBytes = bytes(successor);
  const successorSha = sha(successorBytes);
  const predecessorPointer = {
    schemaVersion: 1, gateId, contractRevision: 'R0001',
    contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`, contractSha256: predecessorSha, activatedByEventId: null
  };
  const successorPointer = {
    schemaVersion: 1, gateId, contractRevision: 'R0002',
    contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0002.json`, contractSha256: successorSha, activatedByEventId: null
  };
  const predecessorPointerSha = sha(bytes(predecessorPointer));
  const successorPointerSha = sha(bytes(successorPointer));
  const predecessorPath = predecessorPointer.contractPath;
  const currentPath = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const successorPath = successorPointer.contractPath;
  const statePaths = [`governance/gates/${gateId}/state/CURRENT_STATE.json`];
  const authorizedPaths = [successorPath, currentPath, ...statePaths];
  const authorizedDelta = diffContractSemantics(predecessor, successor);
  const shared = {
    projectId: 'WHEEL', gateId, purpose: SUCCESSION_PURPOSE,
    reason: 'Correct the lifecycle condition after the valid START without rewriting the predecessor.',
    predecessorContractPath: predecessorPath, predecessorContractSha256: predecessorSha,
    predecessorCurrentContractPath: currentPath, predecessorCurrentContractSha256: predecessorPointerSha,
    successorContractPath: successorPath, successorContractSha256: successorSha,
    successorCurrentContractPath: currentPath, successorCurrentContractSha256: successorPointerSha,
    previousContractPath: predecessorPath, previousContractSha256: predecessorSha, successorRevision: 'R0002',
    authorizedDelta, authorizedDeltaDigest: sha(Buffer.from(canonicalize(authorizedDelta))), currentGateStatus: 'IN_PROGRESS',
    ledgerHeadEventId: `${gateId}_START_R1`, ledgerHeadEventPayloadSha256: 'a'.repeat(64), ledgerSha256: 'b'.repeat(64),
    baseCommit: 'c'.repeat(40), ownerKeyId: KEY_ID, expiresAtUtc: FUTURE, maxUse: 1, successorAuthorized: true,
    authorizedOperation: SUCCESSION_OPERATION, authorizedPaths, stateRevision: 'R0003', statePaths
  };
  const request = { schemaVersion: 1, documentKind: 'GATE_CONTRACT_SUCCESSION_REQUEST', requestId: `${gateId}_SUCCESSION_REQUEST_R1`, ...shared, requestDigest: '' };
  request.requestDigest = computeGateContractSuccessionRequestDigest(request);
  const record = { schemaVersion: 1, document: 'GATE_CONTRACT_SUCCESSION_RECORD', recordId: `${gateId}_SUCCESSION_RECORD_R1`, ...shared, recordDigest: '' };
  record.recordDigest = computeGateContractSuccessionRecordDigest(record);
  const authorityBase = {
    schemaVersion: 1, documentKind: SUCCESSION_AUTHORITY_KIND, authorityId: `${gateId}_SUCCESSION_AUTHORITY_R1`, issuedBy: 'PROJECT_OWNER', issuedAtUtc: '2026-08-12T13:00:00.000Z',
    ...shared, requestDigest: request.requestDigest, recordDigest: record.recordDigest,
    bindingDigest: computeGateContractSuccessionBindingDigest({ requestDigest: request.requestDigest, recordDigest: record.recordDigest, successorContractSha256: successorSha, successorCurrentContractSha256: successorPointerSha }),
    signatureAlgorithm: 'ed25519', signature: ''
  };
  const authority = sign(authorityBase);
  const observed = {
    projectId: 'WHEEL', gateId, baseCommit: shared.baseCommit, currentStatus: 'IN_PROGRESS',
    ledgerHeadEventId: shared.ledgerHeadEventId, ledgerHeadEventPayloadSha256: shared.ledgerHeadEventPayloadSha256, ledgerSha256: shared.ledgerSha256, candidateLedgerSha256: shared.ledgerSha256,
    predecessorContractPath: predecessorPath, predecessorContractSha256: predecessorSha, predecessorCurrentContractPath: currentPath, predecessorCurrentContractSha256: predecessorPointerSha,
    successorContractPath: successorPath, successorContractSha256: successorSha, successorCurrentContractPath: currentPath, successorCurrentContractSha256: successorPointerSha,
    competingAuthorityCount: 1, authorityConsumed: false, predecessorContract: predecessor, successorContract: successor,
    predecessorCurrentContract: predecessorPointer, successorCurrentContract: successorPointer
  };
  return { predecessor, successor, predecessorPointer, successorPointer, request, record, authority, observed };
}

function evaluate(scenario, overrides = {}) {
  const { ownerKey = { keyId: KEY_ID, publicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' }) }, observed = {}, now = new Date(), predecessorContract = scenario.observed.predecessorContract, successorContract = scenario.observed.successorContract, predecessorCurrentContract = scenario.observed.predecessorCurrentContract, successorCurrentContract = scenario.observed.successorCurrentContract } = overrides;
  return evaluateGateContractSuccessionAuthority({
    request: scenario.request, record: scenario.record, authority: scenario.authority,
    ownerKey, observed: { ...scenario.observed, ...observed }, now,
    predecessorContract, successorContract, predecessorCurrentContract, successorCurrentContract
  });
}

test('P01-P06 valid succession, immutable predecessor, unique pointer and generic future gate', () => {
  const scenario = buildScenario('GATE40');
  assert.equal(validateGateContractSuccessionRequestShape(scenario.request).valid, true);
  assert.equal(validateGateContractSuccessionRecordShape(scenario.record).valid, true);
  assert.equal(validateGateContractSuccessionAuthorityShape(scenario.authority).valid, true);
  assert.equal(verifyGateContractSuccessionOwnerSignature(scenario.authority, { keyId: KEY_ID, publicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' }) }).verified, true);
  assert.equal(evaluate(scenario).decision, 'AUTHORIZED');
  assert.equal(scenario.predecessor.contractRevision, 'R0001');
  assert.equal(scenario.observed.successorCurrentContract.contractRevision, 'R0002');
  assert.equal(new Set(scenario.request.authorizedPaths).size, scenario.request.authorizedPaths.length);
  assert.equal(scenario.successor.previousContractSha256, scenario.request.predecessorContractSha256);
});

const hostileCases = [
  ['CS01 wrong Gate', (s) => ({ observed: { gateId: 'GATE16' } })],
  ['CS02 predecessor SHA mismatch', (s) => ({ observed: { predecessorContractSha256: '0'.repeat(64) } })],
  ['CS03 predecessor path mismatch', (s) => ({ observed: { predecessorContractPath: 'governance/gates/GATE16/contracts/EXECUTION_CONTRACT_R0001.json' } })],
  ['CS04 wrong CURRENT_CONTRACT predecessor binding', (s) => ({ observed: { predecessorCurrentContractSha256: '0'.repeat(64) } })],
  ['CS05 successor SHA mismatch', (s) => ({ observed: { successorContractSha256: '0'.repeat(64) } })],
  ['CS06 successor path mismatch', (s) => ({ observed: { successorContractPath: 'governance/gates/GATE16/contracts/EXECUTION_CONTRACT_R0002.json' } })],
  ['CS07 unsigned authority', (s) => { s.authority.signature = ''; return {}; }],
  ['CS08 invalid owner signature', (s) => { s.authority.signature = 'Zm9yZ2Vk'; return {}; }],
  ['CS09 wrong owner key', (s) => ({ ownerKey: { keyId: 'WRONG', publicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' }) } })],
  ['CS10 modified signed payload', (s) => { s.authority.reason = 'tampered'; return {}; }],
  ['CS11 expired authority', (s) => ({ now: new Date('3000-01-01T00:00:00.000Z') })],
  ['CS12 authority reuse', (s) => ({ observed: { authorityConsumed: true } })],
  ['CS13 successor differs from authorized bytes', (s) => ({ observed: { successorContractSha256: '1'.repeat(64) } })],
  ['CS14 predecessor mutation attempt', (s) => { s.request.successorContractPath = s.request.predecessorContractPath; return {}; }],
  ['CS15 unrelated contract replacement', (s) => { s.request.successorContractPath = 'governance/gates/GATE13/contracts/EXECUTION_CONTRACT_R0002.json'; return {}; }],
  ['CS16 field outside approved delta', (s) => { s.successor.stable.purpose = 'tampered'; return { observed: { successorContract: s.successor } }; }],
  ['CS17 downgrade', (s) => { s.successor.contractRevision = 'R0001'; return { observed: { successorContract: s.successor } }; }],
  ['CS18 lineage gap', (s) => { s.successor.previousContractSha256 = '2'.repeat(64); return { observed: { successorContract: s.successor } }; }],
  ['CS19 current status mismatch', (s) => ({ observed: { currentStatus: 'REPAIR_REQUIRED' } })],
  ['CS20 cross-Gate borrowing', (s) => { s.authority.gateId = 'GATE16'; return {}; }],
  ['CS21 START borrowing', (s) => { s.authority.authorizedOperation = 'START'; return {}; }],
  ['CS22 closure borrowing', (s) => { s.authority.purpose = 'AGENT_CLOSURE'; return {}; }],
  ['CS23 external confirmation borrowing', (s) => { s.authority.purpose = 'EXTERNAL_CONFIRMATION'; return {}; }],
  ['CS24 arbitrary governance path', (s) => { s.request.authorizedPaths.push('governance/state/GATE_STATUS_LEDGER.ndjson'); return {}; }],
  ['CS25 GEE R8 creation', (s) => { s.request.authorizedPaths.push('governance/gee-v1/R8/EXECUTION_CONTRACT.json'); return {}; }]
];

for (const [name, mutate] of hostileCases) {
  test(`${name} blocks fail-closed`, () => {
    const scenario = buildScenario();
    const extra = mutate(scenario) || {};
    const result = evaluate(scenario, extra);
    assert.equal(result.decision, 'BLOCKED', JSON.stringify(result));
    assert.equal(result.successionAuthorized, false);
  });
}

// ===========================================================================
// LOCAL_EXPLICIT_AUTHORITY — the non-key CURRENT_CONTRACT_SWITCH route.
//
// The signed route above is unchanged and must stay so: every case in this
// section is additive, and the mode is reachable ONLY by naming it explicitly.
// ===========================================================================

/**
 * Deliberately built at currentGateStatus NOT_STARTED. That is the status a Gate
 * whose contract has been bootstrapped but never started sits at, and it is the
 * exact case the signed route could not serve. Nothing here touches the ledger's
 * CONTRACT_SUCCESSION transition class, which stays IN_PROGRESS-only (see L20).
 */
function buildLocalScenario(gateId = 'GATE25', currentGateStatus = 'NOT_STARTED') {
  const predecessor = { gateId, contractRevision: 'R0001', closureConditions: ['old lifecycle condition'], stable: { purpose: 'fixed' } };
  const predecessorSha = sha(bytes(predecessor));
  const successor = {
    gateId, contractRevision: 'R0002', closureConditions: ['new lifecycle condition'], stable: { purpose: 'fixed' },
    previousContractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`,
    previousContractSha256: predecessorSha
  };
  const successorSha = sha(bytes(successor));
  const currentPath = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const predecessorPath = `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`;
  const successorPath = `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0002.json`;
  const predecessorPointer = { schemaVersion: 1, gateId, contractRevision: 'R0001', contractPath: predecessorPath, contractSha256: predecessorSha, activatedByEventId: null };
  const successorPointer = { schemaVersion: 1, gateId, contractRevision: 'R0002', contractPath: successorPath, contractSha256: successorSha, activatedByEventId: null };
  const predecessorPointerSha = sha(bytes(predecessorPointer));
  const successorPointerSha = sha(bytes(successorPointer));
  const statePaths = [`governance/gates/${gateId}/state/CURRENT_STATE.json`];
  const authorizedPaths = [successorPath, currentPath, ...statePaths];
  const authorizedDelta = diffContractSemantics(predecessor, successor);
  // Every shared binding the signed route carries, minus ownerKeyId: the local
  // mode has no key to name and naming one is rejected outright.
  const shared = {
    projectId: 'WHEEL', gateId, purpose: SUCCESSION_PURPOSE,
    reason: 'Succeed the bootstrapped R0001 contract before START, without a key, a signature or a ledger append.',
    predecessorContractPath: predecessorPath, predecessorContractSha256: predecessorSha,
    predecessorCurrentContractPath: currentPath, predecessorCurrentContractSha256: predecessorPointerSha,
    successorContractPath: successorPath, successorContractSha256: successorSha,
    successorCurrentContractPath: currentPath, successorCurrentContractSha256: successorPointerSha,
    previousContractPath: predecessorPath, previousContractSha256: predecessorSha, successorRevision: 'R0002',
    authorizedDelta, authorizedDeltaDigest: sha(Buffer.from(canonicalize(authorizedDelta))), currentGateStatus,
    ledgerHeadEventId: `GENESIS_IMPORT_${gateId}`, ledgerHeadEventPayloadSha256: 'a'.repeat(64), ledgerSha256: 'b'.repeat(64),
    baseCommit: 'c'.repeat(40), expiresAtUtc: FUTURE, maxUse: 1, successorAuthorized: true,
    authorizedOperation: SUCCESSION_OPERATION, authorizedPaths, stateRevision: 'R0003', statePaths
  };
  const record = {
    schemaVersion: 1, document: 'GATE_CONTRACT_SUCCESSION_RECORD', recordId: `${gateId}_SUCCESSION_RECORD_LOCAL_R1`,
    authorityMode: SUCCESSION_LOCAL_AUTHORITY_MODE, ...shared, recordDigest: ''
  };
  record.recordDigest = computeGateContractSuccessionRecordDigest(record);
  const authority = {
    schemaVersion: 1, documentKind: SUCCESSION_LOCAL_AUTHORITY_KIND, authorityMode: SUCCESSION_LOCAL_AUTHORITY_MODE,
    authorityId: `${gateId}_SUCCESSION_AUTHORITY_LOCAL_R1`, issuedBy: 'PROJECT_OWNER', issuedAtUtc: '2026-09-01T00:00:00.000Z',
    localRequestDigestAlgorithm: SUCCESSION_LOCAL_REQUEST_DIGEST_ALGORITHM, approvedRequestDigest: '',
    ...shared, recordDigest: record.recordDigest, bindingDigest: '',
    pushAuthorized: false, prohibitedOperations: [...SUCCESSION_LOCAL_REQUIRED_PROHIBITIONS]
  };
  authority.approvedRequestDigest = computeGateContractSuccessionLocalRequestDigest(authority);
  authority.bindingDigest = computeGateContractSuccessionBindingDigest({
    requestDigest: authority.approvedRequestDigest, recordDigest: record.recordDigest,
    successorContractSha256: successorSha, successorCurrentContractSha256: successorPointerSha
  });
  const observed = {
    projectId: 'WHEEL', gateId, baseCommit: shared.baseCommit, currentStatus: currentGateStatus,
    ledgerHeadEventId: shared.ledgerHeadEventId, ledgerHeadEventPayloadSha256: shared.ledgerHeadEventPayloadSha256,
    ledgerSha256: shared.ledgerSha256, candidateLedgerSha256: shared.ledgerSha256,
    predecessorContractPath: predecessorPath, predecessorContractSha256: predecessorSha,
    predecessorCurrentContractPath: currentPath, predecessorCurrentContractSha256: predecessorPointerSha,
    successorContractPath: successorPath, successorContractSha256: successorSha,
    successorCurrentContractPath: currentPath, successorCurrentContractSha256: successorPointerSha,
    competingAuthorityCount: 1, authorityConsumed: false, predecessorContract: predecessor, successorContract: successor,
    predecessorCurrentContract: predecessorPointer, successorCurrentContract: successorPointer
  };
  return { predecessor, successor, predecessorPointer, successorPointer, record, authority, observed, authorizedPaths };
}

function evaluateLocal(scenario, overrides = {}) {
  const { ownerKey = null, observed = {}, now = new Date('2026-09-09T00:00:00.000Z'), request = null } = overrides;
  return evaluateGateContractSuccessionAuthority({
    request, record: scenario.record, authority: scenario.authority, ownerKey,
    observed: { ...scenario.observed, ...observed }, now,
    predecessorContract: overrides.predecessorContract ?? scenario.observed.predecessorContract,
    successorContract: overrides.successorContract ?? scenario.observed.successorContract,
    predecessorCurrentContract: scenario.observed.predecessorCurrentContract,
    successorCurrentContract: scenario.observed.successorCurrentContract
  });
}

/**
 * Re-derive every digest after a mutation, so a hostile case proves the check it
 * names rather than the self-binding digest.
 *
 * Without this, tampering with (say) authorizedPaths trips
 * LOCAL_REQUEST_DIGEST_SELF_INCONSISTENT during shape validation and the
 * evaluator returns before the scope check ever runs — a pass that would say
 * nothing about whether the scope check works. A real forger re-derives the
 * digests, because they are computed from the document rather than signed over
 * it, so this is also the honest threat model: the substantive bindings, not the
 * digest, are what must refuse a widened authority.
 */
function resealLocal(scenario) {
  for (const field of SUCCESSION_LOCAL_SHARED_FIELDS) scenario.record[field] = scenario.authority[field];
  scenario.record.recordDigest = computeGateContractSuccessionRecordDigest(scenario.record);
  scenario.authority.recordDigest = scenario.record.recordDigest;
  scenario.authority.approvedRequestDigest = computeGateContractSuccessionLocalRequestDigest(scenario.authority);
  scenario.authority.bindingDigest = computeGateContractSuccessionBindingDigest({
    requestDigest: scenario.authority.approvedRequestDigest, recordDigest: scenario.record.recordDigest,
    successorContractSha256: scenario.authority.successorContractSha256,
    successorCurrentContractSha256: scenario.authority.successorCurrentContractSha256
  });
}

const codes = (result) => result.findings.map((f) => f.code);

test('L01 local mode authorizes CURRENT_CONTRACT_SWITCH at NOT_STARTED and grants nothing else', () => {
  const scenario = buildLocalScenario('GATE25', 'NOT_STARTED');
  assert.equal(scenario.record.currentGateStatus, 'NOT_STARTED');
  assert.equal(validateGateContractSuccessionLocalAuthorityShape(scenario.authority).valid, true);
  assert.equal(validateGateContractSuccessionRecordShape(scenario.record, { local: true }).valid, true);
  const result = evaluateLocal(scenario);
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
  assert.equal(result.successionAuthorized, true);
  assert.equal(result.authorityMode, SUCCESSION_LOCAL_AUTHORITY_MODE);
  assert.equal(scenario.authority.purpose, SUCCESSION_PURPOSE);
  assert.equal(scenario.authority.authorizedOperation, SUCCESSION_OPERATION);
  // The switch, the pointer and the declared state paths — nothing else.
  assert.deepEqual(result.authorizedPaths, scenario.authorizedPaths);
  // Permitted gate-local statePaths remain valid; the denylist is exact-path.
  assert.deepEqual(scenario.authority.statePaths, ['governance/gates/GATE25/state/CURRENT_STATE.json']);
  assert.equal(scenario.authority.statePaths.includes(SUCCESSION_LEDGER_PATH), false);
  assert.equal(scenario.authority.statePaths.includes(SUCCESSION_ACTIVE_GATE_PATH), false);
});

test('L02 local mode requires no private key, no signature and no owner key material', () => {
  const scenario = buildLocalScenario();
  for (const field of FORBIDDEN_SIGNATURE_FIELDS) assert.equal(Object.hasOwn(scenario.authority, field), false, field);
  // A null key, a wrong key and a key that verifies nothing all reach the same
  // decision, which is what "no private-key dependency" has to mean operationally.
  assert.equal(evaluateLocal(scenario, { ownerKey: null }).decision, 'AUTHORIZED');
  assert.equal(evaluateLocal(scenario, { ownerKey: { keyId: 'WRONG', publicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' }) } }).decision, 'AUTHORIZED');
  assert.equal(isLocalGateContractSuccessionAuthority(scenario.authority), true);
  assert.notEqual(gateContractSuccessionLocalAuthorityPath('GATE25'), gateContractSuccessionAuthorityPath('GATE25'));
});

for (const field of ['ownerKeyId', 'signatureAlgorithm', 'signature', 'privateKeyPath', 'externalSigner', 'ownerKeyHistory', 'recoveryRoot', 'keyRotation']) {
  test(`L03 local mode rejects forbidden signature field ${field}`, () => {
    const scenario = buildLocalScenario();
    scenario.authority[field] = field === 'signatureAlgorithm' ? 'ed25519' : 'forged';
    const result = evaluateLocal(scenario);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('SIGNATURE_MATERIAL_NOT_PERMITTED'), JSON.stringify(result.findings));
  });
}

test('L04 a mode that is neither of the two, and an unnamed local shape, both block', () => {
  const bogus = buildLocalScenario();
  bogus.authority.authorityMode = 'OWNER_PRESENT_BYTE_AUTHORITY';
  const bogusResult = evaluateLocal(bogus);
  assert.equal(bogusResult.decision, 'BLOCKED');
  assert.ok(codes(bogusResult).includes('AUTHORITY_MODE_INVALID'), JSON.stringify(bogusResult.findings));

  // Absence resolves to the signed branch, which is what keeps historical
  // documents on their original validation — a local-shaped document that omits
  // the field is therefore judged as an unsigned legacy authority and blocked.
  const unnamed = buildLocalScenario();
  delete unnamed.authority.authorityMode;
  const unnamedResult = evaluateLocal(unnamed);
  assert.equal(unnamedResult.decision, 'BLOCKED');
  assert.equal(unnamedResult.authorityMode, SUCCESSION_LEGACY_AUTHORITY_MODE);
});

test('L05 local mode refuses a borrowed purpose or a borrowed operation', () => {
  for (const purpose of ['AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'GATE_START']) {
    const scenario = buildLocalScenario();
    scenario.authority.purpose = purpose;
    const result = evaluateLocal(scenario);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('PURPOSE_INVALID'), purpose);
  }
  for (const operation of ['START', 'GATE_START', 'ACTIVE_GATE_SWITCH', 'LEDGER_APPEND']) {
    const scenario = buildLocalScenario();
    scenario.authority.authorizedOperation = operation;
    const result = evaluateLocal(scenario);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('AUTHORIZED_OPERATION_INVALID'), operation);
  }
});

const localHostileCases = [
  // 7 — predecessor lineage.
  ['L06 predecessor contract SHA mismatch', () => ({ observed: { predecessorContractSha256: '0'.repeat(64) } }), 'PREDECESSOR_SHA_MISMATCH'],
  ['L07 predecessor CURRENT_CONTRACT pointer SHA mismatch', () => ({ observed: { predecessorCurrentContractSha256: '0'.repeat(64) } }), 'PREDECESSOR_CURRENT_POINTER_SHA_MISMATCH'],
  ['L08 predecessor lineage not carried by the successor bytes', (s) => { s.successor.previousContractSha256 = '2'.repeat(64); return { successorContract: s.successor }; }, 'SUCCESSOR_PREDECESSOR_LINEAGE_MISMATCH'],
  // 8 — successor revision, path and SHA.
  ['L09 successor revision lineage gap', (s) => { s.successor.contractRevision = 'R0004'; return { successorContract: s.successor }; }, 'SUCCESSOR_REVISION_LINEAGE_GAP'],
  ['L10 successor path mismatch', () => ({ observed: { successorContractPath: 'governance/gates/GATE26/contracts/EXECUTION_CONTRACT_R0002.json' } }), 'SUCCESSOR_PATH_MISMATCH'],
  ['L11 successor SHA mismatch', () => ({ observed: { successorContractSha256: '1'.repeat(64) } }), 'SUCCESSOR_SHA_MISMATCH'],
  ['L12 successor pointer binding mismatch', (s) => { s.observed.successorCurrentContract = { ...s.successorPointer, contractRevision: 'R0003' }; return {}; }, 'SUCCESSOR_POINTER_BINDING_MISMATCH'],
  // 9 — authorized path scope, including the two paths that must never enter it
  // even when smuggled through BOTH statePaths and authorizedPaths (resealed).
  ['L13 authorizedPaths widened beyond the exact switch scope', (s) => { s.authority.authorizedPaths = [...s.authority.authorizedPaths, 'governance/gates/GATE25/evidence/EXTRA.json']; return { reseal: true }; }, 'AUTHORIZED_PATH_SCOPE_MISMATCH'],
  ['L14 ledger path smuggled via statePaths and authorizedPaths', (s) => {
    s.authority.statePaths = [...s.authority.statePaths, SUCCESSION_LEDGER_PATH];
    s.authority.authorizedPaths = [...s.authority.authorizedPaths, SUCCESSION_LEDGER_PATH];
    return { reseal: true };
  }, 'LEDGER_PATH_FORBIDDEN'],
  ['L15 ACTIVE_GATE path smuggled via statePaths and authorizedPaths', (s) => {
    s.authority.statePaths = [...s.authority.statePaths, SUCCESSION_ACTIVE_GATE_PATH];
    s.authority.authorizedPaths = [...s.authority.authorizedPaths, SUCCESSION_ACTIVE_GATE_PATH];
    return { reseal: true };
  }, 'ACTIVE_GATE_PATH_FORBIDDEN'],
  ['L16 GEE path claimed as an authorized path', (s) => { s.authority.statePaths = [...s.authority.statePaths, 'governance/gee-v1/R8/EXECUTION_CONTRACT.json']; return {}; }, 'GEE_PATH_FORBIDDEN'],
  // 10 — the authorized delta and its digest.
  ['L17 successor delta outside the authorized delta', (s) => { s.successor.stable.purpose = 'tampered'; return { successorContract: s.successor }; }, 'SUCCESSOR_DELTA_OUTSIDE_AUTHORIZATION'],
  ['L18 authorized delta digest does not describe the authorized delta', (s) => { s.authority.authorizedDeltaDigest = '3'.repeat(64); return {}; }, 'AUTHORIZED_DELTA_DIGEST_MISMATCH'],
  // 11 — the exact prestate binding this primitive carries.
  ['L19 base commit prestate mismatch', () => ({ observed: { baseCommit: 'd'.repeat(40) } }), 'BASE_COMMIT_MISMATCH'],
  ['L20 ledger bytes prestate mismatch', () => ({ observed: { ledgerSha256: 'e'.repeat(64) } }), 'LEDGER_HEAD_BINDING_MISMATCH'],
  ['L21 ledger head event prestate mismatch', () => ({ observed: { ledgerHeadEventId: 'GATE25_START_R1' } }), 'LEDGER_HEAD_BINDING_MISMATCH'],
  ['L22 observed status is not the status the authority was issued against', () => ({ observed: { currentStatus: 'IN_PROGRESS' } }), 'CURRENT_STATUS_MISMATCH'],
  // 12 — single use and replay.
  ['L23 maxUse above one', (s) => { s.authority.maxUse = 2; return {}; }, 'MAX_USE_INVALID'],
  ['L24 replay of a consumed authority', () => ({ observed: { authorityConsumed: true } }), 'AUTHORITY_REPLAY'],
  ['L25 competing succession authorities', () => ({ observed: { competingAuthorityCount: 2 } }), 'COMPETING_SUCCESSION_AUTHORITIES'],
  // 13 — the ledger may not move under a CURRENT_CONTRACT_SWITCH.
  ['L26 candidate ledger bytes moved', () => ({ observed: { candidateLedgerSha256: 'f'.repeat(64) } }), 'LEDGER_MUTATION_NOT_AUTHORIZED'],
  // 14/15 — the prohibition set is a checked claim, not an absence.
  ['L27 START dropped from the prohibition set', (s) => { s.authority.prohibitedOperations = s.authority.prohibitedOperations.filter((op) => op !== 'START'); return {}; }, 'PROHIBITED_OPERATIONS_INVALID'],
  ['L28 ACTIVE_GATE_SWITCH dropped from the prohibition set', (s) => { s.authority.prohibitedOperations = s.authority.prohibitedOperations.filter((op) => op !== 'ACTIVE_GATE_SWITCH'); return {}; }, 'PROHIBITED_OPERATIONS_INVALID'],
  ['L29 LEDGER_REWRITE dropped from the prohibition set', (s) => { s.authority.prohibitedOperations = s.authority.prohibitedOperations.filter((op) => op !== 'LEDGER_REWRITE'); return {}; }, 'PROHIBITED_OPERATIONS_INVALID'],
  ['L30 push claimed', (s) => { s.authority.pushAuthorized = true; return {}; }, 'PUSH_NOT_FORBIDDEN'],
  // Self-binding and record agreement replace the signature.
  ['L31 self-binding digest does not describe the authority', (s) => { s.authority.reason = 'tampered after issue'; return {}; }, 'LOCAL_REQUEST_DIGEST_SELF_INCONSISTENT'],
  ['L32 record disagrees with the authority', (s) => { s.record.stateRevision = 'R0009'; s.record.recordDigest = computeGateContractSuccessionRecordDigest({ ...s.record, recordDigest: '' }); return {}; }, 'AUTHORITY_RECORD_BINDING_MISMATCH'],
  ['L33 record digest not reproduced by the record bytes', (s) => { s.record.recordDigest = '4'.repeat(64); return {}; }, 'RECORD_DIGEST_MISMATCH'],
  ['L34 binding digest does not commit to the successor bytes', (s) => { s.authority.bindingDigest = '5'.repeat(64); return {}; }, 'AUTHORITY_BINDING_DIGEST_MISMATCH'],
  ['L35 expired local authority', (s) => { s.authority.expiresAtUtc = '2026-01-01T00:00:00.000Z'; return { reseal: true }; }, 'AUTHORITY_EXPIRED'],
  ['L36 cross-Gate borrowing', () => ({ observed: { gateId: 'GATE26' } }), 'CROSS_GATE_OR_PROJECT_BINDING'],
  ['L37 predecessor mutation attempt', (s) => { s.authority.successorContractPath = s.authority.predecessorContractPath; s.authority.authorizedPaths = [s.authority.predecessorContractPath, s.authority.successorCurrentContractPath, ...s.authority.statePaths]; return { reseal: true }; }, 'PREDECESSOR_MUTATION_FORBIDDEN'],
  ['L38 a local authority may not also present an external request', () => ({ request: { schemaVersion: 1 } }), 'LOCAL_AUTHORITY_REQUEST_NOT_PERMITTED'],
  ['L39 a legacy record may not be paired with a local authority', (s) => { delete s.record.authorityMode; return {}; }, 'RECORD_MISSING_FIELD'],
  ['L40 a record naming the wrong mode', (s) => { s.record.authorityMode = SUCCESSION_LEGACY_AUTHORITY_MODE; return {}; }, 'RECORD_AUTHORITY_MODE_INVALID']
];

for (const [name, mutate, expectedCode] of localHostileCases) {
  test(`${name} blocks fail-closed`, () => {
    const scenario = buildLocalScenario();
    const extra = mutate(scenario) || {};
    if (extra.reseal) resealLocal(scenario);
    const result = evaluateLocal(scenario, extra);
    assert.equal(result.decision, 'BLOCKED', JSON.stringify(result));
    assert.equal(result.successionAuthorized, false);
    assert.deepEqual(result.authorizedPaths, []);
    assert.ok(codes(result).includes(expectedCode), `expected ${expectedCode}, got ${JSON.stringify(result.findings)}`);
  });
}

test('L41 neither mode grants START, execution or closure, in either decision', () => {
  const authorized = evaluateLocal(buildLocalScenario());
  assert.equal(authorized.decision, 'AUTHORIZED');
  for (const capability of ['startAuthorized', 'executionAuthorized', 'closureAuthorized']) {
    assert.equal(authorized[capability], false, capability);
  }
  assert.equal(Object.hasOwn(authorized, 'ledgerAuthorized'), false);
  assert.equal(Object.hasOwn(authorized, 'activeGateAuthorized'), false);
  // The same for the signed route, so the repair cannot have widened either one.
  const signed = evaluate(buildScenario('GATE40'));
  assert.equal(signed.decision, 'AUTHORIZED');
  for (const capability of ['startAuthorized', 'executionAuthorized', 'closureAuthorized']) {
    assert.equal(signed[capability], false, capability);
  }
});

test('L42 the CONTRACT_SUCCESSION ledger transition class is untouched by this repair', () => {
  // The switch appends nothing, so the succession transition class must remain
  // the single IN_PROGRESS self-transition it has always been. NOT_STARTED is a
  // valid status for a local authority to be ISSUED against; it is not, and must
  // not become, a succession transition.
  assert.deepEqual(CONTRACT_SUCCESSION_TRANSITIONS, [['IN_PROGRESS', 'IN_PROGRESS', 'CONTRACT_SUCCESSION']]);
  assert.equal(CONTRACT_SUCCESSION_TRANSITION_TYPE, 'CONTRACT_SUCCESSION');
  for (const [from, to] of CONTRACT_SUCCESSION_TRANSITIONS) {
    assert.equal(from, 'IN_PROGRESS');
    assert.equal(to, 'IN_PROGRESS');
  }
  assert.equal(CONTRACT_SUCCESSION_TRANSITIONS.some(([from, to]) => from === 'NOT_STARTED' || to === 'NOT_STARTED'), false);
});

test('L43 the signed route is unchanged: explicit legacy mode, and absence, both verify', () => {
  const explicit = buildScenario('GATE40');
  explicit.authority.authorityMode = SUCCESSION_LEGACY_AUTHORITY_MODE;
  explicit.authority.signature = '';
  explicit.authority.signature = crypto.sign(null, Buffer.from(canonicalSuccessionSigningPayload(explicit.authority)), KEYS.privateKey).toString('base64');
  const explicitResult = evaluate(explicit);
  assert.equal(explicitResult.decision, 'AUTHORIZED', JSON.stringify(explicitResult.findings));
  assert.equal(explicitResult.authorityMode, SUCCESSION_LEGACY_AUTHORITY_MODE);

  const implicit = buildScenario('GATE40');
  assert.equal(Object.hasOwn(implicit.authority, 'authorityMode'), false);
  assert.equal(evaluate(implicit).decision, 'AUTHORIZED');
  assert.equal(verifyGateContractSuccessionOwnerSignature(implicit.authority, { keyId: KEY_ID, publicKeyPem: KEYS.publicKey.export({ type: 'spki', format: 'pem' }) }).verified, true);
  // And a signed authority still cannot pass as a local one, or the reverse.
  assert.equal(validateGateContractSuccessionLocalAuthorityShape(implicit.authority).valid, false);
  assert.equal(validateGateContractSuccessionAuthorityShape(buildLocalScenario().authority).valid, false);
  assert.equal(validateGateContractSuccessionRequestShape(implicit.request).valid, true);
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE_LEDGER = path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson');
const LEDGER_BOUND_AUTHORITIES = Object.freeze([
  'governance/historical-architecture/CONTRACT_SUCCESSION_R0002_LOCAL_AUTHORITY.json',
  'governance/authority/authorizations/GATE21/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json',
  'governance/authority/authorizations/GATE22/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json',
  'governance/authority/authorizations/GATE23/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json',
  'governance/authority/authorizations/GATE24/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json',
  'governance/authority/authorizations/GATE25/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json'
]);
const readRepoJson = (relative) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')), 'utf8'));
const shaFile = (absolute) => crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
function recomputeEvent(event) {
  const payload = { ...event };
  delete payload.eventPayloadSha256;
  return { ...event, eventPayloadSha256: sha256Canonical(payload) };
}
function appendLedgerEvent(extra) {
  const original = fs.readFileSync(LIVE_LEDGER);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g25-succ-replay-'));
  const out = path.join(tmp, 'GATE_STATUS_LEDGER.ndjson');
  const text = original.toString('utf8');
  const prefix = text.endsWith('\n') ? text : `${text}\n`;
  fs.writeFileSync(out, `${prefix}${canonicalize(extra)}\n`);
  return { tmp, out };
}
function blockingCodes(report) {
  return report.findings.filter((item) => item.severity === 'BLOCKING').map((item) => item.detectorId);
}

test('A valid ledger-bound succession authority shape PASSes without TypeError', () => {
  const authority = readRepoJson('governance/authority/authorizations/GATE25/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json');
  assert.equal(isLedgerBoundGateContractSuccessionAuthority(authority), true);
  let legacy;
  let local;
  let dedicated;
  assert.doesNotThrow(() => { legacy = validateGateContractSuccessionAuthorityShape(authority); });
  assert.doesNotThrow(() => { local = validateGateContractSuccessionLocalAuthorityShape(authority); });
  assert.doesNotThrow(() => { dedicated = validateGateContractSuccessionLedgerBoundAuthorityShape(authority); });
  assert.equal(legacy.valid, true, JSON.stringify(legacy.findings));
  assert.equal(local.valid, true, JSON.stringify(local.findings));
  assert.equal(dedicated.valid, true, JSON.stringify(dedicated.findings));
  assert.doesNotThrow(() => {
    createWheelGateContractSuccessionAuthoritySource(REPO_ROOT).resolveGateContractSuccessionAuthority('GATE25');
  });
});

test('B malformed ledger-bound shape fails closed without uncaught exception', () => {
  const malformed = [
    null,
    [],
    42,
    'not-json-object',
    { documentKind: SUCCESSION_LOCAL_AUTHORITY_KIND },
    {
      documentKind: SUCCESSION_LOCAL_AUTHORITY_KIND,
      baseHead: 1,
      preLedgerEventCount: 'nope',
      preLedgerPrefixSha256: 1,
      currentContractPointerPath: 1,
      predecessorContractRevision: 1
    }
  ];
  for (const value of malformed) {
    let legacy;
    let local;
    let evaluateResult;
    assert.doesNotThrow(() => { legacy = validateGateContractSuccessionAuthorityShape(value); });
    assert.doesNotThrow(() => { local = validateGateContractSuccessionLocalAuthorityShape(value); });
    assert.doesNotThrow(() => { evaluateResult = evaluateGateContractSuccessionAuthority({ authority: value }); });
    assert.equal(legacy.valid, false);
    assert.equal(local.valid, false);
    assert.equal(evaluateResult.decision, 'BLOCKED');
    assert.equal(evaluateResult.successionAuthorized, false);
    assert.ok(Array.isArray(legacy.findings) && legacy.findings.length > 0);
  }
});

/**
 * The COMPLETE evidence a lawful ledger-bound succession requires, derived entirely
 * from the authority's own bindings — which is exactly what a correct observer at the
 * authorized pre-state reports. Every fail-closed test below starts from this and
 * removes exactly ONE thing, so each proves that one absence blocks on its own.
 *
 * The pointer documents are shaped like a real CURRENT_CONTRACT.json: `contractPath`
 * and `contractSha256` name the execution contract POINTED AT, never the pointer's
 * own path or bytes.
 */
function ledgerBoundEvidence(authority, { ledgerDigest = 'a'.repeat(64) } = {}) {
  const pointerPath = authority.currentContractPointerPath;
  const pointer = (revision, contractPath, contractSha256) => ({
    schemaVersion: 1, gateId: authority.gateId, contractRevision: revision,
    contractPath, contractSha256, activatedByEventId: null
  });
  return {
    predecessorContract: {
      schemaVersion: 1, gateId: authority.gateId, contractRevision: authority.predecessorContractRevision
    },
    successorContract: {
      schemaVersion: 1, gateId: authority.gateId, contractRevision: authority.successorContractRevision,
      previousContractPath: authority.predecessorContractPath,
      previousContractSha256: authority.predecessorContractSha256
    },
    predecessorCurrentContract: pointer(authority.predecessorContractRevision, authority.predecessorContractPath, authority.predecessorContractSha256),
    successorCurrentContract: pointer(authority.successorContractRevision, authority.successorContractPath, authority.successorContractSha256),
    observed: {
      projectId: authority.projectId,
      gateId: authority.gateId,
      baseCommit: authority.baseHead,
      competingAuthorityCount: 1,
      authorityConsumed: false,
      predecessorContractPath: authority.predecessorContractPath,
      predecessorContractSha256: authority.predecessorContractSha256,
      successorContractPath: authority.successorContractPath,
      successorContractSha256: authority.successorContractSha256,
      predecessorCurrentContractPath: pointerPath,
      successorCurrentContractPath: pointerPath,
      predecessorCurrentContractSha256: authority.predecessorCurrentContractSha256,
      successorCurrentContractSha256: authority.successorCurrentContractSha256,
      ledgerHeadEventId: authority.ledgerHeadEventId,
      ledgerHeadEventPayloadSha256: authority.ledgerHeadEventPayloadSha256,
      ledgerSha256: ledgerDigest,
      candidateLedgerSha256: ledgerDigest
    }
  };
}
const evaluateLedgerBound = (authority, evidence) =>
  evaluateGateContractSuccessionAuthority({ request: null, authority, ...evidence });
const GATE25_AUTHORITY_PATH = 'governance/authority/authorizations/GATE25/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json';

test('C valid first consumption of single-use ledger-bound authority PASSes', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  const first = evaluateLedgerBound(authority, ledgerBoundEvidence(authority));
  assert.equal(first.decision, 'AUTHORIZED', JSON.stringify(first.findings));
  assert.equal(first.successionAuthorized, true);
  const consumed = ledgerBoundEvidence(authority);
  consumed.observed.authorityConsumed = true;
  const replayed = evaluateLedgerBound(authority, consumed);
  assert.equal(replayed.decision, 'BLOCKED');
  assert.equal(replayed.findings.some((item) => item.code === 'AUTHORITY_REPLAY'), true);
  const live = validateLedger({ root: REPO_ROOT, ledgerPath: LIVE_LEDGER, policy, mode: MODE_FULL });
  const succession = live.events.filter((event) => event.transitionType === CONTRACT_SUCCESSION_TRANSITION_TYPE && event.gateId === 'GATE25');
  assert.equal(succession.length, 1);
  const successionBlocking = live.findings.filter((item) => item.severity === 'BLOCKING' && String(item.detectorId).startsWith('CONTRACT_SUCCESSION_'));
  assert.deepEqual(successionBlocking, []);
  assert.equal(live.findings.some((item) => item.detectorId === 'CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), false);
  assert.equal(live.findings.some((item) => item.detectorId === 'CONTRACT_SUCCESSION_APPLIED' && item.eventId === succession[0].eventId), true);
});

test('D second use with the same eventId is rejected', () => {
  const events = fs.readFileSync(LIVE_LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const last = events.at(-1);
  const original = events.find((event) => event.eventId === 'GATE25_CONTRACT_SUCCESSION_R0003_R1');
  const duplicate = recomputeEvent({
    ...original,
    ordinal: last.ordinal + 1,
    previousEventSha256: last.eventPayloadSha256,
    recordedAt: '2026-09-15T12:00:00.000Z'
  });
  const { tmp, out } = appendLedgerEvent(duplicate);
  try {
    const report = validateLedger({ root: REPO_ROOT, ledgerPath: out, policy, mode: MODE_FULL });
    assert.equal(report.valid, false);
    assert.equal(blockingCodes(report).includes('LEDGER_DUPLICATE_EVENT_ID'), true, JSON.stringify(blockingCodes(report)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('E second use with a different eventId but the same single-use authority is rejected', () => {
  const events = fs.readFileSync(LIVE_LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const last = events.at(-1);
  const original = events.find((event) => event.eventId === 'GATE25_CONTRACT_SUCCESSION_R0003_R1');
  const replay = recomputeEvent({
    ...original,
    eventId: 'GATE25_CONTRACT_SUCCESSION_R0003_REPLAY',
    ordinal: last.ordinal + 1,
    previousEventSha256: last.eventPayloadSha256,
    recordedAt: '2026-09-15T12:00:00.000Z'
  });
  const { tmp, out } = appendLedgerEvent(replay);
  try {
    const report = validateLedger({ root: REPO_ROOT, ledgerPath: out, policy, mode: MODE_FULL });
    assert.equal(report.valid, false);
    assert.equal(blockingCodes(report).includes('CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), true, JSON.stringify(blockingCodes(report)));
    assert.equal(blockingCodes(report).includes('LEDGER_DUPLICATE_EVENT_ID'), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('F genuinely distinct authorized successions remain allowed', () => {
  const live = validateLedger({ root: REPO_ROOT, ledgerPath: LIVE_LEDGER, policy, mode: MODE_FULL });
  const succession = live.events.filter((event) => event.transitionType === CONTRACT_SUCCESSION_TRANSITION_TYPE);
  const identities = succession.map((event) => `${event.authorityPath}::${event.authoritySha256}`);
  assert.ok(succession.length >= 6, `expected multiple canonical successions, got ${succession.length}`);
  assert.equal(new Set(identities).size, identities.length);
  const successionBlocking = live.findings.filter((item) => item.severity === 'BLOCKING' && String(item.detectorId).startsWith('CONTRACT_SUCCESSION_'));
  assert.deepEqual(successionBlocking, []);
  assert.equal(live.findings.filter((item) => item.detectorId === 'CONTRACT_SUCCESSION_APPLIED').length, succession.length);
});

test('G historical canonical succession records continue validating unchanged', () => {
  for (const relative of LEDGER_BOUND_AUTHORITIES) {
    const authority = readRepoJson(relative);
    let result;
    assert.doesNotThrow(() => { result = validateGateContractSuccessionAuthorityShape(authority); });
    assert.equal(isLedgerBoundGateContractSuccessionAuthority(authority), true, relative);
    assert.equal(result.valid, true, `${relative}: ${JSON.stringify(result.findings)}`);
  }
  const live = validateLedger({ root: REPO_ROOT, ledgerPath: LIVE_LEDGER, policy, mode: MODE_FULL });
  const successionBlocking = live.findings.filter((item) => item.severity === 'BLOCKING' && String(item.detectorId).startsWith('CONTRACT_SUCCESSION_'));
  assert.deepEqual(successionBlocking, []);
  assert.equal(live.findings.some((item) => item.detectorId === 'CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), false);
});

test('H existing ledger bytes are not mutated by this repair', () => {
  const before = shaFile(LIVE_LEDGER);
  validateLedger({ root: REPO_ROOT, ledgerPath: LIVE_LEDGER, policy, mode: MODE_FULL });
  validateGateContractSuccessionAuthorityShape(readRepoJson('governance/authority/authorizations/GATE25/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json'));
  const after = shaFile(LIVE_LEDGER);
  assert.equal(after, before);
  assert.equal(before, '64f11d155fc0a6571d14f03a19c7240042c349796678811cf6e081567358bc85');
});

/* ===================================================================== *
 * R2 — the three independent-audit defects, proven repaired.
 * ===================================================================== */

/* --- DEFECT 1: forbidden granted paths must not fail open ------------ */

const FORBIDDEN_GRANTED_PATH_CASES = Object.freeze([
  [SUCCESSION_LEDGER_PATH, 'LEDGER_PATH_FORBIDDEN'],
  [SUCCESSION_ACTIVE_GATE_PATH, 'ACTIVE_GATE_PATH_FORBIDDEN']
]);
const LEDGER_BOUND_GRANTABLE_PATH_FIELDS = Object.freeze([
  'currentContractPointerPath', 'successorContractPath', 'predecessorContractPath'
]);

test('R2-D1 every ledger-bound succession path field refuses the forbidden granted paths', () => {
  const base = readRepoJson(GATE25_AUTHORITY_PATH);
  for (const field of LEDGER_BOUND_GRANTABLE_PATH_FIELDS) {
    for (const [forbiddenPath, expectedCode] of FORBIDDEN_GRANTED_PATH_CASES) {
      const authority = clone(base);
      authority[field] = forbiddenPath;
      // isSafePath() alone accepts both of these, so the shape may only refuse them
      // via the forbidden-granted-path invariant.
      const shape = validateGateContractSuccessionLedgerBoundAuthorityShape(authority);
      assert.equal(shape.valid, false, `${field}=${forbiddenPath}`);
      assert.equal(
        shape.findings.some((item) => item.code === expectedCode && item.detail === `${field}:${forbiddenPath}`),
        true,
        `${field}=${forbiddenPath}: ${JSON.stringify(shape.findings)}`
      );
      // The same refusal through both public shape entry points and the evaluator.
      assert.equal(validateGateContractSuccessionAuthorityShape(authority).valid, false);
      assert.equal(validateGateContractSuccessionLocalAuthorityShape(authority).valid, false);
      const result = evaluateLedgerBound(authority, ledgerBoundEvidence(authority));
      assert.equal(result.decision, 'BLOCKED');
      assert.equal(result.successionAuthorized, false);
      assert.deepEqual(result.authorizedPaths, []);
      assert.equal(result.findings.some((item) => item.code === expectedCode), true);
    }
  }
});

test('R2-D1 no forbidden path can ever appear in authorizedPaths', () => {
  const base = readRepoJson(GATE25_AUTHORITY_PATH);
  const granted = [];
  const authorized = evaluateLedgerBound(base, ledgerBoundEvidence(base));
  assert.equal(authorized.decision, 'AUTHORIZED', JSON.stringify(authorized.findings));
  granted.push(...authorized.authorizedPaths);
  for (const field of LEDGER_BOUND_GRANTABLE_PATH_FIELDS) {
    for (const [forbiddenPath] of FORBIDDEN_GRANTED_PATH_CASES) {
      const authority = clone(base);
      authority[field] = forbiddenPath;
      granted.push(...evaluateLedgerBound(authority, ledgerBoundEvidence(authority)).authorizedPaths);
    }
  }
  for (const [forbiddenPath] of FORBIDDEN_GRANTED_PATH_CASES) {
    assert.equal(granted.includes(forbiddenPath), false, `${forbiddenPath} reached authorizedPaths`);
  }
  // And the grant, when it is made, is exactly successor contract + pointer.
  assert.deepEqual(authorized.authorizedPaths, [base.successorContractPath, base.currentContractPointerPath]);
});

/* --- DEFECT 2: missing observation must fail closed ------------------ */

const REQUIRED_LEDGER_BOUND_OBSERVATIONS = Object.freeze([
  ['projectId', 'CROSS_GATE_OR_PROJECT_BINDING'],
  ['gateId', 'CROSS_GATE_OR_PROJECT_BINDING'],
  ['baseCommit', 'BASE_COMMIT_MISMATCH'],
  ['competingAuthorityCount', 'COMPETING_SUCCESSION_AUTHORITIES'],
  ['authorityConsumed', 'AUTHORITY_REPLAY'],
  ['predecessorContractPath', 'PREDECESSOR_PATH_MISMATCH'],
  ['predecessorContractSha256', 'PREDECESSOR_SHA_MISMATCH'],
  ['successorContractPath', 'SUCCESSOR_PATH_MISMATCH'],
  ['successorContractSha256', 'SUCCESSOR_SHA_MISMATCH'],
  ['predecessorCurrentContractPath', 'PREDECESSOR_CURRENT_POINTER_PATH_MISMATCH'],
  ['successorCurrentContractPath', 'SUCCESSOR_CURRENT_POINTER_PATH_MISMATCH'],
  ['predecessorCurrentContractSha256', 'PREDECESSOR_CURRENT_POINTER_SHA_MISMATCH'],
  ['successorCurrentContractSha256', 'SUCCESSOR_CURRENT_POINTER_SHA_MISMATCH'],
  ['ledgerHeadEventId', 'LEDGER_HEAD_BINDING_MISMATCH'],
  ['ledgerHeadEventPayloadSha256', 'LEDGER_HEAD_BINDING_MISMATCH'],
  ['ledgerSha256', 'LEDGER_MUTATION_NOT_AUTHORIZED'],
  ['candidateLedgerSha256', 'LEDGER_MUTATION_NOT_AUTHORIZED']
]);
const REQUIRED_LEDGER_BOUND_DOCUMENTS = Object.freeze([
  'predecessorContract', 'successorContract', 'predecessorCurrentContract', 'successorCurrentContract'
]);

test('R2-D2 an absent or empty observation never authorizes', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  const complete = ledgerBoundEvidence(authority);
  for (const absent of [undefined, null, {}, [], 'observed', 42]) {
    let result;
    assert.doesNotThrow(() => {
      result = evaluateGateContractSuccessionAuthority({
        request: null, authority, ...complete, observed: absent
      });
    });
    assert.equal(result.decision, 'BLOCKED', JSON.stringify(absent));
    assert.equal(result.successionAuthorized, false);
    assert.deepEqual(result.authorizedPaths, []);
    assert.ok(result.findings.length > 0);
    // Absence is never silently treated as agreement.
    assert.equal(result.findings.some((item) => item.code === 'AUTHORITY_REPLAY'), true);
  }
});

test('R2-D2 each required observation field blocks on its own when absent', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  for (const [field, expectedCode] of REQUIRED_LEDGER_BOUND_OBSERVATIONS) {
    const evidence = ledgerBoundEvidence(authority);
    delete evidence.observed[field];
    let result;
    assert.doesNotThrow(() => { result = evaluateLedgerBound(authority, evidence); });
    assert.equal(result.decision, 'BLOCKED', `absent ${field} authorized`);
    assert.equal(result.successionAuthorized, false);
    assert.deepEqual(result.authorizedPaths, []);
    assert.equal(
      result.findings.some((item) => item.code === expectedCode),
      true,
      `absent ${field}: expected ${expectedCode}, got ${JSON.stringify(result.findings)}`
    );
  }
});

test('R2-D2 a malformed observed value blocks with the same finding a divergent one raises', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  const malformed = [
    ['predecessorContractSha256', null, 'PREDECESSOR_SHA_MISMATCH'],
    ['successorContractSha256', 42, 'SUCCESSOR_SHA_MISMATCH'],
    ['successorContractPath', {}, 'SUCCESSOR_PATH_MISMATCH'],
    ['baseCommit', '', 'BASE_COMMIT_MISMATCH'],
    ['competingAuthorityCount', '1', 'COMPETING_SUCCESSION_AUTHORITIES'],
    ['competingAuthorityCount', 2, 'COMPETING_SUCCESSION_AUTHORITIES'],
    // Only an explicit observed `false` clears the single-use blocker.
    ['authorityConsumed', 'false', 'AUTHORITY_REPLAY'],
    ['authorityConsumed', null, 'AUTHORITY_REPLAY'],
    ['ledgerSha256', 'not-a-sha', 'LEDGER_MUTATION_NOT_AUTHORIZED']
  ];
  for (const [field, value, expectedCode] of malformed) {
    const evidence = ledgerBoundEvidence(authority);
    evidence.observed[field] = value;
    let result;
    assert.doesNotThrow(() => { result = evaluateLedgerBound(authority, evidence); });
    assert.equal(result.decision, 'BLOCKED', `${field}=${JSON.stringify(value)}`);
    assert.equal(
      result.findings.some((item) => item.code === expectedCode),
      true,
      `${field}=${JSON.stringify(value)}: ${JSON.stringify(result.findings)}`
    );
  }
});

test('R2-D2 an unavailable predecessor or successor contract document blocks', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  for (const document of REQUIRED_LEDGER_BOUND_DOCUMENTS) {
    for (const absent of [null, undefined]) {
      const evidence = ledgerBoundEvidence(authority);
      evidence[document] = absent;
      let result;
      assert.doesNotThrow(() => { result = evaluateLedgerBound(authority, evidence); });
      assert.equal(result.decision, 'BLOCKED', `absent ${document} authorized`);
      assert.equal(result.successionAuthorized, false);
      assert.deepEqual(result.authorizedPaths, []);
      assert.equal(
        result.findings.some((item) => item.code === 'CONTRACT_BYTES_UNAVAILABLE' && item.detail === document),
        true,
        `absent ${document}: ${JSON.stringify(result.findings)}`
      );
    }
  }
});

test('R2-D2 after presence is proven, values are compared strictly', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  // A successor pointer that names the pointer's own path instead of the contract it
  // points at is a mismatch, not a match: the two are different things.
  const confused = ledgerBoundEvidence(authority);
  confused.successorCurrentContract.contractPath = authority.currentContractPointerPath;
  assert.equal(evaluateLedgerBound(authority, confused).findings.some((item) => item.code === 'SUCCESSOR_POINTER_BINDING_MISMATCH'), true);
  // And a pointer still holding the predecessor cannot witness the successor.
  const stale = ledgerBoundEvidence(authority);
  stale.successorCurrentContract.contractSha256 = authority.predecessorContractSha256;
  assert.equal(evaluateLedgerBound(authority, stale).findings.some((item) => item.code === 'SUCCESSOR_POINTER_BINDING_MISMATCH'), true);
  const complete = evaluateLedgerBound(authority, ledgerBoundEvidence(authority));
  assert.equal(complete.decision, 'AUTHORIZED', JSON.stringify(complete.findings));
});

/* --- DEFECT 3: consumption identity is path AND sha ------------------ */

/**
 * Appends a CONTRACT_SUCCESSION event that reuses a historical one's bindings while
 * overriding the authority identity, so the replay rule can be probed in isolation.
 */
function successionReplayReport(overrides) {
  const events = fs.readFileSync(LIVE_LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const last = events.at(-1);
  const original = events.find((event) => event.eventId === 'GATE25_CONTRACT_SUCCESSION_R0003_R1');
  const candidate = recomputeEvent({
    ...original,
    eventId: 'GATE25_CONTRACT_SUCCESSION_R0003_PROBE',
    ordinal: last.ordinal + 1,
    previousEventSha256: last.eventPayloadSha256,
    recordedAt: '2026-09-15T12:00:00.000Z',
    ...overrides
  });
  const { tmp, out } = appendLedgerEvent(candidate);
  try {
    return blockingCodes(validateLedger({ root: REPO_ROOT, ledgerPath: out, policy, mode: MODE_FULL }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('R2-A first use of a distinct authority is AUTHORIZED', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  const result = evaluateLedgerBound(authority, ledgerBoundEvidence(authority));
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
  assert.equal(result.successionAuthorized, true);
  // And it still grants nothing beyond the switch.
  assert.equal(result.startAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.closureAuthorized, false);
});

test('R2-B the exact same authority a second time is rejected as AUTHORITY_REPLAY', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  const evidence = ledgerBoundEvidence(authority);
  evidence.observed.authorityConsumed = true;
  const result = evaluateLedgerBound(authority, evidence);
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.findings.some((item) => item.code === 'AUTHORITY_REPLAY'), true);
  assert.deepEqual(result.authorizedPaths, []);
});

test('R2-C same authority path and sha under a different eventId is still a replay', () => {
  const codes = successionReplayReport({});
  assert.equal(codes.includes('CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), true, JSON.stringify(codes));
  assert.equal(codes.includes('LEDGER_DUPLICATE_EVENT_ID'), false);
});

/**
 * The replay rule can only be REACHED when the cited authority actually resolves —
 * the path exists and its bytes hash to the cited digest. Against the live repository
 * the only resolvable identities are the six already-consumed ones, so probing the
 * path-arm and the sha-arm in isolation requires a root where a second authority
 * document genuinely exists. This builds exactly that root: the governed authority
 * files named by `files`, a ledger of the real history plus one appended event, and
 * nothing else. Findings about the unrelated events are irrelevant here; the only
 * assertion made is whether THIS event is judged a replay.
 */
function successionIdentityProbe({ files, authorityPath, authoritySha256 }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g25-succ-identity-'));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(tmp, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    const events = fs.readFileSync(LIVE_LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const last = events.at(-1);
    const original = events.find((event) => event.eventId === 'GATE25_CONTRACT_SUCCESSION_R0003_R1');
    const candidate = recomputeEvent({
      ...original,
      eventId: 'GATE25_CONTRACT_SUCCESSION_R0003_PROBE',
      ordinal: last.ordinal + 1,
      previousEventSha256: last.eventPayloadSha256,
      recordedAt: '2026-09-15T12:00:00.000Z',
      authorityPath,
      authoritySha256
    });
    const ledgerPath = path.join(tmp, 'PROBE_LEDGER.ndjson');
    const text = fs.readFileSync(LIVE_LEDGER, 'utf8');
    fs.writeFileSync(ledgerPath, `${text.endsWith('\n') ? text : `${text}\n`}${canonicalize(candidate)}\n`);
    const report = validateLedger({ root: tmp, ledgerPath, policy, mode: MODE_FULL });
    const forProbe = report.findings.filter((item) => item.eventId === candidate.eventId).map((item) => item.detectorId);
    return { codes: forProbe, all: report.findings.map((item) => item.detectorId) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const GATE25_CANONICAL_AUTHORITY_PATH = 'governance/authority/authorizations/GATE25/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json';
const GATE25_SECOND_AUTHORITY_PATH = 'governance/authority/authorizations/GATE25/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY_R2.json';

test('R2-D the same authority path bearing a NEW sha is a distinct authority, not a replay', () => {
  const original = fs.readFileSync(path.join(REPO_ROOT, ...GATE25_CANONICAL_AUTHORITY_PATH.split('/')));
  // A genuinely different document written to the SAME governed path.
  const revised = Buffer.from(JSON.stringify({ ...JSON.parse(original.toString('utf8')), authorityId: 'GATE25_SECOND_LAWFUL_AUTHORITY_R2' }));
  const revisedSha = sha(revised);
  assert.notEqual(revisedSha, sha(original));
  const probe = successionIdentityProbe({
    files: { [GATE25_CANONICAL_AUTHORITY_PATH]: revised },
    authorityPath: GATE25_CANONICAL_AUTHORITY_PATH,
    authoritySha256: revisedSha
  });
  // The authority resolves, so the replay rule is genuinely reached...
  assert.equal(probe.codes.includes('CONTRACT_SUCCESSION_AUTHORITY_UNRESOLVED'), false, JSON.stringify(probe.codes));
  // ...and the path alone — identical to an already-consumed authority — must not
  // condemn it. Under the old disjunction this is exactly where a Gate became unable
  // to ever lawfully succeed again.
  assert.equal(probe.codes.includes('CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), false, JSON.stringify(probe.codes));
});

test('R2-E the same sha under a different governed path is not the same consumption identity', () => {
  const original = fs.readFileSync(path.join(REPO_ROOT, ...GATE25_CANONICAL_AUTHORITY_PATH.split('/')));
  // Byte-identical document at a SECOND governed path: same sha, different path.
  const probe = successionIdentityProbe({
    files: {
      [GATE25_CANONICAL_AUTHORITY_PATH]: original,
      [GATE25_SECOND_AUTHORITY_PATH]: original
    },
    authorityPath: GATE25_SECOND_AUTHORITY_PATH,
    authoritySha256: sha(original)
  });
  assert.equal(probe.codes.includes('CONTRACT_SUCCESSION_AUTHORITY_UNRESOLVED'), false, JSON.stringify(probe.codes));
  // The sha alone matches a consumed authority, but the governed path differs and no
  // frozen rule declares the two locations equivalent, so this is not that consumption.
  assert.equal(probe.codes.includes('CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), false, JSON.stringify(probe.codes));
});

test('R2-E both components matching IS a replay, so the conjunction still blocks', () => {
  const original = fs.readFileSync(path.join(REPO_ROOT, ...GATE25_CANONICAL_AUTHORITY_PATH.split('/')));
  const probe = successionIdentityProbe({
    files: { [GATE25_CANONICAL_AUTHORITY_PATH]: original },
    authorityPath: GATE25_CANONICAL_AUTHORITY_PATH,
    authoritySha256: sha(original)
  });
  assert.equal(probe.codes.includes('CONTRACT_SUCCESSION_AUTHORITY_UNRESOLVED'), false, JSON.stringify(probe.codes));
  assert.equal(probe.codes.includes('CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), true, JSON.stringify(probe.codes));
});

test('R2-F the consumption check honors the authority actually loaded via localAuthorityPath', () => {
  const overridePath = 'governance/authority/authorizations/GATE24/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json';
  const overrideSha = shaFile(path.join(REPO_ROOT, ...overridePath.split('/')));
  const result = createWheelGateContractSuccessionAuthoritySource(REPO_ROOT, { localAuthorityPath: overridePath })
    .resolveGateContractSuccessionAuthority('GATE25');
  // The evaluated authority names itself; the gate-scoped canonical path is NOT assumed.
  assert.equal(result.authorityPath, overridePath);
  assert.equal(result.authoritySha256, overrideSha);
  assert.notEqual(result.authorityPath, gateContractSuccessionLocalAuthorityPath('GATE25'));
  // That identity — GATE24's path AND GATE24's bytes — is consumed in the live ledger,
  // which is only visible if the lookup used the loaded document rather than GATE25's.
  assert.equal(result.findings.some((item) => item.code === 'AUTHORITY_REPLAY'), true, JSON.stringify(result.findings));
  assert.equal(result.decision, 'BLOCKED');
  // Without an override the canonical location is still what gets evaluated.
  const canonical = createWheelGateContractSuccessionAuthoritySource(REPO_ROOT).resolveGateContractSuccessionAuthority('GATE24');
  assert.equal(canonical.authorityPath, overridePath);
  assert.equal(canonical.authoritySha256, overrideSha);
});

test('R2-G the six historical canonical successions remain valid', () => {
  const live = validateLedger({ root: REPO_ROOT, ledgerPath: LIVE_LEDGER, policy, mode: MODE_FULL });
  const succession = live.events.filter((event) => event.transitionType === CONTRACT_SUCCESSION_TRANSITION_TYPE);
  assert.equal(succession.length, 6, succession.map((event) => event.eventId).join(','));
  // Six distinct (path, sha) identities: none consumes another under the conjunction.
  const identities = succession.map((event) => `${event.authorityPath}::${event.authoritySha256}`);
  assert.equal(new Set(identities).size, 6);
  assert.deepEqual(live.findings.filter((item) => item.severity === 'BLOCKING' && String(item.detectorId).startsWith('CONTRACT_SUCCESSION_')), []);
  assert.equal(live.findings.some((item) => item.detectorId === 'CONTRACT_SUCCESSION_AUTHORITY_REPLAYED'), false);
  assert.equal(live.findings.filter((item) => item.detectorId === 'CONTRACT_SUCCESSION_APPLIED').length, 6);
  for (const relative of LEDGER_BOUND_AUTHORITIES) {
    assert.equal(validateGateContractSuccessionAuthorityShape(readRepoJson(relative)).valid, true, relative);
  }
});

/**
 * MANDATORY. GATE25 has already consumed one succession authority. A future, lawful,
 * genuinely DISTINCT authority must still be authorizable — otherwise the replay rule
 * has permanently frozen the Gate and closure could never proceed. This is the case
 * the previous suite never exercised.
 */
test('R2-H a future lawful GATE25 succession with a distinct authority is AUTHORIZED', () => {
  const consumed = readRepoJson(GATE25_AUTHORITY_PATH);
  const future = {
    ...clone(consumed),
    authorityId: 'OWNER_AUTHORIZE_GATE25_FUTURE_LAWFUL_CONTRACT_SUCCESSION_R2',
    reason: 'Synthetic future lawful succession proving a distinct authority is not a replay.',
    baseHead: 'd'.repeat(40),
    preLedgerEventCount: 107,
    preLedgerPrefixSha256: 'e'.repeat(64),
    predecessorContractPath: consumed.successorContractPath,
    predecessorContractSha256: consumed.successorContractSha256,
    predecessorContractRevision: 'R0003',
    successorContractPath: 'governance/gates/GATE25/contracts/EXECUTION_CONTRACT_R0004.json',
    successorContractSha256: 'f'.repeat(64),
    successorContractRevision: 'R0004',
    predecessorCurrentContractSha256: consumed.successorCurrentContractSha256,
    successorCurrentContractSha256: '1'.repeat(64),
    previousStateSealSha256: '2'.repeat(64),
    successorStateRevision: 'R0004',
    successorStateSealSha256: null,
    ledgerHeadEventId: 'GATE25_CONTRACT_SUCCESSION_R0003_R1',
    ledgerHeadEventPayloadSha256: '3'.repeat(64)
  };
  // It is a different document from the consumed one by both identity components.
  assert.notEqual(sha256Canonical(future), sha256Canonical(consumed));
  assert.equal(isLedgerBoundGateContractSuccessionAuthority(future), true);
  assert.equal(validateGateContractSuccessionLedgerBoundAuthorityShape(future).valid, true, JSON.stringify(validateGateContractSuccessionLedgerBoundAuthorityShape(future).findings));

  const result = evaluateLedgerBound(future, ledgerBoundEvidence(future));
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
  assert.equal(result.successionAuthorized, true);
  // Specifically NOT rejected merely because GATE25 previously consumed an authority.
  assert.equal(result.findings.some((item) => item.code === 'AUTHORITY_REPLAY'), false);
  assert.deepEqual(result.authorizedPaths, [future.successorContractPath, future.currentContractPointerPath]);
  assert.equal(result.startAuthorized, false);
  assert.equal(result.closureAuthorized, false);
  // The already-consumed authority is still refused at the same moment.
  const replay = ledgerBoundEvidence(consumed);
  replay.observed.authorityConsumed = true;
  assert.equal(evaluateLedgerBound(consumed, replay).findings.some((item) => item.code === 'AUTHORITY_REPLAY'), true);
});

test('R2 the original TypeError repair is preserved across all three validators', () => {
  const authority = readRepoJson(GATE25_AUTHORITY_PATH);
  for (const validator of [
    validateGateContractSuccessionAuthorityShape,
    validateGateContractSuccessionLocalAuthorityShape,
    validateGateContractSuccessionLedgerBoundAuthorityShape
  ]) {
    let result;
    assert.doesNotThrow(() => { result = validator(authority); });
    assert.equal(result.valid, true, JSON.stringify(result.findings));
    // No canonicalize(undefined) / undefined.split('/') escaping as an exception.
    assert.equal(result.findings.some((item) => item.code === 'AUTHORITY_VALIDATION_EXCEPTION'), false);
  }
});

