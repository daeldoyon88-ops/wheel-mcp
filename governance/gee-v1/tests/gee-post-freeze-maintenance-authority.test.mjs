import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  PHASE_AUTHORIZE_PROGRAM_APPLY,
  PHASE_VERIFY_PROGRAM_CONSUMPTION
} from '../core/post-freeze-maintenance-authority.mjs';
import { collectClosedStateSealMembers } from '../core/sealed-state-evidence.mjs';
import { verifyOwnerSignature } from '../core/release-authority.mjs';
import { resolveCanonicalLedgerPrefix } from '../../tools/validate-status-ledger.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const R7_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R7';
const R8_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R8';
const R9999_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R9999';
const HR_R2_ID = 'HISTORICAL_RECONCILIATION_PRIMITIVE_REPAIR_R2';
const HR_R2_FILE = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_HR_R2_R1.json';
const INTEGRATION_ID = 'GATE00_11_POST_RECONCILIATION_INTEGRATION_SYNC_R1';
const INTEGRATION_FILE = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE00_11_INTEGRATION_SYNC_R1.json';
const GENERIC_MAINTENANCE_ID = 'WHEEL_GENERIC_MAINTENANCE_ADMISSION_AND_PRESTATE_REPLAY_R1';
const LEDGER_PATH = path.join(REPO_ROOT, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
const GATE16_PREFIX_EVENT_COUNT = 65;
const GATE16_PREFIX_SHA256 = '0607f8a0725f20406013905904f3a8ea1c1772f59c034af395a066dc4afa5f41';
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

test('MA20: arbitrary maintenance mission identity is discovered without an allowlist entry', () => {
  const fixture = makeV2Fixture();
  fixture.manifest.programId = GENERIC_MAINTENANCE_ID;
  fixture.authority = {
    ...fixture.authority,
    authorityId: `${GENERIC_MAINTENANCE_ID}_AUTHORITY_R1`,
    programId: GENERIC_MAINTENANCE_ID,
    authorizedPathManifestSha256: sha256Hex(Buffer.from(JSON.stringify(fixture.manifest), 'utf8'))
  };
  fixture.observed.manifestSha256 = fixture.authority.authorizedPathManifestSha256;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-arbitrary-maintenance-'));
  const authorityDir = path.join(root, AUTHORITY_ROOT);
  const manifestPath = path.join(root, 'synthetic', 'governance', 'AUTHORIZED_PATHS.json');
  fs.mkdirSync(authorityDir, { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(fixture.manifest, null, 2));
  fs.writeFileSync(path.join(authorityDir, 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GENERIC_R1.json'), JSON.stringify(fixture.authority, null, 2));
  const source = createGeeMissionAuthoritySource(root, { maintenanceObservationProvider: () => fixture.observed });
  assert.equal(source.listWorkUnitIds().includes(GENERIC_MAINTENANCE_ID), true);
  const result = source.resolveWorkUnitAuthority(GENERIC_MAINTENANCE_ID);
  assert.equal(result.workUnitClass, 'MAINTENANCE');
  assert.equal(result.authorityKind, 'POST_FREEZE_MAINTENANCE_V2');
  assert.equal(result.proofs.WORK_UNIT_EXECUTABLE.state, 'PROVEN');
  assert.deepEqual(result.findings, []);
  fs.rmSync(root, { recursive: true, force: true });
});

function withTemporaryLedger(bytes, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-ledger-prefix-'));
  const ledgerPath = path.join(root, 'GATE_STATUS_LEDGER.ndjson');
  fs.writeFileSync(ledgerPath, bytes);
  try {
    return callback(ledgerPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function ledgerLines() {
  return fs.readFileSync(LEDGER_PATH, 'utf8').trimEnd().split('\n');
}

function ledgerSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('MA21: canonical prestate prefix accepts the real suffix and a future N+k identity', () => {
  const currentBytes = fs.readFileSync(LEDGER_PATH);
  const prefix = resolveCanonicalLedgerPrefix({
    ledgerPath: LEDGER_PATH,
    eventCount: GATE16_PREFIX_EVENT_COUNT,
    expectedSha256: GATE16_PREFIX_SHA256
  });
  assert.equal(prefix.valid, true, JSON.stringify(prefix.findings));
  assert.equal(prefix.availableEventCount, 69);
  assert.equal(prefix.prefixSha256, GATE16_PREFIX_SHA256);
  assert.equal(prefix.prefixBytes.length < currentBytes.length, true);

  const future = resolveCanonicalLedgerPrefix({
    ledgerPath: LEDGER_PATH,
    eventCount: 69,
    expectedSha256: ledgerSha256(currentBytes)
  });
  assert.equal(future.valid, true, JSON.stringify(future.findings));
  assert.equal(future.availableEventCount, 69);
  assert.equal(future.prefixBytes.equals(currentBytes), true);
});

test('MA22: mutated historical prefix blocks on prefix identity mismatch', () => {
  const mutated = Buffer.from(fs.readFileSync(LEDGER_PATH, 'utf8').replace('GENESIS_IMPORT_GATE00', 'GENESIS_IMPORT_GATE0X'), 'utf8');
  withTemporaryLedger(mutated, (ledgerPath) => {
    const result = resolveCanonicalLedgerPrefix({ ledgerPath, eventCount: GATE16_PREFIX_EVENT_COUNT, expectedSha256: GATE16_PREFIX_SHA256 });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === 'PRESTATE_PREFIX_SHA_MISMATCH'));
  });
});

test('MA23: shortened history blocks when the requested prefix is unavailable', () => {
  const shortened = Buffer.from(`${ledgerLines().slice(0, 64).join('\n')}\n`, 'utf8');
  withTemporaryLedger(shortened, (ledgerPath) => {
    const result = resolveCanonicalLedgerPrefix({ ledgerPath, eventCount: GATE16_PREFIX_EVENT_COUNT, expectedSha256: GATE16_PREFIX_SHA256 });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === 'PRESTATE_LEDGER_TOO_SHORT'));
    assert.equal(result.prefixBytes, null);
  });
});

test('MA24: malformed ordinal and previous-event chain block inside the prefix', () => {
  const lines = ledgerLines();
  const ordinalMutation = JSON.parse(lines[1]);
  ordinalMutation.ordinal = 999;
  const ordinalBytes = Buffer.from(`${[lines[0], JSON.stringify(ordinalMutation), ...lines.slice(2)].join('\n')}\n`, 'utf8');
  withTemporaryLedger(ordinalBytes, (ledgerPath) => {
    const result = resolveCanonicalLedgerPrefix({ ledgerPath, eventCount: GATE16_PREFIX_EVENT_COUNT, expectedSha256: GATE16_PREFIX_SHA256 });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === 'PRESTATE_ORDINAL_INVALID'));
  });

  const chainMutation = JSON.parse(lines[1]);
  chainMutation.previousEventSha256 = '0'.repeat(64);
  const chainBytes = Buffer.from(`${[lines[0], JSON.stringify(chainMutation), ...lines.slice(2)].join('\n')}\n`, 'utf8');
  withTemporaryLedger(chainBytes, (ledgerPath) => {
    const result = resolveCanonicalLedgerPrefix({ ledgerPath, eventCount: GATE16_PREFIX_EVENT_COUNT, expectedSha256: GATE16_PREFIX_SHA256 });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === 'PRESTATE_PREVIOUS_EVENT_CHAIN_INVALID'));
  });
});

