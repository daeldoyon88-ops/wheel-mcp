/**
 * CLOSED_STATE_SEAL_MEMBER — the trust boundary between a document that LOOKS
 * like a state seal and one that may PROVE what bytes a path holds.
 *
 * THE DEFECT THIS SUITE EXISTS FOR, STATED AS THE ATTACK.
 *
 * `deriveCurrentByteAuthorizationProof` reported a path as
 * BLOCKED / NO_APPLICABLE_AUTHORITY. An isolated clone then received one new
 * file at governance/gates/<G>/state/revisions/<Rxxxx>/STATE_SEAL.json:
 *
 *     { "gateId": "...", "stateRevision": "...",
 *       "payload": { "status": "CLOSED" },
 *       "sealedMembers": [ { the blocked path, its CURRENT sha256, its length } ] }
 *
 * and the same byte became AUTHORIZED_CURRENT_BYTES. No payloadSha256, no
 * sealedMembersDigest, no seal chain, no ledger event, no gate that had ever
 * existed. The document restated the bytes and was accepted as proof of them.
 *
 * WHY THE CANONICAL SEAL VALIDATOR IS NOT, BY ITSELF, THE FIX — and why this
 * suite asserts that explicitly rather than trusting it. `validateStateSeal`
 * verifies a seal against the bytes on disk, so a seal that passes it in full can
 * be manufactured by anyone who can write files: create the next revision
 * directory with its own CHECKPOINT and OPEN_DEFECTS, link previousStateSealSha256
 * to the real predecessor, recompute both digests, and name any path at its
 * current digest. B3 below builds exactly that document, asserts the canonical
 * validator returns valid === true for it, and then requires the authorization
 * layer to refuse it anyway. A suite that only checked malformed seals would pass
 * against a repair that is still wide open.
 *
 * What cannot be manufactured is the append-only ledger's pin of the seal bytes.
 * Eligibility is therefore restricted to revisions on the LEDGER-ANCHORED lineage,
 * and B3 is the test that keeps that requirement honest.
 *
 * NON-VACUITY IS PART OF THE CONTRACT. A repair that made every STATE_SEAL fail
 * would satisfy every negative case here and destroy the binding class. B1 and
 * B12 are the positive controls: a genuine ledger-anchored closed seal must still
 * authorize its exact member, and the publisher's refusal inventory — which must
 * stay permissive, because narrowing it would weaken SEALED_MEMBER_MUTATION — must
 * still see the seals this layer rejects.
 *
 * The fixture is built from scratch under a temporary root. Nothing here reads or
 * writes the repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sha256Canonical } from '../tools/canonical-json.mjs';
import { computeSealedMembersDigest, validateStateSeal } from '../tools/validate-state-seal.mjs';
import {
  collectAuthenticatedClosedStateSealMembers,
  collectClosedStateSealMembers
} from '../gee-v1/core/sealed-state-evidence.mjs';
import {
  BINDING_CLOSED_STATE_SEAL_MEMBER,
  STATUS_AUTHORIZED,
  STATUS_BLOCKED,
  collectCurrentByteBindings,
  deriveCurrentByteAuthorizationProof
} from '../gee-v1/core/current-byte-authorization.mjs';
// The canonically authorized synthetic repository, shared with the ledger
// authenticity suite so the two halves of one trust boundary cannot drift apart.
import {
  GATE, LEDGER, CONTRACT, EVIDENCE, UNSEALED, R1, R2,
  absolute, identity, readJson, run, sealDocument,
  stateBindingsFor, writeJson, writeLedger, writeSeal
} from './closed-seal-fixture.mjs';


function proof(root, relativePath) {
  const { bindings } = collectCurrentByteBindings({ root, gateId: GATE });
  return deriveCurrentByteAuthorizationProof({ root, gateId: GATE, path: relativePath, bindings });
}

/** Plant a seal at an arbitrary revision directory and report the verdict for a path. */
function withPlantedSeal(fixture, revisionDir, seal, target = EVIDENCE) {
  writeJson(fixture.root, `${revisionDir}/STATE_SEAL.json`, seal);
  return proof(fixture.root, target);
}

