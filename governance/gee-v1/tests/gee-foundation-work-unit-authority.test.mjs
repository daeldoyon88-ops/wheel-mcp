/**
 * Foundation repair: WORK_UNIT execution authority + owner commit/push policy.
 *
 * AUTH-01..AUTH-17 from the mission, plus the owner-approval cases added by
 * the owner's clarification. Every case is deterministic and local.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createExecutionAuthorityRegistry,
  resolveExecutionAuthority,
  isPathAuthorized,
  REQUIRED_AUTHORITY_PROOFS
} from '../core/work-unit-core.mjs';
import { createWheelGateAuthoritySource, readActiveGateId, EXECUTABLE_GATE_STATUSES } from '../adapters/wheel/gate-authority-source.mjs';
import { createGeeMissionAuthoritySource, MISSION_WORK_UNIT_TYPE } from '../adapters/gee-mission-authority-source.mjs';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { NEVER_GRANTABLE_OPERATIONS, GRANTABLE_OPERATIONS, buildCommitPlan } from '../core/release-authority.mjs';
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { validateStrategicContract } from '../contracts/validate-strategic-contract.mjs';
import { EXTENSION_POINTS } from '../core/extension-points.mjs';
import { createSyntheticAdapter } from '../fixtures/synthetic-non-wheel-adapter.mjs';
import { createProjectSession } from '../core/work-unit-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const PROJECT_ID = 'WHEEL';

const R1_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R1';
const R2_ID = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R2';

function registry(root = REPO_ROOT) {
  const wheelAdapter = createWheelProjectAdapter(root);
  return createExecutionAuthorityRegistry([
    createWheelGateAuthoritySource(root, { projectId: PROJECT_ID }),
    createGeeMissionAuthoritySource(root, {
      projectId: PROJECT_ID,
      prerequisiteResolvers: {
        'wheel-adapter-status': (prerequisite) => wheelAdapter.resolvePrerequisite(prerequisite.id, prerequisite)
      }
    })
  ]);
}

function resolve(workUnitType, workUnitId, reg = registry()) {
  return resolveExecutionAuthority({ projectId: PROJECT_ID, workUnitType, workUnitId, registry: reg });
}

function preflight(args = []) {
  const result = spawnSync(process.execPath, ['governance/tools/governance-preflight.mjs', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  return JSON.parse(result.stdout);
}

function constitutionRule(ruleId) {
  const constitution = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/PROJECT_CONSTITUTION.json'), 'utf8'));
  return (constitution.rules || []).find((rule) => rule.ruleId === ruleId);
}

// ---------------------------------------------------------------------------
// AUTH-01 / AUTH-02 — GATE compatibility
// ---------------------------------------------------------------------------

test('AUTH-01: the existing ACTIVE_GATE / GATE workflow still resolves, with unchanged semantics', () => {
  const activeGate = readActiveGateId(REPO_ROOT);
  assert.equal(typeof activeGate, 'string');

  // No-argument preflight must still resolve the active gate, as before.
  const report = preflight();
  assert.equal(report.workUnit.requested.workUnitType, 'GATE');
  assert.equal(report.workUnit.requested.workUnitId, activeGate);
  assert.equal(report.workUnit.resolvedBy, 'wheel-gate-authority-source');

  // Legacy report fields survive with their original meaning.
  assert.equal(report.GOVERNANCE_VERDICT, 'PASS');
  assert.equal(report.configurationValid, true);
  assert.equal(typeof report.activeGateStatus, 'string');
  assert.equal(typeof report.activeContractPresent, 'boolean');
  assert.equal(typeof report.activeGateExecutable, 'boolean');
  assert.deepEqual(report.blockingFindings, []);

  // Backward-compatibility invariant: for the GATE path, executionAuthorized is
  // still exactly configurationValid && contract present && executable status.
  assert.equal(report.executionAuthorized, report.configurationValid && report.activeGateExecutable);
});

test('AUTH-02: GATE13 remains COMPLETE_CONFIRMED and is therefore not executable', () => {
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  assert.equal(adapter.getWorkUnitView('GATE13').status, 'COMPLETE_CONFIRMED');

  const authority = resolve('GATE', 'GATE13');
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
  assert.equal(EXECUTABLE_GATE_STATUSES.includes('COMPLETE_CONFIRMED'), false);

  // The repair must not have reopened it anywhere.
  const report = preflight();
  assert.equal(report.activeGateStatus, 'COMPLETE_CONFIRMED');
  assert.equal(report.activeGateExecutable, false);
});

// ---------------------------------------------------------------------------
// AUTH-03 / AUTH-04 — independent GEE mission authority
// ---------------------------------------------------------------------------

test('AUTH-03: GEE R2 remains delivered and is superseded independently of ACTIVE_GATE', () => {
  const authority = resolve(MISSION_WORK_UNIT_TYPE, R2_ID);
  assert.equal(authority.decision, 'BLOCKED');
  assert.equal(authority.authoritySource, 'gee-mission-authority-source');
  assert.equal(authority.executionAuthorized, false);
  assert.ok(authority.findings.some((finding) => finding.detail.includes('delivered and superseded by GOVERNANCE_EXECUTION_EFFICIENCY_V1_R3')));

  // Its proof chain cites the mission's own contract, never the gate pointer.
  const cited = Object.values(authority.proofs).map((proof) => proof.reason || '').join(' ');
  assert.ok(cited.includes('GEE_V1_EXECUTION_CONTRACT_R0002.json'));
  assert.equal(cited.includes('ACTIVE_GATE'), false);

  // And ACTIVE_GATE still points at the closed gate: R2 did not touch it.
  const pointer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/active/ACTIVE_GATE.json'), 'utf8'));
  assert.equal(pointer.activeGate, 'GATE13');
});

test('AUTH-04: R2 preflight proves delivery while refusing superseded execution', () => {
  const report = preflight(['--work-unit-type', MISSION_WORK_UNIT_TYPE, '--work-unit-id', R2_ID]);
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.workUnit.decision, 'BLOCKED');
  assert.ok(report.workUnit.findings.some((finding) => finding.detail.includes('delivered and superseded by GOVERNANCE_EXECUTION_EFFICIENCY_V1_R3')));
  for (const proofId of REQUIRED_AUTHORITY_PROOFS.filter((proofId) => proofId !== 'WORK_UNIT_EXECUTABLE')) {
    assert.equal(report.workUnit.proofs[proofId].state, 'PROVEN', proofId);
  }
  assert.equal(report.workUnit.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
});

// ---------------------------------------------------------------------------
// AUTH-05 / AUTH-06 / AUTH-11 — scope of the R2 authority
// ---------------------------------------------------------------------------

test('AUTH-05: R1 mutation through R2 authority is BLOCKED', () => {
  const authority = resolve(MISSION_WORK_UNIT_TYPE, R2_ID);
  const r1Contract = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0001.json'), 'utf8')
  );

  // Every artifact R1 declared required is outside R2's write scope.
  for (const artifact of r1Contract.requiredArtifacts) {
    assert.equal(isPathAuthorized(authority.authorizedPaths, artifact), false, artifact);
  }
  for (const r1Path of [
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0001.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_SEAL.json',
    'governance/gee-v1/core/work-unit-core.mjs',
    'governance/gee-v1/core/release-authority.mjs',
    'governance/gee-v1/readiness/evaluate-readiness.mjs',
    'governance/gee-v1/adapters/wheel/wheel-project-adapter.mjs',
    'governance/gee-v1/schemas/work-unit-execution-contract.schema.json'
  ]) {
    assert.equal(isPathAuthorized(authority.authorizedPaths, r1Path), false, r1Path);
  }
});

test('AUTH-06: R4 is authorized only by its own sealed revision', () => {
  const r4 = resolve(MISSION_WORK_UNIT_TYPE, 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R4');
  assert.equal(r4.executionAuthorized, true);
  assert.equal(r4.decision, 'AUTHORIZED');
  assert.equal(r4.authoritySource, 'gee-mission-authority-source');
  assert.equal(r4.proofs.EXECUTION_CONTRACT.state, 'PROVEN');
  assert.equal(r4.proofs.CONTRACT_INTEGRITY.state, 'PROVEN');
  assert.equal(r4.proofs.PREREQUISITES.state, 'PROVEN');

  const r3 = resolve(MISSION_WORK_UNIT_TYPE, 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R3');
  assert.equal(r3.executionAuthorized, false);
  assert.ok(r3.findings.some((finding) => finding.detail.includes('delivered and superseded by GOVERNANCE_EXECUTION_EFFICIENCY_V1_R4')));

  // R3's own contract remains historical and refuses to stand in for R4.
  const r2Contract = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0002.json'), 'utf8')
  );
  assert.equal(r2Contract.authorizedVerdicts.some((verdict) => /^R[3-9]/.test(verdict)), false);
  assert.ok(r2Contract.invalidationDeclarations.some((d) => d.includes('never authorizes R3')));
  const r3Contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0003.json'), 'utf8'));
  assert.ok(r3Contract.invalidationDeclarations.some((d) => d.includes('R4')));
});

test('AUTH-11: an out-of-scope R2 write is BLOCKED, and in-scope writes are allowed', () => {
  const { authorizedPaths } = resolve(MISSION_WORK_UNIT_TYPE, R2_ID);

  for (const inScope of [
    'governance/gee-v1/context/compile-context.mjs',
    'governance/gee-v1/schemas/context-bundle.schema.json',
    'governance/gee-v1/tools/context-compile.mjs',
    'governance/gee-v1/tests/gee-r2-context-compiler.test.mjs'
  ]) {
    assert.equal(isPathAuthorized(authorizedPaths, inScope), true, inScope);
  }

  for (const outOfScope of [
    'server.js',
    'governance/PROJECT_CONSTITUTION.json',
    'governance/active/ACTIVE_GATE.json',
    'governance/state/GATE_STATUS_LEDGER.ndjson',
    'governance/gates/GATE13/state/CURRENT_STATE.json',
    'governance/gee-v1/tools/validate-gee-contracts.mjs',
    'governance/gee-v1/tests/gee-r1-contract-layer.test.mjs',
    'research/directional-lab/src/index.mjs'
  ]) {
    assert.equal(isPathAuthorized(authorizedPaths, outOfScope), false, outOfScope);
  }

  // Scope cannot be escaped by spelling.
  assert.equal(isPathAuthorized(authorizedPaths, 'governance/gee-v1/context/../../../etc/passwd'), false);
  assert.equal(isPathAuthorized(authorizedPaths, 'C:/Users/melan/x'), false);
  assert.equal(isPathAuthorized(authorizedPaths, '/etc/passwd'), false);
  assert.equal(isPathAuthorized(authorizedPaths, 'governance\\gee-v1\\context\\..\\..\\core\\x.mjs'), false);
  // A prefix must be a strict prefix: the scope entry itself is not a file.
  assert.equal(isPathAuthorized(authorizedPaths, 'governance/gee-v1/context/'), false);
});

// ---------------------------------------------------------------------------
// AUTH-07 .. AUTH-10 — fail-closed routing
// ---------------------------------------------------------------------------

test('AUTH-07: an unknown workUnitType is BLOCKED and never falls back to the active gate', () => {
  const authority = resolve('EXPERIMENT', 'ANYTHING');
  assert.equal(authority.executionAuthorized, false);
  assert.ok(authority.findings.some((f) => f.code === 'UNKNOWN_WORK_UNIT_TYPE'));
  assert.equal(authority.authoritySource, null);
  assert.deepEqual(authority.authorizedPaths, []);

  // The active gate is never consulted as a fallback subject.
  assert.notEqual(authority.workUnitId, readActiveGateId(REPO_ROOT));

  const report = preflight(['--work-unit-type', 'EXPERIMENT', '--work-unit-id', 'ANYTHING']);
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.workUnit.requested.workUnitId, 'ANYTHING');
});

test('AUTH-08: an unknown workUnitId is BLOCKED for every registered type', () => {
  for (const [type, id] of [['GATE', 'GATE99'], [MISSION_WORK_UNIT_TYPE, 'NOT_A_MISSION']]) {
    const authority = resolve(type, id);
    assert.equal(authority.executionAuthorized, false, `${type}:${id}`);
    assert.ok(authority.findings.some((f) => f.code === 'UNKNOWN_WORK_UNIT_ID'), `${type}:${id}`);
  }
  // A missing id is not an invitation to guess one.
  assert.equal(resolve(MISSION_WORK_UNIT_TYPE, null).executionAuthorized, false);
  assert.ok(resolve(MISSION_WORK_UNIT_TYPE, null).findings.some((f) => f.code === 'WORK_UNIT_ID_REQUIRED'));
});

test('AUTH-09: a missing execution contract is BLOCKED', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-auth-missing-'));
  fs.mkdirSync(path.join(temp, 'governance', 'gee-v1', 'missions'), { recursive: true });
  const source = createGeeMissionAuthoritySource(temp, { projectId: PROJECT_ID });
  const authority = resolveExecutionAuthority({
    projectId: PROJECT_ID,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    workUnitId: R2_ID,
    registry: createExecutionAuthorityRegistry([source])
  });
  assert.equal(authority.executionAuthorized, false);
  assert.ok(authority.findings.some((f) => f.code === 'UNKNOWN_WORK_UNIT_ID'));

  // A contract present but with a broken seal is equally BLOCKED, not degraded.
  const contract = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0002.json'), 'utf8')
  );
  fs.writeFileSync(
    path.join(temp, 'governance', 'gee-v1', 'missions', 'GEE_V1_EXECUTION_CONTRACT_R0002.json'),
    JSON.stringify(contract, null, 2)
  );
  const unsealed = resolveExecutionAuthority({
    projectId: PROJECT_ID,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    workUnitId: R2_ID,
    registry: createExecutionAuthorityRegistry([createGeeMissionAuthoritySource(temp, { projectId: PROJECT_ID })])
  });
  assert.equal(unsealed.executionAuthorized, false);
  assert.equal(unsealed.proofs.CONTRACT_INTEGRITY.state, 'FAILED');
  fs.rmSync(temp, { recursive: true, force: true });
});

test('AUTH-10: two sources claiming the same work-unit type is a CONFLICTING_AUTHORITY block', () => {
  const conflicting = createExecutionAuthorityRegistry([
    createGeeMissionAuthoritySource(REPO_ROOT, { projectId: PROJECT_ID }),
    createGeeMissionAuthoritySource(REPO_ROOT, { projectId: PROJECT_ID })
  ]);
  const authority = resolveExecutionAuthority({
    projectId: PROJECT_ID,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    workUnitId: R2_ID,
    registry: conflicting
  });
  assert.equal(authority.executionAuthorized, false);
  assert.ok(authority.findings.some((f) => f.code === 'CONFLICTING_AUTHORITY'));
});

test('a source that omits a proof, or throws, is BLOCKED — absence never upgrades', () => {
  const silent = {
    projectId: PROJECT_ID,
    workUnitType: 'SILENT',
    resolveWorkUnitAuthority: (workUnitId) => ({ workUnitId, authorizedPaths: ['x/'], proofs: {} })
  };
  const silentResult = resolveExecutionAuthority({
    projectId: PROJECT_ID, workUnitType: 'SILENT', workUnitId: 'W', registry: createExecutionAuthorityRegistry([silent])
  });
  assert.equal(silentResult.executionAuthorized, false);
  assert.equal(silentResult.findings.filter((f) => f.code === 'PROOF_UNKNOWN').length, REQUIRED_AUTHORITY_PROOFS.length);

  const throwing = {
    projectId: PROJECT_ID,
    workUnitType: 'THROWS',
    resolveWorkUnitAuthority: () => { throw new Error('boom'); }
  };
  const throwingResult = resolveExecutionAuthority({
    projectId: PROJECT_ID, workUnitType: 'THROWS', workUnitId: 'W', registry: createExecutionAuthorityRegistry([throwing])
  });
  assert.equal(throwingResult.executionAuthorized, false);
  assert.ok(throwingResult.findings.some((f) => f.code === 'AUTHORITY_SOURCE_ERROR'));

  // An unexplained NOT_APPLICABLE is treated as a forgotten check.
  const handwaving = {
    projectId: PROJECT_ID,
    workUnitType: 'HANDWAVE',
    resolveWorkUnitAuthority: (workUnitId) => ({
      workUnitId,
      authorizedPaths: ['x/'],
      proofs: Object.fromEntries(REQUIRED_AUTHORITY_PROOFS.map((id) => [id, { state: 'NOT_APPLICABLE' }]))
    })
  };
  const handwavingResult = resolveExecutionAuthority({
    projectId: PROJECT_ID, workUnitType: 'HANDWAVE', workUnitId: 'W', registry: createExecutionAuthorityRegistry([handwaving])
  });
  assert.equal(handwavingResult.executionAuthorized, false);
  assert.ok(handwavingResult.findings.some((f) => f.code === 'PROOF_NOT_APPLICABLE_WITHOUT_REASON'));

  // A work unit that declares no write scope is BLOCKED.
  const scopeless = {
    projectId: PROJECT_ID,
    workUnitType: 'SCOPELESS',
    resolveWorkUnitAuthority: (workUnitId) => ({
      workUnitId,
      authorizedPaths: [],
      proofs: Object.fromEntries(REQUIRED_AUTHORITY_PROOFS.map((id) => [id, { state: 'PROVEN', reason: 'ok' }]))
    })
  };
  const scopelessResult = resolveExecutionAuthority({
    projectId: PROJECT_ID, workUnitType: 'SCOPELESS', workUnitId: 'W', registry: createExecutionAuthorityRegistry([scopeless])
  });
  assert.equal(scopelessResult.executionAuthorized, false);
  assert.ok(scopelessResult.findings.some((f) => f.code === 'WRITE_SCOPE_UNDECLARED'));
});

// ---------------------------------------------------------------------------
// AUTH-12 / AUTH-13 / AUTH-14 — Git policy
// ---------------------------------------------------------------------------

test('AUTH-12: autonomous agent git push is BLOCKED by canonical policy', () => {
  const rule = constitutionRule('GIT_WRITES_FORBIDDEN_BY_DEFAULT');
  assert.equal(rule.gitOperationPolicy.agentAutomaticPush, 'FORBIDDEN_ALWAYS');
  assert.equal(rule.gitOperationPolicy.subject, 'GOVERNED_AGENT_EXECUTION');

  // No authority kind may ever grant a push operation.
  for (const operation of ['GIT_PUSH', 'GIT_PUSH_FORCE']) {
    assert.ok(NEVER_GRANTABLE_OPERATIONS.includes(operation), operation);
    assert.equal(GRANTABLE_OPERATIONS.includes(operation), false, operation);
  }
  // Destructive commands remain forbidden with override authority NONE.
  const dangerous = constitutionRule('DANGEROUS_GIT_COMMANDS_FORBIDDEN');
  assert.equal(dangerous.overrideAuthority, 'NONE');

  // The preflight surfaces the policy so no caller has to infer it.
  const report = preflight();
  assert.equal(report.gitPolicy.declared, true);
  assert.equal(report.gitPolicy.agentAutomaticPush, 'FORBIDDEN_ALWAYS');
});

test('AUTH-13: release authorization still does NOT grant agent push', () => {
  const plan = buildCommitPlan({
    baseCommit: 'a'.repeat(40),
    branch: 'main',
    commitMessage: 'test',
    manifest: [{ path: 'a.txt', status: 'MODIFIED', workingTreeSha256: 'b'.repeat(64), stageAction: 'STAGE_CONTENT' }]
  });
  assert.equal(plan.pushAllowed, false);
  assert.equal(plan.pushCommand, null);
  assert.equal(plan.commands.some((command) => command.includes('push')), false);
  // No `git add .` / `-A` can appear in a plan: pathspecs are enumerated.
  assert.equal(plan.commands.some((command) => command.includes('.') && command[1] === 'add'), false);
  assert.equal(plan.commands.some((command) => command.includes('-A')), false);
});

test('AUTH-14: owner manual `git push origin main` requires no extra cryptographic authorization', () => {
  const policy = constitutionRule('GIT_WRITES_FORBIDDEN_BY_DEFAULT').gitOperationPolicy;
  assert.equal(policy.ownerManualShellPush, 'OUT_OF_SCOPE_OF_AGENT_EXECUTION_AUTHORITY');
  assert.equal(policy.ownerManualShellPushRequiresCryptographicAuthorization, false);
  // And it is a boundary, not a detector: nothing claims to identify a human.
  assert.equal(policy.humanShellDetection, 'NOT_A_MECHANISM_THIS_IS_A_GOVERNANCE_BOUNDARY');

  // No push-authorization subsystem was introduced anywhere.
  for (const forbidden of [
    'governance/authority/PUSH_AUTHORIZATION.json',
    'governance/authority/PROJECT_OWNER_PUSH_KEY.json',
    'governance/gee-v1/core/push-authority.mjs'
  ]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, forbidden)), false, forbidden);
  }
});

test('OWNER-COMMIT: explicit owner approval authorizes a targeted local commit without a signing ceremony', () => {
  const rule = constitutionRule('GIT_WRITES_FORBIDDEN_BY_DEFAULT');
  const policy = rule.gitOperationPolicy;

  assert.ok(rule.allowedOverrides.includes('OWNER_EXPLICIT_COMMIT_APPROVAL'));
  assert.equal(policy.ownerApprovedTargetedLocalCommit, 'ALLOWED_BY_OWNER_EXPLICIT_APPROVAL');
  assert.equal(policy.ownerApprovedCommitRequiresCryptographicAuthorization, false);
  assert.equal(policy.commitPathspecPolicy, 'EXPLICIT_PATHSPECS_ONLY');
  assert.equal(policy.maxCommitsPerOwnerApproval, 1);

  // Without owner approval the default still forbids an agent commit.
  assert.equal(rule.defaultState, 'ENFORCED');
  assert.equal(policy.agentAutomaticCommitWithoutOwnerApproval, 'FORBIDDEN');

  // The signed flow is preserved as an option, not removed and not required.
  assert.equal(policy.cryptographicReleaseAuthorization, 'OPTIONAL_HIGH_SECURITY_MODE');
  assert.ok(rule.allowedOverrides.includes('OWNER_AUTHORIZED_RELEASE_COMMIT'));
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json')), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance/gee-v1/core/release-authority.mjs')), true);
});

test('SIMPLICITY: the constitution still has exactly 17 rules and gained no new key or document kind', () => {
  const constitution = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/PROJECT_CONSTITUTION.json'), 'utf8'));
  assert.equal(constitution.rules.length, 17);
  assert.equal(new Set(constitution.rules.map((rule) => rule.ruleId)).size, 17);

  const validation = spawnSync(process.execPath, ['governance/tools/validate-project-constitution.mjs'], {
    cwd: REPO_ROOT, encoding: 'utf8'
  });
  assert.equal(validation.status, 0);
  assert.equal(JSON.parse(validation.stdout).verdict, 'PASS');

  // Exactly one owner key file exists, unchanged in kind: no second key.
  const authorityFiles = fs.readdirSync(path.join(REPO_ROOT, 'governance/authority'));
  assert.deepEqual(authorityFiles.filter((file) => /KEY/i.test(file)), ['PROJECT_OWNER_RELEASE_KEY.json']);
});

// ---------------------------------------------------------------------------
// AUTH-15 / AUTH-16 / AUTH-17 — non-regression
// ---------------------------------------------------------------------------

test('AUTH-15: R1 stays COMPLETE — its sealed contract is intact and all its artifacts still exist', () => {
  const contract = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0001.json'), 'utf8')
  );
  const authority = resolve(MISSION_WORK_UNIT_TYPE, R1_ID);

  assert.equal(authority.proofs.EXECUTION_CONTRACT.state, 'PROVEN');
  assert.equal(authority.proofs.CONTRACT_INTEGRITY.state, 'PROVEN');
  for (const artifact of contract.requiredArtifacts) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, artifact)), true, artifact);
  }

  // Delivered work is closed: R1 is no longer executable now that R2 exists,
  // and that is derived from R1's own delivery, not from a status field.
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.proofs.WORK_UNIT_EXECUTABLE.state, 'FAILED');
  assert.match(authority.proofs.WORK_UNIT_EXECUTABLE.reason, /superseded by GOVERNANCE_EXECUTION_EFFICIENCY_V1_R2/);

  // The R1 seal file itself was not rewritten to accommodate R2.
  const seal = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_SEAL.json'), 'utf8')
  );
  assert.equal(seal.payload.contractId, 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R1');
  assert.equal(seal.payload.contractVersion, 'R0001');
  assert.equal(seal.sealSha256, 'e8b2d9982f98522dc42dab634e1a9a50cefda9190337990197548788030c6b0a');
});

test('AUTH-16: GATE13 state, ledger closure and external confirmation are untouched', () => {
  const view = createWheelProjectAdapter(REPO_ROOT).getWorkUnitView('GATE13');
  assert.equal(view.status, 'COMPLETE_CONFIRMED');
  assert.equal(view.authorityState.consistent, true);
  assert.equal(view.state.identityBinding, 'BOUND');

  const events = fs.readFileSync(path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const last = events.filter((event) => event.gateId === 'GATE13').at(-1);
  assert.equal(last.toStatus, 'COMPLETE_CONFIRMED');
  assert.equal(last.transitionType, 'EXTERNAL_CONFIRMATION');
  // The repair appended nothing to the authority spine.
  assert.equal(events.length, 44);
});

test('AUTH-17: a synthetic non-Wheel work unit still works through the generic core', () => {
  // The R1 project-agnostic session path is unchanged.
  const session = createProjectSession(createSyntheticAdapter());
  assert.equal(session.projectId, 'SYNTHETIC_LAB');
  assert.equal(session.workUnitType, 'EXPERIMENT');
  assert.equal(session.getWorkUnit('WU_SYNTH_01').status, 'AUTHORIZED_NOT_STARTED');

  // And the new authority router accepts a foreign project + type with no
  // Wheel knowledge whatsoever.
  const syntheticSource = {
    projectId: 'SYNTHETIC_LAB',
    workUnitType: 'EXPERIMENT',
    sourceId: 'synthetic-source',
    resolveWorkUnitAuthority: (workUnitId) => (workUnitId === 'WU_SYNTH_01' ? {
      workUnitId,
      authorizedPaths: ['synthetic/lab/'],
      proofs: Object.fromEntries(REQUIRED_AUTHORITY_PROOFS.map((id) => [id, { state: 'PROVEN', reason: 'synthetic' }]))
    } : null)
  };
  const reg = createExecutionAuthorityRegistry([syntheticSource]);
  const ok = resolveExecutionAuthority({
    projectId: 'SYNTHETIC_LAB', workUnitType: 'EXPERIMENT', workUnitId: 'WU_SYNTH_01', registry: reg
  });
  assert.equal(ok.executionAuthorized, true);
  assert.equal(isPathAuthorized(ok.authorizedPaths, 'synthetic/lab/run.mjs'), true);

  // A Wheel work unit is not reachable through a foreign project id.
  const crossProject = resolveExecutionAuthority({
    projectId: 'SYNTHETIC_LAB', workUnitType: 'GATE', workUnitId: 'GATE13', registry: registry()
  });
  assert.equal(crossProject.executionAuthorized, false);
  assert.ok(crossProject.findings.some((f) => f.code === 'UNKNOWN_WORK_UNIT_TYPE'));
});

// ---------------------------------------------------------------------------
// AUTH-18 — strategic/execution authority compatibility
//
// Independent review found a semantic contradiction: the strategic objective
// still forbade "implementing R2+ engines" while the execution contract that
// references it authorized the R2 Context Compiler. The check below uses the
// canonical compatibility mechanism the contract layer already provides
// (validateExecutionContract's knownVerdicts, sourced from the strategic
// authority) rather than any new semantic validator.
// ---------------------------------------------------------------------------

test('AUTH-18: the R2 execution contract is compatible with its referenced strategic authority', () => {
  const strategic = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_STRATEGIC_CONTRACT.json'), 'utf8')
  );
  const r2 = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0002.json'), 'utf8')
  );

  // The strategic contract itself must still be canonically valid.
  assert.equal(validateStrategicContract(strategic).valid, true);

  // (1) Structural linkage, then verdict compatibility through the existing
  // knownVerdicts mechanism — the canonical way an execution contract is
  // checked against the authority it claims to descend from.
  assert.equal(r2.strategicContractId, strategic.id);
  const knownVerdicts = new Set(strategic.authorizedVerdicts);
  assert.equal(validateExecutionContract(r2, { knownVerdicts }).valid, true);

  // R1 remains compatible with the revised strategic authority too.
  const r1 = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0001.json'), 'utf8')
  );
  assert.equal(r1.strategicContractId, strategic.id);
  assert.equal(validateExecutionContract(r1, { knownVerdicts }).valid, true);

  // (2) The strategic authority no longer prohibits R2, and declares it as a
  // program stage. The prohibition was a literal clause; its absence is
  // asserted literally, not by interpreting prose.
  // Scoped to the NORMATIVE fields. `notes` is deliberately excluded: it cites
  // the withdrawn clause verbatim as provenance for why R0002 exists, and
  // recording history must not be mistaken for still imposing it.
  const normative = JSON.stringify({
    objective: strategic.objective,
    strategicPurpose: strategic.strategicPurpose,
    invariants: strategic.invariants,
    stateTransitionRules: strategic.stateTransitionRules,
    invalidationDeclarations: strategic.invalidationDeclarations
  });
  assert.equal(/without implementing R2\+/i.test(strategic.objective), false);
  assert.equal(/R2\+ engines/i.test(normative), false);
  assert.ok(/without implementing R2\+ engines/i.test(strategic.notes), 'the withdrawn clause stays recorded as history');
  const stages = strategic.stateTransitionRules.join(' | ');
  for (const stage of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']) {
    assert.ok(new RegExp(`\\b${stage}\\b`).test(stages), `strategic program must declare ${stage}`);
  }
  // The staged program must stay consistent with the extension points R1
  // already declared, so the two descriptions of the program cannot drift.
  for (const point of Object.values(EXTENSION_POINTS)) {
    assert.ok(new RegExp(`\\b${point.targetRevision}\\b`).test(stages), `${point.id} targets ${point.targetRevision}`);
  }

  // Canonical revision handling was used rather than an in-place rewrite.
  assert.match(strategic.version, /^R[0-9]{4}$/);
  assert.equal(strategic.version, 'R0002');
});

test('AUTH-18b: only the sealed R4 revision is current; R5+ remain unauthorized', () => {
  const strategic = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_STRATEGIC_CONTRACT.json'), 'utf8')
  );

  // The strategic contract says so itself, in its structured declarations.
  assert.ok(strategic.invalidationDeclarations.some((d) => /NOT authorized for execution/i.test(d)));
  assert.ok(strategic.invalidationDeclarations.some((d) => /no revision authorizes a later stage/i.test(d)));

  // And the resolver agrees: R4 exists as its own sealed revision, while no
  // execution contract exists for any later stage.
  const missions = fs.readdirSync(path.join(REPO_ROOT, 'governance/gee-v1/missions'));
  assert.deepEqual(
    missions.filter((file) => /^GEE_V1_EXECUTION_CONTRACT_R\d{4}\.json$/.test(file)).sort(),
    ['GEE_V1_EXECUTION_CONTRACT_R0001.json', 'GEE_V1_EXECUTION_CONTRACT_R0002.json', 'GEE_V1_EXECUTION_CONTRACT_R0003.json', 'GEE_V1_EXECUTION_CONTRACT_R0004.json']
  );
  const r4 = resolve(MISSION_WORK_UNIT_TYPE, 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R4');
  assert.equal(r4.executionAuthorized, true);
  assert.equal(r4.decision, 'AUTHORIZED');
  for (const laterStage of ['R5', 'R6', 'R7']) {
    const authority = resolve(MISSION_WORK_UNIT_TYPE, `GOVERNANCE_EXECUTION_EFFICIENCY_V1_${laterStage}`);
    assert.equal(authority.executionAuthorized, false, laterStage);
    assert.ok(authority.findings.some((f) => f.code === 'UNKNOWN_WORK_UNIT_ID'), laterStage);
  }

  // Strategic verdicts still cover only the revisions that actually have a
  // contract: the program is declared, its later stages are not pre-verdicted.
  assert.equal(strategic.authorizedVerdicts.some((verdict) => /^R[3-9]_/.test(verdict)), false);
});

test('AUTH-18c: an execution contract contradicting its strategic authority fails closed', () => {
  const strategic = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_STRATEGIC_CONTRACT.json'), 'utf8')
  );
  const knownVerdicts = new Set(strategic.authorizedVerdicts);
  const r2 = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0002.json'), 'utf8')
  );

  // A contract claiming a stage verdict this strategic authority does not know
  // is BLOCKING through the canonical mechanism — no new validator involved.
  const contradictory = { ...r2, id: 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R3', version: 'R0003', authorizedVerdicts: ['R3_COMPLETE'] };
  const result = validateExecutionContract(contradictory, { knownVerdicts });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((finding) => finding.detectorId === 'UNKNOWN_VERDICT'));

  // The same mechanism is what R1's hostile fixture already exercises, so this
  // is the architecture's existing fail-closed path, not a parallel one.
  const hostile = JSON.parse(
    fs.readFileSync(path.join(HERE, '..', 'fixtures', 'hostile-unknown-verdict.json'), 'utf8')
  );
  assert.equal(validateExecutionContract(hostile, { knownVerdicts }).valid, false);
});

test('the generic core stays free of project facts and of revision hardcoding', () => {
  const core = fs.readFileSync(path.join(HERE, '..', 'core', 'work-unit-core.mjs'), 'utf8');
  for (const token of ['GATE', 'WHEEL', 'MISSION_REVISION', 'R0001', 'R0002', 'ACTIVE_GATE']) {
    assert.equal(core.includes(token), false, `core must not mention ${token}`);
  }
  // No revision id is hardcoded in the preflight or the mission source either.
  const preflightSource = fs.readFileSync(path.join(REPO_ROOT, 'governance/tools/governance-preflight.mjs'), 'utf8');
  const missionSource = fs.readFileSync(path.join(HERE, '..', 'adapters', 'gee-mission-authority-source.mjs'), 'utf8');
  for (const source of [preflightSource, missionSource]) {
    assert.equal(source.includes(R2_ID), false);
    assert.equal(/workUnitId\s*===\s*['"]R2/.test(source), false);
  }
});
