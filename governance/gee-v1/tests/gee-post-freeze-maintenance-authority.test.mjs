import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGeeMissionAuthoritySource,
} from '../adapters/gee-mission-authority-source.mjs';
import { isPathAuthorized } from '../core/work-unit-core.mjs';
import {
  evaluatePostFreezeMaintenanceAuthorityV2,
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  REQUIRED_PROHIBITED_OPERATIONS,
  sha256Hex,
  PHASE_AUTHORIZE_PROGRAM_APPLY
} from '../core/post-freeze-maintenance-authority.mjs';
import { verifyOwnerSignature } from '../core/release-authority.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const R7_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R7';
const R8_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R8';
const R9999_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R9999';
const HR_R2_ID = 'HISTORICAL_RECONCILIATION_PRIMITIVE_REPAIR_R2';
const HR_R2_FILE = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_HR_R2_R1.json';
const INTEGRATION_ID = 'GATE00_11_POST_RECONCILIATION_INTEGRATION_SYNC_R1';
const INTEGRATION_FILE = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE00_11_INTEGRATION_SYNC_R1.json';
const AUTHORITY_ROOT = 'governance/sources';
const EXPECTED_PATHS = [
  'governance/tools/validate-status-ledger.mjs',
  'governance/tests/historical-reconciliation-primitive.test.mjs'
];

function readAuthority(root = REPO_ROOT, fileName = HR_R2_FILE) {
  return JSON.parse(fs.readFileSync(path.join(root, AUTHORITY_ROOT, fileName), 'utf8'));
}

function tempAuthority(mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-maintenance-'));
  const authorityPath = path.join(root, AUTHORITY_ROOT, HR_R2_FILE);
  fs.mkdirSync(path.dirname(authorityPath), { recursive: true });
  fs.writeFileSync(authorityPath, JSON.stringify(mutator(readAuthority()), null, 2));
  return { root, source: createGeeMissionAuthoritySource(root) };
}

function tempAuthorities(authorities) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-maintenance-'));
  const sourceDir = path.join(root, AUTHORITY_ROOT);
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const [fileName, authority] of authorities) {
    fs.writeFileSync(path.join(sourceDir, fileName), JSON.stringify(authority, null, 2));
  }
  return { root, source: createGeeMissionAuthoritySource(root) };
}

function reservedAuthority(workUnitId) {
  return {
    ...readAuthority(),
    authorityId: `GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_RESERVED_${workUnitId.slice(-4)}`,
    workUnitId
  };
}

test('M01: existing R7 resolution remains normal revision resolution', () => {
  const result = createGeeMissionAuthoritySource(REPO_ROOT).resolveWorkUnitAuthority(R7_ID);
  assert.equal(result.contract.id, R7_ID);
  assert.equal(result.contract.version, 'R0007');
  assert.equal(result.authorityKind, undefined);
  assert.equal(result.proofs.EXECUTION_CONTRACT.state, 'PROVEN');
});

test('M02: R8 remains unknown and unauthorized', () => {
  assert.equal(createGeeMissionAuthoritySource(REPO_ROOT).resolveWorkUnitAuthority(R8_ID), null);
});

test('M03: unknown maintenance work unit remains unknown', () => {
  assert.equal(createGeeMissionAuthoritySource(REPO_ROOT).resolveWorkUnitAuthority('UNKNOWN_POST_FREEZE_MAINTENANCE'), null);
});

test('M04-M05: valid owner maintenance authority resolves the exact scope', () => {
  const result = createGeeMissionAuthoritySource(REPO_ROOT).resolveWorkUnitAuthority(HR_R2_ID);
  assert.equal(result.authorityKind, 'POST_FREEZE_MAINTENANCE');
  assert.deepEqual(result.authorizedPaths, EXPECTED_PATHS);
  assert.deepEqual(result.findings, []);
  assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
});

