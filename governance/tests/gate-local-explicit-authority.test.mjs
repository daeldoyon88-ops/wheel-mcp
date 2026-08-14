import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateGateAuthorizationAuthority,
  computeGateAuthorizationBindingDigest,
  computeGateAuthorizationLocalRequestDigest,
  PHASE_AUTHORIZE_APPLY
} from '../gee-v1/core/gate-authorization-authority.mjs';
import {
  evaluateGateStartAuthority,
  computeGateStartRecordDigest,
  computeGateStartLocalRequestDigest,
  computeGateStartBindingDigestFromDigests
} from '../gee-v1/core/gate-start-authority.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const clone = (value) => structuredClone(value);
const localMode = 'LOCAL_EXPLICIT_AUTHORITY';
const now = new Date('2026-08-13T00:00:00.000Z');

function localAuthorizationFixture() {
  const record = clone(readJson('governance/authority/authorizations/GATE15/GATE_AUTHORIZATION_RECORD.json'));
  const authority = clone(readJson('governance/authority/authorizations/GATE15/PROJECT_OWNER_GATE_AUTHORIZATION_AUTHORITY.json'));
  for (const document of [record, authority]) {
    document.authorityMode = localMode;
    document.gateId = 'GATE16';
    document.authorizedStateArtifacts = document.authorizedStateArtifacts.map((item) => ({ ...item, repoRelativePath: item.repoRelativePath.replaceAll('GATE15', 'GATE16') }));
    document.dependencyProof = { ...document.dependencyProof, gateId: 'GATE15', authorityPath: 'synthetic/GATE15_COMPLETE_CONFIRMED.json' };
  }
  record.authorizationId = 'GATE_AUTHORIZATION_GATE16_R1';
  authority.authorityId = 'ACTIVE_GATE_AUTHORITY_GATE16_LOCAL_R1';
  delete authority.ownerKeyId;
  delete authority.signatureAlgorithm;
  delete authority.signature;
  authority.approvedBindingDigest = computeGateAuthorizationBindingDigest({
    ...authority,
    recordedAt: record.recordedAt,
    stateArtifacts: authority.authorizedStateArtifacts,
    derivedArtifacts: authority.authorizedDerivedArtifacts
  }).digest;
  authority.approvedRequestDigest = computeGateAuthorizationLocalRequestDigest(authority);
  const artifactSha256 = {};
  const artifactByteLength = {};
  for (const artifact of [...record.authorizedStateArtifacts, ...authority.authorizedDerivedArtifacts]) {
    artifactSha256[artifact.repoRelativePath] = artifact.sha256;
    artifactByteLength[artifact.repoRelativePath] = artifact.byteLength;
  }
  return {
    record,
    authority,
    observed: {
      projectId: 'WHEEL', gateId: 'GATE16', headCommit: record.baseCommit,
      preLedgerSha256: record.preLedgerSha256, previousEventSha256: record.previousEventSha256,
      currentStatus: 'NOT_STARTED', contractSha256: record.contractSha256,
      currentContractSha256: record.currentContractSha256, currentContractPresent: true,
      dependencyProof: { ...record.dependencyProof, status: 'COMPLETE_CONFIRMED' },
      artifactSha256, artifactByteLength, competingAuthorityCount: 1,
      existingAuthorizationEventCount: 0, consumed: false
    }
  };
}

function localStartFixture() {
  const record = clone(readJson('governance/authority/authorizations/GATE15/GATE_START_RECORD.json'));
  const authority = clone(readJson('governance/authority/authorizations/GATE15/PROJECT_OWNER_GATE_START_AUTHORITY.json'));
  for (const document of [record, authority]) {
    document.authorityMode = localMode;
    document.gateId = 'GATE16';
    document.eventId = 'GATE16_START_R1';
    document.dependencyProof = { ...document.dependencyProof, gateId: 'GATE15', authorityPath: 'synthetic/GATE15_COMPLETE_CONFIRMED.json' };
    document.authorizedStartWritePaths = document.authorizedStartWritePaths.map((item) => item.replaceAll('GATE15', 'GATE16'));
    document.functionalExecutionScope = document.functionalExecutionScope.map((item) => item.replaceAll('GATE15', 'GATE16'));
  }
  record.recordId = 'GATE16_START_RECORD_R1';
  record.recordDigest = computeGateStartRecordDigest(record);
  authority.authorityId = 'GATE16_START_AUTHORITY_LOCAL_R1';
  delete authority.ownerKeyId;
  delete authority.signatureAlgorithm;
  delete authority.signature;
  authority.recordDigest = record.recordDigest;
  authority.requestDigest = computeGateStartLocalRequestDigest(authority);
  authority.bindingDigest = computeGateStartBindingDigestFromDigests({ requestDigest: authority.requestDigest, recordDigest: record.recordDigest });
  return { record, authority };
}

