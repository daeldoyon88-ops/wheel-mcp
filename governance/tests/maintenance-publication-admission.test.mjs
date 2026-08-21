/**
 * PRE-PUBLICATION ADMISSION — positive control through the real consumer, and
 * sixteen hostile controls that each name the exact thing that refused.
 *
 * ON THE OWNER / BUILD BOUNDARY, WHICH THIS FILE DEPENDS ON BEING CLEAR.
 *
 * Everything under FIXTURE OWNER DATA below is CEREMONY-SHAPED TEST DATA built
 * inside a throwaway git repository in the OS temp directory. It is not Owner
 * data, it does not exist in this repository, and it authorizes nothing here. Its
 * only job is to let the design be exercised end to end by the genuine publisher
 * without performing a ceremony.
 *
 * The real GATE20 Repair-B objects ARE read, and are asserted to be FAIL-CLOSED:
 * no Owner admission exists for them, so they cannot publish. That is the correct
 * present state and the test pins it, so that an admission appearing later is a
 * visible, deliberate act rather than a silent one.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
  ADMISSION_DIRECTORY,
  ADMISSION_REGISTRY_PATH,
  ADMISSION_DENIED_PERMISSIONS,
  ADMISSION_REQUIRED_PROHIBITED_OPERATIONS,
  computeAdmissionRegistryDigest,
  computeMaintenancePublicationAdmissionDigest,
  evaluateMaintenancePublicationAdmission,
  resolveMaintenancePublicationAdmission,
  validateAdmissionRegistryShape,
  validateMaintenancePublicationAdmissionShape
} from '../gee-v1/core/maintenance-publication-admission.mjs';
import {
  MODE_ADMISSION,
  MODE_PUBLICATION,
  evaluateMaintenanceSourceAdmissibility
} from '../gee-v1/core/maintenance-publication-admissibility.mjs';
import {
  REQUIRED_PROHIBITED_OPERATIONS,
  validateConsumptionRecordCoherence,
  validateMaintenanceAuthorizedPathManifest
} from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import { applyPathPrestateProgram } from '../tools/apply-path-prestate-program.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bytesOf = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

const GATE = 'GATE20';
const PROGRAM_ID = 'FIXTURE_REPAIR_B_POSITIVE_PUBLICATION_R1';
const AUTHORITY_ID = 'FIXTURE_REPAIR_B_POSITIVE_PUBLICATION_LOCAL_AUTHORITY_R1';
const MANIFEST_ID = 'FIXTURE_REPAIR_B_POSITIVE_PUBLICATION_AUTHORIZED_PATHS_R1';
const ADMISSION_ID = 'FIXTURE_REPAIR_B_PUBLICATION_ADMISSION_R1';
const DECISION_ID = 'FIXTURE_REPAIR_B_PUBLICATION_ADMISSION_DECISION_R1';

const AUTHORITY_PATH = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_FIXTURE_REPAIR_B_R1.json';
const MANIFEST_PATH = 'governance/historical-architecture/FIXTURE_REPAIR_B_AUTHORIZED_PATHS_R1.json';
const CONSUMPTION_PATH = 'governance/historical-architecture/FIXTURE_REPAIR_B_CONSUMPTION_R1.json';
const ADMISSION_PATH = `${ADMISSION_DIRECTORY}/${GATE}/PROJECT_OWNER_MAINTENANCE_PUBLICATION_ADMISSION_FIXTURE_REPAIR_B_R1.json`;
const R2_ADMISSION_REGISTRY_PATH = 'governance/sources/MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION_R2.json';
const TRACKED_TARGET = 'governance/tools/fixture-tracked.mjs';
const NEW_TARGET = 'governance/tools/fixture-created.mjs';

const COMMITTED_BYTES = Buffer.from('export const value = 1;\n', 'utf8');
const CANDIDATE_TRACKED = Buffer.from('export const value = 2;\n', 'utf8');
const CANDIDATE_NEW = Buffer.from('export const created = true;\n', 'utf8');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root, relativePath, bytes) {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const readJson = (root, relativePath) => JSON.parse(fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8'));
const fileSha = (root, relativePath) => sha256(fs.readFileSync(path.join(root, ...relativePath.split('/'))));

/* =================================================================== *
 *  BUILD-TIME CODE — a minimal but genuine governed repository.
 * =================================================================== */

function makeFixtureRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-admission-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  fs.mkdirSync(path.join(root, 'governance', 'gates'), { recursive: true });
  write(root, TRACKED_TARGET, COMMITTED_BYTES);
  write(root, 'governance/active/ACTIVE_GATE.json', bytesOf({ activeGate: 'GATE13' }));
  write(root, `governance/gates/${GATE}/state/CURRENT_STATE.json`, bytesOf({ stateRevision: 'R0003' }));
  write(root, `governance/gates/${GATE}/contracts/CURRENT_CONTRACT.json`, bytesOf({ contractRevision: 'R0001' }));
  const ledger = `${[
    JSON.stringify({ ordinal: 1, gateId: GATE, toStatus: 'IN_PROGRESS' }),
    JSON.stringify({ ordinal: 2, gateId: GATE, toStatus: 'COMPLETE_AGENT' })
  ].join('\n')}\n`;
  write(root, 'governance/state/GATE_STATUS_LEDGER.ndjson', Buffer.from(ledger, 'utf8'));
  write(root, '.gitkeep', Buffer.from('', 'utf8'));

  git(root, ['add', '--', '.gitkeep', TRACKED_TARGET, 'governance']);
  git(root, ['commit', '-q', '-m', 'fixture base']);

  return {
    root,
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    ledgerBytes: fs.readFileSync(path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'))
  };
}

