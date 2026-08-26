/**
 * Tests for FINAL_GATE_INTEGRITY_AUDITOR.
 *
 * An auditor that only ever says PASS is worthless, and an auditor that says
 * PASS because it read someone else's PASS is worse than worthless. So these
 * tests are built in two halves:
 *
 *   1. THE READ-ONLY BENCHMARK. GATE17 is closed, confirmed, and was audited by
 *      hand. The auditor must reach PASS on it from the current repository bytes
 *      alone, and must independently establish the invariants that audit
 *      established — not merely fail to find anything.
 *
 *   2. THE DETECTION HALF. For every family the auditor claims to cover, a
 *      scratch copy is damaged in that specific way and the auditor must report
 *      it, with the right defectClass, on the right path. A check that cannot be
 *      made to fail has not been shown to run.
 *
 * The real repository is read and never mutated. Every hostile fixture is a full
 * copy under the OS temp directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDITOR_DOCUMENT, CHECK_FAMILIES, actualIdentity, auditFinalGateIntegrity, loadAuthorityMigrations
} from '../tools/final-gate-integrity-auditor.mjs';
import { sha256Bytes, sha256Canonical, canonicalize } from '../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';

/**
 * The ledger length at the instant GATE17's EXTERNAL_CONFIRMATION closed it.
 *
 * It is a FLOOR, never an equality. The ledger is append-only, so every Gate
 * that runs afterwards lengthens it; asserting the exact number turned "GATE17's
 * history is intact" into "nothing has happened since GATE17", which stopped
 * being true the moment GATE19 ran and took the assertion down with it.
 */
const GATE17_CLOSURE_EVENT_COUNT = 73;

