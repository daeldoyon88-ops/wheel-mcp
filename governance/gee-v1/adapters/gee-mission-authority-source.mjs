/**
 * GEE mission-revision execution-authority source.
 *
 * A GEE mission advances in immutable revisions (R0001, R0002, ...), each with
 * its own sealed execution contract under governance/gee-v1/missions/. Those
 * contracts already existed; what did not exist was anything able to resolve
 * one as a work unit, which is why an independent mission had no route to
 * execution authority and could only have obtained one by impersonating a
 * work-unit type it is not.
 *
 * Two design constraints shaped this file:
 *
 * 1. NO SECOND STATUS LEDGER. A mission revision has no append-only status
 *    spine and must not grow one. Delivery is therefore RECOMPUTED from real
 *    files — a revision is delivered when its contract validates, its seal is
 *    intact, and every artifact it declared required actually exists — never
 *    read from a status field. That is also what closes a finished revision:
 *    once a LATER revision declares a satisfied prerequisite on it, the earlier
 *    revision stops being executable. The successor's own prerequisite is the
 *    proof, so the transition needs no new document.
 *
 * 2. NO REVISION IS NAMED HERE. Revisions are discovered by scanning the
 *    missions directory and indexing each contract by its own declared id, so
 *    adding a future revision requires adding a contract, not editing code.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { detectSealedMutation } from '../contracts/detect-sealed-mutation.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import {
  evaluatePostFreezeMaintenanceAuthorityV2,
  isExactMaintenancePath,
  PHASE_AUTHORIZE_PROGRAM_APPLY
} from '../core/post-freeze-maintenance-authority.mjs';

export const MISSIONS_DIR = 'governance/gee-v1/missions';
export const MISSION_WORK_UNIT_TYPE = 'MISSION_REVISION';
export const POST_FREEZE_MAINTENANCE_AUTHORITY_RELATIVE_ROOT = 'governance/sources';
export const POST_FREEZE_MAINTENANCE_AUTHORITY_FILENAME_RE =
  /^GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_[A-Za-z0-9_-]+\.json$/;
export const POST_FREEZE_MAINTENANCE_AUTHORITY_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'post-freeze-maintenance-authority.schema.json'
);
export const POST_FREEZE_MAINTENANCE_AUTHORITY_V2_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'post-freeze-maintenance-authority-v2.schema.json'
);
export const POST_FREEZE_MAINTENANCE_AUTHORITY_CLASS = 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY';
export const CANONICAL_GEE_REVISION_WORK_UNIT_ID_RE = /^GOVERNANCE_EXECUTION_EFFICIENCY_V1_R[0-9]+$/;

/**
 * satisfactionRule naming a prerequisite on another revision of the same
 * mission. Resolved entirely from files by this source.
 */
export const RULE_REVISION_DELIVERED = 'gee-mission-revision-delivered';

const CONTRACT_FILE_RE = /^GEE_V1_EXECUTION_CONTRACT_(R\d{4})\.json$/;

function loadPostFreezeMaintenanceAuthorities(root) {
  const sourcesPath = path.join(root, ...POST_FREEZE_MAINTENANCE_AUTHORITY_RELATIVE_ROOT.split('/'));
  let v1Schema;
  let v2Schema;
  try {
    v1Schema = readJson(POST_FREEZE_MAINTENANCE_AUTHORITY_SCHEMA_PATH);
    v2Schema = readJson(POST_FREEZE_MAINTENANCE_AUTHORITY_V2_SCHEMA_PATH);
  } catch {
    return [{ authority: null, authorityPath: null, authorityRelativePath: null, validation: { valid: false, errors: [{ message: 'maintenance authority schema is unavailable' }] } }];
  }
  let entries;
  try {
    entries = fs.readdirSync(sourcesPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && POST_FREEZE_MAINTENANCE_AUTHORITY_FILENAME_RE.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const authorityPath = path.join(sourcesPath, entry.name);
      const authorityRelativePath = `${POST_FREEZE_MAINTENANCE_AUTHORITY_RELATIVE_ROOT}/${entry.name}`;
      let authority;
      try {
        authority = readJson(authorityPath);
      } catch {
        return { authority: null, authorityPath, authorityRelativePath, validation: { valid: false, errors: [{ message: 'authority is not valid JSON' }] } };
      }
      const schema = authority.schemaVersion === 2 ? v2Schema : v1Schema;
      return {
        authority,
        authorityPath,
        authorityRelativePath,
        authoritySha256: crypto.createHash('sha256').update(fs.readFileSync(authorityPath)).digest('hex'),
        validation: validateAgainstJsonSchema(authority, schema)
      };
    });
}

