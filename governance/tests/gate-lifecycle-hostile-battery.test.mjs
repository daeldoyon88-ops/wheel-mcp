/**
 * HOSTILE REGRESSION BATTERY H1-H14.
 *
 * Every case here reproduces a defect CLASS that actually cost time during
 * GATE16 and GATE17. The battery exists so that the next Gate cannot rediscover
 * them: each is expressed generically, against the real orchestrator and the
 * real auditor, with no Gate-specific fixture that could pass by coincidence.
 *
 * Two of the fourteen are NOT failures, and that is deliberate. H4 and H7 are
 * the false-positive traps — a legitimate successor-sealed artifact, and an
 * authorized path that happens to be byte-identical to what is already
 * committed. A battery that only proved things get blocked would encourage
 * exactly the over-blocking that made those two cases expensive in the first
 * place.
 *
 *   H1  malformed candidate ledger event      -> BLOCK BEFORE canonical write
 *   H2  wrong SHA256 or byteLength            -> BLOCK
 *   H3  mutation of a member sealed at prestate -> BLOCK
 *   H4  legitimate successor-sealed member    -> PASS
 *   H5  stale reusable evidence               -> detected, not advertised
 *   H6  stale generated report/provenance     -> detected
 *   H7  authorized path byte-identical        -> distinguished, not blocked
 *   H8  historical prestate N inside N+k      -> PASS
 *   H9  duplicate lifecycle transition        -> BLOCK or idempotent
 *   H10 wrong external report path/SHA        -> BLOCK
 *   H11 unexpected file in bounded cohort     -> BLOCK
 *   H12 failure during candidate construction -> canonical bytes unchanged
 *   H13 attempted reseal / history rewrite    -> BLOCK
 *   H14 gate-specific bypass                  -> BLOCK / test failure
 *
 * The real repository is read, never mutated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ORCHESTRATED_TRANSITIONS, deriveCandidateTransition, ledgerLineBytes,
  runLifecycleTransition, validateCandidateInStagingRoot
} from '../tools/gate-lifecycle-orchestrator.mjs';
import { auditFinalGateIntegrity, actualIdentity } from '../tools/final-gate-integrity-auditor.mjs';
import { canonicalize, sha256Bytes, sha256Canonical } from '../tools/canonical-json.mjs';
import { computeSealedMembersDigest } from '../tools/validate-state-seal.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const GATE17_CLOSURE_AUTHORITY =
  'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE17_AGENT_CLOSURE_R1.json';

function scratchRoot(label) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `hostile-${label}-`));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}
function stagingDir() { return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hostile-stage-')); }
function discard(root) { fs.rmSync(root, { recursive: true, force: true }); }
function readText(root, relative) { return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'); }
function writeText(root, relative, text) { fs.writeFileSync(path.join(root, ...relative.split('/')), text); }
function readJson(root, relative) { return JSON.parse(readText(root, relative)); }
function writeJson(root, relative, value) { writeText(root, relative, `${JSON.stringify(value, null, 2)}\n`); }
function initializeGitRepository(root) {
  const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  run(['init', '--quiet']);
  run(['add', 'governance']);
  run(['-c', 'user.name=hostile', '-c', 'user.email=hostile@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline']);
}

/** Canonical bytes of the governed spine, for before/after comparison. */
function spineDigest(root) {
  return {
    ledger: sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER.split('/')))),
    currentState: sha256Bytes(fs.readFileSync(path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json')))
  };
}

/** GATE17 rewound to the state its hand-built AGENT_CLOSURE acted on. */
function rewindGate17ToPostStart(root) {
  fs.rmSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0004'), { recursive: true, force: true });
  const lines = readText(root, LEDGER).split('\n').filter(Boolean);
  writeText(root, LEDGER, `${lines.slice(0, 71).join('\n')}\n`);
  writeJson(root, 'governance/gates/GATE17/state/CURRENT_STATE.json', {
    schemaVersion: 1, gateId: 'GATE17', stateRevision: 'R0002',
    revisionPath: 'governance/gates/GATE17/state/revisions/R0002',
    stateSealSha256: '9f9f4cf466a7b0be18919dfe72c9fb4c9babe5d9efe150c866dc7f0eab914c52',
    committedByTransactionId: 'GATE17_START_R1_TRANSACTION'
  });
}

