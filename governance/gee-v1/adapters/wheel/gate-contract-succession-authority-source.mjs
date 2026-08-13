/** Wheel I/O adapter for the generic contract succession primitive. */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isWithinGovernedRoots } from '../../core/witness-source.mjs';
import { loadOwnerReleaseKey } from '../../core/release-authorization-source.mjs';
import {
  evaluateGateContractSuccessionAuthority,
  gateContractSuccessionRecordPath,
  gateContractSuccessionAuthorityPath
} from '../../core/gate-contract-succession-authority.mjs';

export const GATE_CONTRACT_SUCCESSION_WORK_UNIT_TYPE = 'GATE_CONTRACT_SUCCESSION';
export const GATE_CONTRACT_SUCCESSION_AUTHORITY_ENV_VAR = 'WHEEL_GATE_CONTRACT_SUCCESSION_AUTHORITY_SOURCE';
export const GATE_CONTRACT_SUCCESSION_REQUEST_ENV_VAR = 'WHEEL_GATE_CONTRACT_SUCCESSION_REQUEST_SOURCE';
export const OWNER_GATE_CONTRACT_SUCCESSION_KEY_ENV_VAR = 'WHEEL_OWNER_GATE_CONTRACT_SUCCESSION_PUBLIC_KEY';

const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const OWNER_KEY_PATH = 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function info(root, relative) {
  const file = path.join(root, ...relative.split('/'));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const bytes = fs.readFileSync(file);
  let json = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* byte-only artifacts such as NDJSON */ }
  return { file, bytes, sha256: sha256(bytes), byteLength: bytes.length, json };
}
function sourcePaths(explicit, env, key) {
  const value = explicit || env?.[key] || null;
  return value ? (Array.isArray(value) ? value : [value]) : [];
}
function loadExternal(file, root) {
  if (!file) return { value: null, finding: 'SUCCESSION_AUTHORITY_SOURCE_UNCONFIGURED' };
  try {
    const real = fs.realpathSync(file);
    if (isWithinGovernedRoots(real, [root])) return { value: null, finding: 'SUCCESSION_AUTHORITY_MUST_BE_EXTERNAL' };
    return { value: readJson(real), finding: null };
  } catch { return { value: null, finding: 'SUCCESSION_AUTHORITY_UNREADABLE' }; }
}
function gitHead(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function ledgerFacts(root) {
  const ledger = info(root, LEDGER_PATH);
  if (!ledger) return { events: [], sha256: null };
  try { return { events: ledger.bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse), sha256: ledger.sha256 }; }
  catch { return { events: [], sha256: ledger.sha256 }; }
}

function observe(baseRoot, candidateRoot, request) {
  const baseLedger = ledgerFacts(baseRoot);
  const candidateLedger = ledgerFacts(candidateRoot);
  const basePointer = info(baseRoot, request.predecessorCurrentContractPath);
  const predecessor = info(baseRoot, request.predecessorContractPath);
  const successor = info(candidateRoot, request.successorContractPath);
  const candidatePointer = info(candidateRoot, request.successorCurrentContractPath);
  const latest = baseLedger.events.at(-1);
  const gateEvents = baseLedger.events.filter((event) => event.gateId === request.gateId);
  return {
    projectId: 'WHEEL', gateId: request.gateId, baseCommit: gitHead(baseRoot),
    currentStatus: gateEvents.at(-1)?.toStatus || null,
    ledgerHeadEventId: latest?.eventId || null,
    ledgerHeadEventPayloadSha256: latest?.eventPayloadSha256 || null,
    ledgerSha256: baseLedger.sha256,
    candidateLedgerSha256: candidateLedger.sha256,
    predecessorContractPath: request.predecessorContractPath,
    predecessorContractSha256: predecessor?.sha256 || null,
    predecessorCurrentContractPath: request.predecessorCurrentContractPath,
    predecessorCurrentContractSha256: basePointer?.sha256 || null,
    successorContractPath: request.successorContractPath,
    successorContractSha256: successor?.sha256 || null,
    successorCurrentContractPath: request.successorCurrentContractPath,
    successorCurrentContractSha256: candidatePointer?.sha256 || null,
    competingAuthorityCount: 1,
    authorityConsumed: false,
    predecessorContract: predecessor?.json || null,
    successorContract: successor?.json || null,
    predecessorCurrentContract: basePointer?.json || null,
    successorCurrentContract: candidatePointer?.json || null
  };
}

