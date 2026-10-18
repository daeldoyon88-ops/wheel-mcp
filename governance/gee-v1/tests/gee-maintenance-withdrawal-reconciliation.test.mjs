import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {evaluatePostFreezeMaintenanceAuthorityV2,evaluateMaintenanceAuthorityWithdrawal,MAINTENANCE_WITHDRAWAL_DECISIONS,sha256Hex,REQUIRED_PROHIBITED_OPERATIONS,PHASE_AUTHORIZE_PROGRAM_APPLY,PHASE_VERIFY_PROGRAM_CONSUMPTION} from '../core/post-freeze-maintenance-authority.mjs';import {collectMaintenanceWithdrawalEvidence} from '../../tools/post-freeze-maintenance-observation.mjs';import {applyCandidate} from '../../tools/gate-lifecycle-orchestrator.mjs';
const POLICY_TEXT="{\n  \"schemaVersion\": 1,\n  \"documentKind\": \"MAINTENANCE_AUTHORITY_WITHDRAWAL_DECISION\",\n  \"decisionId\": \"WHEEL_R2_AUTHORITY_WITHDRAWAL_RESOLUTION_R1\",\n  \"issuedBy\": \"PROJECT_OWNER\",\n  \"recordedAt\": \"2026-10-17T19:18:36.492Z\",\n  \"programId\": \"WHEEL_STABLE_FINANCIAL_GUARDRAILS_REPAIR_R2\",\n  \"authorityId\": \"WHEEL_STABLE_FINANCIAL_GUARDRAILS_REPAIR_R2_AUTHORITY\",\n  \"authoritySha256\": \"a394d473781b453c6c086b12e76e811c9d5485a37ef1ee0b97271f6f88f5a897\",\n  \"decision\": \"WITHDRAW_EXECUTION_CONSENT\",\n  \"scope\": \"PROGRAM_AND_AUTHORITY_ID\",\n  \"reasonCode\": \"OWNER_CONSENT_WITHDRAWN\",\n  \"ownerDecisionText\": \"Je confirme que l'autorité WHEEL_STABLE_FINANCIAL_GUARDRAILS_REPAIR_R2, SHA-256 a394d473781b453c6c086b12e76e811c9d5485a37ef1ee0b97271f6f88f5a897, ne doit plus être exécutée. Elle reste historiquement non consommée. Aucun reçu fictif ne doit être créé.\",\n  \"source\": \"OWNER AUTHORIZATION — R2 AUTHORITY WITHDRAWAL CANDIDATE R1\"\n}\n";
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
  const observed = { withdrawalEvidence: [{ path: MAINTENANCE_WITHDRAWAL_DECISIONS[0].path, text: POLICY_TEXT }],
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
    closedStateSealFindings: [],
    preStateClosedStateSealMembers: [],
    preStateClosedStateSealFindings: []
  };
  return { authority, manifest, observed, now: new Date('2026-08-13T00:02:00.000Z') };
}
test('WD01: adopted withdrawal rejects either program identity or authority identity',()=>{const decision=JSON.parse(POLICY_TEXT),e=[{path:MAINTENANCE_WITHDRAWAL_DECISIONS[0].path,text:POLICY_TEXT}];for(const authority of [{programId:decision.programId,authorityId:'OTHER'},{programId:'OTHER',authorityId:decision.authorityId}])assert.ok(evaluateMaintenanceAuthorityWithdrawal({authority,withdrawalEvidence:e}).some(f=>f.code==='AUTHORITY_WITHDRAWN'));});
test('WD02: absent, altered and duplicate policy evidence each block',()=>{for(const evidence of [[],[{path:MAINTENANCE_WITHDRAWAL_DECISIONS[0].path,text:POLICY_TEXT+' '}],[{path:MAINTENANCE_WITHDRAWAL_DECISIONS[0].path,text:POLICY_TEXT},{path:MAINTENANCE_WITHDRAWAL_DECISIONS[0].path,text:POLICY_TEXT}]])assert.ok(evaluateMaintenanceAuthorityWithdrawal({authority:{},withdrawalEvidence:evidence}).length>0);});
test('WD03: unrelated exact maintenance grant keeps its own scope and cannot reuse R2',()=>{const f=makeV2Fixture();assert.equal(evaluatePostFreezeMaintenanceAuthorityV2(f).programAuthorized,true);f.authority.programId=JSON.parse(POLICY_TEXT).programId;f.manifest.programId=f.authority.programId;f.observed.manifestSha256=sha256Hex(Buffer.from(JSON.stringify(f.manifest),'utf8'));f.authority.authorizedPathManifestSha256=f.observed.manifestSha256;assert.ok(evaluatePostFreezeMaintenanceAuthorityV2(f).findings.some(f=>f.code==='AUTHORITY_WITHDRAWN'));});
test('WD04: withdrawal policy absence does not rewrite historical consumption',()=>{const f=makeV2Fixture();f.observed.withdrawalEvidence=[];const r=evaluatePostFreezeMaintenanceAuthorityV2({...f,phase:PHASE_VERIFY_PROGRAM_CONSUMPTION});assert.ok(!r.findings.some(f=>f.code.startsWith('WITHDRAWAL_')||f.code==='AUTHORITY_WITHDRAWN'));});
test('WD05: policy collector rereads changed and missing live bytes',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'wheel-wd-'));try{const p=path.join(root,MAINTENANCE_WITHDRAWAL_DECISIONS[0].path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,POLICY_TEXT);assert.equal(collectMaintenanceWithdrawalEvidence(root)[0].text,POLICY_TEXT);fs.writeFileSync(p,'altered');assert.equal(collectMaintenanceWithdrawalEvidence(root)[0].text,'altered');fs.unlinkSync(p);assert.equal(collectMaintenanceWithdrawalEvidence(root)[0].text,null);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('WD06: cached authorized decision without live authority is rejected before any write',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'wheel-wd-'));try{const target=path.join(root,'protected.txt');fs.writeFileSync(target,'before');assert.throws(()=>applyCandidate({root,candidate:{writes:[{path:'protected.txt',bytes:Buffer.from('after')}]},authority:{decision:'AUTHORIZED'}}),/CANDIDATE_AUTHORITY_DOCUMENT_REQUIRED/);assert.equal(fs.readFileSync(target,'utf8'),'before');}finally{fs.rmSync(root,{recursive:true,force:true});}});
