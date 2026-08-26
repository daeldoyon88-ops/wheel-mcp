/**
 * DEFERRED CAPABILITY REGISTRY — normal suite.
 *
 * Every case here builds a real registry on disk, replays it through the real
 * validator and asserts on the real fold. Nothing is declarative: a test that
 * asserted "the design says X" would pass forever regardless of what the code
 * does, which is the failure mode this suite exists to avoid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  computeEventPayloadSha256, computeEvidenceCohortDigest, isGovernedPath,
  parseRegistry, readVocabulary, replayRegistry, validateDeferredCapabilityRegistry,
  REGISTRY_PATH, VOCABULARY_PATH, STATUSES, DISPOSITIONS, TERMINAL_DISPOSITIONS, EVENT_TYPES
} from '../tools/validate-deferred-capability-registry.mjs';
import {
  buildIndex, generateDeferredCapabilityIndex, writeDeferredCapabilityIndex,
  checkDeferredCapabilityIndex, INDEX_PATH, PROVENANCE_PATH
} from '../tools/generate-deferred-capability-index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUTHORITY_REL = 'governance/sources/TEST_DEFERRED_CAPABILITY_AUTHORITY.json';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-normal-'));
  fs.mkdirSync(path.join(root, 'governance', 'master-matrix'), { recursive: true });
  fs.mkdirSync(path.join(root, 'governance', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, 'governance', 'generated'), { recursive: true });
  fs.copyFileSync(
    path.resolve(REPO_ROOT, ...VOCABULARY_PATH.split('/')),
    path.join(root, ...VOCABULARY_PATH.split('/'))
  );
  fs.writeFileSync(path.join(root, ...AUTHORITY_REL.split('/')), '{"document":"TEST_AUTHORITY"}\n');
  return root;
}

function authorityDigest(root) {
  return sha256(fs.readFileSync(path.join(root, ...AUTHORITY_REL.split('/'))));
}

function makeEvent({ root, ordinal, previous, eventType, id, payload, eventId, authorityPath = AUTHORITY_REL }) {
  const base = {
    schemaVersion: 1,
    eventId: eventId ?? `E${String(ordinal).padStart(4, '0')}`,
    ordinal,
    recordedAt: '2026-08-25T20:00:00.000Z',
    eventType,
    deferredCapabilityId: id,
    authorityPath,
    authoritySha256: authorityDigest(root),
    payload
  };
  return { ...base, previousEventSha256: previous, eventPayloadSha256: computeEventPayloadSha256(base) };
}

function entryPayload(overrides = {}) {
  return {
    sourceGate: 'GATE24',
    capabilityName: 'growthState as an active classifying dimension',
    capabilityClass: 'REGISTERED_NOT_ACTIVE_IN_CORE_V1',
    status: 'REGISTERED',
    disposition: 'OPEN',
    reasonDeferred: ['TAXONOMY_INTENTIONALLY_DEFERRED'],
    reasonVocabularyVersion: 'V1',
    promotionRequirements: [],
    consumerCandidates: [],
    mustRevisitByGate: 'GATE26',
    ownerPromotionRequired: true,
    currentVersion: 'REGIME_VECTOR_V1',
    ...overrides
  };
}

/** Write a chained stream; each event's previous link is the prior payload digest. */
function writeChain(root, specs) {
  const events = [];
  let previous = null;
  specs.forEach((spec, index) => {
    const event = makeEvent({ root, ordinal: index + 1, previous, ...spec });
    previous = event.eventPayloadSha256;
    events.push(event);
  });
  fs.writeFileSync(
    path.join(root, ...REGISTRY_PATH.split('/')),
    events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
  );
  return events;
}

function replay(root) {
  const text = fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8');
  return replayRegistry({ events: parseRegistry(text), vocabulary: readVocabulary(root), root });
}

test('N01 an empty registry is valid: zero events, zero entries, no findings', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ...REGISTRY_PATH.split('/')), '');
  const report = validateDeferredCapabilityRegistry({ root });
  assert.equal(report.verdict, 'VALID');
  assert.deepEqual(report.findings, []);
  assert.equal(report.eventCount, 0);
  assert.equal(report.entryCount, 0);
});

test('N02 the live published registry validates against its own validator', () => {
  const report = validateDeferredCapabilityRegistry({ root: REPO_ROOT });
  assert.equal(report.verdict, 'VALID', JSON.stringify(report.findings));
  assert.deepEqual(report.findings, []);
});

test('N03 canonical replay folds a REGISTER into exactly one entry', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  const result = replay(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].deferredCapabilityId, 'GATE24-DC-01');
  assert.equal(result.entries[0].status, 'REGISTERED');
  assert.equal(result.entries[0].disposition, 'OPEN');
});

test('N04 the fold is deterministic: replaying identical bytes twice gives identical state', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'REGISTER', id: 'GATE24-DC-02', payload: entryPayload({ capabilityName: 'laborState' }) }
  ]);
  assert.equal(JSON.stringify(replay(root).entries), JSON.stringify(replay(root).entries));
});

