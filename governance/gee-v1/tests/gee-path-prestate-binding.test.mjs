/**
 * PATH PRE-STATE BINDING — anti-ratification hostile battery.
 *
 * The property under test is the one that separates a governed replay from a
 * ratification: an authority may only authorize paths that are in the exact
 * state it declared BEFORE the program runs. Every test here tries to obtain a
 * PASS for bytes that were written first and authorized afterwards, by a
 * different route each time.
 *
 * Fixtures are real: a real git repository, a real ledger, real gate state. The
 * pre-state gate reads git and disk, so a mocked repository would prove nothing
 * about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  evaluatePostFreezeMaintenanceAuthorityV2,
  validateMaintenanceAuthorizedPathManifest,
  REQUIRED_PROHIBITED_OPERATIONS,
  PHASE_AUTHORIZE_PROGRAM_APPLY
} from '../core/post-freeze-maintenance-authority.mjs';
import { collectPathPrestates, collectPostFreezeMaintenanceObservation, reconstructPathPrestates } from '../../tools/post-freeze-maintenance-observation.mjs';
import { applyPathPrestateProgram } from '../../tools/apply-path-prestate-program.mjs';
import { computeAdmissionRegistryDigest, computeMaintenancePublicationAdmissionDigest } from '../core/maintenance-publication-admission.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const AUTHORITY_PATH = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_FIXTURE_R1.json';
const MANIFEST_PATH = 'governance/historical-architecture/FIXTURE_AUTHORIZED_PATHS_R1.json';
const CONSUMPTION_PATH = 'governance/historical-architecture/FIXTURE_CONSUMPTION_R1.json';
const TRACKED_TARGET = 'governance/tools/fixture-tracked-tool.mjs';
const NEW_TARGET = 'governance/tools/fixture-new-tool.mjs';
/** Published last, so a fault here lands after earlier targets are already written. */
const NESTED_TARGET = 'governance/tools/fixture-nested/fixture-nested-tool.mjs';
const NESTED_PARENT = 'governance/tools/fixture-nested';
const OWNER_AUTHORIZATION_PATH = 'governance/sources/MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION_FIXTURE_R1.json';
const ADMISSION_PATH = 'governance/authority/publication-admissions/GATE19/FIXTURE_PUBLICATION_ADMISSION_R1.json';

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

