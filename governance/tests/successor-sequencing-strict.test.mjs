/**
 * STRICT SUCCESSOR SEQUENCING — COMPLETE_AGENT does not admit a successor.
 *
 * THE CONTRADICTION THIS CLOSES. Dependency resolution treated COMPLETE_AGENT,
 * COMPLETE_CONFIRMED and SUPERSEDED alike as closed. A Gate at COMPLETE_AGENT
 * has been closed by the agent that executed it and has NOT been independently
 * confirmed, so admitting its successor let the executing agent certify its own
 * work and immediately spend that certification as the next Gate's entry
 * condition. The repository already held the correct answer in two other places
 * — the registry's entry condition for GATE21 reads "GATE20 is
 * COMPLETE_CONFIRMED", and validate-active-gate.mjs required COMPLETE_CONFIRMED
 * or SUPERSEDED — so this was one question with two canonical answers.
 *
 * WHAT IS PROVEN HERE. The rule, and the fact that it is ONE rule. It used to be
 * written in four modules; four copies that agree are one assumption, not four
 * proofs, so the battery asserts both the decision and its single source.
 *
 * The live repository is read and never mutated. Every hostile status is applied
 * to a synthetic event list or a disposable copy under the OS temp directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NON_SUCCESSOR_CLOSING_TERMINAL_STATUSES,
  SUCCESSOR_CLOSURE_STATUSES,
  satisfiesSuccessorClosure
} from '../gee-v1/core/successor-closure.mjs';
import {
  CLOSED_LEDGER_STATUSES,
  resolveGateDependencyProof,
  resolveGateDependencyProofFromEvents
} from '../gee-v1/adapters/wheel/gate-dependency-resolution.mjs';
import { GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES } from '../gee-v1/core/gate-authorization-authority.mjs';
import { TERMINAL_DEPENDENCY_STATUSES } from '../gee-v1/core/precontract-authority.mjs';
import { runFastPathControlPlane } from '../tools/gate-fast-path-control-plane.mjs';
import { canonicalize, sha256Canonical } from '../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const PREDECESSOR = 'GATE20';
const SUCCESSOR = 'GATE21';

function liveEvents() {
  return fs.readFileSync(path.join(REPO_ROOT, ...LEDGER.split('/')), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Re-chain a ledger so it is CANONICALLY VALID after a fixture edits it.
 *
 * WHY THIS BECAME NECESSARY. These fixtures used to edit `toStatus` in place and
 * hand the result to the resolver. That worked while the resolver read the scalar.
 * It no longer does: a terminal status is now admitted only when the event that
 * produced it is a legal transition from the status the Gate's own replay reached,
 * carrying an authority whose live bytes still hash to what the event pinned.
 *
 * A bare scalar edit is therefore no longer "a Gate with status X" — it is a
 * FORGERY, and the resolver blocks it as one. The fixtures kept running and
 * stopped asking their question, which is exactly the evidence-vacuity class this
 * mission exists to close. They are rebuilt here to construct genuinely valid
 * evidence instead.
 */
function rechain(events) {
  let previous = null;
  return events.map((event, index) => {
    const next = { ...event, ordinal: index + 1, previousEventSha256: previous };
    delete next.eventPayloadSha256;
    next.eventPayloadSha256 = sha256Canonical(next);
    previous = next.eventPayloadSha256;
    return next;
  });
}

/**
 * The Gate's history truncated to the last point it LAWFULLY held `status`.
 *
 * Nothing is relabelled: the events are the Gate's real ones, cut short. That is
 * the only way to pose "predecessor is IN_PROGRESS" honestly, because
 * COMPLETE_AGENT -> IN_PROGRESS is not a transition the canonical table permits,
 * so no amount of editing the final event could produce it lawfully.
 */
function withPredecessorTruncatedTo(gateId, status) {
  const events = liveEvents();
  const index = events.findLastIndex((event) => event.gateId === gateId && event.toStatus === status);
  assert.notEqual(index, -1, `${gateId} must lawfully reach ${status} somewhere in its real history`);
  return rechain(events.slice(0, index + 1));
}

/**
 * The Gate advanced to a terminal status by a LAWFUL transition it has not
 * actually taken.
 *
 * The appended event reuses an authority the Gate already cites, so the authority
 * resolves and its digest binds against real bytes; the transition is one the
 * canonical table permits from the Gate's current status; and the whole ledger is
 * re-chained. The result is a ledger the canonical terminal proof accepts — which
 * is the point, since these cases ask what a REAL closure admits, not what a
 * forgery can sneak past.
 */