test('M06: a different maintenance work unit cannot reuse the authority', () => {
  const { root, source } = tempAuthority((authority) => authority);
  assert.equal(source.resolveWorkUnitAuthority('HISTORICAL_RECONCILIATION_PRIMITIVE_REPAIR_R3'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [name, mutation] of [
  ['M07 wrong owner authority class', (authority) => ({ ...authority, issuedBy: 'OTHER_OWNER', authorityClass: 'OTHER_AUTHORITY' })],
  ['M08 wildcard path', (authority) => ({ ...authority, authorizedPaths: ['governance/tools/*', ...EXPECTED_PATHS.slice(1)] })],
  ['M09 new GEE revision authorization', (authority) => ({ ...authority, newGeeRevisionAuthorized: true })],
  ['M10 Gate execution authorization', (authority) => ({ ...authority, gateExecutionAuthorized: true })]
]) {
  test(`${name} is rejected fail-closed`, () => {
    const { root, source } = tempAuthority(mutation);
    const result = source.resolveWorkUnitAuthority(HR_R2_ID);
    assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
    assert.deepEqual(result.authorizedPaths, []);
    assert.ok(result.findings.some((finding) => finding.code === 'POST_FREEZE_MAINTENANCE_AUTHORITY_INVALID'));
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('MA01-MA03: a second exact maintenance authority resolves its own work unit and scope', () => {
  const authority = { ...readAuthority(),
    authorityId: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_INTEGRATION_R1',
    workUnitId: 'GATE00_11_POST_RECONCILIATION_INTEGRATION_SYNC_R1',
    reason: 'integration synchronization',
    defects: ['POST_RECONCILIATION_GENERATED_STATE_DRIFT'],
    authorizedPaths: ['governance/state/generated/GATE_STATUS_SNAPSHOT.json']
  };
  const { root, source } = tempAuthorities([[HR_R2_FILE, readAuthority()], ['GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_INTEGRATION_R1.json', authority]]);
  const result = source.resolveWorkUnitAuthority(authority.workUnitId);
  assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
  assert.deepEqual(result.authorizedPaths, authority.authorizedPaths);
  fs.rmSync(root, { recursive: true, force: true });
});

test('MA04-MA05: unknown work remains blocked and duplicate work-unit authorities conflict', () => {
  const base = readAuthority();
  const duplicate = { ...base, authorityId: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_DUPLICATE_R1' };
  const { root, source } = tempAuthorities([[HR_R2_FILE, base], ['GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_DUPLICATE_R1.json', duplicate]]);
  assert.equal(createGeeMissionAuthoritySource(root).resolveWorkUnitAuthority('UNKNOWN_POST_FREEZE_MAINTENANCE'), null);
  const result = source.resolveWorkUnitAuthority(HR_R2_ID);
  assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
  assert.ok(result.findings.some((finding) => finding.code === 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONFLICT'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('MA06: wildcard, traversal and absolute paths are rejected', () => {
  for (const badPath of ['governance/**', 'governance/../outside.json', 'C:\\outside.json', '/outside.json']) {
    const { root, source } = tempAuthority((authority) => ({ ...authority, authorizedPaths: [badPath] }));
    const result = source.resolveWorkUnitAuthority(HR_R2_ID);
    assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED', badPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MA07: wrong PROJECT_OWNER or authority class is rejected', () => {
  const { root, source } = tempAuthority((authority) => ({ ...authority, issuedBy: 'OTHER_OWNER', authorityClass: 'OTHER_AUTHORITY' }));
  const result = source.resolveWorkUnitAuthority(HR_R2_ID);
  assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
  fs.rmSync(root, { recursive: true, force: true });
});

test('MA08-MA09: R8 remains unknown and normal R7 revision resolution is unchanged', () => {
  const source = createGeeMissionAuthoritySource(REPO_ROOT);
  assert.equal(source.resolveWorkUnitAuthority(R8_ID), null);
  const result = source.resolveWorkUnitAuthority(R7_ID);
  assert.equal(result.contract.id, R7_ID);
  assert.equal(result.proofs.EXECUTION_CONTRACT.state, 'PROVEN');
});

test('MA10-MA13: exact files and explicit directories have bounded path semantics', () => {
  assert.equal(isPathAuthorized(['governance/active/ACTIVE_GATE.json'], 'governance/active/ACTIVE_GATE.json'), true);
  assert.equal(isPathAuthorized(['governance/active/ACTIVE_GATE.json'], 'governance/active/ACTIVE_GATE.json.evil'), false);
  assert.equal(isPathAuthorized(['governance/foo/'], 'governance/foobar/file.json'), false);
  assert.equal(isPathAuthorized(['governance/foo/'], 'governance/foo/file.json'), true);
});

for (const workUnitId of [R7_ID, R8_ID, R9999_ID]) {
  test(`MA14-MA16: maintenance claim of ${workUnitId} is blocked`, () => {
    const fileName = `GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_${workUnitId}_R1.json`;
    const { root, source } = tempAuthorities([[fileName, reservedAuthority(workUnitId)]]);
    const result = source.resolveWorkUnitAuthority(workUnitId);
    assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
    assert.deepEqual(result.authorizedPaths, []);
    assert.ok(result.findings.some((finding) => finding.code === 'POST_FREEZE_MAINTENANCE_RESERVED_WORK_UNIT_ID'));
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('MA17-MA18: legitimate HR_R2 and integration maintenance authorities remain executable', () => {
  const source = createGeeMissionAuthoritySource(REPO_ROOT);
  assert.equal(source.resolveWorkUnitAuthority(HR_R2_ID).proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
  assert.equal(source.resolveWorkUnitAuthority(INTEGRATION_ID).proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
});

test('MA19: integration authority authorizes only exact cohort files', () => {
  const authority = readAuthority(REPO_ROOT, INTEGRATION_FILE);
  const result = createGeeMissionAuthoritySource(REPO_ROOT).resolveWorkUnitAuthority(INTEGRATION_ID);
  assert.deepEqual(result.authorizedPaths, authority.authorizedPaths);
  for (const authorizedPath of authority.authorizedPaths) {
    assert.equal(isPathAuthorized(authority.authorizedPaths, authorizedPath), true, authorizedPath);
    assert.equal(isPathAuthorized(authority.authorizedPaths, `${authorizedPath}.evil`), false, `${authorizedPath}.evil`);
  }
  assert.equal(isPathAuthorized(authority.authorizedPaths, 'governance/state/generated-evidence/GATE_STATUS_SNAPSHOT.json'), false);
});

// ---------------------------------------------------------------------------
// H0A-S — LOCAL_EXPLICIT_AUTHORITY (schema V2).
//
// V2 no longer carries or checks a signature. Everything below therefore proves
// the replacement property: authority is the exact agreement between the
// document and the live repository, and any single divergence blocks.
// ---------------------------------------------------------------------------

function makeV2Fixture() {
  const manifest = {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORIZED_PATH_MANIFEST',
    schemaVersion: 1,
    manifestId: 'SYNTHETIC_MAINTENANCE_PATHS_R1',
    programId: 'SYNTHETIC_GOVERNANCE_PROGRAM_R1',
    paths: [
      { path: 'synthetic/governance/state.json', operation: 'MODIFY', phase: 'H1', reason: 'fixture', artifactClass: 'STATE_SEAL_HARDENING' },
      { path: 'synthetic/governance/replay.mjs', operation: 'CREATE', phase: 'H2', reason: 'fixture', artifactClass: 'TEST_AND_REPLAY_INFRASTRUCTURE' }
    ]
  };
  const manifestSha256 = sha256Hex(Buffer.from(JSON.stringify(manifest), 'utf8'));
  const authority = {
    document: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY',
    schemaVersion: 2,
    authorityId: 'SYNTHETIC_GOVERNANCE_PROGRAM_AUTHORITY_R1',
    authorityClass: 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY',
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    createdAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-12-31T23:59:59.000Z',
    targetSystem: 'PROJECT_GOVERNANCE',
    programId: manifest.programId,
    resumePoint: 'CP-H0A-S',
    maxUse: 1,
    preState: {
      baseHead: '1'.repeat(40),
      ledgerEventCount: 58,
      ledgerPrefixSha256: '2'.repeat(64),
      gateId: 'GATEX',
      gateStatus: 'IN_PROGRESS',
      stateRevision: 'R0002',
      contractRevision: 'R0001',
      activeGate: 'GATEY',
      R8ExpectedAbsent: true
    },
    authorizedPathManifestPath: 'synthetic/governance/AUTHORIZED_PATHS.json',
    authorizedPathManifestSha256: manifestSha256,
    authorizedOperationClasses: ['STATE_SEAL_HARDENING', 'TEST_AND_REPLAY_INFRASTRUCTURE'],
    commitPolicy: {
      maxCommitCount: 1,
      allowedGitOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'],
      commitMessage: 'governance: synthetic program',
      thirdCommitAuthorized: false
    },
    pushAuthorized: false,
    authorityPredecessor: null,
    authorityHeadBinding: { mode: 'BASE_HEAD', baseHead: '1'.repeat(40) },
    consumptionRecordPath: 'synthetic/governance/CONSUMPTION.json',
    prohibitedOperations: [...REQUIRED_PROHIBITED_OPERATIONS]
  };
  const observed = {
    baseHead: authority.preState.baseHead,
    ledgerEventCount: authority.preState.ledgerEventCount,
    ledgerPrefixSha256: authority.preState.ledgerPrefixSha256,
    gateId: authority.preState.gateId,
    gateStatus: authority.preState.gateStatus,
    stateRevision: authority.preState.stateRevision,
    contractRevision: authority.preState.contractRevision,
    activeGate: authority.preState.activeGate,
    R8Absent: true,
    manifestSha256,
    authorityPredecessorSha256: null,
    requestedPaths: manifest.paths.map((entry) => entry.path),
    requestedOperationClasses: manifest.paths.map((entry) => entry.artifactClass)
  };
  return { authority, manifest, observed, now: new Date('2026-08-13T00:02:00.000Z') };
}

test('LA01: a valid local V2 authority carries no key material and still authorizes', () => {
  const fixture = makeV2Fixture();
  for (const field of ['ownerKeyId', 'signatureAlgorithm', 'signature', 'privateKeyPath', 'externalSigner']) {
    assert.equal(Object.hasOwn(fixture.authority, field), false, field);
  }
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.authorityMode, POST_FREEZE_MAINTENANCE_AUTHORITY_MODE);
  assert.equal(result.programAuthorized, true);
});

test('LA02: HEAD, ledger identity and manifest digest are what the authority binds', () => {
  // Each of the three, alone, is load-bearing: flip one and authority is gone.
  for (const drift of [
    (f) => { f.observed.baseHead = '9'.repeat(40); },
    (f) => { f.observed.ledgerEventCount = 57; },
    (f) => { f.observed.ledgerPrefixSha256 = '9'.repeat(64); },
    (f) => { f.observed.manifestSha256 = '9'.repeat(64); }
  ]) {
    const fixture = makeV2Fixture();
    assert.equal(evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY }).decision, 'AUTHORIZED');
    drift(fixture);
    assert.equal(evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY }).decision, 'BLOCKED');
  }
});

test('LA03: only the literal manifest paths are authorized', () => {
  const fixture = makeV2Fixture();
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.deepEqual(result.authorizedPaths, fixture.manifest.paths.map((entry) => entry.path));
  for (const authorizedPath of result.authorizedPaths) {
    assert.equal(isPathAuthorized(result.authorizedPaths, authorizedPath), true, authorizedPath);
    assert.equal(isPathAuthorized(result.authorizedPaths, `${authorizedPath}.evil`), false, `${authorizedPath}.evil`);
  }
});

test('LA04: only the literal authorized operation classes are granted', () => {
  const fixture = makeV2Fixture();
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.deepEqual(result.authorizedOperationClasses, fixture.authority.authorizedOperationClasses);
  assert.equal(result.authorizedOperationClasses.includes('START'), false);
});

test('LA05: V1 historical maintenance authorities keep their original semantics', () => {
  const source = createGeeMissionAuthoritySource(REPO_ROOT);
  for (const workUnitId of [HR_R2_ID, INTEGRATION_ID]) {
    const result = source.resolveWorkUnitAuthority(workUnitId);
    assert.equal(result.authorityKind, 'POST_FREEZE_MAINTENANCE', workUnitId);
    assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN', workUnitId);
  }
  // V1 never carried a signature and still must not require one.
  const v1 = readAuthority();
  assert.equal(v1.schemaVersion, 1);
  assert.equal(Object.hasOwn(v1, 'signature'), false);
});

test('LA06: historical owner-signed authorities still verify against the retained public key', () => {
  const ownerKey = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json'), 'utf8'));
  for (const historical of [
    'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_AUTHORIZATION_AUTHORITY.json',
    'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json'
  ]) {
    const document = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, historical), 'utf8'));
    assert.equal(verifyOwnerSignature(document, ownerKey).verified, true, historical);
    // Retained material verifies the original bytes only — never a rewritten one.
    assert.equal(verifyOwnerSignature({ ...document, gateId: 'GATE15' }, ownerKey).verified, false, historical);
  }
});

for (const [name, mutate] of [
  ['LAH01 wrong HEAD', (f) => { f.observed.baseHead = '3'.repeat(40); }],
  ['LAH02 wrong ledger count', (f) => { f.observed.ledgerEventCount = 59; }],
  ['LAH03 wrong ledger SHA', (f) => { f.observed.ledgerPrefixSha256 = '4'.repeat(64); }],
  ['LAH04 wrong Gate', (f) => { f.observed.gateId = 'GATEZ'; }],
  ['LAH05 wrong state revision', (f) => { f.observed.stateRevision = 'R0003'; }],
  ['LAH06 wrong contract revision', (f) => { f.observed.contractRevision = 'R0002'; }],
  ['LAH07 wrong ACTIVE_GATE', (f) => { f.observed.activeGate = 'GATEZ'; }],
  ['LAH08 R8 unexpectedly present', (f) => { f.observed.R8Absent = false; }],
  ['LAH09 path absent from manifest', (f) => { f.observed.requestedPaths.push('synthetic/outside.json'); }],
  ['LAH10 wildcard path', (f) => { f.manifest.paths[0].path = 'synthetic/**'; }],
  ['LAH11 unauthorized operation', (f) => { f.observed.requestedOperationClasses.push('CONTRACT_R0002_CREATION'); }],
  ['LAH12 maxUse not 1', (f) => { f.authority.maxUse = 2; }],
  ['LAH13 authority reused', (f) => { f.consumptionRecord = { consumedUse: 1 }; }],
  ['LAH14 pushAuthorized true', (f) => { f.authority.pushAuthorized = true; }],
  ['LAH15 manifest altered after authority creation', (f) => { f.manifest.paths.push({ path: 'synthetic/extra.json', operation: 'CREATE', phase: 'H1', reason: 'smuggled', artifactClass: 'STATE_SEAL_HARDENING' }); f.observed.manifestSha256 = sha256Hex(Buffer.from(JSON.stringify(f.manifest), 'utf8')); }],
  ['LAH16 modify ledger events 1-58', (f) => { f.observed.requestedPaths.push('governance/state/GATE_STATUS_LEDGER.ndjson'); }],
  ['LAH17 modify frozen R0001/R0002', (f) => { f.observed.requestedPaths.push('governance/gates/GATE14/state/revisions/R0001/STATE_SEAL.json', 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json'); }],
  ['LAH18 modify contract R0001', (f) => { f.observed.requestedPaths.push('governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json'); }],
  ['LAH19 attempt START', (f) => { f.authority.authorizedOperationClasses.push('START'); f.observed.requestedOperationClasses.push('START'); }],
  ['LAH20 attempt closure', (f) => { f.authority.authorizedOperationClasses.push('AGENT_CLOSURE'); f.observed.requestedOperationClasses.push('AGENT_CLOSURE'); }],
  ['LAH21 attempt ACTIVE_GATE succession', (f) => { f.authority.authorizedOperationClasses.push('ACTIVE_GATE_SWITCH'); f.observed.requestedOperationClasses.push('ACTIVE_GATE_SWITCH'); }],
  ['LAH22 attempt R8', (f) => { f.authority.authorizedOperationClasses.push('GEE_R8'); f.observed.requestedOperationClasses.push('GEE_R8'); }],
  ['LAH23 third commit', (f) => { f.authority.commitPolicy.thirdCommitAuthorized = true; }],
  ['LAH24 expired authority', (f) => { f.now = new Date('2027-01-01T00:00:00.000Z'); }],
  ['LAH25 wrong authority mode', (f) => { f.authority.authorityMode = 'OWNER_SIGNED_AUTHORITY'; }],
  ['LAH26 signature material smuggled in', (f) => { f.authority.ownerKeyId = 'WHEEL-OWNER-RELEASE-2D441D1E'; f.authority.signature = 'AAAA'; }],
  ['LAH27 manifest claims another program', (f) => { f.manifest.programId = 'OTHER_PROGRAM_R1'; }]
]) {
  test(`${name} is blocked fail-closed`, () => {
    const fixture = makeV2Fixture();
    mutate(fixture);
    const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
    assert.equal(result.decision, 'BLOCKED');
    assert.deepEqual(result.authorizedPaths, []);
    assert.deepEqual(result.authorizedOperationClasses, []);
  });
}

test('LAH26b: an authority carrying signature fields is rejected, never silently accepted', () => {
  const fixture = makeV2Fixture();
  fixture.authority.signature = 'AAAA';
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.ok(result.findings.some((f) => f.code === 'SIGNATURE_MATERIAL_NOT_PERMITTED' && f.detail === 'signature'));
});

test('LA07: the adapter resolves a local V2 authority with no owner key present at all', () => {
  const fixture = makeV2Fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-maintenance-v2-'));
  const sourceRoot = path.join(root, 'governance', 'sources');
  const manifestPath = path.join(root, ...fixture.authority.authorizedPathManifestPath.split('/'));
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_SYNTHETIC_V2_R1.json'), JSON.stringify(fixture.authority, null, 2));
  fs.writeFileSync(manifestPath, JSON.stringify(fixture.manifest));
  assert.equal(fs.existsSync(path.join(root, 'governance', 'authority', 'PROJECT_OWNER_RELEASE_KEY.json')), false);
  const source = createGeeMissionAuthoritySource(root, { maintenanceObservationProvider: () => fixture.observed });
  const result = source.resolveWorkUnitAuthority(fixture.authority.programId);
  assert.deepEqual(result.findings, []);
  assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
  assert.deepEqual(result.authorizedPaths, fixture.manifest.paths.map((entry) => entry.path));
  fs.rmSync(root, { recursive: true, force: true });
});