/**
 * The manifest. Note what it does NOT contain: the admission record and the Owner
 * registry. They are causally prior INPUTS to this publication, not outputs of it,
 * which is exactly the property Control 15 protects. The authority and the manifest
 * do appear, under the existing bootstrap self-exclusion, because the evaluator
 * must read both of them in order to run at all.
 */
function makeManifest(overrides = {}) {
  return {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORIZED_PATH_MANIFEST',
    schemaVersion: 2,
    manifestId: MANIFEST_ID,
    programId: PROGRAM_ID,
    prestateSelfExclusion: [
      { path: AUTHORITY_PATH, role: 'AUTHORITY_DOCUMENT', reason: 'The authority must exist for the canonical consumer to load it before publication.' },
      { path: MANIFEST_PATH, role: 'AUTHORIZED_PATH_MANIFEST', reason: 'The manifest must exist for the authority to pin its exact digest before publication.' }
    ],
    paths: [
      { path: AUTHORITY_PATH, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'single-use positive local authority', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } },
      { path: MANIFEST_PATH, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'exact finite cohort', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } },
      { path: CONSUMPTION_PATH, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'single-use consumption receipt', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } },
      { path: TRACKED_TARGET, operation: 'MODIFY', phase: 'MAINTENANCE', reason: 'advance committed tool', artifactClass: 'MAINTENANCE', prestate: { state: 'PRESENT', sha256: sha256(COMMITTED_BYTES), byteLength: COMMITTED_BYTES.length } },
      { path: NEW_TARGET, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'new tool', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } }
    ],
    ...overrides
  };
}

function makeAuthority(fixture, manifestBytes, overrides = {}) {
  return {
    document: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY',
    schemaVersion: 2,
    authorityId: AUTHORITY_ID,
    authorityClass: 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY',
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    createdAt: '2026-08-18T00:00:00.000Z',
    expiresAt: '2026-12-31T23:59:59.000Z',
    targetSystem: 'PROJECT_GOVERNANCE',
    programId: PROGRAM_ID,
    authorityPurpose: 'NORMAL_MAINTENANCE',
    resumePoint: 'CP-FIXTURE-REPAIR-B',
    maxUse: 1,
    preState: {
      baseHead: fixture.head,
      ledgerEventCount: 2,
      ledgerPrefixSha256: sha256(fixture.ledgerBytes),
      gateId: GATE,
      gateStatus: 'COMPLETE_AGENT',
      stateRevision: 'R0003',
      contractRevision: 'R0001',
      activeGate: 'GATE13',
      R8ExpectedAbsent: true
    },
    authorizedPathManifestPath: MANIFEST_PATH,
    authorizedPathManifestSha256: sha256(manifestBytes),
    authorizedOperationClasses: ['MAINTENANCE'],
    commitPolicy: {
      maxCommitCount: 1,
      allowedGitOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'],
      commitMessage: 'governance: fixture repair-b publication',
      thirdCommitAuthorized: false
    },
    pushAuthorized: false,
    authorityPredecessor: null,
    authorityHeadBinding: { mode: 'BASE_HEAD', baseHead: fixture.head },
    consumptionRecordPath: CONSUMPTION_PATH,
    prohibitedOperations: [...REQUIRED_PROHIBITED_OPERATIONS],
    ...overrides
  };
}

/* =================================================================== *
 *  FIXTURE OWNER DATA — ceremony-SHAPED, never ceremony.
 *
 *  These two documents stand in for the Project Owner's decision. They live
 *  only inside the temp fixture. Nothing here is written into this repository
 *  and nothing here admits anything in it.
 * =================================================================== */

function makeAdmission(fixture, authority, authorityBytes, manifest, manifestBytes, overrides = {}, ownerAuthorizationPath = ADMISSION_REGISTRY_PATH) {
  const admission = {
    documentKind: 'MAINTENANCE_PUBLICATION_ADMISSION',
    schemaVersion: 1,
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    admissionId: ADMISSION_ID,
    decisionId: DECISION_ID,
    issuedAtUtc: '2026-08-18T00:00:00.000Z',
    expiresAtUtc: null,
    projectId: 'WHEEL',
    repositoryId: 'WHEEL_MCP_CANONICAL_FIXTURE',
    gateId: GATE,
    programId: PROGRAM_ID,
    purpose: 'MAINTENANCE_PUBLICATION_ADMISSION',
    publicationClass: 'PATH_PRESTATE_PROGRAM_PUBLISHER',
    authorityPurpose: 'NORMAL_MAINTENANCE',
    maxUse: 1,
    admissionStatement: 'The Project Owner admits this one exact maintenance publication, against this one exact repository pre-state, once. It is not a licence and confers no permission over any later bytes.',
    admittedAuthority: {
      path: AUTHORITY_PATH, sha256: sha256(authorityBytes), byteLength: authorityBytes.length,
      schemaVersion: 2, documentId: authority.authorityId
    },
    admittedManifest: {
      path: MANIFEST_PATH, sha256: sha256(manifestBytes), byteLength: manifestBytes.length,
      schemaVersion: 2, documentId: manifest.manifestId
    },
    admittedPrestate: { ...authority.preState },
    admittedOperationClasses: [...authority.authorizedOperationClasses],
    grantsFutureBytePermission: false,
    grantsGateAuthorizationPermission: false,
    grantsStartPermission: false,
    grantsStatusTransitionPermission: false,
    grantsHistoricalAdmissionWidening: false,
    genericV1Admission: false,
    derivedFromGitDelta: false,
    derivedFromFinalGateIntegrityFindings: false,
    prohibitedOperations: [...ADMISSION_REQUIRED_PROHIBITED_OPERATIONS],
    successorRequirement: 'A future publication over changed bytes requires a NEW authority, a NEW pre-state and a NEW admission. This decision is never a shortcut.',
    ...overrides
  };
  admission.admissionDigest = computeMaintenancePublicationAdmissionDigest(admission);
  admission.ownerAuthorizationPath = ownerAuthorizationPath;
  return admission;
}