export function createWheelGateContractSuccessionAuthoritySource(repoRoot, {
  candidateRoot = repoRoot, authorityPath = null, requestPath = null,
  recordPath = null, authorityPaths = null, requestPaths = null, ownerKeyPath = null, env = process.env, now = new Date()
} = {}) {
  const root = path.resolve(repoRoot);
  const futureRoot = path.resolve(candidateRoot);
  const authorities = sourcePaths(authorityPaths || authorityPath, env, GATE_CONTRACT_SUCCESSION_AUTHORITY_ENV_VAR);
  const requests = sourcePaths(requestPaths || requestPath, env, GATE_CONTRACT_SUCCESSION_REQUEST_ENV_VAR);
  const keyPath = ownerKeyPath || env?.[OWNER_GATE_CONTRACT_SUCCESSION_KEY_ENV_VAR] || path.join(root, ...OWNER_KEY_PATH.split('/'));

  function resolveGateContractSuccessionAuthority(workUnitId) {
    const findings = [];
    if (authorities.length > 1 || requests.length > 1) return { decision: 'BLOCKED', successionAuthorized: false, authorizedPaths: [], findings: [{ code: 'COMPETING_SUCCESSION_AUTHORITIES' }] };
    if (authorities.length !== 1 || requests.length !== 1) return { decision: 'BLOCKED', successionAuthorized: false, authorizedPaths: [], findings: [{ code: 'SUCCESSION_AUTHORITY_SOURCE_UNCONFIGURED' }] };
    const requestLoad = loadExternal(requests[0], root);
    const authorityLoad = loadExternal(authorities[0], root);
    if (requestLoad.finding) findings.push({ code: requestLoad.finding });
    if (authorityLoad.finding) findings.push({ code: authorityLoad.finding });
    const request = requestLoad.value;
    const authority = authorityLoad.value;
    let record = null;
    try { record = readJson(recordPath || path.join(root, ...gateContractSuccessionRecordPath(workUnitId).split('/'))); }
    catch { findings.push({ code: 'SUCCESSION_RECORD_UNREADABLE' }); }
    if (request?.gateId !== workUnitId || authority?.gateId !== workUnitId || record?.gateId !== workUnitId) findings.push({ code: 'CROSS_GATE_AUTHORITY_BORROWING' });
    let ownerKey = null;
    try { ownerKey = loadOwnerReleaseKey(keyPath).ownerKey; } catch { findings.push({ code: 'OWNER_PUBLIC_KEY_UNAVAILABLE' }); }
    if (!request || !record || !authority) return { decision: 'BLOCKED', successionAuthorized: false, authorizedPaths: [], findings };
    const result = evaluateGateContractSuccessionAuthority({ request, record, authority, ownerKey, ...observe(root, futureRoot, request), now });
    return { ...result, findings: [...findings, ...result.findings], workUnitId, workUnitType: GATE_CONTRACT_SUCCESSION_WORK_UNIT_TYPE, recordPath: gateContractSuccessionRecordPath(workUnitId), authorityPath: gateContractSuccessionAuthorityPath(workUnitId) };
  }

  return { projectId: 'WHEEL', workUnitType: GATE_CONTRACT_SUCCESSION_WORK_UNIT_TYPE, sourceId: 'wheel-gate-contract-succession-authority-source', resolveGateContractSuccessionAuthority, resolveWorkUnitAuthority: resolveGateContractSuccessionAuthority };
}
