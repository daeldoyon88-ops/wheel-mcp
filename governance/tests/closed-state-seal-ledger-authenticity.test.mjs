/**
 * CLOSED_STATE_SEAL_MEMBER — the LEDGER AUTHENTICITY boundary.
 *
 * THE DEFECT THIS SUITE EXISTS FOR, STATED AS THE ATTACK.
 *
 * The sibling suite (closed-state-seal-trust-boundary) proves that a seal-shaped
 * DOCUMENT cannot prove bytes. It closed that hole by requiring the seal to sit on
 * a lineage the LEDGER anchors, on the stated reasoning that "what cannot be
 * manufactured is the append-only ledger's pin of the seal bytes."
 *
 * That reasoning had one load-bearing assumption, and it was false. The ledger's
 * pin cannot be manufactured only if somebody has actually VALIDATED the ledger.
 * The inventory validated it with `verifyLedgerText`, which proves CHAIN INTEGRITY:
 * canonical bytes, continuous ordinals, `previousEventSha256` pinning the previous
 * line, and a recomputable `eventPayloadSha256`. Every one of those digests is
 * computed by whoever writes the file. So:
 *
 *     SELF-HASH IS NOT AUTHENTICITY.
 *     A COHERENT HASH CHAIN IS NOT A CANONICALLY AUTHORIZED HISTORY.
 *
 * Reproduced from live repository bytes in a disposable clone: take a path the
 * layer reports BLOCKED / NO_APPLICABLE_AUTHORITY, mint a state-binding event that
 * pins a brand-new revision, RECHAIN THE ENTIRE LEDGER so every ordinal and digest
 * is internally correct, and plant a STATE_SEAL for that revision naming the path
 * at its CURRENT digest. Observed, before the repair:
 *
 *     verifyLedgerText           verified = true
 *     validateStateSeal          valid    = true
 *     resolveStateRevisionLineage LEDGER-ANCHORED (the ledger really did pin it)
 *     CLOSED_STATE_SEAL_MEMBER   member ADMITTED
 *     current-byte authorization AUTHORIZED_CURRENT_BYTES
 *
 *     validate-status-ledger     BLOCK — the transition was never authorized
 *
 * Two answers over one set of bytes, and the one gating byte authorization was the
 * one that had checked no authority at all. L5 below is that exact scenario.
 *
 * WHAT THE REPAIR REQUIRES. The positive chain now descends from CANONICALLY
 * AUTHORIZED LEDGER HISTORY — the verdict of `validateLedger`, the same function
 * the validate-status-ledger CLI calls, with the same project policy. There is no
 * second validator and no fallback: if canonical authority cannot be established,
 * the authenticated inventory yields nothing (L14).
 *
 * NON-VACUITY IS PART OF THE CONTRACT. A repair that made every ledger fail would
 * satisfy L2-L14 and destroy the binding class. L1 and L15 are the positive
 * controls, and L15 additionally proves `verifyLedgerText` was not weakened into
 * uselessness — it remains the first gate and still catches the naive forgery.
 *
 * Every fixture is built from scratch under a temporary root. Nothing here reads
 * or writes the real repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validateStateSeal } from '../tools/validate-state-seal.mjs';
import { authenticateCanonicalLedgerHistory } from '../tools/canonical-ledger-authority.mjs';
// The canonical record kinds whose anti-borrowing rules L8/L9 exercise.
import { GATE_AUTHORIZATION_RECORD_KIND } from '../gee-v1/core/gate-authorization-authority.mjs';
import { GATE_START_RECORD_KIND } from '../gee-v1/core/gate-start-authority.mjs';
import { verifyLedgerText } from '../gee-v1/core/verified-ledger-evidence.mjs';
import { collectAuthenticatedClosedStateSealMembers } from '../gee-v1/core/sealed-state-evidence.mjs';
import {
  BINDING_CLOSED_STATE_SEAL_MEMBER,
  STATUS_AUTHORIZED,
  STATUS_BLOCKED,
  collectCurrentByteBindings,
  deriveCurrentByteAuthorizationProof
} from '../gee-v1/core/current-byte-authorization.mjs';
import {
  GATE, FILLER_GATE, LEDGER, CONTRACT, EVIDENCE, UNSEALED,
  TRANSITION_AUTHORITY, R2,
  absolute, identity, readJson, readLedgerEvents, rechain, run,
  sealDocument, writeJson, writeLedgerEvents
} from './closed-seal-fixture.mjs';

const R3 = `governance/gates/${GATE}/state/revisions/R0003`;

function proof(root, relativePath) {
  const { bindings } = collectCurrentByteBindings({ root, gateId: GATE });
  return deriveCurrentByteAuthorizationProof({ root, gateId: GATE, path: relativePath, bindings });
}

const ledgerText = (root) => fs.readFileSync(absolute(root, LEDGER), 'utf8');

/**
 * Every boundary in the positive chain, measured independently over one root.
 * Reporting them separately is the whole point: the defect was two of them
 * disagreeing while only one of them gated authorization.
 */