function withPredecessorAdvancedTo(gateId, toStatus, transitionType) {
  const events = liveEvents();
  const own = events.filter((event) => event.gateId === gateId);
  const last = own.at(-1);
  assert.ok(last, `${gateId} must appear in the ledger`);
  const donor = own.findLast((event) => typeof event.authorityPath === 'string' && event.authorityPath.startsWith('governance/'));
  assert.ok(donor, `${gateId} must cite at least one resolvable repository authority`);
  events.push({
    ...last,
    eventId: `${gateId}_FIXTURE_${transitionType}`,
    transitionType,
    fromStatus: last.toStatus,
    toStatus,
    authorityPath: donor.authorityPath,
    authoritySha256: donor.authoritySha256
  });
  return rechain(events);
}

/**
 * A status scalar written onto the terminal event WITHOUT re-chaining.
 *
 * This is no longer a way to pose a status question — it is the forgery hostile,
 * and it is kept under that name so the distinction stays visible in the suite.
 */
function withForgedTerminalScalar(gateId, toStatus) {
  const events = liveEvents();
  const index = events.map((event) => event.gateId).lastIndexOf(gateId);
  assert.notEqual(index, -1, `${gateId} must appear in the ledger`);
  events[index] = { ...events[index], toStatus };
  return events;
}

const proofFor = (events, gateId = PREDECESSOR) =>
  resolveGateDependencyProofFromEvents({ root: REPO_ROOT, gateId, events });

/* ========================================================================= *
 * The owner decision, stated directly
 * ====================================================================== */

test('D06-RULE the canonical terminal set is exactly COMPLETE_CONFIRMED and SUPERSEDED', () => {
  assert.deepEqual([...SUCCESSOR_CLOSURE_STATUSES], ['COMPLETE_CONFIRMED', 'SUPERSEDED']);
  assert.deepEqual([...NON_SUCCESSOR_CLOSING_TERMINAL_STATUSES], ['COMPLETE_AGENT']);
  assert.equal(satisfiesSuccessorClosure('COMPLETE_AGENT'), false);
  assert.equal(satisfiesSuccessorClosure('COMPLETE_CONFIRMED'), true);
  assert.equal(satisfiesSuccessorClosure('SUPERSEDED'), true);
});

test('D06-ONE-RULE every layer resolves the SAME set, not its own copy', () => {
  // The defect was four independent lists that happened to agree. Identity is
  // asserted, not equality: a future edit to any one of them must be impossible
  // rather than merely detectable.
  assert.equal(GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES, SUCCESSOR_CLOSURE_STATUSES);
  assert.equal(TERMINAL_DEPENDENCY_STATUSES, SUCCESSOR_CLOSURE_STATUSES);
  assert.ok(Object.isFrozen(SUCCESSOR_CLOSURE_STATUSES));
});

test('D06-DISTINCT closed-for-reference and closed-for-successor stay different questions', () => {
  // CLOSED_LEDGER_STATUSES answers "is this Gate finished enough to be a sealed
  // reference". Collapsing the two is what produced the defect, so the fact that
  // they now differ is itself load-bearing.
  assert.equal(CLOSED_LEDGER_STATUSES.has('COMPLETE_AGENT'), true);
  assert.equal(satisfiesSuccessorClosure('COMPLETE_AGENT'), false);
});

/* ========================================================================= *
 * A-G: the required hostiles
 * ====================================================================== */

test('A predecessor COMPLETE_AGENT is BLOCKED', () => {
  const proof = proofFor(withPredecessorTruncatedTo(PREDECESSOR, 'COMPLETE_AGENT'));
  assert.equal(proof.satisfied, false);
  assert.equal(proof.status, 'COMPLETE_AGENT');
  assert.equal(proof.reason, 'DEPENDENCY_NOT_TERMINAL');
});

test('B predecessor IN_PROGRESS is BLOCKED', () => {
  const proof = proofFor(withPredecessorTruncatedTo(PREDECESSOR, 'IN_PROGRESS'));
  assert.equal(proof.satisfied, false);
  assert.equal(proof.reason, 'DEPENDENCY_NOT_TERMINAL');
});