function scratchRoot(label) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `final-audit-${label}-`));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}
function discard(root) { fs.rmSync(root, { recursive: true, force: true }); }
function readText(root, relative) { return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'); }
function writeText(root, relative, text) { fs.writeFileSync(path.join(root, ...relative.split('/')), text); }
function readJson(root, relative) { return JSON.parse(readText(root, relative)); }
function writeJson(root, relative, value) { writeText(root, relative, `${JSON.stringify(value, null, 2)}\n`); }

/** Rewrites one ledger line and repairs nothing, which is the point. */
function corruptLedgerEvent(root, eventId, mutate) {
  const lines = readText(root, LEDGER).split('\n').filter(Boolean);
  const index = lines.findIndex((line) => JSON.parse(line).eventId === eventId);
  assert.notEqual(index, -1, `fixture needs event ${eventId}`);
  const event = JSON.parse(lines[index]);
  mutate(event);
  lines[index] = canonicalize(event);
  writeText(root, LEDGER, `${lines.join('\n')}\n`);
  return index + 1;
}

function audit(root, overrides = {}) {
  return auditFinalGateIntegrity({ root, gateId: 'GATE17', expectNotStartedFrom: 'GATE18', ...overrides });
}

function classes(report) { return report.findings.map((finding) => finding.defectClass); }

/* =========================================================================
 * 1. The read-only benchmark
 * ====================================================================== */

test('GATE17 read-only benchmark: the auditor reaches PASS from the real repository bytes', () => {
  const report = audit(REPO_ROOT);
  assert.equal(report.document, AUDITOR_DOCUMENT);
  assert.equal(report.FINAL_GATE_INTEGRITY, 'PASS', JSON.stringify(report.findings, null, 1));
  assert.equal(report.findingCount, 0);
  // Every family must have RUN. A PASS with a family missing is a PASS about
  // less than it claims.
  assert.deepEqual(report.familiesRun, [...CHECK_FAMILIES]);
  assert.deepEqual(report.familiesNotRun, []);
});

test('GATE16 also reaches PASS, so the benchmark is not GATE17-shaped', () => {
  const report = auditFinalGateIntegrity({ root: REPO_ROOT, gateId: 'GATE16', expectNotStartedFrom: 'GATE18' });
  assert.equal(report.FINAL_GATE_INTEGRITY, 'PASS', JSON.stringify(report.findings, null, 1));
});

test('the benchmark independently establishes GATE17 lifecycle facts, not just absence of findings', () => {
  const { observations } = audit(REPO_ROOT);
  assert.equal(observations.lifecycle.derivedStatus, 'COMPLETE_CONFIRMED');
  // Exactly one of each mechanical transition; the whole normal lifecycle, once.
  assert.deepEqual(observations.lifecycle.transitionCounts, {
    GENESIS_IMPORT: 1, AUTHORIZATION: 1, START: 1, AGENT_CLOSURE: 1, EXTERNAL_CONFIRMATION: 1
  });
  assert.equal(observations.state.currentStateRevision, 'R0004');
  assert.deepEqual(observations.state.revisions, ['R0001', 'R0002', 'R0003', 'R0004']);
  assert.equal(observations.state.revisionValidatorValid, true);
  // GATE17's own lifecycle is frozen, so it is pinned above. The LEDGER is not:
  // it is append-only and every later Gate lengthens it, so a literal count here
  // asserted that no Gate had run since GATE17 rather than anything about GATE17.
  // What the auditor must still establish is that GATE17's history sits intact
  // inside whatever the ledger has become.
  assert.ok(observations.ledger.eventCount >= GATE17_CLOSURE_EVENT_COUNT,
    'append-only history may grow, never shrink');
});

test('the benchmark verifies real sealed-member bytes rather than counting declarations', () => {
  const { observations } = audit(REPO_ROOT);
  const allMembers = observations.state.seals.flatMap((seal) => seal.members);
  assert.ok(allMembers.length >= 15, 'GATE17 seals should bind a substantial member set');
  for (const member of allMembers) {
    if (member.historicalProjection) continue;
    assert.equal(member.matches, true, `${member.path} must still hold its sealed bytes`);
    // The comparison must have been made against something real.
    assert.match(member.actualSha256, /^[a-f0-9]{64}$/);
    assert.equal(member.actualSha256, member.sealedSha256);
    assert.equal(member.actualByteLength, member.sealedByteLength);
  }
});

test('the benchmark reconstructs historical ledger prefixes inside the current longer ledger', () => {
  const { observations } = audit(REPO_ROOT);
  assert.ok(observations.ledger.prefixProbes.length >= 3);
  for (const probe of observations.ledger.prefixProbes) {
    assert.equal(probe.agrees, true, `prefix through ordinal ${probe.throughOrdinal} must reconstruct`);
  }
});

test('the benchmark proves the global boundaries the mission depends on', () => {
  const { observations } = audit(REPO_ROOT);
  assert.equal(observations.globalBoundaries.r8Present, false);
  assert.deepEqual(observations.globalBoundaries.successorViolations, []);
  for (let gate = 18; gate <= 40; gate += 1) {
    assert.equal(observations.globalBoundaries.statusByGate[`GATE${gate}`], 'NOT_STARTED');
  }
  assert.equal(observations.globalBoundaries.statusByGate.GATE16, 'COMPLETE_CONFIRMED');
  assert.equal(observations.globalBoundaries.statusByGate.GATE17, 'COMPLETE_CONFIRMED');
});

test('a migrated historical authority is resolved through its snapshot, and the snapshot is verified', () => {
  const { observations } = audit(REPO_ROOT);
  const migrated = observations.authority.filter((entry) => entry.kind === 'MIGRATED_HISTORICAL_AUTHORITY');
  assert.equal(migrated.length, 1, 'GATE17 genesis cites the retired registry bytes');
  assert.equal(migrated[0].matches, true);
  assert.equal(migrated[0].snapshotPath, 'governance/authority/snapshots/GATE_REGISTRY_00_40.GENESIS_R1_SNAPSHOT.json');

  // The resolution is real: the snapshot holds the cited bytes and the LIVE file
  // no longer does, which is exactly why the migration exists.
  const migrations = loadAuthorityMigrations(REPO_ROOT);
  const record = migrations.get(`governance/GATE_REGISTRY_00_40.json|${migrated[0].actualSha256}`);
  assert.ok(record, 'a migration record must retire those exact bytes');
  assert.equal(actualIdentity(REPO_ROOT, record.snapshotPath).sha256, record.originalAuthoritySha256);
  assert.notEqual(actualIdentity(REPO_ROOT, 'governance/GATE_REGISTRY_00_40.json').sha256, record.originalAuthoritySha256);
});

/* =========================================================================
 * 2. The detection half — every family must be provably able to fail
 * ====================================================================== */

test('LEDGER: a broken previousEventSha256 chain link is detected', () => {
  const root = scratchRoot('chain');
  try {
    corruptLedgerEvent(root, 'GATE17_AGENT_CLOSURE_R1', (event) => {
      event.previousEventSha256 = 'a'.repeat(64);
      const payload = { ...event }; delete payload.eventPayloadSha256;
      event.eventPayloadSha256 = sha256Canonical(payload);
    });
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('LEDGER_CHAIN_BREAK'));
  } finally { discard(root); }
});