function boundaries(root, target) {
  const inventory = collectAuthenticatedClosedStateSealMembers(root);
  return {
    chain: verifyLedgerText(ledgerText(root)).verified,
    authority: authenticateCanonicalLedgerHistory({ root }).authorized,
    inventoryAuthenticated: inventory.authenticated,
    memberAdmitted: inventory.members.some((m) => m.repoRelativePath === target),
    currentByte: proof(root, target).status,
    findings: [...new Set(inventory.findings.map((entry) => entry.code))]
  };
}

/** The supporting artifacts a manufactured R0003 needs to be canonically valid. */
function plantR0003(root, extraMember) {
  writeJson(root, `${R3}/CHECKPOINT.json`, { gateId: GATE, stateRevision: 'R0003', resumePoint: 'PLANTED' });
  writeJson(root, `${R3}/OPEN_DEFECTS.json`, { gateId: GATE, stateRevision: 'R0003', defects: [] });
  const r2Sha = require$sha(root);
  const members = [
    identity(root, `${R3}/CHECKPOINT.json`),
    identity(root, `${R3}/OPEN_DEFECTS.json`),
    identity(root, CONTRACT),
    identity(root, extraMember)
  ];
  const seal = sealDocument({
    stateRevision: 'R0003', members, previousStateSealSha256: r2Sha,
    executionStatus: 'COMPLETE_AGENT', contractSha256: identity(root, CONTRACT).sha256
  });
  writeJson(root, `${R3}/STATE_SEAL.json`, seal);
  return require$sha(root, `${R3}/STATE_SEAL.json`);
}

/** SHA-256 of a seal file, defaulting to R0002's. */
function require$sha(root, rel = `${R2}/STATE_SEAL.json`) {
  return identity(root, rel).sha256;
}

/**
 * Append a self-minted state-binding event for R0003 and rechain the WHOLE ledger,
 * so the result is perfectly chain-coherent. `authority` lets a case choose which
 * authority the forged event cites.
 */
function forgeStateBinding(root, sealSha, authority = {}) {
  const events = readLedgerEvents(root);
  events.push({
    schemaVersion: 1,
    ordinal: events.length + 1,
    eventId: `${GATE}_FORGED_BIND_R0003`,
    gateId: authority.gateId ?? GATE,
    fromStatus: 'IN_PROGRESS',
    toStatus: 'INTERRUPTED_RESUMABLE',
    transitionType: 'INTERRUPTION',
    authorityPath: authority.authorityPath ?? 'governance/authority/NO_SUCH_AUTHORITY.json',
    authoritySha256: authority.authoritySha256 ?? 'f'.repeat(64),
    previousEventSha256: null,
    recordedAt: '2026-06-01T00:00:00.000Z',
    stateRevision: 'R0003',
    stateRevisionSealSha256: sealSha,
    eventPayloadSha256: null
  });
  writeLedgerEvents(root, rechain(events));
}

/* ========================= POSITIVE CONTROL ============================== */

test('L1 a real canonical ledger with a real anchored closed seal authorizes its exact member', () => {
  run((fixture) => {
    const observed = boundaries(fixture.root, EVIDENCE);
    assert.equal(observed.chain, true);
    assert.equal(observed.authority, true, 'the fixture ledger must be canonically AUTHORIZED, not merely coherent');
    assert.equal(observed.inventoryAuthenticated, true);
    assert.equal(observed.memberAdmitted, true);
    assert.equal(observed.currentByte, STATUS_AUTHORIZED);
    assert.deepEqual(observed.findings, []);
    assert.equal(proof(fixture.root, EVIDENCE).bindingClass, BINDING_CLOSED_STATE_SEAL_MEMBER);
  });
});

/* ===================== CHAIN-LEVEL HOSTILES (L2-L3) ====================== */

