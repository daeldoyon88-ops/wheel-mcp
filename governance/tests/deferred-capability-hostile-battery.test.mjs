/**
 * DEFERRED CAPABILITY REGISTRY — hostile battery.
 *
 * Independent of the normal suite on purpose: it builds its own fixtures and
 * imports only the shipped primitives, so it stays meaningful if the normal suite
 * is ever weakened. Every case constructs a registry that a careless or hostile
 * writer would want accepted and asserts the exact finding that refuses it.
 *
 * The cases that matter most are the quiet ones. H05 and H25 are the anti-forget
 * mechanism's real threat model: not a forged record, but a capability that drifts
 * into ACTIVE without anybody deciding to promote it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  computeEventPayloadSha256, computeEvidenceCohortDigest,
  parseRegistry, readVocabulary, replayRegistry, validateDeferredCapabilityRegistry,
  REGISTRY_PATH, VOCABULARY_PATH
} from '../tools/validate-deferred-capability-registry.mjs';
import {
  generateDeferredCapabilityIndex, writeDeferredCapabilityIndex,
  checkDeferredCapabilityIndex, INDEX_PATH
} from '../tools/generate-deferred-capability-index.mjs';
import { runPreexecutionReuseCheck } from '../tools/gate-preexecution-reuse-check.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const AUTHORITY_REL = 'governance/sources/TEST_DEFERRED_CAPABILITY_AUTHORITY.json';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-hostile-'));
  for (const dir of ['master-matrix', 'sources', 'generated']) {
    fs.mkdirSync(path.join(root, 'governance', dir), { recursive: true });
  }
  fs.copyFileSync(path.resolve(REPO_ROOT, ...VOCABULARY_PATH.split('/')), path.join(root, ...VOCABULARY_PATH.split('/')));
  fs.writeFileSync(path.join(root, ...AUTHORITY_REL.split('/')), '{"document":"TEST_AUTHORITY"}\n');
  return root;
}

const authorityDigest = (root) => sha256(fs.readFileSync(path.join(root, ...AUTHORITY_REL.split('/'))));

function makeEvent({ root, ordinal, previous, eventType, id, payload, authorityPath = AUTHORITY_REL, authoritySha256 = null, eventId }) {
  const base = {
    schemaVersion: 1,
    eventId: eventId ?? `E${String(ordinal).padStart(4, '0')}`,
    ordinal,
    recordedAt: '2026-08-25T20:00:00.000Z',
    eventType,
    deferredCapabilityId: id,
    authorityPath,
    authoritySha256: authoritySha256 ?? authorityDigest(root),
    payload
  };
  return { ...base, previousEventSha256: previous, eventPayloadSha256: computeEventPayloadSha256(base) };
}

function entryPayload(overrides = {}) {
  return {
    sourceGate: 'GATE24',
    capabilityName: 'deferred capability under test',
    capabilityClass: 'REGISTERED_NOT_ACTIVE_IN_CORE_V1',
    status: 'REGISTERED',
    disposition: 'OPEN',
    reasonDeferred: ['TAXONOMY_INTENTIONALLY_DEFERRED'],
    reasonVocabularyVersion: 'V1',
    promotionRequirements: [],
    consumerCandidates: [],
    mustRevisitByGate: 'GATE26',
    ownerPromotionRequired: false,
    currentVersion: 'REGIME_VECTOR_V1',
    ...overrides
  };
}

function writeChain(root, specs) {
  const events = [];
  let previous = null;
  specs.forEach((spec, index) => {
    const event = makeEvent({ root, ordinal: index + 1, previous, ...spec });
    previous = event.eventPayloadSha256;
    events.push(event);
  });
  writeEvents(root, events);
  return events;
}

function writeEvents(root, events) {
  fs.writeFileSync(
    path.join(root, ...REGISTRY_PATH.split('/')),
    events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
  );
}

function replay(root) {
  const text = fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8');
  return replayRegistry({ events: parseRegistry(text), vocabulary: readVocabulary(root), root });
}

const codes = (result) => result.findings.map((entry) => entry.code);

/** A promotion payload that satisfies everything, so each case can break exactly one thing. */
function goodPromotion(overrides = {}) {
  const cohort = [
    { evidenceRole: 'PROMOTION_TEST_EVIDENCE', governedPath: 'governance/tests/deferred-capability-hostile-battery.test.mjs', byteLength: 10, sha256: 'a'.repeat(64) }
  ];
  return {
    authorityIssuedBy: 'PROJECT_OWNER',
    promotedIntoVersion: 'REGIME_VECTOR_V2',
    retroactiveMutation: false,
    evidenceCohort: cohort,
    evidenceCohortDigest: computeEvidenceCohortDigest(cohort),
    requirementEvidenceMap: [],
    consumerCompatibility: [],
    ...overrides
  };
}