test('C predecessor NOT_STARTED is BLOCKED', () => {
  const proof = proofFor(withPredecessorTruncatedTo(PREDECESSOR, 'NOT_STARTED'));
  assert.equal(proof.satisfied, false);
  assert.equal(proof.reason, 'DEPENDENCY_NOT_TERMINAL');
});

test('D predecessor COMPLETE_CONFIRMED satisfies the dependency', () => {
  const proof = proofFor(withPredecessorAdvancedTo(PREDECESSOR, 'COMPLETE_CONFIRMED', 'EXTERNAL_CONFIRMATION'));
  assert.equal(proof.satisfied, true);
  assert.equal(proof.status, 'COMPLETE_CONFIRMED');
  // Renamed with the terminal-proof repair: the reason now records that the
  // status was PROVEN canonical (legal transition + bound authority), not merely
  // that a terminal scalar was present on the last event.
  assert.equal(proof.reason, 'CANONICAL_TERMINAL_STATUS_PROVEN');
  assert.equal(proof.proof.gateId, PREDECESSOR);
});

test('E a canonically SUPERSEDED predecessor satisfies the dependency', () => {
  // Two routes, both canonical and both still open: a recorded SUPERSEDED
  // toStatus, and the owner disposition that GATE18 actually carries. The
  // disposition route is the one the live repository depends on — GATE19 could
  // only run because GATE18 is lawfully superseded — so tightening the rule must
  // not have closed it.
  const byStatus = proofFor(withPredecessorAdvancedTo(PREDECESSOR, 'SUPERSEDED', 'SUPERSESSION'));
  assert.equal(byStatus.satisfied, true);
  assert.equal(byStatus.status, 'SUPERSEDED');

  const byDisposition = resolveGateDependencyProof({ root: REPO_ROOT, gateId: 'GATE18' });
  assert.equal(byDisposition.satisfied, true);
  assert.equal(byDisposition.status, 'SUPERSEDED');
  assert.equal(byDisposition.reason, 'CANONICAL_OWNER_DISPOSITION_SUPERSEDED');
  assert.equal(byDisposition.observedStatus, 'NOT_STARTED');
});

test('F a fake status scalar without ledger proof is BLOCKED', () => {
  // Nothing that merely looks like closure counts. The value must be exactly one
  // of the canonical statuses, and a Gate with no events at all has no proof to
  // offer regardless of what any other document claims.
  for (const forged of ['COMPLETE', 'CONFIRMED', 'complete_confirmed', 'COMPLETE_CONFIRMED ', 'COMPLETE_AGENT_CONFIRMED', '', null, undefined, 0, true, {}]) {
    assert.equal(satisfiesSuccessorClosure(forged), false, String(forged));
  }
  for (const forged of ['COMPLETE', 'complete_confirmed', 'COMPLETE_AGENT_CONFIRMED']) {
    const proof = proofFor(withForgedTerminalScalar(PREDECESSOR, forged));
    // A forged scalar left on a stale-digest event is refused as unverified
    // evidence before its value is ever considered, which is strictly stronger
    // than the old DEPENDENCY_NOT_TERMINAL and is the point of the repair.
    assert.equal(proof.satisfied, false, forged);
    assert.ok(['LEDGER_EVIDENCE_UNVERIFIED', 'CANONICAL_TERMINAL_PROOF_FAILED', 'DEPENDENCY_NOT_TERMINAL'].includes(proof.reason), forged + ':' + proof.reason);
  }
  // A Gate absent from the ledger cannot be closed by assertion.
  // Re-chained after removal, so the ledger the resolver sees is VALID and the
  // only thing missing is the Gate. Filtering without re-chaining would break the
  // ordinals and pose 'the ledger is mangled' instead of 'the Gate is absent'.
  const absent = proofFor(rechain(liveEvents().filter((event) => event.gateId !== PREDECESSOR)));
  assert.equal(absent.satisfied, false);
  assert.equal(absent.status, 'ABSENT');
});