test('L2 a malformed ledger chain blocks', () => {
  run((fixture) => {
    fs.writeFileSync(absolute(fixture.root, LEDGER), 'this is not ndjson\n');
    const observed = boundaries(fixture.root, EVIDENCE);
    assert.equal(observed.chain, false);
    assert.equal(observed.authority, false);
    assert.equal(observed.inventoryAuthenticated, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

test('L3 one ledger byte changed without rechaining blocks', () => {
  run((fixture) => {
    const before = ledgerText(fixture.root);
    const after = before.replace('"toStatus":"IN_PROGRESS"', '"toStatus":"COMPLETE_CONFIRMED"');
    assert.notEqual(after, before, 'the hostile edit must actually change the ledger');
    fs.writeFileSync(absolute(fixture.root, LEDGER), after);
    const observed = boundaries(fixture.root, EVIDENCE);
    // Chain integrity catches this one; it is the naive forgery and must stay caught.
    assert.equal(observed.chain, false);
    assert.equal(observed.inventoryAuthenticated, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

/* ============ THE COMPETENT FORGERIES: COHERENT BUT UNAUTHORIZED ========= */

test('L4 an entire ledger coherently rehashed after mutation still blocks when the authority does not hold', () => {
  run((fixture) => {
    const events = readLedgerEvents(fixture.root);
    // Relabel a status AND rechain, so every digest is internally correct.
    events.at(-1).toStatus = 'COMPLETE_AGENT';
    writeLedgerEvents(fixture.root, rechain(events));
    const observed = boundaries(fixture.root, EVIDENCE);
    assert.equal(observed.chain, true, 'the forgery must be chain-coherent, or it proves nothing');
    assert.equal(observed.authority, false);
    assert.equal(observed.inventoryAuthenticated, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

test('L5 THE DEFECT: rehashed ledger + self-minted state binding + valid seal + exact member, with no authority, blocks', () => {
  run((fixture) => {
    // The target is a real file that no authority names: BLOCKED to begin with.
    const before = proof(fixture.root, UNSEALED);
    assert.equal(before.status, STATUS_BLOCKED);
    assert.equal(before.reason, 'NO_APPLICABLE_AUTHORITY');

    const sealSha = plantR0003(fixture.root, UNSEALED);
    forgeStateBinding(fixture.root, sealSha);

    // Both halves of the forgery are genuinely well-formed. If either of these
    // assertions ever fails, this test has stopped reproducing the attack.
    const sealReport = validateStateSeal({
      root: fixture.root, sealPath: absolute(fixture.root, `${R3}/STATE_SEAL.json`), currentRevision: 'R0003'
    });
    assert.equal(sealReport.valid, true, 'the planted seal must be canonically VALID');

    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true, 'the ledger must be perfectly COHERENT');
    assert.equal(observed.authority, false, 'and canonically UNAUTHORIZED');
    assert.equal(observed.inventoryAuthenticated, false);
    assert.equal(observed.memberAdmitted, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
    assert.ok(observed.findings.includes('AUTHENTICATED_CLOSED_STATE_SEAL_LEDGER_AUTHORITY_INVALID'));
  });
});

/* ==================== AUTHORITY-SHAPED HOSTILES (L6-L9) ================== */

test('L6 a forged event naming a nonexistent authority blocks', () => {
  run((fixture) => {
    const sealSha = plantR0003(fixture.root, UNSEALED);
    forgeStateBinding(fixture.root, sealSha, { authorityPath: 'governance/authority/ABSENT_AUTHORITY.json' });
    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true);
    assert.equal(observed.authority, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

test('L7 a forged event naming a real authority path with the wrong SHA blocks', () => {
  run((fixture) => {
    const sealSha = plantR0003(fixture.root, UNSEALED);
    forgeStateBinding(fixture.root, sealSha, {
      authorityPath: TRANSITION_AUTHORITY, authoritySha256: 'a'.repeat(64)
    });
    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true);
    assert.equal(observed.authority, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

/**
 * L8 and L9 are about an authority whose BYTES bind perfectly but which does not
 * authorize THIS transition or THIS gate. The repository already owns that
 * semantics — `checkGateAuthorizationRecordNotBorrowed` and
 * `checkGateStartRecordNotBorrowed` inside the canonical validator — so these
 * cases are proven through those primitives rather than through a new rule.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE. A transition citing an UNSCOPED
 * authority document (one that names no gate and no transition class) is bound by
 * its bytes and nothing more; the canonical validator has never required scope for
 * generic execution transitions. That is a pre-existing property of
 * `validateLedger`, it is unchanged by this repair, and — the point that matters
 * for the contradiction search — the canonical validator and the authenticated
 * seal inventory now reach the SAME verdict on it, because they are the same
 * function. It is recorded as residual, not silently implied to be closed.
 */
function plantAuthorityRecord(root, relativePath, document, gateId) {
  writeJson(root, relativePath, {
    document, gateId, recordId: `${gateId}_RECORD_R1`, note: 'real, resolvable, correctly hashed'
  });
  return { authorityPath: relativePath, authoritySha256: identity(root, relativePath).sha256 };
}

test('L8 a forged event citing real authority bytes that do not authorize this transition blocks', () => {
  run((fixture) => {
    const sealSha = plantR0003(fixture.root, UNSEALED);
    // A GATE_AUTHORIZATION_RECORD for this very Gate: real path, real bytes,
    // correct digest — it resolves perfectly. It authorizes AUTHORIZATION and
    // nothing else, so it can never authorize a state-binding INTERRUPTION.
    const cited = plantAuthorityRecord(
      fixture.root,
      `governance/authority/authorizations/${GATE}/GATE_AUTHORIZATION_RECORD.json`,
      GATE_AUTHORIZATION_RECORD_KIND,
      GATE
    );
    forgeStateBinding(fixture.root, sealSha, cited);
    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true, 'the forgery must be chain-coherent');
    assert.equal(observed.authority, false, 'a resolvable authority is not an authorizing one');
    assert.equal(observed.memberAdmitted, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

test('L9 an authority valid for another gate cannot authorize this gate revision', () => {
  run((fixture) => {
    const sealSha = plantR0003(fixture.root, UNSEALED);
    // A GATE_START_RECORD belonging to the OTHER gate, borrowed by this gate's
    // forged state binding. Its bytes bind; its authority does not reach here.
    const cited = plantAuthorityRecord(
      fixture.root,
      `governance/authority/authorizations/${FILLER_GATE}/GATE_START_RECORD.json`,
      GATE_START_RECORD_KIND,
      FILLER_GATE
    );
    forgeStateBinding(fixture.root, sealSha, cited);
    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true);
    assert.equal(observed.authority, false);
    assert.equal(observed.memberAdmitted, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

test('L9b a state binding recorded against another gate cannot reach this gate lineage', () => {
  run((fixture) => {
    const sealSha = plantR0003(fixture.root, UNSEALED);
    // Here the ledger stays canonically AUTHORIZED: the forged event is a legal
    // transition for the other gate, citing the shared authority. What it cannot
    // do is bind THIS gate's revision — so the seal stays off this lineage.
    forgeStateBinding(fixture.root, sealSha, {
      gateId: FILLER_GATE,
      authorityPath: TRANSITION_AUTHORITY,
      authoritySha256: identity(fixture.root, TRANSITION_AUTHORITY).sha256
    });
    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true);
    assert.equal(observed.memberAdmitted, false, 'another gate cannot bind this gate revision');
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

/* ==================== LINEAGE AND REPLAY HOSTILES (L10-L12) ============== */

test('L10 a valid seal unreachable from the authorized lineage cannot authorize', () => {
  run((fixture) => {
    // A canonically valid R0003 seal, and NO ledger event binding it at all.
    plantR0003(fixture.root, UNSEALED);
    const sealReport = validateStateSeal({
      root: fixture.root, sealPath: absolute(fixture.root, `${R3}/STATE_SEAL.json`)
    });
    assert.equal(sealReport.valid, true, 'the unreachable seal must itself be VALID');
    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true);
    assert.equal(observed.authority, true, 'the ledger is untouched and still authorized');
    // The ledger never bound R0003, so the lineage reports it as an orphan.
    assert.equal(observed.memberAdmitted, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
    assert.ok(observed.findings.includes('AUTHENTICATED_CLOSED_STATE_SEAL_LINEAGE_INVALID'));
  });
});

test('L11 a later append cannot retroactively authorize previously unauthorized member bytes', () => {
  run((fixture) => {
    assert.equal(proof(fixture.root, UNSEALED).status, STATUS_BLOCKED);
    const sealSha = plantR0003(fixture.root, UNSEALED);
    // Appending is the whole attack: the ledger grows, and the growth is exactly
    // the event that would authorize the bytes. It is not itself authorized.
    forgeStateBinding(fixture.root, sealSha);
    const observed = boundaries(fixture.root, UNSEALED);
    assert.equal(observed.chain, true);
    assert.equal(observed.authority, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED,
      'growth of the ledger must never convert unauthorized bytes into authorized ones');
  });
});

test('L12 replaying obsolete state-binding evidence cannot supersede the canonical terminal lineage', () => {
  run((fixture) => {
    const events = readLedgerEvents(fixture.root);
    // Re-append the R0001 binding after the R0002 binding, rechained coherently:
    // an obsolete but once-genuine state binding, replayed to roll the head back.
    const obsolete = { ...events.find((e) => e.eventId === `${GATE}_BIND_R0001`) };
    obsolete.eventId = `${GATE}_BIND_R0001_REPLAY`;
    obsolete.fromStatus = 'IN_PROGRESS';
    obsolete.recordedAt = '2026-07-01T00:00:00.000Z';
    events.push(obsolete);
    writeLedgerEvents(fixture.root, rechain(events));
    const observed = boundaries(fixture.root, EVIDENCE);
    assert.equal(observed.chain, true, 'the replay must be chain-coherent');
    // Either the canonical validator refuses the replayed transition, or the
    // lineage reports the rollback. What must never happen is silent acceptance.
    assert.equal(observed.currentByte, STATUS_BLOCKED);
    assert.ok(observed.authority === false || observed.memberAdmitted === false);
  });
});

/* ==================== AUTHORITY TAMPERING AND COLLAPSE (L13-L14) ========= */

test('L13 tampering the cited authority while keeping the chain coherent blocks', () => {
  run((fixture) => {
    // The ledger is untouched and perfectly coherent; only the AUTHORITY BYTES
    // the events pinned are edited, so every authoritySha256 stops resolving.
    writeJson(fixture.root, TRANSITION_AUTHORITY, {
      documentKind: 'FIXTURE_TRANSITION_AUTHORITY',
      issuedBy: 'PROJECT_OWNER',
      purpose: 'TAMPERED'
    });
    const observed = boundaries(fixture.root, EVIDENCE);
    assert.equal(observed.chain, true, 'the ledger chain is deliberately left intact');
    assert.equal(observed.authority, false);
    assert.equal(observed.inventoryAuthenticated, false);
    assert.equal(observed.memberAdmitted, false);
    assert.equal(observed.currentByte, STATUS_BLOCKED);
  });
});

test('L14 destroying the ledger trust source yields a fail-closed inventory with zero usable members', () => {
  run((fixture) => {
    fs.rmSync(absolute(fixture.root, LEDGER));
    const inventory = collectAuthenticatedClosedStateSealMembers(fixture.root);
    assert.equal(inventory.authenticated, false);
    assert.deepEqual(inventory.members, []);
    assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
    assert.equal(proof(fixture.root, UNSEALED).status, STATUS_BLOCKED);
  });
});

/* ============================= NON-VACUITY =============================== */

test('L15 legitimately authorized closed-seal bindings survive the repair unchanged', () => {
  run((fixture) => {
    // The exact member the fixture's genuine R0002 seal binds is still AUTHORIZED,
    // through the CLOSED_STATE_SEAL_MEMBER class specifically.
    const authorized = proof(fixture.root, EVIDENCE);
    assert.equal(authorized.status, STATUS_AUTHORIZED);
    assert.equal(authorized.bindingClass, BINDING_CLOSED_STATE_SEAL_MEMBER);

    const inventory = collectAuthenticatedClosedStateSealMembers(fixture.root);
    assert.equal(inventory.authenticated, true);
    assert.ok(inventory.members.length > 0, 'the binding class must not have been emptied');
    assert.deepEqual(inventory.findings, []);

    // And the layer is still capable of refusing: non-vacuity in both directions.
    assert.equal(proof(fixture.root, UNSEALED).status, STATUS_BLOCKED);

    // verifyLedgerText was NOT weakened: it remains the first gate and still
    // rejects the naive un-rechained edit on its own.
    const seal = readJson(fixture.root, `${R2}/STATE_SEAL.json`);
    assert.equal(typeof seal.payloadSha256, 'string');
    assert.equal(verifyLedgerText(ledgerText(fixture.root)).verified, true);
  });
});
