/**
 * Focused tests for GATE_LIFECYCLE_ORCHESTRATOR.
 *
 * The claim under test is that mechanical lifecycle plumbing can be derived
 * deterministically instead of assembled by hand, and that a candidate which
 * would be rejected never reaches the canonical bytes. Both halves are easy to
 * fake, so these tests are written against the failure modes:
 *
 *   - ATOMICITY is proven by taking the canonical ledger's digest before and
 *     after a deliberately broken candidate, not by reading a status field that
 *     claims nothing was written;
 *   - IDEMPOTENCE is proven against the REAL ledger at HEAD, where GATE16 and
 *     GATE17 have already made every transition once, so a duplicate is a real
 *     duplicate rather than a fixture's idea of one;
 *   - DETERMINISM is proven by rewinding GATE17 to its post-START state in a
 *     scratch copy and re-deriving the AGENT_CLOSURE that was originally built
 *     by hand, then comparing identities.
 *
 * Real modules throughout. Every hostile case operates on a scratch copy under
 * the OS temp directory; the real repository is read but never mutated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ORCHESTRATED_TRANSITIONS, ORCHESTRATOR_DOCUMENT, LEDGER_PATH,
  collectBaselineIntegrity, deriveCandidateTransition, governedBytes,
  ledgerLineBytes, replayGateStatus, readLedgerEvents, resolveTargetStatus,
  runLifecycleTransition, summarizeCandidate, validateCandidateInStagingRoot
} from '../tools/gate-lifecycle-orchestrator.mjs';
import { sha256Bytes } from '../tools/canonical-json.mjs';
import { computeSealedMembersDigest } from '../tools/validate-state-seal.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GATE17_AGENT_CLOSURE_AUTHORITY =
  'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE17_AGENT_CLOSURE_R1.json';

function scratchRoot(label) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `gate-lifecycle-${label}-`));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}

function discard(root) { fs.rmSync(root, { recursive: true, force: true }); }

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

/**
 * Rewinds a scratch copy to GATE17's state immediately after START: ledger
 * truncated to ordinal 71, revisions R0003/R0004 removed, CURRENT_STATE pointing
 * at R0002. This is the exact pre-state the hand-built AGENT_CLOSURE acted on.
 */
