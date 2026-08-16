/**
 * Wheel adapter — GATE_AUTHORIZATION_AUTHORITY source.
 *
 * The I/O half of the Gate authorization primitive. core/gate-authorization-
 * authority.mjs stays pure; this module reads the live repository and hands it
 * observed facts. It decides nothing on its own.
 *
 * Same two-mechanism non-circularity as the release and precontract sources:
 *
 *  1. LOCATION. The owner authority is loaded only from a path configured
 *     OUTSIDE the repository. A source whose real (symlink-resolved) path lands
 *     inside the governed set is treated exactly like an absent file, so an
 *     authority the agent copied into the repo can never be honored.
 *  2. SIGNATURE. Location alone is not enough — an agent can write outside the
 *     repo too. The ed25519 owner signature is what makes forgery require the
 *     owner's private key rather than a text editor.
 *
 * This module is generic over gateId: it contains no specific Gate literal.
 * The Gate under authorization is always supplied by the caller.
 *
 * It NEVER writes, and it never returns execution or START privilege: both are
 * structural `false` inherited from the core decision, not outcomes it computes.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  evaluateGateAuthorizationAuthority,
  gateAuthorizationRecordPath,
  gateAuthorizationAuthoritySnapshotPath,
  gateAuthorizationStateCohortPaths,
  gateAuthorizationDerivedCohortPaths,
  GATE_AUTHORIZATION_TRANSITION_TYPE,
  GATE_AUTHORIZATION_FIRST_REVISION,
  PHASE_AUTHORIZE_APPLY
} from '../../core/gate-authorization-authority.mjs';
import {
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  resolveAuthorityMode
} from '../../core/post-freeze-maintenance-authority.mjs';
import { loadOwnerReleaseKey, loadReleaseAuthorization } from '../../core/release-authorization-source.mjs';
import { validateAgainstJsonSchema } from '../../contracts/validate-against-json-schema.mjs';
import { resolveGateDependencyProof } from './gate-dependency-resolution.mjs';

export const GATE_AUTHORIZATION_WORK_UNIT_TYPE = 'GATE_AUTHORIZATION';
export const GATE_AUTHORIZATION_AUTHORITY_ENV_VAR = 'WHEEL_GATE_AUTHORIZATION_AUTHORITY_SOURCE';
export const GATE_AUTHORIZATION_REQUEST_ENV_VAR = 'WHEEL_GATE_AUTHORIZATION_REQUEST_SOURCE';
export const OWNER_GATE_AUTHORIZATION_KEY_ENV_VAR = 'WHEEL_OWNER_GATE_AUTHORIZATION_PUBLIC_KEY';

const LEDGER_RELATIVE_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const OWNER_KEY_RELATIVE_PATH = 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sourcePaths(explicit, env, variable) {
  const value = explicit || env?.[variable] || null;
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function gitHead(repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function loadLedgerEvents(repoRoot) {
  const file = path.join(repoRoot, LEDGER_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { events: [], sha256: null };
  const bytes = fs.readFileSync(file);
  const events = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return { events, sha256: sha256(bytes) };
}

/** Loads a document from OUTSIDE the governed set, or reports why it is unusable. */
function loadExternal(filePath, root) {
  const loaded = loadReleaseAuthorization(filePath, { governedRoots: [root] });
  if (loaded.finding) return { value: null, finding: loaded.finding };
  try { return { value: readJson(filePath), finding: null }; } catch { return { value: null, finding: 'AUTHORITY_OR_REQUEST_MALFORMED' }; }
}

/**
 * Live bytes for every path the record claims, resolved through realpath so a
 * symlink pointing outside the repository is reported as an escape rather than
 * silently followed.
 */
function observeArtifacts(root, artifacts) {
  const artifactSha256 = {};
  const artifactByteLength = {};
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const relative = artifact?.repoRelativePath;
    if (typeof relative !== 'string' || !relative) continue;
    const target = path.resolve(root, relative);
    try {
      const real = fs.realpathSync(target);
      if (!real.startsWith(path.resolve(root) + path.sep)) {
        artifactSha256[relative] = '__SYMLINK_ESCAPE__';
        artifactByteLength[relative] = null;
        continue;
      }
      const bytes = fs.readFileSync(real);
      artifactSha256[relative] = sha256(bytes);
      artifactByteLength[relative] = bytes.length;
    } catch {
      artifactSha256[relative] = null;
      artifactByteLength[relative] = null;
    }
  }
  return { artifactSha256, artifactByteLength };
}

function liveSha(root, relativePath) {
  const target = path.join(root, ...String(relativePath).split('/'));
  try { return sha256(fs.readFileSync(target)); } catch { return null; }
}

/**
 * @param {string} repoRoot
 * @param {object} [options]
 * @returns {{ projectId, workUnitType, sourceId, resolveGateAuthorizationAuthority, resolveWorkUnitAuthority }}
 */