test('G GATE21 cannot START while GATE20 remains COMPLETE_AGENT', async () => {
  // The end-to-end consequence, read from the live repository exactly as it
  // stands: this is the state the defect made READY.
  const live = resolveGateDependencyProof({ root: REPO_ROOT, gateId: PREDECESSOR });
  assert.equal(live.status, 'COMPLETE_AGENT', 'this case is only meaningful while GATE20 is agent-closed');
  assert.equal(live.satisfied, false);

  const plan = await runFastPathControlPlane({ root: REPO_ROOT, gateId: SUCCESSOR, phase: 'READINESS' });
  assert.equal(plan.gateStatus, 'NOT_STARTED');
  assert.notEqual(plan.verdict, 'FAST_PATH_READY');
  assert.equal(plan.verdict, 'READY_WHEN_SEQUENCED');
  assert.equal(plan.dependencies.satisfied, false);
  assert.deepEqual(plan.dependencies.unsatisfied.map((entry) => entry.gateId), [PREDECESSOR]);
  assert.equal(plan.dependencies.unsatisfied[0].reason, 'DEPENDENCY_NOT_TERMINAL');
  assert.equal(plan.nextAllowedTransition, 'NONE');
});

test('G2 the registry and the resolver now give the same answer', () => {
  // The contradiction was documentary as well as behavioural: the registry
  // demanded COMPLETE_CONFIRMED while the resolver accepted COMPLETE_AGENT.
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/GATE_REGISTRY_00_40.json'), 'utf8'));
  const successor = registry.gates.find((gate) => gate.gateId === SUCCESSOR);
  assert.deepEqual(successor.dependencies, [PREDECESSOR]);
  assert.ok(successor.entryConditions.some((condition) => condition.includes(`${PREDECESSOR} is COMPLETE_CONFIRMED`)),
    JSON.stringify(successor.entryConditions));
  // What the registry demands is exactly what the resolver now enforces.
  assert.equal(satisfiesSuccessorClosure('COMPLETE_CONFIRMED'), true);
  assert.equal(resolveGateDependencyProof({ root: REPO_ROOT, gateId: PREDECESSOR }).satisfied, false);
});

test('G3 the tightening invalidates NO recorded history', () => {
  // NO_FUTURE_LEAKAGE in the other direction: a rule that refuses more today
  // must not retroactively refuse what was lawfully recorded yesterday. Every
  // AUTHORIZATION and START in the real ledger is replayed against the state its
  // own predecessor held AT THAT MOMENT, under the new rule.
  const events = liveEvents();
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/GATE_REGISTRY_00_40.json'), 'utf8'));
  const dependenciesOf = (gateId) => registry.gates.find((gate) => gate.gateId === gateId)?.dependencies ?? [];

  let replayed = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!['AUTHORIZATION', 'START'].includes(event.transitionType)) continue;
    const prefix = events.slice(0, index);
    for (const dependency of dependenciesOf(event.gateId)) {
      const proof = resolveGateDependencyProofFromEvents({ root: REPO_ROOT, gateId: dependency, events: prefix });
      assert.equal(proof.satisfied, true,
        `${event.eventId} depended on ${dependency}, which the strict rule must still accept (${proof.status}/${proof.reason})`);
      replayed += 1;
    }
  }
  assert.ok(replayed >= 10, `the replay must actually cover the recorded lifecycle, covered ${replayed}`);
});

test('G4 a rewound GATE20 admits GATE21 the moment it is lawfully confirmed', () => {
  // The rule must be a gate, not a wall: the same successor that is refused now
  // is admitted by the ONE change the lifecycle requires, and by nothing else.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'successor-sequencing-'));
  try {
    fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
    const target = path.join(root, ...LEDGER.split('/'));
    assert.equal(resolveGateDependencyProof({ root, gateId: PREDECESSOR }).satisfied, false);

    // THE ONE LAWFUL CHANGE. This case used to relabel the terminal event's
    // `toStatus` and call that a confirmation. Under the terminal-proof rule that
    // is a forgery and is refused — so the case, unchanged, would have proven the
    // exact opposite of its own name: that no lawful confirmation admits the
    // successor. It now appends a REAL EXTERNAL_CONFIRMATION from COMPLETE_AGENT,
    // citing an authority GATE20 already cites so the authority resolves and its
    // digest binds, with the whole ledger re-chained.
    const confirmedEvents = withPredecessorAdvancedTo(PREDECESSOR, 'COMPLETE_CONFIRMED', 'EXTERNAL_CONFIRMATION');
    fs.writeFileSync(target, `${confirmedEvents.map((event) => canonicalize(event)).join('\n')}\n`);

    const confirmed = resolveGateDependencyProof({ root, gateId: PREDECESSOR });
    assert.equal(confirmed.satisfied, true);
    assert.equal(confirmed.status, 'COMPLETE_CONFIRMED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
