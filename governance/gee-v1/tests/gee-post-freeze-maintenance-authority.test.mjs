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
