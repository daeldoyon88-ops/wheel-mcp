/**
 * CURRENT_STATE BOOTSTRAP LINEAGE — L1..L16.
 *
 * THE DEFECT UNDER PROOF. `GATE_AUTHORIZATION_RECORD` pins a digest for every
 * state-cohort role. Three of those roles sit at revision-scoped paths and are
 * immutable, so their pin is a permanent obligation. CURRENT_STATE is not one of
 * them: it is the MUTABLE_PROJECTION that names which revision is current, and
 * `validate-status-ledger` already skips the exact-byte comparison for it,
 * re-imposing the pin only while the pointer still names the authorization-time
 * revision.
 *
 * The current-byte layer did not know that. It admitted the authorization-time
 * CURRENT_STATE digest as a permanent lineage ROOT, so once a governed
 * publication legitimately advanced the pointer there were two terminal
 * candidates for one path and the answer was PUBLICATION_LINEAGE_AMBIGUOUS —
 * forever, and for no governance reason.
 *
 * WHAT IS AND IS NOT CLAIMED HERE. The repair removes ONE non-answer: a
 * bootstrap pin stops competing once a real publication exists. It does not make
 * the projection's bytes free (L5), it does not let obsolete bytes be replayed
 * (L9), it does not resolve a genuine conflict between two publications (L10),
 * and it does not touch the immutable roles (L13..L15). Every one of those is
 * asserted below at its exact boundary rather than by absence of a pass.
 *
 * NON-VACUITY. A suite of refusals proves nothing if the fixture never worked.
 * Every hostile case starts from a baseline re-validated by the canonical
 * validators (`assertBaselineAdmissible`), and every BLOCK asserts WHICH
 * candidate the derivation reached, so a refusal caused by a broken fixture
 * cannot be mistaken for a refusal caused by the invariant. L1, L3, L4 and L16
 * are positive controls that must genuinely pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  deriveCurrentByteAuthorizationProof,
  collectCurrentByteBindings,
  STATUS_AUTHORIZED,
  STATUS_BLOCKED,
  REASON_UNAUTHORIZED_BYTES,
  REASON_LINEAGE_AMBIGUOUS,
  REASON_NO_APPLICABLE_AUTHORITY,
  BINDING_MAINTENANCE_PUBLICATION,
  BINDING_GATE_AUTHORIZATION_STATE_ARTIFACT,
  BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP
} from '../gee-v1/core/current-byte-authorization.mjs';
import { gateAuthorizationRecordPath } from '../gee-v1/core/gate-authorization-authority.mjs';
import * as fixture from './helpers/current-state-bootstrap-lineage-fixture.mjs';

const GATE = fixture.FIXTURE_GATE;
const CURRENT_STATE = fixture.CURRENT_STATE_PATH;
const RECORD = gateAuthorizationRecordPath(GATE);

/** Runs the production derivation over a fixture root. */
function proofFor(root, relativePath = CURRENT_STATE) {
  return deriveCurrentByteAuthorizationProof({ root, gateId: GATE, path: relativePath });
}

function bindingsFor(root, relativePath = CURRENT_STATE) {
  return collectCurrentByteBindings({ root, gateId: GATE }).bindings.get(relativePath) ?? [];
}

/** Builds a root, runs `body`, and always removes it. */
function withRoot(body) {
  const root = fixture.makeRoot();
  try { return body(root); } finally { fixture.removeRoot(root); }
}

/* ========================================================================== */
/* CASE A — the bootstrap pin still proves the INITIAL state                  */
/* ========================================================================== */

test('L1 initial CURRENT_STATE equal to the bootstrap pin, no successor, is AUTHORIZED', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    fixture.assertBaselineAdmissible(root, null, 'L1');

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_AUTHORIZED, JSON.stringify(proof));
    // The pin did the work, and says so by name.
    assert.equal(proof.bindingClass, BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP);
    assert.equal(proof.authorityPath, RECORD);
    assert.equal(proof.candidateCount, 1);
    assert.equal(proof.candidateSha256, proof.currentSha256);
  });
});

test('L2 initial CURRENT_STATE differing by one byte, no successor, BLOCKS at the pin', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    fixture.assertBaselineAdmissible(root, null, 'L2');
    const pinned = proofFor(root).candidateSha256;

    // One byte, appended. Nothing else about the fixture changes.
    fs.appendFileSync(fixture.absolute(root, CURRENT_STATE), ' ');

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES);
    // BOUNDARY: it reached the byte comparison against the bootstrap pin — it did
    // not fail earlier for want of an authority, which would prove nothing.
    assert.equal(proof.bindingClass, BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP);
    assert.equal(proof.candidateSha256, pinned);
    assert.notEqual(proof.currentSha256, pinned);
  });
});

