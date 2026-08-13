import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  SUCCESSION_AUTHORITY_KIND,
  SUCCESSION_OPERATION,
  SUCCESSION_PURPOSE,
  canonicalSuccessionSigningPayload,
  computeGateContractSuccessionBindingDigest,
  computeGateContractSuccessionRecordDigest,
  computeGateContractSuccessionRequestDigest,
  diffContractSemantics,
  evaluateGateContractSuccessionAuthority,
  validateGateContractSuccessionAuthorityShape,
  validateGateContractSuccessionRecordShape,
  validateGateContractSuccessionRequestShape,
  verifyGateContractSuccessionOwnerSignature
} from '../gee-v1/core/gate-contract-succession-authority.mjs';
import { canonicalize } from '../tools/canonical-json.mjs';

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