/** The attacker's supporting files for a manufactured R0003. */
function plantR0003Support(root) {
  writeJson(root, `governance/gates/${GATE}/state/revisions/R0003/CHECKPOINT.json`, { gateId: GATE, stateRevision: 'R0003', resumePoint: 'PLANTED' });
  writeJson(root, `governance/gates/${GATE}/state/revisions/R0003/OPEN_DEFECTS.json`, { gateId: GATE, stateRevision: 'R0003', defects: [] });
}

function plantedR0003Members(root) {
  return [
    identity(root, `governance/gates/${GATE}/state/revisions/R0003/CHECKPOINT.json`),
    identity(root, `governance/gates/${GATE}/state/revisions/R0003/OPEN_DEFECTS.json`),
    identity(root, CONTRACT),
    identity(root, UNSEALED)
  ];
}

test('B1 a genuine ledger-anchored closed seal authorizes its exact member', () => {
  run((fixture) => {
    const authorized = proof(fixture.root, EVIDENCE);
    assert.equal(authorized.status, STATUS_AUTHORIZED);
    assert.equal(authorized.bindingClass, BINDING_CLOSED_STATE_SEAL_MEMBER);
    // Non-vacuity in the other direction: the layer is still capable of blocking.
    assert.equal(proof(fixture.root, UNSEALED).status, STATUS_BLOCKED);
    const inventory = collectAuthenticatedClosedStateSealMembers(fixture.root);
    assert.equal(inventory.authenticated, true);
    assert.deepEqual(inventory.findings, []);
  });
});

test('B2 a fabricated seal naming the exact current bytes cannot authorize them', () => {
  run((fixture) => {
    const before = proof(fixture.root, UNSEALED);
    assert.equal(before.status, STATUS_BLOCKED);
    const result = withPlantedSeal(fixture, `governance/gates/${GATE}/state/revisions/R0003`, {
      gateId: GATE, stateRevision: 'R0003', payload: { status: 'CLOSED' },
      sealedMembers: [identity(fixture.root, UNSEALED)]
    }, UNSEALED);
    assert.equal(result.status, STATUS_BLOCKED);
    assert.equal(result.candidateCount, 0);
  });
});

test('B3 a seal the canonical validator fully accepts still cannot authorize when the ledger never bound it', () => {
  run((fixture) => {
    plantR0003Support(fixture.root);
    const members = plantedR0003Members(fixture.root);
    const seal = sealDocument({
      stateRevision: 'R0003', members, previousStateSealSha256: fixture.r2Sha,
      executionStatus: 'COMPLETE_AGENT', contractSha256: fixture.contract.sha256
    });
    writeJson(fixture.root, `governance/gates/${GATE}/state/revisions/R0003/STATE_SEAL.json`, seal);

    // The load-bearing assertion: canonical seal validity is REACHED, and refused.
    const report = validateStateSeal({ root: fixture.root, sealPath: absolute(fixture.root, `governance/gates/${GATE}/state/revisions/R0003/STATE_SEAL.json`) });
    assert.equal(report.valid, true, 'fixture must actually manufacture a canonically valid seal');

    assert.equal(proof(fixture.root, UNSEALED).status, STATUS_BLOCKED);
    const inventory = collectAuthenticatedClosedStateSealMembers(fixture.root);
    assert.ok(inventory.findings.some((entry) => entry.code === 'AUTHENTICATED_CLOSED_STATE_SEAL_LINEAGE_INVALID'));
  });
});

test('B4 a wrong payloadSha256 removes the seal from the trust source', () => {
  run((fixture) => {
    const seal = readJson(fixture.root, `${R2}/STATE_SEAL.json`);
    seal.payloadSha256 = '0'.repeat(64);
    writeJson(fixture.root, `${R2}/STATE_SEAL.json`, seal);
    assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
  });
});

test('B5 members edited after the sealed-member digest was computed are rejected', () => {
  run((fixture) => {
    const seal = readJson(fixture.root, `${R2}/STATE_SEAL.json`);
    seal.sealedMembers.push(identity(fixture.root, UNSEALED));
    seal.payloadSha256 = sha256Canonical(seal.payload);
    writeJson(fixture.root, `${R2}/STATE_SEAL.json`, seal);
    assert.equal(proof(fixture.root, UNSEALED).status, STATUS_BLOCKED);
    assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
  });
});

