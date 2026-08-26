/**
 * STEP2 deferred-capability closure enforcement — hostile battery S2-H01..H18.
 *
 * Scratch roots only. The live canonical registry is never a trust write.
 * The generated index is never read as trust.
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
  validateDeferredCapabilityRegistry, REGISTRY_PATH, VOCABULARY_PATH, IDENTITY_RE
} from '../tools/validate-deferred-capability-registry.mjs';
import {
  evaluateDeferredCapabilityClosureDeclaration, RULE_ID, declarationPathFor
} from '../tools/evaluate-deferred-capability-closure-declaration.mjs';
import { auditFinalGateIntegrity, AUDITOR_VERSION } from '../tools/final-gate-integrity-auditor.mjs';
import { writeDeferredCapabilityIndex, INDEX_PATH } from '../tools/generate-deferred-capability-index.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const AUTHORITY_REL = 'governance/sources/TEST_DEFERRED_CAPABILITY_AUTHORITY.json';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const codes = (result) => (result.findings ?? []).map((entry) => entry.code);

function makeEvalRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-dc-'));
  for (const dir of ['master-matrix', 'sources', 'generated', 'gates/GATE24/state/revisions/R0001', 'state']) {
    fs.mkdirSync(path.join(root, 'governance', dir), { recursive: true });
  }
  fs.copyFileSync(path.resolve(REPO_ROOT, ...VOCABULARY_PATH.split('/')), path.join(root, ...VOCABULARY_PATH.split('/')));
  fs.writeFileSync(path.join(root, ...AUTHORITY_REL.split('/')), '{"document":"TEST_AUTHORITY"}\n');
  fs.writeFileSync(path.join(root, ...REGISTRY_PATH.split('/')), '');
  const constitution = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/PROJECT_CONSTITUTION.json'), 'utf8'));
  fs.writeFileSync(
    path.join(root, 'governance/PROJECT_CONSTITUTION.json'),
    `${JSON.stringify(constitution, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, 'governance/gates/GATE24/state/CURRENT_STATE.json'),
    `${JSON.stringify({ stateRevision: 'R0001' }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, LEDGER_PATH),
    `${JSON.stringify({ ordinal: 1, gateId: 'GATE24', toStatus: 'COMPLETE_CONFIRMED' })}\n`
  );
  return root;
}

const authorityDigest = (root) => sha256(fs.readFileSync(path.join(root, ...AUTHORITY_REL.split('/'))));

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

function makeEvent({ root, ordinal, previous, eventType, id, payload, eventId }) {
  const base = {
    schemaVersion: 1,
    eventId: eventId ?? `E${String(ordinal).padStart(4, '0')}`,
    ordinal,
    recordedAt: '2026-08-25T20:00:00.000Z',
    eventType,
    deferredCapabilityId: id,
    authorityPath: AUTHORITY_REL,
    authoritySha256: authorityDigest(root),
    payload
  };
  return { ...base, previousEventSha256: previous, eventPayloadSha256: computeEventPayloadSha256(base) };
}

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

function writeDeclaration(root, gateId, revision, ids) {
  const relative = declarationPathFor(gateId, revision);
  fs.mkdirSync(path.dirname(path.join(root, ...relative.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...relative.split('/')), `${JSON.stringify({ deferredCapabilitiesIntroduced: ids }, null, 2)}\n`);
  return relative;
}

function evaluate(root, gateId = 'GATE24') {
  return evaluateDeferredCapabilityClosureDeclaration({ root, gateId });
}

function goodPromotion(overrides = {}) {
  const cohort = [
    { evidenceRole: 'PROMOTION_TEST_EVIDENCE', governedPath: 'governance/tests/deferred-capability-closure-enforcement-hostile-battery.test.mjs', byteLength: 10, sha256: 'a'.repeat(64) }
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

test('S2-H01 legacy GATE17/GATE23 without declaration is NOT_APPLICABLE / BELOW_EFFECTIVE_FROM_GATE', () => {
  const registryPath = path.join(REPO_ROOT, ...REGISTRY_PATH.split('/'));
  const beforeRegistry = fs.readFileSync(registryPath);
  const report17 = auditFinalGateIntegrity({ root: REPO_ROOT, gateId: 'GATE17', expectNotStartedFrom: 'GATE18' });
  assert.ok(report17.familiesRun.includes('DEFERRED_CAPABILITY'));
  const deferred17 = report17.findings.filter((item) => item.family === 'DEFERRED_CAPABILITY');
  assert.equal(deferred17.length, 0);
  assert.equal(deferred17.some((item) => item.defectClass === 'DEFERRED_CAPABILITY_DECLARATION_MISSING'), false);
  const eval17 = evaluateDeferredCapabilityClosureDeclaration({ root: REPO_ROOT, gateId: 'GATE17' });
  assert.equal(eval17.applicable, false);
  assert.equal(eval17.applicabilityReason, 'BELOW_EFFECTIVE_FROM_GATE');
  assert.deepEqual(eval17.findings, []);
  const eval23 = evaluateDeferredCapabilityClosureDeclaration({ root: REPO_ROOT, gateId: 'GATE23' });
  assert.equal(eval23.applicable, false);
  assert.equal(eval23.applicabilityReason, 'BELOW_EFFECTIVE_FROM_GATE');
  assert.deepEqual(eval23.findings, []);
  const afterRegistry = fs.readFileSync(registryPath);
  assert.equal(sha256(afterRegistry), sha256(beforeRegistry));
  assert.ok(Buffer.compare(beforeRegistry, afterRegistry) === 0);
});

test('S2-H02 prospective closed gate missing declaration => DECLARATION_MISSING', () => {
  const root = makeEvalRoot();
  const result = evaluate(root);
  assert.equal(result.applicable, true);
  assert.ok(codes(result).includes('DEFERRED_CAPABILITY_DECLARATION_MISSING'));
});

test('S2-H03 prospective declaration [] => PASS', () => {
  const root = makeEvalRoot();
  writeDeclaration(root, 'GATE24', 'R0001', []);
  const result = evaluate(root);
  assert.equal(result.applicable, true);
  assert.deepEqual(result.findings, []);
});

test('S2-H04 new durable registry id resolves => PASS', () => {
  const root = makeEvalRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01']);
  const result = evaluate(root);
  assert.deepEqual(result.findings, []);
});

test('S2-H05 existing id resolves => PASS', () => {
  const root = makeEvalRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'RESTATE', id: 'GATE24-DC-01', payload: { status: 'DEFERRED' } }
  ]);
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01']);
  const result = evaluate(root);
  assert.deepEqual(result.findings, []);
});

test('S2-H06 nonexistent id => REFERENCE_UNRESOLVED', () => {
  const root = makeEvalRoot();
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-99']);
  const result = evaluate(root);
  assert.ok(codes(result).includes('DEFERRED_CAPABILITY_REFERENCE_UNRESOLVED'));
});

test('S2-H07 malformed JSON/schema/pattern/duplicate => DECLARATION_MALFORMED', () => {
  const cases = [
    (root, file) => fs.writeFileSync(file, '{not json'),
    (root, file) => fs.writeFileSync(file, `${JSON.stringify({ deferredCapabilitiesIntroduced: 'GATE24-DC-01' })}\n`),
    (root, file) => fs.writeFileSync(file, `${JSON.stringify({ deferredCapabilitiesIntroduced: ['NOT-AN-ID'] })}\n`),
    (root, file) => fs.writeFileSync(file, `${JSON.stringify({ deferredCapabilitiesIntroduced: ['GATE24-DC-01', 'GATE24-DC-01'] })}\n`),
    (root, file) => fs.writeFileSync(file, `${JSON.stringify({ deferredCapabilitiesIntroduced: [], extra: true })}\n`)
  ];
  for (const mutate of cases) {
    const root = makeEvalRoot();
    const relative = declarationPathFor('GATE24', 'R0001');
    const file = path.join(root, ...relative.split('/'));
    mutate(root, file);
    const result = evaluate(root);
    assert.ok(codes(result).includes('DEFERRED_CAPABILITY_DECLARATION_MALFORMED'), mutate.toString());
  }
  assert.equal(IDENTITY_RE.test('GATE24-DC-01'), true);
});

test('S2-H08 invalid canonical registry => REGISTRY_INVALID', () => {
  const root = makeEvalRoot();
  writeDeclaration(root, 'GATE24', 'R0001', []);
  fs.writeFileSync(path.join(root, ...REGISTRY_PATH.split('/')), '{broken\n');
  const result = evaluate(root);
  assert.ok(codes(result).includes('DEFERRED_CAPABILITY_REGISTRY_INVALID'));
  assert.equal(result.findings.some((item) => item.code === 'DEFERRED_CAPABILITY_REFERENCE_UNRESOLVED'), false);
});

test('S2-H09 prose contains deferred + declaration [] => PASS', () => {
  const root = makeEvalRoot();
  fs.writeFileSync(
    path.join(root, 'governance/gates/GATE24/state/revisions/R0001/CHECKPOINT.json'),
    '{"notes":"this capability is deferred to the future and out of scope"}\n'
  );
  writeDeclaration(root, 'GATE24', 'R0001', []);
  const result = evaluate(root);
  assert.deepEqual(result.findings, []);
});

test('S2-H10 prose contains no deferred + declaration absent => DECLARATION_MISSING', () => {
  const root = makeEvalRoot();
  fs.writeFileSync(
    path.join(root, 'governance/gates/GATE24/state/revisions/R0001/CHECKPOINT.json'),
    '{"notes":"clean closure with no extra commentary"}\n'
  );
  const result = evaluate(root);
  assert.ok(codes(result).includes('DEFERRED_CAPABILITY_DECLARATION_MISSING'));
});

test('S2-H11 generated index tampered => canonical registry wins', () => {
  const root = makeEvalRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  writeDeferredCapabilityIndex({ root });
  const indexFile = path.join(root, ...INDEX_PATH.split('/'));
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.entries = [];
  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01']);
  const result = evaluate(root);
  assert.deepEqual(result.findings, []);
});

test('S2-H12 generated index missing => enforcement still works', () => {
  const root = makeEvalRoot();
  writeChain(root, [{ eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() }]);
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01']);
  assert.equal(fs.existsSync(path.join(root, ...INDEX_PATH.split('/'))), false);
  const result = evaluate(root);
  assert.deepEqual(result.findings, []);
});

test('S2-H13a GATE24 ids absent from registry => REFERENCE_UNRESOLVED', () => {
  const root = makeEvalRoot();
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01', 'GATE24-DC-02']);
  const result = evaluate(root);
  assert.equal(result.findings.filter((item) => item.code === 'DEFERRED_CAPABILITY_REFERENCE_UNRESOLVED').length, 2);
});

test('S2-H13b same ids imported in fixture => PASS', () => {
  const root = makeEvalRoot();
  const mandate = 'governance/sources/GATE24_CANONICAL_MANDATE_R0.json';
  fs.mkdirSync(path.dirname(path.join(root, ...mandate.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...mandate.split('/')), '{}\n');
  writeChain(root, [
    {
      eventType: 'IMPORT_BINDING',
      id: 'GATE24-DC-01',
      payload: {
        ...entryPayload(),
        bindingMode: 'REFERENCE_ONLY',
        sourceMandatePath: mandate,
        sourceMandateSha256: '67bd631a77c87785d623ccbf1051c33b5b5bc9d57855167a8763d8586a55115f'
      }
    },
    {
      eventType: 'IMPORT_BINDING',
      id: 'GATE24-DC-02',
      payload: {
        ...entryPayload({ capabilityName: 'second imported' }),
        bindingMode: 'REFERENCE_ONLY',
        sourceMandatePath: mandate,
        sourceMandateSha256: '67bd631a77c87785d623ccbf1051c33b5b5bc9d57855167a8763d8586a55115f'
      }
    }
  ]);
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01', 'GATE24-DC-02']);
  const registry = validateDeferredCapabilityRegistry({ root });
  assert.equal(registry.verdict, 'VALID', JSON.stringify(registry.findings, null, 1));
  const result = evaluate(root);
  assert.deepEqual(result.findings, []);
});

test('S2-H14 KEEP_DEFERRED remains OPEN and declaration PASS', () => {
  const root = makeEvalRoot();
  writeChain(root, [
    { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
    { eventType: 'DISPOSITION_DECISION', id: 'GATE24-DC-01', payload: { decision: 'KEEP_DEFERRED', decidedAtGate: 'GATE26' } }
  ]);
  writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01']);
  const registry = validateDeferredCapabilityRegistry({ root });
  assert.equal(registry.entries[0].disposition, 'OPEN');
  const result = evaluate(root);
  assert.deepEqual(result.findings, []);
});

test('S2-H15 PROMOTED/RETIRED/SUPERSEDED declared as OPEN deferral => NOT_DURABLY_REGISTERED', () => {
  const terminals = [
    {
      specs: [
        { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
        { eventType: 'PROMOTE', id: 'GATE24-DC-01', payload: goodPromotion() }
      ]
    },
    {
      specs: [
        { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
        { eventType: 'RETIRE', id: 'GATE24-DC-01', payload: { retirementRationale: 'Withdrawn upstream.' } }
      ]
    },
    {
      specs: [
        { eventType: 'REGISTER', id: 'GATE24-DC-01', payload: entryPayload() },
        { eventType: 'REGISTER', id: 'GATE24-DC-02', payload: entryPayload({ capabilityName: 'successor' }) },
        { eventType: 'SUPERSEDE', id: 'GATE24-DC-01', payload: { supersededBy: 'GATE24-DC-02' } }
      ]
    }
  ];
  for (const { specs } of terminals) {
    const root = makeEvalRoot();
    writeChain(root, specs);
    writeDeclaration(root, 'GATE24', 'R0001', ['GATE24-DC-01']);
    const result = evaluate(root);
    assert.ok(codes(result).includes('DEFERRED_CAPABILITY_NOT_DURABLY_REGISTERED'), JSON.stringify(result.findings));
  }
});

test('S2-H16 duplicate declaration id => DECLARATION_MALFORMED', () => {
  const root = makeEvalRoot();
  const relative = declarationPathFor('GATE24', 'R0001');
  fs.writeFileSync(
    path.join(root, ...relative.split('/')),
    `${JSON.stringify({ deferredCapabilitiesIntroduced: ['GATE24-DC-01', 'GATE24-DC-01'] }, null, 2)}\n`
  );
  const result = evaluate(root);
  assert.ok(codes(result).includes('DEFERRED_CAPABILITY_DECLARATION_MALFORMED'));
});

test('S2-H17 registry bytes unchanged before/after evaluator + FGI', () => {
  const before = fs.readFileSync(path.join(REPO_ROOT, ...REGISTRY_PATH.split('/')));
  evaluateDeferredCapabilityClosureDeclaration({ root: REPO_ROOT, gateId: 'GATE17' });
  auditFinalGateIntegrity({ root: REPO_ROOT, gateId: 'GATE17', expectNotStartedFrom: 'GATE18' });
  const after = fs.readFileSync(path.join(REPO_ROOT, ...REGISTRY_PATH.split('/')));
  assert.equal(sha256(after), sha256(before));
  assert.ok(Buffer.compare(before, after) === 0);
});

test('S2-H18 ledger bytes unchanged before/after evaluator + FGI', () => {
  const before = fs.readFileSync(path.join(REPO_ROOT, LEDGER_PATH));
  evaluateDeferredCapabilityClosureDeclaration({ root: REPO_ROOT, gateId: 'GATE17' });
  auditFinalGateIntegrity({ root: REPO_ROOT, gateId: 'GATE17', expectNotStartedFrom: 'GATE18' });
  const after = fs.readFileSync(path.join(REPO_ROOT, LEDGER_PATH));
  assert.equal(sha256(after), sha256(before));
  assert.ok(Buffer.compare(before, after) === 0);
  assert.equal(AUDITOR_VERSION, 'R2');
});
