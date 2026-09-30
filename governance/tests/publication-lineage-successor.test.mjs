/**
 * PUBLICATION_LINEAGE_SUCCESSOR — proofs A..H.
 *
 * Every case starts from the SAME ambiguity the existing lineage suite proves
 * (L10: two admissible, concurrently terminal publications of one path) and
 * re-validates that baseline with the canonical validators first, so a refusal
 * caused by a broken fixture cannot pass for a refusal caused by the invariant.
 *
 * The primitive may do exactly one thing: remove ONE named predecessor binding
 * from ONE path's terminal set. Every hostile below asserts the path is left
 * exactly as ambiguous as it was, and names the refusal code that did it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  deriveCurrentByteAuthorizationProof,
  collectCurrentByteBindings,
  STATUS_AUTHORIZED,
  STATUS_BLOCKED,
  REASON_LINEAGE_AMBIGUOUS,
  REASON_UNAUTHORIZED_BYTES,
  BINDING_MAINTENANCE_PUBLICATION
} from '../gee-v1/core/current-byte-authorization.mjs';
import {
  MAINTENANCE_PUBLICATION_BINDING_CLASS,
  RECORD_DOCUMENT,
  OWNER_AUTHORITY_DOCUMENT,
  SUCCESSOR_REFUSAL,
  computeSuccessorEdgeSha256,
  recordPathFor,
  ownerAuthorityPathFor,
  resolvePublicationLineageSuccessorConsumption,
  validatePublicationLineageSuccessorRecordShape,
  validatePublicationLineageSuccessorOwnerAuthorityShape
} from '../gee-v1/core/publication-lineage-successor.mjs';
import * as fixture from './helpers/current-state-bootstrap-lineage-fixture.mjs';

const GATE = fixture.FIXTURE_GATE;
const CS = fixture.CURRENT_STATE_PATH;
const OTHER = 'governance/generated/FIXTURE_SUCCESSOR_OTHER.json';
const UNRELATED = 'governance/generated/FIXTURE_SUCCESSOR_UNRELATED.json';

const proofFor = (root, relativePath = CS) => deriveCurrentByteAuthorizationProof({ root, gateId: GATE, path: relativePath });
const text = (value) => `${JSON.stringify(value, null, 2)}\n`;

function withRoot(body) {
  const root = fixture.makeRoot();
  try { return body(root); } finally { fixture.removeRoot(root); }
}

/** The L10 ambiguity, plus optional extra paths per publication. */
function ambiguous(root, { s1Extra = {}, s2Extra = {} } = {}) {
  fixture.writeAuthorization(root);
  const s1 = fixture.publish(root, { programSuffix: 'S1', paths: { [CS]: fixture.currentStateBytes('R0002'), ...s1Extra } });
  fixture.assertBaselineAdmissible(root, s1, 'baseline/S1');
  const s2 = fixture.publish(root, { programSuffix: 'S2', paths: { [CS]: fixture.currentStateBytes('R0003'), ...s2Extra } });
  fixture.assertBaselineAdmissible(root, s2, 'baseline/S2');
  const proof = proofFor(root);
  assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS, 'baseline must be the L10 ambiguity');
  assert.equal(proof.terminalCount, 2);
  return { s1, s2 };
}

/** One edge side, read from the publication's documents on disk. */
function sideOf(root, publication, relativePath = CS) {
  const consumption = fixture.readJson(root, publication.consumptionPath);
  const entry = consumption.cohort.find((item) => item.path === relativePath);
  return {
    authorityId: publication.authorityId,
    authorityPath: publication.authorityPath,
    authoritySha256: fixture.identity(root, publication.authorityPath).sha256,
    manifestPath: publication.manifestPath,
    manifestSha256: fixture.identity(root, publication.manifestPath).sha256,
    consumptionPath: publication.consumptionPath,
    consumptionSha256: fixture.identity(root, publication.consumptionPath).sha256,
    sha256: entry.sha256,
    byteLength: entry.byteLength
  };
}

/**
 * Writes an Owner authority and its successor record. Mutators run on the parsed
 * documents before they are written; the record pins whatever authority bytes
 * were finally written, unless `mutateRecord` changes that too.
 */