function makeRegistry(admission, entryOverrides = {}, registryOverrides = {}) {
  const registry = {
    document: 'MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION',
    schemaVersion: 1,
    authorityId: 'MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION_R1',
    authorityClass: 'PROJECT_OWNER_MAINTENANCE_PUBLICATION_ADMISSION_AUTHORITY',
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    issuedAtUtc: '2026-08-18T00:00:00.000Z',
    decisionId: DECISION_ID,
    purpose: 'Enumerate the maintenance publications the Project Owner has admitted. The registry is an index and never a grant; each admission record carries the exact bound bytes.',
    reexecutionAuthorized: false,
    grantsFutureBytePermission: false,
    genericV1Admission: false,
    admittedPublications: [{
      admissionId: admission.admissionId,
      projectId: admission.projectId,
      gateId: admission.gateId,
      programId: admission.programId,
      admissionPath: ADMISSION_PATH,
      admissionDigest: admission.admissionDigest,
      ...entryOverrides
    }],
    ...registryOverrides
  };
  registry.registryDigest = computeAdmissionRegistryDigest(registry);
  return registry;
}

/**
 * Installs the whole chain in the one order the mutual bindings permit:
 *
 *   manifest -> authority (pins manifest digest) -> admission (pins both, sealed
 *   by identity digest) -> registry (pins admission identity digest) -> admission
 *   back-reference (pins the registry FILE digest)
 *
 * The back-reference is written last because it is the only binding that depends on
 * a file hash. That asymmetry is what keeps the mutual binding non-recursive.
 */
function installChain(fixture, { manifest = makeManifest(), authorityOverrides = {}, admissionOverrides = {}, registryEntryOverrides = {}, registryOverrides = {}, ownerAuthorizationPath = ADMISSION_REGISTRY_PATH } = {}) {
  const manifestBytes = bytesOf(manifest);
  write(fixture.root, MANIFEST_PATH, manifestBytes);

  const authority = makeAuthority(fixture, manifestBytes, authorityOverrides);
  const authorityBytes = bytesOf(authority);
  write(fixture.root, AUTHORITY_PATH, authorityBytes);

  const admission = makeAdmission(fixture, authority, authorityBytes, manifest, manifestBytes, admissionOverrides, ownerAuthorizationPath);
  const registry = makeRegistry(admission, registryEntryOverrides, registryOverrides);
  write(fixture.root, ownerAuthorizationPath, bytesOf(registry));

  admission.ownerAuthorizationSha256 = fileSha(fixture.root, ownerAuthorizationPath);
  write(fixture.root, ADMISSION_PATH, bytesOf(admission));

  return { manifest, manifestBytes, authority, authorityBytes, admission, registry };
}

const candidateSet = (fixture) => new Map([
  [AUTHORITY_PATH, fs.readFileSync(path.join(fixture.root, ...AUTHORITY_PATH.split('/')))],
  [MANIFEST_PATH, fs.readFileSync(path.join(fixture.root, ...MANIFEST_PATH.split('/')))],
  [TRACKED_TARGET, CANDIDATE_TRACKED],
  [NEW_TARGET, CANDIDATE_NEW]
]);

const publish = (fixture) => applyPathPrestateProgram({
  root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
  transactionId: 'FIXTURE_REPAIR_B_TRANSACTION', now: new Date('2026-08-18T12:00:00.000Z')
});

/** Resolve an admission exactly as the publisher does, for the pure-refusal controls. */
function resolve(fixture, chain, extra = {}) {
  return resolveMaintenancePublicationAdmission({
    root: fixture.root, gateId: GATE, authority: chain.authority,
    authorityPath: AUTHORITY_PATH,
    authoritySha256: fileSha(fixture.root, AUTHORITY_PATH),
    authorityByteLength: fs.statSync(path.join(fixture.root, ...AUTHORITY_PATH.split('/'))).size,
    manifest: chain.manifest,
    manifestSha256: fileSha(fixture.root, MANIFEST_PATH),
    manifestByteLength: fs.statSync(path.join(fixture.root, ...MANIFEST_PATH.split('/'))).size,
    ...extra
  });
}

/* =================================================================== *
 *  POSITIVE CONTROL
 * =================================================================== */

test('POSITIVE an Owner registry, an exact admission record and a valid prestate publish through the real consumer', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);

  assert.equal(validateAdmissionRegistryShape(chain.registry).valid, true);
  const resolution = resolve(fixture, chain);
  assert.equal(resolution.admitted, true, JSON.stringify(resolution));
  assert.equal(resolution.admissionId, ADMISSION_ID);
  assert.equal(resolution.grantsFutureBytePermission, false);
  assert.equal(resolution.governingPaths.length, 4);
  assert.deepEqual(
    resolution.governingPaths.map((entry) => entry.role).sort(),
    ['ADMITTED_AUTHORITY', 'ADMITTED_MANIFEST', 'OWNER_ADMISSION_AUTHORIZATION', 'PUBLICATION_ADMISSION_RECORD']
  );

  const report = publish(fixture);
  assert.equal(report.decision, 'APPLIED', JSON.stringify(report.findings));
  assert.equal(report.published.includes(TRACKED_TARGET), true);

  // THE RECEIPT CITES THE DECISION IT RAN UNDER, and the citation is coherent
  // against the canonical consumption validator rather than merely present.
  const consumption = readJson(fixture.root, CONSUMPTION_PATH);
  assert.deepEqual(consumption.publicationAdmission, {
    admissionId: ADMISSION_ID, admissionPath: ADMISSION_PATH, admissionSha256: fileSha(fixture.root, ADMISSION_PATH)
  });
  const coherence = [];
  validateConsumptionRecordCoherence(consumption, chain.authority, chain.manifest, coherence, { publicationAdmission: resolution });
  assert.deepEqual(coherence, []);

  // A receipt citing a DIFFERENT decision than the one it published under is not
  // merely odd, it is incoherent, and the same validator says so.
  const misCited = [];
  validateConsumptionRecordCoherence(consumption, chain.authority, chain.manifest, misCited, {
    publicationAdmission: { ...resolution, admissionId: 'OTHER_ADMISSION_R1' }
  });
  assert.equal(misCited.some((entry) => entry.code === 'CONSUMPTION_ADMISSION_CITATION_ID_MISMATCH'), true);
});