test('MA25: malformed canonical prestate identity blocks closed', () => {
  const result = resolveCanonicalLedgerPrefix({ ledgerPath: LEDGER_PATH, eventCount: 0, expectedSha256: 'A'.repeat(64) });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((finding) => finding.code === 'PRESTATE_EVENT_COUNT_INVALID'));
  assert.ok(result.findings.some((finding) => finding.code === 'PRESTATE_EXPECTED_SHA_INVALID'));
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
    requestedOperationClasses: manifest.paths.map((entry) => entry.artifactClass),
    closedStateSealMembers: [],
    closedStateSealFindings: []
  };
  return { authority, manifest, observed, now: new Date('2026-08-13T00:02:00.000Z') };
}

function makeV2ConsumptionFixture() {
  const fixture = makeV2Fixture();
  fixture.manifest.paths.push({
    path: fixture.authority.consumptionRecordPath,
    operation: 'CREATE',
    phase: 'H3',
    reason: 'single-use receipt',
    artifactClass: 'TEST_AND_REPLAY_INFRASTRUCTURE'
  });
  fixture.authority.authorizedPathManifestSha256 = sha256Hex(Buffer.from(JSON.stringify(fixture.manifest), 'utf8'));
  fixture.observed.manifestSha256 = fixture.authority.authorizedPathManifestSha256;
  fixture.observed.requestedPaths = fixture.manifest.paths.map((entry) => entry.path);
  fixture.observed.requestedOperationClasses = fixture.manifest.paths.map((entry) => entry.artifactClass);
  const hashes = ['a'.repeat(64), 'b'.repeat(64)];
  const byteLengths = [101, 202];
  const cohort = fixture.manifest.paths.slice(0, 2).map((entry, index) => ({
    path: entry.path,
    sha256: hashes[index],
    byteLength: byteLengths[index],
    operation: entry.operation,
    reason: entry.reason,
    artifactClass: entry.artifactClass
  }));
  fixture.observed.consumptionCohort = cohort.map(({ path: cohortPath, sha256, byteLength }) => ({ path: cohortPath, sha256, byteLength }));
  fixture.consumptionRecord = {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION',
    schemaVersion: 2,
    authorityId: fixture.authority.authorityId,
    programId: fixture.authority.programId,
    manifestSha256: fixture.authority.authorizedPathManifestSha256,
    baseHead: fixture.authority.preState.baseHead,
    consumedUse: 1,
    transactionId: 'SYNTHETIC_EXACT_COHORT_TRANSACTION_R1',
    recordedAt: '2026-08-13T00:01:00.000Z',
    commitMessage: fixture.authority.commitPolicy.commitMessage,
    cohortSelfExclusion: {
      path: fixture.authority.consumptionRecordPath,
      reason: 'The receipt cannot digest its own bytes; the enclosing commit binds it.'
    },
    cohortPathCount: fixture.manifest.paths.length,
    cohort
  };
  return fixture;
}