/* ========================================================================== */
/* CASE B — a legitimate successor decides the lineage                        */
/* ========================================================================== */

test('L3 a valid successor publication authorizes the advanced bytes', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L3');

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_AUTHORIZED, JSON.stringify(proof));
    assert.equal(proof.bindingClass, BINDING_MAINTENANCE_PUBLICATION);
    assert.equal(proof.programId, publication.programId);
    assert.equal(proof.consumptionPath, publication.consumptionPath);
  });
});

test('L4 the bootstrap pin is still collected but is no longer a terminal candidate', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const bootstrapPin = fixture.readJson(root, RECORD)
      .authorizedStateArtifacts.find((artifact) => artifact.cohortRole === 'CURRENT_STATE').sha256;
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L4');

    // The bootstrap binding is NOT deleted — it is still recognised, still names
    // the authorization-time bytes, and is still reported as a candidate.
    const candidates = bindingsFor(root);
    assert.equal(candidates.length, 2);
    const bootstrap = candidates.find((entry) => entry.bindingClass === BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP);
    assert.ok(bootstrap, 'the bootstrap binding must still be collected');
    assert.equal(bootstrap.bootstrapOnly, true);
    assert.equal(bootstrap.candidateSha256, bootstrapPin);
    assert.equal(bootstrap.cohortRole, 'CURRENT_STATE');

    // ...and yet exactly one candidate is terminal, so there is no ambiguity.
    const proof = proofFor(root);
    assert.equal(proof.candidateCount, 2);
    assert.equal(proof.status, STATUS_AUTHORIZED);
    assert.notEqual(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(proof.bindingClass, BINDING_MAINTENANCE_PUBLICATION);
  });
});

/* ========================================================================== */
/* CASE C — arbitrary mutation is never excused                               */
/* ========================================================================== */

test('L5 a valid successor plus an arbitrary third state BLOCKS against the successor', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L5');
    const certified = proofFor(root).candidateSha256;

    // Neither the pin nor the publication ever certified these bytes.
    fixture.writeText(root, CURRENT_STATE, fixture.currentStateBytes('R0007'));

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES);
    // BOUNDARY: the SUCCESSOR is what it was measured against. "Mutable" did not
    // become "unbound".
    assert.equal(proof.bindingClass, BINDING_MAINTENANCE_PUBLICATION);
    assert.equal(proof.candidateSha256, certified);
    assert.notEqual(proof.currentSha256, certified);
  });
});

/* ========================================================================== */
/* tampering with the documents that carry the bindings                       */
/* ========================================================================== */

test('L6 a tampered bootstrap digest BLOCKS where the bootstrap is the only authority', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    fixture.assertBaselineAdmissible(root, null, 'L6');
    const forged = 'b'.repeat(64);

    fixture.rewriteAuthorization(root, (record) => {
      const artifact = record.authorizedStateArtifacts.find((entry) => entry.cohortRole === 'CURRENT_STATE');
      artifact.sha256 = forged;
    });

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES);
    // BOUNDARY: the forged digest is what the untouched bytes were judged against.
    assert.equal(proof.candidateSha256, forged);
    assert.equal(proof.bindingClass, BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP);
  });
});

test('L6b a structurally invalid authorization record yields no binding at all', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    fixture.rewriteAuthorization(root, (record) => { record.authorizationId = 'not-a-valid-id'; });

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    // A record that fails its own shape validator contributes nothing — it is not
    // partially trusted for the roles that happen to still parse.
    assert.equal(proof.reason, REASON_NO_APPLICABLE_AUTHORITY);
    assert.equal(proof.candidateCount, 0);
  });
});

test('L7 a tampered bootstrap byteLength BLOCKS even when the digest matches', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    fixture.assertBaselineAdmissible(root, null, 'L7');

    fixture.rewriteAuthorization(root, (record) => {
      const artifact = record.authorizedStateArtifacts.find((entry) => entry.cohortRole === 'CURRENT_STATE');
      artifact.byteLength = artifact.byteLength + 1;
    });

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES);
    // BOUNDARY: the digest agreed and it still blocked, so the length gate — not
    // the digest gate — is what refused.
    assert.equal(proof.candidateSha256, proof.currentSha256);
  });
});