test('LOCAL_EXPLICIT_AUTHORITY autorise un AUTH future sans clé ni requête externe', () => {
  const fixture = localAuthorizationFixture();
  const result = evaluateGateAuthorizationAuthority({ ...fixture, request: null, ownerKey: null, phase: PHASE_AUTHORIZE_APPLY, now });
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
  assert.equal(result.authorizationAuthorized, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.startAuthorized, false);
});

test('LOCAL_EXPLICIT_AUTHORITY autorise START futur sans clé ni requête externe', () => {
  const fixture = localStartFixture();
  const result = evaluateGateStartAuthority({ ...fixture, request: null, ownerKey: null, now });
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
  assert.equal(result.startAuthorized, true);
  assert.equal(result.executionAuthorized, true);
});

test('les deux branches et les mutations hostiles restent fail-closed', () => {
  const authMutations = [
    ['signature smuggling', (fixture) => { fixture.authority.ownerKeyId = 'FORGED'; }],
    ['external request', (fixture) => { fixture.request = {}; }],
    ['missing mode and signature', (fixture) => { delete fixture.authority.authorityMode; }],
    ['wrong base', (fixture) => { fixture.record.baseCommit = '2'.repeat(40); }],
    ['wrong ledger', (fixture) => { fixture.record.preLedgerSha256 = '3'.repeat(64); }],
    ['wrong Gate', (fixture) => { fixture.record.gateId = 'GATE17'; }],
    ['wrong operation', (fixture) => { fixture.record.prohibitedOperations = fixture.record.prohibitedOperations.filter((item) => item !== 'START'); }],
    ['wrong maxUse', (fixture) => { fixture.record.maxUse = 2; }],
    ['wrong path', (fixture) => { fixture.record.authorizedStateArtifacts[0].repoRelativePath = 'governance/gates/GATE17/state/CURRENT_STATE.json'; }]
  ];
  for (const [name, mutate] of authMutations) {
    const fixture = localAuthorizationFixture();
    fixture.request = null;
    mutate(fixture);
    assert.equal(evaluateGateAuthorizationAuthority({ ...fixture, ownerKey: null, now }).decision, 'BLOCKED', `AUTH ${name}`);
  }

  const startMutations = [
    ['signature smuggling', (fixture) => { fixture.authority.signature = 'forged'; }],
    ['external request', (fixture) => { fixture.request = {}; }],
    ['missing mode and signature', (fixture) => { delete fixture.authority.authorityMode; }],
    ['wrong base', (fixture) => { fixture.record.baseCommit = '2'.repeat(40); }],
    ['wrong ledger', (fixture) => { fixture.record.preStartLedgerSha256 = '3'.repeat(64); }],
    ['wrong Gate', (fixture) => { fixture.record.gateId = 'GATE17'; }],
    ['wrong operation', (fixture) => { fixture.record.prohibitedOperations = fixture.record.prohibitedOperations.filter((item) => item !== 'AUTHORIZATION'); }],
    ['wrong maxUse', (fixture) => { fixture.record.maxUse = 2; }],
    ['wrong path', (fixture) => { fixture.record.authorizedStartWritePaths[0] = 'governance/gates/GATE17/state/CURRENT_STATE.json'; }]
  ];
  for (const [name, mutate] of startMutations) {
    const fixture = localStartFixture();
    fixture.request = null;
    mutate(fixture);
    assert.equal(evaluateGateStartAuthority({ ...fixture, ownerKey: null, now }).decision, 'BLOCKED', `START ${name}`);
  }
});