test('revision-aware Owner authorization uses only the admission-selected R2 path and fails closed', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture, {
    ownerAuthorizationPath: R2_ADMISSION_REGISTRY_PATH,
    registryOverrides: { authorityId: 'MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION_R2' }
  });
  assert.equal(resolve(fixture, chain).admitted, true, 'P2 R2 owner registry accepted');

  const r1RegistryPath = ADMISSION_REGISTRY_PATH;
  const r1Bytes = bytesOf({ ...chain.registry, authorityId: 'MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION_R1' });
  write(fixture.root, r1RegistryPath, r1Bytes);
  const admission = readJson(fixture.root, ADMISSION_PATH);
  const refuse = (mutate, label) => {
    const candidate = { ...admission, ...mutate };
    write(fixture.root, ADMISSION_PATH, bytesOf(candidate));
    assert.equal(resolve(fixture, chain).admitted, false, label);
  };
  refuse({ ownerAuthorizationSha256: fileSha(fixture.root, r1RegistryPath) }, 'N1 R2 path with R1 SHA');
  refuse({ ownerAuthorizationPath: r1RegistryPath, ownerAuthorizationSha256: fileSha(fixture.root, R2_ADMISSION_REGISTRY_PATH) }, 'N2 R1 path with R2 SHA');
  refuse({ ownerAuthorizationPath: 'governance/authority/OWNER.json' }, 'N3 outside governance/sources');
  refuse({ ownerAuthorizationPath: 'governance/sources/../OWNER.json' }, 'N4 traversal');
  refuse({ ownerAuthorizationPath: 'governance/sources/MISSING_R2.json' }, 'N5 missing Owner file');
  write(fixture.root, R2_ADMISSION_REGISTRY_PATH, Buffer.from('{ bad json', 'utf8'));
  refuse({}, 'N6 mutated Owner byte');
  write(fixture.root, R2_ADMISSION_REGISTRY_PATH, bytesOf({ ...chain.registry, decisionId: 'WRONG_DECISION_R2' }));
  refuse({ ownerAuthorizationSha256: fileSha(fixture.root, R2_ADMISSION_REGISTRY_PATH) }, 'N7 wrong owner identity');
  fs.rmSync(path.join(fixture.root, ...R2_ADMISSION_REGISTRY_PATH.split('/')));
  refuse({ ownerAuthorizationPath: R2_ADMISSION_REGISTRY_PATH }, 'N8 missing R2 never falls back to R1');
});

/* =================================================================== *
 *  NEGATIVE CONTROLS — each names the exact refusal identity.
 * =================================================================== */

test('N01 admission absent — publication is refused, never defaulted open', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  fs.rmSync(path.join(fixture.root, ...ADMISSION_PATH.split('/')));

  assert.equal(resolve(fixture, chain).reason, 'PUBLICATION_ADMISSION_ABSENT');
  const report = publish(fixture);
  assert.equal(report.decision, 'BLOCKED');
  assert.equal(report.findings[0].code, 'PUBLICATION_ADMISSION_REFUSED');
  assert.equal(report.findings[0].detail, 'PUBLICATION_ADMISSION_ABSENT');

  // And with the registry gone as well, so is any claim that one existed.
  fs.rmSync(path.join(fixture.root, ...ADMISSION_REGISTRY_PATH.split('/')));
  assert.equal(resolve(fixture, chain).reason, 'PUBLICATION_ADMISSION_ABSENT');
});

test('N02 wrong authority SHA in the admission — the bound bytes are the identity', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const admission = readJson(fixture.root, ADMISSION_PATH);
  admission.admittedAuthority.sha256 = '0'.repeat(64);
  admission.admissionDigest = computeMaintenancePublicationAdmissionDigest(admission);
  const registry = makeRegistry(admission);
  write(fixture.root, ADMISSION_REGISTRY_PATH, bytesOf(registry));
  admission.ownerAuthorizationSha256 = fileSha(fixture.root, ADMISSION_REGISTRY_PATH);
  write(fixture.root, ADMISSION_PATH, bytesOf(admission));

  assert.equal(resolve(fixture, chain).reason, 'ADMISSION_AUTHORITY_SHA_MISMATCH');
  assert.equal(publish(fixture).findings[0].code, 'PUBLICATION_ADMISSION_REFUSED');
  assert.equal(publish(fixture).findings[0].detail, 'ADMISSION_AUTHORITY_SHA_MISMATCH');
});

test('N03 wrong manifest SHA in the admission — refused before the authority pin is consulted', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const admission = readJson(fixture.root, ADMISSION_PATH);
  admission.admittedManifest.sha256 = 'f'.repeat(64);
  admission.admissionDigest = computeMaintenancePublicationAdmissionDigest(admission);
  write(fixture.root, ADMISSION_REGISTRY_PATH, bytesOf(makeRegistry(admission)));
  admission.ownerAuthorizationSha256 = fileSha(fixture.root, ADMISSION_REGISTRY_PATH);
  write(fixture.root, ADMISSION_PATH, bytesOf(admission));

  assert.equal(resolve(fixture, chain).reason, 'ADMISSION_MANIFEST_SHA_MISMATCH');
});