function authorityWorkUnitId(authority) {
  return authority?.schemaVersion === 2 ? authority?.programId : authority?.workUnitId;
}

function maintenanceAuthorityConflictResult(workUnitId, candidates) {
  const paths = candidates.map((candidate) => candidate.authorityRelativePath).join(', ');
  return {
    workUnitId,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    authorityKind: 'POST_FREEZE_MAINTENANCE',
    contract: null,
    contractPath: null,
    sealPath: null,
    authorizedPaths: [],
    findings: [{ code: 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONFLICT', detail: `multiple maintenance authorities claim workUnitId ${workUnitId}: ${paths}` }],
    proofs: {
      EXECUTION_CONTRACT: { state: 'NOT_APPLICABLE', reason: 'post-freeze maintenance is not a GEE revision' },
      CONTRACT_INTEGRITY: { state: 'FAILED', reason: 'multiple post-freeze maintenance authorities claim the same work unit' },
      PREREQUISITES: { state: 'NOT_APPLICABLE', reason: 'owner-authorized maintenance scope has no revision prerequisite' },
      WORK_UNIT_EXECUTABLE: { state: 'FAILED', reason: 'post-freeze maintenance authority conflict' }
    }
  }
}

function readJsonIfPresent(file) {
  try { return readJson(file); } catch { return null; }
}

function resolveGovernedFile(root, relativePath) {
  if (!isExactMaintenancePath(relativePath)) return null;
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null;
}

function observeV2MaintenanceAuthority(root, authority, manifest, loadedAuthorities) {
  const ledgerPath = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
  const ledgerBytes = fs.readFileSync(ledgerPath);
  const ledgerLines = ledgerBytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim());
  const ledgerEvents = ledgerLines.map((line) => JSON.parse(line));
  const gateEvents = authority.preState.gateId === null ? [] : ledgerEvents.filter((event) => event.gateId === authority.preState.gateId);
  const gateStateRoot = authority.preState.gateId === null ? null : path.join(root, 'governance', 'gates', authority.preState.gateId);
  const currentState = gateStateRoot ? readJsonIfPresent(path.join(gateStateRoot, 'state', 'CURRENT_STATE.json')) : null;
  const currentContract = gateStateRoot ? readJsonIfPresent(path.join(gateStateRoot, 'contracts', 'CURRENT_CONTRACT.json')) : null;
  const activeGate = readJsonIfPresent(path.join(root, 'governance', 'active', 'ACTIVE_GATE.json'));
  const manifestPath = resolveGovernedFile(root, authority.authorizedPathManifestPath);
  const predecessor = authority.authorityPredecessor === null
    ? null
    : loadedAuthorities.find((candidate) => candidate.authority?.authorityId === authority.authorityPredecessor.authorityId);
  return {
    baseHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    ledgerEventCount: ledgerLines.length,
    ledgerPrefixSha256: crypto.createHash('sha256').update(ledgerBytes).digest('hex'),
    gateId: authority.preState.gateId,
    gateStatus: gateEvents.at(-1)?.toStatus ?? null,
    stateRevision: currentState?.stateRevision ?? null,
    contractRevision: currentContract?.contractRevision ?? null,
    activeGate: activeGate?.activeGate ?? null,
    R8Absent: !fs.existsSync(path.join(root, 'governance', 'gee-v1', 'missions', 'GEE_V1_EXECUTION_CONTRACT_R0008.json')),
    manifestSha256: manifestPath ? crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex') : null,
    authorityPredecessorSha256: predecessor?.authoritySha256 ?? null,
    requestedPaths: manifest?.paths?.map((entry) => entry.path) ?? [],
    requestedOperationClasses: manifest?.paths?.map((entry) => entry.artifactClass) ?? []
  };
}

function maintenanceAuthorityV2Result(workUnitId, loaded, root, loadedAuthorities, maintenanceObservationProvider) {
  const authority = loaded.authority;
  const manifestPath = resolveGovernedFile(root, authority?.authorizedPathManifestPath);
  const consumptionPath = resolveGovernedFile(root, authority?.consumptionRecordPath);
  const manifest = manifestPath ? readJsonIfPresent(manifestPath) : null;
  const consumptionRecord = consumptionPath ? readJsonIfPresent(consumptionPath) : null;
  let observed = {};
  let observationFinding = null;
  try {
    observed = typeof maintenanceObservationProvider === 'function'
      ? maintenanceObservationProvider({ root, authority, manifest, loadedAuthorities })
      : observeV2MaintenanceAuthority(root, authority, manifest, loadedAuthorities);
  } catch (error) {
    observationFinding = { code: 'POST_FREEZE_MAINTENANCE_OBSERVATION_FAILED', detail: error?.message || String(error) };
  }
  const evaluation = evaluatePostFreezeMaintenanceAuthorityV2({
    authority,
    manifest,
    observed,
    phase: PHASE_AUTHORIZE_PROGRAM_APPLY,
    consumptionRecord
  });
  const findings = [
    ...(loaded.validation.valid ? [] : [{ code: 'POST_FREEZE_MAINTENANCE_V2_SCHEMA_INVALID', detail: loaded.validation.errors }]),
    ...(observationFinding ? [observationFinding] : []),
    ...evaluation.findings
  ];
  const valid = findings.length === 0 && evaluation.programAuthorized;
  const validationReason = valid
    ? `schema-valid local explicit V2 maintenance authority: ${loaded.authorityRelativePath}`
    : `invalid or inapplicable V2 maintenance authority: ${loaded.authorityRelativePath}`;
  return {
    workUnitId,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    authorityKind: 'POST_FREEZE_MAINTENANCE_V2',
    contract: null,
    contractPath: null,
    sealPath: null,
    authorizedPaths: valid ? evaluation.authorizedPaths : [],
    authorizedOperationClasses: valid ? evaluation.authorizedOperationClasses : [],
    findings,
    proofs: {
      EXECUTION_CONTRACT: { state: 'NOT_APPLICABLE', reason: 'post-freeze maintenance is not a GEE revision' },
      CONTRACT_INTEGRITY: { state: valid ? 'PROVEN' : 'FAILED', reason: validationReason },
      PREREQUISITES: { state: 'NOT_APPLICABLE', reason: 'local explicit maintenance program has a bound pre-state instead of revision prerequisites' },
      WORK_UNIT_EXECUTABLE: valid
        ? { state: 'PROVEN', reason: 'single-use LOCAL_EXPLICIT_AUTHORITY V2 program authority matches the exact live pre-state and manifest' }
        : { state: 'FAILED', reason: validationReason }
    }
  };
}

function maintenanceAuthorityResult(workUnitId, loaded, root, loadedAuthorities, maintenanceObservationProvider) {
  if (loaded.authority?.schemaVersion === 2) {
    return maintenanceAuthorityV2Result(workUnitId, loaded, root, loadedAuthorities, maintenanceObservationProvider);
  }
  const valid = Boolean(loaded?.validation?.valid)
    && loaded.authority?.workUnitId === workUnitId
    && loaded.authority?.authorityClass === POST_FREEZE_MAINTENANCE_AUTHORITY_CLASS
    && loaded.authority?.issuedBy === 'PROJECT_OWNER'
    && loaded.authority?.targetSystem === 'GEE_V1'
    && loaded.authority?.frozenRevision === 'R7'
    && loaded.authority?.newGeeRevisionAuthorized === false
    && loaded.authority?.r8Authorized === false
    && loaded.authority?.gateExecutionAuthorized === false
    && loaded.authority?.successorAuthorization === false
    && loaded.authority?.unrelatedWritesAuthorized === false;
  const validationReason = valid
    ? `schema-valid PROJECT_OWNER maintenance authority: ${loaded.authorityRelativePath}`
    : `invalid PROJECT_OWNER maintenance authority: ${loaded.authorityRelativePath}`;
  return {
    workUnitId,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    authorityKind: 'POST_FREEZE_MAINTENANCE',
    contract: null,
    contractPath: null,
    sealPath: null,
    authorizedPaths: valid ? [...loaded.authority.authorizedPaths] : [],
    findings: valid ? [] : [{ code: 'POST_FREEZE_MAINTENANCE_AUTHORITY_INVALID', detail: validationReason }],
    proofs: {
      EXECUTION_CONTRACT: { state: 'NOT_APPLICABLE', reason: 'post-freeze maintenance is not a GEE revision' },
      CONTRACT_INTEGRITY: { state: valid ? 'PROVEN' : 'FAILED', reason: validationReason },
      PREREQUISITES: { state: 'NOT_APPLICABLE', reason: 'owner-authorized maintenance scope has no revision prerequisite' },
      WORK_UNIT_EXECUTABLE: valid
        ? { state: 'PROVEN', reason: 'exact owner-authorized post-freeze maintenance work unit' }
        : { state: 'FAILED', reason: validationReason }
    }
  };
}

function reservedMaintenanceWorkUnitResult(workUnitId, candidates) {
  const paths = candidates.map((candidate) => candidate.authorityRelativePath).join(', ');
  return {
    workUnitId,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    authorityKind: 'POST_FREEZE_MAINTENANCE',
    contract: null,
    contractPath: null,
    sealPath: null,
    authorizedPaths: [],
    findings: [{ code: 'POST_FREEZE_MAINTENANCE_RESERVED_WORK_UNIT_ID', detail: `maintenance authority cannot claim canonical GEE revision workUnitId ${workUnitId}: ${paths}` }],
    proofs: {
      EXECUTION_CONTRACT: { state: 'NOT_APPLICABLE', reason: 'post-freeze maintenance is not a GEE revision' },
      CONTRACT_INTEGRITY: { state: 'FAILED', reason: 'reserved canonical GEE revision workUnitId claimed by maintenance authority' },
      PREREQUISITES: { state: 'NOT_APPLICABLE', reason: 'owner-authorized maintenance scope has no revision prerequisite' },
      WORK_UNIT_EXECUTABLE: { state: 'FAILED', reason: 'canonical GEE revision namespace is reserved for the revision authority' }
    }
  };
}

function readJson(absolutePath) {
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8').replace(/^﻿/, ''));
}

/**
 * Locate the seal for one revision. The versioned name is canonical; the
 * unversioned name is accepted only for the first revision, which was sealed
 * before a second revision existed. The fallback cannot mis-bind, because the
 * seal payload must independently name this exact contract id AND version
 * before it is honoured — identity is asserted before the evidence is used.
 */
function loadSeal(missionsAbsDir, contract) {
  const candidates = [
    `GEE_V1_EXECUTION_CONTRACT_${contract.version}_SEAL.json`,
    'GEE_V1_EXECUTION_CONTRACT_SEAL.json'
  ];
  for (const candidate of candidates) {
    const sealPath = path.join(missionsAbsDir, candidate);
    if (!fs.existsSync(sealPath)) continue;
    let seal;
    try {
      seal = readJson(sealPath);
    } catch {
      continue;
    }
    if (seal?.payload?.contractId === contract.id && seal?.payload?.contractVersion === contract.version) {
      return { seal, sealPath: `${MISSIONS_DIR}/${candidate}` };
    }
  }
  return { seal: null, sealPath: null };
}

function loadRevisions(root) {
  const missionsAbsDir = path.join(root, ...MISSIONS_DIR.split('/'));
  const revisions = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(missionsAbsDir);
  } catch {
    return { missionsAbsDir, revisions };
  }
  for (const entry of entries.sort()) {
    if (!CONTRACT_FILE_RE.test(entry)) continue;
    let contract;
    try {
      contract = readJson(path.join(missionsAbsDir, entry));
    } catch {
      continue;
    }
    if (typeof contract?.id !== 'string' || !contract.id) continue;
    const { seal, sealPath } = loadSeal(missionsAbsDir, contract);
    revisions.set(contract.id, {
      contract,
      contractPath: `${MISSIONS_DIR}/${entry}`,
      seal,
      sealPath,
      validation: validateExecutionContract(contract),
      sealStatus: detectSealedMutation(contract, seal).status
    });
  }
  return { missionsAbsDir, revisions };
}

