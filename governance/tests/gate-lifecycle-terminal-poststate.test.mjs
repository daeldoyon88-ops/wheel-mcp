/**
 * Focused tests for the GATE_LIFECYCLE_TERMINAL_POSTSTATE_REPAIR_R1 behaviour of
 * GATE_LIFECYCLE_ORCHESTRATOR.
 *
 * Two defects are pinned here, each written against its failure mode:
 *
 *   - a CLOSURE-RELEVANT transition (COMPLETE_AGENT / COMPLETE_CONFIRMED at or
 *     above the rule's effectiveFromGate) must mint the new revision's
 *     DEFERRED_CAPABILITY_DECLARATION.json inside the same transaction, from an
 *     explicit declaration or the predecessor's, and must block rather than
 *     invent one;
 *   - a non-closure transition called without a checkpoint (the CLI path) must
 *     carry its predecessor's completed tasks and protected hashes forward and
 *     record its own lifecycle task, instead of resetting them — while never
 *     consuming an unrelated required next action on the caller's behalf.
 *
 * Fixtures are synthetic Gates under the OS temp directory; the constitution
 * rule and the deferred-capability registry are the REAL canonical bytes, so
 * applicability and registry resolution are the law's own answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_PATH, applyCandidate, deriveCandidateTransition, governedBytes, validateCandidateInStagingRoot
} from '../tools/gate-lifecycle-orchestrator.mjs';
import { sha256Bytes } from '../tools/canonical-json.mjs';
import { validateStateRevision } from '../tools/validate-state-revision.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANONICAL_INPUTS = [
  'governance/PROJECT_CONSTITUTION.json',
  'governance/master-matrix/DEFERRED_CAPABILITY_REGISTRY.ndjson',
  'governance/master-matrix/DEFERRED_CAPABILITY_REASON_VOCABULARY_V1.json',
  'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_DEFERRED_CAPABILITY_REGISTRY_STEP3_COMBINED_R1.json'
];
const AUTHORITY_PATH = 'governance/sources/FIXTURE_TERMINAL_POSTSTATE_AUTHORITY.json';
const RECORDED_AT = '2026-09-28T12:00:00.000Z';
const DECLARATION = 'DEFERRED_CAPABILITY_DECLARATION.json';

function writeJson(root, relative, value) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRaw(root, relative, text) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function exists(root, relative) { return fs.existsSync(path.join(root, ...relative.split('/'))); }
function discard(root) { fs.rmSync(root, { recursive: true, force: true }); }

/**
 * A Gate sitting at `fromStatus` on revision R0001, one ledger event deep.
 * `previousDeclaration`: an object (written as JSON), a string (raw bytes), or
 * null (absent). `previousCheckpoint`: an object, a string (raw bytes), or null.
 */