test('N04 wrong Gate — an admission for one Gate can never authorize a program on another', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const admission = readJson(fixture.root, ADMISSION_PATH);

  // Asked of the pure evaluator, where the exact identity is visible. The Gate is
  // compared against the Gate the AUTHORITY binds, not only against the caller's.
  const wrongGate = evaluateMaintenancePublicationAdmission({
    admission, gateId: 'GATE21', authority: chain.authority,
    authorityPath: AUTHORITY_PATH, authoritySha256: fileSha(fixture.root, AUTHORITY_PATH),
    manifest: chain.manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH)
  });
  assert.equal(wrongGate.admitted, false);
  assert.equal(wrongGate.reason, 'ADMISSION_GATE_MISMATCH');

  // And a genuine, internally valid GATE21 admission still cannot reach a GATE20
  // authority: THIS is the "cannot authorize GATE21" property.
  const gate21 = { ...admission, gateId: 'GATE21', admittedPrestate: { ...admission.admittedPrestate, gateId: 'GATE21' } };
  gate21.admissionDigest = computeMaintenancePublicationAdmissionDigest(gate21);
  assert.equal(validateMaintenancePublicationAdmissionShape(gate21).valid, true);
  const crossGate = evaluateMaintenancePublicationAdmission({
    admission: gate21, gateId: 'GATE21', authority: chain.authority,
    authorityPath: AUTHORITY_PATH, authoritySha256: fileSha(fixture.root, AUTHORITY_PATH),
    manifest: chain.manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH)
  });
  assert.equal(crossGate.reason, 'ADMISSION_AUTHORITY_GATE_MISMATCH');
});

test('N05 wrong purpose — a document that is not an admission admits nothing', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture, { admissionOverrides: { purpose: 'GENERAL_APPROVAL' } });
  const resolution = resolve(fixture, chain);
  assert.equal(resolution.reason, 'PUBLICATION_ADMISSION_INVALID');
  assert.equal(resolution.detail, 'ADMISSION_PURPOSE_INVALID');

  const wrongAuthorityPurpose = installChain(makeFixtureRepository(), {
    admissionOverrides: { authorityPurpose: 'GATE_FINAL_CLOSURE' }
  });
  assert.equal(validateMaintenancePublicationAdmissionShape(wrongAuthorityPurpose.admission).findings[0].code, 'ADMISSION_AUTHORITY_PURPOSE_UNSUPPORTED');
});

test('N06 wrong prestate — every facet is compared, and the mismatch names the facet', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const admission = readJson(fixture.root, ADMISSION_PATH);
  admission.admittedPrestate.stateRevision = 'R0002';
  admission.admissionDigest = computeMaintenancePublicationAdmissionDigest(admission);
  write(fixture.root, ADMISSION_REGISTRY_PATH, bytesOf(makeRegistry(admission)));
  admission.ownerAuthorizationSha256 = fileSha(fixture.root, ADMISSION_REGISTRY_PATH);
  write(fixture.root, ADMISSION_PATH, bytesOf(admission));

  const resolution = resolve(fixture, chain);
  assert.equal(resolution.reason, 'ADMISSION_PRESTATE_MISMATCH');
  assert.equal(resolution.detail, 'stateRevision');
});

test('N07 stale replay — an admission pinned to a superseded base HEAD is spent, not reusable', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const admission = readJson(fixture.root, ADMISSION_PATH);
  admission.admittedPrestate.baseHead = 'a'.repeat(40);
  admission.admissionDigest = computeMaintenancePublicationAdmissionDigest(admission);
  write(fixture.root, ADMISSION_REGISTRY_PATH, bytesOf(makeRegistry(admission)));
  admission.ownerAuthorizationSha256 = fileSha(fixture.root, ADMISSION_REGISTRY_PATH);
  write(fixture.root, ADMISSION_PATH, bytesOf(admission));

  const resolution = resolve(fixture, chain);
  assert.equal(resolution.reason, 'ADMISSION_PRESTATE_MISMATCH');
  assert.equal(resolution.detail, 'baseHead');
  assert.equal(publish(fixture).decision, 'BLOCKED');
});

test('N08 authority mutated after admission — the admission stays valid and still refuses', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const mutated = { ...chain.authority, resumePoint: 'CP-FIXTURE-REPAIR-B-MUTATED' };
  write(fixture.root, AUTHORITY_PATH, bytesOf(mutated));

  // The admission document itself is untouched and still internally valid: the
  // refusal comes from the binding to bytes that moved, not from a broken record.
  assert.equal(validateMaintenancePublicationAdmissionShape(readJson(fixture.root, ADMISSION_PATH)).valid, true);
  assert.equal(publish(fixture).findings[0].code, 'PUBLICATION_ADMISSION_REFUSED');
  assert.equal(publish(fixture).findings[0].detail, 'ADMISSION_AUTHORITY_SHA_MISMATCH');
});

test('N09 substituted authority at the admitted path — a matching digest claim is not enough', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const admission = readJson(fixture.root, ADMISSION_PATH);

  // The digest is presented as matching; only the document identity differs. The
  // documentId binding is what catches a swap that a digest claim alone would not.
  const substituted = { ...chain.authority, authorityId: 'SUBSTITUTED_LOCAL_AUTHORITY_R1' };
  const evaluation = evaluateMaintenancePublicationAdmission({
    admission, gateId: GATE, authority: substituted,
    authorityPath: AUTHORITY_PATH, authoritySha256: admission.admittedAuthority.sha256,
    manifest: chain.manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH)
  });
  assert.equal(evaluation.reason, 'ADMISSION_AUTHORITY_ID_MISMATCH');

  // Substituting the bytes on disk is refused too, one clause earlier.
  write(fixture.root, AUTHORITY_PATH, bytesOf(substituted));
  assert.equal(resolve(fixture, chain).reason, 'ADMISSION_AUTHORITY_SHA_MISMATCH');
});