/**
 * A minimal but genuine governed repository: one committed tool, a two-event
 * ledger, one gate at COMPLETE_AGENT, and nothing else.
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-prestate-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  fs.mkdirSync(path.join(root, 'governance', 'gates'), { recursive: true });
  write(root, TRACKED_TARGET, COMMITTED_BYTES);
  write(root, 'governance/active/ACTIVE_GATE.json', Buffer.from(JSON.stringify({ activeGate: 'GATE13' }, null, 2), 'utf8'));
  write(root, 'governance/gates/GATE19/state/CURRENT_STATE.json', Buffer.from(JSON.stringify({ stateRevision: 'R0003' }, null, 2), 'utf8'));
  write(root, 'governance/gates/GATE19/contracts/CURRENT_CONTRACT.json', Buffer.from(JSON.stringify({ contractRevision: 'R0001' }, null, 2), 'utf8'));
  const ledger = [
    JSON.stringify({ ordinal: 1, gateId: 'GATE19', toStatus: 'IN_PROGRESS' }),
    JSON.stringify({ ordinal: 2, gateId: 'GATE19', toStatus: 'COMPLETE_AGENT' })
  ].join('\n') + '\n';
  write(root, 'governance/state/GATE_STATUS_LEDGER.ndjson', Buffer.from(ledger, 'utf8'));
  write(root, '.gitkeep', Buffer.from('', 'utf8'));

  git(root, ['add', '--', '.gitkeep', TRACKED_TARGET, 'governance']);
  git(root, ['commit', '-q', '-m', 'fixture base']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();

  const ledgerBytes = fs.readFileSync(path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'));
  return { root, head, ledgerBytes };
}

function makeManifest(overrides = {}) {
  return {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORIZED_PATH_MANIFEST',
    schemaVersion: 2,
    manifestId: 'FIXTURE_AUTHORIZED_PATHS_R1',
    programId: 'FIXTURE_PROGRAM_R1',
    prestateSelfExclusion: [
      { path: AUTHORITY_PATH, role: 'AUTHORITY_DOCUMENT', reason: 'The authority must exist to be read by its own evaluator.' },
      { path: MANIFEST_PATH, role: 'AUTHORIZED_PATH_MANIFEST', reason: 'The manifest must exist to be digest-pinned and read.' }
    ],
    paths: [
      { path: AUTHORITY_PATH, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'single-use authority', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } },
      { path: MANIFEST_PATH, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'exact cohort', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } },
      { path: CONSUMPTION_PATH, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'consumption receipt', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } },
      { path: TRACKED_TARGET, operation: 'MODIFY', phase: 'MAINTENANCE', reason: 'advance committed tool', artifactClass: 'MAINTENANCE', prestate: { state: 'PRESENT', sha256: sha256(COMMITTED_BYTES), byteLength: COMMITTED_BYTES.length } },
      { path: NEW_TARGET, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'new tool', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } },
      { path: NESTED_TARGET, operation: 'CREATE', phase: 'MAINTENANCE', reason: 'nested new tool', artifactClass: 'MAINTENANCE', prestate: { state: 'ABSENT' } }
    ],
    ...overrides
  };
}

function makeAuthority(fixture, manifestBytes) {
  return {
    document: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY',
    schemaVersion: 2,
    authorityId: 'FIXTURE_LOCAL_AUTHORITY_R1',
    authorityClass: 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY',
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    createdAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-12-31T23:59:59.000Z',
    targetSystem: 'PROJECT_GOVERNANCE',
    programId: 'FIXTURE_PROGRAM_R1',
    authorityPurpose: 'NORMAL_MAINTENANCE',
    resumePoint: 'CP-FIXTURE',
    maxUse: 1,
    preState: {
      baseHead: fixture.head,
      ledgerEventCount: 2,
      ledgerPrefixSha256: sha256(fixture.ledgerBytes),
      gateId: 'GATE19',
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
      commitMessage: 'governance: fixture program',
      thirdCommitAuthorized: false
    },
    pushAuthorized: false,
    authorityPredecessor: null,
    authorityHeadBinding: { mode: 'BASE_HEAD', baseHead: fixture.head },
    consumptionRecordPath: CONSUMPTION_PATH,
    prohibitedOperations: [...REQUIRED_PROHIBITED_OPERATIONS]
  };
}

/** Installs authority + manifest on disk, as every real program must. */
function installPublicationAdmission(fixture, authority, manifest, manifestBytes, authorityBytes) {
  const admission = {
    documentKind: 'MAINTENANCE_PUBLICATION_ADMISSION', schemaVersion: 1, authorityMode: 'LOCAL_EXPLICIT_AUTHORITY', issuedBy: 'PROJECT_OWNER',
    admissionId: 'FIXTURE_PUBLICATION_ADMISSION_R1', decisionId: 'FIXTURE_PUBLICATION_OWNER_DECISION_R1', issuedAtUtc: '2026-08-15T00:00:00.000Z', expiresAtUtc: null,
    projectId: 'WHEEL', repositoryId: 'WHEEL_MCP_CANONICAL', gateId: 'GATE19', programId: authority.programId,
    purpose: 'MAINTENANCE_PUBLICATION_ADMISSION', publicationClass: 'PATH_PRESTATE_PROGRAM_PUBLISHER', authorityPurpose: 'NORMAL_MAINTENANCE', maxUse: 1,
    admissionStatement: 'Fixture-only causal Owner admission for one exact pre-state publication.',
    admittedAuthority: { path: AUTHORITY_PATH, sha256: sha256(authorityBytes), byteLength: authorityBytes.length, schemaVersion: 2, documentId: authority.authorityId },
    admittedManifest: { path: MANIFEST_PATH, sha256: sha256(manifestBytes), byteLength: manifestBytes.length, schemaVersion: 2, documentId: manifest.manifestId },
    admittedPrestate: authority.preState, admittedOperationClasses: ['MAINTENANCE'],
    grantsFutureBytePermission: false, grantsGateAuthorizationPermission: false, grantsStartPermission: false, grantsStatusTransitionPermission: false,
    grantsHistoricalAdmissionWidening: false, genericV1Admission: false, derivedFromGitDelta: false, derivedFromFinalGateIntegrityFindings: false,
    prohibitedOperations: ['START', 'SECOND_START', 'GATE_AUTHORIZATION', 'STATUS_TRANSITION', 'ACTIVE_GATE_SWITCH', 'GEE_R8', 'GIT_PUSH', 'HISTORY_REWRITE', 'GENERIC_V1_ADMISSION', 'HISTORICAL_ADMISSION_WIDENING', 'SELF_ADMISSION'],
    successorRequirement: 'A later publication requires a new exact Owner admission over a new exact pre-state.',
    admissionDigest: null, ownerAuthorizationPath: OWNER_AUTHORIZATION_PATH, ownerAuthorizationSha256: null
  };
  admission.admissionDigest = computeMaintenancePublicationAdmissionDigest(admission);
  const registry = {
    document: 'MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION', schemaVersion: 1, authorityId: 'FIXTURE_PUBLICATION_OWNER_AUTHORIZATION_R1',
    authorityClass: 'PROJECT_OWNER_MAINTENANCE_PUBLICATION_ADMISSION_AUTHORITY', authorityMode: 'LOCAL_EXPLICIT_AUTHORITY', issuedBy: 'PROJECT_OWNER',
    issuedAtUtc: '2026-08-15T00:00:00.000Z', decisionId: admission.decisionId, purpose: 'MAINTENANCE_PUBLICATION_ADMISSION',
    reexecutionAuthorized: false, grantsFutureBytePermission: false, genericV1Admission: false,
    admittedPublications: [{ admissionId: admission.admissionId, projectId: admission.projectId, gateId: admission.gateId, programId: admission.programId, admissionPath: ADMISSION_PATH, admissionDigest: admission.admissionDigest }],
    registryDigest: null
  };
  registry.registryDigest = computeAdmissionRegistryDigest(registry);
  const registryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  admission.ownerAuthorizationSha256 = sha256(registryBytes);
  write(fixture.root, OWNER_AUTHORIZATION_PATH, registryBytes);
  write(fixture.root, ADMISSION_PATH, Buffer.from(`${JSON.stringify(admission, null, 2)}\n`, 'utf8'));
}