test('MA26: a sealed member path is blocked generically before maintenance apply', () => {
  const fixture = makeV2Fixture();
  const sealedPath = 'governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json';
  fixture.manifest.paths[0] = {
    ...fixture.manifest.paths[0],
    path: sealedPath,
    operation: 'MODIFY'
  };
  fixture.authority.authorizedPathManifestSha256 = sha256Hex(Buffer.from(JSON.stringify(fixture.manifest), 'utf8'));
  fixture.observed.manifestSha256 = fixture.authority.authorizedPathManifestSha256;
  fixture.observed.requestedPaths = fixture.manifest.paths.map((entry) => entry.path);
  fixture.observed.closedStateSealMembers = [{ repoRelativePath: sealedPath, sha256: 'a'.repeat(64), byteLength: 1 }];
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'POST_FREEZE_MAINTENANCE_SEALED_MEMBER_MUTATION'));
});

test('MA27: the generic closed-seal inventory discovers closed revision members without a gate allowlist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-closed-seal-inventory-'));
  const sealPath = path.join(root, 'governance', 'gates', 'SYNTHETIC_GATE', 'state', 'revisions', 'R0001', 'STATE_SEAL.json');
  fs.mkdirSync(path.dirname(sealPath), { recursive: true });
  fs.writeFileSync(sealPath, JSON.stringify({
    gateId: 'SYNTHETIC_GATE',
    stateRevision: 'R0001',
    sealedMembers: [{ repoRelativePath: 'synthetic/closed-evidence.json', sha256: 'b'.repeat(64), byteLength: 2 }],
    payload: { executionStatus: 'COMPLETE_CONFIRMED' }
  }));
  const inventory = collectClosedStateSealMembers(root);
  assert.deepEqual(inventory.findings, []);
  assert.deepEqual(inventory.members.map((member) => member.repoRelativePath), ['synthetic/closed-evidence.json']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('MA28: an invalid closed-seal inventory blocks maintenance fail-closed', () => {
  const fixture = makeV2Fixture();
  fixture.observed.closedStateSealFindings = [{ code: 'CLOSED_STATE_SEAL_MEMBER_INVALID', detail: 'synthetic' }];
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'SEALED_EVIDENCE_IMMUTABILITY_INVENTORY_INVALID'));
});