/**
 * Recomputed delivery: contract valid, seal intact, and every declared
 * required artifact present on disk. Absence of any one of them is not
 * delivery — nothing here is upgraded by a field.
 */
function deriveDelivered(root, revision) {
  if (!revision) return { delivered: false, reason: 'REVISION_ABSENT' };
  if (!revision.validation.valid) return { delivered: false, reason: 'EXECUTION_CONTRACT_INVALID' };
  if (revision.sealStatus !== 'INTACT') return { delivered: false, reason: `SEAL_${revision.sealStatus}` };
  const missing = (revision.contract.requiredArtifacts || []).filter(
    (artifact) => typeof artifact !== 'string' || !fs.existsSync(path.join(root, ...artifact.split('/')))
  );
  if (missing.length) return { delivered: false, reason: `REQUIRED_ARTIFACT_ABSENT:${missing.length}` };
  return { delivered: true, reason: 'CONTRACT_SEALED_AND_ALL_REQUIRED_ARTIFACTS_PRESENT' };
}

/**
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {string} [options.projectId]
 * @param {Record<string, (prerequisite: object) => {status: string, reason?: string}>} [options.prerequisiteResolvers]
 *   Resolvers for satisfactionRules this source does not own — a mission whose
 *   prerequisite is a host-project work unit gets it injected rather than this
 *   file learning what the host project's work units are. An unresolvable rule
 *   is UNKNOWN, which is BLOCKED.
 */