test('B6 a closed-looking string elsewhere in the payload is not a closed status', () => {
  run((fixture) => {
    const contract = identity(fixture.root, CONTRACT);
    const members = [
      identity(fixture.root, `${R2}/CHECKPOINT.json`), identity(fixture.root, `${R2}/OPEN_DEFECTS.json`),
      contract, identity(fixture.root, EVIDENCE)
    ];
    const payload = {
      gateId: GATE, stateRevision: 'R0002', milestoneStatus: 'COMPLETE_CONFIRMED',
      contractSha256: contract.sha256, previousStateSealSha256: fixture.r1Sha,
      sealedMembersDigest: computeSealedMembersDigest(members)
    };
    const seal = sealDocument({ stateRevision: 'R0002', members, previousStateSealSha256: fixture.r1Sha, payloadOverride: payload });
    writeJson(fixture.root, `${R2}/STATE_SEAL.json`, seal);
    // The seal is canonically valid; it simply never declares a closed state.
    assert.equal(validateStateSeal({ root: fixture.root, sealPath: absolute(fixture.root, `${R2}/STATE_SEAL.json`), currentRevision: 'R0002' }).valid, true);
    assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
  });
});

test('B7 a wrong gateId, a wrong revisionId, or a relocated seal all fail closed', () => {
  for (const mutate of [
    (seal) => { seal.gateId = 'GATE32'; },
    (seal) => { seal.stateRevision = 'R0009'; }
  ]) {
    run((fixture) => {
      const seal = readJson(fixture.root, `${R2}/STATE_SEAL.json`);
      mutate(seal);
      seal.payloadSha256 = sha256Canonical(seal.payload);
      writeJson(fixture.root, `${R2}/STATE_SEAL.json`, seal);
      assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
    });
  }
  run((fixture) => {
    const bytes = fs.readFileSync(absolute(fixture.root, `${R2}/STATE_SEAL.json`));
    fs.rmSync(absolute(fixture.root, `${R2}/STATE_SEAL.json`));
    const relocated = `governance/gates/${GATE}/state/revisions/R0007/STATE_SEAL.json`;
    fs.mkdirSync(path.dirname(absolute(fixture.root, relocated)), { recursive: true });
    fs.writeFileSync(absolute(fixture.root, relocated), bytes);
    assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
  });
});

test('B8 member sha256, byteLength or path tampering fails even with every digest recomputed', () => {
  const mutations = [
    (member) => { member.sha256 = 'a'.repeat(64); },
    (member) => { member.byteLength += 1; },
    (member) => { member.repoRelativePath = UNSEALED; }
  ];
  for (const mutate of mutations) {
    run((fixture) => {
      const seal = readJson(fixture.root, `${R2}/STATE_SEAL.json`);
      mutate(seal.sealedMembers.find((entry) => entry.repoRelativePath === EVIDENCE));
      seal.payload.sealedMembersDigest = computeSealedMembersDigest(seal.sealedMembers);
      seal.payloadSha256 = sha256Canonical(seal.payload);
      writeJson(fixture.root, `${R2}/STATE_SEAL.json`, seal);
      assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
      assert.equal(proof(fixture.root, UNSEALED).status, STATUS_BLOCKED);
    });
  }
});

test('B9 two conflicting seals for one identity block, and never resolve first-wins', () => {
  run((fixture) => {
    const seal = readJson(fixture.root, `${R2}/STATE_SEAL.json`);
    const clone = structuredClone(seal);
    clone.sealedMembers.find((entry) => entry.repoRelativePath === EVIDENCE).sha256 = 'b'.repeat(64);
    clone.payload.sealedMembersDigest = computeSealedMembersDigest(clone.sealedMembers);
    clone.payloadSha256 = sha256Canonical(clone.payload);
    writeJson(fixture.root, `governance/gates/${GATE}/state/revisions/R0004/STATE_SEAL.json`, clone);
    const result = proof(fixture.root, EVIDENCE);
    assert.equal(result.status, STATUS_BLOCKED);
    assert.notEqual(result.bindingClass, BINDING_CLOSED_STATE_SEAL_MEMBER);
  });
});

