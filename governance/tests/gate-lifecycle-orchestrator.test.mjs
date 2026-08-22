/**
 * Focused tests for GATE_LIFECYCLE_ORCHESTRATOR.
 *
 * The claim under test is that mechanical lifecycle plumbing can be derived
 * deterministically instead of assembled by hand, and that a candidate which
 * would be rejected never reaches the canonical bytes. Both halves are easy to
 * fake, so these tests are written against the failure modes:
 *
 *   - ATOMICITY is proven by taking the canonical ledger's digest before and
 *     after a deliberately broken candidate, not by reading a status field that
 *     claims nothing was written;
 *   - IDEMPOTENCE is proven against the REAL ledger at HEAD, where GATE16 and
 *     GATE17 have already made every transition once, so a duplicate is a real
 *     duplicate rather than a fixture's idea of one;
 *   - DETERMINISM is proven by rewinding GATE17 to its post-START state in a
 *     scratch copy and re-deriving the AGENT_CLOSURE that was originally built
 *     by hand, then comparing identities.
 *
 * Real modules throughout. Every hostile case operates on a scratch copy under
 * the OS temp directory; the real repository is read but never mutated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ORCHESTRATED_TRANSITIONS, ORCHESTRATOR_DOCUMENT, LEDGER_PATH,
  applyCandidate, collectBaselineIntegrity, deriveCandidateTransition, governedBytes,
  ledgerLineBytes, replayGateStatus, readLedgerEvents, resolveTargetStatus,
  runLifecycleTransition, summarizeCandidate, validateCandidateInStagingRoot, evaluateTransitionAuthority
} from '../tools/gate-lifecycle-orchestrator.mjs';
import { sha256Bytes } from '../tools/canonical-json.mjs';
import { collectPostFreezeMaintenanceObservation } from '../tools/post-freeze-maintenance-observation.mjs';
import { validateLifecycleTransactionProvenance } from '../tools/transaction-provenance.mjs';
import { computeSealedMembersDigest } from '../tools/validate-state-seal.mjs';
import {
  computeGateAuthorizationBindingDigest,
  computeGateAuthorizationLocalRequestDigest
} from '../gee-v1/core/gate-authorization-authority.mjs';
import {
  computeGateStartBindingDigestFromDigests,
  computeGateStartLocalRequestDigest,
  computeGateStartReadinessDigest,
  computeGateStartRecordDigest
} from '../gee-v1/core/gate-start-authority.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

const REPO_ROOT = process.env.WHEEL_LIVE_REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANDIDATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GATE17_AGENT_CLOSURE_AUTHORITY =
  'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE17_AGENT_CLOSURE_R1.json';

function overlayCandidateProduction(dir) {
  for (const rel of [
    'governance/tools/generate-status-snapshot.mjs',
    'governance/tools/gate-lifecycle-orchestrator.mjs',
    'governance/tools/post-freeze-maintenance-observation.mjs'
  ]) {
    fs.copyFileSync(path.join(CANDIDATE_ROOT, ...rel.split('/')), path.join(dir, ...rel.split('/')));
  }
}

function scratchRoot(label) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `gate-lifecycle-${label}-`));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  overlayCandidateProduction(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '--', 'governance'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=gate-lifecycle-test', '-c', 'user.email=gate-lifecycle-test@example.invalid', 'commit', '--quiet', '-m', 'scratch baseline'], { cwd: root });
  return root;
}

function discard(root) { fs.rmSync(root, { recursive: true, force: true }); }

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

function writeJson(root, relative, value) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, governedBytes(value));
}

function readBytes(root, relative) {
  return fs.readFileSync(path.join(root, ...relative.split('/')));
}

function artifact(root, relative, cohortRole = null) {
  const bytes = readBytes(root, relative);
  return { ...(cohortRole ? { cohortRole } : {}), repoRelativePath: relative, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

function ledgerIdentity(root) {
  const bytes = readBytes(root, LEDGER_PATH);
  const events = readLedgerEvents(root);
  return {
    sha256: sha256Bytes(bytes),
    previousEventSha256: events.at(-1)?.eventPayloadSha256 ?? null,
    count: events.length
  };
}

/**
 * The next lawful recordedAt for a synthetic transition on `root`: five minutes
 * after whatever the ledger head already records.
 *
 * A literal instant is only correct until real history passes it. Once it does,
 * the ledger validator refuses the candidate with LEDGER_TIMESTAMP_REGRESSION
 * and the synthetic fixture aborts during SETUP — taking every hostile case
 * built on top of it out of the run without failing any of them individually,
 * which is the most expensive way a test suite can lie. Deriving the instant
 * from the head keeps the synthetic sequence strictly increasing however far
 * canonical history has advanced.
 */
function nextInstant(root, steps = 1) {
  const head = readLedgerEvents(root).at(-1);
  return new Date(Date.parse(head.recordedAt) + steps * 5 * 60 * 1000).toISOString();
}

/** A validity window that always contains the derived instant it is issued at. */
function windowEnd(recordedAt) {
  return new Date(Date.parse(recordedAt) + 365 * 24 * 60 * 60 * 1000).toISOString();
}

function syntheticGateContract(root, gateId) {
  const contractPath = `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`;
  const contract = {
    gateId,
    contractRevision: 'R0001',
    authorizedPaths: [`governance/gates/${gateId}/implementation/SYNTHETIC_FUTURE_GATE.md`]
  };
  writeJson(root, contractPath, contract);
  const pointerPath = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  writeJson(root, pointerPath, {
    schemaVersion: 1, gateId, contractRevision: 'R0001', contractPath,
    contractSha256: sha256Bytes(readBytes(root, contractPath)), activatedByEventId: null
  });
  return { contractPath, pointerPath };
}