test('N10 no Git-derived admission — the field is denied, and the resolver cannot reach Git at all', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture, { admissionOverrides: { derivedFromGitDelta: true } });
  const shape = validateMaintenancePublicationAdmissionShape(chain.admission);
  assert.equal(shape.valid, false);
  assert.equal(shape.findings[0].code, 'ADMISSION_PERMISSION_NOT_DENIED');
  assert.equal(shape.findings[0].detail, 'derivedFromGitDelta');
  assert.equal(resolve(fixture, chain).reason, 'PUBLICATION_ADMISSION_INVALID');

  // Structural, not merely declarative: the module has no route to Git or to a
  // clock, so a Git-derived admission is unrepresentable rather than forbidden.
  const source = fs.readFileSync(path.join(repoRoot, 'governance', 'gee-v1', 'core', 'maintenance-publication-admission.mjs'), 'utf8');
  for (const forbidden of ['child_process', 'execFile', 'execSync', 'spawn', 'Date.now', 'new Date', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, `resolver must not reference ${forbidden}`);
  }
});

test('N11 no FGI-derived admission — the audit never supplies the authority it audits', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture, { admissionOverrides: { derivedFromFinalGateIntegrityFindings: true } });
  const shape = validateMaintenancePublicationAdmissionShape(chain.admission);
  assert.equal(shape.findings[0].code, 'ADMISSION_PERMISSION_NOT_DENIED');
  assert.equal(shape.findings[0].detail, 'derivedFromFinalGateIntegrityFindings');
  assert.equal(resolve(fixture, chain).reason, 'PUBLICATION_ADMISSION_INVALID');

  const resolverSource = fs.readFileSync(path.join(repoRoot, 'governance', 'gee-v1', 'core', 'maintenance-publication-admission.mjs'), 'utf8');
  const importedModules = [...resolverSource.matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm)]
    .map((match) => match[1]);
  assert.equal(importedModules.some((modulePath) => modulePath.endsWith('/final-gate-integrity-auditor.mjs')), false);

  const signature = resolverSource.match(/export function resolveMaintenancePublicationAdmission\(\{([\s\S]*?)\}\) \{/);
  assert.ok(signature, 'resolver signature must remain discoverable');
  const inputNames = signature[1].split(',')
    .map((input) => input.trim().split(/\s*=/, 1)[0])
    .filter(Boolean);
  assert.deepEqual(inputNames, [
    'root', 'gateId', 'authority', 'authorityPath', 'authoritySha256', 'authorityByteLength',
    'manifest', 'manifestSha256', 'manifestByteLength', 'historicalIdentity', 'admissions'
  ]);
});

test('N12 a reserved historical identity cannot publish, and an admission is not a second route', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);

  // The resolver refuses outright, so an admission can never become the door the
  // reservation closed.
  const reserved = resolve(fixture, chain, { historicalIdentity: { reserved: true } });
  assert.equal(reserved.admitted, false);
  assert.equal(reserved.reason, 'ADMISSION_REFUSES_RESERVED_HISTORICAL_IDENTITY');

  // And the shared seam refuses EARLIER, before the admission is even consulted.
  const seam = evaluateMaintenanceSourceAdmissibility({
    authority: chain.authority, manifest: chain.manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH),
    consumption: null, requireConsumption: false, mode: MODE_PUBLICATION,
    historicalIdentity: { reserved: true }, publicationAdmission: null
  });
  assert.equal(seam.reason, 'HISTORICAL_IDENTITY_RESERVED_NOT_PUBLISHABLE');

  // NON-REGRESSION on the real Owner reservation registry in this repository.
  const reservation = JSON.parse(fs.readFileSync(path.join(repoRoot, 'governance', 'sources', 'HISTORICAL_IDENTITY_RESERVATION_OWNER_AUTHORIZATION_R1.json'), 'utf8'));
  assert.equal(reservation.publicationAuthorized, false);
  assert.equal(reservation.reexecutionAuthorized, false);
});

test('N13 arbitrary legacy V1 remains refused, and is refused WITHOUT reference to any admission', () => {
  const legacyAuthority = JSON.parse(fs.readFileSync(path.join(repoRoot, 'governance', 'sources', 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE20_FOUNDATION_PROJECTION_SYNC_R1.json'), 'utf8'));
  const legacyManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, legacyAuthority.authorizedPathManifestPath), 'utf8'));
  const legacyManifestSha = sha256(fs.readFileSync(path.join(repoRoot, legacyAuthority.authorizedPathManifestPath)));

  const refused = evaluateMaintenanceSourceAdmissibility({
    authority: legacyAuthority, manifest: legacyManifest, manifestSha256: legacyManifestSha,
    consumption: null, requireConsumption: false, mode: MODE_PUBLICATION,
    historicalIdentity: { reserved: false }, publicationAdmission: null
  });
  assert.equal(refused.admissible, false);
  // The V1 refusal is reached BEFORE the admission gate, so no admission — valid or
  // otherwise — could ever make a generic V1 program publishable.
  assert.equal(refused.reason, 'MANIFEST_DOES_NOT_BIND_PRESTATE');
});