test('LEDGER: an event payload digest that was not recomputed is detected', () => {
  const root = scratchRoot('payload');
  try {
    corruptLedgerEvent(root, 'GATE17_START_R1', (event) => { event.recordedAt = '2026-08-14T19:01:00.000Z'; });
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('LEDGER_EVENT_PAYLOAD_HASH_MISMATCH'));
  } finally { discard(root); }
});

test('LEDGER: non-canonical event bytes are detected even though the JSON still parses', () => {
  const root = scratchRoot('noncanonical');
  try {
    const lines = readText(root, LEDGER).split('\n').filter(Boolean);
    const index = lines.findIndex((line) => JSON.parse(line).eventId === 'GATE17_START_R1');
    // Re-serialize with a different key order: same object, different bytes.
    const event = JSON.parse(lines[index]);
    lines[index] = JSON.stringify({ eventPayloadSha256: event.eventPayloadSha256, ...event });
    writeText(root, LEDGER, `${lines.join('\n')}\n`);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('LEDGER_EVENT_NOT_CANONICAL'));
  } finally { discard(root); }
});

test('STATE: a sealed member whose bytes changed after sealing is detected', () => {
  const root = scratchRoot('sealed-bytes');
  try {
    const target = 'governance/gates/GATE17/evidence/CLOSURE_MATRIX.json';
    const document = readJson(root, target);
    document.injectedByHostileFixture = true;
    writeJson(root, target, document);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('SEALED_MEMBER_BYTES_CHANGED'));
    const finding = report.findings.find((item) => item.defectClass === 'SEALED_MEMBER_BYTES_CHANGED');
    assert.equal(finding.path, target);
    assert.equal(finding.expected.sha256, actualIdentity(REPO_ROOT, target).sha256);
    assert.notEqual(finding.actual.sha256, finding.expected.sha256);
  } finally { discard(root); }
});

test('STATE: a sealed member that was deleted is detected', () => {
  const root = scratchRoot('sealed-absent');
  try {
    fs.rmSync(path.join(root, 'governance/gates/GATE17/evidence/GENERATED_REPORT_EVIDENCE.json'));
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('SEALED_MEMBER_ABSENT'));
  } finally { discard(root); }
});

test('STATE: a seal payload digest that no longer matches its payload is detected', () => {
  const root = scratchRoot('seal-payload');
  try {
    const sealPath = 'governance/gates/GATE17/state/revisions/R0004/STATE_SEAL.json';
    const seal = readJson(root, sealPath);
    seal.payload.executionStatus = 'COMPLETE_AGENT';
    writeJson(root, sealPath, seal);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('SEAL_PAYLOAD_HASH_MISMATCH'));
  } finally { discard(root); }
});

test('STATE: a seal chain that does not link its predecessor is detected', () => {
  const root = scratchRoot('seal-chain');
  try {
    const sealPath = 'governance/gates/GATE17/state/revisions/R0004/STATE_SEAL.json';
    const seal = readJson(root, sealPath);
    seal.previousStateSealSha256 = 'b'.repeat(64);
    seal.payload.previousStateSealSha256 = 'b'.repeat(64);
    seal.payloadSha256 = sha256Canonical(seal.payload);
    writeJson(root, sealPath, seal);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('SEAL_CHAIN_BREAK'));
  } finally { discard(root); }
});

