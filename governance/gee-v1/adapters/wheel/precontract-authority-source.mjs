import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { evaluatePrecontractAuthority, PRECONTRACT_OPERATION } from '../../core/precontract-authority.mjs';
import { loadOwnerReleaseKey, loadReleaseAuthorization } from '../../core/release-authorization-source.mjs';
import { isWithinGovernedRoots } from '../../core/witness-source.mjs';
import { validateAgainstJsonSchema } from '../../contracts/validate-against-json-schema.mjs';

export const PRECONTRACT_WORK_UNIT_TYPE = 'PRECONTRACT';
export const PRECONTRACT_AUTHORITY_ENV_VAR = 'WHEEL_PRECONTRACT_AUTHORITY_SOURCE';
export const PRECONTRACT_REQUEST_ENV_VAR = 'WHEEL_PRECONTRACT_REQUEST_SOURCE';
export const OWNER_PRECONTRACT_KEY_ENV_VAR = 'WHEEL_OWNER_PRECONTRACT_PUBLIC_KEY';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function sourcePaths(explicit, env, variable) {
  const value = explicit || env?.[variable] || null;
  return value ? (Array.isArray(value) ? value : [value]) : [];
}
function gitHead(repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function latestEvent(repoRoot, gateId) {
  const file = path.join(repoRoot, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter((event) => event.gateId === gateId).at(-1) || null;
}
function loadExternal(filePath, root) {
  const loaded = loadReleaseAuthorization(filePath, { governedRoots: [root] });
  if (loaded.finding) return { value: null, finding: loaded.finding };
  try { return { value: readJson(filePath), finding: null }; } catch { return { value: null, finding: 'AUTHORITY_OR_REQUEST_MALFORMED' }; }
}
function targetHashes(root, bindings) {
  const values = {};
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const target = path.join(root, ...binding.path.split('/'));
    try {
      const real = fs.realpathSync(target);
      values[binding.path] = isWithinGovernedRoots(real, [root]) ? sha256(fs.readFileSync(real)) : '__SYMLINK_ESCAPE__';
    } catch { values[binding.path] = null; }
  }
  return values;
}

export function createWheelPrecontractAuthoritySource(repoRoot, { authorityPath = null, requestPath = null, authorityPaths = null, requestPaths = null, ownerKeyPath = null, env = process.env, operation = PRECONTRACT_OPERATION, now = new Date() } = {}) {
  const root = path.resolve(repoRoot);
  const authorities = sourcePaths(authorityPaths || authorityPath, env, PRECONTRACT_AUTHORITY_ENV_VAR);
  const requests = sourcePaths(requestPaths || requestPath, env, PRECONTRACT_REQUEST_ENV_VAR);
  const keyPath = ownerKeyPath || env?.[OWNER_PRECONTRACT_KEY_ENV_VAR] || path.join(root, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json');

  function resolvePrecontractAuthority(workUnitId) {
    const findings = [];
    if (authorities.length > 1 || requests.length > 1) {
      return { decision: 'BLOCKED', bootstrapAuthorized: false, executionAuthorized: false, authorizedPaths: [], findings: [{ code: 'PRECONTRACT_AUTHORITY_CONFLICT' }] };
    }
    if (!workUnitId || authorities.length !== 1 || requests.length !== 1) {
      return { decision: 'BLOCKED', bootstrapAuthorized: false, executionAuthorized: false, authorizedPaths: [], findings: [{ code: 'PRECONTRACT_SOURCE_UNCONFIGURED' }] };
    }
    const loadedRequest = loadExternal(requests[0], root);
    const loadedAuthority = loadExternal(authorities[0], root);
    if (loadedRequest.finding) findings.push({ code: loadedRequest.finding });
    if (loadedAuthority.finding) findings.push({ code: loadedAuthority.finding });
    const request = loadedRequest.value;
    const authority = loadedAuthority.value;
    try {
      const requestSchema = readJson(path.join(root, 'governance/schemas/precontract-authority-request.schema.json'));
      const authoritySchema = readJson(path.join(root, 'governance/schemas/precontract-authority.schema.json'));
      if (!validateAgainstJsonSchema(request, requestSchema).valid) findings.push({ code: 'REQUEST_SCHEMA_INVALID' });
      if (!validateAgainstJsonSchema(authority, authoritySchema).valid) findings.push({ code: 'AUTHORITY_SCHEMA_INVALID' });
    } catch {
      findings.push({ code: 'PRECONTRACT_SCHEMA_UNAVAILABLE' });
    }
    const bootstrapPaths = new Set([
      'governance/GATE_REGISTRY_00_40.json',
      `governance/gates/${workUnitId}/contracts/EXECUTION_CONTRACT_R0001.json`,
      `governance/gates/${workUnitId}/contracts/CURRENT_CONTRACT.json`
    ]);
    for (const authorizedPath of request?.authorizedPaths || []) {
      if (!bootstrapPaths.has(authorizedPath)) findings.push({ code: 'PRECONTRACT_PATH_OUTSIDE_BOOTSTRAP_SCOPE', detail: authorizedPath });
    }
    const ledgerPath = path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson');
    const ledgerBytes = fs.readFileSync(ledgerPath);
    const event = latestEvent(root, workUnitId);
    const dependency = request?.dependencyProof;
    const dependencyEvent = dependency ? latestEvent(root, dependency.gateId) : null;
    const currentContractPath = path.join(root, 'governance/gates', workUnitId, 'contracts/CURRENT_CONTRACT.json');
    const ownerKey = loadOwnerReleaseKey(keyPath).ownerKey;
    const observed = {
      projectId: 'WHEEL', gateId: workUnitId, headCommit: gitHead(root), ledgerSha256: sha256(ledgerBytes),
      currentStatus: event?.toStatus || null, currentContractPresent: fs.existsSync(currentContractPath), consumed: fs.existsSync(currentContractPath),
      dependencyProof: dependencyEvent ? { gateId: dependencyEvent.gateId, status: dependencyEvent.toStatus, authorityPath: dependencyEvent.authorityPath, authoritySha256: dependencyEvent.authoritySha256 } : null,
      targetFileSha256: targetHashes(root, request?.artifactBindings)
    };
    const result = evaluatePrecontractAuthority({ request, authority, ownerKey, observed, operation, now });
    findings.push(...result.findings);
    const authorized = findings.length === 0 && result.bootstrapAuthorized;
    return {
      decision: authorized ? 'AUTHORIZED' : 'BLOCKED', bootstrapAuthorized: authorized, executionAuthorized: false,
      authorizedPaths: authorized ? result.authorizedPaths : [], findings,
      proofs: {
        EXECUTION_CONTRACT: { state: 'NOT_APPLICABLE', reason: 'precontract phase precedes CURRENT_CONTRACT' },
        CONTRACT_INTEGRITY: { state: 'NOT_APPLICABLE', reason: 'normal contract validation follows bootstrap' },
        PREREQUISITES: { state: dependencyEvent && dependencyEvent.toStatus === dependency?.status ? 'PROVEN' : 'FAILED', reason: 'predecessor terminal proof' },
        WORK_UNIT_EXECUTABLE: { state: 'FAILED', reason: 'PRECONTRACT is non-execution authority' }
      }, workUnitId, workUnitType: PRECONTRACT_WORK_UNIT_TYPE, authoritySource: 'wheel-precontract-authority-source'
    };
  }
  return { projectId: 'WHEEL', workUnitType: PRECONTRACT_WORK_UNIT_TYPE, sourceId: 'wheel-precontract-authority-source', resolvePrecontractAuthority, resolveWorkUnitAuthority: resolvePrecontractAuthority };
}
