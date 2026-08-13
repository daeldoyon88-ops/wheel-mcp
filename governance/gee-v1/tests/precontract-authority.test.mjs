import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  authorizationSigningPayload,
  canonicalize
} from '../core/release-authority.mjs';
import {
  computePrecontractRequestDigest,
  evaluatePrecontractAuthority,
  isPrecontractPathAuthorized,
  PRECONTRACT_OPERATION
} from '../core/precontract-authority.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { createWheelPrecontractAuthoritySource } from '../adapters/wheel/precontract-authority-source.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BOOTSTRAP_PATHS = [
  'governance/GATE_REGISTRY_00_40.json',
  'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json',
  'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json'
];
const PROHIBITIONS = [
  'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_CONFIRMED', 'ARBITRARY_LEDGER_TRANSITION',
  'GIT_PUSH', 'ARBITRARY_GOVERNANCE_WRITE', 'OTHER_GATE', 'GEE_REVISION_CREATION', 'FUNCTIONAL_GATE_EXECUTION'
];

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function latest(root, gateId) {
  return fs.readFileSync(path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter((event) => event.gateId === gateId).at(-1);
}
function makeFixture() {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const ownerKey = { keyId: 'TEST-PRECONTRACT-OWNER', publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const ledgerBytes = fs.readFileSync(path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson'));
  const predecessor = latest(REPO_ROOT, 'GATE13');
  const request = {
    schemaVersion: 1, documentKind: 'PRECONTRACT_AUTHORITY_REQUEST', requestId: 'REQ-GATE14-R1', projectId: 'WHEEL', gateId: 'GATE14',
    purpose: 'BOOTSTRAP_CONTRACT_CANONICALIZATION', operation: PRECONTRACT_OPERATION,
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(), ledgerSha256: sha256(ledgerBytes), currentStatus: 'NOT_STARTED',
    dependencyProof: { gateId: 'GATE13', status: predecessor.toStatus, authorityPath: predecessor.authorityPath, authoritySha256: predecessor.authoritySha256 },
    authorizedPaths: BOOTSTRAP_PATHS, artifactBindings: BOOTSTRAP_PATHS.map((entry, index) => ({ path: entry, sha256: `${String(index + 1).repeat(64)}` })),
    expiresAtUtc: '2099-01-01T00:00:00.000Z', maxUse: 1, prohibitedOperations: PROHIBITIONS
  };
  request.requestDigest = computePrecontractRequestDigest(request);
  const unsignedAuthority = {
    schemaVersion: 1, documentKind: 'ACTIVE_PRECONTRACT_AUTHORITY', authorityId: 'AUTH-GATE14-R1', issuedBy: 'PROJECT_OWNER', issuedAtUtc: '2026-08-10T00:00:00.000Z',
    approvedRequestDigest: request.requestDigest, projectId: request.projectId, gateId: request.gateId, purpose: request.purpose, operation: request.operation,
    authorizedPaths: request.authorizedPaths, artifactBindings: request.artifactBindings, expiresAtUtc: request.expiresAtUtc, maxUse: 1, ownerKeyId: ownerKey.keyId, signatureAlgorithm: 'ed25519'
  };
  const authority = { ...unsignedAuthority, signature: crypto.sign(null, Buffer.from(authorizationSigningPayload(unsignedAuthority), 'utf8'), keyPair.privateKey).toString('base64') };
  const observed = {
    projectId: 'WHEEL', gateId: 'GATE14', headCommit: request.baseCommit, ledgerSha256: request.ledgerSha256, currentStatus: 'NOT_STARTED', currentContractPresent: false, consumed: false,
    dependencyProof: request.dependencyProof
  };
  return { request, authority, ownerKey, observed, keyPair };
}
function cloneFixture() {
  const fixture = makeFixture();
  return { ...fixture, request: structuredClone(fixture.request), authority: structuredClone(fixture.authority), observed: structuredClone(fixture.observed) };
}
function codes(result) { return result.findings.map((finding) => finding.code); }

test('P01/P02/P04/P05: valid GATE14 precontract authority resolves without execution authority', () => {
  const fixture = makeFixture();
  const result = evaluatePrecontractAuthority(fixture);
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.bootstrapAuthorized, true);
  assert.deepEqual(result.authorizedPaths, BOOTSTRAP_PATHS);
  assert.equal(fixture.observed.currentContractPresent, false);
  assert.equal(fixture.observed.dependencyProof.status, 'COMPLETE_CONFIRMED');
  assert.equal(result.executionAuthorized, undefined);
});

test('P03: CURRENT_CONTRACT presence removes precontract eligibility', () => {
  const fixture = cloneFixture();
  fixture.observed.currentContractPresent = true;
  const result = evaluatePrecontractAuthority(fixture);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('CURRENT_CONTRACT_PRESENT'));
});

test('schema: valid request and owner authority match their canonical schemas', () => {
  const fixture = makeFixture();
  const requestSchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/schemas/precontract-authority-request.schema.json')));
  const authoritySchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/schemas/precontract-authority.schema.json')));
  assert.equal(validateAgainstJsonSchema(fixture.request, requestSchema).valid, true);
  assert.equal(validateAgainstJsonSchema(fixture.authority, authoritySchema).valid, true);
});

const hostileCases = [
  ['H01 wrong gateId', (f) => { f.request.gateId = 'GATE15'; }],
  ['H02 wrong base commit', (f) => { f.observed.headCommit = '0'.repeat(40); }],
  ['H03 wrong ledger SHA', (f) => { f.observed.ledgerSha256 = '0'.repeat(64); }],
  ['H04 status not NOT_STARTED', (f) => { f.observed.currentStatus = 'IN_PROGRESS'; }],
  ['H05 predecessor not terminal', (f) => { f.observed.dependencyProof.status = 'NOT_STARTED'; }],
  ['H06 unauthorized path', (f) => { f.request.authorizedPaths = ['governance/gates/GATE14/implementation/x.mjs']; }],
  ['H07 file prefix sibling escape', (f) => { assert.equal(isPrecontractPathAuthorized(BOOTSTRAP_PATHS, `${BOOTSTRAP_PATHS[0]}.evil`), false); f.observed.currentContractPresent = true; }],
  ['H08 traversal path', (f) => { f.request.authorizedPaths = ['governance/gates/GATE14/contracts/../x.json']; }],
  ['H09 absolute path', (f) => { f.request.authorizedPaths = ['/governance/GATE_REGISTRY_00_40.json']; }],
  ['H10 GATE15 path', (f) => { f.request.authorizedPaths = ['governance/gates/GATE15/contracts/CURRENT_CONTRACT.json']; }],
  ['H11 GEE R8 path', (f) => { f.request.authorizedPaths = ['governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0008.json']; }],
  ['H12 START claim', (f) => { f.request.operation = 'START'; }],
  ['H13 expired authority', (f) => { f.authority.expiresAtUtc = '2020-01-01T00:00:00.000Z'; }],
  ['H14 replay consumed', (f) => { f.observed.consumed = true; }],
  ['H15 modified request', (f) => { f.request.requestId = 'MUTATED'; }],
  ['H16 substituted bytes', (f) => { f.observed.currentContractPresent = true; f.observed.targetFileSha256 = Object.fromEntries(f.request.artifactBindings.map((entry) => [entry.path, '0'.repeat(64)])); const result = evaluatePrecontractAuthority({ ...f, phase: 'VERIFY_CONSUMPTION' }); assert.ok(codes(result).includes('ARTIFACT_BYTES_MISMATCH')); f.observed.consumed = true; }],
  ['H17 invalid owner signature', (f) => { f.authority.signature = 'invalid'; }],
  ['H18 competing authorities', (f) => { f.authority.authorityId = 'SECOND'; }],
  ['H19 wildcard governance', (f) => { f.request.authorizedPaths = ['governance/**']; }],
  ['H20 functional execution', (f) => { f.operation = 'FUNCTIONAL_GATE_EXECUTION'; }]
];

for (const [name, mutate] of hostileCases) {
  test(`${name} blocks deterministically`, () => {
    const fixture = cloneFixture();
    mutate(fixture);
    const result = evaluatePrecontractAuthority(fixture);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(result.findings.length > 0);
  });
}

test('Wheel source resolves a real external fixture and rejects competing sources', () => {
  const fixture = makeFixture();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'precontract-authority-'));
  try {
    const requestPath = path.join(temp, 'request.json');
    const authorityPath = path.join(temp, 'authority.json');
    const keyPath = path.join(temp, 'owner.json');
    fs.writeFileSync(requestPath, JSON.stringify(fixture.request));
    fs.writeFileSync(authorityPath, JSON.stringify(fixture.authority));
    fs.writeFileSync(keyPath, JSON.stringify(fixture.ownerKey));
    const source = createWheelPrecontractAuthoritySource(REPO_ROOT, { requestPath, authorityPath, ownerKeyPath: keyPath });
    const result = source.resolvePrecontractAuthority('GATE14');
    assert.equal(result.decision, 'AUTHORIZED');
    assert.equal(result.executionAuthorized, false);
    const cli = spawnSync(process.execPath, ['governance/tools/validate-precontract-authority.mjs', '--request', requestPath, '--authority', authorityPath, '--owner-key', keyPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.equal(JSON.parse(cli.stdout).bootstrapAuthorized, true);
    const conflict = createWheelPrecontractAuthoritySource(REPO_ROOT, { requestPaths: [requestPath, requestPath], authorityPaths: [authorityPath, authorityPath], ownerKeyPath: keyPath }).resolvePrecontractAuthority('GATE14');
    assert.equal(conflict.decision, 'BLOCKED');
    assert.ok(conflict.findings.some((finding) => finding.code === 'PRECONTRACT_AUTHORITY_CONFLICT'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('preflight integration keeps PRECONTRACT non-executable when authority is absent', () => {
  const result = spawnSync(process.execPath, ['governance/tools/governance-preflight.mjs', '--work-unit-type', 'PRECONTRACT', '--work-unit-id', 'GATE14'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.bootstrapAuthorized, false);
  assert.equal(report.workUnit.decision, 'BLOCKED');
});
