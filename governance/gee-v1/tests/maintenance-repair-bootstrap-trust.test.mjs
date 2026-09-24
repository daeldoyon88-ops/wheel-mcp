/**
 * MAINTENANCE REPAIR BOOTSTRAP TRUST — positive and hostile battery.
 *
 * Fixtures are real. Each canonical fixture is an exact byte copy of this
 * repository's committed governance/ tree and .gitattributes (read from Git
 * objects, never from the working tree), committed into a disposable repository
 * so the V2 observation has a real base HEAD. The residual is therefore the one
 * the canonical validator really reports for committed bytes, recomputed by the
 * evaluator itself; no test hands the evaluator a finding list.
 *
 * If the committed residual has no defect subject at all (a future in which the
 * present-state defect has been repaired), the fixture creates exactly one by
 * committing a one-line change to .gitattributes, whose bytes are pinned by
 * protected hashes. A committed residual with more than one subject is not a state
 * this battery can reason about and fails loudly.
 *
 * Nothing here publishes Genesis, invokes the real Fast Gate, or writes outside a
 * temporary directory.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BOOTSTRAP_GENESIS_AUTHORITY_PATH,
  BOOTSTRAP_GENESIS_CONSUMPTION_PATH,
  BOOTSTRAP_GENESIS_CREATE_PATHS,
  BOOTSTRAP_GENESIS_MANIFEST_PATH,
  BOOTSTRAP_GENESIS_PUBLISHER_PATH,
  BOOTSTRAP_NOT_APPLICABLE,
  BOOTSTRAP_NOT_REQUIRED,
  BOOTSTRAP_PROTECTED_CONTROL_SURFACE,
  BOOTSTRAP_REQUIRED,
  STOP_BOOTSTRAP_REPAIR_FAILED_TO_RESTORE_TRUST,
  computeResidualIdentity,
  deriveMaintenanceRepairBootstrapPaths,
  deriveMaintenanceRepairResidual,
  evaluateMaintenanceRepairBootstrapClosure,
  evaluateMaintenanceRepairBootstrapEligibility,
  normalizeResidualFindings,
  validateMaintenanceBootstrapGenesisCohort,
  validateMaintenanceRepairBootstrapAuthorityShape,
  validateMaintenanceRepairBootstrapConsumptionShape,
  validateMaintenanceRepairBootstrapReceiptPair
} from '../core/maintenance-repair-bootstrap-trust.mjs';
import {
  evaluatePathPrestateBinding,
  evaluatePostFreezeMaintenanceAuthorityV2,
  PHASE_AUTHORIZE_PROGRAM_APPLY,
  REQUIRED_PROHIBITED_OPERATIONS,
  validateConsumptionRecordCoherence,
  validateMaintenanceAuthorizedPathManifest,
  validatePostFreezeMaintenanceAuthorityV2Shape
} from '../core/post-freeze-maintenance-authority.mjs';
import { computeAdmissionRegistryDigest, computeMaintenancePublicationAdmissionDigest } from '../core/maintenance-publication-admission.mjs';
import { collectPostFreezeMaintenanceObservation, observeCanonicalPreState } from '../../tools/post-freeze-maintenance-observation.mjs';
import { applyPathPrestateProgram } from '../../tools/apply-path-prestate-program.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const NOW = new Date('2026-09-21T00:00:00.000Z');
const DECIDED_AT = '2026-09-19T00:00:00.000Z';
const V2_CREATED_AT = '2026-09-20T00:00:00.000Z';
const RECORDED_AT = '2026-09-21T00:00:00.000Z';
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const R8_PATH = 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0008.json';

function git(root, args, input) {
  return execFileSync('git', args, { cwd: root, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
}

function repoFile(root, relativePath) { return path.join(root, ...relativePath.split('/')); }
function readBytes(root, relativePath) { return fs.readFileSync(repoFile(root, relativePath)); }
function exists(root, relativePath) { return fs.existsSync(repoFile(root, relativePath)); }
function writeBytes(root, relativePath, bytes) {
  const file = repoFile(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function remove(root, relativePath) { fs.rmSync(repoFile(root, relativePath), { force: true }); }
function codes(result) { return (result.findings ?? []).map((entry) => entry.code); }

/** Exact committed bytes of governance/ and .gitattributes, from Git objects. */
function copyCommittedGovernance(target) {
  const listing = git(REPO_ROOT, ['ls-tree', '-r', '-z', 'HEAD', '--', 'governance', '.gitattributes']).toString('utf8');
  const entries = listing.split('\0').filter(Boolean).map((line) => {
    const [meta, relativePath] = line.split('\t');
    const [mode, type, objectId] = meta.split(' ');
    return { mode, type, objectId, relativePath };
  });
  assert.ok(entries.every((entry) => entry.type === 'blob' && entry.mode === '100644'), 'governance copy expects regular blobs only');
  const output = git(REPO_ROOT, ['cat-file', '--batch'], `${entries.map((entry) => entry.objectId).join('\n')}\n`);
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    const [objectId, , size] = output.subarray(offset, headerEnd).toString('utf8').split(' ');
    assert.equal(objectId, entry.objectId);
    const start = headerEnd + 1;
    writeBytes(target, entry.relativePath, output.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
}

function commitAll(root, message) {
  git(root, ['add', '--', 'governance', '.gitattributes']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
}

/**
 * A committed canonical copy whose residual is exactly one defect subject.
 */
function initCommittedFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  copyCommittedGovernance(root);
  git(root, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.email', 'fixture@example.invalid'], ['user.name', 'fixture'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    git(root, ['config', key, value]);
  }
  commitAll(root, 'bootstrap fixture base');
  return root;
}

function makeCanonicalFixture() {
  const root = initCommittedFixture('gee-bootstrap-');
  let residual = deriveMaintenanceRepairResidual({ root });
  assert.equal(residual.evaluable, true, 'fixture residual must be evaluable');
  assert.equal(residual.ledgerIntegrityValid, true, 'fixture ledger history must be intact');
  if (residual.subjects.length === 0) {
    writeBytes(root, '.gitattributes', Buffer.concat([readBytes(root, '.gitattributes'), Buffer.from('# bootstrap fixture residual\n')]));
    commitAll(root, 'bootstrap fixture single-subject residual');
    residual = deriveMaintenanceRepairResidual({ root });
  }
  assert.equal(residual.subjects.length, 1, `fixture requires exactly one committed defect subject, found ${residual.subjects.length}`);
  return { root, residual };
}

/** The bytes in this repository's history of `relativePath` whose SHA-256 is `wantedSha256`. */
function historicalBytes(relativePath, wantedSha256) {
  const commits = git(REPO_ROOT, ['log', '--format=%H', '--', relativePath]).toString('utf8').split('\n').filter(Boolean);
  for (const commit of commits) {
    let bytes;
    try { bytes = git(REPO_ROOT, ['show', `${commit}:${relativePath}`]); } catch { continue; }
    if (sha256(bytes) === wantedSha256) return bytes;
  }
  return assert.fail(`no historical bytes of ${relativePath} hash to ${wantedSha256}`);
}

/**
 * A committed canonical copy AFTER Genesis whose residual is EMPTY.
 *
 * Genesis post-state: every Genesis cohort member (the primitive, its schemas and
 * test, the Genesis authority and manifest, the succeeded publisher) carries the
 * bytes this candidate carries. Once Genesis is committed this overlay is a no-op.
 * The Genesis consumption record is not written: the evaluator never reads it.
 *
 * Empty residual: each committed defect subject's protected path is restored to
 * the historical bytes its protected hash pins, taken from this repository's own
 * history. The residual is then the one the canonical validator really reports —
 * nothing hands the evaluator an empty finding list.
 */
function makeEmptyResidualPostGenesisFixture() {
  const root = initCommittedFixture('gee-bootstrap-empty-');
  const genesisMembers = [...BOOTSTRAP_GENESIS_CREATE_PATHS.filter((member) => member !== BOOTSTRAP_GENESIS_CONSUMPTION_PATH), BOOTSTRAP_GENESIS_PUBLISHER_PATH];
  for (const member of genesisMembers) writeBytes(root, member, readBytes(REPO_ROOT, member));
  if (git(root, ['status', '--porcelain']).length > 0) commitAll(root, 'bootstrap fixture Genesis post-state');
  let residual = deriveMaintenanceRepairResidual({ root });
  assert.equal(residual.evaluable, true, 'fixture residual must be evaluable');
  assert.equal(residual.ledgerIntegrityValid, true, 'fixture ledger history must be intact');
  if (residual.blockingCount > 0) {
    for (const entry of residual.subjects) {
      const pinned = [...new Set(entry.manifestations.map((item) => item.historicalSha256))];
      assert.equal(pinned.length, 1, `subject ${entry.key} must pin exactly one historical hash`);
      writeBytes(root, entry.subject.protectedPath, historicalBytes(entry.subject.protectedPath, pinned[0]));
    }
    commitAll(root, 'bootstrap fixture empty residual');
    residual = deriveMaintenanceRepairResidual({ root });
  }
  assert.equal(residual.ledgerIntegrityValid, true, 'fixture ledger history must stay intact');
  assert.equal(residual.blockingCount, 0, 'fixture residual must be empty');
  assert.equal(residual.subjects.length, 0, 'fixture residual must have no defect subject');
  for (const member of genesisMembers) assert.deepEqual(readBytes(root, member), readBytes(REPO_ROOT, member), member);
  return { root, residual };
}

/** A mutation that adds a SECOND subject: a protected path other than the fixture's subject. */
function secondSubjectMutation(fixture) {
  const current = fixture.residual.subjects[0].subject.protectedPath;
  const target = current === '.gitattributes' ? 'governance/GATE_REGISTRY_00_40.json' : '.gitattributes';
  return { path: target, mutate: (bytes) => Buffer.concat([bytes, Buffer.from(target === '.gitattributes' ? '# second subject\n' : ' ')]) };
}

function withMutation(root, relativePath, mutate, body) {
  const before = exists(root, relativePath) ? readBytes(root, relativePath) : null;
  writeBytes(root, relativePath, mutate(before));
  try { return body(); } finally {
    if (before === null) remove(root, relativePath); else writeBytes(root, relativePath, before);
  }
}

const manifestEntry = (entryPath, operation, prestate, reason = 'bootstrap fixture member') => ({
  path: entryPath, operation, phase: 'MAINTENANCE', reason, artifactClass: 'MAINTENANCE', prestate
});

/**
 * One complete V2 repair program plus its bootstrap authority and Owner decision,
 * written into `fixture.root`. Every digest is computed from the bytes written.
 */
function buildRepairProgram(fixture, {
  programId = 'FIXTURE_BOOTSTRAP_REPAIR_R1',
  extraEntries = [],
  extraCandidates = [],
  omitReceiptEntry = false,
  includeDecisionInManifest = false,
  authorityOverrides = {},
  decisionOverrides = {},
  v2AuthorityOverrides = {},
  writeBootstrapAuthority = true,
  writeDecision = true,
  subjectOverride = null,
  residualIdentityOverride = null
} = {}) {
  const { root, residual } = fixture;
  const paths = deriveMaintenanceRepairBootstrapPaths(programId);
  const v2AuthorityPath = `governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_${programId}.json`;
  const manifestPath = `governance/historical-architecture/${programId}_AUTHORIZED_PATHS.json`;
  const consumptionPath = `governance/historical-architecture/${programId}_CONSUMPTION.json`;
  const targetPath = `governance/gates/GATE15/BOOTSTRAP_FIXTURE_REPAIR_${programId}.json`;
  const admissionPath = `governance/authority/publication-admissions/GATE26/${programId}_PUBLICATION_ADMISSION.json`;
  const registryPath = `governance/sources/MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION_${programId}.json`;
  const ABSENT = { state: 'ABSENT' };
  const live = observeCanonicalPreState(root, 'GATE26');
  const preState = { ...live, R8ExpectedAbsent: true };

  const manifest = {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORIZED_PATH_MANIFEST',
    schemaVersion: 2,
    manifestId: `${programId}_AUTHORIZED_PATHS`,
    programId,
    prestateSelfExclusion: [
      { path: v2AuthorityPath, role: 'AUTHORITY_DOCUMENT', reason: 'read by its own evaluator' },
      { path: manifestPath, role: 'AUTHORIZED_PATH_MANIFEST', reason: 'digest-pinned and read' }
    ],
    paths: [
      manifestEntry(v2AuthorityPath, 'CREATE', ABSENT),
      manifestEntry(manifestPath, 'CREATE', ABSENT),
      manifestEntry(consumptionPath, 'CREATE', ABSENT),
      ...(omitReceiptEntry ? [] : [manifestEntry(paths.receiptPath, 'CREATE', ABSENT, 'bootstrap receipt reserved for the publisher')]),
      manifestEntry(targetPath, 'CREATE', ABSENT, 'the repair itself'),
      ...(includeDecisionInManifest ? [manifestEntry(paths.ownerDecisionPath, 'CREATE', ABSENT)] : []),
      ...extraEntries
    ]
  };
  const manifestBytes = jsonBytes(manifest);
  const v2Authority = {
    document: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY', schemaVersion: 2,
    authorityId: `${programId}_LOCAL_AUTHORITY`, authorityClass: 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY',
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY', issuedBy: 'PROJECT_OWNER',
    createdAt: V2_CREATED_AT, expiresAt: '2026-12-31T23:59:59.000Z', targetSystem: 'PROJECT_GOVERNANCE',
    programId, authorityPurpose: 'NORMAL_MAINTENANCE', resumePoint: 'CP-BOOTSTRAP-FIXTURE', maxUse: 1, preState,
    authorizedPathManifestPath: manifestPath, authorizedPathManifestSha256: sha256(manifestBytes),
    authorizedOperationClasses: ['MAINTENANCE'],
    commitPolicy: { maxCommitCount: 1, allowedGitOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'], commitMessage: 'fixture bootstrap repair', thirdCommitAuthorized: false },
    pushAuthorized: false, authorityPredecessor: null,
    authorityHeadBinding: { mode: 'BASE_HEAD', baseHead: preState.baseHead },
    consumptionRecordPath: consumptionPath, prohibitedOperations: [...REQUIRED_PROHIBITED_OPERATIONS],
    ...v2AuthorityOverrides
  };
  const v2AuthorityBytes = jsonBytes(v2Authority);

  const admission = {
    documentKind: 'MAINTENANCE_PUBLICATION_ADMISSION', schemaVersion: 1, authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER', admissionId: `${programId}_PUBLICATION_ADMISSION`, decisionId: `OWNER_ADMIT_${programId}`,
    issuedAtUtc: V2_CREATED_AT, expiresAtUtc: null, projectId: 'WHEEL', repositoryId: 'WHEEL_MCP_CANONICAL',
    gateId: 'GATE26', programId, purpose: 'MAINTENANCE_PUBLICATION_ADMISSION', publicationClass: 'PATH_PRESTATE_PROGRAM_PUBLISHER',
    authorityPurpose: 'NORMAL_MAINTENANCE', maxUse: 1, admissionStatement: 'fixture admission',
    admittedAuthority: { path: v2AuthorityPath, sha256: sha256(v2AuthorityBytes), byteLength: v2AuthorityBytes.length, schemaVersion: 2, documentId: v2Authority.authorityId },
    admittedManifest: { path: manifestPath, sha256: sha256(manifestBytes), byteLength: manifestBytes.length, schemaVersion: 2, documentId: manifest.manifestId },
    admittedPrestate: { ...preState }, admittedOperationClasses: ['MAINTENANCE'],
    grantsFutureBytePermission: false, grantsGateAuthorizationPermission: false, grantsStartPermission: false,
    grantsStatusTransitionPermission: false, grantsHistoricalAdmissionWidening: false, genericV1Admission: false,
    derivedFromGitDelta: false, derivedFromFinalGateIntegrityFindings: false,
    prohibitedOperations: ['START', 'SECOND_START', 'GATE_AUTHORIZATION', 'STATUS_TRANSITION', 'ACTIVE_GATE_SWITCH', 'GEE_R8', 'GIT_PUSH', 'HISTORY_REWRITE', 'GENERIC_V1_ADMISSION', 'HISTORICAL_ADMISSION_WIDENING', 'SELF_ADMISSION'],
    successorRequirement: 'fixture', admissionDigest: null, ownerAuthorizationPath: registryPath, ownerAuthorizationSha256: null
  };
  admission.admissionDigest = computeMaintenancePublicationAdmissionDigest(admission);
  const registry = {
    document: 'MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION', schemaVersion: 1, authorityId: `${programId}_OWNER_AUTHORIZATION`,
    authorityClass: 'PROJECT_OWNER_MAINTENANCE_PUBLICATION_ADMISSION_AUTHORITY', authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER', issuedAtUtc: V2_CREATED_AT, decisionId: admission.decisionId, purpose: 'MAINTENANCE_PUBLICATION_ADMISSION',
    reexecutionAuthorized: false, grantsFutureBytePermission: false, genericV1Admission: false,
    admittedPublications: [{ admissionId: admission.admissionId, projectId: 'WHEEL', gateId: 'GATE26', programId, admissionPath, admissionDigest: admission.admissionDigest }],
    registryDigest: null
  };
  registry.registryDigest = computeAdmissionRegistryDigest(registry);
  const registryBytes = jsonBytes(registry);
  admission.ownerAuthorizationSha256 = sha256(registryBytes);

  // The residual identity the Owner binds: recomputed from the fixture, the same
  // way the evaluator will recompute it. On an empty residual there is no subject:
  // the program is then ordinary maintenance and may bring no bootstrap document.
  const entry = residual.subjects[0] ?? null;
  assert.ok(entry || (!writeDecision && !writeBootstrapAuthority), 'a bootstrap document requires a residual subject');
  const producerSha256 = entry ? sha256(readBytes(REPO_ROOT, entry.subject.producerPath)) : null;
  const residualIdentitySha256 = residualIdentityOverride ?? (entry ? computeResidualIdentity({
    validator: residual.validator, baseHead: preState.baseHead, ledgerEventCount: residual.eventCount,
    ledgerPrefixSha256: residual.ledgerSha256, producer: { path: entry.subject.producerPath, sha256: producerSha256 },
    subject: entry.subject, manifestations: entry.manifestations
  }) : null);
  const defectSubject = subjectOverride ?? { ...entry?.subject, producerBlobSha256: producerSha256 };
  const decision = {
    document: 'MAINTENANCE_REPAIR_BOOTSTRAP_OWNER_DECISION', schemaVersion: 1, decisionId: `OWNER_BOOTSTRAP_${programId}`,
    issuedBy: 'PROJECT_OWNER', authorityMode: 'LOCAL_EXPLICIT_AUTHORITY', decidedAt: DECIDED_AT, programId,
    bootstrapAuthorityId: paths.authorityId,
    defectSubject: { detectorId: defectSubject.detectorId, protectedPath: defectSubject.protectedPath, producerPath: defectSubject.producerPath, producerBlobSha256: defectSubject.producerBlobSha256 },
    residualIdentitySha256, repairManifestPath: manifestPath, repairManifestSha256: sha256(manifestBytes),
    decisionStatement: 'fixture Owner decision for exactly one bootstrap repair',
    ...decisionOverrides
  };
  const decisionBytes = jsonBytes(decision);
  const bootstrapAuthority = {
    document: 'MAINTENANCE_REPAIR_BOOTSTRAP_TRUST_AUTHORITY', schemaVersion: 1, authorityId: paths.authorityId,
    authorityClass: 'PROJECT_OWNER_MAINTENANCE_BOOTSTRAP_AUTHORITY', authorityMode: 'LOCAL_EXPLICIT_AUTHORITY', issuedBy: 'PROJECT_OWNER',
    programId, maxUse: 1, pushAuthorized: false, genesisAuthorized: false, grantsPresentStateTrust: false,
    grantsFastGateExemption: false, recursiveBootstrapAuthorized: false, derivedFromFinalGateIntegrityFindings: false,
    preState: { ...preState }, defectSubject: { ...defectSubject }, residualIdentitySha256,
    repairManifestPath: manifestPath, repairManifestSha256: sha256(manifestBytes),
    ownerDecisionPath: paths.ownerDecisionPath, ownerDecisionSha256: sha256(decisionBytes),
    receiptPath: paths.receiptPath, closureObligation: 'ORDINARY_FAST_GATE_PASS',
    ...authorityOverrides
  };

  const written = [manifestPath, v2AuthorityPath, admissionPath, registryPath];
  writeBytes(root, manifestPath, manifestBytes);
  writeBytes(root, v2AuthorityPath, v2AuthorityBytes);
  writeBytes(root, admissionPath, jsonBytes(admission));
  writeBytes(root, registryPath, registryBytes);
  if (writeDecision) { writeBytes(root, paths.ownerDecisionPath, decisionBytes); written.push(paths.ownerDecisionPath); }
  if (writeBootstrapAuthority) { writeBytes(root, paths.authorityPath, jsonBytes(bootstrapAuthority)); written.push(paths.authorityPath); }
  const targetBytes = Buffer.from(`${JSON.stringify({ fixtureRepair: programId })}\n`, 'utf8');
  // The self-excluded authority and manifest are still cohort members: their
  // candidate bytes are the bytes already on disk, exactly as in the V2 battery.
  const candidates = new Map([
    [v2AuthorityPath, v2AuthorityBytes], [manifestPath, manifestBytes], [targetPath, targetBytes],
    ...extraEntries.filter((item) => item.operation === 'CREATE').map((item) => [item.path, Buffer.from('fixture\n')]),
    ...extraCandidates
  ]);
  const cleanup = () => {
    for (const relativePath of [...written, consumptionPath, paths.receiptPath, targetPath, ...extraEntries.map((item) => item.path)]) {
      if (!BOOTSTRAP_PROTECTED_CONTROL_SURFACE.includes(relativePath) && relativePath !== LEDGER_PATH) remove(root, relativePath);
    }
  };
  const evaluate = (extra = {}) => evaluateMaintenanceRepairBootstrapEligibility({
    root, v2Authority, v2AuthorityPath, manifest, manifestSha256: sha256(manifestBytes), now: NOW, ...extra
  });
  const publish = (overrides = {}) => applyPathPrestateProgram({
    root, authorityDocumentPath: v2AuthorityPath, candidates, transactionId: `${programId}_TX`,
    recordedAt: RECORDED_AT, now: NOW, ...overrides
  });
  return {
    paths, programId, v2AuthorityPath, v2Authority, manifestPath, manifest, manifestBytes, consumptionPath, targetPath,
    decision, bootstrapAuthority, residualIdentitySha256, candidates, cleanup, evaluate, publish
  };
}

let shared;
before(() => { shared = makeCanonicalFixture(); });
after(() => { if (shared) fs.rmSync(shared.root, { recursive: true, force: true }); });

function withProgram(options, body) {
  const program = buildRepairProgram(shared, options);
  try { return body(program); } finally { program.cleanup(); }
}

/* ======================================================================== */
/* NAMING, SCHEMAS, RESIDUAL IDENTITY                                        */
/* ======================================================================== */

test('N01 PROGRAM_ID naming is a literal substitution with no alternative identifier', () => {
  assert.deepEqual(deriveMaintenanceRepairBootstrapPaths('SOME_REPAIR_R1'), {
    programId: 'SOME_REPAIR_R1',
    authorityPath: 'governance/authority/maintenance-repair-bootstrap/SOME_REPAIR_R1_AUTHORITY_R1.json',
    ownerDecisionPath: 'governance/authority/maintenance-repair-bootstrap/SOME_REPAIR_R1_OWNER_DECISION_R1.json',
    receiptPath: 'governance/historical-architecture/SOME_REPAIR_R1_BOOTSTRAP_CONSUMPTION_R1.json',
    authorityId: 'SOME_REPAIR_R1_BOOTSTRAP_AUTHORITY_R1'
  });
  for (const invalid of ['', 'lower_case', '../X', 'A/B', null, 42]) assert.equal(deriveMaintenanceRepairBootstrapPaths(invalid), null);
});

test('N02 the closed schemas accept the exact documents and refuse widened ones, including any Fast Gate result', () => {
  withProgram({}, (program) => {
    assert.equal(validateMaintenanceRepairBootstrapAuthorityShape(program.bootstrapAuthority).valid, true);
    for (const [field, value] of [['extraClaim', true], ['grantsPresentStateTrust', true], ['grantsFastGateExemption', true], ['closureObligation', 'NONE']]) {
      assert.equal(validateMaintenanceRepairBootstrapAuthorityShape({ ...program.bootstrapAuthority, [field]: value }).valid, false, field);
    }
    const { derivedFromFinalGateIntegrityFindings, ...missingDenial } = program.bootstrapAuthority;
    assert.equal(derivedFromFinalGateIntegrityFindings, false);
    assert.ok(codes(validateMaintenanceRepairBootstrapAuthorityShape(missingDenial)).includes('BOOTSTRAP_AUTHORITY_DENIAL_MISSING'));
  });
  const receipt = {
    document: 'MAINTENANCE_REPAIR_BOOTSTRAP_TRUST_CONSUMPTION', schemaVersion: 1,
    bootstrapAuthorityId: 'P_R1_BOOTSTRAP_AUTHORITY_R1', bootstrapAuthorityPath: 'governance/authority/maintenance-repair-bootstrap/P_R1_AUTHORITY_R1.json',
    bootstrapAuthoritySha256: 'a'.repeat(64), programId: 'P_R1', repairManifestPath: 'governance/historical-architecture/P.json',
    repairManifestSha256: 'b'.repeat(64), baseHead: 'c'.repeat(40), residualIdentitySha256: 'd'.repeat(64),
    v2ConsumptionRecordPath: 'governance/historical-architecture/P_CONSUMPTION.json', v2AuthorityId: 'P_LOCAL_AUTHORITY',
    transactionId: 'P_TX', publicationAdmission: { admissionId: 'P_ADMISSION', admissionPath: 'governance/authority/publication-admissions/GATE26/P.json', admissionSha256: 'e'.repeat(64) },
    recordedAt: RECORDED_AT, consumedUse: 1, closureObligation: 'ORDINARY_FAST_GATE_PASS'
  };
  assert.equal(validateMaintenanceRepairBootstrapConsumptionShape(receipt).valid, true);
  for (const [field, value] of [['fastGateVerdict', 'FAST_PATH_READY'], ['fastGateResult', {}], ['consumedAt', RECORDED_AT], ['consumedUse', 2]]) {
    assert.equal(validateMaintenanceRepairBootstrapConsumptionShape({ ...receipt, [field]: value }).valid, false, field);
  }
});

test('N03 residual identity is deterministic, order-free and message-free, and changes with any hash', () => {
  const entry = shared.residual.subjects[0];
  const base = {
    validator: shared.residual.validator, baseHead: 'f'.repeat(40), ledgerEventCount: shared.residual.eventCount,
    ledgerPrefixSha256: shared.residual.ledgerSha256, producer: { path: entry.subject.producerPath, sha256: 'a'.repeat(64) },
    subject: entry.subject, manifestations: entry.manifestations
  };
  const digest = computeResidualIdentity(base);
  assert.equal(computeResidualIdentity({ ...base, manifestations: [...entry.manifestations].reverse() }), digest);
  assert.equal(computeResidualIdentity({ ...base, manifestations: entry.manifestations.map((item) => ({ ...item, message: 'any prose' })) }), digest);
  assert.notEqual(computeResidualIdentity({ ...base, manifestations: entry.manifestations.map((item, index) => (index === 0 ? { ...item, liveSha256: '0'.repeat(64) } : item)) }), digest);
  assert.notEqual(computeResidualIdentity({ ...base, baseHead: 'e'.repeat(40) }), digest);
  assert.notEqual(computeResidualIdentity({ ...base, producer: { ...base.producer, sha256: 'b'.repeat(64) } }), digest);
});

test('N04 wrapped state-lineage manifestations collapse to one subject only when the normalized key is shared', () => {
  const inner = (protectedPath, detectorId = 'PROTECTED_HASH_MISMATCH') => ({
    detectorId, severity: 'BLOCKING', jsonPointer: '/R0001/protectedHashes/1', message: 'prose',
    protectedHashCheck: { path: protectedPath, expectedSha256: 'a'.repeat(64), actualSha256: 'b'.repeat(64) }
  });
  const wrap = (gateId, entries) => ({ detectorId: 'GATE_AUTHORIZATION_STATE_LINEAGE_INVALID', severity: 'BLOCKING', gateId, jsonPointer: '/authorizedStateArtifacts/CURRENT_STATE', actualValue: entries });
  const info = { detectorId: 'MIGRATED_HISTORICAL_AUTHORITY', severity: 'INFO', gateId: 'GATE00' };
  const one = normalizeResidualFindings([wrap('GATE15', [inner('governance/X.json')]), wrap('GATE16', [inner('governance/X.json')]), info]);
  assert.equal(one.subjects.length, 1);
  assert.equal(one.subjects[0].manifestations.length, 2);
  assert.equal(one.subjects[0].subject.producerPath, 'governance/tools/validate-state-revision.mjs');
  assert.equal(normalizeResidualFindings([wrap('GATE15', [inner('governance/X.json')]), wrap('GATE16', [inner('governance/Y.json')])]).subjects.length, 2);
  assert.equal(normalizeResidualFindings([wrap('GATE15', [inner('governance/X.json'), inner('governance/X.json', 'STATE_SEAL_MEMBER_MISMATCH')])]).subjects.length, 2);
  assert.equal(normalizeResidualFindings([wrap('GATE15', [inner('governance/X.json')]), { detectorId: 'SOME_NEW_BLOCKER', severity: 'BLOCKING', gateId: 'GATE15' }]).subjects.length, 2);
});

/* ======================================================================== */
/* APPLICABILITY — the V2 law is unchanged where the boundary does not apply */
/* ======================================================================== */

test('A01 a non-canonical fixture ledger is NOT_APPLICABLE unless the program brings a bootstrap signal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-bootstrap-nc-'));
  try {
    writeBytes(root, LEDGER_PATH, Buffer.from(`${JSON.stringify({ ordinal: 1, gateId: 'GATE19', toStatus: 'IN_PROGRESS' })}\n`));
    writeBytes(root, 'governance/active/ACTIVE_GATE.json', jsonBytes({ activeGate: 'GATE13' }));
    const v2Authority = { programId: 'NC_PROGRAM_R1', preState: { gateId: 'GATE19' }, createdAt: V2_CREATED_AT, pushAuthorized: false };
    const plain = { schemaVersion: 2, programId: 'NC_PROGRAM_R1', paths: [{ path: 'governance/tools/fixture-tool.mjs' }] };
    assert.equal(evaluateMaintenanceRepairBootstrapEligibility({ root, v2Authority, manifest: plain, manifestSha256: 'x', now: NOW }).applicability, BOOTSTRAP_NOT_APPLICABLE);
    const touching = { ...plain, paths: [{ path: 'governance/tools/apply-path-prestate-program.mjs' }] };
    const result = evaluateMaintenanceRepairBootstrapEligibility({ root, v2Authority, manifest: touching, manifestSha256: 'x', now: NOW });
    assert.equal(result.applicability, BOOTSTRAP_REQUIRED);
    assert.equal(result.eligible, false);
    assert.ok(codes(result).some((code) => code.startsWith('BOOTSTRAP_E1_')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('A02 on the canonical history, unrelated maintenance is NOT_REQUIRED and repair of the residual is REQUIRED', () => {
  const v2Authority = { programId: 'UNRELATED_R1', preState: { gateId: 'GATE26' }, createdAt: V2_CREATED_AT, pushAuthorized: false };
  const unrelated = { schemaVersion: 2, programId: 'UNRELATED_R1', paths: [{ path: 'governance/tools/fixture-unrelated.mjs' }] };
  assert.equal(evaluateMaintenanceRepairBootstrapEligibility({ root: shared.root, v2Authority, manifest: unrelated, manifestSha256: 'x', now: NOW }).applicability, BOOTSTRAP_NOT_REQUIRED);
  const subject = shared.residual.subjects[0].subject;
  const manifestingGate = shared.residual.subjects[0].manifestations[0].gateId;
  for (const touching of [subject.protectedPath, subject.producerPath, 'governance/tools/validate-status-ledger.mjs', `governance/gates/${manifestingGate}/fixture.json`]) {
    const result = evaluateMaintenanceRepairBootstrapEligibility({ root: shared.root, v2Authority, manifest: { ...unrelated, paths: [{ path: touching }] }, manifestSha256: 'x', now: NOW });
    assert.equal(result.applicability, BOOTSTRAP_REQUIRED, touching);
    assert.equal(result.eligible, false);
    assert.ok(codes(result).includes('BOOTSTRAP_AUTHORITY_ABSENT'));
  }
});

/* ======================================================================== */
/* POSITIVE                                                                   */
/* ======================================================================== */

test('P01 an exact Owner-authorized bootstrap of the single reproduced subject is eligible', () => {
  withProgram({}, (program) => {
    const result = program.evaluate();
    assert.deepEqual(result.findings, []);
    assert.equal(result.applicability, BOOTSTRAP_REQUIRED);
    assert.equal(result.eligible, true);
    assert.equal(result.residualIdentitySha256, program.residualIdentitySha256);
    assert.deepEqual(result.subject, shared.residual.subjects[0].subject);
    assert.equal(result.bootstrapAuthority.path, program.paths.authorityPath);
  });
});

/* ======================================================================== */
/* HOSTILES — E1..E9                                                          */
/* ======================================================================== */

test('H01 an arbitrary old finding is not a bootstrap subject', () => {
  const producer = sha256(readBytes(REPO_ROOT, 'governance/tools/validate-status-ledger.mjs'));
  withProgram({ subjectOverride: { detectorId: 'MIGRATED_HISTORICAL_AUTHORITY', protectedPath: 'governance/GATE_REGISTRY_00_40.json', producerPath: 'governance/tools/validate-status-ledger.mjs', producerBlobSha256: producer } }, (program) => {
    const found = codes(program.evaluate());
    assert.ok(found.includes('BOOTSTRAP_E2_SUBJECT_MISMATCH'));
    assert.ok(found.includes('BOOTSTRAP_E9_BLOCKING_FINDING_OUTSIDE_SUBJECT'));
  });
});

test('H02 two defect subjects are refused even when one of them is the authorized one', () => {
  const mutation = secondSubjectMutation(shared);
  withProgram({}, (program) => withMutation(shared.root, mutation.path, mutation.mutate, () => {
    const result = program.evaluate();
    assert.equal(result.eligible, false);
    assert.ok(codes(result).includes('BOOTSTRAP_E2_MULTIPLE_DEFECT_SUBJECTS'));
    assert.ok(codes(result).includes('BOOTSTRAP_E9_BLOCKING_FINDING_OUTSIDE_SUBJECT'));
  }));
});

test('H03 an unknown blocker outside the subject is refused (E9)', () => {
  withProgram({}, (program) => withMutation(shared.root, 'governance/gates/GATE19/contracts/CURRENT_CONTRACT.json', (bytes) => Buffer.concat([bytes, Buffer.from(' ')]), () => {
    const result = program.evaluate();
    assert.equal(result.eligible, false);
    assert.ok(codes(result).includes('BOOTSTRAP_E9_BLOCKING_FINDING_OUTSIDE_SUBJECT'));
  }));
});

test('H04 an invalid LEDGER_INTEGRITY is refused and never read as FULL validity (E1)', () => {
  withProgram({}, (program) => withMutation(shared.root, LEDGER_PATH, (bytes) => {
    const text = bytes.toString('utf8');
    const index = text.lastIndexOf('"recordedAt":"') + '"recordedAt":"'.length;
    return Buffer.from(`${text.slice(0, index)}1999${text.slice(index + 4)}`, 'utf8');
  }, () => {
    const result = program.evaluate();
    assert.equal(result.eligible, false);
    assert.ok(codes(result).some((code) => code.startsWith('BOOTSTRAP_E1_')), codes(result).join(','));
  }));
});

test('H05 an Owner decision dated after the repair authority, or written by the repair, is refused (E3)', () => {
  withProgram({ decisionOverrides: { decidedAt: '2026-09-20T12:00:00.000Z' } }, (program) => {
    assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E3_OWNER_DECISION_NOT_CAUSALLY_PRIOR'));
  });
  withProgram({ includeDecisionInManifest: true }, (program) => {
    const found = codes(program.evaluate());
    assert.ok(found.includes('BOOTSTRAP_E3_OWNER_DECISION_WRITTEN_BY_REPAIR'));
    assert.ok(found.includes('BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE'));
  });
  withProgram({ writeDecision: false }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E3_OWNER_DECISION_ABSENT')));
});

test('H06 an extra repair path after the Owner binding breaks the manifest digest (E3/E4)', () => {
  withProgram({}, (program) => {
    const widened = { ...program.manifest, paths: [...program.manifest.paths, manifestEntry('governance/tools/fixture-extra.mjs', 'CREATE', { state: 'ABSENT' })] };
    const widenedBytes = jsonBytes(widened);
    const v2Authority = { ...program.v2Authority, authorizedPathManifestSha256: sha256(widenedBytes) };
    const result = evaluateMaintenanceRepairBootstrapEligibility({ root: shared.root, v2Authority, v2AuthorityPath: program.v2AuthorityPath, manifest: widened, manifestSha256: sha256(widenedBytes), now: NOW });
    assert.equal(result.eligible, false);
    assert.ok(codes(result).includes('BOOTSTRAP_E4_MANIFEST_DIGEST_MISMATCH'));
  });
});

const surfaceCase = (label, surfacePath) => test(`H07 ${label}: a bootstrap repair may not write ${surfacePath} (E4)`, () => {
  const entry = manifestEntry(surfacePath, exists(REPO_ROOT, surfacePath) && !surfacePath.includes('maintenance-repair-bootstrap') ? 'MODIFY' : 'CREATE',
    exists(REPO_ROOT, surfacePath) && !surfacePath.includes('maintenance-repair-bootstrap')
      ? { state: 'PRESENT', sha256: sha256(readBytes(REPO_ROOT, surfacePath)), byteLength: readBytes(REPO_ROOT, surfacePath).length }
      : { state: 'ABSENT' });
  withProgram({ extraEntries: [entry] }, (program) => {
    const result = program.evaluate();
    assert.equal(result.eligible, false);
    assert.ok(result.findings.some((item) => item.code === 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE' && item.detail === surfacePath));
  });
});
surfaceCase('ledger mutation', LEDGER_PATH);
surfaceCase('Fast Gate mutation', 'governance/tools/gate-fast-path-control-plane.mjs');
surfaceCase('evaluator mutation', 'governance/gee-v1/core/maintenance-repair-bootstrap-trust.mjs');
surfaceCase('authority schema mutation', 'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-authority.schema.json');
surfaceCase('consumption schema mutation', 'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-consumption.schema.json');
surfaceCase('context compiler mutation', 'governance/gee-v1/context/compile-context.mjs');
surfaceCase('Wheel project adapter mutation', 'governance/gee-v1/adapters/wheel/wheel-project-adapter.mjs');
surfaceCase('Wheel context adapter mutation', 'governance/gee-v1/adapters/wheel/context-wheel-adapter.mjs');
surfaceCase('normal repair modifying the publisher', 'governance/tools/apply-path-prestate-program.mjs');

test('H08 the active bootstrap authority may not modify itself (E4)', () => {
  const selfPath = deriveMaintenanceRepairBootstrapPaths('FIXTURE_BOOTSTRAP_REPAIR_R1').authorityPath;
  withProgram({ extraEntries: [manifestEntry(selfPath, 'MODIFY', { state: 'PRESENT', sha256: 'a'.repeat(64), byteLength: 1 })] }, (program) => {
    assert.ok(program.evaluate().findings.some((item) => item.code === 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE' && item.detail === selfPath));
  });
});

test('H09 a bootstrap receipt already present is a consumed authority (E6)', () => {
  withProgram({}, (program) => {
    writeBytes(shared.root, program.paths.receiptPath, Buffer.from('{}\n'));
    assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E6_RECEIPT_ALREADY_PRESENT'));
  });
});

test('H10 maxUse other than 1 is refused (E5)', () => {
  withProgram({ authorityOverrides: { maxUse: 2 } }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E5_MAX_USE_INVALID')));
});

test('H11 pushAuthorized = true is refused on the bootstrap and on the V2 authority (E7)', () => {
  withProgram({ authorityOverrides: { pushAuthorized: true } }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E7_PUSH_AUTHORIZED')));
  withProgram({}, (program) => {
    const result = evaluateMaintenanceRepairBootstrapEligibility({ root: shared.root, v2Authority: { ...program.v2Authority, pushAuthorized: true }, v2AuthorityPath: program.v2AuthorityPath, manifest: program.manifest, manifestSha256: sha256(program.manifestBytes), now: NOW });
    assert.ok(codes(result).includes('BOOTSTRAP_E7_PUSH_AUTHORIZED'));
  });
});

test('H12 R8 present ends eligibility (E8)', () => {
  withProgram({}, (program) => withMutation(shared.root, R8_PATH, () => Buffer.from('{}\n'), () => {
    assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E8_R8_PRESENT'));
  }));
});

test('H13 a recursive bootstrap is refused by denial and by path', () => {
  withProgram({ authorityOverrides: { recursiveBootstrapAuthorized: true } }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_RECURSION_NOT_PERMITTED')));
  const other = deriveMaintenanceRepairBootstrapPaths('ANOTHER_REPAIR_R1');
  withProgram({ extraEntries: [manifestEntry(other.authorityPath, 'CREATE', { state: 'ABSENT' }), manifestEntry(other.receiptPath, 'CREATE', { state: 'ABSENT' })] }, (program) => {
    const found = program.evaluate().findings.filter((item) => item.code === 'BOOTSTRAP_RECURSIVE_BOOTSTRAP_PATH').map((item) => item.detail);
    assert.deepEqual(found.sort(), [other.authorityPath, other.receiptPath].sort());
  });
});

test('H14 a manifest digest mismatch, a residual identity mismatch and a conflicting candidate are refused', () => {
  withProgram({ authorityOverrides: { repairManifestSha256: '0'.repeat(64) } }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E4_MANIFEST_DIGEST_MISMATCH')));
  withProgram({ residualIdentityOverride: '0'.repeat(64) }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E2_RESIDUAL_IDENTITY_MISMATCH')));
  withProgram({ authorityOverrides: { authorityId: 'OTHER_PROGRAM_R1_BOOTSTRAP_AUTHORITY_R1' } }, (program) => {
    assert.ok(program.evaluate().findings.some((item) => item.code === 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT' && item.detail === 'authorityId'));
  });
});

test('H15 a missing receipt reservation is refused (E4)', () => {
  withProgram({ omitReceiptEntry: true }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E4_RECEIPT_NOT_RESERVED')));
});

/* ======================================================================== */
/* EMPTY RESIDUAL — THE PROTECTED CONTROL SURFACE AFTER GENESIS               */
/*                                                                            */
/* Every program below is ORDINARY V2 maintenance: no bootstrap authority, no */
/* Owner decision, no receipt reservation, no recursive path. The residual is */
/* empty and the ledger intact. The control-surface hit is the only signal,   */
/* and it alone must keep the program out of NOT_REQUIRED.                     */
/* ======================================================================== */

let emptyResidual = null;
function emptyResidualFixture() { emptyResidual ??= makeEmptyResidualPostGenesisFixture(); return emptyResidual; }
after(() => { if (emptyResidual) fs.rmSync(emptyResidual.root, { recursive: true, force: true }); });

function ordinaryProgram(fixture, programId, extraEntries = [], extraCandidates = []) {
  return buildRepairProgram(fixture, {
    programId, extraEntries, extraCandidates,
    omitReceiptEntry: true, writeBootstrapAuthority: false, writeDecision: false
  });
}

/** A MODIFY of `surfacePath` bound to its present bytes, with one changed candidate. */
function presentModify(fixture, surfacePath) {
  const current = readBytes(fixture.root, surfacePath);
  return {
    current,
    entry: manifestEntry(surfacePath, 'MODIFY', { state: 'PRESENT', sha256: sha256(current), byteLength: current.length }, 'ordinary maintenance of a control-surface file'),
    candidate: [surfacePath, Buffer.concat([current, Buffer.from('\n')])]
  };
}

/** The V2 law alone, exactly as the publisher runs it after the bootstrap boundary. */
function v2Decision(fixture, program) {
  const observation = collectPostFreezeMaintenanceObservation({
    root: fixture.root, authority: program.v2Authority, authorityDocumentPath: program.v2AuthorityPath,
    candidateWrites: [...program.candidates].map(([candidatePath, bytes]) => ({ path: candidatePath, bytes }))
  });
  assert.equal(observation.valid, true, JSON.stringify(observation.findings));
  return evaluatePostFreezeMaintenanceAuthorityV2({
    authority: program.v2Authority, manifest: observation.manifest, observed: observation.observed,
    phase: PHASE_AUTHORIZE_PROGRAM_APPLY, now: NOW, consumptionRecord: null
  });
}

function assertNoBootstrapDocuments(fixture, program) {
  for (const documentPath of [program.paths.authorityPath, program.paths.ownerDecisionPath, program.paths.receiptPath]) {
    assert.equal(exists(fixture.root, documentPath), false, `no preinstalled bootstrap document: ${documentPath}`);
  }
  assert.equal(program.manifest.paths.some((item) => item.path === program.paths.receiptPath), false, 'no receipt reservation');
}

function assertEmptyResidual(result) {
  assert.equal(result.residualSummary.evaluable, true);
  assert.equal(result.residualSummary.ledgerIntegrityValid, true);
  assert.equal(result.residualSummary.blockingCount, 0);
  assert.equal(result.residualSummary.subjectCount, 0);
}

test('E01 on an empty residual after Genesis, unrelated ordinary maintenance stays NOT_REQUIRED and publishes', () => {
  const fixture = emptyResidualFixture();
  const program = ordinaryProgram(fixture, 'EMPTY_RESIDUAL_UNRELATED_R1');
  try {
    assertNoBootstrapDocuments(fixture, program);
    const result = program.evaluate();
    assertEmptyResidual(result);
    assert.deepEqual(result.controlSurfaceHits, []);
    assert.deepEqual(result.recursiveHits, []);
    assert.equal(result.applicability, BOOTSTRAP_NOT_REQUIRED);
    assert.equal(result.eligible, null);
    const ledgerBefore = sha256(readBytes(fixture.root, LEDGER_PATH));
    const report = program.publish();
    assert.equal(report.decision, 'APPLIED', JSON.stringify(report.findings));
    assert.equal(sha256(readBytes(fixture.root, LEDGER_PATH)), ledgerBefore);
  } finally { program.cleanup(); }
  assert.equal(git(fixture.root, ['status', '--porcelain']).toString('utf8'), '', 'the positive control leaves the fixture clean');
});

const EMPTY_RESIDUAL_SURFACE_CASES = [
  ['A publisher', 'governance/tools/apply-path-prestate-program.mjs'],
  ['B evaluator', 'governance/gee-v1/core/maintenance-repair-bootstrap-trust.mjs'],
  ['C1 authority schema', 'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-authority.schema.json'],
  ['C2 consumption schema', 'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-consumption.schema.json'],
  ['D Fast Gate', 'governance/tools/gate-fast-path-control-plane.mjs'],
  ['E ledger', LEDGER_PATH],
  ['context compiler', 'governance/gee-v1/context/compile-context.mjs'],
  ['Wheel project adapter', 'governance/gee-v1/adapters/wheel/wheel-project-adapter.mjs'],
  ['Wheel context adapter', 'governance/gee-v1/adapters/wheel/context-wheel-adapter.mjs']
];

test('E02 the empty-residual battery covers the whole static protected control surface', () => {
  assert.deepEqual(EMPTY_RESIDUAL_SURFACE_CASES.map(([, surfacePath]) => surfacePath).sort(), [...BOOTSTRAP_PROTECTED_CONTROL_SURFACE].sort());
});

for (const [label, surfacePath] of EMPTY_RESIDUAL_SURFACE_CASES) {
  test(`E03 ${label}: ordinary maintenance of ${surfacePath} on an empty residual is never NOT_REQUIRED and is refused (E4)`, () => {
    const fixture = emptyResidualFixture();
    const modify = presentModify(fixture, surfacePath);
    const program = ordinaryProgram(fixture, `EMPTY_RESIDUAL_SURFACE_${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_R1`, [modify.entry], [modify.candidate]);
    try {
      assertNoBootstrapDocuments(fixture, program);
      // The V2 law alone authorizes this program: without the bootstrap boundary it
      // would publish. What refuses it below is the protected-control-surface law.
      assert.equal(v2Decision(fixture, program).decision, 'AUTHORIZED');
      // Differential: the same program without the surface entry is NOT_REQUIRED,
      // so the surface hit — not a fixture document — is what the law reacts to.
      const withoutSurface = evaluateMaintenanceRepairBootstrapEligibility({
        root: fixture.root, v2Authority: program.v2Authority, v2AuthorityPath: program.v2AuthorityPath,
        manifest: { ...program.manifest, paths: program.manifest.paths.filter((item) => item.path !== surfacePath) }, manifestSha256: 'x', now: NOW
      });
      assert.equal(withoutSurface.applicability, BOOTSTRAP_NOT_REQUIRED);

      const result = program.evaluate();
      assertEmptyResidual(result);
      assert.deepEqual(result.controlSurfaceHits, [surfacePath]);
      assert.deepEqual(result.recursiveHits, []);
      assert.notEqual(result.applicability, BOOTSTRAP_NOT_REQUIRED);
      assert.equal(result.applicability, BOOTSTRAP_REQUIRED);
      assert.equal(result.eligible, false);
      assert.ok(result.findings.some((item) => item.code === 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE' && item.detail === surfacePath), codes(result).join(','));
      assert.ok(codes(result).includes('BOOTSTRAP_AUTHORITY_ABSENT'));
      assert.equal(result.bootstrapAuthority, null);

      // Fail closed at the publisher, before any byte moves.
      const ledgerBefore = sha256(readBytes(fixture.root, LEDGER_PATH));
      const report = program.publish();
      assert.equal(report.decision, 'BLOCKED');
      assert.equal(report.stage, 'BOOTSTRAP');
      assert.ok(report.findings.some((item) => item.code === 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE' && item.detail === surfacePath));
      assert.deepEqual(readBytes(fixture.root, surfacePath), modify.current);
      assert.equal(sha256(readBytes(fixture.root, LEDGER_PATH)), ledgerBefore);
      assert.equal(exists(fixture.root, program.targetPath), false);
      assert.equal(exists(fixture.root, program.consumptionPath), false);
    } finally { program.cleanup(); }
  });
}

test('E04 on an empty residual an ordinary program may not write its own bootstrap authority or Owner decision (E4)', () => {
  const fixture = emptyResidualFixture();
  const own = deriveMaintenanceRepairBootstrapPaths('EMPTY_RESIDUAL_SELF_AUTHORITY_R1');
  for (const selfPath of [own.authorityPath, own.ownerDecisionPath]) {
    const program = ordinaryProgram(fixture, 'EMPTY_RESIDUAL_SELF_AUTHORITY_R1', [manifestEntry(selfPath, 'CREATE', { state: 'ABSENT' })]);
    try {
      assertNoBootstrapDocuments(fixture, program);
      const result = program.evaluate();
      assertEmptyResidual(result);
      assert.deepEqual(result.controlSurfaceHits, [selfPath]);
      assert.equal(result.applicability, BOOTSTRAP_REQUIRED);
      assert.equal(result.eligible, false);
      assert.ok(result.findings.some((item) => item.code === 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE' && item.detail === selfPath));
      const report = program.publish();
      assert.equal(report.decision, 'BLOCKED');
      assert.equal(report.stage, 'BOOTSTRAP');
      assert.equal(exists(fixture.root, selfPath), false);
    } finally { program.cleanup(); }
  }
});

/* ======================================================================== */
/* GENESIS                                                                    */
/* ======================================================================== */

function genesisPublisherPrestate() {
  const authority = JSON.parse(readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_AUTHORITY_PATH).toString('utf8'));
  const bytes = git(REPO_ROOT, ['show', `${authority.preState.baseHead}:${BOOTSTRAP_GENESIS_PUBLISHER_PATH}`]);
  return { sha256: sha256(bytes), byteLength: bytes.length };
}

test('G01 the Genesis candidate is the exact cohort, including the one-time publisher succession', () => {
  const manifest = JSON.parse(readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_MANIFEST_PATH).toString('utf8'));
  const authority = JSON.parse(readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_AUTHORITY_PATH).toString('utf8'));
  assert.equal(authority.authorizedPathManifestSha256, sha256(readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_MANIFEST_PATH)));
  assert.equal(authority.consumptionRecordPath, BOOTSTRAP_GENESIS_CONSUMPTION_PATH);
  assert.equal(authority.pushAuthorized, false);
  assert.equal(authority.maxUse, 1);
  assert.equal(validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose).valid, true);
  assert.deepEqual(validateMaintenanceBootstrapGenesisCohort({ manifest, publisherPrestate: genesisPublisherPrestate() }).findings, []);
});

test('G02 a Genesis without the required publisher succession is refused', () => {
  const manifest = JSON.parse(readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_MANIFEST_PATH).toString('utf8'));
  const publisherPrestate = genesisPublisherPrestate();
  const without = { ...manifest, paths: manifest.paths.filter((entry) => entry.path !== BOOTSTRAP_GENESIS_PUBLISHER_PATH) };
  assert.ok(codes(validateMaintenanceBootstrapGenesisCohort({ manifest: without, publisherPrestate })).includes('BOOTSTRAP_GENESIS_PUBLISHER_SUCCESSION_MISSING'));
  const stale = { ...manifest, paths: manifest.paths.map((entry) => (entry.path === BOOTSTRAP_GENESIS_PUBLISHER_PATH ? { ...entry, prestate: { ...entry.prestate, sha256: '0'.repeat(64) } } : entry)) };
  assert.ok(codes(validateMaintenanceBootstrapGenesisCohort({ manifest: stale, publisherPrestate })).includes('BOOTSTRAP_GENESIS_PUBLISHER_SUCCESSION_INVALID'));
});

test('G03 a second Genesis is refused by four independent mechanisms', () => {
  const manifest = JSON.parse(readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_MANIFEST_PATH).toString('utf8'));
  const authority = JSON.parse(readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_AUTHORITY_PATH).toString('utf8'));
  // 1. prior V2 consumption of the Genesis authority
  assert.ok(codes(validateMaintenanceBootstrapGenesisCohort({ manifest, publisherPrestate: genesisPublisherPrestate(), genesisConsumptionPresent: true })).includes('BOOTSTRAP_GENESIS_ALREADY_CONSUMED'));
  const replay = evaluatePostFreezeMaintenanceAuthorityV2({ authority, manifest, observed: {}, phase: PHASE_AUTHORIZE_PROGRAM_APPLY, now: NOW, consumptionRecord: { documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION' } });
  assert.ok(codes(replay).includes('AUTHORITY_ALREADY_CONSUMED'));
  // 2. CREATE/ABSENT pre-state no longer satisfiable once the primitive exists
  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);
  const pathPrestates = Object.fromEntries(manifest.paths.map((entry) => [entry.path, BOOTSTRAP_GENESIS_CREATE_PATHS.slice(0, 4).includes(entry.path)
    ? { state: 'PRESENT', sha256: 'a'.repeat(64), byteLength: 1, canonicalPredecessors: [] }
    : { ...entry.prestate, canonicalPredecessors: entry.prestate.sha256 ? [entry.prestate.sha256] : [] }]));
  const prestateFindings = [];
  evaluatePathPrestateBinding({ manifestResult, authority, observed: { pathPrestates, authorityDocumentPath: BOOTSTRAP_GENESIS_AUTHORITY_PATH }, findings: prestateFindings });
  assert.equal(prestateFindings.filter((item) => item.code === 'PATH_PRESTATE_STATE_MISMATCH').length, 4);
  // 3. the protected control surface: a re-Genesis shaped program through the new publisher's gate
  const reGenesis = BOOTSTRAP_GENESIS_CREATE_PATHS.slice(0, 3).map((surfacePath) => manifestEntry(surfacePath, 'CREATE', { state: 'ABSENT' }))
    .concat([manifestEntry(BOOTSTRAP_GENESIS_PUBLISHER_PATH, 'MODIFY', { state: 'PRESENT', sha256: 'a'.repeat(64), byteLength: 1 })]);
  withProgram({ programId: 'SECOND_GENESIS_ATTEMPT_R1', extraEntries: reGenesis }, (program) => {
    const hits = program.evaluate().findings.filter((item) => item.code === 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE').map((item) => item.detail);
    assert.deepEqual(hits.sort(), [...BOOTSTRAP_GENESIS_CREATE_PATHS.slice(0, 3), BOOTSTRAP_GENESIS_PUBLISHER_PATH].sort());
  });
  // 4. a normal authority can never carry genesisAuthorized = true
  withProgram({ authorityOverrides: { genesisAuthorized: true } }, (program) => assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_GENESIS_NOT_PERMITTED')));
});

test('G04 the Genesis receipt is absent and the primitive is not the authority of its own Genesis', () => {
  assert.equal(exists(REPO_ROOT, BOOTSTRAP_GENESIS_CONSUMPTION_PATH), false);
  assert.equal(exists(REPO_ROOT, deriveMaintenanceRepairBootstrapPaths('GATE26_MAINTENANCE_BOOTSTRAP_TRUST_PRIMITIVE_GENESIS_R1').receiptPath), false);
  assert.equal(exists(REPO_ROOT, deriveMaintenanceRepairBootstrapPaths('GATE26_MAINTENANCE_BOOTSTRAP_TRUST_PRIMITIVE_GENESIS_R1').authorityPath), false);
  // The publisher and the evaluator never import the Fast Gate for eligibility.
  const publisher = readBytes(REPO_ROOT, BOOTSTRAP_GENESIS_PUBLISHER_PATH).toString('utf8');
  const evaluator = readBytes(REPO_ROOT, 'governance/gee-v1/core/maintenance-repair-bootstrap-trust.mjs').toString('utf8');
  assert.equal(/gate-fast-path-control-plane/.test(publisher), false);
  assert.equal(/^import .*gate-fast-path-control-plane/m.test(evaluator), false);
});

test('G05 after Genesis, a second publisher succession on an empty FULL residual is refused by the control-surface law alone', () => {
  const fixture = emptyResidualFixture();
  // Every member is PRESENT and bound to its post-Genesis bytes: the CREATE/ABSENT
  // mechanism of G03 plays no part here, and the V2 law alone would authorize it.
  const members = [BOOTSTRAP_GENESIS_PUBLISHER_PATH, ...BOOTSTRAP_GENESIS_CREATE_PATHS.slice(0, 3)].map((member) => presentModify(fixture, member));
  const program = ordinaryProgram(fixture, 'SECOND_PUBLISHER_SUCCESSION_R1', members.map((member) => member.entry), members.map((member) => member.candidate));
  try {
    assertNoBootstrapDocuments(fixture, program);
    for (const member of members) assert.equal(member.entry.prestate.state, 'PRESENT');
    assert.equal(v2Decision(fixture, program).decision, 'AUTHORIZED');
    const result = program.evaluate();
    assertEmptyResidual(result);
    assert.deepEqual(result.recursiveHits, []);
    assert.deepEqual(result.controlSurfaceHits, [BOOTSTRAP_GENESIS_PUBLISHER_PATH, ...BOOTSTRAP_GENESIS_CREATE_PATHS.slice(0, 3)].sort());
    assert.equal(result.applicability, BOOTSTRAP_REQUIRED);
    assert.equal(result.eligible, false);
    assert.deepEqual(result.findings.filter((item) => item.code === 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE').map((item) => item.detail).sort(), result.controlSurfaceHits);
    const report = program.publish();
    assert.equal(report.decision, 'BLOCKED');
    assert.equal(report.stage, 'BOOTSTRAP');
    for (const member of members) assert.deepEqual(readBytes(fixture.root, member.entry.path), member.current, member.entry.path);
    assert.equal(exists(fixture.root, program.consumptionPath), false);
  } finally { program.cleanup(); }
});

/* ======================================================================== */
/* PUBLISHER: receipts, replay, closure                                       */
/* ======================================================================== */

test('R01 a forged or pre-existing bootstrap receipt before publication is a consumed authority; nothing is written', () => {
  for (const forged of [Buffer.from('not json'), null]) {
    withProgram({}, (program) => {
      const receiptBytes = forged ?? jsonBytes({
        document: 'MAINTENANCE_REPAIR_BOOTSTRAP_TRUST_CONSUMPTION', schemaVersion: 1,
        bootstrapAuthorityId: program.paths.authorityId, bootstrapAuthorityPath: program.paths.authorityPath,
        bootstrapAuthoritySha256: sha256(readBytes(shared.root, program.paths.authorityPath)), programId: program.programId,
        repairManifestPath: program.manifestPath, repairManifestSha256: sha256(program.manifestBytes),
        baseHead: program.v2Authority.preState.baseHead, residualIdentitySha256: program.residualIdentitySha256,
        v2ConsumptionRecordPath: program.consumptionPath, v2AuthorityId: program.v2Authority.authorityId, transactionId: 'FORGED_TX',
        publicationAdmission: { admissionId: 'FORGED', admissionPath: 'governance/authority/publication-admissions/GATE26/FORGED.json', admissionSha256: 'a'.repeat(64) },
        recordedAt: RECORDED_AT, consumedUse: 1, closureObligation: 'ORDINARY_FAST_GATE_PASS'
      });
      writeBytes(shared.root, program.paths.receiptPath, receiptBytes);
      const ledgerBefore = sha256(readBytes(shared.root, LEDGER_PATH));
      const report = program.publish();
      assert.equal(report.decision, 'BLOCKED');
      assert.deepEqual(codes(report), ['AUTHORITY_ALREADY_CONSUMED', 'BOOTSTRAP_RECEIPT_PRESENT_WITHOUT_V2_RECEIPT']);
      assert.equal(exists(shared.root, program.targetPath), false);
      assert.equal(exists(shared.root, program.consumptionPath), false);
      assert.deepEqual(readBytes(shared.root, program.paths.receiptPath), receiptBytes);
      assert.equal(sha256(readBytes(shared.root, LEDGER_PATH)), ledgerBefore);
    });
  }
});

test('R02 an ineligible bootstrap is BLOCKED before any write, and the caller may never supply the receipt', () => {
  withProgram({ authorityOverrides: { maxUse: 2 } }, (program) => {
    const report = program.publish();
    assert.equal(report.decision, 'BLOCKED');
    assert.equal(report.stage, 'BOOTSTRAP');
    assert.ok(codes(report).includes('BOOTSTRAP_E5_MAX_USE_INVALID'));
    assert.equal(exists(shared.root, program.targetPath), false);
    assert.equal(exists(shared.root, program.paths.receiptPath), false);
  });
  withProgram({}, (program) => {
    const candidates = new Map([...program.candidates, [program.paths.receiptPath, Buffer.from('{}\n')]]);
    const report = program.publish({ candidates });
    assert.deepEqual(codes(report), ['BOOTSTRAP_RECEIPT_CANDIDATE_FORBIDDEN']);
    assert.equal(exists(shared.root, program.paths.receiptPath), false);
  });
});

test('R03 publication, idempotence, replay, receipt coherence and the closure obligation', async () => {
  const fixture = makeCanonicalFixture();
  try {
    const program = buildRepairProgram(fixture);
    const ledgerBefore = sha256(readBytes(fixture.root, LEDGER_PATH));

    // ---- exact publication: both receipts, one transaction ----
    const report = program.publish();
    assert.equal(report.decision, 'APPLIED', JSON.stringify(report.findings));
    assert.equal(report.bootstrapConsumptionRecordPath, program.paths.receiptPath);
    assert.equal(sha256(readBytes(fixture.root, LEDGER_PATH)), ledgerBefore, 'the ledger is never written');
    const receiptBytes = readBytes(fixture.root, program.paths.receiptPath);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    const v2Bytes = readBytes(fixture.root, program.consumptionPath);
    const v2 = JSON.parse(v2Bytes.toString('utf8'));
    assert.equal(validateMaintenanceRepairBootstrapConsumptionShape(receipt).valid, true);
    assert.equal(Object.keys(receipt).some((key) => /fast/i.test(key)), false, 'no Fast Gate result in the receipt');
    assert.equal(receipt.recordedAt, v2.recordedAt);
    assert.equal(receipt.transactionId, v2.transactionId);
    assert.deepEqual(receipt.publicationAdmission, v2.publicationAdmission);
    assert.equal(receipt.residualIdentitySha256, program.residualIdentitySha256);
    const certified = v2.cohort.find((entry) => entry.path === program.paths.receiptPath);
    assert.equal(certified.sha256, sha256(receiptBytes), 'the V2 receipt certifies the bootstrap receipt');
    assert.equal(validateMaintenanceRepairBootstrapReceiptPair({ root: fixture.root, v2Authority: program.v2Authority, v2ConsumptionRecord: v2 }).coherent, true);

    // ---- consumed-authority replay of a coherent pair: ALREADY_APPLIED, no write ----
    const again = program.publish({ transactionId: 'SECOND_TX', recordedAt: '2026-09-21T00:00:01.000Z' });
    assert.equal(again.decision, 'ALREADY_APPLIED');
    assert.deepEqual(readBytes(fixture.root, program.paths.receiptPath), receiptBytes);
    assert.deepEqual(readBytes(fixture.root, program.consumptionPath), v2Bytes);

    // ---- mismatched pair / receipt authority mismatch / forged receipt: consumed, never repaired ----
    for (const [field, value] of [['transactionId', 'OTHER_TX'], ['bootstrapAuthorityId', 'OTHER_R1_BOOTSTRAP_AUTHORITY_R1'], ['residualIdentitySha256', '0'.repeat(64)]]) {
      const tampered = jsonBytes({ ...receipt, [field]: value });
      writeBytes(fixture.root, program.paths.receiptPath, tampered);
      const blocked = program.publish();
      assert.equal(blocked.decision, 'BLOCKED', field);
      assert.equal(codes(blocked)[0], 'AUTHORITY_ALREADY_CONSUMED');
      assert.ok(codes(blocked).includes('CONSUMED_COHORT_DRIFTED'), field);
      assert.ok(blocked.findings.some((item) => item.code === 'BOOTSTRAP_RECEIPT_MISMATCH' && item.detail === field), field);
      assert.deepEqual(readBytes(fixture.root, program.paths.receiptPath), tampered, 'the publisher does not repair the receipt');
    }
    writeBytes(fixture.root, program.paths.receiptPath, receiptBytes);
    assert.equal(program.publish().decision, 'ALREADY_APPLIED');

    // ---- the evaluator itself refuses a second consumption ----
    assert.ok(codes(program.evaluate()).includes('BOOTSTRAP_E6_RECEIPT_ALREADY_PRESENT'));

    // ---- closure: never by quotation, never by a substitute invoker, STOP on failure ----
    const quoted = await evaluateMaintenanceRepairBootstrapClosure({ root: fixture.root, programId: program.programId, gateId: 'GATE26', fastGateResult: { verdict: 'FAST_PATH_READY' } });
    assert.equal(quoted.decision, 'CLOSURE_REQUIRES_REAL_FAST_GATE_INVOCATION');
    assert.equal(quoted.closureObligationSatisfied, false);
    assert.equal(quoted.fastGateInvocations, 0);
    const substitute = await evaluateMaintenanceRepairBootstrapClosure({ root: fixture.root, programId: program.programId, gateId: 'GATE26', invokeFastGate: async () => ({ verdict: 'FAST_PATH_READY' }) });
    assert.equal(substitute.decision, 'CLOSURE_REQUIRES_REAL_FAST_GATE_INVOCATION');
    assert.equal(substitute.closureObligationSatisfied, false);
    for (const failing of [async () => ({ verdict: 'FAST_PATH_BLOCKED' }), async () => { throw new Error('CONFLICTING_AUTHORITY'); }]) {
      let calls = 0;
      const stop = await evaluateMaintenanceRepairBootstrapClosure({ root: fixture.root, programId: program.programId, gateId: 'GATE26', invokeFastGate: async (options) => { calls += 1; return failing(options); } });
      assert.equal(stop.decision, STOP_BOOTSTRAP_REPAIR_FAILED_TO_RESTORE_TRUST);
      assert.equal(stop.terminal, true);
      assert.equal(calls, 1, 'no automatic retry');
      assert.equal(stop.retryAuthorized, false);
      assert.equal(stop.successorAuthorized, false);
      assert.equal(stop.secondBootstrapAuthorized, false);
      assert.equal(stop.authorityConsumed, true);
    }
    // Still consumed after the STOP: no second bootstrap, no rollback.
    assert.equal(program.publish().decision, 'ALREADY_APPLIED');
    assert.equal(sha256(readBytes(fixture.root, LEDGER_PATH)), ledgerBefore);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('R04 a closure is refused without a consumed bootstrap', async () => {
  const result = await evaluateMaintenanceRepairBootstrapClosure({ root: shared.root, programId: 'NEVER_CONSUMED_R1', gateId: 'GATE26', invokeFastGate: async () => { throw new Error('must not be invoked'); } });
  assert.equal(result.decision, 'CLOSURE_WITHOUT_CONSUMED_BOOTSTRAP');
  assert.equal(result.fastGateInvocations, 0);
});

/* ======================================================================== */
/* CLOSURE: consumption is proven by the whole receipt chain, before any     */
/* Fast Gate invocation. Every refusal below must leave the counter at zero. */
/* ======================================================================== */

/** A substitute Fast Gate that counts its own invocations; it returns `verdict`, or throws `throws`. */
function countingFastGate(verdict = 'FAST_PATH_READY', throws = null) {
  const invoker = async () => {
    invoker.calls += 1;
    if (throws) throw new Error(throws);
    return { verdict };
  };
  invoker.calls = 0;
  return invoker;
}

async function closeWithCounter(root, programId, extra = {}) {
  const invokeFastGate = extra.invokeFastGate ?? countingFastGate();
  const result = await evaluateMaintenanceRepairBootstrapClosure({ root, programId, gateId: 'GATE26', ...extra, invokeFastGate });
  return { result, calls: invokeFastGate.calls };
}

function assertRefusedBeforeFastGate({ result, calls }, code, detail, label = code) {
  assert.equal(result.decision, 'CLOSURE_WITHOUT_CONSUMED_BOOTSTRAP', `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.closureObligationSatisfied, false, label);
  assert.equal(result.fastGateInvocations, 0, label);
  assert.equal(calls, 0, `${label}: the Fast Gate is never invoked on an unproven consumption`);
  assert.ok(result.findings.some((item) => item.code === code && (detail === undefined || item.detail === detail)), `${label}: ${code}:${detail} in ${JSON.stringify(result.findings)}`);
}

/** Replace (or, when `mutate` returns null, remove) one file for the duration of `body`, then restore it. */
async function withBytes(root, relativePath, mutate, body) {
  const before = exists(root, relativePath) ? readBytes(root, relativePath) : null;
  const after = mutate(before);
  if (after === null) remove(root, relativePath); else writeBytes(root, relativePath, after);
  try { return await body(after); } finally {
    if (before === null) remove(root, relativePath); else writeBytes(root, relativePath, before);
  }
}

const editJson = (edit) => (bytes) => jsonBytes(edit(JSON.parse(bytes.toString('utf8'))));

/** A closed-schema-valid bootstrap receipt for `program` that no publisher wrote. */
function forgedBootstrapReceipt(root, program) {
  return jsonBytes({
    document: 'MAINTENANCE_REPAIR_BOOTSTRAP_TRUST_CONSUMPTION', schemaVersion: 1,
    bootstrapAuthorityId: program.paths.authorityId, bootstrapAuthorityPath: program.paths.authorityPath,
    bootstrapAuthoritySha256: exists(root, program.paths.authorityPath) ? sha256(readBytes(root, program.paths.authorityPath)) : 'a'.repeat(64),
    programId: program.programId, repairManifestPath: program.manifestPath, repairManifestSha256: sha256(program.manifestBytes),
    baseHead: program.v2Authority.preState.baseHead, residualIdentitySha256: program.residualIdentitySha256 ?? 'd'.repeat(64),
    v2ConsumptionRecordPath: program.consumptionPath, v2AuthorityId: program.v2Authority.authorityId, transactionId: 'FORGED_TX',
    publicationAdmission: { admissionId: 'FORGED', admissionPath: 'governance/authority/publication-admissions/GATE26/FORGED.json', admissionSha256: 'a'.repeat(64) },
    recordedAt: RECORDED_AT, consumedUse: 1, closureObligation: 'ORDINARY_FAST_GATE_PASS'
  });
}

test('R05 an isolated valid-looking bootstrap receipt never reaches the Fast Gate', async () => {
  // Isolated: the receipt is the only bootstrap document of its program.
  const isolated = { ...deriveMaintenanceRepairBootstrapPaths('ISOLATED_RECEIPT_R1') };
  const program = {
    programId: 'ISOLATED_RECEIPT_R1', paths: isolated, manifestPath: 'governance/historical-architecture/ISOLATED_RECEIPT_R1_AUTHORIZED_PATHS.json',
    manifestBytes: Buffer.from('{}\n'), consumptionPath: 'governance/historical-architecture/ISOLATED_RECEIPT_R1_CONSUMPTION.json',
    v2Authority: { authorityId: 'ISOLATED_RECEIPT_R1_LOCAL_AUTHORITY', preState: { baseHead: 'c'.repeat(40) } }, residualIdentitySha256: null
  };
  const receiptBytes = forgedBootstrapReceipt(shared.root, program);
  assert.equal(validateMaintenanceRepairBootstrapConsumptionShape(JSON.parse(receiptBytes.toString('utf8'))).valid, true, 'the forged receipt is shape-valid');
  await withBytes(shared.root, isolated.receiptPath, () => receiptBytes, async () => {
    assertRefusedBeforeFastGate(await closeWithCounter(shared.root, 'ISOLATED_RECEIPT_R1'), 'BOOTSTRAP_AUTHORITY_ABSENT', isolated.authorityPath);
    assert.deepEqual(readBytes(shared.root, isolated.receiptPath), receiptBytes, 'the receipt is not repaired or removed');
  });

  // Beside a real, unpublished program: authority, decision, manifest and V2 authority
  // are all present, but nothing was consumed, so there is no V2 receipt.
  const built = buildRepairProgram(shared);
  try {
    const forged = forgedBootstrapReceipt(shared.root, built);
    await withBytes(shared.root, built.paths.receiptPath, () => forged, async () => {
      assertRefusedBeforeFastGate(await closeWithCounter(shared.root, built.programId), 'BOOTSTRAP_CLOSURE_V2_RECEIPT_ABSENT', built.consumptionPath);
      assert.equal(exists(shared.root, built.consumptionPath), false, 'no V2 receipt is inferred or written');
      assert.deepEqual(readBytes(shared.root, built.paths.receiptPath), forged, 'the receipt is not repaired or removed');
    });
  } finally { built.cleanup(); }
});

test('R06 on a published pair, every broken link of the consumption chain refuses the closure before the Fast Gate', async () => {
  const fixture = makeCanonicalFixture();
  try {
    const program = buildRepairProgram(fixture, { programId: 'FIXTURE_BOOTSTRAP_CLOSURE_R1' });
    const { root } = fixture;
    assert.equal(program.publish().decision, 'APPLIED');
    const receiptPath = program.paths.receiptPath;
    const authorityPath = program.paths.authorityPath;
    const watched = [receiptPath, program.consumptionPath, authorityPath, program.manifestPath, program.v2AuthorityPath, LEDGER_PATH];
    const snapshot = () => watched.map((item) => [item, exists(root, item) ? sha256(readBytes(root, item)) : null]);
    const published = snapshot();
    const v2 = JSON.parse(readBytes(root, program.consumptionPath).toString('utf8'));
    assert.equal(validateMaintenanceRepairBootstrapReceiptPair({ root, v2Authority: program.v2Authority, v2ConsumptionRecord: v2 }).coherent, true);

    // Positive control: the coherent pair proves consumption and reaches the Fast
    // Gate exactly once. A substitute invoker can never close, even on READY.
    const reached = async () => {
      const outcome = await closeWithCounter(root, program.programId);
      assert.equal(outcome.calls, 1);
      assert.equal(outcome.result.fastGateInvocations, 1);
      assert.equal(outcome.result.decision, 'CLOSURE_REQUIRES_REAL_FAST_GATE_INVOCATION');
      assert.equal(outcome.result.closureObligationSatisfied, false);
    };
    await reached();

    const cases = [
      ['1 V2 receipt absent', program.consumptionPath, () => null, 'BOOTSTRAP_CLOSURE_V2_RECEIPT_ABSENT', program.consumptionPath],
      ['2a pair mismatched: V2 receipt transaction', program.consumptionPath, editJson((record) => ({ ...record, transactionId: 'OTHER_TX' })), 'BOOTSTRAP_RECEIPT_MISMATCH', 'transactionId'],
      ['2b pair mismatched: bootstrap receipt time', receiptPath, editJson((record) => ({ ...record, recordedAt: '2026-09-21T00:00:09.000Z' })), 'BOOTSTRAP_RECEIPT_MISMATCH', 'recordedAt'],
      ['3 receipt authorityId mismatch', receiptPath, editJson((record) => ({ ...record, bootstrapAuthorityId: 'OTHER_R1_BOOTSTRAP_AUTHORITY_R1' })), 'BOOTSTRAP_RECEIPT_MISMATCH', 'bootstrapAuthorityId'],
      ['4 bootstrap authority missing', authorityPath, () => null, 'BOOTSTRAP_AUTHORITY_ABSENT', authorityPath],
      ['5a bootstrap authority bytes tampered', authorityPath, (bytes) => Buffer.from(`${JSON.stringify(JSON.parse(bytes.toString('utf8')))}\n`), 'BOOTSTRAP_RECEIPT_MISMATCH', 'bootstrapAuthoritySha256'],
      ['5b bootstrap authority receipt path tampered', authorityPath, editJson((document) => ({ ...document, receiptPath: 'governance/historical-architecture/OTHER_R1_BOOTSTRAP_CONSUMPTION_R1.json' })), 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'receiptPath'],
      ['5c bootstrap authority maxUse tampered', authorityPath, editJson((document) => ({ ...document, maxUse: 2 })), 'BOOTSTRAP_E5_MAX_USE_INVALID', 2],
      ['6a V2 receipt certifies another digest', program.consumptionPath, editJson((record) => ({ ...record, cohort: record.cohort.map((entry) => (entry.path === receiptPath ? { ...entry, sha256: '0'.repeat(64) } : entry)) })), 'BOOTSTRAP_RECEIPT_V2_COHORT_DIGEST_MISMATCH', receiptPath],
      ['6b V2 receipt omits the bootstrap receipt', program.consumptionPath, editJson((record) => ({ ...record, cohort: record.cohort.filter((entry) => entry.path !== receiptPath) })), 'BOOTSTRAP_RECEIPT_NOT_CERTIFIED_BY_V2_COHORT', receiptPath],
      ['V2 authority missing', program.v2AuthorityPath, () => null, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_ABSENT', program.v2AuthorityPath],
      ['V2 authority tampered', program.v2AuthorityPath, (bytes) => Buffer.concat([bytes, Buffer.from(' ')]), 'BOOTSTRAP_CLOSURE_V2_COHORT_NOT_CERTIFIED', program.v2AuthorityPath],
      ['repair manifest missing', program.manifestPath, () => null, 'BOOTSTRAP_CLOSURE_MANIFEST_ABSENT', program.manifestPath],
      ['repair manifest tampered', program.manifestPath, (bytes) => Buffer.concat([bytes, Buffer.from(' ')]), 'BOOTSTRAP_CLOSURE_MANIFEST_DIGEST_MISMATCH', program.manifestPath]
    ];
    for (const [label, target, mutate, code, detail] of cases) {
      await withBytes(root, target, mutate, async (after) => {
        assertRefusedBeforeFastGate(await closeWithCounter(root, program.programId), code, detail, label);
        // Reported, never repaired: the broken link is exactly as the case left it.
        assert.deepEqual(exists(root, target) ? readBytes(root, target) : null, after, label);
      });
      assert.deepEqual(snapshot(), published, `${label}: restored`);
    }
    await reached();

    // 7. the coherent pair, a substitute Fast Gate that fails: one invocation, STOP, no retry.
    for (const failing of [countingFastGate('FAST_PATH_BLOCKED'), countingFastGate(null, 'LEDGER_NOT_VERIFIED')]) {
      const { result, calls } = await closeWithCounter(root, program.programId, { invokeFastGate: failing });
      assert.equal(calls, 1, 'exactly one invocation, no automatic retry');
      assert.equal(result.fastGateInvocations, 1);
      assert.equal(result.decision, STOP_BOOTSTRAP_REPAIR_FAILED_TO_RESTORE_TRUST);
      assert.equal(result.terminal, true);
      assert.equal(result.closureObligationSatisfied, false);
      assert.equal(result.retryAuthorized, false);
      assert.equal(result.successorAuthorized, false);
      assert.equal(result.rollbackAuthorized, false);
      assert.equal(result.secondBootstrapAuthorized, false);
      assert.equal(result.authorityConsumed, true);
    }

    // 8. a quoted Fast Gate result is refused with zero invocations, even on the coherent pair.
    for (const quote of [{ fastGateResult: { verdict: 'FAST_PATH_READY' } }, { fastGateVerdict: 'FAST_PATH_READY' }, { verdict: 'FAST_PATH_READY' }]) {
      const { result, calls } = await closeWithCounter(root, program.programId, quote);
      assert.equal(result.decision, 'CLOSURE_REQUIRES_REAL_FAST_GATE_INVOCATION');
      assert.equal(result.closureObligationSatisfied, false);
      assert.equal(result.fastGateInvocations, 0);
      assert.equal(calls, 0);
    }

    assert.deepEqual(snapshot(), published, 'the closure writes nothing');
    assert.equal(program.publish().decision, 'ALREADY_APPLIED');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

/* ======================================================================== */
/* CLOSURE: the V2 half of the pair is judged by the CANONICAL V2 law. Each  */
/* hostile below passes every bootstrap link, the cohort certification and   */
/* the pair; only the canonical V2 validators refuse it, before the Fast Gate.*/
/* ======================================================================== */

/** Replace several files for the duration of `body`, then restore every one of them. */
async function withFiles(root, replacements, body) {
  const before = new Map(Object.keys(replacements).map((item) => [item, exists(root, item) ? readBytes(root, item) : null]));
  try {
    for (const [item, bytes] of Object.entries(replacements)) writeBytes(root, item, bytes);
    return await body();
  } finally {
    for (const [item, bytes] of before) { if (bytes === null) remove(root, item); else writeBytes(root, item, bytes); }
  }
}

/** The canonical V2 law asked directly, in the order it can be asked: shape and manifest, then coherence. */
function canonicalV2Findings(authority, manifest, record, programId) {
  const shape = validatePostFreezeMaintenanceAuthorityV2Shape(authority);
  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, programId, authority.authorityPurpose);
  const found = [...shape.findings, ...manifestResult.findings];
  if (shape.valid && manifestResult.valid) validateConsumptionRecordCoherence(record, authority, manifest, found);
  return found;
}

test('R07 a published pair whose V2 half the canonical V2 law rejects never reaches the Fast Gate', async (t) => {
  const fixture = makeCanonicalFixture();
  try {
    const program = buildRepairProgram(fixture, { programId: 'FIXTURE_BOOTSTRAP_V2_LAW_R1' });
    const { root } = fixture;
    assert.equal(program.publish().decision, 'APPLIED');
    const { receiptPath, authorityPath, ownerDecisionPath } = program.paths;
    const watched = [receiptPath, program.consumptionPath, authorityPath, ownerDecisionPath, program.manifestPath, program.v2AuthorityPath, LEDGER_PATH];
    const snapshot = () => watched.map((item) => [item, exists(root, item) ? sha256(readBytes(root, item)) : null]);
    const published = snapshot();
    const load = (item) => JSON.parse(readBytes(root, item).toString('utf8'));
    const v2Receipt = load(program.consumptionPath);
    const v2Authority = load(program.v2AuthorityPath);
    const manifest = load(program.manifestPath);
    const certify = (record, item, bytes) => ({
      ...record, cohort: record.cohort.map((entry) => (entry.path === item ? { ...entry, sha256: sha256(bytes), byteLength: bytes.length } : entry))
    });

    // 7. Positive control: the publisher's pair is canonically valid, not merely
    // accepted, and it reaches the substitute Fast Gate exactly once.
    assert.deepEqual(canonicalV2Findings(v2Authority, manifest, v2Receipt, program.programId), []);
    const reached = async () => {
      const outcome = await closeWithCounter(root, program.programId);
      assert.equal(outcome.calls, 1);
      assert.equal(outcome.result.fastGateInvocations, 1);
      assert.equal(outcome.result.decision, 'CLOSURE_REQUIRES_REAL_FAST_GATE_INVOCATION');
      assert.equal(outcome.result.closureObligationSatisfied, false);
    };
    await reached();

    // A V2 receipt edit: nothing else binds the V2 receipt's own bytes.
    const receiptCase = (label, edit, code, detail) => {
      const record = edit(structuredClone(v2Receipt));
      return { label, code, detail, wrapper: 'BOOTSTRAP_CLOSURE_V2_RECEIPT_INCOHERENT', authority: v2Authority, manifest, record, files: { [program.consumptionPath]: jsonBytes(record) } };
    };
    // A V2 authority edit, re-certified in the V2 cohort.
    const authorityCase = (label, edit, code, detail) => {
      const authority = edit(structuredClone(v2Authority));
      const bytes = jsonBytes(authority);
      const record = certify(v2Receipt, program.v2AuthorityPath, bytes);
      return {
        label, code, detail, wrapper: 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_INVALID', authority, manifest, record,
        files: { [program.v2AuthorityPath]: bytes, [program.consumptionPath]: jsonBytes(record) }
      };
    };
    // A manifest edit, with every digest that binds the manifest resealed: the Owner
    // decision, the bootstrap authority, the bootstrap receipt, the V2 authority and
    // the V2 receipt with its cohort.
    const manifestCase = (label, edit, code, detail) => {
      const edited = edit(structuredClone(manifest));
      const manifestBytes = jsonBytes(edited);
      const manifestSha256 = sha256(manifestBytes);
      const decisionBytes = jsonBytes({ ...load(ownerDecisionPath), repairManifestSha256: manifestSha256 });
      const bootstrapAuthorityBytes = jsonBytes({ ...load(authorityPath), repairManifestSha256: manifestSha256, ownerDecisionSha256: sha256(decisionBytes) });
      const bootstrapReceiptBytes = jsonBytes({ ...load(receiptPath), repairManifestSha256: manifestSha256, bootstrapAuthoritySha256: sha256(bootstrapAuthorityBytes) });
      const authority = { ...v2Authority, authorizedPathManifestSha256: manifestSha256 };
      const authorityBytes = jsonBytes(authority);
      let record = { ...v2Receipt, manifestSha256 };
      for (const [item, bytes] of [[program.manifestPath, manifestBytes], [program.v2AuthorityPath, authorityBytes], [receiptPath, bootstrapReceiptBytes]]) record = certify(record, item, bytes);
      return {
        label, code, detail, wrapper: 'BOOTSTRAP_CLOSURE_V2_MANIFEST_INVALID', authority, manifest: edited, record,
        files: {
          [program.manifestPath]: manifestBytes, [ownerDecisionPath]: decisionBytes, [authorityPath]: bootstrapAuthorityBytes,
          [receiptPath]: bootstrapReceiptBytes, [program.v2AuthorityPath]: authorityBytes, [program.consumptionPath]: jsonBytes(record)
        }
      };
    };
    const withTarget = (record, edit) => ({ ...record, cohort: record.cohort.flatMap((entry) => (entry.path === program.targetPath ? edit(entry) : [entry])) });

    const cases = [
      receiptCase('1 V2 receipt with an unknown field', (record) => ({ ...record, unexpectedField: true }), 'CONSUMPTION_UNKNOWN_FIELD', 'unexpectedField'),
      receiptCase('2a V2 receipt documentKind invalid', (record) => ({ ...record, documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION_FORGED' }), 'CONSUMPTION_RECORD_INVALID'),
      receiptCase('2b V2 receipt schemaVersion unsupported', (record) => ({ ...record, schemaVersion: 3 }), 'CONSUMPTION_RECORD_INVALID'),
      receiptCase('2c V2 receipt downgraded to schemaVersion 1 to escape the cohort law', (record) => ({ ...record, schemaVersion: 1 }), 'CONSUMPTION_UNKNOWN_FIELD', 'cohort'),
      receiptCase('3 V2 receipt consumedUse invalid', (record) => ({ ...record, consumedUse: 2 }), 'CONSUMPTION_USE_INVALID'),
      authorityCase('4a V2 authority maxUse other than 1', (authority) => ({ ...authority, maxUse: 2 }), 'MAX_USE_INVALID'),
      authorityCase('4b V2 authority with an unknown field', (authority) => ({ ...authority, unexpectedField: true }), 'AUTHORITY_UNKNOWN_FIELD', 'unexpectedField'),
      manifestCase('5a repair manifest phase not a token', (document) => ({ ...document, paths: document.paths.map((entry) => (entry.path === program.targetPath ? { ...entry, phase: 'not a token' } : entry)) }), 'MANIFEST_PHASE_INVALID', program.targetPath),
      manifestCase('5b repair manifest with an unknown field', (document) => ({ ...document, unexpectedField: true }), 'MANIFEST_UNKNOWN_FIELD', 'unexpectedField'),
      receiptCase('6a V2 cohort omits the repair payload', (record) => withTarget(record, () => []), 'CONSUMPTION_COHORT_PATH_MISSING', program.targetPath),
      receiptCase('6b V2 cohort duplicates the repair payload', (record) => withTarget(record, (entry) => [entry, entry]), 'CONSUMPTION_COHORT_PATH_DUPLICATE', program.targetPath),
      receiptCase('6c V2 cohort metadata disagrees with the manifest', (record) => withTarget(record, (entry) => [{ ...entry, reason: 'another reason' }]), 'CONSUMPTION_COHORT_METADATA_MISMATCH', `${program.targetPath}:reason`),
      receiptCase('6d V2 cohort certifies an unauthorized path', (record) => ({ ...record, cohort: [...record.cohort, { path: 'governance/gates/GATE15/NOT_AUTHORIZED.json', sha256: 'e'.repeat(64), byteLength: 1, operation: 'CREATE', reason: 'not in the manifest', artifactClass: 'MAINTENANCE' }] }), 'CONSUMPTION_COHORT_UNEXPECTED_PATH', 'governance/gates/GATE15/NOT_AUTHORIZED.json'),
      receiptCase('6e V2 cohortPathCount disagrees with the manifest', (record) => ({ ...record, cohortPathCount: record.cohortPathCount + 1 }), 'CONSUMPTION_COHORT_COUNT_MISMATCH')
    ];
    for (const hostile of cases) {
      await t.test(hostile.label, async () => {
        await withFiles(root, hostile.files, async () => {
          // Every link the bootstrap law checks still holds: the pair is coherent and
          // the V2 cohort certifies the V2 authority and manifest actually on disk.
          const pair = validateMaintenanceRepairBootstrapReceiptPair({ root, v2Authority: hostile.authority, v2ConsumptionRecord: hostile.record });
          assert.equal(pair.coherent, true, `${hostile.label}: ${JSON.stringify(pair.findings)}`);
          for (const item of [program.v2AuthorityPath, program.manifestPath]) {
            const certified = hostile.record.cohort.find((entry) => entry.path === item);
            assert.equal(certified?.sha256, sha256(readBytes(root, item)), `${hostile.label}: ${item} certified`);
          }
          // ...and the canonical V2 law, asked directly, rejects it.
          const canonical = canonicalV2Findings(hostile.authority, hostile.manifest, hostile.record, program.programId);
          assert.ok(canonical.some((item) => item.code === hostile.code && (hostile.detail === undefined || item.detail === hostile.detail)), `${hostile.label}: ${JSON.stringify(canonical)}`);

          const outcome = await closeWithCounter(root, program.programId);
          assertRefusedBeforeFastGate(outcome, hostile.code, hostile.detail, hostile.label);
          assert.deepEqual(outcome.result.findings.map((item) => item.code).filter((code) => code.startsWith('BOOTSTRAP_')), [hostile.wrapper], `${hostile.label}: refused by the canonical V2 law alone`);
          // Reported, never repaired.
          for (const [item, bytes] of Object.entries(hostile.files)) assert.deepEqual(readBytes(root, item), bytes, `${hostile.label}: ${item}`);
        });
        assert.deepEqual(snapshot(), published, `${hostile.label}: restored`);
      });
    }
    await reached();

    assert.deepEqual(snapshot(), published, 'the closure writes nothing');
    assert.equal(program.publish().decision, 'ALREADY_APPLIED');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