test('N14 duplicate and conflicting admissions refuse both, never first-wins', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  const duplicate = `${ADMISSION_DIRECTORY}/${GATE}/PROJECT_OWNER_MAINTENANCE_PUBLICATION_ADMISSION_FIXTURE_REPAIR_B_R1_COPY.json`;
  write(fixture.root, duplicate, bytesOf(readJson(fixture.root, ADMISSION_PATH)));

  const resolution = resolve(fixture, chain);
  assert.equal(resolution.reason, 'PUBLICATION_ADMISSION_INVALID');
  assert.equal(resolution.detail, 'ADMISSION_DUPLICATE_IDENTITY');
  assert.equal(publish(fixture).decision, 'BLOCKED');

  // A registry naming one identity twice is invalid outright rather than resolved.
  const conflicted = makeRegistry(chain.admission);
  conflicted.admittedPublications.push({ ...conflicted.admittedPublications[0], admissionId: 'OTHER_ADMISSION_R1' });
  conflicted.registryDigest = computeAdmissionRegistryDigest(conflicted);
  assert.equal(validateAdmissionRegistryShape(conflicted).findings[0].code, 'ADMISSION_REGISTRY_DUPLICATE_IDENTITY');
});

test('N15 CONTROL 15 — no governing document may be declared as something this publication creates', () => {
  const roles = [
    { label: 'publication admission record', path: ADMISSION_PATH, role: 'PUBLICATION_ADMISSION_RECORD' },
    { label: 'Owner admission registry', path: ADMISSION_REGISTRY_PATH, role: 'OWNER_ADMISSION_AUTHORIZATION' }
  ];
  for (const { label, path: governingPath, role } of roles) {
    const fixture = makeFixtureRepository();
    const manifest = makeManifest();
    manifest.paths.push({
      path: governingPath, operation: 'CREATE', phase: 'MAINTENANCE',
      reason: `bootstrap the ${label} in the same act it authorizes`, artifactClass: 'MAINTENANCE',
      prestate: { state: 'ABSENT' }
    });
    const chain = installChain(fixture, { manifest });
    const admissibility = evaluateMaintenanceSourceAdmissibility({
      authority: chain.authority, manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH),
      consumption: null, requireConsumption: false, mode: MODE_PUBLICATION,
      publicationAdmission: resolve(fixture, chain)
    });
    assert.equal(admissibility.admissible, false, label);
    assert.equal(admissibility.reason, 'GOVERNING_PATH_PRESTATE_ABSENT_NOT_PERMITTED', label);
    assert.equal(admissibility.detail, `${role}:${governingPath}`, label);
    assert.equal(publish(fixture).decision, 'BLOCKED', label);
  }

  // The admitted AUTHORITY declared ABSENT with no bootstrap self-exclusion to
  // justify it is refused on the same rule. The exemption is a narrow, role-checked
  // mechanism, not a property of the path.
  const fixture = makeFixtureRepository();
  const manifest = makeManifest({ prestateSelfExclusion: [
    { path: MANIFEST_PATH, role: 'AUTHORIZED_PATH_MANIFEST', reason: 'The manifest must exist for the authority to pin its exact digest before publication.' }
  ] });
  const chain = installChain(fixture, { manifest });
  const admissibility = evaluateMaintenanceSourceAdmissibility({
    authority: chain.authority, manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH),
    consumption: null, requireConsumption: false, mode: MODE_PUBLICATION,
    publicationAdmission: resolve(fixture, chain)
  });
  assert.equal(admissibility.reason, 'GOVERNING_PATH_PRESTATE_ABSENT_NOT_PERMITTED');
  assert.equal(admissibility.detail, `ADMITTED_AUTHORITY:${AUTHORITY_PATH}`);

  // A governing file that is missing from disk entirely fails the other half of
  // Control 15 — the half checked against the repository rather than the manifest.
  const missing = makeFixtureRepository();
  const missingChain = installChain(missing);
  fs.rmSync(path.join(missing.root, ...ADMISSION_REGISTRY_PATH.split('/')));
  assert.equal(resolve(missing, missingChain).reason, 'ADMISSION_OWNER_AUTHORIZATION_ABSENT');
});

test('N16 a damaged resolver input can never fail open', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);

  // Unparseable admission record.
  write(fixture.root, ADMISSION_PATH, Buffer.from('{ not json', 'utf8'));
  assert.equal(resolve(fixture, chain).reason, 'PUBLICATION_ADMISSION_ABSENT');

  // Unparseable registry.
  installChain(fixture);
  write(fixture.root, ADMISSION_REGISTRY_PATH, Buffer.from('{ not json', 'utf8'));
  assert.equal(resolve(fixture, chain).reason, 'ADMISSION_OWNER_AUTHORIZATION_ABSENT');

  // A registry whose seal no longer covers what it lists.
  const chain2 = installChain(fixture);
  const tampered = readJson(fixture.root, ADMISSION_REGISTRY_PATH);
  tampered.admittedPublications[0].programId = 'SOME_OTHER_PROGRAM_R1';
  write(fixture.root, ADMISSION_REGISTRY_PATH, bytesOf(tampered));
  const sealBroken = resolve(fixture, chain2);
  assert.equal(sealBroken.reason, 'ADMISSION_OWNER_AUTHORIZATION_INVALID');
  assert.equal(sealBroken.detail, 'ADMISSION_REGISTRY_DIGEST_MISMATCH');

  // A record repointed at a registry it does not actually bind.
  const chain3 = installChain(fixture);
  const record = readJson(fixture.root, ADMISSION_PATH);
  record.ownerAuthorizationSha256 = '0'.repeat(64);
  write(fixture.root, ADMISSION_PATH, bytesOf(record));
  assert.equal(resolve(fixture, chain3).reason, 'ADMISSION_OWNER_AUTHORIZATION_BACKREFERENCE_INVALID');

  // And the seam itself: neither absence nor a non-admitting resolution passes.
  installChain(fixture);
  for (const [supplied, expected] of [
    [null, 'PUBLICATION_ADMISSION_ABSENT'],
    [{ admitted: false, reason: 'ANYTHING' }, 'PUBLICATION_ADMISSION_REFUSED'],
    [{ admitted: true, publicationClass: 'SOMETHING_ELSE' }, 'PUBLICATION_ADMISSION_CLASS_MISMATCH'],
    [{ admitted: true, publicationClass: 'PATH_PRESTATE_PROGRAM_PUBLISHER', programId: PROGRAM_ID, grantsFutureBytePermission: true }, 'PUBLICATION_ADMISSION_GRANTS_FUTURE_BYTES'],
    [{ admitted: true, publicationClass: 'PATH_PRESTATE_PROGRAM_PUBLISHER', programId: PROGRAM_ID, grantsFutureBytePermission: false, maxUse: 2 }, 'PUBLICATION_ADMISSION_MAX_USE_INVALID']
  ]) {
    const seam = evaluateMaintenanceSourceAdmissibility({
      authority: chain.authority, manifest: chain.manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH),
      consumption: null, requireConsumption: false, mode: MODE_PUBLICATION, publicationAdmission: supplied
    });
    assert.equal(seam.admissible, false);
    assert.equal(seam.reason, expected);
  }
});

