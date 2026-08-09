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
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { detectSealedMutation } from '../contracts/detect-sealed-mutation.mjs';

export const MISSIONS_DIR = 'governance/gee-v1/missions';
export const MISSION_WORK_UNIT_TYPE = 'MISSION_REVISION';

/**
 * satisfactionRule naming a prerequisite on another revision of the same
 * mission. Resolved entirely from files by this source.
 */
export const RULE_REVISION_DELIVERED = 'gee-mission-revision-delivered';

const CONTRACT_FILE_RE = /^GEE_V1_EXECUTION_CONTRACT_(R\d{4})\.json$/;

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
export function createGeeMissionAuthoritySource(repoRoot, { projectId = 'WHEEL', prerequisiteResolvers = {} } = {}) {
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