function gate17ClosureRequest() {
  const historical = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
  return {
    gateId: 'GATE17', transitionType: 'AGENT_CLOSURE', eventId: 'GATE17_AGENT_CLOSURE_R1',
    authorityPath: GATE17_CLOSURE_AUTHORITY,
    recordedAt: '2026-08-14T19:35:00.000Z', sealedAt: '2026-08-14T19:30:00.000Z',
    sealedMemberOrder: ['CHECKPOINT', 'OPEN_DEFECTS', 'CURRENT_CONTRACT'],
    checkpoint: {
      milestone: historical.milestone, resumePoint: historical.resumePoint,
      completedTasks: historical.completedTasks, openTasks: historical.openTasks,
      reusableEvidence: historical.reusableEvidence, invalidatedEvidence: historical.invalidatedEvidence,
      requiredNextActions: historical.requiredNextActions, protectedHashes: historical.protectedHashes,
      createdAt: historical.createdAt
    }
  };
}

function auditClasses(report) { return new Set(report.findings.map((finding) => finding.defectClass)); }

/* ======================================================================
 * H1 — malformed candidate ledger event -> BLOCK BEFORE canonical write
 * =================================================================== */

test('H1: a malformed candidate ledger event is blocked before any canonical byte moves', () => {
  const root = scratchRoot('h1');
  const staging = stagingDir();
  try {
    rewindGate17ToPostStart(root);
    const before = spineDigest(root);

    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest() });
    assert.equal(derived.status, 'DERIVED');

    // Malform the event: a transitionType the canonical table does not admit
    // from this fromStatus. Only direct corruption can produce it, which is the
    // point — the deriver reads the table and cannot emit this.
    const candidate = derived.candidate;
    candidate.event.transitionType = 'SUPERSESSION';
    const payload = { ...candidate.event };
    delete payload.eventPayloadSha256;
    candidate.event.eventPayloadSha256 = sha256Canonical(payload);
    const prior = fs.readFileSync(path.join(root, ...LEDGER.split('/')));
    candidate.writes.find((write) => write.path === LEDGER).bytes =
      Buffer.concat([prior, ledgerLineBytes(candidate.event)]);

    const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
    assert.equal(validation.valid, false);
    assert.ok(validation.findings.some((finding) => finding.defectClass === 'CANDIDATE_LEDGER_INVALID'));

    // BEFORE the write, not rolled back after it.
    assert.deepEqual(spineDigest(root), before);
    assert.equal(fs.existsSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003')), false);
  } finally { discard(root); discard(staging); }
});

/* ======================================================================
 * H2 — wrong SHA256 or byteLength -> BLOCK
 * =================================================================== */

test('H2: a wrong sealed-member SHA256 or byteLength is blocked', () => {
  const root = scratchRoot('h2');
  const staging = stagingDir();
  try {
    rewindGate17ToPostStart(root);
    const before = spineDigest(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest() });
    const candidate = derived.candidate;

    // Falsify one member's digest and length, then re-seal the document around
    // the lie so only the BYTES on disk can expose it.
    const seal = candidate.seal;
    seal.sealedMembers[0].sha256 = 'e'.repeat(64);
    seal.sealedMembers[0].byteLength = 1;
    seal.payload.sealedMembersDigest = computeSealedMembersDigest(seal.sealedMembers);
    seal.payloadSha256 = sha256Canonical(seal.payload);
    const sealBytes = Buffer.from(`${JSON.stringify(seal, null, 2)}\n`, 'utf8');
    const sealWrite = candidate.writes.find((write) => write.path === candidate.paths.seal);
    sealWrite.bytes = sealBytes;
    sealWrite.sha256 = sha256Bytes(sealBytes);

    const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
    assert.equal(validation.valid, false);
    assert.ok(validation.findings.some((finding) => finding.defectClass === 'CANDIDATE_STATE_SEAL_INVALID'));
    assert.deepEqual(spineDigest(root), before);
  } finally { discard(root); discard(staging); }
});