function writeEdge(root, { id, predecessor, successor, relativePath = CS, predecessorPath, successorPath, mutateEdge, mutateAuthority, mutateRecord, recordFileId }) {
  const edge = {
    path: relativePath,
    predecessor: sideOf(root, predecessor, predecessorPath ?? relativePath),
    successor: sideOf(root, successor, successorPath ?? relativePath)
  };
  mutateEdge?.(edge);
  const recordId = `FIXTURE_SUCCESSOR_${id}`;
  const authorityId = `FIXTURE_SUCCESSOR_${id}_OWNER_AUTHORITY`;
  const edgeSha256 = computeSuccessorEdgeSha256(edge);
  const authority = {
    document: OWNER_AUTHORITY_DOCUMENT,
    schemaVersion: 1,
    authorityId,
    authorityClass: 'PROJECT_OWNER_PUBLICATION_LINEAGE_SUCCESSOR_AUTHORITY',
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    gateId: GATE,
    maxUse: 1,
    recordId,
    recordPath: recordPathFor(recordId),
    edge: structuredClone(edge),
    edgeSha256,
    grantsByteAuthorization: false,
    createsPublicationBinding: false,
    rewritesHistoricalArtifacts: false,
    widensAdmission: false
  };
  mutateAuthority?.(authority);
  const authorityPath = ownerAuthorityPathFor(authorityId);
  fixture.writeText(root, authorityPath, text(authority));
  const record = {
    document: RECORD_DOCUMENT,
    schemaVersion: 1,
    recordId,
    gateId: GATE,
    ownerAuthorityId: authorityId,
    ownerAuthorityPath: authorityPath,
    ownerAuthoritySha256: fixture.identity(root, authorityPath).sha256,
    edge,
    edgeSha256,
    grantsByteAuthorization: false,
    createsPublicationBinding: false,
    rewritesHistoricalArtifacts: false,
    widensAdmission: false
  };
  mutateRecord?.(record);
  const recordPath = recordPathFor(recordFileId ?? recordId);
  fixture.writeText(root, recordPath, text(record));
  return { authority, authorityPath, record, recordPath };
}

function refusalCodes(proof) {
  return (proof.lineageSuccessor?.refused ?? []).flatMap((item) => item.findings.map((entry) => entry.code));
}

function assertStillAmbiguous(proof, code, label) {
  assert.equal(proof.status, STATUS_BLOCKED, `${label}: ${JSON.stringify(proof)}`);
  assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS, `${label}: ${JSON.stringify(proof)}`);
  assert.equal(proof.lineageSuccessor?.accepted, false, `${label}: edge must not be accepted`);
  const codes = [...refusalCodes(proof), ...(proof.lineageSuccessor?.findings ?? []).map((entry) => entry.code)];
  assert.ok(codes.includes(code), `${label}: expected ${code}, got ${JSON.stringify(codes)}`);
}

/* ========================================================================== */
/* schema non-vacuity                                                          */
/* ========================================================================== */

test('S0 the restated binding class equals the collector binding class', () => {
  assert.equal(MAINTENANCE_PUBLICATION_BINDING_CLASS, BINDING_MAINTENANCE_PUBLICATION);
});

test('S1 a well-formed record and authority satisfy their closed schemas', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const { authority, record } = writeEdge(root, { id: 'S0', predecessor: s1, successor: s2 });
    assert.deepEqual(validatePublicationLineageSuccessorRecordShape(record), { valid: true, findings: [] });
    assert.deepEqual(validatePublicationLineageSuccessorOwnerAuthorityShape(authority), { valid: true, findings: [] });
  });
});

/* ========================================================================== */
/* A..E                                                                         */
/* ========================================================================== */

test('A no successor record: the existing fixture remains PUBLICATION_LINEAGE_AMBIGUOUS', () => {
  withRoot((root) => {
    ambiguous(root);
    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_BLOCKED);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(proof.terminalCount, 2);
    assert.equal(Object.hasOwn(proof, 'lineageSuccessor'), false, 'no record, no report, no shape change');
  });
});