function futureAuthorizationInputs(root, gateId, eventId, recordedAt) {
  const recordPath = `governance/authority/authorizations/${gateId}/GATE_AUTHORIZATION_RECORD.json`;
  const authorityPath = `governance/authority/authorizations/${gateId}/PROJECT_OWNER_GATE_AUTHORIZATION_AUTHORITY.json`;
  writeJson(root, recordPath, { placeholder: true });
  writeJson(root, authorityPath, { placeholder: true });
  const { contractPath, pointerPath } = syntheticGateContract(root, gateId);
  const initial = deriveCandidateTransition({ root, gateId, transitionType: 'AUTHORIZATION', eventId, authorityPath: recordPath, recordedAt });
  assert.equal(initial.status, 'DERIVED', JSON.stringify(initial.findings));
  const byPath = new Map(initial.candidate.writes.map((write) => [write.path, write]));
  const dependency = readLedgerEvents(root).filter((event) => event.gateId === 'GATE17').at(-1);
  const stateArtifacts = [
    artifactFromCandidate(byPath, initial.candidate.paths.currentState, 'CURRENT_STATE'),
    artifactFromCandidate(byPath, initial.candidate.paths.checkpoint, 'CHECKPOINT'),
    artifactFromCandidate(byPath, initial.candidate.paths.openDefects, 'OPEN_DEFECTS'),
    artifactFromCandidate(byPath, initial.candidate.paths.seal, 'STATE_SEAL')
  ];
  const derivedPaths = [
    ['GATE_STATUS_SNAPSHOT', 'governance/state/generated/GATE_STATUS_SNAPSHOT.json'],
    ['ACTIVE_GATE', 'governance/active/ACTIVE_GATE.json'],
    ['ACTIVE_GATE_CONTEXT_JSON', 'governance/generated/ACTIVE_GATE_CONTEXT.json'],
    ['ACTIVE_GATE_CONTEXT_MD', 'governance/generated/ACTIVE_GATE_CONTEXT.md']
  ];
  const identity = ledgerIdentity(root);
  const record = {
    schemaVersion: 1, authorityMode: 'LOCAL_EXPLICIT_AUTHORITY', document: 'GATE_AUTHORIZATION_RECORD',
    authorizationId: `GATE_AUTHORIZATION_${gateId}_SYNTHETIC_R1`, projectId: 'WHEEL', gateId,
    purpose: 'GATE_NORMAL_AUTHORIZATION', transitionType: 'AUTHORIZATION', fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED', recordedAt,
    baseCommit: '90abb16c8435512eb2d53ea9f4cde84ceb2201b8', preLedgerSha256: identity.sha256, previousEventSha256: identity.previousEventSha256,
    contractSha256: sha256Bytes(readBytes(root, contractPath)), currentContractSha256: sha256Bytes(readBytes(root, pointerPath)),
    dependencyProof: { gateId: 'GATE17', status: 'COMPLETE_CONFIRMED', authorityPath: dependency.authorityPath, authoritySha256: dependency.authoritySha256 },
    stateRevision: 'R0001', authorizedStateArtifacts: stateArtifacts,
    authorizedDerivedArtifacts: derivedPaths.map(([cohortRole, repoRelativePath]) => ({ cohortRole, repoRelativePath })),
    prohibitedOperations: ['START', 'GATE_EXECUTION', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_CONFIRMED', 'ARBITRARY_LEDGER_TRANSITION', 'LEDGER_REWRITE', 'GIT_PUSH', 'ARBITRARY_GOVERNANCE_WRITE', 'OTHER_GATE', 'GEE_REVISION_CREATION'],
    executionAuthorized: false, reason: 'Scratch-only future LOCAL_EXPLICIT_AUTHORITY authorization.'
  };
  const { document, authorizationId, recordedAt: recordRecordedAt, prohibitedOperations, reason, ...authorityCore } = record;
  const authority = {
    ...authorityCore, documentKind: 'ACTIVE_GATE_AUTHORIZATION_AUTHORITY', authorityId: `ACTIVE_GATE_AUTHORIZATION_AUTHORITY_${gateId}_SYNTHETIC_R1`,
    issuedBy: 'PROJECT_OWNER', issuedAtUtc: recordedAt, expiresAtUtc: windowEnd(recordedAt),
    authorizedDerivedArtifacts: derivedPaths.map(([cohortRole, repoRelativePath]) => ({ cohortRole, ...artifact(root, repoRelativePath) })),
    bindingDigestAlgorithm: 'SHA256_CANONICAL_JSON_GATE_AUTHORIZATION_BINDING_V1', maxUse: 1
  };
  authority.approvedBindingDigest = computeGateAuthorizationBindingDigest({ ...authority, recordedAt, stateArtifacts, derivedArtifacts: authority.authorizedDerivedArtifacts }).digest;
  authority.approvedRequestDigest = computeGateAuthorizationLocalRequestDigest(authority);
  writeJson(root, recordPath, record);
  writeJson(root, authorityPath, authority);
  return { recordPath, authorityPath };
}

function artifactFromCandidate(byPath, relative, cohortRole) {
  const write = byPath.get(relative);
  assert.ok(write, `candidate must contain ${relative}`);
  return { cohortRole, repoRelativePath: relative, sha256: write.sha256, byteLength: write.byteLength };
}

function futureStartInputs(root, gateId, eventId, recordedAt) {
  const recordPath = `governance/authority/authorizations/${gateId}/GATE_START_RECORD.json`;
  const authorityPath = `governance/authority/authorizations/${gateId}/PROJECT_OWNER_GATE_START_AUTHORITY.json`;
  writeJson(root, recordPath, { placeholder: true });
  writeJson(root, authorityPath, { placeholder: true });
  const initial = deriveCandidateTransition({ root, gateId, transitionType: 'START', eventId, authorityPath: recordPath, recordedAt });
  assert.equal(initial.status, 'DERIVED', JSON.stringify(initial.findings));
  const identity = ledgerIdentity(root);
  const contractPath = `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`;
  const pointerPath = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const preStatePath = `governance/gates/${gateId}/state/CURRENT_STATE.json`;
  const preState = readJson(root, preStatePath);
  const preSealPath = `governance/gates/${gateId}/state/revisions/${preState.stateRevision}/STATE_SEAL.json`;
  const dependency = readLedgerEvents(root).filter((event) => event.gateId === 'GATE17').at(-1);
  const active = artifact(root, 'governance/active/ACTIVE_GATE.json');
  const record = {
    schemaVersion: 1, authorityMode: 'LOCAL_EXPLICIT_AUTHORITY', document: 'GATE_START_RECORD', recordId: `${gateId}_START_RECORD_SYNTHETIC_R1`,
    projectId: 'WHEEL', gateId, purpose: 'START_PLUS_EXECUTION_AUTHORITY', eventId, transitionType: 'START', fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS', recordedAt,
    baseCommit: '90abb16c8435512eb2d53ea9f4cde84ceb2201b8', preStartLedgerSha256: identity.sha256, previousEventSha256: identity.previousEventSha256,
    contractSha256: sha256Bytes(readBytes(root, contractPath)), currentContractSha256: sha256Bytes(readBytes(root, pointerPath)),
    preStateRevision: preState.stateRevision, preCurrentStateSha256: sha256Bytes(readBytes(root, preStatePath)), preStateSealSha256: sha256Bytes(readBytes(root, preSealPath)),
    dependencyProof: { gateId: 'GATE17', status: 'COMPLETE_CONFIRMED', authorityPath: dependency.authorityPath, authoritySha256: dependency.authoritySha256 },
    activeGatePreState: { activeGate: readJson(root, 'governance/active/ACTIVE_GATE.json').activeGate, sha256: active.sha256, byteLength: active.byteLength },
    authorizedStartWritePaths: [recordPath, authorityPath, LEDGER_PATH, initial.candidate.paths.checkpoint, initial.candidate.paths.openDefects, initial.candidate.paths.seal, initial.candidate.paths.currentState, 'governance/state/generated/GATE_STATUS_SNAPSHOT.json', 'governance/generated/ACTIVE_GATE_CONTEXT.json', 'governance/generated/ACTIVE_GATE_CONTEXT.md'],
    functionalExecutionScope: readJson(root, contractPath).authorizedPaths,
    expiresAtUtc: '2026-12-31T23:59:59.000Z', maxUse: 1,
    prohibitedOperations: ['AUTHORIZATION', 'SECOND_START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_CONFIRMED', 'OTHER_GATE', 'GEE_REVISION_CREATION', 'ARBITRARY_LEDGER_TRANSITION', 'LEDGER_REWRITE', 'ARBITRARY_GOVERNANCE_WRITE', 'GIT_PUSH'],
    startAuthorized: true, executionAuthorized: true
  };
  record.readinessDigest = computeGateStartReadinessDigest({
    projectId: record.projectId, gateId, status: record.fromStatus, preStartLedgerSha256: record.preStartLedgerSha256,
    previousEventSha256: record.previousEventSha256, preStateRevision: record.preStateRevision,
    preCurrentStateSha256: record.preCurrentStateSha256, preStateSealSha256: record.preStateSealSha256,
    openDefectsKnowledge: 'KNOWN_ZERO', contractSha256: record.contractSha256, currentContractSha256: record.currentContractSha256,
    dependencyProof: record.dependencyProof, readinessVerdict: 'READY'
  });
  record.recordDigest = computeGateStartRecordDigest(record);
  const { document, recordId, ...authorityCore } = record;
  const authority = { ...authorityCore, documentKind: 'PROJECT_OWNER_GATE_START_AUTHORITY', authorityId: `${gateId}_START_AUTHORITY_SYNTHETIC_R1`, issuedBy: 'PROJECT_OWNER', issuedAtUtc: recordedAt };
  authority.requestDigest = computeGateStartLocalRequestDigest(authority);
  authority.bindingDigest = computeGateStartBindingDigestFromDigests({ requestDigest: authority.requestDigest, recordDigest: record.recordDigest });
  writeJson(root, recordPath, record);
  writeJson(root, authorityPath, authority);
  return { recordPath, authorityPath };
}

function futureMaintenanceInputs(root, gateId, transitionType, eventId, recordedAt, { policy = null, externalReportPath = null, authorityPredecessor = null, lifecycleAuthorityPath = null } = {}) {
  const stem = `${gateId}_SYNTHETIC_${transitionType}_R1`;
  const authorityPath = `governance/sources/${stem}_LOCAL_AUTHORITY.json`;
  const manifestPath = `governance/sources/${stem}_AUTHORIZED_PATHS.json`;
  writeJson(root, authorityPath, { placeholder: true });
  const initial = deriveCandidateTransition({ root, policy: policy ?? WHEEL_EXTERNAL_AUTHORITY_POLICY, gateId, transitionType, eventId, authorityPath: lifecycleAuthorityPath ?? authorityPath, recordedAt });
  assert.equal(initial.status, 'DERIVED', JSON.stringify(initial.findings));
  const manifest = {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORIZED_PATH_MANIFEST', schemaVersion: 1,
    manifestId: `${stem}_AUTHORIZED_PATHS`, programId: `${stem}_PROGRAM`,
    paths: [...initial.candidate.writes.map((write) => write.path), 'governance/state/generated/GATE_STATUS_SNAPSHOT.json', externalReportPath]
      .filter(Boolean)
      .sort().map((candidatePath) => ({
        path: candidatePath,
        operation: candidatePath.endsWith('CURRENT_STATE.json') || candidatePath === LEDGER_PATH || candidatePath.includes('/generated/') ? 'MODIFY' : 'CREATE',
        phase: transitionType, reason: 'Scratch-only exact local authority cohort.', artifactClass: transitionType
      }))
  };
  writeJson(root, manifestPath, manifest);
  const identity = ledgerIdentity(root);
  const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const current = readJson(root, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  const authority = {
    document: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY', schemaVersion: 2,
    authorityId: `${stem}_LOCAL_AUTHORITY`, authorityClass: 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY', authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER', createdAt: recordedAt, expiresAt: windowEnd(recordedAt), targetSystem: 'PROJECT_GOVERNANCE',
    programId: `${stem}_PROGRAM`, authorityPurpose: transitionType === 'EXTERNAL_CONFIRMATION' ? 'GATE_EXTERNAL_CONFIRMATION' : 'GATE_FINAL_CLOSURE', resumePoint: `${gateId}_${transitionType}`, maxUse: 1,
    preState: {
      baseHead, ledgerEventCount: identity.count, ledgerPrefixSha256: identity.sha256,
      gateId, gateStatus: replayGateStatus(readLedgerEvents(root)).get(gateId), stateRevision: current.stateRevision,
      contractRevision: readJson(root, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`).contractRevision,
      activeGate: readJson(root, 'governance/active/ACTIVE_GATE.json').activeGate, R8ExpectedAbsent: true
    },
    authorizedPathManifestPath: manifestPath, authorizedPathManifestSha256: sha256Bytes(readBytes(root, manifestPath)),
    authorizedOperationClasses: [transitionType],
    commitPolicy: { maxCommitCount: 1, allowedGitOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'], commitMessage: `synthetic ${transitionType}`, thirdCommitAuthorized: false },
    pushAuthorized: false, authorityPredecessor, authorityHeadBinding: { mode: 'BASE_HEAD', baseHead },
    consumptionRecordPath: `governance/sources/${stem}_CONSUMPTION.json`,
    prohibitedOperations: ['START', 'SECOND_START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'ACTIVE_GATE_SWITCH', 'GEE_R8', 'GIT_PUSH', 'HISTORY_REWRITE', 'THIRD_COMMIT', 'UNRELATED_WRITE']
  };
  if (externalReportPath) {
    authority.externalReinspectionReportPath = externalReportPath;
    authority.externalReinspectionReportSha256 = sha256Bytes(readBytes(root, externalReportPath));
  }
  writeJson(root, authorityPath, authority);
  return { authorityPath };
}

function syntheticExternalPolicy(gateId, authorityId, reportPath, reportSha256, programId) {
  return {
    extraExternalAuthorities: [...WHEEL_EXTERNAL_AUTHORITY_POLICY.extraExternalAuthorities, {
      authorityId, classification: 'EXTERNAL_REINSPECTION_REPORT', path: reportPath, sha256: reportSha256,
      gateId, programId, reportShape: 'SYNTHETIC_EXTERNAL_REINSPECTION_REPORT'
    }],
    assertExternalReinspectionVerdict({ event, report, authorityId: observedAuthorityId }) {
      if (observedAuthorityId === authorityId) {
        return event?.gateId === gateId && report?.document === 'EXTERNAL_REINSPECTION_REPORT'
          && report?.gateId === gateId && report?.verdict === 'PASS' && report?.independentSession === true && report?.programId === programId;
      }
      return WHEEL_EXTERNAL_AUTHORITY_POLICY.assertExternalReinspectionVerdict({ event, report, authorityId: observedAuthorityId });
    }
  };
}

function syntheticExternalPolicyModule(root, gateId, authorityId, reportPath, reportSha256, programId) {
  const relative = `governance/sources/${gateId}_SYNTHETIC_EXTERNAL_POLICY.mjs`;
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';
const authorityId = ${JSON.stringify(authorityId)};
const gateId = ${JSON.stringify(gateId)};
const programId = ${JSON.stringify(programId)};
export default {
  extraExternalAuthorities: [...WHEEL_EXTERNAL_AUTHORITY_POLICY.extraExternalAuthorities, {
    authorityId, classification: 'EXTERNAL_REINSPECTION_REPORT', path: ${JSON.stringify(reportPath)}, sha256: ${JSON.stringify(reportSha256)}, gateId, programId, reportShape: 'SYNTHETIC_EXTERNAL_REINSPECTION_REPORT'
  }],
  assertExternalReinspectionVerdict({ event, report, authorityId: observedAuthorityId }) {
    if (observedAuthorityId === authorityId) return event?.gateId === gateId && report?.document === 'EXTERNAL_REINSPECTION_REPORT' && report?.gateId === gateId && report?.verdict === 'PASS' && report?.independentSession === true && report?.programId === programId;
    return WHEEL_EXTERNAL_AUTHORITY_POLICY.assertExternalReinspectionVerdict({ event, report, authorityId: observedAuthorityId });
  }
};
`);
  return relative;
}

function enterSyntheticFutureGate(root, staging, gateId = 'GATE18') {
  const authorizedAt = nextInstant(root);
  const authorization = futureAuthorizationInputs(root, gateId, `${gateId}_SYNTHETIC_AUTHORIZATION_R1`, authorizedAt);
  const authorized = runLifecycleTransition({
    root, stagingRoot: staging, gateId, transitionType: 'AUTHORIZATION', eventId: `${gateId}_SYNTHETIC_AUTHORIZATION_R1`,
    authorityPath: authorization.recordPath, recordedAt: authorizedAt
  });
  assert.equal(authorized.result, 'APPLIED', JSON.stringify(authorized.findings));
  const startedAt = nextInstant(root);
  const start = futureStartInputs(root, gateId, `${gateId}_SYNTHETIC_START_R1`, startedAt);
  const started = runLifecycleTransition({
    root, stagingRoot: staging, gateId, transitionType: 'START', eventId: `${gateId}_SYNTHETIC_START_R1`,
    authorityPath: start.recordPath, recordedAt: startedAt
  });
  assert.equal(started.result, 'APPLIED', JSON.stringify(started.findings));
}

function syntheticAuthorizedClosure(root, staging, gateId = 'GATE18') {
  enterSyntheticFutureGate(root, staging, gateId);
  const closedAt = nextInstant(root);
  const closure = futureMaintenanceInputs(root, gateId, 'AGENT_CLOSURE', `${gateId}_SYNTHETIC_AGENT_CLOSURE_R1`, closedAt);
  const derived = deriveCandidateTransition({ root, gateId, transitionType: 'AGENT_CLOSURE', eventId: `${gateId}_SYNTHETIC_AGENT_CLOSURE_R1`, authorityPath: closure.authorityPath, recordedAt: closedAt });
  assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
  assert.equal(validateCandidateInStagingRoot({ root, candidate: derived.candidate, stagingRoot: staging }).valid, true);
  const authority = evaluateTransitionAuthority({ root, candidate: derived.candidate, authorityDocumentPath: closure.authorityPath });
  assert.equal(authority.decision, 'AUTHORIZED', JSON.stringify(authority.findings));
  const request = { gateId, transitionType: 'AGENT_CLOSURE', eventId: `${gateId}_SYNTHETIC_AGENT_CLOSURE_R1`, authorityPath: closure.authorityPath, authorityDocumentPath: closure.authorityPath, recordedAt: closedAt };
  return { candidate: derived.candidate, authority, request };
}

/**
 * Rewinds a scratch copy to GATE17's state immediately after START: ledger
 * truncated to ordinal 71, revisions R0003/R0004 removed, CURRENT_STATE pointing
 * at R0002. This is the exact pre-state the hand-built AGENT_CLOSURE acted on.
 */
function rewindGate17ToPostStart(root) {
  fs.rmSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0004'), { recursive: true, force: true });
  const ledgerFile = path.join(root, ...LEDGER_PATH.split('/'));
  const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(ledgerFile, `${lines.slice(0, 71).join('\n')}\n`);
  fs.writeFileSync(
    path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      gateId: 'GATE17',
      stateRevision: 'R0002',
      revisionPath: 'governance/gates/GATE17/state/revisions/R0002',
      stateSealSha256: '9f9f4cf466a7b0be18919dfe72c9fb4c9babe5d9efe150c866dc7f0eab914c52',
      committedByTransactionId: 'GATE17_START_R1_TRANSACTION'
    }, null, 2)}\n`
  );
  return JSON.parse(lines[71]);
}

/** The AGENT_CLOSURE request that reproduces GATE17's historical transition. */
function gate17ClosureRequest(historicalCheckpoint) {
  return {
    gateId: 'GATE17',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_AGENT_CLOSURE_R1',
    authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
    recordedAt: '2026-08-14T19:35:00.000Z',
    sealedAt: '2026-08-14T19:30:00.000Z',
    sealedMemberOrder: ['CHECKPOINT', 'OPEN_DEFECTS', 'CURRENT_CONTRACT'],
    checkpoint: {
      milestone: historicalCheckpoint.milestone,
      resumePoint: historicalCheckpoint.resumePoint,
      completedTasks: historicalCheckpoint.completedTasks,
      openTasks: historicalCheckpoint.openTasks,
      reusableEvidence: historicalCheckpoint.reusableEvidence,
      invalidatedEvidence: historicalCheckpoint.invalidatedEvidence,
      requiredNextActions: historicalCheckpoint.requiredNextActions,
      protectedHashes: historicalCheckpoint.protectedHashes,
      createdAt: historicalCheckpoint.createdAt
    }
  };
}

function alignGate17MaintenanceAuthorityToScratch(root) {
  const authority = readJson(root, GATE17_AGENT_CLOSURE_AUTHORITY);
  const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  authority.preState.baseHead = baseHead;
  authority.authorityHeadBinding.baseHead = baseHead;
  writeJson(root, GATE17_AGENT_CLOSURE_AUTHORITY, authority);
  return GATE17_AGENT_CLOSURE_AUTHORITY;
}

function rewindGate17ToHistoricalPrestate(root, throughOrdinal, revision) {
  const revisions = path.join(root, 'governance/gates/GATE17/state/revisions');
  for (let ordinal = (revision ?? 0) + 1; ordinal <= 4; ordinal += 1) {
    fs.rmSync(path.join(revisions, `R${String(ordinal).padStart(4, '0')}`), { recursive: true, force: true });
  }
  const ledgerFile = path.join(root, ...LEDGER_PATH.split('/'));
  const lines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(ledgerFile, `${lines.slice(0, throughOrdinal).join('\n')}\n`);
  const currentPath = path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json');
  if (revision === null) {
    fs.rmSync(currentPath, { force: true });
  } else {
    const event = JSON.parse(lines[throughOrdinal - 1]);
    fs.writeFileSync(currentPath, `${JSON.stringify({
      schemaVersion: 1, gateId: 'GATE17', stateRevision: `R${String(revision).padStart(4, '0')}`,
      revisionPath: `governance/gates/GATE17/state/revisions/R${String(revision).padStart(4, '0')}`,
      stateSealSha256: event.stateRevisionSealSha256, committedByTransactionId: `${event.eventId}_TRANSACTION`
    }, null, 2)}\n`);
  }
  return JSON.parse(lines[throughOrdinal]);
}

function historicalLifecycleRequest(event) {
  const revision = event.stateRevision;
  const checkpoint = readJson(REPO_ROOT, `governance/gates/GATE17/state/revisions/${revision}/CHECKPOINT.json`);
  const defects = readJson(REPO_ROOT, `governance/gates/GATE17/state/revisions/${revision}/OPEN_DEFECTS.json`);
  const seal = readJson(REPO_ROOT, `governance/gates/GATE17/state/revisions/${revision}/STATE_SEAL.json`);
  const prefix = `governance/gates/GATE17/state/revisions/${revision}/`;
  const sealedMemberOrder = seal.sealedMembers.map((member) => {
    if (member.repoRelativePath === `${prefix}CHECKPOINT.json`) return 'CHECKPOINT';
    if (member.repoRelativePath === `${prefix}OPEN_DEFECTS.json`) return 'OPEN_DEFECTS';
    if (member.repoRelativePath === 'governance/gates/GATE17/contracts/CURRENT_CONTRACT.json') return 'CURRENT_CONTRACT';
    return member.repoRelativePath;
  });
  return {
    gateId: 'GATE17', transitionType: event.transitionType, eventId: event.eventId,
    authorityPath: event.authorityPath, recordedAt: event.recordedAt, sealedAt: seal.sealedAt,
    sealedMemberOrder, openDefects: defects.defects,
    checkpoint: {
      milestone: checkpoint.milestone, resumePoint: checkpoint.resumePoint, completedTasks: checkpoint.completedTasks,
      openTasks: checkpoint.openTasks, reusableEvidence: checkpoint.reusableEvidence,
      invalidatedEvidence: checkpoint.invalidatedEvidence, requiredNextActions: checkpoint.requiredNextActions,
      protectedHashes: checkpoint.protectedHashes, createdAt: checkpoint.createdAt
    }
  };
}

/**
 * Historical AUTHORIZATION and START cannot be re-derived from semantic fields:
 * their legacy authorities bind the exact original revision bytes.  This helper
 * deliberately treats those repository bytes as pre-materialized transaction
 * inputs, while the generic staging validator remains the consumer.
 */
function preMaterializedHistoricalCandidate(root, eventOrdinal) {
  const sourceLines = fs.readFileSync(path.join(REPO_ROOT, ...LEDGER_PATH.split('/')), 'utf8').split('\n').filter(Boolean);
  const event = JSON.parse(sourceLines[eventOrdinal - 1]);
  const revisionDirectory = `governance/gates/${event.gateId}/state/revisions/${event.stateRevision}`;
  const paths = {
    ledger: LEDGER_PATH,
    seal: `${revisionDirectory}/STATE_SEAL.json`,
    currentState: `governance/gates/${event.gateId}/state/CURRENT_STATE.json`,
    checkpoint: `${revisionDirectory}/CHECKPOINT.json`,
    openDefects: `${revisionDirectory}/OPEN_DEFECTS.json`,
    revisionDirectory
  };
  const sourceStateBytes = (relative) => fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')));
  const sealBytes = sourceStateBytes(paths.seal);
  const exactHistoricalCurrentState = governedBytes({
    schemaVersion: 1,
    gateId: event.gateId,
    stateRevision: event.stateRevision,
    revisionPath: revisionDirectory,
    stateSealSha256: sha256Bytes(sealBytes),
    committedByTransactionId: `${event.eventId}_TRANSACTION`
  });
  const writes = new Map([
    [paths.ledger, Buffer.from(`${sourceLines.slice(0, eventOrdinal).join('\n')}\n`, 'utf8')],
    [paths.seal, sealBytes],
    [paths.checkpoint, sourceStateBytes(paths.checkpoint)],
    [paths.openDefects, sourceStateBytes(paths.openDefects)],
    // CURRENT_STATE is the historical mutable pointer; its exact R000N form is
    // deterministically pinned by the immutable historical seal and event id.
    [paths.currentState, exactHistoricalCurrentState]
  ]);
  return {
    document: ORCHESTRATOR_DOCUMENT,
    version: 'R1',
    gateId: event.gateId,
    transitionType: event.transitionType,
    eventId: event.eventId,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    stateRevision: event.stateRevision,
    ordinal: event.ordinal,
    event,
    paths,
    writes: [...writes].map(([relativePath, bytes]) => ({
      path: relativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length, bytes
    })).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  };
}

/* -------------------------------------------------------------------------
 * Shape and reuse
 * ---------------------------------------------------------------------- */

test('the orchestrator automates exactly the four mechanical transitions and no others', () => {
  assert.deepEqual([...ORCHESTRATED_TRANSITIONS].sort(),
    ['AGENT_CLOSURE', 'AUTHORIZATION', 'EXTERNAL_CONFIRMATION', 'START']);
  // Transitions carrying judgement are deliberately absent rather than
  // half-supported: a partly automated SUPERSESSION is worse than a manual one.
  for (const judgement of ['SUPERSESSION', 'EXTERNAL_REJECTION', 'AUTHORIZED_REOPEN', 'DEFECT_OPENED', 'INTERRUPTION']) {
    assert.ok(!ORCHESTRATED_TRANSITIONS.includes(judgement), `${judgement} must stay manual`);
  }
});

test('target status is read from the canonical transition table, not restated', () => {
  assert.equal(resolveTargetStatus('NOT_STARTED', 'AUTHORIZATION'), 'AUTHORIZED_NOT_STARTED');
  assert.equal(resolveTargetStatus('AUTHORIZED_NOT_STARTED', 'START'), 'IN_PROGRESS');
  assert.equal(resolveTargetStatus('IN_PROGRESS', 'AGENT_CLOSURE'), 'COMPLETE_AGENT');
  assert.equal(resolveTargetStatus('COMPLETE_AGENT', 'EXTERNAL_CONFIRMATION'), 'COMPLETE_CONFIRMED');
  // A transition the table does not admit has no target, and therefore no
  // candidate can be derived for it.
  assert.equal(resolveTargetStatus('COMPLETE_CONFIRMED', 'AGENT_CLOSURE'), null);
  assert.equal(resolveTargetStatus('NOT_STARTED', 'START'), null);
});

test('HIST_AUTH_POSITIVE and HIST_START_POSITIVE consume exact historical transaction bytes without regenerating signatures', () => {
  for (const fixture of [
    { throughOrdinal: 69, revision: null, eventOrdinal: 70, transition: 'AUTHORIZATION' },
    { throughOrdinal: 70, revision: 1, eventOrdinal: 71, transition: 'START' }
  ]) {
    const root = scratchRoot(`positive-${fixture.transition.toLowerCase()}`);
    const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
    try {
      const event = rewindGate17ToHistoricalPrestate(root, fixture.throughOrdinal, fixture.revision);
      assert.equal(event.ordinal, fixture.eventOrdinal);
      const candidate = preMaterializedHistoricalCandidate(root, fixture.eventOrdinal);
      assert.equal(candidate.event.eventPayloadSha256, event.eventPayloadSha256);
      const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
      assert.equal(validation.valid, true, JSON.stringify(validation.findings, null, 2));
      assert.equal(validation.reports.introducedBlockingLedgerFindingCount, 0);
      assert.ok(validation.reports.introducedInformationalLedgerFindingCount >= 1);
      for (const write of candidate.writes.filter((write) => write.path.includes('/state/revisions/'))) {
        assert.equal(
          sha256Bytes(write.bytes),
          sha256Bytes(fs.readFileSync(path.join(REPO_ROOT, ...write.path.split('/')))),
          `${fixture.transition} must consume the immutable historical ${write.path} bytes`
        );
      }
    } finally { discard(root); discard(staging); }
  }
});

test('historical GATE17 EXTERNAL_CONFIRMATION retains its logical authority identity and validates', () => {
  const root = scratchRoot('positive-external-confirmation');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const event = rewindGate17ToHistoricalPrestate(root, 72, 3);
    const request = historicalLifecycleRequest(event);
    const derived = deriveCandidateTransition({ root, ...request });
    assert.equal(derived.status, 'DERIVED', JSON.stringify(derived.findings));
    assert.equal(derived.candidate.event.authorityPath, event.authorityPath);
    assert.equal(derived.candidate.event.authoritySha256, event.authoritySha256);
    const validation = validateCandidateInStagingRoot({ root, candidate: derived.candidate, stagingRoot: staging });
    assert.equal(validation.valid, true, JSON.stringify(validation.findings, null, 2));
    assert.equal(derived.candidate.toStatus, 'COMPLETE_CONFIRMED');
  } finally { discard(root); discard(staging); }
});

test('A1: AGENT_CLOSURE without maintenance authority is blocked before canonical publication', () => {
  const root = scratchRoot('authority-omission');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const checkpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const before = sha256Bytes(readBytes(root, LEDGER_PATH));
    const result = runLifecycleTransition({ root, stagingRoot: staging, ...gate17ClosureRequest(checkpoint) });
    assert.equal(result.result, 'BLOCKED');
    assert.equal(result.authority.decision, 'BLOCKED');
    assert.ok(result.findings.some((finding) => finding.code === 'MAINTENANCE_AUTHORITY_REQUIRED'));
    assert.equal(sha256Bytes(readBytes(root, LEDGER_PATH)), before);
  } finally { discard(root); discard(staging); }
});

test('A2: partial AGENT_CLOSURE authority is blocked against the final projected cohort', () => {
  const root = scratchRoot('partial-closure-authority');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    enterSyntheticFutureGate(root, staging);
    const closedAt = nextInstant(root);
    const closure = futureMaintenanceInputs(root, 'GATE18', 'AGENT_CLOSURE', 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1', closedAt);
    const authority = readJson(root, closure.authorityPath);
    const manifest = readJson(root, authority.authorizedPathManifestPath);
    manifest.paths.pop();
    writeJson(root, authority.authorizedPathManifestPath, manifest);
    const before = sha256Bytes(readBytes(root, LEDGER_PATH));
    const result = runLifecycleTransition({
      root, stagingRoot: staging, gateId: 'GATE18', transitionType: 'AGENT_CLOSURE', eventId: 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1',
      authorityPath: closure.authorityPath, authorityDocumentPath: closure.authorityPath, recordedAt: closedAt
    });
    assert.equal(result.result, 'BLOCKED');
    assert.equal(result.authority.decision, 'BLOCKED');
    assert.ok(result.findings.some((finding) => finding.code === 'AUTHORIZED_MANIFEST_SHA_MISMATCH' || finding.code === 'PATH_NOT_AUTHORIZED'));
    assert.equal(sha256Bytes(readBytes(root, LEDGER_PATH)), before);
  } finally { discard(root); discard(staging); }
});

test('A5: partial EXTERNAL_CONFIRMATION authority is blocked before publication', () => {
  const root = scratchRoot('partial-confirmation-authority');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    enterSyntheticFutureGate(root, staging);
    const closedAt = nextInstant(root);
    const closure = futureMaintenanceInputs(root, 'GATE18', 'AGENT_CLOSURE', 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1', closedAt);
    assert.equal(runLifecycleTransition({ root, stagingRoot: staging, gateId: 'GATE18', transitionType: 'AGENT_CLOSURE', eventId: 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1', authorityPath: closure.authorityPath, authorityDocumentPath: closure.authorityPath, recordedAt: closedAt }).result, 'APPLIED');
    const reportPath = 'governance/sources/GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_R1.json';
    const externalAuthorityId = 'GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_R1';
    const programId = 'GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_PROGRAM';
    writeJson(root, reportPath, { document: 'EXTERNAL_REINSPECTION_REPORT', gateId: 'GATE18', verdict: 'PASS', independentSession: true, programId });
    const policy = syntheticExternalPolicy('GATE18', externalAuthorityId, reportPath, sha256Bytes(readBytes(root, reportPath)), programId);
    const modulePath = syntheticExternalPolicyModule(root, 'GATE18', externalAuthorityId, reportPath, sha256Bytes(readBytes(root, reportPath)), programId);
    const confirmedAt = nextInstant(root);
    const confirmation = futureMaintenanceInputs(root, 'GATE18', 'EXTERNAL_CONFIRMATION', 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1', confirmedAt, {
      policy, externalReportPath: reportPath, lifecycleAuthorityPath: externalAuthorityId,
      authorityPredecessor: { authorityId: readJson(root, closure.authorityPath).authorityId, sha256: sha256Bytes(readBytes(root, closure.authorityPath)) }
    });
    const authority = readJson(root, confirmation.authorityPath);
    const manifest = readJson(root, authority.authorizedPathManifestPath);
    manifest.paths = manifest.paths.filter((entry) => entry.path !== reportPath);
    writeJson(root, authority.authorizedPathManifestPath, manifest);
    const before = sha256Bytes(readBytes(root, LEDGER_PATH));
    const result = runLifecycleTransition({ root, stagingRoot: staging, policy, projectionPolicyModulePath: modulePath, gateId: 'GATE18', transitionType: 'EXTERNAL_CONFIRMATION', eventId: 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1', authorityPath: externalAuthorityId, authorityDocumentPath: confirmation.authorityPath, recordedAt: confirmedAt });
    assert.equal(result.result, 'BLOCKED');
    assert.ok(result.findings.some((finding) => finding.code === 'AUTHORIZED_MANIFEST_SHA_MISMATCH' || finding.code === 'EXTERNAL_REINSPECTION_REPORT_NOT_IN_MANIFEST'));
    assert.equal(sha256Bytes(readBytes(root, LEDGER_PATH)), before);
  } finally { discard(root); discard(staging); }
});

test('A7: validator and orchestrator share the complete external-confirmation observation', () => {
  const root = scratchRoot('shared-observation-parity');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    enterSyntheticFutureGate(root, staging);
    const closedAt = nextInstant(root);
    const closure = futureMaintenanceInputs(root, 'GATE18', 'AGENT_CLOSURE', 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1', closedAt);
    assert.equal(runLifecycleTransition({ root, stagingRoot: staging, gateId: 'GATE18', transitionType: 'AGENT_CLOSURE', eventId: 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1', authorityPath: closure.authorityPath, authorityDocumentPath: closure.authorityPath, recordedAt: closedAt }).result, 'APPLIED');
    const reportPath = 'governance/sources/GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_R1.json';
    const externalAuthorityId = 'GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_R1';
    const programId = 'GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_PROGRAM';
    writeJson(root, reportPath, { document: 'EXTERNAL_REINSPECTION_REPORT', gateId: 'GATE18', verdict: 'PASS', independentSession: true, programId });
    const policy = syntheticExternalPolicy('GATE18', externalAuthorityId, reportPath, sha256Bytes(readBytes(root, reportPath)), programId);
    const confirmedAt = nextInstant(root);
    const confirmation = futureMaintenanceInputs(root, 'GATE18', 'EXTERNAL_CONFIRMATION', 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1', confirmedAt, {
      policy, externalReportPath: reportPath, lifecycleAuthorityPath: externalAuthorityId,
      authorityPredecessor: { authorityId: readJson(root, closure.authorityPath).authorityId, sha256: sha256Bytes(readBytes(root, closure.authorityPath)) }
    });
    const authority = readJson(root, confirmation.authorityPath);
    const candidate = deriveCandidateTransition({ root, policy, gateId: 'GATE18', transitionType: 'EXTERNAL_CONFIRMATION', eventId: 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1', authorityPath: externalAuthorityId, recordedAt: confirmedAt }).candidate;
    const direct = collectPostFreezeMaintenanceObservation({ root, authority, requestedPaths: candidate.writes.map((write) => write.path), requestedOperationClasses: ['EXTERNAL_CONFIRMATION'], candidateWrites: candidate.writes });
    const orchestrated = evaluateTransitionAuthority({ root, candidate, authorityDocumentPath: confirmation.authorityPath });
    for (const field of ['ledgerEventCount', 'ledgerPrefixSha256', 'gateId', 'gateStatus', 'stateRevision', 'contractRevision', 'manifestSha256', 'requestedPaths', 'requestedOperationClasses', 'externalReinspectionReportPath', 'externalReinspectionReportSha256', 'authorityPredecessorSha256', 'preStateClosedStateSealMembers']) {
      assert.deepEqual(orchestrated.observed[field], direct.observed[field], field);
    }
    assert.equal(orchestrated.decision, 'AUTHORIZED');
    writeJson(root, reportPath, { document: 'EXTERNAL_REINSPECTION_REPORT', gateId: 'GATE18', verdict: 'FAIL', independentSession: true, programId });
    const altered = evaluateTransitionAuthority({ root, candidate, authorityDocumentPath: confirmation.authorityPath });
    assert.equal(altered.decision, 'BLOCKED');
    assert.ok(altered.findings.some((finding) => finding.code === 'EXTERNAL_REINSPECTION_REPORT_SHA_MISMATCH'));
  } finally { discard(root); discard(staging); }
});

test('B1: a rollback restoration failure is RECOVERY_REQUIRED, never falsely reported rolled back', () => {
  const root = scratchRoot('rollback-restoration-failure');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const { candidate, authority, request } = syntheticAuthorizedClosure(root, staging);
    let forwardWrites = 0;
    assert.throws(() => applyCandidate({
      root, candidate, authorityDocumentPath: request.authorityDocumentPath, authority,
      writeFile(target, bytes) { forwardWrites += 1; if (forwardWrites === 3) throw new Error('FORWARD_FAILURE'); fs.writeFileSync(target, bytes); },
      rollbackWriteFile(target, bytes) { if (target.endsWith('CURRENT_STATE.json')) throw new Error('RESTORATION_FAILURE'); fs.writeFileSync(target, bytes); }
    }), (error) => error.recovered === false && /RECOVERY_REQUIRED/.test(error.message));
    const resumed = runLifecycleTransition({ root, stagingRoot: staging, ...request });
    assert.equal(resumed.result, 'ALREADY_SATISFIED', JSON.stringify(resumed.findings));
    assert.equal(readLedgerEvents(root).filter((event) => event.eventId === request.eventId).length, 1, 'recovery must publish exactly one event');
    assert.equal(readJson(root, 'governance/gates/GATE18/state/CURRENT_STATE.json').stateRevision, 'R0003');
  } finally { discard(root); discard(staging); }
});

test('R3: a rollback deletion failure for a newly-created member requires durable recovery', () => {
  const root = scratchRoot('rollback-delete-failure');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const { candidate, authority, request } = syntheticAuthorizedClosure(root, staging);
    let writes = 0;
    const createdCheckpoint = candidate.paths.checkpoint;
    assert.throws(() => applyCandidate({
      root, candidate, authorityDocumentPath: request.authorityDocumentPath, authority,
      writeFile(target, bytes) { writes += 1; if (writes === 4) throw new Error('FORWARD_FAILURE'); fs.writeFileSync(target, bytes); },
      rollbackRemoveFile(target, options) { if (path.normalize(target).endsWith(path.normalize(createdCheckpoint))) throw new Error('DELETE_FAILURE'); fs.rmSync(target, options); }
    }), (error) => error.recovered === false && error.rollbackFailures.some((item) => item.path === createdCheckpoint));
    const resumed = runLifecycleTransition({ root, stagingRoot: staging, ...request });
    assert.equal(resumed.result, 'ALREADY_SATISFIED', JSON.stringify(resumed.findings));
    assert.equal(readLedgerEvents(root).filter((event) => event.eventId === request.eventId).length, 1);
  } finally { discard(root); discard(staging); }
});

function createAuthorizedPendingTransaction(root, staging) {
  const { candidate, authority, request } = syntheticAuthorizedClosure(root, staging);
  let writes = 0;
  assert.throws(() => applyCandidate({
    root, candidate, authorityDocumentPath: request.authorityDocumentPath, authority,
    writeFile(target, bytes) { writes += 1; if (writes === 3) throw new Error('FORWARD_FAILURE'); fs.writeFileSync(target, bytes); },
    rollbackWriteFile(target, bytes) { if (target.endsWith('CURRENT_STATE.json')) throw new Error('RESTORATION_FAILURE'); fs.writeFileSync(target, bytes); }
  }), (error) => error.recovered === false);
  const relative = `governance/transactions/TXN_${request.eventId}/TRANSACTION.json`;
  return { request, transactionPath: relative, transaction: readJson(root, relative) };
}

test('P1-P12: recovery rejects unproven or altered pending transactions and retains forensic evidence', () => {
  const cases = [
    ['P1', (root) => {
      const target = 'governance/generated/MODEL_ROUTING_POLICY.md';
      const directory = 'governance/transactions/TXN_FORGED_PREPARED';
      const source = `${directory}/staged/000.bin`;
      const malicious = Buffer.from('malicious scratch bytes\n');
      const before = readBytes(root, target);
      const sourceFile = path.join(root, ...source.split('/')); fs.mkdirSync(path.dirname(sourceFile), { recursive: true }); fs.writeFileSync(sourceFile, malicious);
      writeJson(root, `${directory}/TRANSACTION.json`, {
        schemaVersion: 1, transactionId: 'FORGED_PREPARED_TRANSACTION', transactionState: 'PREPARED', caseType: 'STATUS_TRANSITION', gateId: 'GATE17',
        stagedArtifacts: [{ sourcePath: source, targetPath: target, sha256: sha256Bytes(malicious), byteLength: malicious.length }], expectedHashes: [{ targetPath: target, sha256: sha256Bytes(malicious), byteLength: malicious.length }], oldPointers: [], newPointers: [], commitOrder: [target], rollbackPlan: [], recoveryPlan: { mode: 'ROLL_FORWARD_FROM_STAGED_ARTIFACTS' }, idempotencyKeys: [], ledgerEvent: { gateId: 'GATE17', transitionType: 'AGENT_CLOSURE', eventId: 'FORGED_EVENT' }, provenance: null
      });
      return { request: { gateId: 'GATE17', transitionType: 'AGENT_CLOSURE', eventId: 'FORGED_EVENT', authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY, recordedAt: '2026-08-15T10:10:00.000Z' }, target, before, transactionPath: `${directory}/TRANSACTION.json` };
    }],
    ['P2', (_root, transaction) => { transaction.provenance.authority.documentPath = 'governance/sources/DOES_NOT_EXIST.json'; }],
    ['P3', (_root, transaction) => { transaction.provenance.authority.documentSha256 = '0'.repeat(64); }],
    ['P4', (_root, transaction) => { transaction.provenance.candidateManifestSha256 = '1'.repeat(64); }],
    ['P5', (_root, transaction) => { transaction.provenance.candidateCohort.pop(); }],
    ['P6', (root, transaction) => { fs.writeFileSync(path.join(root, ...transaction.stagedArtifacts[0].sourcePath.split('/')), 'altered staged candidate\n'); }],
    ['P7', (_root, transaction) => { transaction.expectedHashes.push({ targetPath: 'governance/generated/MODEL_ROUTING_POLICY.md', sha256: '2'.repeat(64), byteLength: 1 }); }],
    ['P8', (_root, transaction) => { transaction.provenance.requestedOperationClasses = ['START']; }],
    ['P9', (_root, transaction) => { transaction.gateId = 'GATE17'; }],
    ['P10', (_root, transaction) => { transaction.provenance.preState.ledgerPrefixSha256 = '3'.repeat(64); }],
    ['P11', (_root, transaction) => { transaction.provenance.external = { logicalAuthorityId: 'WRONG_EXTERNAL', reportPath: 'governance/sources/MISSING_EXTERNAL.json', reportSha256: '4'.repeat(64), authorityPredecessor: null }; }],
    ['P12', (_root, transaction) => { delete transaction.provenance; }]
  ];
  for (const [label, mutate] of cases) {
    const root = scratchRoot(`provenance-${label}`);
    const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
    try {
      const fixture = label === 'P1' ? mutate(root) : createAuthorizedPendingTransaction(root, staging);
      if (label !== 'P1') {
        mutate(root, fixture.transaction);
        writeJson(root, fixture.transactionPath, fixture.transaction);
      }
      const transaction = readJson(root, fixture.transactionPath);
      const preflight = validateLifecycleTransactionProvenance({ root, transaction });
      assert.equal(preflight.valid, false, `${label} must fail provenance`);
      const result = runLifecycleTransition({ root, stagingRoot: staging, ...fixture.request });
      assert.equal(result.result, 'BLOCKED', `${label} runner verdict`);
      assert.equal(result.findings[0].defectClass, 'PENDING_TRANSACTION_PROVENANCE_INVALID');
      assert.ok(fs.existsSync(path.join(root, ...fixture.transactionPath.split('/'))), `${label} forensic transaction retained`);
      if (fixture.target) assert.ok(readBytes(root, fixture.target).equals(fixture.before), `${label} target bytes unchanged`);
    } finally { discard(root); discard(staging); }
  }
});

test('A3/A4/A6: exact closure and confirmation authority cover the complete projected cohort', () => {
  const root = scratchRoot('synthetic-future-local-auth-start');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  const gateId = 'GATE18';
  try {
    const authorizedAt = nextInstant(root);
    const authorization = futureAuthorizationInputs(root, gateId, 'GATE18_SYNTHETIC_AUTHORIZATION_R1', authorizedAt);
    const authorized = runLifecycleTransition({
      root, stagingRoot: staging, gateId, transitionType: 'AUTHORIZATION', eventId: 'GATE18_SYNTHETIC_AUTHORIZATION_R1',
      authorityPath: authorization.recordPath, recordedAt: authorizedAt
    });
    assert.equal(authorized.result, 'APPLIED', JSON.stringify(authorized.findings));
    assert.equal(authorized.authority.decision, 'NOT_APPLICABLE');
    assert.equal(replayGateStatus(readLedgerEvents(root)).get(gateId), 'AUTHORIZED_NOT_STARTED');

    const startedAt = nextInstant(root);
    const start = futureStartInputs(root, gateId, 'GATE18_SYNTHETIC_START_R1', startedAt);
    const started = runLifecycleTransition({
      root, stagingRoot: staging, gateId, transitionType: 'START', eventId: 'GATE18_SYNTHETIC_START_R1',
      authorityPath: start.recordPath, recordedAt: startedAt
    });
    assert.equal(started.result, 'APPLIED', JSON.stringify(started.findings));
    assert.equal(started.authority.decision, 'NOT_APPLICABLE');
    assert.equal(replayGateStatus(readLedgerEvents(root)).get(gateId), 'IN_PROGRESS');

    const closedAt = nextInstant(root);
    const closure = futureMaintenanceInputs(root, gateId, 'AGENT_CLOSURE', 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1', closedAt);
    const closureCandidate = deriveCandidateTransition({ root, gateId, transitionType: 'AGENT_CLOSURE', eventId: 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1', authorityPath: closure.authorityPath, recordedAt: closedAt }).candidate;
    assert.equal(validateCandidateInStagingRoot({ root, candidate: closureCandidate, stagingRoot: staging }).valid, true);
    const closureAuthority = evaluateTransitionAuthority({ root, candidate: closureCandidate, authorityDocumentPath: closure.authorityPath });
    assert.equal(closureAuthority.decision, 'AUTHORIZED');
    assert.deepEqual([...closureAuthority.observed.requestedPaths].sort(), [...closureAuthority.authorizedPaths].sort());
    const closed = runLifecycleTransition({
      root, stagingRoot: staging, gateId, transitionType: 'AGENT_CLOSURE', eventId: 'GATE18_SYNTHETIC_AGENT_CLOSURE_R1',
      authorityPath: closure.authorityPath, authorityDocumentPath: closure.authorityPath, recordedAt: closedAt
    });
    assert.equal(closed.result, 'APPLIED', JSON.stringify(closed.findings));
    assert.equal(closed.authority.decision, 'AUTHORIZED');
    assert.equal(replayGateStatus(readLedgerEvents(root)).get(gateId), 'COMPLETE_AGENT');

    const confirmedAt = nextInstant(root);
    const externalAuthorityId = 'GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_R1';
    const externalReportPath = 'governance/sources/GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_R1.json';
    const externalProgramId = 'GATE18_SYNTHETIC_EXTERNAL_REINSPECTION_PROGRAM';
    writeJson(root, externalReportPath, {
      document: 'EXTERNAL_REINSPECTION_REPORT', gateId, verdict: 'PASS', independentSession: true, programId: externalProgramId
    });
    const policy = syntheticExternalPolicy(gateId, externalAuthorityId, externalReportPath, sha256Bytes(readBytes(root, externalReportPath)), externalProgramId);
    const projectionPolicyModulePath = syntheticExternalPolicyModule(root, gateId, externalAuthorityId, externalReportPath, sha256Bytes(readBytes(root, externalReportPath)), externalProgramId);
    const blockedWithoutMaintenanceAuthority = runLifecycleTransition({
      root, stagingRoot: staging, policy, projectionPolicyModulePath, gateId, transitionType: 'EXTERNAL_CONFIRMATION', eventId: 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1',
      authorityPath: externalAuthorityId, recordedAt: confirmedAt
    });
    assert.equal(blockedWithoutMaintenanceAuthority.result, 'BLOCKED');
    assert.equal(blockedWithoutMaintenanceAuthority.authority.decision, 'BLOCKED');
    assert.equal(readLedgerEvents(root).filter((event) => event.eventId === 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1').length, 0);
    const confirmation = futureMaintenanceInputs(root, gateId, 'EXTERNAL_CONFIRMATION', 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1', confirmedAt, {
      policy, externalReportPath, lifecycleAuthorityPath: externalAuthorityId,
      authorityPredecessor: { authorityId: readJson(root, closure.authorityPath).authorityId, sha256: sha256Bytes(readBytes(root, closure.authorityPath)) }
    });
    const confirmationCandidate = deriveCandidateTransition({ root, policy, gateId, transitionType: 'EXTERNAL_CONFIRMATION', eventId: 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1', authorityPath: externalAuthorityId, recordedAt: confirmedAt }).candidate;
    assert.equal(validateCandidateInStagingRoot({ root, candidate: confirmationCandidate, stagingRoot: staging, policy, projectionPolicyModulePath }).valid, true);
    const confirmationAuthority = evaluateTransitionAuthority({ root, candidate: confirmationCandidate, authorityDocumentPath: confirmation.authorityPath });
    assert.equal(confirmationAuthority.decision, 'AUTHORIZED');
    assert.deepEqual([...confirmationAuthority.observed.requestedPaths].sort(), confirmationAuthority.authorizedPaths.filter((entry) => entry !== externalReportPath).sort());
    assert.equal(confirmationAuthority.observed.externalReinspectionReportPath, externalReportPath);
    assert.equal(confirmationAuthority.observed.externalReinspectionReportSha256, sha256Bytes(readBytes(root, externalReportPath)));
    assert.equal(confirmationAuthority.observed.authorityPredecessorSha256, sha256Bytes(readBytes(root, closure.authorityPath)));
    const confirmed = runLifecycleTransition({
      root, stagingRoot: staging, policy, projectionPolicyModulePath, gateId, transitionType: 'EXTERNAL_CONFIRMATION', eventId: 'GATE18_SYNTHETIC_EXTERNAL_CONFIRMATION_R1',
      authorityPath: externalAuthorityId, authorityDocumentPath: confirmation.authorityPath, recordedAt: confirmedAt
    });
    assert.equal(confirmed.result, 'APPLIED', JSON.stringify(confirmed.findings));
    assert.equal(confirmed.authority.decision, 'AUTHORIZED');
    assert.equal(replayGateStatus(readLedgerEvents(root)).get(gateId), 'COMPLETE_CONFIRMED');
  } finally { discard(root); discard(staging); }
});

/* -------------------------------------------------------------------------
 * Idempotence, against the real ledger at HEAD
 * ---------------------------------------------------------------------- */

test('re-requesting a transition the ledger already records is ALREADY_SATISFIED, not a duplicate', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    ...gate17ClosureRequest(readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json'))
  });
  assert.equal(result.status, 'ALREADY_SATISFIED');
  assert.equal(result.candidate, null, 'an already-satisfied transition must derive no candidate');
  assert.equal(result.satisfiedBy.eventId, 'GATE17_AGENT_CLOSURE_R1');
  assert.equal(result.satisfiedBy.ordinal, 72);
  assert.equal(result.satisfiedBy.toStatus, 'COMPLETE_AGENT');
});

test('every already-recorded transition of GATE16 and GATE17 is idempotent', () => {
  const events = readLedgerEvents(REPO_ROOT);
  const recorded = events.filter((event) =>
    ['GATE16', 'GATE17'].includes(event.gateId) && ORCHESTRATED_TRANSITIONS.includes(event.transitionType));
  assert.ok(recorded.length >= 6, 'GATE16/GATE17 should contribute at least six orchestrated transitions');
  for (const event of recorded) {
    const result = deriveCandidateTransition({
      root: REPO_ROOT,
      gateId: event.gateId,
      transitionType: event.transitionType,
      eventId: event.eventId,
      authorityPath: event.authorityPath,
      recordedAt: event.recordedAt
    });
    // An EXTERNAL_CONFIRMATION cites a logical report id rather than a file, so
    // its authority bytes are not resolvable from the path alone. Either answer
    // is acceptable; what is NOT acceptable is deriving a fresh candidate for a
    // transition the ledger already contains.
    assert.notEqual(result.status, 'DERIVED', `${event.eventId} must not re-derive`);
    if (result.status === 'ALREADY_SATISFIED') {
      assert.equal(result.satisfiedBy.ordinal, event.ordinal);
    }
  }
});

test('a NEW event id cannot repeat a transition the gate has already made', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE17',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_AGENT_CLOSURE_R2_ATTEMPT',
    authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.findings.map((item) => item.defectClass), ['DUPLICATE_TRANSITION_FOR_GATE']);
});

test('an event id already spent on another transition cannot be reused', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE16',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_AGENT_CLOSURE_R1',
    authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.findings.map((item) => item.defectClass), ['EVENT_ID_ALREADY_USED_FOR_DIFFERENT_TRANSITION']);
});

/* -------------------------------------------------------------------------
 * Determinism — re-deriving GATE17's hand-built AGENT_CLOSURE
 * ---------------------------------------------------------------------- */

test('GATE17 AGENT_CLOSURE re-derives to the same lifecycle identities that were built by hand', () => {
  const root = scratchRoot('gate17-replay');
  try {
    const historicalEvent = rewindGate17ToPostStart(root);
    const historicalSeal = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/STATE_SEAL.json');
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');

    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');
    const candidate = derived.candidate;

    // The ledger position and chain link are mechanical facts and must match
    // the historical event exactly.
    assert.equal(candidate.ordinal, historicalEvent.ordinal);
    assert.equal(candidate.event.previousEventSha256, historicalEvent.previousEventSha256);
    assert.equal(candidate.fromStatus, historicalEvent.fromStatus);
    assert.equal(candidate.toStatus, historicalEvent.toStatus);
    assert.equal(candidate.event.authoritySha256, historicalEvent.authoritySha256);

    // So are the seal's lineage and subject.
    assert.equal(candidate.stateRevision, historicalSeal.stateRevision);
    assert.equal(candidate.seal.previousStateSealSha256, historicalSeal.previousStateSealSha256);
    assert.equal(candidate.seal.payload.executionStatus, historicalSeal.payload.executionStatus);
    assert.equal(candidate.seal.payload.contractSha256, historicalSeal.payload.contractSha256);
    assert.deepEqual(
      candidate.seal.sealedMembers.map((member) => member.repoRelativePath),
      historicalSeal.sealedMembers.map((member) => member.repoRelativePath)
    );

    // The contract member's bytes were untouched by the transaction, so its
    // sealed identity must be byte-for-byte what history recorded.
    const historicalContract = historicalSeal.sealedMembers
      .find((member) => member.repoRelativePath.endsWith('/CURRENT_CONTRACT.json'));
    const derivedContract = candidate.seal.sealedMembers
      .find((member) => member.repoRelativePath.endsWith('/CURRENT_CONTRACT.json'));
    assert.deepEqual(derivedContract, historicalContract);
  } finally {
    discard(root);
  }
});

test('a re-derived GATE17 AGENT_CLOSURE introduces no new ledger, seal or revision finding', () => {
  const root = scratchRoot('gate17-validate');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const authorityDocumentPath = alignGate17MaintenanceAuthorityToScratch(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');

    const validation = validateCandidateInStagingRoot({ root, candidate: derived.candidate, stagingRoot: staging });
    assert.equal(validation.valid, true, JSON.stringify(validation.findings.slice(0, 4)));
    assert.equal(validation.reports.introducedLedgerFindingCount, 0);
    assert.equal(validation.reports.sealValid, true);
    assert.equal(validation.reports.revisionValid, true);
    // The pre-existing baseline is REPORTED rather than silently absorbed, so a
    // reader can see what was already true of this repository.
    assert.ok(validation.reports.baselineLedgerFindingCount > 0);
  } finally {
    discard(root);
    discard(staging);
  }
});

/* -------------------------------------------------------------------------
 * Atomicity — a rejected candidate never reaches canonical bytes
 * ---------------------------------------------------------------------- */

test('a candidate rejected during validation leaves every canonical byte untouched', () => {
  const root = scratchRoot('atomicity');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);

    const before = {
      ledger: sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))),
      currentState: sha256Bytes(fs.readFileSync(path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json'))),
      revisionAbsent: !fs.existsSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003'))
    };
    assert.equal(before.revisionAbsent, true);

    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');

    // Break the candidate the way a hand-built transition breaks: a chain link
    // that does not chain. Corrupting the derived object is the only way to
    // reach this state, which is itself the point — the deriver cannot produce it.
    const candidate = derived.candidate;
    candidate.event.previousEventSha256 = 'f'.repeat(64);
    const rebuiltLine = ledgerLineBytes(candidate.event);
    const priorLedger = fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')));
    const ledgerWrite = candidate.writes.find((write) => write.path === LEDGER_PATH);
    ledgerWrite.bytes = Buffer.concat([priorLedger, rebuiltLine]);

    const validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging });
    assert.equal(validation.valid, false, 'a broken chain link must be rejected');
    assert.ok(validation.findings.some((item) => item.defectClass === 'CANDIDATE_LEDGER_INVALID'));

    // The real proof: the canonical bytes are digest-identical to before, and
    // the revision directory the candidate would have minted does not exist.
    assert.equal(sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))), before.ledger);
    assert.equal(sha256Bytes(fs.readFileSync(path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json'))), before.currentState);
    assert.equal(fs.existsSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003')), false);
  } finally {
    discard(root);
    discard(staging);
  }
});

test('runLifecycleTransition in dryRun reports a valid candidate and still writes nothing', () => {
  const root = scratchRoot('dryrun');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const ledgerBefore = sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/'))));

    const report = runLifecycleTransition({
      root, stagingRoot: staging, dryRun: true, ...gate17ClosureRequest(historicalCheckpoint)
    });
    assert.equal(report.document, ORCHESTRATOR_DOCUMENT);
    assert.equal(report.result, 'CANDIDATE_VALID');
    assert.equal(report.canonicalBytesUnchanged, true);
    assert.deepEqual(report.applied, []);
    assert.equal(sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))), ledgerBefore);
  } finally {
    discard(root);
    discard(staging);
  }
});

test('an applied transition writes exactly its declared cohort and nothing else', () => {
  const root = scratchRoot('apply');
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');
    assert.equal(validateCandidateInStagingRoot({ root, candidate: derived.candidate, stagingRoot: staging }).valid, true);
    // RAW PRIMITIVE, DELIBERATELY AUTHORITY-LESS. This case is about the WRITE
    // boundary — which paths a validated candidate moves and which it does not —
    // so it drives applyCandidate directly rather than through the orchestrator,
    // and supplies no authority of any kind. Recoverable provenance is therefore
    // opted out EXPLICITLY here rather than by omission: the production default is
    // now `true`, and every canonical publisher is held to it. An opt-out that had
    // to be written down is one a reviewer can see; the silent default this
    // replaces is what let three real publishers arm unrecoverable transactions.
    const applied = applyCandidate({ root, candidate: derived.candidate, requireRecoverableProvenance: false });
    assert.deepEqual(applied.map((write) => write.path).sort(), [
      'governance/gates/GATE17/state/CURRENT_STATE.json',
      'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json',
      'governance/gates/GATE17/state/revisions/R0003/OPEN_DEFECTS.json',
      'governance/gates/GATE17/state/revisions/R0003/STATE_SEAL.json',
      'governance/generated/FOUNDATION_REPORT.md',
      'governance/generated/FOUNDATION_REPORT_PROVENANCE.json',
      'governance/state/GATE_STATUS_LEDGER.ndjson',
      'governance/state/generated/GATE_STATUS_SNAPSHOT.json'
    ]);

    // Applying it a second time is a no-op decided from the ledger, not a
    // second event.
    const repeat = runLifecycleTransition({ root, stagingRoot: staging, dryRun: false, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(repeat.result, 'ALREADY_SATISFIED');
    assert.deepEqual(repeat.applied, []);
    assert.equal(readLedgerEvents(root).length, 72, 'the ledger must not grow on a repeated apply');
  } finally {
    discard(root);
    discard(staging);
  }
});

test('every canonical apply write boundary rolls back exactly, and a retry appends once', () => {
  // Eight writes: four lifecycle bytes, the ledger, and three deterministic
  // projections.  Each injected exception must return only after exact restore.
  for (let boundary = 1; boundary <= 8; boundary += 1) {
    const root = scratchRoot(`apply-fault-${boundary}`);
    const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-stage-'));
    try {
      const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
      rewindGate17ToPostStart(root);
      const before = {
        ledger: sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))),
        currentState: sha256Bytes(fs.readFileSync(path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json')))
      };
      let writes = 0;
      const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
      assert.equal(derived.status, 'DERIVED');
      assert.equal(validateCandidateInStagingRoot({ root, candidate: derived.candidate, stagingRoot: staging }).valid, true);
      // Raw primitive, deliberately authority-less: this case injects a failure at
      // each write boundary to prove the rollback is byte-exact, which is a
      // property of the write loop rather than of any authority. The provenance
      // requirement is opted out explicitly, at the callsite, for that reason.
      assert.throws(() => applyCandidate({
        root, candidate: derived.candidate, requireRecoverableProvenance: false,
        writeFile(target, bytes) {
          writes += 1;
          if (writes === boundary) throw new Error(`INJECTED_WRITE_${boundary}`);
          fs.writeFileSync(target, bytes);
        }
      }), (error) => error.recovered === true && /ROLLED_BACK/.test(error.message));
      assert.equal(sha256Bytes(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))), before.ledger);
      assert.equal(sha256Bytes(fs.readFileSync(path.join(root, 'governance/gates/GATE17/state/CURRENT_STATE.json'))), before.currentState);
      assert.equal(fs.existsSync(path.join(root, 'governance/gates/GATE17/state/revisions/R0003')), false);
      const retry = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
      assert.equal(retry.status, 'DERIVED');
      assert.equal(validateCandidateInStagingRoot({ root, candidate: retry.candidate, stagingRoot: staging }).valid, true);
      applyCandidate({ root, candidate: retry.candidate, requireRecoverableProvenance: false });
      assert.equal(readLedgerEvents(root).length, 72);
    } finally { discard(root); discard(staging); }
  }
});

/* -------------------------------------------------------------------------
 * Derived-not-supplied identities
 * ---------------------------------------------------------------------- */

test('every sealed member hash and byte length is computed from real bytes', () => {
  const root = scratchRoot('derived-hashes');
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    assert.equal(derived.status, 'DERIVED');

    const writesByPath = new Map(derived.candidate.writes.map((write) => [write.path, write.bytes]));
    for (const member of derived.candidate.seal.sealedMembers) {
      const bytes = writesByPath.get(member.repoRelativePath)
        ?? fs.readFileSync(path.join(root, ...member.repoRelativePath.split('/')));
      assert.equal(member.sha256, sha256Bytes(bytes), `${member.repoRelativePath} hash must come from bytes`);
      assert.equal(member.byteLength, bytes.length, `${member.repoRelativePath} length must come from bytes`);
    }
    // The set digest is recomputed independently here rather than trusted.
    assert.equal(
      derived.candidate.seal.payload.sealedMembersDigest,
      computeSealedMembersDigest(derived.candidate.seal.sealedMembers)
    );
  } finally {
    discard(root);
  }
});

test('the candidate summary carries identities but never raw bytes', () => {
  const root = scratchRoot('summary');
  try {
    const historicalCheckpoint = readJson(REPO_ROOT, 'governance/gates/GATE17/state/revisions/R0003/CHECKPOINT.json');
    rewindGate17ToPostStart(root);
    const derived = deriveCandidateTransition({ root, ...gate17ClosureRequest(historicalCheckpoint) });
    const summary = summarizeCandidate(derived.candidate);
    assert.ok(summary.identities.eventPayloadSha256);
    assert.ok(summary.identities.stateSealSha256);
    for (const write of summary.writes) {
      assert.equal(Object.hasOwn(write, 'bytes'), false, 'a serializable summary must not carry file bytes');
    }
  } finally {
    discard(root);
  }
});

/* -------------------------------------------------------------------------
 * Fail-closed
 * ---------------------------------------------------------------------- */

test('a gate with no current contract cannot be transitioned', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE18',
    transitionType: 'AUTHORIZATION',
    eventId: 'GATE18_AUTHORIZATION_UNIT_TEST',
    authorityPath: 'governance/GATE_REGISTRY_00_40.json',
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some((item) => item.defectClass === 'CURRENT_CONTRACT_ABSENT'));
});

test('an unresolvable authority document blocks before any derivation', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT,
    gateId: 'GATE17',
    transitionType: 'AGENT_CLOSURE',
    eventId: 'GATE17_UNRESOLVABLE_AUTHORITY',
    authorityPath: 'governance/sources/THIS_AUTHORITY_DOES_NOT_EXIST.json',
    recordedAt: '2026-08-14T23:00:00.000Z'
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some((item) =>
    ['AUTHORITY_BYTES_UNRESOLVABLE', 'DUPLICATE_TRANSITION_FOR_GATE'].includes(item.defectClass)));
});

test('malformed requests are rejected with every independent reason at once', () => {
  const result = deriveCandidateTransition({
    root: REPO_ROOT, gateId: 'NOT_A_GATE', transitionType: 'SUPERSESSION',
    eventId: '', authorityPath: '', recordedAt: 'not-a-timestamp'
  });
  assert.equal(result.status, 'BLOCKED');
  const classes = result.findings.map((item) => item.defectClass);
  // All five are reported together. A validator that stopped at the first would
  // turn one diagnosis into five sequential retries.
  for (const expected of ['GATE_ID_INVALID', 'TRANSITION_NOT_ORCHESTRATED', 'EVENT_ID_INVALID', 'AUTHORITY_PATH_INVALID', 'RECORDED_AT_INVALID']) {
    assert.ok(classes.includes(expected), `${expected} must be reported`);
  }
});

test('a transition the canonical table does not admit cannot be derived', () => {
  const root = scratchRoot('not-admitted');
  try {
    // GATE17 rewound to post-START is IN_PROGRESS; EXTERNAL_CONFIRMATION is only
    // admitted from COMPLETE_AGENT.
    rewindGate17ToPostStart(root);
    const result = deriveCandidateTransition({
      root,
      gateId: 'GATE17',
      transitionType: 'EXTERNAL_CONFIRMATION',
      eventId: 'GATE17_PREMATURE_CONFIRMATION',
      authorityPath: GATE17_AGENT_CLOSURE_AUTHORITY,
      recordedAt: '2026-08-14T23:00:00.000Z'
    });
    assert.equal(result.status, 'BLOCKED');
    assert.ok(result.findings.some((item) => item.defectClass === 'TRANSITION_NOT_ADMITTED_BY_CANONICAL_TABLE'));
  } finally {
    discard(root);
  }
});

/* -------------------------------------------------------------------------
 * Baseline and helpers
 * ---------------------------------------------------------------------- */

test('the baseline records what was already true, and is not empty on this repository', () => {
  const baseline = collectBaselineIntegrity(REPO_ROOT);
  assert.ok(baseline.ledgerFindingCount > 0, 'FULL-mode ledger validation is not a pass/fail gate here');
  assert.equal(baseline.ledgerEventCount, readLedgerEvents(REPO_ROOT).length);
  assert.ok(baseline.sealValidity.size >= 20, 'every gate revision seal should be inventoried');
  assert.equal(baseline.sealValidity.get('governance/gates/GATE17/state/revisions/R0004/STATE_SEAL.json'), true);
});

test('replayed gate status is derived from the ledger alone', () => {
  const events = readLedgerEvents(REPO_ROOT);
  const status = replayGateStatus(events);
  assert.equal(status.get('GATE16'), 'COMPLETE_CONFIRMED');
  assert.equal(status.get('GATE17'), 'COMPLETE_CONFIRMED');

  // Every Gate carries a GENESIS_IMPORT that placed it at NOT_STARTED, so the
  // invariant is not "no event" — it is that a Gate reads NOT_STARTED exactly
  // while no event has moved it. Written as an EQUIVALENCE over whatever the
  // ledger actually holds, it says the same thing about every Gate and cannot
  // decay: the frontier used to be pinned here at GATE17, and GATE19 and GATE20
  // have lawfully executed since, which turned a true statement into a false one
  // without anything being wrong.
  const own = new Map();
  for (const event of events) {
    if (!own.has(event.gateId)) own.set(event.gateId, []);
    own.get(event.gateId).push(event);
  }
  assert.equal(own.size, 41, 'every registered Gate must appear in the ledger');
  for (const [gateId, gateEvents] of own) {
    assert.equal(gateEvents[0].transitionType, 'GENESIS_IMPORT', `${gateId} must open with its genesis event`);
    // The replayed status is the toStatus of the Gate's last event and nothing
    // else. GATE12 proves this is not the same as "one event means NOT_STARTED":
    // it was genesis-imported already COMPLETE_CONFIRMED, so the rule has to be
    // stated over what the events SAY, not over how many there are.
    assert.equal(status.get(gateId), gateEvents.at(-1).toStatus, `${gateId} must replay to its last recorded toStatus`);
    // A Gate is NOT_STARTED only while nothing moved it away from where its own
    // genesis placed it.
    if (gateEvents.length === 1) {
      assert.equal(status.get(gateId), gateEvents[0].toStatus, `${gateId} has only genesis, so it must still read it`);
    }
  }
  // And the replay is a pure function of those events: the same input replays to
  // the same statuses, so nothing outside the ledger contributed to them.
  assert.deepEqual([...replayGateStatus(events).entries()].sort(), [...status.entries()].sort());
});

test('governed bytes are deterministic and newline-terminated', () => {
  const value = { b: 2, a: [1, 2, 3] };
  assert.equal(governedBytes(value).toString('utf8'), `${JSON.stringify(value, null, 2)}\n`);
  assert.equal(Buffer.compare(governedBytes(value), governedBytes(value)), 0);
});

function spawnSnapshot(root, extraArgs = []) {
  const script = path.join(CANDIDATE_ROOT, 'governance', 'tools', 'generate-status-snapshot.mjs');
  try {
    const out = execFileSync(process.execPath, [script, '--root', root, ...extraArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}`, err: `${error.stderr || ''}` };
  }
}