test('H2 (audit side): a sealed member whose real bytes differ from its declared digest is FAIL', () => {
  const root = scratchRoot('h2-audit');
  try {
    const seal = readJson(root, 'governance/gates/GATE17/state/revisions/R0004/STATE_SEAL.json');
    seal.sealedMembers[1].byteLength = seal.sealedMembers[1].byteLength + 1;
    seal.payload.sealedMembersDigest = computeSealedMembersDigest(seal.sealedMembers);
    seal.payloadSha256 = sha256Canonical(seal.payload);
    writeJson(root, 'governance/gates/GATE17/state/revisions/R0004/STATE_SEAL.json', seal);
    const report = auditFinalGateIntegrity({ root, gateId: 'GATE17' });
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(auditClasses(report).has('SEALED_MEMBER_BYTES_CHANGED'));
  } finally { discard(root); }
});

/* ======================================================================
 * H3 — mutation of a member already sealed at prestate -> BLOCK
 * =================================================================== */

test('H3: rewriting a member that was already sealed before the transaction is blocked', () => {
  const root = scratchRoot('h3');
  const staging = stagingDir();
  try {
    rewindGate17ToPostStart(root);
    const before = spineDigest(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest() });
    const candidate = derived.candidate;

    // GATE16's confirmed R0004 seal binds this evidence. It existed and was
    // sealed BEFORE this transaction, so the transaction may not touch it.
    const preSealed = 'governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json';
    const sealedIdentity = actualIdentity(root, preSealed);
    assert.equal(sealedIdentity.present, true, 'fixture needs a pre-sealed GATE16 member');

    const mutatedBytes = Buffer.from(`${JSON.stringify({ ...readJson(root, preSealed), hostile: true }, null, 2)}\n`, 'utf8');
    candidate.writes.push({
      path: preSealed, sha256: sha256Bytes(mutatedBytes), byteLength: mutatedBytes.length, bytes: mutatedBytes
    });

    const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
    assert.equal(validation.valid, false);
    const finding = validation.findings.find((item) => item.defectClass === 'SEALED_MEMBER_MUTATION_AT_PRESTATE');
    assert.ok(finding, JSON.stringify(validation.findings.slice(0, 3)));
    assert.equal(finding.path, preSealed);
    assert.equal(finding.expected.sha256, sealedIdentity.sha256);
    assert.deepEqual(spineDigest(root), before);
  } finally { discard(root); discard(staging); }
});

/* ======================================================================
 * H4 — legitimate transaction-produced successor sealed member -> PASS
 * =================================================================== */

test('H4: an artifact this transaction produced, sealed only by its own successor revision, is NOT a prestate mutation', () => {
  const root = scratchRoot('h4');
  const staging = stagingDir();
  try {
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest() });
    const candidate = derived.candidate;

    // The transaction writes R0003's CHECKPOINT, OPEN_DEFECTS and STATE_SEAL,
    // and its own successor seal binds them. Under a naive "is this path in a
    // seal?" rule these look exactly like sealed-member mutations. They are not.
    const produced = [
      'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json',
      'governance/gates/GATE17/state/revisions/R0003/OPEN_DEFECTS.json',
      'governance/gates/GATE17/state/revisions/R0003/STATE_SEAL.json'
    ];
    for (const producedPath of produced) {
      assert.ok(candidate.writes.some((write) => write.path === producedPath), `${producedPath} must be a transaction product`);
    }
    const sealedByOwnSuccessor = candidate.seal.sealedMembers.map((member) => member.repoRelativePath);
    assert.ok(sealedByOwnSuccessor.includes(produced[0]));
    assert.ok(sealedByOwnSuccessor.includes(produced[1]));

    const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
    assert.equal(validation.valid, true, JSON.stringify(validation.findings.slice(0, 4)));
    assert.equal(
      validation.findings.filter((finding) => finding.defectClass === 'SEALED_MEMBER_MUTATION_AT_PRESTATE').length,
      0,
      'a successor-sealed transaction product must never be classified as a prestate mutation'
    );
  } finally { discard(root); discard(staging); }
});

/* ======================================================================
 * H5 — stale reusable evidence -> detected, not advertised as reusable
 * =================================================================== */

