import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_ID, AUTHORITY_ID, DECISION_ID, OWNER_AUTHORIZATION_KIND, AUTHORITY_KIND, TRANSITION_RECEIPT_KIND, CONSUMPTION_KIND,
  OWNER_AUTHORIZATION_PATH, AUTHORITY_PATH, TRANSITION_RECEIPT_PATH, CONSUMPTION_PATH,
  PREEXISTING_BYTE_RATIFICATION_KIND, PREEXISTING_BYTE_RATIFICATION_PATH,
  evaluateOwnerPresentByteBootstrapAuthority, evaluateDurableTransitionReceipt, evaluateHistoricalDurableTransitionReceipt, evaluateOwnerPresentByteBootstrapConsumption, evaluateLiveOwnerPresentByteBootstrapConsumption, evaluateBootstrapIssuance,
  collectValidatedOwnerPresentByteBootstrapSuccessorBindings
} from '../gee-v1/core/owner-present-byte-bootstrap.mjs';
import { collectCanonicalPredecessors, collectPathPrestates } from '../tools/post-freeze-maintenance-observation.mjs';
import { evaluatePathPrestateBinding } from '../gee-v1/core/post-freeze-maintenance-authority.mjs';

const iso = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'governance/gee-v1/core/current-byte-authorization.mjs'; const B = 'governance/gee-v1/core/canonical-authorized-cohort.mjs'; const C = 'governance/tools/post-freeze-maintenance-observation.mjs';
const RATIFICATION_ID = 'GATE20_OWNER_PREEXISTING_C_BYTE_RATIFICATION_R1';
const R6_CANONICAL = { path: C, sha256: 'fb3c6f426cee0560afe030fad9ac48aad4c237291957a23e767161b90dc34ab5', byteLength: 11314 };
const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
const full = (root, rel) => path.join(root, ...rel.split('/'));
const write = (root, rel, value) => { const p = full(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value)); };
const copy = (root, rel) => { const p = full(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(full(iso, rel), p); };
const expectRefuse = (label, fn) => assert.equal(fn().valid, false, label);
function expectFinding(label, result, code) {
  assert.equal(result.valid, false, label);
  assert.ok((result.findings || []).some((entry) => entry.code === code), `${label} missing ${code}: ${JSON.stringify(result.findings)}`);
}
function expectSuccessorRefuse(label, fixtureRoot, code) {
  const result = collectValidatedOwnerPresentByteBootstrapSuccessorBindings({ root: fixtureRoot, gateId: 'GATE20' });
  assert.equal(result.bindings.length, 0, `${label} bindings`);
  assert.ok((result.refused || []).some((entry) => entry.code === code), `${label} missing ${code}: ${JSON.stringify(result.refused)}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate20-owner-bootstrap-r5-'));
try {
  [A, B, C].forEach((p) => copy(root, p));
  const a = fs.readFileSync(full(root, A)), b = fs.readFileSync(full(root, B)), source = fs.readFileSync(full(iso, 'governance/tests/fixtures/owner-present-byte-bootstrap-c-source.mjs')), target = fs.readFileSync(full(root, C));
  assert.equal(h(source), '957686fdc25e65f81decf363630a12b358fc5ca15bafd44535ae8dceceebbf63'); assert.equal(source.length, 16423);
  assert.equal(h(target), '3ed9b545bcca0b85dde05b41cb85e08fe079a5d6c2113eb9fd90c1a887848c9b'); assert.equal(target.length, 17088);
  const presentPaths = [{ path: A, sha256: h(a), byteLength: a.length }, { path: B, sha256: h(b), byteLength: b.length }];
  const transition = { path: C, sourceSha256: h(source), sourceByteLength: source.length, targetSha256: h(target), targetByteLength: target.length };
  const observedByte = { path: C, sha256: h(source), byteLength: source.length };
  const previousCanonical = { ...R6_CANONICAL };
  const ratification = {
    documentKind: PREEXISTING_BYTE_RATIFICATION_KIND, ratificationId: RATIFICATION_ID, gateId: 'GATE20',
    bootstrapId: BOOTSTRAP_ID, authorityId: AUTHORITY_ID, issuedBy: 'PROJECT_OWNER_EXTERNAL_CEREMONY',
    derivedFromGitDelta: false, derivedFromFinalGateIntegrityFindings: false,
    admissionMode: 'OWNER_PREEXISTING_OBSERVED_BYTE_RATIFICATION', previousCanonical, observedByte
  };
  write(root, PREEXISTING_BYTE_RATIFICATION_PATH, ratification);
  const ratificationSha = h(fs.readFileSync(full(root, PREEXISTING_BYTE_RATIFICATION_PATH)));
  assert.equal(ratification.previousCanonical.sha256, R6_CANONICAL.sha256, 'previous canonical anchor exact');
  assert.equal(ratification.observedByte.sha256, h(source), 'observed C exact');
  assert.equal(transition.sourceSha256, h(source), 'transition C source exact');
  assert.equal(transition.targetSha256, h(target), 'transition C-prime exact');
  // This is the test harness's external ceremony input, written before any authority or consumer invocation.
  const owner = {
    documentKind: OWNER_AUTHORIZATION_KIND, decisionId: DECISION_ID, gateId: 'GATE20', bootstrapId: BOOTSTRAP_ID, authorityId: AUTHORITY_ID,
    issuedBy: 'PROJECT_OWNER_EXTERNAL_CEREMONY', derivedFromGitDelta: false, derivedFromFinalGateIntegrityFindings: false,
    preexistingByteRatificationPath: PREEXISTING_BYTE_RATIFICATION_PATH, preexistingByteRatificationSha256: ratificationSha,
    presentPaths, transition
  };
  write(root, OWNER_AUTHORIZATION_PATH, owner); const ownerSha = h(fs.readFileSync(full(root, OWNER_AUTHORIZATION_PATH)));
  assert.equal(owner.preexistingByteRatificationPath, PREEXISTING_BYTE_RATIFICATION_PATH, 'ratification path exact');
  assert.equal(owner.preexistingByteRatificationSha256, ratificationSha, 'ratification SHA exact');
  const authority = {
    documentKind: AUTHORITY_KIND, authorityId: AUTHORITY_ID, bootstrapId: BOOTSTRAP_ID, gateId: 'GATE20', authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    maxUse: 1, derivedFromGitDelta: false, derivedFromFinalGateIntegrityFindings: false,
    ownerAuthorizationPath: OWNER_AUTHORIZATION_PATH, ownerAuthorizationSha256: ownerSha, ownerDecisionId: DECISION_ID,
    preexistingByteRatificationPath: PREEXISTING_BYTE_RATIFICATION_PATH, preexistingByteRatificationSha256: ratificationSha,
    presentPaths, transition
  };
  write(root, AUTHORITY_PATH, authority); const authoritySha = h(fs.readFileSync(full(root, AUTHORITY_PATH)));
  assert.equal(evaluateOwnerPresentByteBootstrapAuthority({ root, authority }).valid, true, 'P1');
  const transitionReceipt = { documentKind: TRANSITION_RECEIPT_KIND, bootstrapId: BOOTSTRAP_ID, authorityId: AUTHORITY_ID, authoritySha256: authoritySha, gateId: 'GATE20', ownerDecisionId: DECISION_ID, ownerAuthorizationPath: OWNER_AUTHORIZATION_PATH, ownerAuthorizationSha256: ownerSha, ...transition, consumedAt: '2026-08-20T00:00:00.000Z', spent: true };
  write(root, TRANSITION_RECEIPT_PATH, transitionReceipt); assert.equal(evaluateDurableTransitionReceipt({ root, receipt: transitionReceipt }).valid, true, 'P2 live transition admission'); assert.equal(evaluateHistoricalDurableTransitionReceipt({ root, receipt: transitionReceipt }).valid, true, 'P3 historical transition'); assert.equal(JSON.parse(fs.readFileSync(full(root, TRANSITION_RECEIPT_PATH))).spent, true, 'P3 durable spent');
  const receipt = { documentKind: CONSUMPTION_KIND, bootstrapId: BOOTSTRAP_ID, authorityId: AUTHORITY_ID, authoritySha256: authoritySha, gateId: 'GATE20', ownerDecisionId: DECISION_ID, ownerAuthorizationPath: OWNER_AUTHORIZATION_PATH, ownerAuthorizationSha256: ownerSha, cohort: presentPaths, consumedAt: '2026-08-20T00:00:01.000Z', spent: true };
  write(root, CONSUMPTION_PATH, receipt); assert.equal(evaluateLiveOwnerPresentByteBootstrapConsumption({ root, receipt }).valid, true, 'P4 live admission'); assert.equal(evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }).valid, true, 'P4 historical');
  const successor = collectValidatedOwnerPresentByteBootstrapSuccessorBindings({ root, gateId: 'GATE20' });
  assert.equal(successor.refused.length, 0, 'P4 successor refused');
  assert.equal(successor.bindings.length, 2, 'P4 successor bindings');
  expectRefuse('receipt A binding mutation', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt: { ...receipt, cohort: [{ ...presentPaths[0], sha256: '0'.repeat(64) }, presentPaths[1]] } }));
  expectRefuse('receipt B binding mutation', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt: { ...receipt, cohort: [presentPaths[0], { ...presentPaths[1], sha256: '0'.repeat(64) }] } }));
  const savedAuthorityForBinding = fs.readFileSync(full(root, AUTHORITY_PATH)); write(root, AUTHORITY_PATH, { ...authority, presentPaths: [{ ...presentPaths[0], sha256: '0'.repeat(64) }, presentPaths[1]] }); expectRefuse('authority A binding mutation', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt })); fs.writeFileSync(full(root, AUTHORITY_PATH), savedAuthorityForBinding);
  write(root, AUTHORITY_PATH, { ...authority, presentPaths: [presentPaths[0], { ...presentPaths[1], sha256: '0'.repeat(64) }] }); expectRefuse('authority B binding mutation', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt })); fs.writeFileSync(full(root, AUTHORITY_PATH), savedAuthorityForBinding);
  const predecessors = collectCanonicalPredecessors(root, [A, B]); assert.ok(predecessors[A].includes(presentPaths[0].sha256) && predecessors[B].includes(presentPaths[1].sha256), 'P5/P6');
  const findings = []; evaluatePathPrestateBinding({ manifestResult: { bindsPrestate: true, prestateByPath: new Map(presentPaths.map((x) => [x.path, { state: 'PRESENT', ...x }])), prestateSelfExcluded: new Map() }, authority: {}, observed: { pathPrestates: collectPathPrestates(root, [A, B]), authorityDocumentPath: null }, findings }); assert.equal(findings.length, 0, 'P7');
  fs.writeFileSync(full(root, A), Buffer.concat([a, Buffer.from('\nA advanced') ])); assert.equal(evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }).valid, true, 'A advance historical receipt'); assert.ok(collectCanonicalPredecessors(root, [A])[A].includes(presentPaths[0].sha256), 'A advance predecessor'); const retiredAfterA = evaluateBootstrapIssuance({ root }); assert.equal(retiredAfterA.valid, false, 'A advance retired'); assert.deepEqual(retiredAfterA.findings.map((x) => x.code), ['BOOTSTRAP_RETIRED'], 'A advance precise retirement'); fs.writeFileSync(full(root, A), a);
  fs.unlinkSync(full(root, A)); const retiredAfterADeletion = evaluateBootstrapIssuance({ root }); assert.equal(retiredAfterADeletion.valid, false, 'A deletion retired'); assert.deepEqual(retiredAfterADeletion.findings.map((x) => x.code), ['BOOTSTRAP_RETIRED'], 'A deletion precise retirement'); fs.writeFileSync(full(root, A), a);
  fs.writeFileSync(full(root, B), Buffer.concat([b, Buffer.from('\nB advanced') ])); assert.equal(evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }).valid, true, 'B advance historical receipt'); assert.ok(collectCanonicalPredecessors(root, [B])[B].includes(presentPaths[1].sha256), 'B advance predecessor'); const retiredAfterB = evaluateBootstrapIssuance({ root }); assert.equal(retiredAfterB.valid, false, 'B advance retired'); assert.deepEqual(retiredAfterB.findings.map((x) => x.code), ['BOOTSTRAP_RETIRED'], 'B advance precise retirement'); fs.writeFileSync(full(root, B), b);
  fs.writeFileSync(full(root, C), Buffer.concat([target, Buffer.from('\nC advanced') ])); assert.equal(evaluateHistoricalDurableTransitionReceipt({ root, receipt: transitionReceipt }).valid, true, 'C advance historical transition'); assert.equal(evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }).valid, true, 'C advance historical consumption'); const retiredAfterC = evaluateBootstrapIssuance({ root }); assert.equal(retiredAfterC.valid, false, 'C advance retired'); assert.deepEqual(retiredAfterC.findings.map((x) => x.code), ['BOOTSTRAP_RETIRED'], 'C advance precise retirement'); fs.writeFileSync(full(root, C), target);
  fs.unlinkSync(full(root, C)); assert.equal(evaluateHistoricalDurableTransitionReceipt({ root, receipt: transitionReceipt }).valid, true, 'C deletion historical transition'); assert.equal(evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }).valid, true, 'C deletion historical consumption'); const retiredAfterCDeletion = evaluateBootstrapIssuance({ root }); assert.equal(retiredAfterCDeletion.valid, false, 'C deletion retired'); assert.deepEqual(retiredAfterCDeletion.findings.map((x) => x.code), ['BOOTSTRAP_RETIRED'], 'C deletion precise retirement'); fs.writeFileSync(full(root, C), target);
  expectRefuse('transition receipt source mutation', () => evaluateHistoricalDurableTransitionReceipt({ root, receipt: { ...transitionReceipt, sourceSha256: '0'.repeat(64) } }));
  expectRefuse('transition receipt target mutation', () => evaluateHistoricalDurableTransitionReceipt({ root, receipt: { ...transitionReceipt, targetSha256: '0'.repeat(64) } }));
  expectRefuse('transition receipt authority SHA mutation', () => evaluateHistoricalDurableTransitionReceipt({ root, receipt: { ...transitionReceipt, authoritySha256: '0'.repeat(64) } }));
  const ownerBytes = fs.readFileSync(full(root, OWNER_AUTHORIZATION_PATH)); fs.unlinkSync(full(root, OWNER_AUTHORIZATION_PATH)); expectRefuse('N1', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority })); fs.writeFileSync(full(root, OWNER_AUTHORIZATION_PATH), ownerBytes);
  expectRefuse('N2', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority: { ...authority, ownerAuthorizationSha256: '0'.repeat(64) } }));
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, decisionId: 'WRONG' }); expectRefuse('N3', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority })); write(root, OWNER_AUTHORIZATION_PATH, owner);
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, bootstrapId: 'GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_R2' }); expectRefuse('N4', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority })); write(root, OWNER_AUTHORIZATION_PATH, owner);
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, authorityId: 'OTHER' }); expectRefuse('N5', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority })); write(root, OWNER_AUTHORIZATION_PATH, owner);
  const refreshedSha = h(fs.readFileSync(full(root, OWNER_AUTHORIZATION_PATH))); authority.ownerAuthorizationSha256 = refreshedSha; receipt.ownerAuthorizationSha256 = refreshedSha; transitionReceipt.ownerAuthorizationSha256 = refreshedSha; write(root, AUTHORITY_PATH, authority); write(root, TRANSITION_RECEIPT_PATH, transitionReceipt); write(root, CONSUMPTION_PATH, receipt);
  write(root, 'governance/authority/owner-present-byte-bootstrap/ALT.json', { ...authority, bootstrapId: 'GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_R2', authorityId: 'ALT' }); expectRefuse('N6', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt })); fs.unlinkSync(full(root, 'governance/authority/owner-present-byte-bootstrap/ALT.json'));
  write(root, 'governance/authority/owner-present-byte-bootstrap/SECOND.json', { ...authority, authorityId: 'SECOND' }); expectRefuse('N7', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt })); fs.unlinkSync(full(root, 'governance/authority/owner-present-byte-bootstrap/SECOND.json'));
  write(root, 'governance/historical-architecture/SECOND.json', { ...receipt, consumptionId: 'SECOND' }); expectRefuse('N8', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt })); fs.unlinkSync(full(root, 'governance/historical-architecture/SECOND.json'));
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, transition: { ...transition, sourceSha256: '0'.repeat(64) } }); expectRefuse('N9', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority }));
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, transition: { ...transition, targetSha256: '0'.repeat(64) } }); expectRefuse('N10', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority }));
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, presentPaths: [{ ...presentPaths[0], sha256: '0'.repeat(64) }, presentPaths[1]] }); expectRefuse('N11', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority }));
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, presentPaths: [{ ...presentPaths[0], byteLength: 0 }, presentPaths[1]] }); expectRefuse('N12', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority }));
  write(root, OWNER_AUTHORIZATION_PATH, owner); authority.ownerAuthorizationSha256 = h(fs.readFileSync(full(root, OWNER_AUTHORIZATION_PATH))); receipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256; transitionReceipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256; write(root, AUTHORITY_PATH, authority); write(root, TRANSITION_RECEIPT_PATH, transitionReceipt); write(root, CONSUMPTION_PATH, receipt);
  const savedA = fs.readFileSync(full(root, A)); fs.unlinkSync(full(root, A)); expectRefuse('N13', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority })); fs.writeFileSync(full(root, A), savedA);
  expectRefuse('N14', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority: { ...authority, presentPaths: [...presentPaths, { path: 'governance/x', sha256: h(Buffer.from('x')), byteLength: 1 }] } }));
  expectRefuse('N15', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority: { ...authority, gateId: 'GATE21' } }));
  expectRefuse('N16', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority: { ...authority, derivedFromGitDelta: true } })); expectRefuse('N17', () => evaluateOwnerPresentByteBootstrapAuthority({ root, authority: { ...authority, derivedFromFinalGateIntegrityFindings: true } }));
  expectRefuse('N18', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt: { ...receipt, documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION' } }));
  const savedAuthority = fs.readFileSync(full(root, AUTHORITY_PATH)); fs.unlinkSync(full(root, AUTHORITY_PATH)); expectRefuse('N19', () => evaluateOwnerPresentByteBootstrapConsumption({ root, receipt })); fs.writeFileSync(full(root, AUTHORITY_PATH), savedAuthority);
  expectRefuse('N20', () => evaluateBootstrapIssuance({ root }));

  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, preexistingByteRatificationPath: 'governance/authority/owner-present-byte-bootstrap/WRONG.json' });
  expectFinding('N21 wrong ratification path', evaluateOwnerPresentByteBootstrapAuthority({ root, authority }), 'OWNER_RATIFICATION_BINDING_MISMATCH');
  write(root, OWNER_AUTHORIZATION_PATH, owner);
  write(root, OWNER_AUTHORIZATION_PATH, { ...owner, preexistingByteRatificationSha256: '0'.repeat(64) });
  expectFinding('N22 wrong ratification SHA', evaluateOwnerPresentByteBootstrapAuthority({ root, authority }), 'OWNER_RATIFICATION_BINDING_MISMATCH');
  write(root, OWNER_AUTHORIZATION_PATH, owner); authority.ownerAuthorizationSha256 = h(fs.readFileSync(full(root, OWNER_AUTHORIZATION_PATH))); receipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256; transitionReceipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256; write(root, AUTHORITY_PATH, authority); write(root, TRANSITION_RECEIPT_PATH, transitionReceipt); write(root, CONSUMPTION_PATH, receipt);

  const savedRatification = fs.readFileSync(full(root, PREEXISTING_BYTE_RATIFICATION_PATH));
  fs.unlinkSync(full(root, PREEXISTING_BYTE_RATIFICATION_PATH));
  expectSuccessorRefuse('N23 ratification absent', root, 'PREEXISTING_BYTE_RATIFICATION_ABSENT');
  fs.writeFileSync(full(root, PREEXISTING_BYTE_RATIFICATION_PATH), savedRatification);

  function rehashAll(nextRatification, { includeOwner = true } = {}) {
    write(root, PREEXISTING_BYTE_RATIFICATION_PATH, nextRatification);
    const nextRatSha = h(fs.readFileSync(full(root, PREEXISTING_BYTE_RATIFICATION_PATH)));
    if (includeOwner) {
      write(root, OWNER_AUTHORIZATION_PATH, { ...owner, preexistingByteRatificationSha256: nextRatSha });
    }
    authority.preexistingByteRatificationSha256 = nextRatSha;
    if (includeOwner) authority.ownerAuthorizationSha256 = h(fs.readFileSync(full(root, OWNER_AUTHORIZATION_PATH)));
    receipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256;
    transitionReceipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256;
    write(root, AUTHORITY_PATH, authority);
    const nextAuthoritySha = h(fs.readFileSync(full(root, AUTHORITY_PATH)));
    transitionReceipt.authoritySha256 = nextAuthoritySha;
    receipt.authoritySha256 = nextAuthoritySha;
    write(root, TRANSITION_RECEIPT_PATH, transitionReceipt);
    write(root, CONSUMPTION_PATH, receipt);
    return { nextRatSha, authorityFromDisk: JSON.parse(fs.readFileSync(full(root, AUTHORITY_PATH), 'utf8')) };
  }
  function restoreCanonicalChain() {
    write(root, PREEXISTING_BYTE_RATIFICATION_PATH, ratification);
    write(root, OWNER_AUTHORIZATION_PATH, owner);
    authority.preexistingByteRatificationSha256 = ratificationSha;
    authority.ownerAuthorizationSha256 = h(fs.readFileSync(full(root, OWNER_AUTHORIZATION_PATH)));
    receipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256;
    transitionReceipt.ownerAuthorizationSha256 = authority.ownerAuthorizationSha256;
    write(root, AUTHORITY_PATH, authority);
    const restoredAuthoritySha = h(fs.readFileSync(full(root, AUTHORITY_PATH)));
    transitionReceipt.authoritySha256 = restoredAuthoritySha;
    receipt.authoritySha256 = restoredAuthoritySha;
    write(root, TRANSITION_RECEIPT_PATH, transitionReceipt);
    write(root, CONSUMPTION_PATH, receipt);
  }

  rehashAll({ ...ratification, observedByte: { ...observedByte, sha256: '0'.repeat(64) } });
  expectSuccessorRefuse('N24 wrong observed C', root, 'PREEXISTING_BYTE_RATIFICATION_INVALID');
  restoreCanonicalChain();
  rehashAll({ ...ratification, previousCanonical: { ...previousCanonical, path: A } });
  expectSuccessorRefuse('N25 wrong previous canonical anchor', root, 'PREEXISTING_BYTE_RATIFICATION_INVALID');
  restoreCanonicalChain();

  const stale = rehashAll({ ...ratification, previousCanonical: { ...previousCanonical, sha256: 'a'.repeat(64) } }, { includeOwner: false });
  expectFinding('N26 rehash previousCanonical owner unchanged', evaluateOwnerPresentByteBootstrapAuthority({ root, authority: stale.authorityFromDisk }), 'OWNER_RATIFICATION_BINDING_MISMATCH');
  restoreCanonicalChain();

  console.log('P1 P2 P3 P4 P5 P6 P7 N1 N2 N3 N4 N5 N6 N7 N8 N9 N10 N11 N12 N13 N14 N15 N16 N17 N18 N19 N20 N21 N22 N23 N24 N25 N26: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