function install(fixture, manifest) {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  write(fixture.root, MANIFEST_PATH, manifestBytes);
  const authority = makeAuthority(fixture, manifestBytes);
  const authorityBytes = Buffer.from(`${JSON.stringify(authority, null, 2)}\n`, 'utf8');
  write(fixture.root, AUTHORITY_PATH, authorityBytes);
  installPublicationAdmission(fixture, authority, manifest, manifestBytes, authorityBytes);
  return { authority, manifestBytes };
}

function candidateSet(fixture) {
  return new Map([
    [AUTHORITY_PATH, fs.readFileSync(path.join(fixture.root, ...AUTHORITY_PATH.split('/')))],
    [MANIFEST_PATH, fs.readFileSync(path.join(fixture.root, ...MANIFEST_PATH.split('/')))],
    [TRACKED_TARGET, CANDIDATE_TRACKED],
    [NEW_TARGET, CANDIDATE_NEW],
    [NESTED_TARGET, Buffer.from('export const nested = true;\n', 'utf8')]
  ]);
}

function authorize(fixture, authority) {
  const observation = collectPostFreezeMaintenanceObservation({
    root: fixture.root, authority, authorityDocumentPath: AUTHORITY_PATH,
    candidateWrites: [...candidateSet(fixture)].map(([p, bytes]) => ({ path: p, bytes }))
  });
  if (!observation.valid) return { decision: 'BLOCKED', findings: observation.findings };
  return evaluatePostFreezeMaintenanceAuthorityV2({
    authority, manifest: observation.manifest, observed: observation.observed,
    phase: PHASE_AUTHORIZE_PROGRAM_APPLY, now: new Date('2026-08-15T12:00:00.000Z'), consumptionRecord: null
  });
}

const codes = (result) => result.findings.map((f) => f.code);

/* ------------------------------------------------------------------ */

test('P09 exact declared prestate followed by exact candidate publication is AUTHORIZED', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
});