test('N05 event hashing excludes the chain link and covers the payload', () => {
  const root = makeRoot();
  const [event] = writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  assert.equal(computeEventPayloadSha256(event), event.eventPayloadSha256);
  // Changing the chain link must NOT change the payload digest...
  assert.equal(computeEventPayloadSha256({ ...event, previousEventSha256: 'f'.repeat(64) }), event.eventPayloadSha256);
  // ...but changing the payload must.
  const mutated = { ...event, payload: { ...event.payload, capabilityName: 'something else' } };
  assert.notEqual(computeEventPayloadSha256(mutated), event.eventPayloadSha256);
});

test('N06 reason vocabulary V1 is exactly the ratified GATE24 token set, in order', () => {
  const vocabulary = readVocabulary(REPO_ROOT);
  assert.equal(vocabulary.version, 'V1');
  assert.deepEqual(vocabulary.tokens, [
    'CAUSAL_VINTAGE_PROOF_INCOMPLETE',
    'CANONICAL_IDENTITY_ABSENT',
    'AVAILABLE_AT_POLICY_INCOMPLETE',
    'RELEASE_TIMESTAMP_UNCERTAINTY',
    'HISTORICAL_COVERAGE_INSUFFICIENT',
    'CLASSIFIER_ROLE_NOT_YET_PROVEN',
    'REDUNDANT_INFORMATION_NOT_YET_EVALUATED',
    'PREDICTIVE_VALUE_BELONGS_TO_LATER_GATE',
    'TAXONOMY_INTENTIONALLY_DEFERRED',
    'NOT_REQUIRED_BY_CORE_V1'
  ]);
});

test('N07 status and disposition are separate vocabularies and do not overlap', () => {
  assert.deepEqual([...STATUSES], ['REGISTERED', 'READY', 'ACTIVE', 'DEFERRED', 'FUTURE']);
  assert.deepEqual([...DISPOSITIONS], ['OPEN', 'PROMOTED', 'RETIRED', 'SUPERSEDED']);
  assert.deepEqual([...TERMINAL_DISPOSITIONS], ['PROMOTED', 'RETIRED', 'SUPERSEDED']);
  assert.equal(STATUSES.filter((value) => DISPOSITIONS.includes(value)).length, 0);
  assert.equal(EVENT_TYPES.length, 7);
});

test('N08 RESTATE moves status among open states and leaves disposition OPEN', () => {
  const root = makeRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ status: 'REGISTERED' }) },
    { eventType: 'RESTATE', id: 'GATE24-DC-01', payload: { status: 'READY' } }
  ]);
  const result = replay(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.entries[0].status, 'READY');
  assert.equal(result.entries[0].disposition, 'OPEN');
});

test('N09 a fully evidenced PROMOTE reaches ACTIVE and PROMOTED together', () => {
  const root = makeRoot();
  const cohort = [
    { evidenceRole: 'PROMOTION_TEST_EVIDENCE', governedPath: 'governance/tests/deferred-capability-registry.test.mjs', byteLength: 10, sha256: 'a'.repeat(64) },
    { evidenceRole: 'CAUSAL_PROOF', governedPath: 'governance/master-matrix/DEFERRED_CAPABILITY_REASON_VOCABULARY_V1.json', byteLength: 20, sha256: 'b'.repeat(64) }
  ];
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload({ promotionRequirements: ['closed taxonomy'], consumerCandidates: ['GATE25 analogue selection'] }) },
    {
      eventType: 'PROMOTE',
      id: 'GATE24-DC-01',
      payload: {
        authorityIssuedBy: 'PROJECT_OWNER',
        promotedIntoVersion: 'REGIME_VECTOR_V2',
        retroactiveMutation: false,
        evidenceCohort: cohort,
        evidenceCohortDigest: computeEvidenceCohortDigest(cohort),
        requirementEvidenceMap: [{ requirement: 'closed taxonomy', governedPath: cohort[1].governedPath }],
        consumerCompatibility: [{ consumer: 'GATE25 analogue selection', verdict: 'COMPATIBLE' }]
      }
    }
  ]);
  const result = replay(root);
  assert.deepEqual(result.findings, []);
  assert.equal(result.entries[0].status, 'ACTIVE');
  assert.equal(result.entries[0].disposition, 'PROMOTED');
  assert.equal(result.entries[0].currentVersion, 'REGIME_VECTOR_V2');
});