test('H5: evidence still advertised as reusable after its declared input changed is detected', () => {
  const root = scratchRoot('h5');
  try {
    // GATE17 R0004's checkpoint declares the external reinspection report
    // reusable, bound to its digest. Move the bytes; the claim goes stale.
    const target = 'governance/sources/GATE17_B_INDEPENDENT_FINAL_REPLAY_EXTERNAL_CONFIRMATION_EXTERNAL_REINSPECTION_REPORT.json';
    const declared = readJson(root, 'governance/gates/GATE17/state/revisions/R0004/CHECKPOINT.json')
      .reusableEvidence.find((entry) => entry.path === target);
    assert.ok(declared?.sha256, 'fixture needs a digest-bound reusable claim');

    writeJson(root, target, { ...readJson(root, target), hostileDrift: true });

    const report = auditFinalGateIntegrity({ root, gateId: 'GATE17' });
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(auditClasses(report).has('STALE_EVIDENCE_ADVERTISED_AS_REUSABLE'));
    const stale = report.observations.evidence.staleReuseClaims.find((claim) => claim.path === target);
    assert.ok(stale, 'the stale claim must be reported, not silently dropped');
    assert.equal(stale.declared, declared.sha256);
    assert.notEqual(stale.actual, declared.sha256);
  } finally { discard(root); }
});

test('H5 (mirror): historical evidence marked invalidated must not be rewritten just because it went stale', () => {
  const root = scratchRoot('h5-mirror');
  try {
    // R0004 records GENERATED_REPORT_EVIDENCE as invalidated-but-preserved,
    // pinned to its exact bytes. Rewriting it is the failure mode.
    const target = 'governance/gates/GATE17/evidence/GENERATED_REPORT_EVIDENCE.json';
    const invalidated = readJson(root, 'governance/gates/GATE17/state/revisions/R0004/CHECKPOINT.json')
      .invalidatedEvidence.find((entry) => entry.path === target);
    assert.ok(invalidated?.sha256, 'fixture needs a digest-bound invalidated claim');

    writeJson(root, target, { ...readJson(root, target), rewrittenBecauseStale: true });

    const report = auditFinalGateIntegrity({ root, gateId: 'GATE17' });
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(auditClasses(report).has('HISTORICAL_EVIDENCE_REWRITTEN_AFTER_INVALIDATION'));
  } finally { discard(root); }
});

/* ======================================================================
 * H6 — generated report/provenance stale after final ledger mutation
 * =================================================================== */

test('H6: a generated projection left stale after the final ledger mutation is detected', () => {
  const root = scratchRoot('h6');
  try {
    const reportPath = 'governance/generated/FOUNDATION_REPORT.md';
    writeText(root, reportPath, `${readText(root, reportPath)}\n<!-- hostile stale projection -->\n`);

    const report = auditFinalGateIntegrity({ root, gateId: 'GATE17' });
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    assert.ok(auditClasses(report).has('GENERATED_PROJECTION_DRIFT'));
    const finding = report.findings.find((item) => item.defectClass === 'GENERATED_PROJECTION_DRIFT');
    assert.equal(finding.path, 'governance/tools/generate-foundation-report.mjs');
    assert.equal(finding.affectedFrontier, 'GENERATED');
  } finally { discard(root); }
});

/* ======================================================================
 * H7 — authorized path byte-identical -> distinguished, not falsely blocked
 * =================================================================== */

test('H7: an authorized path that is byte-identical to HEAD produces no Git delta and is NOT blocked', () => {
  // This is the false-positive trap. The authorized cohort legitimately exceeds
  // the Git delta when a path was authorized but ended up unchanged, and
  // treating count inequality as tampering is what made this expensive before.
  const unchangedButAuthorized = [
    'governance/gates/GATE17/evidence/CLOSURE_MATRIX.json',
    'governance/gates/GATE17/state/revisions/R0004/STATE_SEAL.json'
  ];
  const root = scratchRoot('h7');
  try {
    initializeGitRepository(root);
    const report = auditFinalGateIntegrity({ root, gateId: 'GATE17', authorizedCohort: unchangedButAuthorized });
    assert.equal(report.FINAL_GATE_INTEGRITY, 'PASS', JSON.stringify(report.findings, null, 1));
    assert.deepEqual([...report.observations.git.byteIdenticalAuthorized].sort(), [...unchangedButAuthorized].sort());
    assert.equal(report.observations.git.authorizedCount, 2);
    // Each is reported with a real identity, so "byte-identical" is a measured
    // claim rather than an excuse.
    for (const identity of report.observations.git.cohortIdentities) {
      assert.equal(identity.present, true);
      assert.match(identity.sha256, /^[a-f0-9]{64}$/);
    }
  } finally { discard(root); }
});