test('H01 a second REGISTER for a live identity is refused', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ capabilityName: 'impostor' }) }
  ]);
  const result = replay(root);
  assert.ok(codes(result).includes('DUPLICATE_DEFERRED_CAPABILITY_IDENTITY'));
  assert.equal(result.entries[0].capabilityName, 'deferred capability under test');
});

test('H02 append and replay are deterministic across repeated runs', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'RESTATE', id: 'GATE24-DC-01', payload: { status: 'DEFERRED' } }
  ]);
  const runs = [replay(root), replay(root), replay(root)].map((result) => JSON.stringify(result.entries));
  assert.equal(new Set(runs).size, 1);
});

test('H03 a tampered previousEventSha256 breaks the chain at the exact ordinal', () => {
  const root = makeRoot();
  const events = writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'RESTATE', id: 'GATE24-DC-01', payload: { status: 'READY' } }
  ]);
  events[1].previousEventSha256 = 'e'.repeat(64);
  writeEvents(root, events);
  const result = replay(root);
  assert.ok(codes(result).includes('REGISTRY_CHAIN_BROKEN'));
  assert.ok(result.findings.some((entry) => entry.code === 'REGISTRY_CHAIN_BROKEN' && entry.detail === '#2'));
});

test('H04 any event after a terminal disposition is refused', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'RETIRE', id: 'GATE24-DC-01', payload: { retirementRationale: 'Superseded by a different architecture.' } },
    { eventType: 'RESTATE', id: 'GATE24-DC-01', payload: { status: 'READY' } }
  ]);
  const result = replay(root);
  assert.ok(codes(result).includes('TERMINAL_DISPOSITION_IMMUTABLE'));
  assert.equal(result.entries[0].disposition, 'RETIRED');
});

test('H05 RESTATE can never set ACTIVE — activation is not a side effect', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'RESTATE', id: 'GATE24-DC-01', payload: { status: 'ACTIVE' } }
  ]);
  const result = replay(root);
  assert.ok(codes(result).includes('IMPLICIT_ACTIVATION_FORBIDDEN'));
  assert.equal(result.entries[0].status, 'REGISTERED');
  assert.equal(result.entries[0].disposition, 'OPEN');
});

test('H06 a promotion requirement with no mapped evidence is unproven', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ promotionRequirements: ['owner-ratified taxonomy'] }) },
    { eventType: 'PROMOTE', id: 'GATE24-DC-01', payload: goodPromotion() }
  ]);
  const result = replay(root);
  assert.ok(codes(result).includes('PROMOTION_REQUIREMENT_UNPROVEN'));
  assert.notEqual(result.entries[0].status, 'ACTIVE');
});

test('H07 ownerPromotionRequired refuses a non-Owner promotion', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ ownerPromotionRequired: true }) },
    { eventType: 'PROMOTE', id: 'GATE24-DC-01', payload: goodPromotion({ authorityIssuedBy: 'GATE_AGENT' }) }
  ]);
  const result = replay(root);
  assert.ok(codes(result).includes('OWNER_PROMOTION_AUTHORITY_REQUIRED'));
  assert.equal(result.entries[0].disposition, 'OPEN');
});

test('H08 missing, empty and "later" reasons are all refused', () => {
  for (const reasons of [undefined, [], ['later'], ['  LATER  '], ['']]) {
    const root = makeRoot();
    const payload = entryPayload();
    if (reasons === undefined) delete payload.reasonDeferred; else payload.reasonDeferred = reasons;
    writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload }]);
    assert.ok(codes(replay(root)).includes('REASON_DEFERRED_REQUIRED'), JSON.stringify(reasons));
  }
});