function terminalFixture({
  gateId = 'GATE30',
  fromStatus = 'COMPLETE_AGENT',
  previousCheckpoint = {
    completedTasks: [`${gateId}_BUILD`, `${gateId}_AGENT_CLOSURE`],
    openTasks: [`${gateId}_EXTERNAL_CONFIRMATION`],
    requiredNextActions: [`${gateId}_EXTERNAL_CONFIRMATION`],
    protectedHashes: [{ path: 'governance/sources/FIXTURE_PROTECTED.json', sha256: 'a'.repeat(64) }]
  },
  previousDeclaration = { deferredCapabilitiesIntroduced: [] }
} = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-terminal-'));
  for (const relative of CANONICAL_INPUTS) {
    fs.mkdirSync(path.dirname(path.join(root, ...relative.split('/'))), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, ...relative.split('/')), path.join(root, ...relative.split('/')));
  }
  const revision = `governance/gates/${gateId}/state/revisions/R0001`;
  writeJson(root, AUTHORITY_PATH, { fixture: 'terminal-poststate' });
  writeJson(root, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`, { contractSha256: 'c'.repeat(64) });
  writeJson(root, `${revision}/STATE_SEAL.json`, { gateId, stateRevision: 'R0001' });
  if (typeof previousCheckpoint === 'string') writeRaw(root, `${revision}/CHECKPOINT.json`, previousCheckpoint);
  else if (previousCheckpoint) writeJson(root, `${revision}/CHECKPOINT.json`, { gateId, stateRevision: 'R0001', ...previousCheckpoint });
  if (typeof previousDeclaration === 'string') writeRaw(root, `${revision}/${DECLARATION}`, previousDeclaration);
  else if (previousDeclaration) writeJson(root, `${revision}/${DECLARATION}`, previousDeclaration);
  writeJson(root, `governance/gates/${gateId}/state/CURRENT_STATE.json`, {
    schemaVersion: 1, gateId, stateRevision: 'R0001', revisionPath: revision, stateSealSha256: 'b'.repeat(64)
  });
  writeRaw(root, LEDGER_PATH, `${JSON.stringify({
    eventId: `${gateId}_FIXTURE_PRIOR`, gateId, toStatus: fromStatus, transitionType: 'AGENT_CLOSURE',
    stateRevision: 'R0001', eventPayloadSha256: 'd'.repeat(64)
  })}\n`);
  return root;
}

function confirm(root, extra = {}, gateId = 'GATE30') {
  return deriveCandidateTransition({
    root, gateId, transitionType: 'EXTERNAL_CONFIRMATION', eventId: `${gateId}_FIXTURE_EXTERNAL_CONFIRMATION`,
    authorityPath: AUTHORITY_PATH, recordedAt: RECORDED_AT, ...extra
  });
}

function writeFor(candidate, relative) { return candidate.writes.find((write) => write.path === relative) ?? null; }

/* -------------------------------------------------------------------------
 * Completed-task and protected-hash carry-forward
 * ---------------------------------------------------------------------- */

test('CLI-shaped EXTERNAL_CONFIRMATION carries predecessor task history and records its own task', () => {
  const root = terminalFixture();
  try {
    const derived = confirm(root);
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    assert.deepEqual(derived.candidate.checkpointDocument.completedTasks,
      ['GATE30_BUILD', 'GATE30_AGENT_CLOSURE', 'GATE30_EXTERNAL_CONFIRMATION']);
    assert.deepEqual(derived.candidate.checkpointDocument.protectedHashes,
      [{ path: 'governance/sources/FIXTURE_PROTECTED.json', sha256: 'a'.repeat(64) }]);
  } finally { discard(root); }
});

test('the carried checkpoint consumes the prior resume contract: no RESTART_FROM_ZERO_DETECTED', () => {
  const root = terminalFixture();
  try {
    const derived = confirm(root);
    for (const write of derived.candidate.writes) writeRaw(root, write.path, write.bytes);
    const report = validateStateRevision({
      root, gateId: 'GATE30',
      currentStatePath: path.join(root, 'governance/gates/GATE30/state/CURRENT_STATE.json'),
      contractPath: path.join(root, 'governance/gates/GATE30/contracts/CURRENT_CONTRACT.json')
    });
    assert.equal((report.findings || []).filter((item) => item.detectorId === 'RESTART_FROM_ZERO_DETECTED').length, 0);
  } finally { discard(root); }
});

test('an unrelated required next action is never consumed on the caller\'s behalf and still fails closed', () => {
  const root = terminalFixture({
    previousCheckpoint: { completedTasks: ['GATE30_BUILD'], requiredNextActions: ['GATE30_EXTERNAL_CONFIRMATION', 'GATE30_UNRELATED_ACTION'] }
  });
  try {
    const derived = confirm(root);
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    assert.deepEqual(derived.candidate.checkpointDocument.completedTasks, ['GATE30_BUILD', 'GATE30_EXTERNAL_CONFIRMATION']);
    for (const write of derived.candidate.writes) writeRaw(root, write.path, write.bytes);
    const report = validateStateRevision({
      root, gateId: 'GATE30',
      currentStatePath: path.join(root, 'governance/gates/GATE30/state/CURRENT_STATE.json'),
      contractPath: path.join(root, 'governance/gates/GATE30/contracts/CURRENT_CONTRACT.json')
    });
    const restarts = (report.findings || []).filter((item) => item.detectorId === 'RESTART_FROM_ZERO_DETECTED');
    assert.equal(restarts.length, 1);
    assert.ok(JSON.stringify(restarts[0]).includes('GATE30_UNRELATED_ACTION'));
  } finally { discard(root); }
});

test('explicit caller completedTasks and protectedHashes are taken verbatim', () => {
  const root = terminalFixture();
  try {
    const derived = confirm(root, { checkpoint: { completedTasks: ['ONLY_THIS'], protectedHashes: [] } });
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    assert.deepEqual(derived.candidate.checkpointDocument.completedTasks, ['ONLY_THIS']);
    assert.deepEqual(derived.candidate.checkpointDocument.protectedHashes, []);
  } finally { discard(root); }
});

test('an unreadable predecessor checkpoint blocks an inheriting transition instead of resetting history', () => {
  for (const previousCheckpoint of [null, '{ not json']) {
    const root = terminalFixture({ previousCheckpoint });
    try {
      const derived = confirm(root);
      assert.equal(derived.status, 'BLOCKED');
      assert.deepEqual(derived.findings.map((item) => item.defectClass), ['PREVIOUS_CHECKPOINT_UNREADABLE']);
      const explicit = confirm(root, { checkpoint: { completedTasks: ['X'], protectedHashes: [] } });
      assert.equal(explicit.status, 'DERIVED', JSON.stringify(explicit.findings));
    } finally { discard(root); }
  }
});

/* -------------------------------------------------------------------------
 * Terminal-revision deferred-capability declaration
 * ---------------------------------------------------------------------- */

test('COMPLETE_CONFIRMED mints the declaration inside the new revision, in the same candidate', () => {
  const root = terminalFixture({ previousDeclaration: { deferredCapabilitiesIntroduced: ['GATE24-DC-01'] } });
  try {
    const derived = confirm(root);
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    const relative = `governance/gates/GATE30/state/revisions/R0002/${DECLARATION}`;
    assert.equal(derived.candidate.paths.deferredCapabilityDeclaration, relative);
    assert.ok(relative.startsWith(`${derived.candidate.paths.revisionDirectory}/`));
    const write = writeFor(derived.candidate, relative);
    assert.ok(write, 'declaration is one of the candidate writes');
    assert.deepEqual(write.bytes, governedBytes({ deferredCapabilitiesIntroduced: ['GATE24-DC-01'] }));
    assert.equal(write.sha256, sha256Bytes(write.bytes));
    assert.deepEqual(derived.candidate.deferredCapabilityDeclarationDocument, { deferredCapabilitiesIntroduced: ['GATE24-DC-01'] });
  } finally { discard(root); }
});

test('an explicit declaration takes precedence over the predecessor\'s', () => {
  const root = terminalFixture();
  try {
    const derived = confirm(root, { deferredCapabilityDeclaration: { deferredCapabilitiesIntroduced: ['GATE30-DC-01'] } });
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    assert.deepEqual(derived.candidate.deferredCapabilityDeclarationDocument, { deferredCapabilitiesIntroduced: ['GATE30-DC-01'] });
  } finally { discard(root); }
});

test('with neither an explicit nor a predecessor declaration the transition blocks and invents nothing', () => {
  const root = terminalFixture({ previousDeclaration: null });
  try {
    const derived = confirm(root);
    assert.equal(derived.status, 'BLOCKED');
    assert.equal(derived.candidate, null);
    assert.deepEqual(derived.findings.map((item) => item.defectClass), ['DEFERRED_CAPABILITY_DECLARATION_UNRESOLVABLE']);
  } finally { discard(root); }
});

test('a malformed predecessor or explicit declaration blocks', () => {
  const malformedPredecessors = ['{ not json', JSON.stringify({ deferredCapabilitiesIntroduced: [], extra: true }), JSON.stringify({ deferredCapabilitiesIntroduced: 'x' })];
  for (const previousDeclaration of malformedPredecessors) {
    const root = terminalFixture({ previousDeclaration });
    try {
      const derived = confirm(root);
      assert.equal(derived.status, 'BLOCKED', previousDeclaration);
      assert.deepEqual(derived.findings.map((item) => item.defectClass), ['DEFERRED_CAPABILITY_DECLARATION_MALFORMED']);
    } finally { discard(root); }
  }
  const malformedExplicit = [
    { deferredCapabilitiesIntroduced: ['not-an-id'] },
    { deferredCapabilitiesIntroduced: ['GATE30-DC-01', 'GATE30-DC-01'] },
    { deferredCapabilitiesIntroduced: [], smuggled: [] },
    []
  ];
  for (const deferredCapabilityDeclaration of malformedExplicit) {
    const root = terminalFixture();
    try {
      const derived = confirm(root, { deferredCapabilityDeclaration });
      assert.equal(derived.status, 'BLOCKED', JSON.stringify(deferredCapabilityDeclaration));
      assert.deepEqual(derived.findings.map((item) => item.defectClass), ['DEFERRED_CAPABILITY_DECLARATION_MALFORMED']);
    } finally { discard(root); }
  }
});

test('below the rule\'s effectiveFromGate no declaration is written', () => {
  const root = terminalFixture({ gateId: 'GATE17', previousDeclaration: null });
  try {
    const derived = confirm(root, {}, 'GATE17');
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    assert.equal(derived.candidate.paths.deferredCapabilityDeclaration, null);
    assert.equal(derived.candidate.writes.some((write) => write.path.endsWith(`/${DECLARATION}`)), false);
  } finally { discard(root); }
});

test('a non-closure target status writes no declaration', () => {
  const root = terminalFixture({ fromStatus: 'AUTHORIZED_NOT_STARTED', previousDeclaration: null });
  try {
    const derived = deriveCandidateTransition({
      root, gateId: 'GATE30', transitionType: 'START', eventId: 'GATE30_FIXTURE_START',
      authorityPath: AUTHORITY_PATH, recordedAt: RECORDED_AT
    });
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    assert.equal(derived.candidate.paths.deferredCapabilityDeclaration, null);
    assert.ok(derived.candidate.checkpointDocument.completedTasks.includes('GATE30_START'));
  } finally { discard(root); }
});

test('staged validation judges the minted declaration with the FGI evaluator and fails closed', () => {
  const baseline = { ledgerFindingKeys: new Set(), sealValidity: new Map(), ledgerFindingCount: 0 };
  const cases = [
    { declaration: null, expected: [] },
    { declaration: { deferredCapabilitiesIntroduced: ['GATE30-DC-99'] }, expected: ['DEFERRED_CAPABILITY_REFERENCE_UNRESOLVED'] },
    { declaration: { deferredCapabilitiesIntroduced: ['GATE24-DC-01'] }, expected: ['DEFERRED_CAPABILITY_NOT_DURABLY_REGISTERED'] }
  ];
  for (const { declaration, expected } of cases) {
    const root = terminalFixture();
    const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-terminal-stage-'));
    try {
      const derived = confirm(root, declaration ? { deferredCapabilityDeclaration: declaration } : {});
      assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
      const validation = validateCandidateInStagingRoot({ root, candidate: derived.candidate, stagingRoot: staging, baseline });
      const observed = validation.findings
        .filter((item) => item.defectClass === 'CANDIDATE_DEFERRED_CAPABILITY_DECLARATION_INVALID')
        .map((item) => item.detectorId);
      assert.deepEqual(observed, expected, JSON.stringify(declaration));
      assert.equal(validation.reports.deferredCapabilityDeclaration.applicable, true);
    } finally { discard(root); discard(staging); }
  }
});

test('a failed apply rolls the minted declaration back with the rest of the revision', () => {
  const root = terminalFixture();
  try {
    const derived = confirm(root);
    const ledgerBefore = sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/'))));
    const failAt = derived.candidate.writes.length;
    let writes = 0;
    assert.throws(() => applyCandidate({
      root, candidate: derived.candidate, requireRecoverableProvenance: false,
      writeFile(target, bytes) {
        writes += 1;
        if (writes === failAt) throw new Error('INJECTED_FINAL_WRITE');
        fs.writeFileSync(target, bytes);
      }
    }), (error) => error.recovered === true);
    assert.ok(writes >= failAt);
    assert.equal(exists(root, derived.candidate.paths.revisionDirectory), false);
    assert.equal(exists(root, derived.candidate.paths.deferredCapabilityDeclaration), false);
    assert.equal(sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))), ledgerBefore);
  } finally { discard(root); }
});