test('H7 (contrast): an authorized path that does not exist at all IS blocked', () => {
  const report = auditFinalGateIntegrity({
    root: REPO_ROOT, gateId: 'GATE17', authorizedCohort: ['governance/gates/GATE17/evidence/NEVER_WRITTEN.json']
  });
  assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.ok(auditClasses(report).has('AUTHORIZED_PATH_ABSENT'));
});

/* ======================================================================
 * H8 — historical prestate N inside future/current N+k -> PASS
 * =================================================================== */

test('H8: every historical ledger prefix still reconstructs inside the current longer ledger', () => {
  const report = auditFinalGateIntegrity({ root: REPO_ROOT, gateId: 'GATE17' });
  assert.equal(report.FINAL_GATE_INTEGRITY, 'PASS');
  const probes = report.observations.ledger.prefixProbes;
  assert.ok(probes.length >= 3, 'more than one prefix must be probed');
  for (const probe of probes) {
    assert.equal(probe.agrees, true, `historical prefix through ${probe.throughOrdinal} must survive inside N+k`);
    assert.match(probe.sha256, /^[a-f0-9]{64}$/);
  }
  // The oldest prefix and the whole ledger are both covered, so this is not a
  // probe of the tail only.
  assert.equal(probes.at(0).throughOrdinal, 1);
  assert.equal(probes.at(-1).throughOrdinal, report.observations.ledger.eventCount);
});

test('H8 (contrast): a rewritten historical event breaks prefix reconstruction and is detected', () => {
  const root = scratchRoot('h8-contrast');
  try {
    const lines = readText(root, LEDGER).split('\n').filter(Boolean);
    const index = lines.findIndex((line) => JSON.parse(line).eventId === 'GATE16_AGENT_CLOSURE_R1');
    const event = JSON.parse(lines[index]);
    event.recordedAt = '2026-08-14T15:02:21.000Z';
    lines[index] = canonicalize(event);
    writeText(root, LEDGER, `${lines.join('\n')}\n`);

    const report = auditFinalGateIntegrity({ root, gateId: 'GATE17' });
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    // The rewrite is caught by the payload digest and by the forward chain.
    const found = auditClasses(report);
    assert.ok(found.has('LEDGER_EVENT_PAYLOAD_HASH_MISMATCH') || found.has('LEDGER_CHAIN_BREAK'));
  } finally { discard(root); }
});

/* ======================================================================
 * H9 — duplicate lifecycle transition -> BLOCK or idempotent
 * =================================================================== */

test('H9: every duplicate lifecycle transition attempt is either idempotent or blocked, never appended', () => {
  const root = scratchRoot('h9');
  const staging = stagingDir();
  try {
    const before = spineDigest(root);
    const eventsBefore = readText(root, LEDGER).split('\n').filter(Boolean).length;

    // Identical re-request of each already-recorded transition -> idempotent.
    const recorded = [
      { gateId: 'GATE17', transitionType: 'AGENT_CLOSURE', eventId: 'GATE17_AGENT_CLOSURE_R1', authorityPath: GATE17_CLOSURE_AUTHORITY },
      { gateId: 'GATE17', transitionType: 'START', eventId: 'GATE17_START_R1', authorityPath: 'governance/authority/authorizations/GATE17/GATE_START_RECORD.json' },
      { gateId: 'GATE17', transitionType: 'AUTHORIZATION', eventId: 'GATE17_AUTHORIZATION_R1', authorityPath: 'governance/authority/authorizations/GATE17/GATE_AUTHORIZATION_RECORD.json' },
      { gateId: 'GATE16', transitionType: 'START', eventId: 'GATE16_START_R1', authorityPath: 'governance/authority/authorizations/GATE16/GATE_START_RECORD.json' }
    ];
    for (const request of recorded) {
      const report = runLifecycleTransition({
        root, stagingRoot: staging, dryRun: false, recordedAt: '2026-08-15T00:00:00.000Z', ...request
      });
      assert.equal(report.result, 'ALREADY_SATISFIED', `${request.eventId} must be idempotent`);
      assert.deepEqual(report.applied, []);
    }

    // A NEW event id repeating a completed transition -> blocked.
    for (const transitionType of ORCHESTRATED_TRANSITIONS) {
      const report = runLifecycleTransition({
        root, stagingRoot: staging, dryRun: false,
        gateId: 'GATE17', transitionType, eventId: `GATE17_${transitionType}_HOSTILE_DUPLICATE`,
        authorityPath: GATE17_CLOSURE_AUTHORITY, recordedAt: '2026-08-15T00:00:00.000Z'
      });
      assert.equal(report.result, 'BLOCKED', `${transitionType} duplicate must block`);
      assert.deepEqual(report.applied, []);
    }

    // Nothing was appended by any of the eight attempts.
    assert.equal(readText(root, LEDGER).split('\n').filter(Boolean).length, eventsBefore);
    assert.deepEqual(spineDigest(root), before);
  } finally { discard(root); discard(staging); }
});