export function createWheelGateAuthorizationAuthoritySource(repoRoot, {
  authorityPath = null,
  requestPath = null,
  authorityPaths = null,
  requestPaths = null,
  ownerKeyPath = null,
  env = process.env,
  now = new Date(),
  phase = PHASE_AUTHORIZE_APPLY
} = {}) {
  const root = path.resolve(repoRoot);
  const authorities = sourcePaths(authorityPaths || authorityPath, env, GATE_AUTHORIZATION_AUTHORITY_ENV_VAR);
  const requests = sourcePaths(requestPaths || requestPath, env, GATE_AUTHORIZATION_REQUEST_ENV_VAR);
  const keyPath = ownerKeyPath || env?.[OWNER_GATE_AUTHORIZATION_KEY_ENV_VAR] || path.join(root, OWNER_KEY_RELATIVE_PATH);

  function blocked(findings) {
    return {
      decision: 'BLOCKED',
      authorizationAuthorized: false,
      executionAuthorized: false,
      startAuthorized: false,
      authorizedPaths: [],
      findings
    };
  }

  function resolveGateAuthorizationAuthority(workUnitId) {
    const findings = [];

    const recordRelativePath = gateAuthorizationRecordPath(workUnitId);
    const authoritySnapshotRelativePath = gateAuthorizationAuthoritySnapshotPath(workUnitId);
    let localAuthority = null;
    try {
      const candidate = readJson(path.join(root, ...authoritySnapshotRelativePath.split('/')));
      if (resolveAuthorityMode(candidate, { defaultLegacy: false }) === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE) {
        localAuthority = candidate;
      }
    } catch {
      // Legacy mode continues through its configured external source below.
    }

    if (localAuthority && (authorities.length > 0 || requests.length > 0)) {
      return { ...blocked([{ code: 'COMPETING_GATE_AUTHORIZATION_AUTHORITIES', detail: 'local authority with external source configured' }]), workUnitId, workUnitType: GATE_AUTHORIZATION_WORK_UNIT_TYPE };
    }

    // Competing authorities are refused rather than arbitrated. Picking one of two
    // owner documents would be the validator choosing its own permission.
    if (authorities.length > 1 || requests.length > 1) {
      return { ...blocked([{ code: 'COMPETING_GATE_AUTHORIZATION_AUTHORITIES', detail: `${authorities.length} authorities / ${requests.length} requests` }]), workUnitId, workUnitType: GATE_AUTHORIZATION_WORK_UNIT_TYPE };
    }
    if (!workUnitId || (!localAuthority && (authorities.length !== 1 || requests.length !== 1))) {
      return { ...blocked([{ code: 'GATE_AUTHORIZATION_SOURCE_UNCONFIGURED' }]), workUnitId, workUnitType: GATE_AUTHORIZATION_WORK_UNIT_TYPE };
    }

    const loadedRequest = localAuthority ? { value: null, finding: null } : loadExternal(requests[0], root);
    const loadedAuthority = localAuthority
      ? { value: localAuthority, finding: null }
      : loadExternal(authorities[0], root);
    if (loadedRequest.finding) findings.push({ code: loadedRequest.finding, detail: 'request' });
    if (loadedAuthority.finding) findings.push({ code: loadedAuthority.finding, detail: 'authority' });
    const request = loadedRequest.value;
    const authority = loadedAuthority.value;

    // The in-repo record is the document the ledger event will pin. It is read from
    // its exact deterministic governed path — never from a caller-supplied location.
    let record = null;
    try {
      record = readJson(path.join(root, ...recordRelativePath.split('/')));
    } catch {
      findings.push({ code: 'GATE_AUTHORIZATION_RECORD_UNREADABLE', detail: recordRelativePath });
    }

    try {
      const requestSchema = readJson(path.join(root, 'governance/schemas/gate-authorization-authority-request.schema.json'));
      const authoritySchema = readJson(path.join(root, 'governance/schemas/gate-authorization-authority.schema.json'));
      const recordSchema = readJson(path.join(root, 'governance/schemas/gate-authorization-record.schema.json'));
      if (!localAuthority && !validateAgainstJsonSchema(request, requestSchema).valid) findings.push({ code: 'REQUEST_SCHEMA_INVALID' });
      if (!validateAgainstJsonSchema(authority, authoritySchema).valid) findings.push({ code: 'AUTHORITY_SCHEMA_INVALID' });
      if (!validateAgainstJsonSchema(record, recordSchema).valid) findings.push({ code: 'RECORD_SCHEMA_INVALID' });
    } catch {
      findings.push({ code: 'GATE_AUTHORIZATION_SCHEMA_UNAVAILABLE' });
    }

    // Independently recompute the exact authorized path cohort. A record that names
    // any other path — an extra state file, another Gate's tree, a GEE revision, a
    // wildcard — disagrees with this set and is refused before any decision.
    const expectedStatePaths = Object.values(gateAuthorizationStateCohortPaths(workUnitId));
    const expectedDerivedPaths = Object.values(gateAuthorizationDerivedCohortPaths());
    const expectedPaths = new Set([...expectedStatePaths, ...expectedDerivedPaths]);
    for (const artifact of [...(record?.authorizedStateArtifacts || []), ...(record?.authorizedDerivedArtifacts || [])]) {
      if (!expectedPaths.has(artifact?.repoRelativePath)) {
        findings.push({ code: 'GATE_AUTHORIZATION_PATH_OUTSIDE_AUTHORIZED_COHORT', detail: artifact?.repoRelativePath });
      }
    }

    const { events, sha256: ledgerSha } = loadLedgerEvents(root);
    const ownEvents = events.filter((event) => event.gateId === workUnitId);
    const currentStatus = ownEvents.at(-1)?.toStatus ?? null;
    const dependency = record?.dependencyProof;
    const dependencyResolution = dependency ? resolveGateDependencyProof({ root, gateId: dependency.gateId }) : null;

    const contractRelativePath = `governance/gates/${workUnitId}/contracts/EXECUTION_CONTRACT_${GATE_AUTHORIZATION_FIRST_REVISION}.json`;
    const currentContractRelativePath = `governance/gates/${workUnitId}/contracts/CURRENT_CONTRACT.json`;
    const currentContractAbsolute = path.join(root, ...currentContractRelativePath.split('/'));

    const { artifactSha256, artifactByteLength } = observeArtifacts(root, [
      ...(record?.authorizedStateArtifacts || []),
      ...(record?.authorizedDerivedArtifacts || [])
    ]);

    // Consumption is detected from the ledger itself, not from a side file: once the
    // AUTHORIZATION event exists, the authority is spent and can never be replayed.
    const existingAuthorizationEventCount = ownEvents.filter((event) => event.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE).length;

    const observed = {
      projectId: 'WHEEL',
      gateId: workUnitId,
      headCommit: gitHead(root),
      preLedgerSha256: ledgerSha,
      previousEventSha256: events.at(-1)?.eventPayloadSha256 ?? null,
      currentStatus,
      contractSha256: liveSha(root, contractRelativePath),
      currentContractSha256: liveSha(root, currentContractRelativePath),
      currentContractPresent: fs.existsSync(currentContractAbsolute),
      dependencyProof: dependencyResolution?.proof || null,
      artifactSha256,
      artifactByteLength,
      competingAuthorityCount: localAuthority ? 1 : authorities.length,
      existingAuthorizationEventCount,
      consumed: existingAuthorizationEventCount > 0
    };

    const ownerKey = localAuthority ? null : loadOwnerReleaseKey(keyPath).ownerKey;
    const result = evaluateGateAuthorizationAuthority({ record, request, authority, ownerKey, observed, phase, now });
    findings.push(...result.findings);

    const authorized = findings.length === 0 && result.authorizationAuthorized;
    return {
      decision: authorized ? 'AUTHORIZED' : 'BLOCKED',
      authorizationAuthorized: authorized,
      // Structural, never computed: this primitive has no execution or START
      // privilege to grant, at any decision outcome.
      executionAuthorized: false,
      startAuthorized: false,
      authorizedPaths: authorized ? result.authorizedPaths : [],
      findings,
      ownerAuthoritySnapshotPath: authoritySnapshotRelativePath,
      recordPath: recordRelativePath,
      proofs: {
        EXECUTION_CONTRACT: { state: observed.currentContractPresent ? 'PROVEN' : 'FAILED', reason: 'CURRENT_CONTRACT presence and hash' },
        CONTRACT_INTEGRITY: { state: observed.contractSha256 === record?.contractSha256 ? 'PROVEN' : 'FAILED', reason: 'approved contract hash reproduces live bytes' },
        PREREQUISITES: { state: dependencyResolution?.satisfied && dependencyResolution.status === dependency?.status ? 'PROVEN' : 'FAILED', reason: dependencyResolution?.reason || 'immediate predecessor terminal proof' },
        WORK_UNIT_EXECUTABLE: { state: 'FAILED', reason: 'GATE_AUTHORIZATION is non-execution authority; START remains unauthorized' }
      },
      workUnitId,
      workUnitType: GATE_AUTHORIZATION_WORK_UNIT_TYPE,
      authoritySource: 'wheel-gate-authorization-authority-source'
    };
  }

  return {
    projectId: 'WHEEL',
    workUnitType: GATE_AUTHORIZATION_WORK_UNIT_TYPE,
    sourceId: 'wheel-gate-authorization-authority-source',
    resolveGateAuthorizationAuthority,
    resolveWorkUnitAuthority: resolveGateAuthorizationAuthority
  };
}
