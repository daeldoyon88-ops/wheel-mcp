#!/usr/bin/env node
/**
 * Deterministic builder for the AUTHORIZATION and START document pairs, in
 * LOCAL_EXPLICIT_AUTHORITY mode.
 *
 * WHY THIS EXISTS. The AUTHORIZATION record must pin, by exact hash and byte
 * length, the four state-revision artifacts that the AUTHORIZATION transition
 * itself mints — artifacts that do not exist when the record is authored. Every
 * Gate so far solved that by hand. Hand-deriving a digest that a validator will
 * recompute is exactly the kind of step that produces a Gate-shaped one-off, so
 * this file derives it the only way that cannot drift: it asks the orchestrator
 * to derive the real candidate, reads the real bytes it would write, and builds
 * the documents from those.
 *
 * NOTHING HERE DECIDES ANYTHING. Every value is either observed from the live
 * repository or computed by an existing canonical primitive. The documents this
 * writes are then re-validated, independently, by the lifecycle orchestrator and
 * by permanent ledger validation, which is what makes a builder safe: if it
 * built the wrong document, the document is refused.
 *
 * FIXED POINT. Writing the record changes bytes that the derived projections may
 * read, which can change the projection hashes the authority pins. The build
 * therefore iterates until the documents reproduce themselves, and fails closed
 * if they do not converge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runLifecycleTransition, governedBytes } from './gate-lifecycle-orchestrator.mjs';
import { sha256Bytes } from './canonical-json.mjs';
import {
  computeGateAuthorizationBindingDigest,
  computeGateAuthorizationLocalRequestDigest,
  gateAuthorizationRecordPath,
  gateAuthorizationAuthoritySnapshotPath,
  gateAuthorizationStateCohortPaths,
  gateAuthorizationDerivedCohortPaths,
  GATE_AUTHORIZATION_AUTHORITY_KIND,
  GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
  GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS,
  GATE_AUTHORIZATION_TRANSITION_TYPE,
  GATE_AUTHORIZATION_FROM_STATUS,
  GATE_AUTHORIZATION_TO_STATUS
} from '../gee-v1/core/gate-authorization-authority.mjs';
import {
  computeGateStartRecordDigest,
  computeGateStartLocalRequestDigest,
  computeGateStartBindingDigestFromDigests,
  computeGateStartReadinessDigest,
  gateStartRecordPath,
  gateStartAuthorityPath,
  gateStartWriteCohortPaths,
  GATE_START_PROHIBITED_OPERATIONS,
  GATE_START_FROM_STATUS
} from '../gee-v1/core/gate-start-authority.mjs';
import { deriveGateStartReadinessFacts } from '../gee-v1/adapters/wheel/gate-start-authority-source.mjs';
import { resolveGateDependencyProof } from '../gee-v1/adapters/wheel/gate-dependency-resolution.mjs';

export const LIFECYCLE_RECORD_BUILDER_DOCUMENT = 'GATE_LIFECYCLE_RECORD_BUILD';
export const LOCAL_MODE = 'LOCAL_EXPLICIT_AUTHORITY';
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const MAX_FIXED_POINT_ROUNDS = 4;

function repoBytes(root, relativePath) {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? fs.readFileSync(absolute) : null;
}
function repoJson(root, relativePath) {
  const bytes = repoBytes(root, relativePath);
  return bytes ? JSON.parse(bytes.toString('utf8')) : null;
}
function writeRepo(root, relativePath, bytes) {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
}
function ledgerEvents(root) {
  const bytes = repoBytes(root, LEDGER_PATH);
  return bytes ? bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function registryDependency(root, gateId) {
  const registry = repoJson(root, 'governance/GATE_REGISTRY_00_40.json');
  const entry = (registry?.gates || []).find((gate) => gate.gateId === gateId);
  const dependencies = Array.isArray(entry?.dependencies) ? entry.dependencies : [];
  return dependencies.at(-1) ?? null;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXECUTION_CONTRACT_REQUIRED_FIELDS = Object.freeze([
  'gateId', 'contractRevision', 'strategicRegistryReference', 'canonicalRequirements',
  'requiredOutputs', 'validators', 'closureConditions', 'nextGateAuthorizationConditions',
  'performanceBudget', 'checkpointPolicy', 'authorizedPaths', 'requiredPolicyIds',
  'sourceReferences'
]);

function gateContractsNamespace(gateId) {
  return `governance/gates/${gateId}/contracts`;
}

function isSafeGovernedRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.length > 0 && !segments.some((segment) => !segment || segment === '.' || segment === '..');
}

function pathInGateContractsNamespace(relativePath, gateId) {
  const prefix = `${gateContractsNamespace(gateId)}/`;
  return isSafeGovernedRelative(relativePath) && relativePath.startsWith(prefix)
    && relativePath.slice(prefix.length).length > 0
    && !relativePath.slice(prefix.length).includes('/');
}

function isExecutionContractDocument(json, gateId) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  if (json.gateId !== gateId) return false;
  if (typeof json.contractRevision !== 'string' || !/^R[0-9]{4}$/.test(json.contractRevision)) return false;
  if (!Array.isArray(json.authorizedPaths)) return false;
  for (const field of EXECUTION_CONTRACT_REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(json, field)) return false;
  }
  return true;
}

function listGateContractFiles(root, gateId) {
  const relativeDir = gateContractsNamespace(gateId);
  const absolute = path.resolve(root, ...relativeDir.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return [];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'CURRENT_CONTRACT.json')
    .map((entry) => `${relativeDir}/${entry.name}`);
}

function resolveStartBoundContract({ root, gateId, status }) {
  const findings = [];
  if (status !== GATE_START_FROM_STATUS) {
    findings.push({ code: 'START_PRESTATE_NOT_AUTHORIZED_NOT_STARTED', detail: status });
    return { findings };
  }

  const recordPath = gateAuthorizationRecordPath(gateId);
  const authorizationRecord = repoJson(root, recordPath);
  if (!authorizationRecord) {
    findings.push({ code: 'GATE_AUTHORIZATION_RECORD_ABSENT', detail: recordPath });
    return { findings };
  }
  if (authorizationRecord.gateId !== gateId) findings.push({ code: 'GATE_AUTHORIZATION_RECORD_GATE_MISMATCH', detail: authorizationRecord.gateId });
  if (authorizationRecord.transitionType !== GATE_AUTHORIZATION_TRANSITION_TYPE) {
    findings.push({ code: 'GATE_AUTHORIZATION_RECORD_TRANSITION_INVALID', detail: authorizationRecord.transitionType });
  }
  if (authorizationRecord.fromStatus !== GATE_AUTHORIZATION_FROM_STATUS
    || authorizationRecord.toStatus !== GATE_AUTHORIZATION_TO_STATUS) {
    findings.push({
      code: 'GATE_AUTHORIZATION_RECORD_TRANSITION_INVALID',
      detail: `${authorizationRecord.fromStatus}>${authorizationRecord.toStatus}`
    });
  }
  if (typeof authorizationRecord.contractSha256 !== 'string' || !SHA256_RE.test(authorizationRecord.contractSha256)) {
    findings.push({ code: 'GATE_AUTHORIZATION_RECORD_CONTRACT_SHA_INVALID', detail: authorizationRecord.contractSha256 });
  }
  if (findings.length) return { findings };

  const boundSha = authorizationRecord.contractSha256;
  const matches = [];
  for (const relativePath of listGateContractFiles(root, gateId)) {
    const bytes = repoBytes(root, relativePath);
    if (!bytes) continue;
    let json;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { continue; }
    if (!isExecutionContractDocument(json, gateId)) continue;
    if (sha256Bytes(bytes) !== boundSha) continue;
    matches.push({ relativePath, bytes, json, sha256: boundSha });
  }
  if (matches.length === 0) {
    findings.push({ code: 'START_BOUND_CONTRACT_NOT_FOUND', detail: boundSha });
    return { findings };
  }
  if (matches.length > 1) {
    findings.push({
      code: 'START_BOUND_CONTRACT_AMBIGUOUS',
      detail: matches.map((item) => item.relativePath)
    });
    return { findings };
  }
  const bound = matches[0];

  const pointerPath = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const pointerBytes = repoBytes(root, pointerPath);
  if (!pointerBytes) {
    findings.push({ code: 'CURRENT_CONTRACT_MALFORMED', detail: pointerPath });
    return { findings };
  }
  let pointerJson;
  try { pointerJson = JSON.parse(pointerBytes.toString('utf8')); } catch {
    findings.push({ code: 'CURRENT_CONTRACT_MALFORMED', detail: pointerPath });
    return { findings };
  }
  if (!pointerJson || pointerJson.gateId !== gateId || !pathInGateContractsNamespace(pointerJson.contractPath, gateId)) {
    findings.push({ code: 'CURRENT_CONTRACT_MALFORMED', detail: pointerJson?.contractPath });
    return { findings };
  }

  const namespace = `${gateContractsNamespace(gateId)}/`;
  const seen = new Set();
  let cursorPath = pointerJson.contractPath;
  let reachedBound = false;
  while (cursorPath) {
    if (seen.has(cursorPath)) {
      findings.push({ code: 'START_CONTRACT_LINEAGE_CYCLE', detail: cursorPath });
      return { findings };
    }
    seen.add(cursorPath);
    if (!pathInGateContractsNamespace(cursorPath, gateId)) {
      findings.push({ code: 'START_CONTRACT_LINEAGE_PATH_INVALID', detail: cursorPath });
      return { findings };
    }
    const cursorBytes = repoBytes(root, cursorPath);
    if (!cursorBytes) {
      findings.push({ code: 'START_CONTRACT_LINEAGE_PREDECESSOR_ABSENT', detail: cursorPath });
      return { findings };
    }
    let cursorJson;
    try { cursorJson = JSON.parse(cursorBytes.toString('utf8')); } catch {
      findings.push({ code: 'START_CONTRACT_LINEAGE_MALFORMED', detail: cursorPath });
      return { findings };
    }
    if (!isExecutionContractDocument(cursorJson, gateId)) {
      findings.push({ code: 'START_CONTRACT_LINEAGE_NOT_EXECUTION_CONTRACT', detail: cursorPath });
      return { findings };
    }
    const cursorSha = sha256Bytes(cursorBytes);
    if (cursorSha === boundSha) {
      reachedBound = true;
      break;
    }
    if (typeof cursorJson.previousContractPath !== 'string' || typeof cursorJson.previousContractSha256 !== 'string') {
      findings.push({ code: 'START_CONTRACT_LINEAGE_DOES_NOT_DESCEND', detail: cursorPath });
      return { findings };
    }
    if (!SHA256_RE.test(cursorJson.previousContractSha256)) {
      findings.push({ code: 'START_CONTRACT_LINEAGE_MALFORMED', detail: cursorJson.previousContractSha256 });
      return { findings };
    }
    if (!isSafeGovernedRelative(cursorJson.previousContractPath) || !cursorJson.previousContractPath.startsWith(namespace)) {
      findings.push({ code: 'START_CONTRACT_LINEAGE_PATH_INVALID', detail: cursorJson.previousContractPath });
      return { findings };
    }
    const predecessorBytes = repoBytes(root, cursorJson.previousContractPath);
    if (!predecessorBytes) {
      findings.push({ code: 'START_CONTRACT_LINEAGE_PREDECESSOR_ABSENT', detail: cursorJson.previousContractPath });
      return { findings };
    }
    if (sha256Bytes(predecessorBytes) !== cursorJson.previousContractSha256) {
      findings.push({
        code: 'START_CONTRACT_LINEAGE_PREDECESSOR_SHA_MISMATCH',
        detail: { path: cursorJson.previousContractPath, declared: cursorJson.previousContractSha256 }
      });
      return { findings };
    }
    cursorPath = cursorJson.previousContractPath;
  }
  if (!reachedBound) {
    findings.push({ code: 'START_CONTRACT_LINEAGE_DOES_NOT_DESCEND', detail: pointerJson.contractPath });
    return { findings };
  }

  const scope = bound.json.authorizedPaths;
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((entry) => typeof entry !== 'string' || !entry)) {
    findings.push({ code: 'START_BOUND_SCOPE_UNAVAILABLE', detail: bound.relativePath });
    return { findings };
  }

  return {
    findings,
    boundSha,
    boundJson: bound.json,
    functionalExecutionScope: [...scope],
    currentContractSha256: sha256Bytes(pointerBytes)
  };
}

/** Byte facts for the exact candidate the orchestrator would apply. */
function deriveCandidateWrites({ root, gateId, transitionType, eventId, recordedAt, authorityPath, sealCohort, checkpoint, openDefects }) {
  const report = runLifecycleTransition({
    root, gateId, transitionType, eventId, authorityPath, recordedAt,
    sealCohort, checkpoint, openDefects, dryRun: true
  });
  const writes = new Map();
  for (const write of report.candidateSummary?.writes ?? []) writes.set(write.path, write);
  return { report, writes };
}