test('LA-C01: schema V2 consumption binds the exact authorized cohort bytes with deterministic self-exclusion', () => {
  const fixture = makeV2ConsumptionFixture();
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_VERIFY_PROGRAM_CONSUMPTION });
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.consumed, true);
});

for (const [name, mutate, expectedCode] of [
  ['LA-C02 mutated hash', (f) => { f.consumptionRecord.cohort[0].sha256 = 'c'.repeat(64); }, 'CONSUMPTION_COHORT_SHA_MISMATCH'],
  ['LA-C03 wrong byteLength', (f) => { f.consumptionRecord.cohort[0].byteLength += 1; }, 'CONSUMPTION_COHORT_BYTE_LENGTH_MISMATCH'],
  ['LA-C04 missing path', (f) => { f.consumptionRecord.cohort.pop(); }, 'CONSUMPTION_COHORT_PATH_MISSING'],
  ['LA-C05 unexpected path', (f) => { f.consumptionRecord.cohort.push({ ...f.consumptionRecord.cohort[0], path: 'synthetic/unexpected.json' }); }, 'CONSUMPTION_COHORT_UNEXPECTED_PATH'],
  ['LA-C06 wrong authority', (f) => { f.consumptionRecord.authorityId = 'OTHER_AUTHORITY_R1'; }, 'CONSUMPTION_AUTHORITY_MISMATCH'],
  ['LA-C07 wrong baseHead', (f) => { f.consumptionRecord.baseHead = '9'.repeat(40); }, 'CONSUMPTION_BASE_HEAD_MISMATCH'],
  ['LA-C08 non-deterministic self-exclusion', (f) => { f.consumptionRecord.cohortSelfExclusion.path = f.consumptionRecord.cohort[0].path; }, 'CONSUMPTION_SELF_EXCLUSION_INVALID']
]) {
  test(`${name} blocks exact-byte consumption`, () => {
    const fixture = makeV2ConsumptionFixture();
    mutate(fixture);
    const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_VERIFY_PROGRAM_CONSUMPTION });
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(result.findings.some((finding) => finding.code === expectedCode), JSON.stringify(result.findings));
  });
}

test('LA-C09: a present V2 receipt makes the single-use authority unavailable for apply', () => {
  const fixture = makeV2ConsumptionFixture();
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'AUTHORITY_ALREADY_CONSUMED'));
});

function makeFinalClosureFixture() {
  const fixture = makeV2Fixture();
  fixture.authority = {
    ...fixture.authority,
    authorityPurpose: 'GATE_FINAL_CLOSURE',
    authorizedOperationClasses: ['AGENT_CLOSURE']
  };
  fixture.manifest = {
    ...fixture.manifest,
    paths: fixture.manifest.paths.map((entry) => ({
      ...entry,
      phase: 'AGENT_CLOSURE',
      artifactClass: 'AGENT_CLOSURE'
    }))
  };
  fixture.authority.authorizedPathManifestSha256 = sha256Hex(Buffer.from(JSON.stringify(fixture.manifest), 'utf8'));
  fixture.observed.manifestSha256 = fixture.authority.authorizedPathManifestSha256;
  fixture.observed.requestedOperationClasses = ['AGENT_CLOSURE'];
  return fixture;
}