test('L8 a tampered successor manifest pin falls back to the bootstrap and BLOCKS', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L8');
    const bootstrapPin = fixture.readJson(root, RECORD)
      .authorizedStateArtifacts.find((artifact) => artifact.cohortRole === 'CURRENT_STATE').sha256;

    // The manifest file no longer hashes to the digest its authority pinned.
    fixture.rewrite(root, publication.manifestPath, (manifest) => { manifest.manifestId = 'FIXTURE_S1_RENAMED'; });

    const collected = collectCurrentByteBindings({ root, gateId: GATE });
    assert.ok(
      collected.refused.some((entry) => entry.sourcePath === publication.authorityPath),
      `the tampered source must be refused, not silently dropped: ${JSON.stringify(collected.refused)}`
    );

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES);
    // BOUNDARY: with the publication refused, the bootstrap pin is the only
    // remaining authority and the advanced bytes are judged against it. A tampered
    // successor cannot leave the path unbound.
    assert.equal(proof.bindingClass, BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP);
    assert.equal(proof.candidateSha256, bootstrapPin);
  });
});

test('L8b a tampered successor cohort digest BLOCKS against the tampered value', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L8b');
    const forged = 'c'.repeat(64);

    fixture.rewrite(root, publication.consumptionPath, (consumption) => {
      consumption.cohort.find((entry) => entry.path === CURRENT_STATE).sha256 = forged;
    });

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES);
    assert.equal(proof.candidateSha256, forged);
  });
});

/* ========================================================================== */
/* CASE E — the bootstrap pin is not a replay escape hatch                    */
/* ========================================================================== */

test('L9 replaying the obsolete bootstrap bytes after a valid successor BLOCKS', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const bootstrapBytes = fs.readFileSync(fixture.absolute(root, CURRENT_STATE));
    const bootstrapPin = fixture.readJson(root, RECORD)
      .authorizedStateArtifacts.find((artifact) => artifact.cohortRole === 'CURRENT_STATE').sha256;
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L9');
    const certified = proofFor(root).candidateSha256;
    assert.equal(proofFor(root).status, STATUS_AUTHORIZED, 'the successor state must be authorized before the replay');

    // The projection legitimately advanced. An attacker now restores the exact
    // authorization-time bytes, with no publication authorizing the reversion.
    fs.writeFileSync(fixture.absolute(root, CURRENT_STATE), bootstrapBytes);

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED, 'obsolete bootstrap bytes must not be replayable');
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES);
    // BOUNDARY: judged against the SUCCESSOR. The bootstrap pin exactly matches
    // the restored bytes and still did not authorize them — which is the whole
    // point of it no longer being a candidate.
    assert.equal(proof.bindingClass, BINDING_MAINTENANCE_PUBLICATION);
    assert.equal(proof.candidateSha256, certified);
    assert.equal(proof.currentSha256, bootstrapPin);
  });
});

/* ========================================================================== */
/* CASE D — a genuine conflict still blocks                                   */
/* ========================================================================== */

test('L10 two concurrently terminal successor publications remain LINEAGE_AMBIGUOUS', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const first = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, first, 'L10/first');
    const second = fixture.publish(root, {
      programSuffix: 'S2',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0003') }
    });
    fixture.assertBaselineAdmissible(root, second, 'L10/second');

    // Both publications are admissible, neither declares the other's output as its
    // own pre-state, and they certify different digests.
    const candidates = bindingsFor(root);
    const publications = candidates.filter((entry) => entry.bindingClass === BINDING_MAINTENANCE_PUBLICATION);
    assert.equal(publications.length, 2);
    assert.notEqual(publications[0].candidateSha256, publications[1].candidateSha256);

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS, 'a real conflict must not be resolved by preference');
    assert.equal(proof.terminalCount, 2);
    // The bootstrap rule removed a non-answer, not a conflict: dropping it left
    // TWO terminals, not one.
  });
});

/* ========================================================================== */
/* the derivation reads documents, and nothing else                           */
/* ========================================================================== */

test('L11 future Git state cannot change the result', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L11');
    const before = proofFor(root);
    assert.equal(before.status, STATUS_AUTHORIZED);

    // A repository history appears, claiming anything it likes.
    fixture.writeText(root, '.git/HEAD', 'ref: refs/heads/main\n');
    fixture.writeText(root, '.git/refs/heads/main', `${'f'.repeat(40)}\n`);
    fixture.writeText(root, '.git/FUTURE_STATE', 'a later commit reverted this path\n');

    assert.deepEqual(proofFor(root), before, 'the derivation must not consult Git');
  });
});

test('L12 an unrelated future ledger append cannot retroactively authorize bytes', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const publication = fixture.publish(root, {
      programSuffix: 'S1',
      paths: { [CURRENT_STATE]: fixture.currentStateBytes('R0002') }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L12');
    fixture.writeText(root, CURRENT_STATE, fixture.currentStateBytes('R0009'));
    const blockedBefore = proofFor(root);
    assert.equal(blockedBefore.status, STATUS_BLOCKED);

    // Events are appended that say the state advanced. They bind no bytes, and the
    // derivation does not read them.
    const events = [
      { gateId: GATE, ordinal: 1, stateRevision: 'R0002', toStatus: 'COMPLETE_AGENT' },
      { gateId: GATE, ordinal: 2, stateRevision: 'R0009', toStatus: 'COMPLETE_AGENT' }
    ].map((event) => JSON.stringify(event)).join('\n');
    fixture.writeText(root, 'governance/state/GATE_STATUS_LEDGER.ndjson', `${events}\n`);

    assert.deepEqual(proofFor(root), blockedBefore, 'a ledger append must not authorize bytes');
  });
});

