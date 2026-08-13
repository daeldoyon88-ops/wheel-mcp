/**
 * H5 — a legacy binding record may INTERPRET history and may never INVENT it.
 *
 * Structurally, a truthful record and a fabricated one look the same. The only
 * thing separating them is agreement with evidence that was already immutable,
 * so every hostile below is a way of disagreeing with exactly one piece of that
 * evidence while looking perfectly well-formed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluateLegacyStateBinding,
  validateLegacyStateBindingsDocument,
  FORBIDDEN_BINDING_CLAIMS,
  DEFAULT_LEGACY_ERA_MAX_ORDINAL
} from '../core/legacy-state-binding.mjs';
import { reconstructLedgerPrefixBytes } from '../../tools/validate-status-ledger.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const codes = (result) => result.findings.map((f) => f.code);

const document = () => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json'), 'utf8'));
const events = () => fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
const readBytes = (relative) => fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')));

/** Real evidence for one real binding — nothing here is mocked. */
function realCase(ordinal) {
  const doc = document();
  const binding = structuredClone(doc.bindings.find((b) => b.eventOrdinal === ordinal));
  const event = structuredClone(events().find((e) => e.ordinal === ordinal));
  const sealBytes = readBytes(binding.stateRevisionSealPath);
  const authorityBytes = readBytes(binding.originalAuthorityPath);
  const evidence = {
    event,
    ledgerPrefixSha256: sha(reconstructLedgerPrefixBytes(LEDGER, ordinal)),
    authoritySha256: sha(authorityBytes),
    seal: { sha256: sha(sealBytes), byteLength: sealBytes.length, json: JSON.parse(sealBytes.toString('utf8')) },
    predecessorSealSha256: binding.previousStateSealSha256
  };
  return { binding, evidence, legacyEraMaxOrdinal: doc.legacyEraMaxOrdinal };
}

// --- positives --------------------------------------------------------------

test('H5-01: both real legacy bindings agree with immutable evidence', () => {
  for (const ordinal of [57, 58]) {
    const result = evaluateLegacyStateBinding(realCase(ordinal));
    assert.deepEqual(result.findings, [], `ordinal ${ordinal}`);
    assert.equal(result.decision, 'AUTHORIZED');
    assert.equal(result.grantsPermission, false);
  }
});

test('H5-02: the shipped document is structurally valid', () => {
  const result = validateLegacyStateBindingsDocument(document());
  assert.deepEqual(result.findings, []);
  assert.equal(document().legacyEraMaxOrdinal, DEFAULT_LEGACY_ERA_MAX_ORDINAL);
});

test('H5-03: the executable validator authorizes both bindings and grants nothing', () => {
  const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'governance/tools/validate-legacy-state-binding.mjs'), '--root', REPO_ROOT], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.valid, true, JSON.stringify(report.findings));
  assert.equal(report.grantsNoPermission, true);
  assert.deepEqual(report.bindings.map((b) => b.stateRevision), ['R0001', 'R0002']);
  assert.ok(report.bindings.every((b) => b.decision === 'AUTHORIZED' && b.grantsPermission === false));
});

test('H5-04: event 57 binds R0001 rooted at the seal the authorization record pinned', () => {
  const { binding } = realCase(57);
  const record = JSON.parse(readBytes('governance/authority/authorizations/GATE14/GATE_AUTHORIZATION_RECORD.json').toString('utf8'));
  assert.equal(binding.stateRevision, record.stateRevision);
  assert.equal(binding.stateRevisionSealSha256, record.authorizedStateArtifacts.find((a) => a.cohortRole === 'STATE_SEAL').sha256);
  assert.equal(binding.previousStateSealSha256, null, 'R0001 is the chain root');
});

test('H5-05: event 58 binds R0002 chained to the R0001 seal the START record pinned', () => {
  const { binding } = realCase(58);
  const record = JSON.parse(readBytes('governance/authority/authorizations/GATE14/GATE_START_RECORD.json').toString('utf8'));
  assert.equal(binding.previousStateSealSha256, record.preStateSealSha256);
  assert.equal(record.preStateRevision, 'R0001');
  assert.equal(binding.stateRevision, 'R0002');
});

// --- mandated hostiles ------------------------------------------------------

