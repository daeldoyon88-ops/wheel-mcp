/**
 * Hostile tests for the post-closure release authority primitive (RA01–RA20).
 *
 * Every test asserts that the mechanism FAILS CLOSED. The single positive test
 * (RA04) exists only to prove the negatives are not passing vacuously.
 *
 * No test performs a Git write. The primitive is exercised as a pure decision
 * over synthetic observed state plus real out-of-repo files for the loader.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  evaluateReleaseAuthorization, computeManifestDigest, computeRequestDigest,
  canonicalize, sha256Hex, buildCommitPlan,
  PHASE_PRE_STAGE, PHASE_PRE_COMMIT, NEVER_GRANTABLE_OPERATIONS, GRANTABLE_OPERATIONS
} from '../core/release-authority.mjs';
import { loadReleaseAuthorization, loadOwnerReleaseKey } from '../core/release-authorization-source.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const OWNER_KEY = { keyId: 'TEST-OWNER-KEY', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };

const LEDGER_SHA = 'a'.repeat(64);
const WITNESS_SHA = 'b'.repeat(64);
const FILE_SHA = 'c'.repeat(64);
const HEAD = '0'.repeat(39) + '1';

function makeRequest(overrides = {}) {
  const manifest = overrides.manifest || [
    { path: 'governance/state/X.json', status: 'MODIFIED', workingTreeSha256: FILE_SHA, stageAction: 'STAGE_CONTENT' }
  ];
  const request = {
    schemaVersion: 1,
    documentKind: 'RELEASE_REQUEST',
    requestId: 'RR-TEST',
    projectId: 'TEST-PROJECT',
    repositoryOriginUrl: 'https://example.invalid/repo.git',
    branch: 'main',
    baseCommit: HEAD,
    purpose: 'POST_CLOSURE_LOCAL_RELEASE_COMMIT',
    workUnits: [{ workUnitType: 'WORK_UNIT', workUnitId: 'WU-1', closureVerdict: 'COMPLETE_CONFIRMED' }],
    governedStateBindings: [{ bindingId: 'CANONICAL_LEDGER', path: 'governance/state/L.ndjson', sha256: LEDGER_SHA }],
    externalWitness: { path: 'C:/outside/witness.json', sha256: WITNESS_SHA },
    requestedOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'],
    pushRequested: false,
    maxCommitCount: 1,
    commitMessage: 'release: persist validated work unit',
    ...overrides,
    manifest
  };
  request.manifestDigest = computeManifestDigest(request.manifest);
  request.requestDigest = computeRequestDigest(request);
  return request;
}

function signAuthorization(authorization, key = privateKey) {
  const { signature, ...rest } = authorization;
  return { ...authorization, signature: crypto.sign(null, Buffer.from(canonicalize(rest), 'utf8'), key).toString('base64') };
}

function makeAuthorization(request, overrides = {}) {
  const base = {
    schemaVersion: 1,
    documentKind: 'PROJECT_OWNER_RELEASE_AUTHORIZATION',
    authorizationId: 'RA-TEST',
    issuedBy: 'PROJECT_OWNER',
    issuedAtUtc: '2026-08-09T00:00:00.000Z',
    projectId: request.projectId,
    branch: request.branch,
    baseCommit: request.baseCommit,
    purpose: 'POST_CLOSURE_LOCAL_RELEASE_COMMIT',
    approvedRequestDigest: request.requestDigest,
    authorizedOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'],
    pushAllowed: false,
    maxCommitCount: 1,
    ownerKeyId: OWNER_KEY.keyId,
    signatureAlgorithm: 'ed25519',
    ...overrides
  };
  return signAuthorization(base);
}

function makeObserved(request, overrides = {}) {
  return {
    projectId: request.projectId,
    branch: request.branch,
    headCommit: request.baseCommit,
    governedStateSha256: { CANONICAL_LEDGER: LEDGER_SHA },
    externalWitnessSha256: WITNESS_SHA,
    externalWitnessIsExternal: true,
    manifestPathSha256: Object.fromEntries(request.manifest.map((e) => [e.path, e.workingTreeSha256])),
    stagedPaths: request.manifest.map((e) => e.path),
    workUnitClosures: Object.fromEntries(request.workUnits.map((u) => [u.workUnitId, u.closureVerdict])),
    ...overrides
  };
}

const codes = (result) => result.findings.map((f) => f.code);

// --- RA01 ------------------------------------------------------------------
test('RA01 no authorization at all is BLOCKED', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: null, authorizationLoadFinding: 'AUTHORIZATION_SOURCE_NOT_CONFIGURED',
    ownerKey: OWNER_KEY, observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('AUTHORIZATION_ABSENT'));
  assert.deepEqual(result.permittedOperations, []);
  assert.equal(result.commitPlan, null);
});

// --- RA02 / RA16 -----------------------------------------------------------
test('RA02+RA16 an authorization inside the governed set can never be loaded', () => {
  const governedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-governed-'));
  const inside = path.join(governedRoot, 'governance', 'SELF_AUTHORIZATION.json');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, JSON.stringify(makeAuthorization(makeRequest())), 'utf8');

  const loaded = loadReleaseAuthorization(inside, { governedRoots: [governedRoot] });
  assert.equal(loaded.authorization, null);
  assert.equal(loaded.finding, 'AUTHORIZATION_INSIDE_GOVERNED_SET');

  // and the decision layer refuses even if a caller passed the parsed object anyway
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: null, authorizationLoadFinding: 'AUTHORIZATION_INSIDE_GOVERNED_SET',
    ownerKey: OWNER_KEY, observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('AUTHORIZATION_INSIDE_GOVERNED_SET'));
});

// --- RA03 ------------------------------------------------------------------
test('RA03 a request the agent authored, with no owner authorization, grants nothing', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: null, ownerKey: OWNER_KEY,
    observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('AUTHORIZATION_ABSENT'));
});

test('RA03b an authorization signed by a key that is not the owner key is BLOCKED', () => {
  const request = makeRequest();
  const impostor = crypto.generateKeyPairSync('ed25519').privateKey;
  const { signature, ...unsigned } = makeAuthorization(request);
  const forged = signAuthorization(unsigned, impostor);
  const result = evaluateReleaseAuthorization({
    request, authorization: forged, ownerKey: OWNER_KEY,
    observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('AUTHORIZATION_SIGNATURE_INVALID'));
});

// --- RA04 ------------------------------------------------------------------
test('RA04 a valid owner authorization authorizes exactly one targeted local commit', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request), phase: PHASE_PRE_STAGE, now: new Date('2026-08-09T01:00:00Z')
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.decision, 'AUTHORIZED');
  assert.deepEqual(result.permittedOperations, ['GIT_ADD_PATHSPEC', 'GIT_COMMIT']);
  assert.equal(result.commitPlan.pushAllowed, false);
  assert.equal(result.commitPlan.pushCommand, null);
  const flat = result.commitPlan.commands.map((c) => c.join(' '));
  assert.ok(flat.some((c) => c === 'git add -- governance/state/X.json'));
  assert.ok(flat.some((c) => c.startsWith('git commit -m ')));
  assert.ok(!flat.some((c) => /(\badd\b.*(-A|\.$)|commit .*-a\b|push)/.test(c)));
});

// --- RA05 ------------------------------------------------------------------
test('RA05 a different base HEAD is BLOCKED', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request, { headCommit: 'f'.repeat(40) }), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('BASE_HEAD_MISMATCH'));
});

// --- RA06 ------------------------------------------------------------------
test('RA06 a drifted canonical ledger is BLOCKED', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request, { governedStateSha256: { CANONICAL_LEDGER: 'd'.repeat(64) } }), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('GOVERNED_STATE_BINDING_MISMATCH'));
});

// --- RA07 ------------------------------------------------------------------
test('RA07 a drifted or relocated external witness is BLOCKED', () => {
  const request = makeRequest();
  const drifted = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request, { externalWitnessSha256: 'e'.repeat(64) }), phase: PHASE_PRE_STAGE
  });
  assert.ok(codes(drifted).includes('EXTERNAL_WITNESS_BINDING_MISMATCH'));

  const internalized = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request, { externalWitnessIsExternal: false }), phase: PHASE_PRE_STAGE
  });
  assert.ok(codes(internalized).includes('EXTERNAL_WITNESS_INSIDE_GOVERNED_SET'));
});

// --- RA08 ------------------------------------------------------------------
test('RA08 broadening the approved path set invalidates the owner signature binding', () => {
  const approved = makeRequest();
  const authorization = makeAuthorization(approved);
  const broadened = makeRequest({
    manifest: [
      { path: 'governance/state/X.json', status: 'MODIFIED', workingTreeSha256: FILE_SHA, stageAction: 'STAGE_CONTENT' },
      { path: 'server.js', status: 'MODIFIED', workingTreeSha256: FILE_SHA, stageAction: 'STAGE_CONTENT' }
    ]
  });
  const result = evaluateReleaseAuthorization({
    request: broadened, authorization, ownerKey: OWNER_KEY,
    observed: makeObserved(broadened), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('REQUEST_DIGEST_MISMATCH'));
});

// --- RA09 ------------------------------------------------------------------
test('RA09 approved bytes changed after approval is BLOCKED', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request, { manifestPathSha256: { 'governance/state/X.json': '9'.repeat(64) } }),
    phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('MANIFEST_ENTRY_BYTES_CHANGED'));
});

// --- RA10 / RA11 -----------------------------------------------------------
test('RA10+RA11 `git add .` / `git add -A` are detected as extra staged paths', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request, { stagedPaths: ['governance/state/X.json', 'debug/scratch.md', '.env'] }),
    phase: PHASE_PRE_COMMIT
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('STAGED_PATH_NOT_APPROVED'));
});

test('RA10b bulk-add operations can never be requested or granted', () => {
  for (const operation of ['GIT_ADD_ALL', 'GIT_ADD_DOT']) {
    assert.ok(NEVER_GRANTABLE_OPERATIONS.includes(operation));
    assert.ok(!GRANTABLE_OPERATIONS.includes(operation));
    const request = makeRequest({ requestedOperations: [operation] });
    const result = evaluateReleaseAuthorization({
      request, authorization: makeAuthorization(request, { authorizedOperations: [operation] }),
      ownerKey: OWNER_KEY, observed: makeObserved(request), phase: PHASE_PRE_STAGE
    });
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('FORBIDDEN_OPERATION_REQUESTED'));
    assert.ok(codes(result).includes('FORBIDDEN_OPERATION_GRANTED'));
  }
});

// --- RA12 ------------------------------------------------------------------
test('RA12 `git commit -a` can never be granted', () => {
  assert.ok(NEVER_GRANTABLE_OPERATIONS.includes('GIT_COMMIT_ALL'));
  const request = makeRequest({ requestedOperations: ['GIT_COMMIT_ALL'] });
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request, { authorizedOperations: ['GIT_COMMIT_ALL'] }),
    ownerKey: OWNER_KEY, observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('FORBIDDEN_OPERATION_GRANTED'));
});

// --- RA13 ------------------------------------------------------------------
test('RA13 the same authorization cannot authorize a second commit', () => {
  const request = makeRequest();
  const authorization = makeAuthorization(request);
  // After the first commit lands, HEAD has moved — the binding is naturally stale.
  const afterCommit = evaluateReleaseAuthorization({
    request, authorization, ownerKey: OWNER_KEY,
    observed: makeObserved(request, { headCommit: '2'.repeat(40) }), phase: PHASE_PRE_STAGE
  });
  assert.equal(afterCommit.decision, 'BLOCKED');
  assert.ok(codes(afterCommit).includes('BASE_HEAD_MISMATCH'));

  // Belt and braces: an explicit consumption record also blocks, even at the same HEAD.
  const replayed = evaluateReleaseAuthorization({
    request, authorization, ownerKey: OWNER_KEY, observed: makeObserved(request),
    phase: PHASE_PRE_STAGE, consumptionRecord: { commit: '2'.repeat(40) }
  });
  assert.equal(replayed.decision, 'BLOCKED');
  assert.ok(codes(replayed).includes('AUTHORIZATION_ALREADY_CONSUMED'));
});

// --- RA14 / RA15 -----------------------------------------------------------
test('RA14+RA15 push and force push are outside this authority kind entirely', () => {
  for (const operation of ['GIT_PUSH', 'GIT_PUSH_FORCE']) {
    assert.ok(NEVER_GRANTABLE_OPERATIONS.includes(operation));
  }
  const request = makeRequest();
  const claimsPush = makeAuthorization(request, { pushAllowed: true });
  const result = evaluateReleaseAuthorization({
    request, authorization: claimsPush, ownerKey: OWNER_KEY,
    observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PUSH_NOT_AUTHORIZED'));

  // Even an AUTHORIZED plan never contains a push command.
  const authorized = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(authorized.commitPlan.pushCommand, null);
  assert.equal(buildCommitPlan(request).pushAllowed, false);
});

// --- RA17 ------------------------------------------------------------------
test('RA17 an authorization issued for a previous work unit does not carry over', () => {
  const previous = makeRequest({ workUnits: [{ workUnitType: 'WORK_UNIT', workUnitId: 'WU-0', closureVerdict: 'COMPLETE_CONFIRMED' }] });
  const stale = makeAuthorization(previous);
  const current = makeRequest();
  const result = evaluateReleaseAuthorization({
    request: current, authorization: stale, ownerKey: OWNER_KEY,
    observed: makeObserved(current), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('REQUEST_DIGEST_MISMATCH'));
});

test('RA17b a work unit that is not actually closed is BLOCKED', () => {
  const request = makeRequest();
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request, { workUnitClosures: { 'WU-1': 'IN_PROGRESS' } }), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('CLOSURE_VERDICT_MISMATCH'));
});

// --- RA18 ------------------------------------------------------------------
test('RA18 an authorization for a different project cannot be used here', () => {
  const request = makeRequest();
  const foreign = makeAuthorization(request, { projectId: 'SOME-OTHER-PROJECT' });
  const result = evaluateReleaseAuthorization({
    request, authorization: foreign, ownerKey: OWNER_KEY,
    observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PROJECT_ID_MISMATCH'));
  assert.ok(codes(result).includes('AUTHORIZATION_REQUEST_PROJECT_MISMATCH'));
});

// --- RA19 ------------------------------------------------------------------
test('RA19 unknown fields, wrong kinds and expiry all fail closed', () => {
  const request = makeRequest();

  const extraField = { ...makeAuthorization(request), grantEverything: true };
  assert.ok(codes(evaluateReleaseAuthorization({
    request, authorization: extraField, ownerKey: OWNER_KEY, observed: makeObserved(request)
  })).includes('AUTHORIZATION_UNKNOWN_FIELD'));

  const wrongKind = makeAuthorization(request, { documentKind: 'GEE_HEAD_WITNESS' });
  assert.ok(codes(evaluateReleaseAuthorization({
    request, authorization: wrongKind, ownerKey: OWNER_KEY, observed: makeObserved(request)
  })).includes('AUTHORIZATION_WRONG_DOCUMENT_KIND'));

  const notOwner = makeAuthorization(request, { issuedBy: 'AGENT' });
  assert.ok(codes(evaluateReleaseAuthorization({
    request, authorization: notOwner, ownerKey: OWNER_KEY, observed: makeObserved(request)
  })).includes('AUTHORIZATION_NOT_ISSUED_BY_PROJECT_OWNER'));

  const expired = makeAuthorization(request, { expiresAtUtc: '2026-08-09T00:00:01.000Z' });
  assert.ok(codes(evaluateReleaseAuthorization({
    request, authorization: expired, ownerKey: OWNER_KEY, observed: makeObserved(request),
    now: new Date('2026-08-10T00:00:00Z')
  })).includes('AUTHORIZATION_EXPIRED'));

  const tampered = makeRequest();
  tampered.requestDigest = 'f'.repeat(64);
  assert.ok(codes(evaluateReleaseAuthorization({
    request: tampered, authorization: makeAuthorization(request), ownerKey: OWNER_KEY, observed: makeObserved(request)
  })).includes('REQUEST_DIGEST_SELF_INCONSISTENT'));

  const traversal = makeRequest({
    manifest: [{ path: '../outside.json', status: 'MODIFIED', workingTreeSha256: FILE_SHA, stageAction: 'STAGE_CONTENT' }]
  });
  assert.ok(codes(evaluateReleaseAuthorization({
    request: traversal, authorization: makeAuthorization(traversal), ownerKey: OWNER_KEY, observed: makeObserved(traversal)
  })).includes('MANIFEST_PATH_NOT_REPO_RELATIVE'));
});

test('RA19b a missing or private owner key never yields a pass', () => {
  const request = makeRequest();
  assert.ok(codes(evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: null, observed: makeObserved(request)
  })).includes('OWNER_PUBLIC_KEY_UNAVAILABLE'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-key-'));
  const privatePath = path.join(dir, 'key.json');
  fs.writeFileSync(privatePath, JSON.stringify({ keyId: 'K', publicKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' }), 'utf8');
  assert.equal(loadOwnerReleaseKey(privatePath).finding, 'OWNER_PRIVATE_KEY_IN_GOVERNED_SET');
  assert.equal(loadOwnerReleaseKey(path.join(dir, 'absent.json')).finding, 'OWNER_PUBLIC_KEY_UNAVAILABLE');
});

// --- RA20 ------------------------------------------------------------------
test('RA20 a future, non-gate work unit uses the same primitive with no new code', () => {
  const request = makeRequest({
    workUnits: [
      { workUnitType: 'MODULE', workUnitId: 'GEE_V1_R2', closureVerdict: 'RELEASED' },
      { workUnitType: 'DATASET', workUnitId: 'DS-2027-01', closureVerdict: 'FROZEN' }
    ]
  });
  const result = evaluateReleaseAuthorization({
    request, authorization: makeAuthorization(request), ownerKey: OWNER_KEY,
    observed: makeObserved(request), phase: PHASE_PRE_STAGE
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.decision, 'AUTHORIZED');

  // No project-specific literal in the generic core's executable code. Prose in
  // comments may name the first consumer; code may not depend on it.
  const coreCode = fs.readFileSync(new URL('../core/release-authority.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/GATE\d/.test(coreCode), 'generic core code must not name any gate');
  assert.ok(!/wheel/i.test(coreCode), 'generic core code must not name the project');
  assert.ok(!/REPO-|JARVISE/.test(coreCode), 'generic core code must not name the repository');
});

// --- digest determinism ----------------------------------------------------
test('digests are deterministic and key-order independent', () => {
  const a = makeRequest();
  const reordered = JSON.parse(JSON.stringify(a));
  const shuffled = {};
  for (const key of Object.keys(reordered).reverse()) shuffled[key] = reordered[key];
  assert.equal(computeRequestDigest(shuffled), computeRequestDigest(a));
  assert.equal(sha256Hex(canonicalize({ b: 1, a: 2 })), sha256Hex(canonicalize({ a: 2, b: 1 })));
});