test('STATE: CURRENT_STATE pointing away from the ledger pin is detected', () => {
  const root = scratchRoot('current-state');
  try {
    const statePath = 'governance/gates/GATE17/state/CURRENT_STATE.json';
    const state = readJson(root, statePath);
    state.stateRevision = 'R0003';
    writeJson(root, statePath, state);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('CURRENT_STATE_DISAGREES_WITH_LEDGER_PIN'));
  } finally { discard(root); }
});

test('AUTHORITY: authority bytes that disagree with the citing event are detected', () => {
  const root = scratchRoot('authority');
  try {
    const target = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE17_AGENT_CLOSURE_R1.json';
    const document = readJson(root, target);
    document.injectedByHostileFixture = true;
    writeJson(root, target, document);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('AUTHORITY_BYTES_DISAGREE_WITH_EVENT'));
  } finally { discard(root); }
});

test('AUTHORITY: a migration whose snapshot does not hold the cited bytes is detected', () => {
  const root = scratchRoot('migration');
  try {
    const snapshot = 'governance/authority/snapshots/GATE_REGISTRY_00_40.GENESIS_R1_SNAPSHOT.json';
    const document = readJson(root, snapshot);
    document.injectedByHostileFixture = true;
    writeJson(root, snapshot, document);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('MIGRATED_AUTHORITY_SNAPSHOT_DOES_NOT_HOLD_CITED_BYTES'));
  } finally { discard(root); }
});

test('AUTHORITY: a wrong external reinspection report path or digest is detected', () => {
  const realReport = 'governance/sources/GATE17_B_INDEPENDENT_FINAL_REPLAY_EXTERNAL_CONFIRMATION_EXTERNAL_REINSPECTION_REPORT.json';
  const realSha = actualIdentity(REPO_ROOT, realReport).sha256;

  const correct = audit(REPO_ROOT, { externalReinspectionReport: { path: realReport, sha256: realSha } });
  assert.equal(correct.FINAL_GATE_INTEGRITY, 'PASS');

  const wrongSha = audit(REPO_ROOT, { externalReinspectionReport: { path: realReport, sha256: 'c'.repeat(64) } });
  assert.equal(wrongSha.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.ok(classes(wrongSha).includes('EXTERNAL_REINSPECTION_REPORT_SHA_MISMATCH'));

  const wrongPath = audit(REPO_ROOT, { externalReinspectionReport: { path: 'governance/sources/NO_SUCH_REPORT.json', sha256: realSha } });
  assert.equal(wrongPath.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.ok(classes(wrongPath).includes('EXTERNAL_REINSPECTION_REPORT_ABSENT'));
});

test('EVIDENCE: a protected hash whose target moved is detected', () => {
  const root = scratchRoot('protected');
  try {
    // R0003's checkpoint protects the R0002 seal bytes by digest.
    const target = 'governance/gates/GATE17/state/revisions/R0002/STATE_SEAL.json';
    const seal = readJson(root, target);
    seal.sealedAt = '2026-08-14T19:00:01.000Z';
    writeJson(root, target, seal);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('PROTECTED_HASH_MISMATCH'));
  } finally { discard(root); }
});

test('EVIDENCE: required evidence that does not exist is detected', () => {
  const report = audit(REPO_ROOT, { requiredEvidencePaths: ['governance/gates/GATE17/evidence/NOT_A_REAL_ARTIFACT.json'] });
  assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.ok(classes(report).includes('REQUIRED_EVIDENCE_ABSENT'));
});

test('EVIDENCE: real GATE17 evidence is confirmed present by its actual bytes', () => {
  const report = audit(REPO_ROOT, {
    requiredEvidencePaths: [
      'governance/gates/GATE17/evidence/CLOSURE_MATRIX.json',
      'governance/gates/GATE17/evidence/GENERATED_REPORT_EVIDENCE.json'
    ]
  });
  assert.equal(report.FINAL_GATE_INTEGRITY, 'PASS');
  for (const entry of report.observations.evidence.required) {
    assert.equal(entry.present, true);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.byteLength > 0);
  }
});