/* ========================================================================== */
/* L13..L15 — the immutable roles are untouched by this repair                 */
/* ========================================================================== */

for (const [id, cohortRole] of [['L13', 'CHECKPOINT'], ['L14', 'OPEN_DEFECTS'], ['L15', 'STATE_SEAL']]) {
  const rolePath = fixture.IMMUTABLE_ROLE_PATHS[cohortRole];

  test(`${id} ${cohortRole} keeps exact pin semantics`, () => {
    withRoot((root) => {
      fixture.writeAuthorization(root);
      fixture.assertBaselineAdmissible(root, null, id);

      // Untouched bytes pass, and NOT through the bootstrap class — this role was
      // never reclassified.
      const clean = proofFor(root, rolePath);
      assert.equal(clean.status, STATUS_AUTHORIZED, JSON.stringify(clean));
      assert.equal(clean.bindingClass, BINDING_GATE_AUTHORIZATION_STATE_ARTIFACT);
      assert.notEqual(clean.bindingClass, BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP);

      const collected = bindingsFor(root, rolePath);
      assert.equal(collected.length, 1);
      assert.equal(collected[0].bootstrapOnly, false, `${cohortRole} must not be treated as a bootstrap binding`);

      // One byte, and it blocks against the pin.
      fs.appendFileSync(fixture.absolute(root, rolePath), ' ');
      const mutated = proofFor(root, rolePath);
      assert.equal(mutated.status, STATUS_BLOCKED);
      assert.equal(mutated.reason, REASON_UNAUTHORIZED_BYTES);
      assert.equal(mutated.candidateSha256, clean.candidateSha256);
    });
  });

  test(`${id}b a publication cannot silently supersede the ${cohortRole} pin`, () => {
    withRoot((root) => {
      fixture.writeAuthorization(root);
      // A publication certifies DIFFERENT bytes for an immutable role. For
      // CURRENT_STATE this would settle the lineage; here the authorization pin
      // must keep competing, so the contradiction surfaces instead of resolving.
      const publication = fixture.publish(root, {
        programSuffix: 'S1',
        paths: { [rolePath]: `${JSON.stringify({ gateId: GATE, rewritten: cohortRole }, null, 2)}\n` }
      });
      fixture.assertBaselineAdmissible(root, publication, `${id}b`);

      const candidates = bindingsFor(root, rolePath);
      assert.equal(candidates.length, 2);
      assert.equal(candidates.every((entry) => entry.bootstrapOnly !== true), true,
        `no ${cohortRole} binding may be bootstrapOnly`);

      const proof = proofFor(root, rolePath);
      assert.equal(proof.status, STATUS_BLOCKED);
      assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS,
        'an immutable role with two competing terminals must block, not pick one');
      assert.equal(proof.terminalCount, 2);
    });
  });
}

/* ========================================================================== */
/* L16 — positive non-vacuity control                                          */
/* ========================================================================== */

test('L16 an unrelated legitimate maintenance publication still succeeds', () => {
  withRoot((root) => {
    fixture.writeAuthorization(root);
    const unrelated = 'governance/generated/FIXTURE_REPORT.json';
    const publication = fixture.publish(root, {
      programSuffix: 'M1',
      paths: {
        [unrelated]: `${JSON.stringify({ report: 'ordinary maintenance' }, null, 2)}\n`,
        [CURRENT_STATE]: fixture.currentStateBytes('R0002')
      }
    });
    fixture.assertBaselineAdmissible(root, publication, 'L16');

    // The unrelated path is authorized on its own terms...
    const unrelatedProof = proofFor(root, unrelated);
    assert.equal(unrelatedProof.status, STATUS_AUTHORIZED, JSON.stringify(unrelatedProof));
    assert.equal(unrelatedProof.bindingClass, BINDING_MAINTENANCE_PUBLICATION);

    // ...and so is every other path the same publication certified, plus the
    // untouched immutable roles. The suite is not refusing everything.
    for (const relativePath of [CURRENT_STATE, ...Object.values(fixture.IMMUTABLE_ROLE_PATHS)]) {
      assert.equal(proofFor(root, relativePath).status, STATUS_AUTHORIZED, `${relativePath} must remain authorized`);
    }
  });
});