test('B one valid exact edge: the successor becomes the unique terminal for the named path only', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root, {
      s1Extra: { [OTHER]: text({ other: 'one' }) },
      s2Extra: { [OTHER]: text({ other: 'two' }) }
    });
    assert.equal(proofFor(root, OTHER).reason, REASON_LINEAGE_AMBIGUOUS, 'OTHER is ambiguous too before the edge');
    const { recordPath } = writeEdge(root, { id: 'B', predecessor: s1, successor: s2 });

    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_AUTHORIZED, JSON.stringify(proof));
    assert.equal(proof.programId, s2.programId);
    assert.equal(proof.authorityPath, s2.authorityPath);
    assert.equal(proof.lineageSuccessor.accepted, true);
    assert.deepEqual(proof.lineageSuccessor.applied.map((entry) => entry.recordPath), [recordPath]);

    // The predecessor is consumed ONLY for CS: the same two publications still
    // conflict on OTHER, and nothing reports an edge there.
    const other = proofFor(root, OTHER);
    assert.equal(other.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(Object.hasOwn(other, 'lineageSuccessor'), false);
  });
});

test('B2 the edge authorizes no bytes: predecessor bytes or arbitrary bytes still BLOCK', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'B2', predecessor: s1, successor: s2 });
    fixture.writeText(root, CS, fixture.currentStateBytes('R0002'));
    let proof = proofFor(root);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES, 'replaying the consumed predecessor bytes');
    assert.equal(proof.programId, s2.programId);
    fixture.writeText(root, CS, fixture.currentStateBytes('R0009'));
    proof = proofFor(root);
    assert.equal(proof.reason, REASON_UNAUTHORIZED_BYTES, 'a third state');
  });
});

test('C removing the record restores the ambiguity', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const { recordPath } = writeEdge(root, { id: 'C', predecessor: s1, successor: s2 });
    assert.equal(proofFor(root).status, STATUS_AUTHORIZED);
    fs.rmSync(fixture.absolute(root, recordPath));
    const proof = proofFor(root);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(proof.terminalCount, 2);
    assert.equal(Object.hasOwn(proof, 'lineageSuccessor'), false);
  });
});

test('D removing the Owner authority rejects the edge; the ambiguity remains', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const { authorityPath } = writeEdge(root, { id: 'D', predecessor: s1, successor: s2 });
    assert.equal(proofFor(root).status, STATUS_AUTHORIZED);
    fs.rmSync(fixture.absolute(root, authorityPath));
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.OWNER_AUTHORITY_MISSING, 'D');
  });
});

test('D2 an Owner authority whose bytes changed after the record pinned them is rejected', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const { authorityPath } = writeEdge(root, { id: 'D2', predecessor: s1, successor: s2 });
    fixture.writeText(root, authorityPath, `${fs.readFileSync(fixture.absolute(root, authorityPath), 'utf8')} `);
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.OWNER_AUTHORITY_DIGEST_MISMATCH, 'D2');
  });
});

test('E unrelated paths and publications are byte-for-byte unchanged by a valid edge', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root, {
      s1Extra: { [OTHER]: text({ other: 'one' }) },
      s2Extra: { [OTHER]: text({ other: 'two' }) }
    });
    const unrelated = fixture.publish(root, { programSuffix: 'U1', paths: { [UNRELATED]: text({ unrelated: true }) } });
    fixture.assertBaselineAdmissible(root, unrelated, 'E/U1');

    const watched = [OTHER, UNRELATED, s1.consumptionPath, s2.consumptionPath, unrelated.consumptionPath, ...Object.values(fixture.IMMUTABLE_ROLE_PATHS)];
    const before = Object.fromEntries(watched.map((relativePath) => [relativePath, proofFor(root, relativePath)]));
    const bindingsBefore = collectCurrentByteBindings({ root, gateId: GATE });

    writeEdge(root, { id: 'E', predecessor: s1, successor: s2 });
    assert.equal(proofFor(root).status, STATUS_AUTHORIZED);

    for (const relativePath of watched) assert.deepEqual(proofFor(root, relativePath), before[relativePath], relativePath);
    assert.equal(proofFor(root, UNRELATED).status, STATUS_AUTHORIZED, 'positive control');
    // The primitive creates no binding and refuses no source.
    const bindingsAfter = collectCurrentByteBindings({ root, gateId: GATE });
    assert.deepEqual([...bindingsAfter.bindings.entries()], [...bindingsBefore.bindings.entries()]);
    assert.deepEqual(bindingsAfter.refused, bindingsBefore.refused);
  });
});

test('E2 a record scoped to another Gate is not consulted', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'E2', predecessor: s1, successor: s2, mutateAuthority: (a) => { a.gateId = 'GATE98'; }, mutateRecord: (r) => { r.gateId = 'GATE98'; } });
    const proof = proofFor(root);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(Object.hasOwn(proof, 'lineageSuccessor'), false);
  });
});