test('GENERATED: a tools/ generator drift is still classified as live projection drift', () => {
  const root = scratchRoot('tools-gen-drift');
  try {
    const reportPath = 'governance/generated/FOUNDATION_REPORT.md';
    writeText(root, reportPath, `${readText(root, reportPath)}\n<!-- hostile stale projection -->\n`);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('GENERATED_PROJECTION_DRIFT'));
    const finding = report.findings.find((item) => item.defectClass === 'GENERATED_PROJECTION_DRIFT');
    assert.equal(finding.path, 'governance/tools/generate-foundation-report.mjs');
    assert.equal(finding.affectedFrontier, 'GENERATED');
    assert.equal(finding.path.includes('GATE20'), false);
  } finally { discard(root); }
});

test('GENERATED: a gate-local implementation helper matching the generator role is not a live projection', () => {
  const root = scratchRoot('impl-helper');
  try {
    const helperPath = 'governance/gates/GATE17/implementation/not-a-live-projection-generator.mjs';
    writeText(root, helperPath, `#!/usr/bin/env node\nif (process.argv.includes('--check')) process.exit(2);\nprocess.exit(0);\n`);
    const contractPath = 'governance/gates/GATE17/contracts/EXECUTION_CONTRACT_R0001.json';
    const contract = readJson(root, contractPath);
    contract.requiredOutputs.push({
      ordinal: 99,
      path: helperPath,
      role: 'Deterministic closure verdict and freeze-manifest generator'
    });
    writeJson(root, contractPath, contract);
    const report = audit(root);
    const drift = report.findings.filter((item) => item.defectClass === 'GENERATED_PROJECTION_DRIFT');
    assert.equal(drift.some((item) => item.path === helperPath), false, JSON.stringify(drift, null, 2));
    assert.equal(drift.some((item) => (item.path ?? '').includes('GATE20')), false);
  } finally { discard(root); }
});

test('GENERATED: contractProjectionGenerators has no Gate-specific exception', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'governance', 'tools', 'final-gate-integrity-auditor.mjs'), 'utf8');
  const start = source.indexOf('function contractProjectionGenerators');
  const end = source.indexOf('function checkProjectionGenerator');
  assert.ok(start >= 0 && end > start);
  const fn = source.slice(start, end);
  assert.equal(/GATE20/.test(fn), false);
  assert.equal(/gateId\s*===\s*['"]GATE/.test(fn), false);
  assert.match(fn, /startsWith\('governance\/tools\/'\)/);
});

test('GENERATED: a stale projection is detected after a final ledger mutation', () => {
  const root = scratchRoot('generated');
  try {
    // The staleness is manufactured RELATIVE to the fixture's own ledger, so the
    // case keeps testing "the projection lags the ledger" however long the ledger
    // has grown. A literal pair only described the ledger of the day it was
    // written, and inverted into a false expectation as soon as it grew.
    const snapshotPath = 'governance/state/generated/GATE_STATUS_SNAPSHOT.json';
    const ledgerEventCount = readText(root, LEDGER).split('\n').filter(Boolean).length;
    const staleCount = ledgerEventCount - 2;
    const snapshot = readJson(root, snapshotPath);
    snapshot.ledgerEventCount = staleCount;
    writeJson(root, snapshotPath, snapshot);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('GENERATED_PROJECTION_STALE'));
    const finding = report.findings.find((item) => item.defectClass === 'GENERATED_PROJECTION_STALE');
    assert.equal(finding.expected, ledgerEventCount);
    assert.equal(finding.actual, staleCount);
  } finally { discard(root); }
});