for (const [name, mutate, expected] of [
  ['H5-H01 wrong event', (c) => { c.binding.eventId = 'SOME_OTHER_EVENT'; }, 'LEGACY_BINDING_EVENT_MISMATCH'],
  ['H5-H02 wrong gate', (c) => { c.binding.gateId = 'GATE12'; }, 'LEGACY_BINDING_GATE_MISMATCH'],
  ['H5-H03 wrong payload digest', (c) => { c.binding.eventPayloadSha256 = 'f'.repeat(64); }, 'LEGACY_BINDING_PAYLOAD_MISMATCH'],
  ['H5-H04 wrong revision', (c) => { c.binding.stateRevision = 'R0009'; }, 'LEGACY_BINDING_SEAL_REVISION_MISMATCH'],
  ['H5-H05 wrong seal digest', (c) => { c.binding.stateRevisionSealSha256 = 'a'.repeat(64); }, 'LEGACY_BINDING_SEAL_BYTES_MISMATCH'],
  ['H5-H06 wrong original authority digest', (c) => { c.binding.originalAuthoritySha256 = 'b'.repeat(64); }, 'LEGACY_BINDING_AUTHORITY_DIGEST_MISMATCH'],
  ['H5-H07 wrong original authority path', (c) => { c.binding.originalAuthorityPath = 'governance/authority/elsewhere.json'; }, 'LEGACY_BINDING_AUTHORITY_PATH_MISMATCH'],
  ['H5-H08 wrong ledger prefix', (c) => { c.binding.ledgerPrefixSha256 = 'c'.repeat(64); }, 'LEGACY_BINDING_LEDGER_PREFIX_MISMATCH'],
  // Ordinal 58 IS a START, so the mutation must name a genuinely different type.
  ['H5-H09 wrong transition type', (c) => { c.binding.transitionType = 'AUTHORIZATION'; }, 'LEGACY_BINDING_TRANSITION_MISMATCH'],
  ['H5-H10 status disagreeing with the sealed status', (c) => { c.binding.toStatus = 'COMPLETE_CONFIRMED'; }, 'LEGACY_BINDING_STATUS_MISMATCH'],
  ['H5-H11 broken chain link', (c) => { c.binding.previousStateSealSha256 = 'd'.repeat(64); }, 'LEGACY_BINDING_SEAL_CHAIN_MISMATCH'],
  ['H5-H12 native-era migration', (c) => { c.binding.eventOrdinal = 59; }, 'NATIVE_ERA_MIGRATION_FORBIDDEN'],
  ['H5-H13 seal byte length disagreement', (c) => { c.binding.stateRevisionSealByteLength = 1; }, 'LEGACY_BINDING_SEAL_LENGTH_MISMATCH']
]) {
  test(`${name} BLOCKS`, () => {
    const testCase = realCase(58);
    mutate(testCase);
    const result = evaluateLegacyStateBinding(testCase);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes(expected), `${expected} not in ${codes(result).join(',')}`);
  });
}

test('H5-H14: a record attempting to grant ANY permission is refused', () => {
  for (const claim of FORBIDDEN_BINDING_CLAIMS) {
    const testCase = realCase(58);
    testCase.binding[claim] = true;
    const result = evaluateLegacyStateBinding(testCase);
    assert.equal(result.decision, 'BLOCKED', claim);
    assert.ok(codes(result).includes('LEGACY_BINDING_CLAIMS_PERMISSION'), claim);
  }
});

test('H5-H15: a status mutation attempt is refused even when everything else agrees', () => {
  const testCase = realCase(58);
  testCase.binding.statusMutation = 'COMPLETE_CONFIRMED';
  assert.ok(codes(evaluateLegacyStateBinding(testCase)).includes('LEGACY_BINDING_CLAIMS_PERMISSION'));
});

test('H5-H16: a contract mutation attempt is refused', () => {
  const testCase = realCase(58);
  testCase.binding.contractMutation = 'EXECUTION_CONTRACT_R0002';
  assert.ok(codes(evaluateLegacyStateBinding(testCase)).includes('LEGACY_BINDING_CLAIMS_PERMISSION'));
});

test('H5-H17: an R8 authorization attempt is refused', () => {
  const testCase = realCase(58);
  testCase.binding.r8Authorized = true;
  assert.ok(codes(evaluateLegacyStateBinding(testCase)).includes('LEGACY_BINDING_CLAIMS_PERMISSION'));
});

test('H5-H18: duplicate and conflicting bindings are refused at document level', () => {
  const doc = document();
  const duplicate = { ...doc, bindings: [...doc.bindings, structuredClone(doc.bindings[1])] };
  assert.ok(validateLegacyStateBindingsDocument(duplicate).findings.some((f) => f.code === 'LEGACY_BINDING_DUPLICATE'));

  // Two DIFFERENT ordinals claiming the same revision: one revision cannot have
  // been established twice.
  const conflicting = structuredClone(doc);
  conflicting.bindings[1].stateRevision = conflicting.bindings[0].stateRevision;
  conflicting.bindings[1].eventOrdinal = 56;
  assert.ok(validateLegacyStateBindingsDocument(conflicting).findings.some((f) => f.code === 'LEGACY_BINDING_CONFLICT'));
});

test('H5-H19: a binding whose event does not exist in the ledger is refused', () => {
  const testCase = realCase(58);
  testCase.evidence.event = null;
  const result = evaluateLegacyStateBinding(testCase);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('LEGACY_BINDING_EVENT_NOT_FOUND'));
});

test('H5-H20: a binding whose seal is absent is refused', () => {
  const testCase = realCase(58);
  testCase.evidence.seal = null;
  const result = evaluateLegacyStateBinding(testCase);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('LEGACY_BINDING_SEAL_NOT_FOUND'));
});

test('H5-H21: a binding disagreeing with its predecessor binding is refused', () => {
  const testCase = realCase(58);
  testCase.evidence.predecessorSealSha256 = 'e'.repeat(64);
  assert.ok(codes(evaluateLegacyStateBinding(testCase)).includes('LEGACY_BINDING_PREDECESSOR_DISAGREEMENT'));
});