test('N10 the generated index projects lookup, grouping and target-gate commitments', () => {
  const index = buildIndex({
    entries: [
      { deferredCapabilityId: 'GATE24-DC-02', sourceGate: 'GATE24', status: 'READY', disposition: 'OPEN', consumerCandidates: ['GATE25 analogue selection'], mustRevisitByGate: 'GATE26', eventBasedRevisitTrigger: null, dispositionDecisions: [] },
      { deferredCapabilityId: 'GATE24-DC-01', sourceGate: 'GATE24', status: 'REGISTERED', disposition: 'RETIRED', consumerCandidates: [], mustRevisitByGate: 'GATE26', eventBasedRevisitTrigger: null, dispositionDecisions: [] }
    ],
    registrySha256: 'c'.repeat(64), registryByteLength: 2, eventCount: 2, vocabularyVersion: 'V1'
  });
  assert.equal(index.canonical, false);
  assert.equal(index.entryCount, 2);
  assert.deepEqual(Object.keys(index.byId), ['GATE24-DC-01', 'GATE24-DC-02']);
  assert.deepEqual(index.bySourceGate.GATE24, ['GATE24-DC-01', 'GATE24-DC-02']);
  assert.deepEqual(index.byDisposition.RETIRED, ['GATE24-DC-01']);
  assert.deepEqual(index.byConsumerCandidate['GATE25 analogue selection'], ['GATE24-DC-02']);
  // Only the OPEN one surfaces; the RETIRED one has already been decided.
  assert.deepEqual(index.openCommitmentsByTargetGate.GATE26, ['GATE24-DC-02']);
});

test('N11 an event-based revisit trigger naming a gate also targets that gate', () => {
  const index = buildIndex({
    entries: [{
      deferredCapabilityId: 'GATE23-DC-01', sourceGate: 'GATE23', status: 'DEFERRED', disposition: 'OPEN',
      consumerCandidates: [], mustRevisitByGate: null,
      eventBasedRevisitTrigger: 'When GATE27 declares a cross-sectional contract.', dispositionDecisions: []
    }],
    registrySha256: 'd'.repeat(64), registryByteLength: 1, eventCount: 1, vocabularyVersion: 'V1'
  });
  assert.deepEqual(index.openCommitmentsByTargetGate.GATE27, ['GATE23-DC-01']);
});

test('N12 generation is deterministic and provenance pins the registry it read', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  const first = generateDeferredCapabilityIndex({ root, now: new Date('2026-01-01T00:00:00.000Z') });
  const second = generateDeferredCapabilityIndex({ root, now: new Date('2027-06-06T06:06:06.000Z') });
  // Different clocks, identical index bytes: the index is a pure function of the registry.
  assert.equal(first.indexBytes.toString('utf8'), second.indexBytes.toString('utf8'));
  assert.notEqual(first.provenance.generatedAt, second.provenance.generatedAt);
  assert.equal(first.provenance.canonical, false);
  const registryBytes = fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')));
  assert.equal(first.provenance.sourceDigest, sha256(registryBytes));
  assert.equal(first.provenance.generatedBy, 'governance/tools/generate-deferred-capability-index.mjs');
});

test('N13 write-then-check round-trips as CONSISTENT', () => {
  const root = makeRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  writeDeferredCapabilityIndex({ root });
  assert.equal(checkDeferredCapabilityIndex({ root }).verdict, 'CONSISTENT');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ...INDEX_PATH.split('/')), 'utf8')).canonical, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ...PROVENANCE_PATH.split('/')), 'utf8')).canonical, false);
});

test('N14 the live generated index is consistent with the live canonical registry', () => {
  assert.equal(checkDeferredCapabilityIndex({ root: REPO_ROOT }).verdict, 'CONSISTENT');
});

test('N15 governed-path discipline accepts repo-relative and rejects escapes', () => {
  assert.equal(isGovernedPath('governance/sources/X.json'), true);
  for (const bad of [
    '/etc/passwd', 'C:/governance/x.json', 'governance\\sources\\x.json',
    'governance/../secret', 'sources/x.json', 'governance/*.json', ''
  ]) {
    assert.equal(isGovernedPath(bad), false, bad);
  }
});

test('N16 the evidence cohort digest is order-independent and content-sensitive', () => {
  const a = { evidenceRole: 'A', governedPath: 'governance/a', byteLength: 1, sha256: '1'.repeat(64) };
  const b = { evidenceRole: 'B', governedPath: 'governance/b', byteLength: 2, sha256: '2'.repeat(64) };
  assert.equal(computeEvidenceCohortDigest([a, b]), computeEvidenceCohortDigest([b, a]));
  assert.notEqual(computeEvidenceCohortDigest([a, b]), computeEvidenceCohortDigest([a, { ...b, byteLength: 3 }]));
});

test('N17 serialization is stable across key insertion order', () => {
  const root = makeRoot();
  const payload = entryPayload();
  const reordered = Object.fromEntries(Object.keys(payload).reverse().map((key) => [key, payload[key]]));
  const one = makeEvent({ root, ordinal: 1, previous: null, eventType: 'REGISTER', id: 'GATE24-DC-01', payload });
  const two = makeEvent({ root, ordinal: 1, previous: null, eventType: 'REGISTER', id: 'GATE24-DC-01', payload: reordered });
  assert.equal(one.eventPayloadSha256, two.eventPayloadSha256);
});
