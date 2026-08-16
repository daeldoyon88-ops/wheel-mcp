/**
 * CANONICAL_AUTHORIZED_COHORT — the exact set of paths a Gate was allowed to
 * touch, derived from authority documents and nothing else.
 *
 * WHAT THIS EXISTS TO CLOSE. FINAL_GATE_INTEGRITY used to accept its cohort as a
 * `--cohort` argument. A caller could therefore hand it the observed Git delta,
 * and "delta minus cohort is empty" became a tautology that could not fail. A
 * PASS proved only that someone had typed the right list.
 *
 * THE CHAIN, AND WHY EACH LINK IS REQUIRED.
 *
 *   authority document  — names a manifest and pins its digest
 *   authorized manifest — names exact paths, no wildcards, no directories
 *   consumption record  — proves the program actually ran under that authority
 *   derived cohort      — the union of what those documents authorized
 *
 * A post-freeze program contributes paths only when all three links hold. An
 * authority whose manifest digest has drifted contributes nothing; so does one
 * that was never consumed, because an unconsumed authority describes work that
 * did not happen. Both cases are reported as REFUSED sources rather than being
 * silently dropped, so a caller can see WHY a path is absent from the cohort.
 *
 * WHAT NEVER CONTRIBUTES. Git. Not `git status`, not the diff, not the index.
 * The derivation cannot read the thing it exists to judge, so there is no
 * fallback and no union with the observed delta — an empty or partial cohort
 * fails the audit rather than being topped up from what happens to be on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateMaintenanceAuthorizedPathManifest } from './post-freeze-maintenance-authority.mjs';

export const COHORT_DOCUMENT = 'CANONICAL_AUTHORIZED_COHORT';
export const COHORT_ALGORITHM_VERSION = 'R1';

const GATE_RE = /^GATE[0-9]{2}$/;

function readJsonOrNull(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

function sha256File(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}

function pathsFrom(value, key) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry : entry?.[key]))
    .filter((entry) => typeof entry === 'string' && entry.startsWith('governance/'));
}

/**
 * @returns {{
 *   document: string, algorithmVersion: string, gateId: string,
 *   cohort: string[], cohortDigest: string,
 *   sources: Array<{sourcePath: string, kind: string, sha256: string|null, admitted: boolean, pathCount: number, refusedReason: string|null}>,
 *   refusedSources: number, valid: boolean, findings: Array<{code: string, detail?: string}>
 * }}
 */