export function createGeeMissionAuthoritySource(repoRoot, { projectId = 'WHEEL', prerequisiteResolvers = {}, maintenanceObservationProvider = null } = {}) {
  const root = path.resolve(repoRoot);

  function resolvePrerequisite(revisions, prerequisite) {
    const rule = prerequisite?.satisfactionRule;
    if (rule === RULE_REVISION_DELIVERED) {
      const target = deriveDelivered(root, revisions.get(prerequisite.id));
      return { status: target.delivered ? 'SATISFIED' : 'UNSATISFIED', reason: target.reason };
    }
    const injected = typeof rule === 'string' ? prerequisiteResolvers[rule] : null;
    if (typeof injected !== 'function') {
      return { status: 'UNKNOWN', reason: rule ? `NO_RESOLVER_FOR_RULE:${rule}` : 'SATISFACTION_RULE_UNDECLARED' };
    }
    try {
      const resolved = injected(prerequisite);
      return { status: resolved?.status || 'UNKNOWN', reason: resolved?.reason || null };
    } catch (error) {
      return { status: 'UNKNOWN', reason: error?.message || String(error) };
    }
  }

  /**
   * Has a LATER revision already taken over from this one? True only when that
   * successor declares a prerequisite on this revision AND that prerequisite
   * currently resolves SATISFIED, i.e. this revision really is delivered. A
   * successor contract alone never closes a predecessor that has not shipped.
   */
  function findSucceedingRevision(revisions, workUnitId) {
    for (const [candidateId, candidate] of revisions) {
      if (candidateId === workUnitId) continue;
      if (candidate.contract.version <= (revisions.get(workUnitId)?.contract.version ?? '')) continue;
      const claim = (candidate.contract.prerequisites || []).find(
        (prerequisite) => prerequisite?.id === workUnitId && prerequisite?.satisfactionRule === RULE_REVISION_DELIVERED
      );
      if (!claim) continue;
      if (deriveDelivered(root, revisions.get(workUnitId)).delivered) return candidateId;
    }
    return null;
  }

  return {
    projectId,
    workUnitType: MISSION_WORK_UNIT_TYPE,
    sourceId: 'gee-mission-authority-source',

    listWorkUnitIds() {
      return [...loadRevisions(root).revisions.keys()];
    },

    resolveWorkUnitAuthority(workUnitId) {
      const { revisions } = loadRevisions(root);
      const loadedMaintenance = loadPostFreezeMaintenanceAuthorities(root);
      const maintenance = loadedMaintenance
        .filter((candidate) => authorityWorkUnitId(candidate.authority) === workUnitId);
      if (maintenance.length > 0 && CANONICAL_GEE_REVISION_WORK_UNIT_ID_RE.test(workUnitId)) {
        return reservedMaintenanceWorkUnitResult(workUnitId, maintenance);
      }
      if (maintenance.length > 1) {
        return maintenanceAuthorityConflictResult(workUnitId, maintenance);
      }
      if (maintenance.length === 1) {
        return maintenanceAuthorityResult(workUnitId, maintenance[0], root, loadedMaintenance, maintenanceObservationProvider);
      }
      const revision = revisions.get(workUnitId);
      if (!revision) return null;

      const findings = [];
      const prerequisiteStatuses = {};
      let prerequisitesProven = true;
      let prerequisiteReason = 'all critical prerequisites SATISFIED';
      for (const prerequisite of revision.contract.prerequisites || []) {
        const resolved = resolvePrerequisite(revisions, prerequisite);
        prerequisiteStatuses[prerequisite.id] = resolved;
        if (prerequisite.critical && resolved.status !== 'SATISFIED') {
          prerequisitesProven = false;
          prerequisiteReason = `${prerequisite.id}: ${resolved.status}${resolved.reason ? ` (${resolved.reason})` : ''}`;
        }
      }

      const succeededBy = findSucceedingRevision(revisions, workUnitId);

      return {
        workUnitId,
        workUnitType: MISSION_WORK_UNIT_TYPE,
        contract: revision.contract,
        contractPath: revision.contractPath,
        sealPath: revision.sealPath,
        authorizedPaths: revision.contract.authorizedPaths || [],
        prerequisiteStatuses,
        succeededBy,
        findings,
        proofs: {
          EXECUTION_CONTRACT: revision.validation.valid
            ? { state: 'PROVEN', reason: revision.contractPath }
            : { state: 'FAILED', reason: revision.validation.findings.map((f) => f.detectorId).join(',') },
          CONTRACT_INTEGRITY: revision.sealStatus === 'INTACT'
            ? { state: 'PROVEN', reason: `sealed and intact: ${revision.sealPath}` }
            : { state: 'FAILED', reason: `seal status ${revision.sealStatus}` },
          PREREQUISITES: prerequisitesProven
            ? { state: 'PROVEN', reason: prerequisiteReason }
            : { state: 'FAILED', reason: prerequisiteReason },
          WORK_UNIT_EXECUTABLE: succeededBy
            ? { state: 'FAILED', reason: `delivered and superseded by ${succeededBy}` }
            : { state: 'PROVEN', reason: 'latest revision of this mission with no delivered successor' }
        }
      };
    }
  };
}