/* ======================================================================
 * H10 — wrong external reinspection report path or SHA -> BLOCK
 * =================================================================== */

test('H10: a wrong external reinspection report path or digest blocks the audit', () => {
  const realPath = 'governance/sources/GATE17_B_INDEPENDENT_FINAL_REPLAY_EXTERNAL_CONFIRMATION_EXTERNAL_REINSPECTION_REPORT.json';
  const realSha = actualIdentity(REPO_ROOT, realPath).sha256;

  const good = auditFinalGateIntegrity({
    root: REPO_ROOT, gateId: 'GATE17', externalReinspectionReport: { path: realPath, sha256: realSha }
  });
  assert.equal(good.FINAL_GATE_INTEGRITY, 'PASS');

  const badSha = auditFinalGateIntegrity({
    root: REPO_ROOT, gateId: 'GATE17', externalReinspectionReport: { path: realPath, sha256: '0'.repeat(64) }
  });
  assert.equal(badSha.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.ok(auditClasses(badSha).has('EXTERNAL_REINSPECTION_REPORT_SHA_MISMATCH'));

  const badPath = auditFinalGateIntegrity({
    root: REPO_ROOT, gateId: 'GATE17',
    externalReinspectionReport: { path: 'governance/sources/WRONG_REPORT.json', sha256: realSha }
  });
  assert.equal(badPath.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.ok(auditClasses(badPath).has('EXTERNAL_REINSPECTION_REPORT_ABSENT'));
});

/* ======================================================================
 * H11 — unexpected file in bounded cohort -> BLOCK
 * =================================================================== */

test('H11: a sealed cohort member that does not exist is blocked at derivation', () => {
  const root = scratchRoot('h11');
  try {
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({
      root, ...gate17ClosureRequest(),
      sealedMemberOrder: ['CHECKPOINT', 'OPEN_DEFECTS', 'CURRENT_CONTRACT', 'governance/gates/GATE17/evidence/UNEXPECTED_FILE.json']
    });
    assert.equal(derived.status, 'BLOCKED');
    const finding = derived.findings.find((item) => item.defectClass === 'SEALED_MEMBER_ABSENT');
    assert.ok(finding);
    assert.equal(finding.path, 'governance/gates/GATE17/evidence/UNEXPECTED_FILE.json');
  } finally { discard(root); }
});

test('H11 (audit side): a path outside the authorized bounded cohort is visible in the Git status the audit reports', () => {
  const report = auditFinalGateIntegrity({
    root: REPO_ROOT, gateId: 'GATE17',
    authorizedCohort: ['governance/tools/final-gate-integrity-auditor.mjs']
  });
  // The audit reports the REAL working-tree status, so an unexpected path
  // cannot hide behind a declared cohort of one.
  assert.ok(Array.isArray(report.observations.git.status));
  const reportedPaths = new Set(report.observations.git.status.map((entry) => entry.path));
  assert.ok(reportedPaths.size > 1, 'the audit must show the real working tree, not the declared cohort');
});

test('H11 (duplicate member): the same path listed twice in a cohort is blocked', () => {
  const root = scratchRoot('h11-dup');
  try {
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({
      root, ...gate17ClosureRequest(),
      sealedMemberOrder: ['CHECKPOINT', 'OPEN_DEFECTS', 'CURRENT_CONTRACT', 'CURRENT_CONTRACT']
    });
    assert.equal(derived.status, 'BLOCKED');
    assert.ok(derived.findings.some((item) => item.defectClass === 'SEALED_MEMBER_DUPLICATE'));
  } finally { discard(root); }
});

/* ======================================================================
 * H12 — failure during candidate construction -> canonical bytes unchanged
 * =================================================================== */

test('H12: a failure during candidate construction leaves canonical ledger and state bytes unchanged', () => {
  const root = scratchRoot('h12');
  try {
    rewindGate17ToPostStart(root);
    const before = spineDigest(root);
    const revisionsBefore = fs.readdirSync(path.join(root, 'governance/gates/GATE17/state/revisions')).sort();

    // Several independent construction failures, none of which may write.
    const failures = [
      { ...gate17ClosureRequest(), authorityPath: 'governance/sources/ABSENT_AUTHORITY.json' },
      { ...gate17ClosureRequest(), sealedMemberOrder: ['CHECKPOINT', 'OPEN_DEFECTS', 'CURRENT_CONTRACT', 'governance/nowhere/missing.json'] },
      { ...gate17ClosureRequest(), gateId: 'GATE99' },
      { ...gate17ClosureRequest(), recordedAt: 'not-a-timestamp' }
    ];
    for (const request of failures) {
      const derived = deriveCandidateTransition({ root, ...request });
      assert.equal(derived.status, 'BLOCKED', JSON.stringify(request.authorityPath ?? request.gateId));
      assert.equal(derived.candidate, null);
    }

    assert.deepEqual(spineDigest(root), before);
    assert.deepEqual(fs.readdirSync(path.join(root, 'governance/gates/GATE17/state/revisions')).sort(), revisionsBefore);
  } finally { discard(root); }
});

test('H12 (mid-validation throw): a staging failure still leaves canonical bytes unchanged', () => {
  const root = scratchRoot('h12-throw');
  try {
    rewindGate17ToPostStart(root);
    const before = spineDigest(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest() });
    assert.equal(derived.status, 'DERIVED');

    // A staging root that cannot be created: validation cannot complete.
    let threw = false;
    try {
      validateCandidateInStagingRoot({
        root, candidate: derived.candidate,
        stagingRoot: path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson', 'impossible')
      });
    } catch { threw = true; }
    assert.equal(threw, true, 'an impossible staging root must throw rather than fall through to apply');
    assert.deepEqual(spineDigest(root), before);
    assert.equal(fs.existsSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003')), false);
  } finally { discard(root); }
});

/* ======================================================================
 * H13 — attempted reseal / history rewrite -> BLOCK
 * =================================================================== */

test('H13: a transition cannot mint a revision directory that already exists', () => {
  const root = scratchRoot('h13');
  try {
    // GATE17 at HEAD already has R0003 and R0004. A transaction that tried to
    // re-mint R0003 would be a reseal.
    const derived = deriveCandidateTransition({
      root, gateId: 'GATE17', transitionType: 'AGENT_CLOSURE',
      eventId: 'GATE17_AGENT_CLOSURE_RESEAL_ATTEMPT',
      authorityPath: GATE17_CLOSURE_AUTHORITY, recordedAt: '2026-08-15T00:00:00.000Z'
    });
    assert.equal(derived.status, 'BLOCKED');
    // Blocked at the duplicate-transition gate, which is the earlier and
    // stricter of the two barriers.
    assert.ok(derived.findings.some((item) => item.defectClass === 'DUPLICATE_TRANSITION_FOR_GATE'));
  } finally { discard(root); }
});

test('H13 (history rewrite): rewriting a committed historical seal is detected by the auditor', () => {
  const root = scratchRoot('h13-rewrite');
  try {
    const sealPath = 'governance/gates/GATE17/state/revisions/R0003/STATE_SEAL.json';
    const seal = readJson(root, sealPath);
    seal.sealedAt = '2026-08-14T19:30:01.000Z';
    writeJson(root, sealPath, seal);

    const report = auditFinalGateIntegrity({ root, gateId: 'GATE17' });
    assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
    const found = auditClasses(report);
    // The rewrite breaks the successor's chain link and the protected-hash claim
    // that pinned those exact bytes.
    assert.ok(found.has('SEAL_CHAIN_BREAK') || found.has('PROTECTED_HASH_MISMATCH') || found.has('SEALED_MEMBER_BYTES_CHANGED'));
  } finally { discard(root); }
});

test('H13 (prestate immutability): a candidate cannot rewrite a seal sealed before it', () => {
  const root = scratchRoot('h13-prestate');
  const staging = stagingDir();
  try {
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest() });
    const candidate = derived.candidate;

    const target = 'governance/gates/GATE16/state/revisions/R0004/STATE_SEAL.json';
    const mutated = Buffer.from(`${JSON.stringify({ ...readJson(root, target), hostile: true }, null, 2)}\n`, 'utf8');
    candidate.writes.push({ path: target, sha256: sha256Bytes(mutated), byteLength: mutated.length, bytes: mutated });

    const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
    assert.equal(validation.valid, false);
    assert.ok(validation.findings.some((finding) =>
      ['CANDIDATE_DISTURBS_EXISTING_SEAL', 'SEALED_MEMBER_MUTATION_AT_PRESTATE', 'CANDIDATE_STATE_SEAL_INVALID'].includes(finding.defectClass)));
  } finally { discard(root); discard(staging); }
});