export function deriveCanonicalAuthorizedCohort({ root, gateId }) {
  const findings = [];
  const sources = [];
  const cohort = new Set();
  if (!GATE_RE.test(gateId || '')) {
    return {
      document: COHORT_DOCUMENT, algorithmVersion: COHORT_ALGORITHM_VERSION, gateId,
      cohort: [], cohortDigest: null, sources, refusedSources: 0, valid: false,
      findings: [{ code: 'GATE_ID_INVALID', detail: gateId }]
    };
  }

  const admit = (sourcePath, kind, paths) => {
    sources.push({ sourcePath, kind, sha256: sha256File(root, sourcePath), admitted: true, pathCount: paths.length, refusedReason: null });
    for (const entry of paths) cohort.add(entry);
  };
  const refuse = (sourcePath, kind, reason) => {
    sources.push({ sourcePath, kind, sha256: sha256File(root, sourcePath), admitted: false, pathCount: 0, refusedReason: reason });
    findings.push({ code: 'AUTHORITY_SOURCE_REFUSED', detail: `${sourcePath}:${reason}` });
  };

  /* ---- Gate lifecycle authority records ------------------------------- */
  const authorizationPath = `governance/authority/authorizations/${gateId}/GATE_AUTHORIZATION_RECORD.json`;
  const authorization = readJsonOrNull(root, authorizationPath);
  if (!authorization) refuse(authorizationPath, 'GATE_AUTHORIZATION_RECORD', 'ABSENT_OR_UNREADABLE');
  else {
    admit(authorizationPath, 'GATE_AUTHORIZATION_RECORD', [
      ...pathsFrom(authorization.authorizedStateArtifacts, 'repoRelativePath'),
      ...pathsFrom(authorization.authorizedDerivedArtifacts, 'repoRelativePath')
    ]);
  }

  const startPath = `governance/authority/authorizations/${gateId}/GATE_START_RECORD.json`;
  const start = readJsonOrNull(root, startPath);
  if (!start) refuse(startPath, 'GATE_START_RECORD', 'ABSENT_OR_UNREADABLE');
  else {
    admit(startPath, 'GATE_START_RECORD', [
      ...pathsFrom(start.authorizedStartWritePaths, 'path'),
      ...pathsFrom(start.functionalExecutionScope, 'path')
    ]);
  }

  /* ---- Precontract bootstrap authority --------------------------------- */
  const precontractPath = `governance/authority/precontract/${gateId}/PROJECT_OWNER_LOCAL_PRECONTRACT_AUTHORITY.json`;
  const precontract = readJsonOrNull(root, precontractPath);
  if (precontract) admit(precontractPath, 'PRECONTRACT_LOCAL_AUTHORITY', pathsFrom(precontract.authorizedPaths, 'path'));

  /* ---- The execution contract this Gate is actually bound to ----------- */
  const current = readJsonOrNull(root, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`);
  const contractPath = typeof current?.contractPath === 'string' && current.contractPath.startsWith('governance/') && !current.contractPath.includes('..')
    ? current.contractPath
    : null;
  if (contractPath) {
    const contract = readJsonOrNull(root, contractPath);
    if (!contract) refuse(contractPath, 'EXECUTION_CONTRACT', 'ABSENT_OR_UNREADABLE');
    else {
      admit(contractPath, 'EXECUTION_CONTRACT', [
        ...pathsFrom(contract.requiredOutputs, 'path'),
        ...pathsFrom(contract.authorizedPaths, 'path')
      ]);
    }
  }

  /* ---- Post-freeze maintenance programs bound to this Gate ------------- */
  //
  // Selection is by the authority's own pre-state, not by file name: a program
  // belongs to this Gate when it declared this Gate as the state it acts on.
  const sourcesDir = path.resolve(root, 'governance', 'sources');
  const sourceFiles = fs.existsSync(sourcesDir)
    ? fs.readdirSync(sourcesDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  for (const name of sourceFiles) {
    const relativePath = `governance/sources/${name}`;
    const authority = readJsonOrNull(root, relativePath);
    if (authority?.document !== 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY') continue;
    if (authority?.schemaVersion !== 2) continue;
    if (authority?.preState?.gateId !== gateId) continue;

    const manifestPath = authority.authorizedPathManifestPath;
    const manifest = typeof manifestPath === 'string' ? readJsonOrNull(root, manifestPath) : null;
    if (!manifest) { refuse(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', 'MANIFEST_ABSENT'); continue; }
    if (sha256File(root, manifestPath) !== authority.authorizedPathManifestSha256) {
      refuse(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', 'MANIFEST_DIGEST_DRIFTED');
      continue;
    }
    const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);
    if (!manifestResult.valid) { refuse(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', 'MANIFEST_INVALID'); continue; }

    // Consumption is what turns an authorization into history. Its own bindings
    // are re-checked here rather than trusted.
    const consumption = typeof authority.consumptionRecordPath === 'string' ? readJsonOrNull(root, authority.consumptionRecordPath) : null;
    if (!consumption) { refuse(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', 'CONSUMPTION_ABSENT'); continue; }
    if (consumption.authorityId !== authority.authorityId
      || consumption.programId !== authority.programId
      || consumption.manifestSha256 !== authority.authorizedPathManifestSha256
      || consumption.baseHead !== authority.preState.baseHead
      || consumption.consumedUse !== 1) {
      refuse(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', 'CONSUMPTION_BINDING_INVALID');
      continue;
    }
    admit(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', manifestResult.authorizedPaths);
  }

  const ordered = [...cohort].sort();
  return {
    document: COHORT_DOCUMENT,
    algorithmVersion: COHORT_ALGORITHM_VERSION,
    gateId,
    cohort: ordered,
    cohortDigest: sha256Canonical({ gateId, algorithmVersion: COHORT_ALGORITHM_VERSION, cohort: ordered }),
    sources,
    refusedSources: sources.filter((entry) => !entry.admitted).length,
    valid: findings.length === 0,
    findings
  };
}