test('GLOBAL_BOUNDARIES: a started successor gate is detected', () => {
  const root = scratchRoot('successor');
  try {
    const lines = readText(root, LEDGER).split('\n').filter(Boolean);
    const last = JSON.parse(lines.at(-1));
    const fabricated = {
      authorityPath: 'governance/GATE_REGISTRY_00_40.json',
      authoritySha256: actualIdentity(root, 'governance/GATE_REGISTRY_00_40.json').sha256,
      eventId: 'GATE18_AUTHORIZATION_FABRICATED',
      fromStatus: 'NOT_STARTED',
      gateId: 'GATE18',
      ordinal: lines.length + 1,
      previousEventSha256: last.eventPayloadSha256,
      recordedAt: '2026-08-14T23:00:00.000Z',
      schemaVersion: 1,
      stateRevision: 'R0001',
      stateRevisionSealSha256: 'd'.repeat(64),
      toStatus: 'AUTHORIZED_NOT_STARTED',
      transitionType: 'AUTHORIZATION'
    };
    fabricated.eventPayloadSha256 = sha256Canonical(fabricated);
    writeText(root, LEDGER, `${[...lines, canonicalize(fabricated)].join('\n')}\n`);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('SUCCESSOR_GATE_STARTED'));
    const finding = report.findings.find((item) => item.defectClass === 'SUCCESSOR_GATE_STARTED');
    assert.equal(finding.message, 'GATE18');
    assert.equal(finding.actual, 'AUTHORIZED_NOT_STARTED');
  } finally { discard(root); }
});

test('GLOBAL_BOUNDARIES: an introduced R8 is detected', () => {
  const root = scratchRoot('r8');
  try {
    fs.mkdirSync(path.join(root, 'governance/gee-v1/r8'), { recursive: true });
    fs.writeFileSync(path.join(root, 'governance/gee-v1/r8/README.md'), 'R8\n');
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('R8_PRESENT'));
  } finally { discard(root); }
});

test('LIFECYCLE: a duplicate mechanical transition is detected', () => {
  const root = scratchRoot('duplicate');
  try {
    const lines = readText(root, LEDGER).split('\n').filter(Boolean);
    const closure = JSON.parse(lines.find((line) => JSON.parse(line).eventId === 'GATE17_AGENT_CLOSURE_R1'));
    const last = JSON.parse(lines.at(-1));
    const duplicate = {
      ...closure,
      eventId: 'GATE17_AGENT_CLOSURE_R1_DUPLICATE',
      ordinal: lines.length + 1,
      previousEventSha256: last.eventPayloadSha256,
      recordedAt: '2026-08-14T23:30:00.000Z'
    };
    delete duplicate.eventPayloadSha256;
    duplicate.eventPayloadSha256 = sha256Canonical(duplicate);
    writeText(root, LEDGER, `${[...lines, canonicalize(duplicate)].join('\n')}\n`);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('DUPLICATE_LIFECYCLE_TRANSITION'));
  } finally { discard(root); }
});

/* =========================================================================
 * 3. Independence of findings
 * ====================================================================== */

test('several unrelated defects are reported as several findings, not collapsed into one', () => {
  const root = scratchRoot('multi');
  try {
    // Three genuinely independent problems, in three different families.
    fs.mkdirSync(path.join(root, 'governance/gee-v1/r8'), { recursive: true });
    fs.writeFileSync(path.join(root, 'governance/gee-v1/r8/README.md'), 'R8\n');

    const snapshotPath = 'governance/state/generated/GATE_STATUS_SNAPSHOT.json';
    const snapshot = readJson(root, snapshotPath);
    snapshot.ledgerEventCount = 3;
    writeJson(root, snapshotPath, snapshot);

    const evidence = 'governance/gates/GATE17/evidence/CLOSURE_MATRIX.json';
    const document = readJson(root, evidence);
    document.injectedByHostileFixture = true;
    writeJson(root, evidence, document);

    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    const found = new Set(classes(report));
    assert.ok(found.has('R8_PRESENT'));
    assert.ok(found.has('GENERATED_PROJECTION_STALE'));
    assert.ok(found.has('SEALED_MEMBER_BYTES_CHANGED'));
    assert.ok(report.defectClasses.length >= 3, 'independent defects must stay independent');
    // And each carries its own path and frontier.
    for (const finding of report.findings) {
      assert.ok(CHECK_FAMILIES.includes(finding.family));
      assert.ok(typeof finding.affectedFrontier === 'string' && finding.affectedFrontier.length > 0);
    }
  } finally { discard(root); }
});