test('P09a Git-clean CRLF physical predecessor is AUTHORIZED while the committed predecessor remains retained', () => {
  const fixture = makeFixture();
  git(fixture.root, ['config', 'core.autocrlf', 'true']);
  const physicalCrLf = Buffer.from('export const value = 1;\r\n', 'utf8');
  write(fixture.root, TRACKED_TARGET, physicalCrLf);
  assert.doesNotThrow(() => git(fixture.root, ['diff', '--quiet', '--', TRACKED_TARGET]));
  assert.doesNotThrow(() => git(fixture.root, ['diff', '--cached', '--quiet', '--', TRACKED_TARGET]));
  assert.equal(
    git(fixture.root, ['hash-object', '--path=' + TRACKED_TARGET, path.join(fixture.root, ...TRACKED_TARGET.split('/'))]).trim(),
    git(fixture.root, ['rev-parse', 'HEAD:' + TRACKED_TARGET]).trim()
  );
  const manifest = makeManifest();
  manifest.paths = manifest.paths.map((entry) => entry.path === TRACKED_TARGET
    ? { ...entry, prestate: { state: 'PRESENT', sha256: sha256(physicalCrLf), byteLength: physicalCrLf.length } }
    : entry);
  const { authority } = install(fixture, manifest);
  const physical = collectPathPrestates(fixture.root, [TRACKED_TARGET])[TRACKED_TARGET];
  assert.equal(physical.sha256, sha256(physicalCrLf));
  assert.ok(physical.canonicalPredecessors.includes(sha256(physicalCrLf)));
  assert.ok(physical.canonicalPredecessors.includes(sha256(COMMITTED_BYTES)));
  assert.notEqual(sha256(physicalCrLf), sha256(COMMITTED_BYTES));
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
});

test('P01 candidate bytes already written, without rollback to declared prestate, is BLOCKED', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  // The ratification move: write the candidates first, then ask for authority.
  write(fixture.root, TRACKED_TARGET, CANDIDATE_TRACKED);
  write(fixture.root, NEW_TARGET, CANDIDATE_NEW);
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PATH_PRESTATE_SHA_MISMATCH'));
  assert.ok(codes(result).includes('PATH_PRESTATE_STATE_MISMATCH'));
});

test('P02 declaring the prestate hash OF the already-written candidate is BLOCKED as non-canonical', () => {
  const fixture = makeFixture();
  // Write the candidate first, then declare ITS digest as the "prestate" so the
  // literal comparison would succeed. Only the canonical-predecessor rule catches this.
  write(fixture.root, TRACKED_TARGET, CANDIDATE_TRACKED);
  const manifest = makeManifest();
  manifest.paths = manifest.paths.map((entry) => entry.path === TRACKED_TARGET
    ? { ...entry, prestate: { state: 'PRESENT', sha256: sha256(CANDIDATE_TRACKED), byteLength: CANDIDATE_TRACKED.length } }
    : entry);
  const { authority } = install(fixture, manifest);
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PATH_PRESTATE_NOT_A_CANONICAL_PREDECESSOR'));
});

test('P03 a path declared PRESENT that is absent is BLOCKED', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  fs.rmSync(path.join(fixture.root, ...TRACKED_TARGET.split('/')));
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PATH_PRESTATE_STATE_MISMATCH'));
});

test('P04 a path declared ABSENT that is present is BLOCKED', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  write(fixture.root, NEW_TARGET, Buffer.from('anything\n', 'utf8'));
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PATH_PRESTATE_STATE_MISMATCH'));
});

test('P05 a one-byte difference from the declared prestate is BLOCKED', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  write(fixture.root, TRACKED_TARGET, Buffer.concat([COMMITTED_BYTES, Buffer.from(' ', 'utf8')]));
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PATH_PRESTATE_SHA_MISMATCH'));
});

test('P05b staged-but-uncommitted bytes are not a canonical physical predecessor', () => {
  const fixture = makeFixture();
  write(fixture.root, TRACKED_TARGET, CANDIDATE_TRACKED);
  git(fixture.root, ['add', '--', TRACKED_TARGET]);
  const manifest = makeManifest();
  manifest.paths = manifest.paths.map((entry) => entry.path === TRACKED_TARGET
    ? { ...entry, prestate: { state: 'PRESENT', sha256: sha256(CANDIDATE_TRACKED), byteLength: CANDIDATE_TRACKED.length } }
    : entry);
  const { authority } = install(fixture, manifest);
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PATH_PRESTATE_NOT_A_CANONICAL_PREDECESSOR'));
});