test('B10 a broken ledger yields no seal members and never falls back to the permissive inventory', () => {
  run((fixture) => {
    const file = absolute(fixture.root, LEDGER);
    // The classic naive forgery, unchanged in spirit: relabel a status scalar and
    // leave every digest stale. The literal being replaced tracks the canonical
    // fixture's own statuses — the old one ('COMPLETE_AGENT') no longer occurs in
    // this ledger, and a `replace` that silently matches nothing would have made
    // this test assert against an INTACT ledger.
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace('"toStatus":"IN_PROGRESS"', '"toStatus":"COMPLETE_CONFIRMED"');
    assert.notEqual(after, before, 'the hostile edit must actually change the ledger');
    fs.writeFileSync(file, after);
    const inventory = collectAuthenticatedClosedStateSealMembers(fixture.root);
    assert.equal(inventory.authenticated, false);
    assert.deepEqual(inventory.members, []);
    assert.ok(inventory.findings.some((entry) => entry.code === 'AUTHENTICATED_CLOSED_STATE_SEAL_LEDGER_EVIDENCE_INVALID'));
    // The permissive inventory still has members; not taking them is the point.
    assert.ok(collectClosedStateSealMembers(fixture.root).members.length > 0);
    assert.equal(proof(fixture.root, EVIDENCE).status, STATUS_BLOCKED);
  });
});

test('B11 a superseded revision cannot promote its historical mutable projection', () => {
  run((fixture) => {
    const inventory = collectAuthenticatedClosedStateSealMembers(fixture.root);
    // R0001 is IN_PROGRESS here, so the promotion refusal is proven by making the
    // superseded revision CLOSED and observing that its pointer member is skipped
    // while its revision-scoped members are still eligible.
    const seal = readJson(fixture.root, `${R1}/STATE_SEAL.json`);
    seal.payload.executionStatus = 'COMPLETE_AGENT';
    seal.payloadSha256 = sha256Canonical(seal.payload);
    const r1Sha = writeSeal(fixture.root, R1, seal);
    const r2 = readJson(fixture.root, `${R2}/STATE_SEAL.json`);
    r2.previousStateSealSha256 = r1Sha;
    r2.payload.previousStateSealSha256 = r1Sha;
    r2.payloadSha256 = sha256Canonical(r2.payload);
    const r2Sha = writeSeal(fixture.root, R2, r2);
    writeLedger(fixture.root, stateBindingsFor(r1Sha, r2Sha));
    const after = collectAuthenticatedClosedStateSealMembers(fixture.root);
    assert.equal(after.authenticated, true);
    assert.deepEqual(after.findings, []);
    const fromR0001 = after.members.filter((member) => member.stateRevision === 'R0001');
    assert.ok(fromR0001.some((member) => member.repoRelativePath.endsWith('R0001/CHECKPOINT.json')));
    assert.equal(fromR0001.some((member) => member.repoRelativePath === CONTRACT), false);
    assert.ok(after.refusals.some((entry) => entry.code === 'AUTHENTICATED_CLOSED_STATE_SEAL_HISTORICAL_PROJECTION_NOT_PROMOTED'));
    assert.ok(inventory.authenticated);
  });
});

test('B12 the publisher refusal inventory stays permissive and still sees rejected seals', () => {
  run((fixture) => {
    const before = collectClosedStateSealMembers(fixture.root).members.length;
    writeJson(fixture.root, `governance/gates/${GATE}/state/revisions/R0003/STATE_SEAL.json`, {
      gateId: GATE, stateRevision: 'R0003', payload: { status: 'CLOSED' },
      sealedMembers: [identity(fixture.root, UNSEALED)]
    });
    const after = collectClosedStateSealMembers(fixture.root);
    // SEALED_MEMBER_MUTATION must keep refusing what this repair stops promoting.
    assert.equal(after.members.length, before + 1);
    assert.ok(after.members.some((member) => member.repoRelativePath === UNSEALED));
    assert.equal(collectAuthenticatedClosedStateSealMembers(fixture.root).members.some((member) => member.repoRelativePath === UNSEALED), false);
  });
});