test('W4 DEFAULT_SNAPSHOT_FAIL_CLOSED: default generator refuses an invalid readable ledger', () => {
  const root = scratchRoot('w4-default-fail-closed');
  fs.appendFileSync(path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'), '{"not":"an-event"}\n');
  const result = spawnSnapshot(root);
  assert.notEqual(result.code, 0);
  const report = JSON.parse(result.out || result.err || '{}');
  assert.equal(report.valid, false);
});

test('W4 STAGING_PROJECTION_MODE_BOUNDED: lifecycle-staging-only still projects a readable ledger with baseline findings', () => {
  const root = scratchRoot('w4-staging-bounded');
  const output = path.join(root, 'governance', 'state', 'generated', 'W4_STAGING_SNAPSHOT.json');
  const result = spawnSnapshot(root, ['--lifecycle-staging-only', '--output', output]);
  assert.equal(result.code, 0, result.err || result.out);
  const report = JSON.parse(result.out);
  assert.equal(report.valid, true);
  assert.equal(report.lifecycleStagingOnly, true);
  assert.equal(fs.existsSync(output), true);
});

test('W4 MALFORMED_LEDGER_REJECTED: unreadable ledger is refused even in staging', () => {
  const root = scratchRoot('w4-malformed');
  fs.writeFileSync(path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'), '{truncated');
  const result = spawnSnapshot(root, ['--lifecycle-staging-only']);
  assert.notEqual(result.code, 0);
  const report = JSON.parse(result.out || result.err || '{}');
  assert.equal(report.valid, false);
  assert.ok((report.findings || []).some((finding) => finding.detectorId === 'NDJSON_PARSE_ERROR'));
});

test('W4 NEW_BLOCKING_FINDING_REJECTED and DIFFERENTIAL_VALIDATION_PRESERVED', () => {
  const root = scratchRoot('w4-diff-new-finding');
  const baseline = collectBaselineIntegrity(root);
  const staging = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'w4-diff-staging-'));
  const candidate = {
    gateId: 'GATE20',
    writes: [{
      path: 'governance/state/GATE_STATUS_LEDGER.ndjson',
      bytes: Buffer.concat([
        fs.readFileSync(path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson')),
        Buffer.from('{"schemaVersion":1}\n')
      ])
    }],
    paths: {
      seal: 'governance/gates/GATE20/state/revisions/R0004/STATE_SEAL.json',
      currentState: 'governance/gates/GATE20/state/CURRENT_STATE.json'
    }
  };
  const report = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging, baseline });
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((finding) => finding.defectClass === 'CANDIDATE_LEDGER_INVALID' || finding.defectClass === 'CANDIDATE_PROJECTION_REGENERATION_FAILED'));
  fs.rmSync(staging, { recursive: true, force: true });
});