/* ========================================================================== */
/* F — hostiles                                                                */
/* ========================================================================== */

test('F1 a record with an unknown forbidden field fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F1', predecessor: s1, successor: s2, mutateRecord: (r) => { r.recordedAt = '2026-01-01T00:00:00.000Z'; } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.RECORD_MALFORMED, 'F1');
  });
});

test('F1b a record missing a required denial fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F1B', predecessor: s1, successor: s2, mutateRecord: (r) => { delete r.grantsByteAuthorization; } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.RECORD_MALFORMED, 'F1b');
  });
});

test('F1c a truncated record makes the registry unreadable and refuses a valid edge on the path', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F1C', predecessor: s1, successor: s2 });
    assert.equal(proofFor(root).status, STATUS_AUTHORIZED);
    fixture.writeText(root, recordPathFor('FIXTURE_SUCCESSOR_TRUNCATED'), '{"document":"PUBLICATION_LINEAGE_SUCC');
    const proof = proofFor(root);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.ok(proof.lineageSuccessor.findings.some((entry) => entry.code === SUCCESSOR_REFUSAL.REGISTRY_UNREADABLE));
  });
});

test('F1d a truncated record alone changes nothing', () => {
  withRoot((root) => {
    ambiguous(root);
    fixture.writeText(root, recordPathFor('FIXTURE_SUCCESSOR_TRUNCATED'), '{"document":');
    const proof = proofFor(root);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(proof.terminalCount, 2);
  });
});

test('F2 a malformed Owner authority fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F2', predecessor: s1, successor: s2, mutateAuthority: (a) => { a.grantsByteAuthorization = true; } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.OWNER_AUTHORITY_MALFORMED, 'F2');
  });
});

test('F2b an Owner authority with an unknown field fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F2B', predecessor: s1, successor: s2, mutateAuthority: (a) => { a.expiresAt = '2099-01-01T00:00:00.000Z'; } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.OWNER_AUTHORITY_MALFORMED, 'F2b');
  });
});

test('F3 a missing publication fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F3', predecessor: s1, successor: s2, mutateEdge: (e) => {
      e.predecessor.authorityPath = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_FIXTURE_ABSENT.json';
    } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.PUBLICATION_MISSING, 'F3');
  });
});

test('F3b an inadmissible publication cannot be named into the lineage', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const s3 = fixture.publish(root, { programSuffix: 'S3', paths: { [CS]: fixture.currentStateBytes('R0004') } });
    fixture.assertBaselineAdmissible(root, s3, 'F3b/S3');
    // Break S3's receipt coherence: its documents still hash as the record claims,
    // but the collector's admissibility now refuses S3.
    fixture.rewrite(root, s3.consumptionPath, (c) => { c.programId = 'FIXTURE_PUBLICATION_FORGED'; });
    assert.ok(collectCurrentByteBindings({ root, gateId: GATE }).refused.some((item) => item.sourcePath === s3.authorityPath));
    fixture.writeText(root, CS, fixture.currentStateBytes('R0004'));
    writeEdge(root, { id: 'F3B', predecessor: s2, successor: s3 });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.PUBLICATION_NOT_ADMITTED, 'F3b');
  });
});

test('F4 a successor whose cohort does not contain the path fails closed', () => {
  withRoot((root) => {
    const { s1 } = ambiguous(root);
    const s3 = fixture.publish(root, { programSuffix: 'S3', paths: { [OTHER]: text({ other: 'three' }) } });
    fixture.assertBaselineAdmissible(root, s3, 'F4/S3');
    writeEdge(root, { id: 'F4', predecessor: s1, successor: s3, successorPath: OTHER });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.PATH_ABSENT_FROM_COHORT, 'F4');
  });
});

test('F5 a successor digest mismatch fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F5', predecessor: s1, successor: s2, mutateEdge: (e) => { e.successor.sha256 = 'f'.repeat(64); } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.DIGEST_MISMATCH, 'F5');
  });
});

test('F5b a predecessor digest mismatch fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F5B', predecessor: s1, successor: s2, mutateEdge: (e) => { e.predecessor.sha256 = e.successor.sha256; } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.DIGEST_MISMATCH, 'F5b');
  });
});