test('H09 an off-vocabulary reason is refused, including a plausible paraphrase', () => {
  for (const token of ['NOT_REQUIRED_BY_CURRENT_CORE', 'CLASSIFIER_ROLE_NOT_PROVEN', 'INVENTED_REASON']) {
    const root = makeRoot();
    writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ reasonDeferred: [token] }) }]);
    assert.ok(codes(replay(root)).includes('REASON_NOT_IN_VOCABULARY'), token);
  }
});

test('H10 an entry with neither revisit trigger is refused', () => {
  const root = makeRoot();
  writeChain(root, [{
    eventType: 'REGISTER', id: 'GATE24-DC-01',
    payload: entryPayload({ mustRevisitByGate: null, eventBasedRevisitTrigger: null })
  }]);
  assert.ok(codes(replay(root)).includes('REVISIT_TRIGGER_REQUIRED'));
});

test('H11 readiness resurfaces an undecided commitment targeting the gate', async () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ mustRevisitByGate: 'GATE26' }) }]);
  writeDeferredCapabilityIndex({ root });
  const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE26' });
  const check = report.checks.find((entry) => entry.id === 'DEFERRED_CAPABILITY_COMMITMENTS');
  assert.ok(check, 'the readiness check must exist');
  assert.equal(check.status, 'FAIL');
  assert.equal(check.class, 'PREEXECUTION_GAP');
  assert.deepEqual(check.detail.undecidedIds, ['GATE24-DC-01']);
  assert.deepEqual(report.reuse.deferredCapabilityCommitments.map((entry) => entry.deferredCapabilityId), ['GATE24-DC-01']);
});

test('H12 KEEP_DEFERRED satisfies readiness and leaves the entry OPEN', async () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ mustRevisitByGate: 'GATE26' }) },
    { eventType: 'DISPOSITION_DECISION', id: 'GATE24-DC-01', payload: { decision: 'KEEP_DEFERRED', decidedAtGate: 'GATE26' } }
  ]);
  const result = replay(root);
  assert.deepEqual(result.findings, []);
  // Recorded, and deliberately NOT a closure.
  assert.equal(result.entries[0].disposition, 'OPEN');
  assert.equal(result.entries[0].dispositionDecisions.length, 1);

  writeDeferredCapabilityIndex({ root });
  const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE26' });
  const check = report.checks.find((entry) => entry.id === 'DEFERRED_CAPABILITY_COMMITMENTS');
  assert.equal(check.status, 'PASS');
  assert.equal(check.detail.targeted, 1);
  assert.equal(check.detail.undecided, 0);
});

test('H13 supersession closes the old entry and points at the successor', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'REGISTER', id: 'GATE24-DC-02', payload: entryPayload({ capabilityName: 'successor' }) },
    { eventType: 'SUPERSEDE', id: 'GATE24-DC-01', payload: { supersededBy: 'GATE24-DC-02' } }
  ]);
  const result = replay(root);
  assert.deepEqual(result.findings, []);
  const old = result.entries.find((entry) => entry.deferredCapabilityId === 'GATE24-DC-01');
  assert.equal(old.disposition, 'SUPERSEDED');
  assert.equal(old.supersededBy, 'GATE24-DC-02');
});

test('H14 supersession by an unknown or self identity is refused', () => {
  for (const successor of ['GATE24-DC-99', 'GATE24-DC-01', null]) {
    const root = makeRoot();
    writeChain(root, [
      { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
      { eventType: 'SUPERSEDE', id: 'GATE24-DC-01', payload: { supersededBy: successor } }
    ]);
    const result = replay(root);
    assert.ok(codes(result).includes('SUPERSEDING_ENTRY_UNRESOLVED'), String(successor));
    assert.equal(result.entries[0].disposition, 'OPEN');
  }
});

test('H15 retirement with a rationale closes the entry', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'RETIRE', id: 'GATE24-DC-01', payload: { retirementRationale: 'The underlying input was withdrawn upstream.' } }
  ]);
  const result = replay(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.entries[0].disposition, 'RETIRED');
});