function rewindGate17ToPostStart(root) {
  fs.rmSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0004'), { recursive: true, force: true });
  const ledgerFile = path.join(root, ...LEDGER_PATH.split('/'));
  const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(ledgerFile, `${lines.slice(0, 71).join('\n')}\n`);
  fs.writeFileSync(
    path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      gateId: 'GATE17',
      stateRevision: 'R0002',
      revisionPath: 'governance/gates/GATE17/state/revisions/R0002',
      stateSealSha256: '9f9f4cf466a7b0be18919dfe72c9fb4c9babe5d9efe150c866dc7f0eab914c52',
      committedByTransactionId: 'GATE17_START_R1_TRANSACTION'
    }, null, 2)}\n`
  );
  return JSON.parse(lines[71]);
}

/** The AGENT_CLOSURE request that reproduces GATE17's historical transition. */
function gate17ClosureRequest(historicalCheckpoint) {
  return {
    gateId: 'GATE17',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_AGENT_CLOSURE_R1',
    authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
    recordedAt: '2026-08-14T19:35:00.000Z',
    sealedAt: '2026-08-14T19:30:00.000Z',
    sealedMemberOrder: ['CHECKPOINT', 'OPEN_DEFECTS', 'CURRENT_CONTRACT'],
    checkpoint: {
      milestone: historicalCheckpoint.milestone,
      resumePoint: historicalCheckpoint.resumePoint,
      completedTasks: historicalCheckpoint.completedTasks,
      openTasks: historicalCheckpoint.openTasks,
      reusableEvidence: historicalCheckpoint.reusableEvidence,
      invalidatedEvidence: historicalCheckpoint.invalidatedEvidence,
      requiredNextActions: historicalCheckpoint.requiredNextActions,
      protectedHashes: historicalCheckpoint.protectedHashes,
      createdAt: historicalCheckpoint.createdAt
    }
  };
}

/* -------------------------------------------------------------------------
 * Shape and reuse
 * ---------------------------------------------------------------------- */

test('the orchestrator automates exactly the four mechanical transitions and no others', () => {
  assert.deepEqual([...ORCHESTRATED_TRANSITIONS].sort(),
    ['AGENT_CLOSURE', 'AUTHORIZATION', 'EXTERNAL_CONFIRMATION', 'START']);
  // Transitions carrying judgement are deliberately absent rather than
  // half-supported: a partly automated SUPERSESSION is worse than a manual one.
  for (const judgement of ['SUPERSESSION', 'EXTERNAL_REJECTION', 'AUTHORIZED_REOPEN', 'DEFECT_OPENED', 'INTERRUPTION']) {
    assert.ok(!ORCHESTRATED_TRANSITIONS.includes(judgement), `${judgement} must stay manual`);
  }
});

test('target status is read from the canonical transition table, not restated', () => {
  assert.equal(resolveTargetStatus('NOT_STARTED', 'AUTHORIZATION'), 'AUTHORIZED_NOT_STARTED');
  assert.equal(resolveTargetStatus('AUTHORIZED_NOT_STARTED', 'START'), 'IN_PROGRESS');
  assert.equal(resolveTargetStatus('IN_PROGRESS', 'AGENT_CLOSURE'), 'COMPLETE_AGENT');
  assert.equal(resolveTargetStatus('COMPLETE_AGENT', 'EXTERNAL_CONFIRMATION'), 'COMPLETE_CONFIRMED');
  // A transition the table does not admit has no target, and therefore no
  // candidate can be derived for it.
  assert.equal(resolveTargetStatus('COMPLETE_CONFIRMED', 'AGENT_CLOSURE'), null);
  assert.equal(resolveTargetStatus('NOT_STARTED', 'START'), null);
});

/* -------------------------------------------------------------------------
 * Idempotence, against the real ledger at HEAD
 * ---------------------------------------------------------------------- */

test('re-requesting a transition the ledger already records is ALREADY_SATISFIED, not a duplicate', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    ...gate17ClosureRequest(readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json'))
  });
  assert.equal(result.status, 'ALREADY_SATISFIED');
  assert.equal(result.candidate, null, 'an already-satisfied transition must derive no candidate');
  assert.equal(result.satisfiedBy.eventId, 'GATE17_AGENT_CLOSURE_R1');
  assert.equal(result.satisfiedBy.ordinal, 72);
  assert.equal(result.satisfiedBy.toStatus, 'COMPLETE_AGENT');
});

test('every already-recorded transition of GATE16 and GATE17 is idempotent', () => {
  const events = readLedgerEvents(REPO_ROOT);
  const recorded = events.filter((event) =>
    ['GATE16', 'GATE17'].includes(event.gateId) && ORCHESTRATED_TRANSITIONS.includes(event.transitionType));
  assert.ok(recorded.length >= 6, 'GATE16/GATE17 should contribute at least six orchestrated transitions');
  for (const event of recorded) {
    const result = deriveCandidateTransition({
      root: REPO_ROOT,
      gateId: event.gateId,
      transitionType: event.transitionType,
      eventId: event.eventId,
      authorityPath: event.authorityPath,
      recordedAt: event.recordedAt
    });
    // An EXTERNAL_CONFIRMATION cites a logical report id rather than a file, so
    // its authority bytes are not resolvable from the path alone. Either answer
    // is acceptable; what is NOT acceptable is deriving a fresh candidate for a
    // transition the ledger already contains.
    assert.notEqual(result.status, 'DERIVED', `${event.eventId} must not re-derive`);
    if (result.status === 'ALREADY_SATISFIED') {
      assert.equal(result.satisfiedBy.ordinal, event.ordinal);
    }
  }
});

test('a NEW event id cannot repeat a transition the gate has already made', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE17',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_AGENT_CLOSURE_R2_ATTEMPT',
    authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.findings.map((item) => item.defectClass), ['DUPLICATE_TRANSITION_FOR_GATE']);
});

test('an event id already spent on another transition cannot be reused', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE16',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_AGENT_CLOSURE_R1',
    authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.findings.map((item) => item.defectClass), ['EVENT_ID_ALREADY_USED_FOR_DIFFERENT_TRANSITION']);
});

/* -------------------------------------------------------------------------
 * Determinism — re-deriving GATE17's hand-built AGENT_CLOSURE
 * ---------------------------------------------------------------------- */

test('GATE17 AGENT_CLOSURE re-derives to the same lifecycle identities that were built by hand', () => {
  const root = scratchRoot('gate17-replay');
  try {
    const historicalEvent = rewindGate17ToPostStart(root);
    const historicalSeal = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/STATE_SEAL.json');
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');

    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');
    const candidate = derived.candidate;

    // The ledger position and chain link are mechanical facts and must match
    // the historical event exactly.
    assert.equal(candidate.ordinal, historicalEvent.ordinal);
    assert.equal(candidate.event.previousEventSha256, historicalEvent.previousEventSha256);
    assert.equal(candidate.fromStatus, historicalEvent.fromStatus);
    assert.equal(candidate.toStatus, historicalEvent.toStatus);
    assert.equal(candidate.event.authoritySha256, historicalEvent.authoritySha256);

    // So are the seal's lineage and subject.
    assert.equal(candidate.stateRevision, historicalSeal.stateRevision);
    assert.equal(candidate.seal.previousStateSealSha256, historicalSeal.previousStateSealSha256);
    assert.equal(candidate.seal.payload.executionStatus, historicalSeal.payload.executionStatus);
    assert.equal(candidate.seal.payload.contractSha256, historicalSeal.payload.contractSha256);
    assert.deepEqual(
      candidate.seal.sealedMembers.map((member) => member.repoRelativePath),
      historicalSeal.sealedMembers.map((member) => member.repoRelativePath)
    );

    // The contract member's bytes were untouched by the transaction, so its
    // sealed identity must be byte-for-byte what history recorded.
    const historicalContract = historicalSeal.sealedMembers
      .find((member) => member.repoRelativePath.endsWith('/CURRENT_CONTRACT.json'));
    const derivedContract = candidate.seal.sealedMembers
      .find((member) => member.repoRelativePath.endsWith('/CURRENT_CONTRACT.json'));
    assert.deepEqual(derivedContract, historicalContract);
  } finally {
    discard(root);
  }
});

test('a re-derived GATE17 AGENT_CLOSURE introduces no new ledger, seal or revision finding', () => {
  const root = scratchRoot('gate17-validate');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');

    const validation = validateCandidateInStagingRoot({ root, candidate: derived.candidate, stagingRoot: staging });
    assert.equal(validation.valid, true, JSON.stringify(validation.findings.slice(0, 4)));
    assert.equal(validation.reports.introducedLedgerFindingCount, 0);
    assert.equal(validation.reports.sealValid, true);
    assert.equal(validation.reports.revisionValid, true);
    // The pre-existing baseline is REPORTED rather than silently absorbed, so a
    // reader can see what was already true of this repository.
    assert.ok(validation.reports.baselineLedgerFindingCount > 0);
  } finally {
    discard(root);
    discard(staging);
  }
});

/* -------------------------------------------------------------------------
 * Atomicity — a rejected candidate never reaches canonical bytes
 * ---------------------------------------------------------------------- */

test('a candidate rejected during validation leaves every canonical byte untouched', () => {
  const root = scratchRoot('atomicity');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);

    const before = {
      ledger: sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))),
      currentState: sha256Bytes(fs.readFileSync(path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json'))),
      revisionAbsent: !fs.existsSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003'))
    };
    assert.equal(before.revisionAbsent, true);

    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');

    // Break the candidate the way a hand-built transition breaks: a chain link
    // that does not chain. Corrupting the derived object is the only way to
    // reach this state, which is itself the point — the deriver cannot produce it.
    const candidate = derived.candidate;
    candidate.event.previousEventSha256 = 'f'.repeat(64);
    const rebuiltLine = ledgerLineBytes(candidate.event);
    const priorLedger = fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')));
    const ledgerWrite = candidate.writes.find((write) => write.path === LEDGER_PATH);
    ledgerWrite.bytes = Buffer.concat([priorLedger, rebuiltLine]);

    const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
    assert.equal(validation.valid, false, 'a broken chain link must be rejected');
    assert.ok(validation.findings.some((item) => item.defectClass === 'CANDIDATE_LEDGER_INVALID'));

    // The real proof: the canonical bytes are digest-identical to before, and
    // the revision directory the candidate would have minted does not exist.
    assert.equal(sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))), before.ledger);
    assert.equal(sha256Bytes(fs.readFileSync(path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json'))), before.currentState);
    assert.equal(fs.existsSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003')), false);
  } finally {
    discard(root);
    discard(staging);
  }
});

test('runLifecycleTransition in dryRun reports a valid candidate and still writes nothing', () => {
  const root = scratchRoot('dryrun');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const ledgerBefore = sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/'))));

    const report = runLifecycleTransition({
      root, stagingRoot: staging, dryRun: true, ...gate17ClosureRequest(historicalCheckpoint)
    });
    assert.equal(report.document, ORCHESTRATOR_DOCUMENT);
    assert.equal(report.result, 'CANDIDATE_VALID');
    assert.equal(report.canonicalBytesUnchanged, true);
    assert.deepEqual(report.applied, []);
    assert.equal(sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))), ledgerBefore);
  } finally {
    discard(root);
    discard(staging);
  }
});

test('an applied transition writes exactly its declared cohort and nothing else', () => {
  const root = scratchRoot('apply');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);

    const report = runLifecycleTransition({
      root, stagingRoot: staging, dryRun: false, ...gate17ClosureRequest(historicalCheckpoint)
    });
    assert.equal(report.result, 'APPLIED');
    assert.deepEqual(report.applied.map((write) => write.path).sort(), [
      'governance/gates/GATE17/state/CURRENT_STATE.json',
      'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json',
      'governance/gates/GATE17/state/revisions/R0003/OPEN_DEFECTS.json',
      'governance/gates/GATE17/state/revisions/R0003/STATE_SEAL.json',
      'governance/state/GATE_STATUS_LEDGER.ndjson'
    ]);

    // Applying it a second time is a no-op decided from the ledger, not a
    // second event.
    const repeat = runLifecycleTransition({
      root, stagingRoot: staging, dryRun: false, ...gate17ClosureRequest(historicalCheckpoint)
    });
    assert.equal(repeat.result, 'ALREADY_SATISFIED');
    assert.deepEqual(repeat.applied, []);
    assert.equal(readLedgerEvents(root).length, 72, 'the ledger must not grow on a repeated apply');
  } finally {
    discard(root);
    discard(staging);
  }
});

/* -------------------------------------------------------------------------
 * Derived-not-supplied identities
 * ---------------------------------------------------------------------- */

test('every sealed member hash and byte length is computed from real bytes', () => {
  const root = scratchRoot('derived-hashes');
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');

    const writesByPath = new Map(derived.candidate.writes.map((write) => [write.path, write.bytes]));
    for (const member of derived.candidate.seal.sealedMembers) {
      const bytes = writesByPath.get(member.repoRelativePath)
        ?? fs.readFileSync(path.join(root, ...member.repoRelativePath.split('/')));
      assert.equal(member.sha256, sha256Bytes(bytes), `${member.repoRelativePath} hash must come from bytes`);
      assert.equal(member.byteLength, bytes.length, `${member.repoRelativePath} length must come from bytes`);
    }
    // The set digest is recomputed independently here rather than trusted.
    assert.equal(
      derived.candidate.seal.payload.sealedMembersDigest,
      computeSealedMembersDigest(derived.candidate.seal.sealedMembers)
    );
  } finally {
    discard(root);
  }
});

test('the candidate summary carries identities but never raw bytes', () => {
  const root = scratchRoot('summary');
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    const summary = summarizeCandidate(derived.candidate);
    assert.ok(summary.identities.eventPayloadSha256);
    assert.ok(summary.identities.stateSealSha256);
    for (const write of summary.writes) {
      assert.equal(Object.hasOwn(write, 'bytes'), false, 'a serializable summary must not carry file bytes');
    }
  } finally {
    discard(root);
  }
});

/* -------------------------------------------------------------------------
 * Fail-closed
 * ---------------------------------------------------------------------- */

test('a gate with no current contract cannot be transitioned', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE18',
    transitionType: 'AUTHORIZATION',
    eventId: 'GATE18_AUTHORIZATION_UNIT_TEST',
    authorityPath: 'governance/GATE_REGISTRY_00_40.json',
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some((item) => item.defectClass === 'CURRENT_CONTRACT_ABSENT'));
});

test('an unresolvable authority document blocks before any derivation', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE17',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_UNRESOLVABLE_AUTHORITY',
    authorityPath: 'governance/sources/THIS_AUTHORITY_DOES_NOT_EXIST.json',
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some((item) =>
    ['AUTHORITY_BYTES_UNRESOLVABLE', 'DUPLICATE_TRANSITION_FOR_GATE'].includes(item.defectClass)));
});

test('malformed requests are rejected with every independent reason at once', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT, gateId: 'NOT_A_GATE', transitionType: 'SUPERSESSION',
    eventId: '', authorityPath: '', recordedAt: 'not-a-timestamp'
  });
  assert.equal(result.status, 'BLOCKED');
  const classes = result.findings.map((item) => item.defectClass);
  // All five are reported together. A validator that stopped at the first would
  // turn one diagnosis into five sequential retries.
  for (const expected of ['GATE_ID_INVALID', 'TRANSITION_NOT_ORCHESTRATED', 'EVENT_ID_INVALID', 'AUTHORITY_PATH_INVALID', 'RECORDED_AT_INVALID']) {
    assert.ok(classes.includes(expected), `${expected} must be reported`);
  }
});

test('a transition the canonical table does not admit cannot be derived', () => {
  const root = scratchRoot('not-admitted');
  try {
    // GATE17 rewound to post-START is IN_PROGRESS; EXTERNAL_CONFIRMATION is only
    // admitted from COMPLETE_AGENT.
    rewindGate17ToPostStart(root);
    const result = deriveCandidateTransition({
      root,
      gateId: 'GATE17',
      transitionType: 'EXTERNAL_CONFIRMATION',
      eventId: 'GATE17_PREMATURE_CONFIRMATION',
      authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
      recordedAt: '2026-08-14T23:00:00.000Z'
    });
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.findings.some((item) => item.defectClass === 'TRANSITION_NOT_ADMITTED_BY_CANONICAL_TABLE'));
  } finally {
    discard(root);
  }
});

/* -------------------------------------------------------------------------
 * Baseline and helpers
 * ---------------------------------------------------------------------- */

test('the baseline records what was already true, and is not empty on this repository', () => {
  const baseline = collectBaselineIntegrity(REPO_ROOT);
  assert.ok(baseline.ledgerFindingCount > 0, 'FULL-mode ledger validation is not a pass/fail gate here');
  assert.equal(baseline.ledgerEventCount, readLedgerEvents(REPO_ROOT).length);
  assert.ok(baseline.sealValidity.size >= 20, 'every gate revision seal should be inventoried');
  assert.equal(baseline.sealValidity.get('governance/gates/GATE17/state/revisions/R0004/STATE_SEAL.json'), true);
});

test('replayed gate status is derived from the ledger alone', () => {
  const events = readLedgerEvents(REPO_ROOT);
  const status = replayGateStatus(events);
  assert.equal(status.get('GATE16'), 'COMPLETE_CONFIRMED');
  assert.equal(status.get('GATE17'), 'COMPLETE_CONFIRMED');

  // GATE18-GATE40 each carry a GENESIS_IMPORT that placed them at NOT_STARTED,
  // so the invariant is not "no event" — it is that no event ever moved them.
  for (let gate = 18; gate <= 40; gate += 1) {
    const gateId = `GATE${gate}`;
    assert.equal(status.get(gateId), 'NOT_STARTED', `${gateId} must remain NOT_STARTED`);
    const own = events.filter((event) => event.gateId === gateId);
    assert.equal(own.length, 1, `${gateId} must have exactly its genesis event`);
    assert.equal(own[0].transitionType, 'GENESIS_IMPORT');
  }
  assert.equal(
    events.filter((event) => event.transitionType === 'START' && event.gateId > 'GATE17').length,
    0,
    'no gate after GATE17 may have been started'
  );
});

test('governed bytes are deterministic and newline-terminated', () => {
  const value = { b: 2, a: [1, 2, 3] };
  assert.equal(governedBytes(value).toString('utf8'), `${JSON.stringify(value, null, 2)}\n`);
  assert.equal(Buffer.compare(governedBytes(value), governedBytes(value)), 0);
});