test('F6 a byte-length mismatch fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F6', predecessor: s1, successor: s2, mutateEdge: (e) => { e.successor.byteLength += 1; } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.BYTE_LENGTH_MISMATCH, 'F6');
  });
});

test('F6b a publication document identity mismatch fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F6B', predecessor: s1, successor: s2, mutateEdge: (e) => { e.predecessor.consumptionSha256 = '0'.repeat(64); } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.PUBLICATION_IDENTITY_MISMATCH, 'F6b');
  });
});

for (const [id, label, mutateAuthority, mutateRecord, code] of [
  ['F7A', 'authority names another record', (a) => { a.recordId = 'FIXTURE_SUCCESSOR_ELSEWHERE'; }, null, SUCCESSOR_REFUSAL.CROSS_BINDING_MISMATCH],
  ['F7B', 'authority restates a different edge', (a) => { [a.edge.predecessor, a.edge.successor] = [a.edge.successor, a.edge.predecessor]; }, null, SUCCESSOR_REFUSAL.CROSS_BINDING_MISMATCH],
  ['F7C', 'authority names another gate', (a) => { a.gateId = 'GATE98'; }, null, SUCCESSOR_REFUSAL.CROSS_BINDING_MISMATCH],
  ['F7D', 'record pins the wrong authority digest', null, (r) => { r.ownerAuthoritySha256 = '1'.repeat(64); }, SUCCESSOR_REFUSAL.OWNER_AUTHORITY_DIGEST_MISMATCH],
  ['F7E', 'record edge digest does not match its edge', null, (r) => { r.edgeSha256 = '2'.repeat(64); }, SUCCESSOR_REFUSAL.EDGE_DIGEST_MISMATCH],
  ['F7F', 'record names an authority id that is not at its path', null, (r) => { r.ownerAuthorityId = 'FIXTURE_SUCCESSOR_OTHER_OWNER_AUTHORITY'; }, SUCCESSOR_REFUSAL.CROSS_BINDING_MISMATCH]
]) {
  test(`${id} bad cross-binding (${label}) fails closed`, () => {
    withRoot((root) => {
      const { s1, s2 } = ambiguous(root);
      writeEdge(root, { id, predecessor: s1, successor: s2, mutateAuthority: mutateAuthority ?? undefined, mutateRecord: mutateRecord ?? undefined });
      assertStillAmbiguous(proofFor(root), code, id);
    });
  });
}

test('F7G a record stored under a name other than its recordId fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F7G', predecessor: s1, successor: s2, recordFileId: 'FIXTURE_SUCCESSOR_RENAMED' });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.RECORD_PATH_MISMATCH, 'F7G');
  });
});

test('F7H one Owner authority cannot back two records', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const { record } = writeEdge(root, { id: 'F7H', predecessor: s1, successor: s2 });
    fixture.writeText(root, recordPathFor('FIXTURE_SUCCESSOR_F7H_COPY'), text({ ...record, recordId: 'FIXTURE_SUCCESSOR_F7H_COPY' }));
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.OWNER_AUTHORITY_REUSED, 'F7H');
  });
});

test('F8 a two-edge cycle fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F8A', predecessor: s1, successor: s2 });
    writeEdge(root, { id: 'F8B', predecessor: s2, successor: s1 });
    const proof = proofFor(root);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.ok(proof.lineageSuccessor.findings.some((entry) => entry.code === SUCCESSOR_REFUSAL.CYCLE));
    assert.equal(proof.lineageSuccessor.accepted, false);
  });
});

test('F8b a self-succession fails closed', () => {
  withRoot((root) => {
    const { s1 } = ambiguous(root);
    writeEdge(root, { id: 'F8C', predecessor: s1, successor: s1 });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.CYCLE, 'F8b');
  });
});

test('F8c an edge that closes a loop with the existing pre-state chain fails closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F8D', predecessor: s1, successor: s2 });
    const collected = collectCurrentByteBindings({ root, gateId: GATE }).bindings.get(CS);
    const valid = resolvePublicationLineageSuccessorConsumption({ root, gateId: GATE, path: CS, candidates: collected });
    assert.equal(valid.report.accepted, true, 'non-vacuity: the edge alone is valid');

    // S1 now declares S2's output as its own pre-state: S2 -> S1 causally, and the
    // record says S1 -> S2. Applying the edge would leave no terminal at all.
    const s2Digest = collected.find((c) => c.authorityPath === s2.authorityPath).candidateSha256;
    const looped = collected.map((c) => (c.authorityPath === s1.authorityPath ? { ...c, prestateSha256: s2Digest } : c));
    const result = resolvePublicationLineageSuccessorConsumption({ root, gateId: GATE, path: CS, candidates: looped });
    assert.equal(result.consumed.size, 0);
    assert.equal(result.report.accepted, false);
    assert.ok(result.report.findings.some((entry) => entry.code === SUCCESSOR_REFUSAL.CYCLE));
  });
});