test('P05c recovery AUTHORIZE omits future outputs but preserves the committed predecessor for dirty partial MODIFY', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  write(fixture.root, TRACKED_TARGET, Buffer.from('export const value = partial;\n', 'utf8'));
  const authorizeObservation = collectPostFreezeMaintenanceObservation({
    root: fixture.root, authority, authorityDocumentPath: AUTHORITY_PATH, includeConsumptionCohort: false
  });
  assert.equal(authorizeObservation.valid, true, JSON.stringify(authorizeObservation.findings));
  const verifyObservation = collectPostFreezeMaintenanceObservation({
    root: fixture.root, authority, authorityDocumentPath: AUTHORITY_PATH, includeConsumptionCohort: true
  });
  assert.equal(verifyObservation.valid, false);
  assert.ok(verifyObservation.findings.some((finding) => finding.code === `CONSUMPTION_COHORT_PATH_ABSENT:${NEW_TARGET}`));
  const recordedBefore = new Map([[TRACKED_TARGET, { present: true, sha256: sha256(COMMITTED_BYTES), byteLength: COMMITTED_BYTES.length }]]);
  const reconstructed = reconstructPathPrestates(fixture.root, authorizeObservation.manifest.paths.map((entry) => entry.path), recordedBefore);
  assert.equal(reconstructed[TRACKED_TARGET].sha256, sha256(COMMITTED_BYTES));
  assert.ok(reconstructed[TRACKED_TARGET].canonicalPredecessors.includes(sha256(COMMITTED_BYTES)));
  const recovered = evaluatePostFreezeMaintenanceAuthorityV2({
    authority, manifest: authorizeObservation.manifest, observed: { ...authorizeObservation.observed, pathPrestates: reconstructed },
    phase: PHASE_AUTHORIZE_PROGRAM_APPLY, now: new Date('2026-08-15T12:00:00.000Z'), consumptionRecord: null
  });
  assert.equal(recovered.decision, 'AUTHORIZED', JSON.stringify(recovered.findings));
});

test('P06 an unauthorized extra path cannot be published', () => {
  const fixture = makeFixture();
  install(fixture, makeManifest());
  const extra = new Map(candidateSet(fixture));
  extra.set('governance/tools/fixture-smuggled.mjs', Buffer.from('export const smuggled = true;\n', 'utf8'));
  const report = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: extra,
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(report.decision, 'BLOCKED');
  assert.ok(report.findings.some((f) => f.code === 'CANDIDATE_PATH_NOT_AUTHORIZED'));
  assert.equal(fs.existsSync(path.join(fixture.root, 'governance', 'tools', 'fixture-smuggled.mjs')), false);
});