test('H16 retirement without a rationale is refused', () => {
  for (const rationale of [undefined, '', '   ']) {
    const root = makeRoot();
    const payload = {};
    if (rationale !== undefined) payload.retirementRationale = rationale;
    writeChain(root, [
      { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
      { eventType: 'RETIRE', id: 'GATE24-DC-01', payload }
    ]);
    const result = replay(root);
    assert.ok(codes(result).includes('RETIREMENT_RATIONALE_REQUIRED'));
    assert.equal(result.entries[0].disposition, 'OPEN');
  }
});

test('H17 provenance that does not resolve is refused', () => {
  // Absent authority file.
  const absent = makeRoot();
  writeChain(absent, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload(), authorityPath: 'governance/sources/NOT_THERE.json' }]);
  assert.ok(codes(replay(absent)).some((code) => code === 'PROVENANCE_UNRESOLVED'));

  // Present authority file, wrong digest.
  const wrong = makeRoot();
  writeChain(wrong, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload(), authoritySha256: 'b'.repeat(64) }]);
  assert.ok(codes(replay(wrong)).includes('PROVENANCE_UNRESOLVED'));
});

test('H18 absolute, traversing and mixed-separator provenance paths are refused', () => {
  for (const bad of ['/etc/passwd', 'C:/x.json', 'governance\\sources\\x.json', 'governance/../x.json', 'sources/x.json']) {
    const root = makeRoot();
    writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload(), authorityPath: bad }]);
    assert.ok(codes(replay(root)).includes('PROVENANCE_PATH_UNSAFE'), bad);
  }
});

test('H19 identities from different gates never collide', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ sourceGate: 'GATE24' }) },
    { eventType: 'REGISTER', id: 'GATE25-DC-01', payload: entryPayload({ sourceGate: 'GATE25' }) }
  ]);
  const result = replay(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.entries.length, 2);
});

test('H19b an identity whose prefix disagrees with sourceGate is refused', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE25-DC-01', payload: entryPayload({ sourceGate: 'GATE24' }) }]);
  assert.ok(codes(replay(root)).includes('SOURCE_GATE_IDENTITY_MISMATCH'));
});

test('H20 a hand-edited generated index is reported as drift', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  writeDeferredCapabilityIndex({ root });
  const indexFile = path.join(root, ...INDEX_PATH.split('/'));
  const tampered = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  tampered.byId['GATE24-DC-01'].disposition = 'RETIRED';
  fs.writeFileSync(indexFile, `${JSON.stringify(tampered, null, 2)}\n`);
  const report = checkDeferredCapabilityIndex({ root });
  assert.equal(report.verdict, 'DRIFTED');
  assert.ok(report.findings.some((entry) => entry.code === 'GENERATED_INDEX_DRIFT'));
});

test('H21 a deleted index is reported and regenerates to identical bytes', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  writeDeferredCapabilityIndex({ root });
  const indexFile = path.join(root, ...INDEX_PATH.split('/'));
  const before = fs.readFileSync(indexFile);
  fs.rmSync(indexFile);
  assert.ok(checkDeferredCapabilityIndex({ root }).findings.some((entry) => entry.code === 'GENERATED_INDEX_ABSENT'));
  writeDeferredCapabilityIndex({ root });
  assert.equal(sha256(fs.readFileSync(indexFile)), sha256(before));
});

test('H22 canonical truth survives a tampered index: the registry is the trust root', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  writeDeferredCapabilityIndex({ root });
  const indexFile = path.join(root, ...INDEX_PATH.split('/'));
  fs.writeFileSync(indexFile, `${JSON.stringify({ document: 'LIES', entries: [] }, null, 2)}\n`);
  // The validator never reads the projection.
  const report = validateDeferredCapabilityRegistry({ root });
  assert.equal(report.verdict, 'VALID');
  assert.equal(report.entryCount, 1);
  assert.equal(report.entries[0].disposition, 'OPEN');
});

test('H23 a declared evidence cohort digest that does not recompute is refused', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'PROMOTE', id: 'GATE24-DC-01', payload: goodPromotion({ evidenceCohortDigest: 'c'.repeat(64) }) }
  ]);
  const result = replay(root);
  assert.ok(codes(result).includes('EVIDENCE_COHORT_DIGEST_MISMATCH'));
  assert.notEqual(result.entries[0].status, 'ACTIVE');
});

test('H24 an event citing the registry itself as its authority is refused', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload(), authorityPath: REGISTRY_PATH }]);
  assert.ok(codes(replay(root)).includes('SELF_AUTHORIZATION_FORBIDDEN'));
});

test('H25 a REGISTER declaring ACTIVE without PROMOTED is refused', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ status: 'ACTIVE', disposition: 'OPEN' }) }]);
  assert.ok(codes(replay(root)).includes('IMPLICIT_ACTIVATION_FORBIDDEN'));
});