test('F8d with no registry the resolver is inert for any candidate set', () => {
  withRoot((root) => {
    const a = { bindingClass: MAINTENANCE_PUBLICATION_BINDING_CLASS, candidateSha256: 'a'.repeat(64), prestateSha256: null };
    const result = resolvePublicationLineageSuccessorConsumption({ root, gateId: GATE, path: CS, candidates: [a] });
    assert.deepEqual(result, { consumed: new Set(), attributed: false, report: null });
  });
});

test('F9 conflicting successor branches fail closed', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const s3 = fixture.publish(root, { programSuffix: 'S3', paths: { [CS]: fixture.currentStateBytes('R0004') } });
    fixture.assertBaselineAdmissible(root, s3, 'F9/S3');
    writeEdge(root, { id: 'F9A', predecessor: s1, successor: s2 });
    writeEdge(root, { id: 'F9B', predecessor: s1, successor: s3 });
    const proof = proofFor(root);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(proof.terminalCount, 3, 'no edge applied: all three publications stay terminal');
    assert.ok(proof.lineageSuccessor.findings.some((entry) => entry.code === SUCCESSOR_REFUSAL.CONFLICTING_SUCCESSORS));
  });
});

test('F10 one refused record on a path refuses every edge on that path', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    writeEdge(root, { id: 'F10A', predecessor: s1, successor: s2 });
    writeEdge(root, { id: 'F10B', predecessor: s1, successor: s2, mutateEdge: (e) => { e.successor.byteLength += 1; } });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.BYTE_LENGTH_MISMATCH, 'F10');
  });
});

/* ========================================================================== */
/* G — same-digest branching uses only the existing collapse                    */
/* ========================================================================== */

test('G1 after a valid edge, identical-digest terminals collapse exactly as before', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const s3 = fixture.publish(root, { programSuffix: 'S3', paths: { [CS]: fixture.currentStateBytes('R0003') } });
    fixture.assertBaselineAdmissible(root, s3, 'G1/S3');
    assert.equal(proofFor(root).reason, REASON_LINEAGE_AMBIGUOUS, 'S1 still competes before the edge');
    writeEdge(root, { id: 'G1', predecessor: s1, successor: s2 });
    const proof = proofFor(root);
    assert.equal(proof.status, STATUS_AUTHORIZED, JSON.stringify(proof));
    assert.equal(proof.candidateSha256, fixture.identity(root, CS).sha256);
  });
});

test('G2 two same-digest successor branches are still a conflict: no new collapse is invented', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const s3 = fixture.publish(root, { programSuffix: 'S3', paths: { [CS]: fixture.currentStateBytes('R0003') } });
    writeEdge(root, { id: 'G2A', predecessor: s1, successor: s2 });
    writeEdge(root, { id: 'G2B', predecessor: s1, successor: s3 });
    assertStillAmbiguous(proofFor(root), SUCCESSOR_REFUSAL.CONFLICTING_SUCCESSORS, 'G2');
  });
});

test('G3 consumption is by identity: a same-digest sibling of the predecessor stays terminal', () => {
  withRoot((root) => {
    const { s1, s2 } = ambiguous(root);
    const s4 = fixture.publish(root, { programSuffix: 'S4', paths: { [CS]: fixture.currentStateBytes('R0002') } });
    fixture.assertBaselineAdmissible(root, s4, 'G3/S4');
    fixture.writeText(root, CS, fixture.currentStateBytes('R0003'));
    writeEdge(root, { id: 'G3', predecessor: s1, successor: s2 });
    const proof = proofFor(root);
    assert.equal(proof.reason, REASON_LINEAGE_AMBIGUOUS);
    assert.equal(proof.terminalCount, 2, 'S4 and S2 remain; only S1 was consumed');
    assert.equal(proof.lineageSuccessor.accepted, true, 'the edge itself was valid');
  });
});