/* ======================================================================
 * H14 — gate-specific fallback that bypasses generic failure -> BLOCK
 * =================================================================== */

test('H14: neither component contains a gate-specific or mission-specific allowlist', () => {
  const sources = [
    'governance/tools/gate-lifecycle-orchestrator.mjs',
    'governance/tools/final-gate-integrity-auditor.mjs'
  ];
  for (const source of sources) {
    const text = fs.readFileSync(path.join(REPO_ROOT, ...source.split('/')), 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*'))
      .join('\n');
    // A concrete Gate id in EXECUTABLE code would be exactly the bypass this
    // case exists to forbid. Comments and prose may name Gates freely.
    const gateLiterals = code.match(/["'`]GATE[0-9]{2}\b/g) ?? [];
    assert.deepEqual(gateLiterals, [], `${source} must not branch on a specific Gate id`);
    for (const forbidden of ['WHEEL_GENERIC_FAST_GATE', 'GATE16', 'GATE17']) {
      assert.equal(code.includes(`'${forbidden}'`), false, `${source} must not special-case ${forbidden}`);
    }
  }
});

test('H14: the same generic code path produces the verdict for every closed Gate', () => {
  // If a bypass existed for one Gate, the others would not behave identically.
  for (const gateId of ['GATE12', 'GATE13', 'GATE14', 'GATE15', 'GATE16', 'GATE17']) {
    const report = auditFinalGateIntegrity({ root: REPO_ROOT, gateId });
    assert.equal(report.familiesRun.length, 9, `${gateId} must run every family`);
    assert.equal(report.document, 'FINAL_GATE_INTEGRITY_AUDITOR');
    assert.ok(['PASS', 'FAIL'].includes(report.FINAL_GATE_INTEGRITY));
    assert.equal(report.gateId, gateId);
  }
});

test('H14: a damaged Gate cannot be rescued by any per-Gate exception', () => {
  const root = scratchRoot('h14-nobypass');
  try {
    // Identical damage applied to two different Gates must produce the identical
    // defect class. A bypass would show up as one of them passing.
    const damaged = [];
    for (const gateId of ['GATE16', 'GATE17']) {
      const copy = scratchRoot(`h14-${gateId}`);
      try {
        const sealPath = `governance/gates/${gateId}/state/revisions/R0004/STATE_SEAL.json`;
        const seal = readJson(copy, sealPath);
        seal.payload.executionStatus = 'IN_PROGRESS';
        writeJson(copy, sealPath, seal);
        const report = auditFinalGateIntegrity({ root: copy, gateId });
        damaged.push({ gateId, verdict: report.FINAL_GATE_INTEGRITY, hasPayloadMismatch: auditClasses(report).has('SEAL_PAYLOAD_HASH_MISMATCH') });
      } finally { discard(copy); }
    }
    assert.deepEqual(damaged.map((entry) => entry.verdict), ['FAIL', 'FAIL']);
    assert.deepEqual(damaged.map((entry) => entry.hasPayloadMismatch), [true, true]);
  } finally { discard(root); }
});