function makeExternalConfirmationFixture() {
  const fixture = makeV2Fixture();
  fixture.authority.preState = {
    ...fixture.authority.preState,
    baseHead: '2d7df54ac3e270c76b0681884a3c2a158b02dbfd',
    ledgerEventCount: 60,
    ledgerPrefixSha256: 'ecb870c2ad3f567ab9655d4248fb87115badc0eec4facae811d89e2316dcbb5f',
    gateId: 'GATE14',
    gateStatus: 'COMPLETE_AGENT',
    stateRevision: 'R0004',
    contractRevision: 'R0002',
    activeGate: 'GATE13'
  };
  fixture.authority.authorityHeadBinding = { mode: 'BASE_HEAD', baseHead: fixture.authority.preState.baseHead };
  const reportPath = 'synthetic/independent/EXTERNAL_REINSPECTION_REPORT.json';
  const reportSha256 = 'a'.repeat(64);
  fixture.authority = {
    ...fixture.authority,
    authorityPurpose: 'GATE_EXTERNAL_CONFIRMATION',
    externalReinspectionReportPath: reportPath,
    externalReinspectionReportSha256: reportSha256,
    authorizedOperationClasses: ['EXTERNAL_CONFIRMATION']
  };
  fixture.manifest = {
    ...fixture.manifest,
    paths: [
      { path: reportPath, operation: 'CREATE', phase: 'EXTERNAL_CONFIRMATION', reason: 'independent report', artifactClass: 'EXTERNAL_CONFIRMATION' },
      { path: 'synthetic/independent/CLOSURE_RECORD.json', operation: 'CREATE', phase: 'EXTERNAL_CONFIRMATION', reason: 'confirmation record', artifactClass: 'EXTERNAL_CONFIRMATION' }
    ]
  };
  fixture.authority.authorizedPathManifestSha256 = sha256Hex(Buffer.from(JSON.stringify(fixture.manifest), 'utf8'));
  fixture.observed.baseHead = fixture.authority.preState.baseHead;
  fixture.observed.ledgerEventCount = fixture.authority.preState.ledgerEventCount;
  fixture.observed.ledgerPrefixSha256 = fixture.authority.preState.ledgerPrefixSha256;
  fixture.observed.gateId = fixture.authority.preState.gateId;
  fixture.observed.gateStatus = fixture.authority.preState.gateStatus;
  fixture.observed.stateRevision = fixture.authority.preState.stateRevision;
  fixture.observed.contractRevision = fixture.authority.preState.contractRevision;
  fixture.observed.activeGate = fixture.authority.preState.activeGate;
  fixture.observed.manifestSha256 = fixture.authority.authorizedPathManifestSha256;
  fixture.observed.requestedPaths = fixture.manifest.paths.map((entry) => entry.path);
  fixture.observed.externalReinspectionReportPath = reportPath;
  fixture.observed.externalReinspectionReportSha256 = reportSha256;
  fixture.observed.requestedOperationClasses = ['EXTERNAL_CONFIRMATION'];
  return fixture;
}

test('LA-FC01: final-closure purpose permits only the exact AGENT_CLOSURE class', () => {
  const fixture = makeFinalClosureFixture();
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'AUTHORIZED');
  assert.deepEqual(result.authorizedOperationClasses, ['AGENT_CLOSURE']);
});

test('LA-FC02: normal maintenance cannot claim AGENT_CLOSURE', () => {
  const fixture = makeV2Fixture();
  fixture.authority.authorizedOperationClasses = ['AGENT_CLOSURE'];
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'PROHIBITED_OPERATION_CLASS_CLAIMED'));
});

test('LA-FC03: final-closure manifests require phase and artifact class parity', () => {
  const fixture = makeFinalClosureFixture();
  fixture.manifest.paths[0].phase = 'EXTERNAL_CONFIRMATION';
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'FINAL_CLOSURE_PHASE_CLASS_MISMATCH'));
});

test('LA-FC04: final-closure purpose still requires AGENT_CLOSURE', () => {
  const fixture = makeFinalClosureFixture();
  fixture.authority.authorizedOperationClasses = ['EXTERNAL_CONFIRMATION'];
  fixture.manifest.paths = fixture.manifest.paths.map((entry) => ({ ...entry, artifactClass: 'EXTERNAL_CONFIRMATION' }));
  fixture.authority.authorizedPathManifestSha256 = sha256Hex(Buffer.from(JSON.stringify(fixture.manifest), 'utf8'));
  fixture.observed.manifestSha256 = fixture.authority.authorizedPathManifestSha256;
  fixture.observed.requestedOperationClasses = ['EXTERNAL_CONFIRMATION'];
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'FINAL_CLOSURE_AGENT_OPERATION_REQUIRED'));
});

test('EC04/EC05/EC06: external-confirmation-only authority binds the exact report and pre-state', () => {
  const fixture = makeExternalConfirmationFixture();
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'AUTHORIZED');
  assert.deepEqual(result.authorizedOperationClasses, ['EXTERNAL_CONFIRMATION']);
  assert.deepEqual(result.authorizedPaths, fixture.manifest.paths.map((entry) => entry.path));
});

