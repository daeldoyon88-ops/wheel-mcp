/**
 * Wheel adapter — release policy.
 *
 * Maps the project-agnostic release primitive onto this repository. The generic
 * core knows nothing about gates, this repo's ledger, or its witness; all of
 * that lives here, exactly as the readiness/witness adapters already do.
 *
 * The core is told `workUnitType` as an opaque string. GATE13 appears nowhere in
 * the core — it is simply the first consumer.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isWithinGovernedRoots } from '../../core/witness-source.mjs';

export const WHEEL_RELEASE_POLICY = Object.freeze({
  projectId: 'REPO-WHEEL-JARVISE-PRIMARY',
  workUnitType: 'GATE',
  branch: 'main',
  ownerPublicKeyPath: 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json',
  governedStateBindings: [
    { bindingId: 'CANONICAL_LEDGER', path: 'governance/state/GATE_STATUS_LEDGER.ndjson' }
  ]
});

export function sha256File(absolutePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Resolves the current closure verdict of a Wheel work unit from the canonical
 * append-only ledger — recomputed from the last event, never read from a
 * summary field or a generated snapshot.
 */
export function resolveWorkUnitClosures(repoRoot, workUnitIds) {
  const ledgerPath = path.join(repoRoot, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const closures = {};
  let events;
  try {
    events = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return closures;
  }
  for (const workUnitId of workUnitIds) {
    const last = events.filter((event) => event.gateId === workUnitId).at(-1);
    if (last) closures[workUnitId] = last.toStatus;
  }
  return closures;
}

/**
 * Live facts the pure core needs. Everything here is READ; nothing is written.
 * `externalWitnessIsExternal` re-applies the same governed-root boundary the
 * witness loader uses, so a witness that migrated into the repo cannot silently
 * keep satisfying a release binding.
 */
export function buildObservedState({ repoRoot, headCommit, branch, request, stagedPaths = null, env = process.env }) {
  const governedStateSha256 = {};
  for (const binding of WHEEL_RELEASE_POLICY.governedStateBindings) {
    governedStateSha256[binding.bindingId] = sha256File(path.join(repoRoot, binding.path));
  }

  let externalWitnessSha256 = null;
  let externalWitnessIsExternal = false;
  const witnessPath = request?.externalWitness?.path || env.GEE_HEAD_WITNESS_SOURCE || null;
  if (witnessPath) {
    let realWitnessPath = null;
    try {
      realWitnessPath = fs.realpathSync(witnessPath);
    } catch {
      realWitnessPath = null;
    }
    if (realWitnessPath && !isWithinGovernedRoots(realWitnessPath, [repoRoot])) {
      externalWitnessIsExternal = true;
      externalWitnessSha256 = sha256File(witnessPath);
    }
  }

  const manifestPathSha256 = {};
  for (const entry of request?.manifest || []) {
    const absolute = path.join(repoRoot, entry.path);
    manifestPathSha256[entry.path] = fs.existsSync(absolute) ? sha256File(absolute) : null;
  }

  return {
    projectId: WHEEL_RELEASE_POLICY.projectId,
    branch,
    headCommit,
    governedStateSha256,
    externalWitnessSha256,
    externalWitnessIsExternal,
    manifestPathSha256,
    stagedPaths,
    workUnitClosures: resolveWorkUnitClosures(repoRoot, (request?.workUnits || []).map((u) => u.workUnitId))
  };
}