/**
 * Post-transition bytes for a cohort.
 *
 * A candidate write is the authoritative answer when the transition produces the
 * artifact. When it does not — the derived cohort authorizes four generated
 * views but an AUTHORIZATION only regenerates the status snapshot — the
 * post-transition bytes ARE the live bytes, because the transition leaves them
 * untouched. Falling back to live bytes for an artifact the candidate DOES write
 * would pin the pre-state, so the fallback is only ever reached when the
 * candidate is silent about that path.
 */
function cohortFromWrites(root, writes, roles, findings) {
  const cohort = [];
  for (const [cohortRole, repoRelativePath] of Object.entries(roles)) {
    const write = writes.get(repoRelativePath);
    if (write) {
      cohort.push({ cohortRole, repoRelativePath, sha256: write.sha256, byteLength: write.byteLength });
      continue;
    }
    const bytes = repoBytes(root, repoRelativePath);
    if (!bytes) { findings.push({ code: 'COHORT_ARTIFACT_ABSENT', detail: repoRelativePath }); continue; }
    cohort.push({ cohortRole, repoRelativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length });
  }
  return cohort;
}

export function buildGateAuthorizationDocuments({
  root, gateId, eventId, recordedAt, expiresAtUtc, reason,
  sealCohort = [], checkpoint = {}, openDefects = [], apply = true
}) {
  const findings = [];
  const recordPath = gateAuthorizationRecordPath(gateId);
  const authorityPath = gateAuthorizationAuthoritySnapshotPath(gateId);
  const statePaths = gateAuthorizationStateCohortPaths(gateId);
  const derivedPaths = gateAuthorizationDerivedCohortPaths();

  const events = ledgerEvents(root);
  const ledger = repoBytes(root, LEDGER_PATH);
  const contract = repoBytes(root, `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`);
  const pointer = repoBytes(root, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`);
  if (!ledger) findings.push({ code: 'LEDGER_ABSENT' });
  if (!contract || !pointer) findings.push({ code: 'BOOTSTRAP_CONTRACT_ABSENT' });
  const dependencyGate = registryDependency(root, gateId);
  const dependency = dependencyGate ? resolveGateDependencyProof({ root, gateId: dependencyGate }) : null;
  if (!dependency?.satisfied) findings.push({ code: 'DEPENDENCY_NOT_SATISFIED', detail: dependency?.reason ?? dependencyGate });
  if (findings.length) return { document: LIFECYCLE_RECORD_BUILDER_DOCUMENT, verdict: 'BLOCKED', findings };

  // HEAD is read the same way the authority sources read it, so the record and
  // the live re-verification cannot disagree about which commit this is.
  const head = execGitHead(root);
  if (!head) return { document: LIFECYCLE_RECORD_BUILDER_DOCUMENT, verdict: 'BLOCKED', findings: [{ code: 'HEAD_UNRESOLVABLE' }] };

  const identity = {
    schemaVersion: 1, authorityMode: LOCAL_MODE, projectId: 'WHEEL', gateId,
    purpose: 'GATE_NORMAL_AUTHORIZATION', transitionType: 'AUTHORIZATION',
    fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED', recordedAt,
    baseCommit: head, preLedgerSha256: sha256Bytes(ledger),
    previousEventSha256: events.at(-1)?.eventPayloadSha256 ?? null,
    contractSha256: sha256Bytes(contract), currentContractSha256: sha256Bytes(pointer),
    dependencyProof: dependency.proof, stateRevision: 'R0001'
  };

  if (!repoBytes(root, recordPath)) writeRepo(root, recordPath, Buffer.from('{"provisionalBuildPlaceholder":true}\n', 'utf8'));

  let record = null;
  let authority = null;
  let rounds = 0;
  let converged = false;
  while (rounds < MAX_FIXED_POINT_ROUNDS && !converged) {
    rounds += 1;
    const derivation = deriveCandidateWrites({
      root, gateId, transitionType: 'AUTHORIZATION', eventId, recordedAt,
      authorityPath: recordPath, sealCohort, checkpoint, openDefects
    });
    if (!derivation.report.candidateSummary) {
      return { document: LIFECYCLE_RECORD_BUILDER_DOCUMENT, verdict: 'BLOCKED', findings: derivation.report.findings, rounds };
    }
    const cohortFindings = [];
    const stateArtifacts = cohortFromWrites(root, derivation.writes, statePaths, cohortFindings);
    const derivedArtifacts = cohortFromWrites(root, derivation.writes, derivedPaths, cohortFindings);
    if (cohortFindings.length) return { document: LIFECYCLE_RECORD_BUILDER_DOCUMENT, verdict: 'BLOCKED', findings: cohortFindings, rounds };

    record = {
      ...identity,
      document: 'GATE_AUTHORIZATION_RECORD',
      authorizationId: `GATE_AUTHORIZATION_${gateId}_R1`,
      authorizedStateArtifacts: stateArtifacts,
      authorizedDerivedArtifacts: derivedArtifacts.map((item) => ({ cohortRole: item.cohortRole, repoRelativePath: item.repoRelativePath })),
      prohibitedOperations: [...GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS],
      executionAuthorized: false,
      reason
    };

    authority = {
      schemaVersion: 1, authorityMode: LOCAL_MODE,
      documentKind: GATE_AUTHORIZATION_AUTHORITY_KIND,
      authorityId: `ACTIVE_GATE_AUTHORITY_${gateId}_LOCAL_R1`,
      issuedBy: 'PROJECT_OWNER', issuedAtUtc: recordedAt, expiresAtUtc,
      projectId: identity.projectId, gateId, purpose: identity.purpose,
      transitionType: identity.transitionType, fromStatus: identity.fromStatus, toStatus: identity.toStatus,
      baseCommit: identity.baseCommit, preLedgerSha256: identity.preLedgerSha256,
      previousEventSha256: identity.previousEventSha256, contractSha256: identity.contractSha256,
      currentContractSha256: identity.currentContractSha256, dependencyProof: identity.dependencyProof,
      stateRevision: identity.stateRevision,
      authorizedStateArtifacts: stateArtifacts, authorizedDerivedArtifacts: derivedArtifacts,
      bindingDigestAlgorithm: GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
      approvedBindingDigest: null, approvedRequestDigest: null,
      executionAuthorized: false, maxUse: 1
    };
    authority.approvedBindingDigest = computeGateAuthorizationBindingDigest({
      ...authority, recordedAt, stateArtifacts, derivedArtifacts
    }).digest;
    authority.approvedRequestDigest = computeGateAuthorizationLocalRequestDigest(authority);

    const recordBytes = governedBytes(record);
    const authorityBytes = governedBytes(authority);
    const recordSame = repoBytes(root, recordPath)?.equals(recordBytes) === true;
    const authoritySame = repoBytes(root, authorityPath)?.equals(authorityBytes) === true;
    converged = recordSame && authoritySame;
    if (!converged && apply) {
      writeRepo(root, recordPath, recordBytes);
      writeRepo(root, authorityPath, authorityBytes);
    } else if (!converged) {
      break;
    }
  }
  return {
    document: LIFECYCLE_RECORD_BUILDER_DOCUMENT, verdict: converged || !apply ? 'BUILT' : 'BLOCKED',
    gateId, transitionType: 'AUTHORIZATION', rounds, converged,
    recordPath, authorityPath, findings: converged || !apply ? [] : [{ code: 'BUILD_DID_NOT_CONVERGE' }]
  };
}

export function buildGateStartDocuments({ root, gateId, eventId, recordedAt, expiresAtUtc, apply = true }) {
  const facts = deriveGateStartReadinessFacts(root, gateId);
  const findings = [];
  if (facts.readinessVerdict !== 'READY') findings.push({ code: 'START_READINESS_BLOCKED', detail: facts.readinessVerdict });
  if (!facts.contractJson) findings.push({ code: 'CONTRACT_ABSENT' });
  if (!facts.activeGatePreState) findings.push({ code: 'ACTIVE_GATE_ABSENT' });
  const head = execGitHead(root);
  if (!head) findings.push({ code: 'HEAD_UNRESOLVABLE' });
  const bound = resolveStartBoundContract({ root, gateId, status: facts.status });
  findings.push(...bound.findings);
  if (findings.length) return { document: LIFECYCLE_RECORD_BUILDER_DOCUMENT, verdict: 'BLOCKED', findings };

  const record = {
    schemaVersion: 1, authorityMode: LOCAL_MODE, document: 'GATE_START_RECORD',
    recordId: `GATE_START_RECORD_${gateId}_R1`, projectId: facts.projectId, gateId,
    purpose: 'START_PLUS_EXECUTION_AUTHORITY', eventId, transitionType: 'START',
    fromStatus: 'AUTHORIZED_NOT_STARTED', toStatus: 'IN_PROGRESS', recordedAt,
    baseCommit: head, preStartLedgerSha256: facts.preStartLedgerSha256,
    previousEventSha256: facts.previousEventSha256, contractSha256: bound.boundSha,
    currentContractSha256: bound.currentContractSha256, preStateRevision: facts.preStateRevision,
    preCurrentStateSha256: facts.preCurrentStateSha256, preStateSealSha256: facts.preStateSealSha256,
    readinessDigest: computeGateStartReadinessDigest({
      projectId: facts.projectId, gateId, status: 'AUTHORIZED_NOT_STARTED',
      preStartLedgerSha256: facts.preStartLedgerSha256, previousEventSha256: facts.previousEventSha256,
      preStateRevision: facts.preStateRevision, preCurrentStateSha256: facts.preCurrentStateSha256,
      preStateSealSha256: facts.preStateSealSha256, openDefectsKnowledge: facts.openDefectsKnowledge,
      contractSha256: bound.boundSha, currentContractSha256: bound.currentContractSha256,
      dependencyProof: facts.dependencyProof, readinessVerdict: 'READY'
    }),
    dependencyProof: facts.dependencyProof, activeGatePreState: facts.activeGatePreState,
    authorizedStartWritePaths: [...gateStartWriteCohortPaths(gateId)],
    functionalExecutionScope: [...bound.functionalExecutionScope],
    expiresAtUtc, maxUse: 1,
    prohibitedOperations: [...GATE_START_PROHIBITED_OPERATIONS],
    startAuthorized: true, executionAuthorized: true, recordDigest: null
  };
  record.recordDigest = computeGateStartRecordDigest(record);

  const { document, recordId, recordDigest, ...shared } = record;
  const authority = {
    schemaVersion: 1, documentKind: 'PROJECT_OWNER_GATE_START_AUTHORITY',
    authorityId: `GATE_START_AUTHORITY_${gateId}_LOCAL_R1`, issuedBy: 'PROJECT_OWNER',
    issuedAtUtc: recordedAt, requestDigest: null, recordDigest, bindingDigest: null,
    ...shared
  };
  authority.requestDigest = computeGateStartLocalRequestDigest(authority);
  authority.bindingDigest = computeGateStartBindingDigestFromDigests({ requestDigest: authority.requestDigest, recordDigest });

  if (apply) {
    writeRepo(root, gateStartRecordPath(gateId), governedBytes(record));
    writeRepo(root, gateStartAuthorityPath(gateId), governedBytes(authority));
  }
  return {
    document: LIFECYCLE_RECORD_BUILDER_DOCUMENT, verdict: 'BUILT', gateId, transitionType: 'START',
    recordPath: gateStartRecordPath(gateId), authorityPath: gateStartAuthorityPath(gateId),
    record, authority, findings: []
  };
}

function execGitHead(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const transition = option('--transition', 'AUTHORIZATION');
  const shared = {
    root, gateId: option('--gate'), eventId: option('--event-id'),
    recordedAt: option('--recorded-at', new Date().toISOString()),
    expiresAtUtc: option('--expires', '2026-12-31T23:59:59.000Z'),
    apply: process.argv.includes('--apply')
  };
  const report = transition === 'START'
    ? buildGateStartDocuments(shared)
    : buildGateAuthorizationDocuments({ ...shared, reason: option('--reason', `Local explicit ${transition} for ${shared.gateId}.`) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === 'BLOCKED' ? 2 : 0;
}
