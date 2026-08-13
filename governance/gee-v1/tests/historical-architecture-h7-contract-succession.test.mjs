/**
 * H7 — contract succession, recorded in the ledger, authorized locally.
 *
 * Two properties are load-bearing here and are easy to lose:
 *
 *   1. The succession must not widen the closed I2 execution table. It is a
 *      THIRD narrow class whose single entry is a self-transition, so it can
 *      never start, close or confirm a Gate.
 *
 *   2. There must be NO DIGEST CYCLE. Event 59 pins the R0003 seal; the R0003
 *      seal must therefore be computable without knowing event 59.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  TRANSITIONS,
  TRANSITION_TYPES,
  STATUSES,
  NORMAL_EXECUTION_TRANSITION_TYPES,
  HISTORICAL_RECONCILIATION_TRANSITIONS,
  CONTRACT_SUCCESSION_TRANSITIONS,
  CONTRACT_SUCCESSION_TRANSITION_TYPE,
  NATIVE_STATE_PIN_FIRST_ORDINAL,
  validateLedger,
  validateLedgerPrefix,
  MODE_FULL
} from '../../tools/validate-status-ledger.mjs';
import { computeSealedMembersDigest } from '../../tools/validate-state-seal.mjs';
import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY as policy } from '../adapters/wheel/external-authority-policy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readBytes = (relative) => fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')));
const readJson = (relative) => JSON.parse(readBytes(relative).toString('utf8'));
const events = () => fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));

// --- the transition class ---------------------------------------------------

test('H7-01: succession is a third narrow class and does not widen the I2 table', () => {
  assert.equal(TRANSITIONS.length, 21, 'the closed I2 execution table must be untouched');
  assert.equal(NORMAL_EXECUTION_TRANSITION_TYPES.length, 15);
  assert.equal(TRANSITIONS.some(([, , t]) => t === CONTRACT_SUCCESSION_TRANSITION_TYPE), false);
  assert.equal(HISTORICAL_RECONCILIATION_TRANSITIONS.some(([, , t]) => t === CONTRACT_SUCCESSION_TRANSITION_TYPE), false);
  assert.deepEqual(CONTRACT_SUCCESSION_TRANSITIONS, [['IN_PROGRESS', 'IN_PROGRESS', 'CONTRACT_SUCCESSION']]);
  assert.ok(TRANSITION_TYPES.includes(CONTRACT_SUCCESSION_TRANSITION_TYPE));
});

test('H7-02: the succession entry is a self-transition reaching no new status', () => {
  for (const [from, to] of CONTRACT_SUCCESSION_TRANSITIONS) {
    assert.equal(from, to);
    assert.ok(STATUSES.includes(to));
  }
  // It can never be used to start, close or confirm a Gate.
  for (const forbidden of ['AUTHORIZED_NOT_STARTED', 'COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'NOT_STARTED']) {
    assert.equal(CONTRACT_SUCCESSION_TRANSITIONS.some(([, to]) => to === forbidden), false, forbidden);
  }
});

test('H7-03: the event schema and the normative validator agree on transition types', () => {
  const schema = readJson('governance/schemas/gate-status-event.schema.json');
  assert.deepEqual(schema.properties.transitionType.enum, TRANSITION_TYPES);
});

// --- EXECUTION_CONTRACT_R0002: exactly three minimal changes ----------------

test('H7-04: R0002 changes exactly the three authorized things and nothing else', () => {
  const r1 = readJson('governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json');
  const r2 = readJson('governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0002.json');

  // (1) the stale impossible closure condition is gone
  assert.ok(r1.closureConditions.includes('GATE14 NOT_STARTED'));
  assert.equal(r2.closureConditions.includes('GATE14 NOT_STARTED'), false);
  assert.deepEqual(r2.closureConditions, r1.closureConditions.filter((c) => c !== 'GATE14 NOT_STARTED'));

  // (2) the whole growing-ledger SHA is replaced by eventCount + prefixSha256
  const ledgerInput = r2.requiredInputs.find((i) => i.path === 'governance/state/GATE_STATUS_LEDGER.ndjson');
  assert.equal(Object.hasOwn(ledgerInput, 'sha256'), false, 'a growing ledger can never match a whole-file digest');
  assert.equal(ledgerInput.ledgerEventCount, 56);
  assert.match(ledgerInput.ledgerPrefixSha256, /^[a-f0-9]{64}$/);

  // (3) successor lineage metadata
  assert.equal(r2.previousContractPath, 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json');
  assert.equal(r2.previousContractSha256, sha(readBytes('governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json')));
  assert.equal(r2.contractRevision, 'R0002');

  // NOTHING ELSE MOVED. Every other key is byte-identical in meaning.
  const ignored = new Set(['contractRevision', 'closureConditions', 'requiredInputs', 'previousContractPath', 'previousContractSha256']);
  for (const key of new Set([...Object.keys(r1), ...Object.keys(r2)])) {
    if (ignored.has(key)) continue;
    assert.deepEqual(r2[key], r1[key], `${key} must not change`);
  }
  // The mandate itself is untouched.
  assert.deepEqual(r2.canonicalRequirements, r1.canonicalRequirements);
  assert.deepEqual(r2.requiredOutputs, r1.requiredOutputs);
  assert.deepEqual(r2.authorizedPaths, r1.authorizedPaths);
});

test('H7-05: the predecessor contract is untouched', () => {
  assert.equal(sha(readBytes('governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json')),
    'be2b6c3abae20e59791587529567b534935d161144ff3aa9d05748b516a0262d');
});

// --- the local succession authority -----------------------------------------

test('H7-06: the succession authority is local and carries no key material', () => {
  const authority = readJson('governance/historical-architecture/CONTRACT_SUCCESSION_R0002_LOCAL_AUTHORITY.json');
  assert.equal(authority.authorityMode, 'LOCAL_EXPLICIT_AUTHORITY');
  assert.equal(authority.maxUse, 1);
  assert.equal(authority.pushAuthorized, false);
  for (const field of ['signature', 'ownerKeyId', 'signatureAlgorithm', 'privateKeyPath']) {
    assert.equal(Object.hasOwn(authority, field), false, field);
  }
  // It binds the exact pre-state it was issued against.
  assert.equal(authority.baseHead, '609cc5d16ce2bb176eefd149a8475f06e0ab75a4');
  assert.equal(authority.preLedgerEventCount, 58);
  assert.equal(authority.predecessorContractRevision, 'R0001');
  assert.equal(authority.successorContractRevision, 'R0002');
  // And it grants nothing beyond the switch.
  for (const forbidden of ['START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_CONFIRMED', 'ACTIVE_GATE_SWITCH', 'GEE_R8', 'GIT_PUSH', 'LEDGER_REWRITE']) {
    assert.ok(authority.prohibitedOperations.includes(forbidden), forbidden);
  }
});

// --- event 59 ---------------------------------------------------------------

test('H7-07: event 59 records the succession with a native state pin', () => {
  const all = events();
  assert.equal(all.length, 59);
  const event59 = all[58];
  assert.equal(event59.ordinal, 59);
  assert.equal(event59.transitionType, 'CONTRACT_SUCCESSION');
  assert.equal(event59.gateId, 'GATE14');
  assert.equal(event59.fromStatus, 'IN_PROGRESS');
  assert.equal(event59.toStatus, 'IN_PROGRESS');
  assert.equal(event59.stateRevision, 'R0003');
  assert.equal(event59.stateRevisionSealSha256, sha(readBytes('governance/gates/GATE14/state/revisions/R0003/STATE_SEAL.json')));
  assert.ok(event59.ordinal >= NATIVE_STATE_PIN_FIRST_ORDINAL);
  // It cites the succession authority by exact bytes.
  assert.equal(event59.authorityPath, 'governance/historical-architecture/CONTRACT_SUCCESSION_R0002_LOCAL_AUTHORITY.json');
  assert.equal(event59.authoritySha256, sha(readBytes('governance/historical-architecture/CONTRACT_SUCCESSION_R0002_LOCAL_AUTHORITY.json')));
  // And it chains to event 58.
  assert.equal(event59.previousEventSha256, all[57].eventPayloadSha256);
});

test('H7-08: NO DIGEST CYCLE — the R0003 seal is computable without event 59', () => {
  const seal = readJson('governance/gates/GATE14/state/revisions/R0003/STATE_SEAL.json');
  const event59 = events()[58];
  const serialized = JSON.stringify(seal);
  // The seal must not reference the event that pins it, in any form.
  assert.equal(serialized.includes(event59.eventPayloadSha256), false, 'seal must not embed the event digest');
  assert.equal(serialized.includes(event59.eventId), false, 'seal must not name the event');
  // And it must be reproducible from its own declared inputs alone.
  assert.equal(sha256Canonical(seal.payload), seal.payloadSha256);
  assert.equal(seal.payload.sealedMembersDigest, computeSealedMembersDigest(seal.sealedMembers));
  assert.equal(seal.previousStateSealSha256, sha(readBytes('governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json')));
  assert.equal(seal.payload.contractSha256, sha(readBytes('governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0002.json')));
});

test('H7-09: events 1-58 are byte-identical after the append', () => {
  const bytes = fs.readFileSync(LEDGER, 'utf8').split('\n').filter((l) => l.trim()).slice(0, 58).join('\n') + '\n';
  assert.equal(sha(Buffer.from(bytes, 'utf8')), '7289f3ef93823a2cc7a5494bb25f7d0a144e6481d3674aaaba7a7e5736a58bc1');
});

// --- the resulting canonical state ------------------------------------------

test('H7-10: the canonical state is exactly what the program was authorized to produce', () => {
  assert.equal(events().length, 59);
  assert.equal(events().filter((e) => e.gateId === 'GATE14').at(-1).toStatus, 'IN_PROGRESS');
  assert.equal(readJson('governance/gates/GATE14/state/CURRENT_STATE.json').stateRevision, 'R0003');
  assert.equal(readJson('governance/gates/GATE14/contracts/CURRENT_CONTRACT.json').contractRevision, 'R0002');
  assert.equal(readJson('governance/active/ACTIVE_GATE.json').activeGate, 'GATE13');
  // Frozen artifacts untouched.
  assert.equal(sha(readBytes('governance/gates/GATE14/state/revisions/R0001/STATE_SEAL.json')), 'c7004faf6368c46a96ec44a230cf594c4f7a4b09ad0f0901c15638071ca9c38d');
  assert.equal(sha(readBytes('governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json')), 'ca29d6ade22c0de9a9eeb18b9d2dfa4d48b202996951a4223e3fc13d3f04c5dd');
  // No closure, no R8.
  const gate14 = events().filter((e) => e.gateId === 'GATE14');
  assert.equal(gate14.filter((e) => e.transitionType === 'AGENT_CLOSURE').length, 0);
  assert.equal(gate14.filter((e) => e.transitionType === 'EXTERNAL_CONFIRMATION').length, 0);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0008.json')), false);
});

test('H7-11: the 59-event ledger is valid and replays at 56, 57, 58 and 59', () => {
  const full = validateLedger({ root: REPO_ROOT, ledgerPath: LEDGER, policy, mode: MODE_FULL });
  assert.equal(full.valid, true, JSON.stringify(full.findings.filter((f) => f.severity === 'BLOCKING')));
  for (const ordinal of [56, 57, 58, 59]) {
    const report = validateLedgerPrefix({ root: REPO_ROOT, ledgerPath: LEDGER, throughOrdinal: ordinal, policy });
    assert.deepEqual(report.prefixFindings.filter((f) => f.severity === 'BLOCKING'), [], `replay --at ${ordinal}`);
  }
});

test('H7-12: a succession event whose state pin does not match its seal blocks', () => {
  const all = events();
  const tampered = { ...all[58], stateRevisionSealSha256: 'a'.repeat(64) };
  const lines = [...all.slice(0, 58).map((e) => JSON.stringify(e)), JSON.stringify(tampered)];
  const os = fs.mkdtempSync(path.join(path.dirname(REPO_ROOT), 'h7-tamper-'));
  try {
    const ledger = path.join(os, 'L.ndjson');
    fs.writeFileSync(ledger, lines.join('\n') + '\n');
    const report = validateLedger({ root: REPO_ROOT, ledgerPath: ledger, policy, mode: MODE_FULL });
    assert.equal(report.valid, false);
  } finally { fs.rmSync(os, { recursive: true, force: true }); }
});