test('an invalid gate id fails closed rather than auditing nothing and passing', () => {
  const report = auditFinalGateIntegrity({ root: REPO_ROOT, gateId: 'NOT_A_GATE' });
  assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.deepEqual(report.defectClasses, ['GATE_ID_INVALID']);
});

test('the auditor writes nothing into the repository it audits', () => {
  const root = scratchRoot('readonly');
  try {
    const before = new Map();
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else before.set(full, sha256Bytes(fs.readFileSync(full)));
      }
    };
    walk(path.join(root, 'governance'));
    audit(root);
    let checked = 0;
    for (const [file, digest] of before) {
      assert.equal(fs.existsSync(file), true, `${file} must survive the audit`);
      assert.equal(sha256Bytes(fs.readFileSync(file)), digest, `${file} must not be rewritten`);
      checked += 1;
    }
    assert.ok(checked > 400, 'the whole governance tree should have been compared');
  } finally { discard(root); }
});

test('DEFERRED_CAPABILITY: GATE17 family ran with zero findings independently of global FGI verdict', () => {
  const report = audit(REPO_ROOT);
  assert.equal(report.version, 'R2');
  assert.ok(report.familiesRun.includes('DEFERRED_CAPABILITY'));
  assert.equal(report.findings.filter((item) => item.family === 'DEFERRED_CAPABILITY').length, 0);
});

test('DEFERRED_CAPABILITY: missing prospective declaration blocks', () => {
  const root = scratchRoot('dc-missing');
  try {
    const constitution = readJson(root, 'governance/PROJECT_CONSTITUTION.json');
    const rule = constitution.rules.find((entry) => entry.ruleId === 'DEFERRED_CAPABILITY_MUST_BE_DURABLY_REGISTERED');
    rule.effectiveFromGate = 'GATE17';
    writeJson(root, 'governance/PROJECT_CONSTITUTION.json', constitution);
    const report = audit(root);
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(classes(report).includes('DEFERRED_CAPABILITY_DECLARATION_MISSING'));
  } finally { discard(root); }
});

test('DEFERRED_CAPABILITY: empty declaration passes when the rule is in force on GATE17', () => {
  const root = scratchRoot('dc-empty');
  try {
    const constitution = readJson(root, 'governance/PROJECT_CONSTITUTION.json');
    const rule = constitution.rules.find((entry) => entry.ruleId === 'DEFERRED_CAPABILITY_MUST_BE_DURABLY_REGISTERED');
    rule.effectiveFromGate = 'GATE17';
    writeJson(root, 'governance/PROJECT_CONSTITUTION.json', constitution);
    writeJson(root, 'governance/gates/GATE17/state/revisions/R0004/DEFERRED_CAPABILITY_DECLARATION.json', {
      deferredCapabilitiesIntroduced: []
    });
    const report = audit(root);
    assert.ok(report.familiesRun.includes('DEFERRED_CAPABILITY'));
    assert.equal(report.findings.filter((item) => item.family === 'DEFERRED_CAPABILITY').length, 0);
  } finally { discard(root); }
});

test('DEFERRED_CAPABILITY: FGI remains read-only against registry and ledger bytes', () => {
  const registryPath = path.join(REPO_ROOT, 'governance/master-matrix/DEFERRED_CAPABILITY_REGISTRY.ndjson');
  const ledgerPath = path.join(REPO_ROOT, LEDGER);
  const beforeRegistry = sha256Bytes(fs.readFileSync(registryPath));
  const beforeLedger = sha256Bytes(fs.readFileSync(ledgerPath));
  audit(REPO_ROOT);
  assert.equal(sha256Bytes(fs.readFileSync(registryPath)), beforeRegistry);
  assert.equal(sha256Bytes(fs.readFileSync(ledgerPath)), beforeLedger);
});