test('H26 a terminal disposition cannot be reopened by any event type', () => {
  for (const eventType of ['RESTATE', 'DISPOSITION_DECISION', 'PROMOTE', 'SUPERSEDE', 'RETIRE']) {
    const root = makeRoot();
    writeChain(root, [
      { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
      { eventType: 'REGISTER', id: 'GATE24-DC-02', payload: entryPayload({ capabilityName: 'successor' }) },
      { eventType: 'SUPERSEDE', id: 'GATE24-DC-01', payload: { supersededBy: 'GATE24-DC-02' } },
      { eventType, id: 'GATE24-DC-01', payload: { status: 'READY', decision: 'KEEP_DEFERRED', decidedAtGate: 'GATE26', supersededBy: 'GATE24-DC-02', retirementRationale: 'x' } }
    ]);
    const result = replay(root);
    assert.ok(codes(result).includes('TERMINAL_DISPOSITION_IMMUTABLE'), eventType);
    assert.equal(result.entries.find((entry) => entry.deferredCapabilityId === 'GATE24-DC-01').disposition, 'SUPERSEDED');
  }
});

test('H27 an entry pinned to an unknown vocabulary version is refused', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ reasonVocabularyVersion: 'V2' }) }]);
  assert.ok(codes(replay(root)).includes('REASON_VOCABULARY_VERSION_MISMATCH'));
});

test('H28 a promotion claiming retroactive mutation is refused', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'PROMOTE', id: 'GATE24-DC-01', payload: goodPromotion({ retroactiveMutation: true }) }
  ]);
  const result = replay(root);
  assert.ok(codes(result).includes('RETROACTIVE_MUTATION_FORBIDDEN'));
  assert.notEqual(result.entries[0].disposition, 'PROMOTED');
});

test('H28b promotion never rewrites earlier event bytes', () => {
  const root = makeRoot();
  const events = writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'PROMOTE', id: 'GATE24-DC-01', payload: goodPromotion() }
  ]);
  const registryFile = path.join(root, ...REGISTRY_PATH.split('/'));
  const firstLineBefore = fs.readFileSync(registryFile, 'utf8').split('\n')[0];
  replay(root);
  assert.equal(fs.readFileSync(registryFile, 'utf8').split('\n')[0], firstLineBefore);
  assert.equal(JSON.parse(firstLineBefore).eventPayloadSha256, events[0].eventPayloadSha256);
});

test('H29 readiness on the live repository is unchanged by an empty registry', async () => {
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE24' });
  const check = report.checks.find((entry) => entry.id === 'DEFERRED_CAPABILITY_COMMITMENTS');
  assert.ok(check, 'the check must be present');
  assert.equal(check.status, 'PASS');
  assert.equal(check.class, 'NONE');
  assert.equal(check.detail.targeted, 0);
  // It contributes no gap, so it cannot change any existing verdict.
  assert.deepEqual(report.reuse.deferredCapabilityCommitments, []);
});

test('H30 the gate status ledger is untouched by the whole battery', () => {
  const ledger = fs.readFileSync(path.resolve(REPO_ROOT, ...LEDGER_PATH.split('/')));
  const events = ledger.toString('utf8').split(/\r?\n/).filter((line) => line.trim());
  assert.equal(events.length, 99);
  assert.equal(sha256(ledger), '2d2707462ef4e518abb5153376c1145c39a97981486066eea62edae043f54a57');
});

test('H30b the registry is not a lifecycle ledger: no event can carry a gate status', () => {
  const root = makeRoot();
  writeChain(root, [{
    eventType: 'REGISTER', id: 'GATE24-DC-01',
    payload: entryPayload(), eventId: 'E0001'
  }]);
  const [event] = parseRegistry(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8'));
  for (const lifecycleField of ['fromStatus', 'toStatus', 'transitionType', 'stateRevision', 'gateId']) {
    assert.equal(Object.hasOwn(event, lifecycleField), false, lifecycleField);
  }
  // And an event that smuggles one in is refused as an unknown field.
  const smuggled = { ...event, toStatus: 'COMPLETE_CONFIRMED' };
  writeEvents(root, [smuggled]);
  assert.ok(codes(replay(root)).includes('EVENT_UNKNOWN_FIELD'));
});