/* =================================================================== *
 *  BLAST RADIUS — what this repair must NOT have changed.
 * =================================================================== */

test('BR1 MODE_ADMISSION is untouched: the cohort never asks for an admission', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  assert.equal(publish(fixture).decision, 'APPLIED');

  const consumption = readJson(fixture.root, CONSUMPTION_PATH);
  const cohortView = evaluateMaintenanceSourceAdmissibility({
    authority: chain.authority, manifest: chain.manifest, manifestSha256: fileSha(fixture.root, MANIFEST_PATH),
    consumption, requireConsumption: true, mode: MODE_ADMISSION
  });
  assert.equal(cohortView.admissible, true, JSON.stringify(cohortView.findings));
  assert.equal(cohortView.publicationClass, 'PATH_PRESTATE_PROGRAM_PUBLISHER');
});

test('BR2 a historical receipt carrying no admission citation stays coherent', () => {
  // Every consumption record already in this repository predates admissions.
  // Requiring a citation of them would be self-ratification with extra steps.
  const legacy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'governance', 'historical-architecture', 'GATE20_FOUNDATION_PROJECTION_SYNC_CONSUMPTION_R1.json'), 'utf8'));
  assert.equal(Object.hasOwn(legacy, 'publicationAdmission'), false);
  const authority = JSON.parse(fs.readFileSync(path.join(repoRoot, 'governance', 'sources', 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE20_FOUNDATION_PROJECTION_SYNC_R1.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, authority.authorizedPathManifestPath), 'utf8'));
  const findings = [];
  validateConsumptionRecordCoherence(legacy, authority, manifest, findings);
  assert.deepEqual(findings, []);
});

test('BR3 the real GATE20 Repair-B admission resolves, but a reserved historical identity cannot publish', () => {
  const authorityPath = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE20_REPAIR_B_POSITIVE_PUBLICATION_R1.json';
  const authority = JSON.parse(fs.readFileSync(path.join(repoRoot, authorityPath), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, authority.authorizedPathManifestPath), 'utf8'));

  assert.equal(validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose).valid, true);
  assert.equal(fs.existsSync(path.join(repoRoot, ...ADMISSION_REGISTRY_PATH.split('/'))), true);

  const resolution = resolveMaintenancePublicationAdmission({
    root: repoRoot, gateId: authority.preState.gateId, authority,
    authorityPath, authoritySha256: sha256(fs.readFileSync(path.join(repoRoot, authorityPath))),
    manifest, manifestSha256: sha256(fs.readFileSync(path.join(repoRoot, authority.authorizedPathManifestPath)))
  });
  assert.equal(resolution.admitted, true);
  assert.equal(resolution.ownerAuthorizationPath, ADMISSION_REGISTRY_PATH);

  const reserved = resolveMaintenancePublicationAdmission({
    root: repoRoot, gateId: authority.preState.gateId, authority,
    authorityPath, authoritySha256: sha256(fs.readFileSync(path.join(repoRoot, authorityPath))),
    manifest, manifestSha256: sha256(fs.readFileSync(path.join(repoRoot, authority.authorizedPathManifestPath))),
    historicalIdentity: { reserved: true }
  });
  assert.equal(reserved.admitted, false);
  assert.equal(reserved.reason, 'ADMISSION_REFUSES_RESERVED_HISTORICAL_IDENTITY');

  const admissibility = evaluateMaintenanceSourceAdmissibility({
    authority, manifest, manifestSha256: sha256(fs.readFileSync(path.join(repoRoot, authority.authorizedPathManifestPath))),
    consumption: null, requireConsumption: false, mode: MODE_PUBLICATION, publicationAdmission: reserved,
    historicalIdentity: { reserved: true }
  });
  assert.equal(admissibility.admissible, false);
  assert.equal(admissibility.reason, 'HISTORICAL_IDENTITY_RESERVED_NOT_PUBLISHABLE');
});

test('BR4 every denial an admission must carry is inside its own seal', () => {
  const fixture = makeFixtureRepository();
  const chain = installChain(fixture);
  for (const field of ADMISSION_DENIED_PERMISSIONS) {
    const widened = { ...chain.admission, [field]: true };
    // Flipping a denial WITHOUT resealing breaks the digest...
    assert.equal(validateMaintenancePublicationAdmissionShape(widened).findings[0].code, 'ADMISSION_PERMISSION_NOT_DENIED');
    // ...and resealing it does not help, because the denial is required outright.
    widened.admissionDigest = computeMaintenancePublicationAdmissionDigest(widened);
    const resealed = validateMaintenancePublicationAdmissionShape(widened);
    assert.equal(resealed.valid, false);
    assert.equal(resealed.findings[0].detail, field);
  }
});