test('P07 a tampered prestate binding is BLOCKED by the authority digest pin', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  // Rewrite the manifest's prestate after the authority pinned its digest.
  const tampered = makeManifest();
  tampered.paths = tampered.paths.map((entry) => entry.path === TRACKED_TARGET
    ? { ...entry, prestate: { state: 'PRESENT', sha256: sha256(CANDIDATE_TRACKED), byteLength: CANDIDATE_TRACKED.length } }
    : entry);
  write(fixture.root, MANIFEST_PATH, Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`, 'utf8'));
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('AUTHORIZED_MANIFEST_SHA_MISMATCH'));
});

test('P08 an authority/manifest SHA mismatch is BLOCKED', () => {
  const fixture = makeFixture();
  const { authority } = install(fixture, makeManifest());
  const wrong = { ...authority, authorizedPathManifestSha256: 'f'.repeat(64) };
  write(fixture.root, AUTHORITY_PATH, Buffer.from(`${JSON.stringify(wrong, null, 2)}\n`, 'utf8'));
  const result = authorize(fixture, wrong);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('AUTHORIZED_MANIFEST_SHA_MISMATCH'));
});

test('P10 replay after successful consumption is BLOCKED once the cohort drifts', () => {
  const fixture = makeFixture();
  install(fixture, makeManifest());
  const first = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(first.decision, 'APPLIED', JSON.stringify(first.findings));

  // Idempotent rerun: same authority, untouched cohort.
  const second = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(second.decision, 'ALREADY_APPLIED');

  // True replay: the cohort has moved on, so the spent authority must refuse.
  write(fixture.root, TRACKED_TARGET, Buffer.from('export const value = 3;\n', 'utf8'));
  const third = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(third.decision, 'BLOCKED');
  assert.ok(third.findings.some((f) => f.code === 'AUTHORITY_ALREADY_CONSUMED'));
});

test('P11 a publication I/O failure rolls every touched path back byte-exactly', () => {
  const fixture = makeFixture();
  install(fixture, makeManifest());
  const before = fs.readFileSync(path.join(fixture.root, ...TRACKED_TARGET.split('/')));
  // A regular FILE where the last target's parent directory must go. The journal
  // still captures cleanly (the target itself is absent), so the fault lands
  // mid-publication, after earlier targets have already been written.
  write(fixture.root, NESTED_PARENT, Buffer.from('not a directory\n', 'utf8'));

  const report = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(report.decision, 'ROLLED_BACK');
  assert.equal(report.rollbackClean, true, JSON.stringify(report.rollbackFailures));
  // The already-modified target is back to its committed bytes, the already-created
  // one is gone again, and no receipt was left behind.
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, ...TRACKED_TARGET.split('/'))), before);
  assert.equal(fs.existsSync(path.join(fixture.root, ...NEW_TARGET.split('/'))), false);
  assert.equal(fs.existsSync(path.join(fixture.root, ...CONSUMPTION_PATH.split('/'))), false);
});

test('P11b a rollback that cannot be guaranteed blocks before anything is written', () => {
  const fixture = makeFixture();
  install(fixture, makeManifest());
  const before = fs.readFileSync(path.join(fixture.root, ...TRACKED_TARGET.split('/')));
  // A directory occupying a target path makes its prior bytes uncapturable.
  fs.mkdirSync(path.join(fixture.root, ...NEW_TARGET.split('/')), { recursive: true });
  const report = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(report.decision, 'BLOCKED');
  assert.equal(report.stage, 'JOURNAL');
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, ...TRACKED_TARGET.split('/'))), before);
});

test('P12 recovery after a rolled-back attempt is deterministic and idempotent', () => {
  const fixture = makeFixture();
  install(fixture, makeManifest());
  const blocker = path.join(fixture.root, ...NESTED_PARENT.split('/'));
  write(fixture.root, NESTED_PARENT, Buffer.from('not a directory\n', 'utf8'));
  const failed = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(failed.decision, 'ROLLED_BACK');

  // Clear the fault and retry: the pre-state survived, so the program proceeds.
  fs.rmSync(blocker, { recursive: true, force: true });
  const retried = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(retried.decision, 'APPLIED', JSON.stringify(retried.findings));

  const firstDigest = sha256(fs.readFileSync(path.join(fixture.root, ...CONSUMPTION_PATH.split('/'))));
  const again = applyPathPrestateProgram({
    root: fixture.root, authorityDocumentPath: AUTHORITY_PATH, candidates: candidateSet(fixture),
    transactionId: 'FIXTURE_TX', now: new Date('2026-08-15T12:00:00.000Z')
  });
  assert.equal(again.decision, 'ALREADY_APPLIED');
  assert.equal(sha256(fs.readFileSync(path.join(fixture.root, ...CONSUMPTION_PATH.split('/')))), firstDigest);
});

test('P13 a self-exclusion may not be pointed at an ordinary authorized path', () => {
  const fixture = makeFixture();
  const manifest = makeManifest();
  manifest.prestateSelfExclusion = [
    { path: TRACKED_TARGET, role: 'AUTHORITY_DOCUMENT', reason: 'smuggling an ordinary path through the bootstrap hole' },
    { path: MANIFEST_PATH, role: 'AUTHORIZED_PATH_MANIFEST', reason: 'genuine' }
  ];
  const { authority } = install(fixture, manifest);
  write(fixture.root, TRACKED_TARGET, CANDIDATE_TRACKED);
  const result = authorize(fixture, authority);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('PRESTATE_SELF_EXCLUSION_AUTHORITY_PATH_MISMATCH'));
});

test('P14 a V2 manifest entry with no prestate declaration is BLOCKED', () => {
  const fixture = makeFixture();
  const manifest = makeManifest();
  manifest.paths = manifest.paths.map((entry) => entry.path === NEW_TARGET
    ? { path: entry.path, operation: entry.operation, phase: entry.phase, reason: entry.reason, artifactClass: entry.artifactClass }
    : entry);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const result = validateMaintenanceAuthorizedPathManifest(manifest, 'FIXTURE_PROGRAM_R1');
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((f) => f.code === 'MANIFEST_PATH_PRESTATE_MISSING'));
  assert.ok(manifestBytes.length > 0);
});

test('P15 CREATE declaring PRESENT, and MODIFY declaring ABSENT, are both incoherent', () => {
  const manifest = makeManifest();
  manifest.paths = manifest.paths.map((entry) => {
    if (entry.path === NEW_TARGET) return { ...entry, prestate: { state: 'PRESENT', sha256: sha256(CANDIDATE_NEW), byteLength: CANDIDATE_NEW.length } };
    if (entry.path === TRACKED_TARGET) return { ...entry, prestate: { state: 'ABSENT' } };
    return entry;
  });
  const result = validateMaintenanceAuthorizedPathManifest(manifest, 'FIXTURE_PROGRAM_R1');
  assert.equal(result.valid, false);
  assert.equal(result.findings.filter((f) => f.code === 'MANIFEST_PATH_PRESTATE_OPERATION_INCOHERENT').length, 2);
});