test('ECH12/ECH13: independent report binding is mandatory and digest drift blocks', () => {
  const missing = makeExternalConfirmationFixture();
  delete missing.authority.externalReinspectionReportPath;
  delete missing.authority.externalReinspectionReportSha256;
  delete missing.observed.externalReinspectionReportPath;
  delete missing.observed.externalReinspectionReportSha256;
  const missingResult = evaluatePostFreezeMaintenanceAuthorityV2({ ...missing, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(missingResult.decision, 'BLOCKED');
  assert.ok(missingResult.findings.some((finding) => finding.code === 'EXTERNAL_REINSPECTION_REPORT_PATH_REQUIRED'));

  const altered = makeExternalConfirmationFixture();
  altered.observed.externalReinspectionReportSha256 = 'b'.repeat(64);
  const alteredResult = evaluatePostFreezeMaintenanceAuthorityV2({ ...altered, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(alteredResult.decision, 'BLOCKED');
  assert.ok(alteredResult.findings.some((finding) => finding.code === 'EXTERNAL_REINSPECTION_REPORT_SHA_MISMATCH'));
});

test('ECH18/ECH19: authority reuse and old final-closure authority cannot authorize confirmation', () => {
  const reused = makeExternalConfirmationFixture();
  reused.consumptionRecord = { consumedUse: 1 };
  assert.equal(evaluatePostFreezeMaintenanceAuthorityV2({ ...reused, phase: PHASE_AUTHORIZE_PROGRAM_APPLY }).decision, 'BLOCKED');

  const oldClosure = makeFinalClosureFixture();
  oldClosure.authority.authorityPurpose = 'GATE_EXTERNAL_CONFIRMATION';
  const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...oldClosure, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'EXTERNAL_REINSPECTION_REPORT_PATH_REQUIRED'));
});

for (const [name, mutate] of [
  ['ECH01 AGENT_CLOSURE', (f) => { f.authority.authorizedOperationClasses.push('AGENT_CLOSURE'); f.observed.requestedOperationClasses.push('AGENT_CLOSURE'); }],
  ['ECH02 START', (f) => { f.authority.authorizedOperationClasses.push('START'); f.observed.requestedOperationClasses.push('START'); }],
  ['ECH03 AUTHORIZATION', (f) => { f.authority.authorizedOperationClasses.push('AUTHORIZATION'); f.observed.requestedOperationClasses.push('AUTHORIZATION'); }],
  ['ECH04 CONTRACT_SUCCESSION', (f) => { f.authority.authorizedOperationClasses.push('CONTRACT_SUCCESSION'); f.observed.requestedOperationClasses.push('CONTRACT_SUCCESSION'); }],
  ['ECH05 wrong Gate', (f) => { f.observed.gateId = 'GATE13'; }],
  ['ECH06 wrong status', (f) => { f.observed.gateStatus = 'IN_PROGRESS'; }],
  ['ECH07 wrong R0004', (f) => { f.observed.stateRevision = 'R0003'; }],
  ['ECH08 wrong R0002', (f) => { f.observed.contractRevision = 'R0001'; }],
  ['ECH09 wrong ledger60', (f) => { f.observed.ledgerEventCount = 59; }],
  ['ECH10 wrong HEAD', (f) => { f.observed.baseHead = '9'.repeat(40); }],
  ['ECH11 wrong ACTIVE_GATE', (f) => { f.observed.activeGate = 'GATE12'; }],
  ['ECH14 wildcard', (f) => { f.manifest.paths[0].path = 'synthetic/**'; f.authority.authorizedPathManifestSha256 = sha256Hex(Buffer.from(JSON.stringify(f.manifest), 'utf8')); f.observed.manifestSha256 = f.authority.authorizedPathManifestSha256; }],
  ['ECH15 unexpected path', (f) => { f.observed.requestedPaths.push('synthetic/unexpected.json'); }],
  ['ECH16 R8', (f) => { f.observed.R8Absent = false; }],
  ['ECH17 push', (f) => { f.authority.pushAuthorized = true; }]
]) {
  test(`${name} is blocked fail-closed`, () => {
    const fixture = makeExternalConfirmationFixture();
    mutate(fixture);
    const result = evaluatePostFreezeMaintenanceAuthorityV2({ ...fixture, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
    assert.equal(result.decision, 'BLOCKED');
    assert.deepEqual(result.authorizedPaths, []);
    assert.deepEqual(result.authorizedOperationClasses, []);
  });
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
