/** Wheel adapter for the modern GATE_START_AUTHORITY primitive. */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  gateStartRecordPath, gateStartAuthorityPath, gateStartWriteCohortPaths,
  validateGateStartRecordShape, validateGateStartAuthorityShape,
  verifyOwnerSignature, computeGateStartRecordDigest,
  computeGateStartBindingDigestFromDigests, computeGateStartLocalRequestDigest,
  GATE_START_SHARED_FIELDS,
  canonicalize
} from '../../core/gate-start-authority.mjs';
import {
  LEGACY_SIGNED_AUTHORITY_MODE,
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  resolveAuthorityMode
} from '../../core/post-freeze-maintenance-authority.mjs';
import { reconstructLedgerPrefixBytes } from '../../../tools/validate-status-ledger.mjs';
import { sha256Bytes } from '../../../tools/canonical-json.mjs';

const LEDGER_RELATIVE_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const OWNER_KEY_RELATIVE_PATH = 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function fileInfo(root, relativePath) {
  const file = path.join(root, ...relativePath.split('/'));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const bytes = fs.readFileSync(file);
  return { bytes, sha256: sha256(bytes), byteLength: bytes.length, file };
}
function ledgerEvents(root) {
  const info = fileInfo(root, LEDGER_RELATIVE_PATH);
  if (!info) return [];
  return info.bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function contractView(root, gateId) {
  const pointerPath = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const pointer = fileInfo(root, pointerPath);
  if (!pointer) return null;
  const pointerJson = JSON.parse(pointer.bytes.toString('utf8'));
  const contract = fileInfo(root, pointerJson.contractPath);
  if (!contract) return null;
  return { pointer, pointerJson, contract, contractJson: JSON.parse(contract.bytes.toString('utf8')) };
}

function predecessorGateId(root, gateId) {
  try {
    const registry = readJson(path.join(root, 'governance/GATE_REGISTRY_00_40.json'));
    const entry = Array.isArray(registry.gates) ? registry.gates.find((item) => item?.gateId === gateId) : null;
    return Array.isArray(entry?.dependencies) && entry.dependencies.length > 0
      ? entry.dependencies.at(-1)
      : null;
  } catch {
    return null;
  }
}

function exactSamePaths(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const left = [...a].sort(); const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function findAppliedModernStart(root, gateId) {
  const info = fileInfo(root, LEDGER_RELATIVE_PATH);
  const result = { event: null, prefixSha256: null, previousEventSha256: null, findings: [] };
  if (!info) { result.findings.push({ code: 'START_LEDGER_ABSENT' }); return result; }
  let events;
  try { events = info.bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { result.findings.push({ code: 'START_LEDGER_MALFORMED' }); return result; }
  const candidates = events.filter((event) => event.gateId === gateId
    && event.transitionType === 'START'
    && event.fromStatus === 'AUTHORIZED_NOT_STARTED'
    && event.toStatus === 'IN_PROGRESS');
  if (candidates.length !== 1) {
    result.findings.push({ code: candidates.length === 0 ? 'START_EVENT_ABSENT' : 'START_EVENT_NOT_UNIQUE', detail: candidates.length });
    return result;
  }
  const event = candidates[0];
  const index = events.indexOf(event);
  result.event = event;
  result.previousEventSha256 = index > 0 ? events[index - 1]?.eventPayloadSha256 || null : null;
  try { result.prefixSha256 = sha256Bytes(reconstructLedgerPrefixBytes(info.file, event.ordinal - 1)); }
  catch { result.findings.push({ code: 'START_LEDGER_PREFIX_UNAVAILABLE' }); }
  if (event.ordinal !== index + 1) result.findings.push({ code: 'START_EVENT_ORDINAL_INVALID' });
  if (index > 0 && event.previousEventSha256 !== result.previousEventSha256) result.findings.push({ code: 'START_EVENT_PREVIOUS_HASH_INVALID' });
  return result;
}

function checkPostStartState(root, gateId, record) {
  const findings = [];
  const currentStateInfo = fileInfo(root, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  if (!currentStateInfo) return [{ code: 'START_CURRENT_STATE_ABSENT' }];
  let currentState;
  try { currentState = JSON.parse(currentStateInfo.bytes.toString('utf8')); }
  catch { return [{ code: 'START_CURRENT_STATE_MALFORMED' }]; }
  const revisionNumber = Number.parseInt(String(currentState.stateRevision || '').slice(1), 10);
  if (!Number.isInteger(revisionNumber) || revisionNumber <= 1) findings.push({ code: 'START_R0002_REQUIRED' });
  if (currentState.gateId !== gateId) findings.push({ code: 'START_CURRENT_STATE_GATE_MISMATCH' });
  const revisionPath = typeof currentState.revisionPath === 'string' ? currentState.revisionPath : null;
  const sealInfo = revisionPath ? fileInfo(root, `${revisionPath}/STATE_SEAL.json`) : null;
  if (!sealInfo) findings.push({ code: 'START_POST_STATE_SEAL_ABSENT' });
  else {
    try {
      const seal = JSON.parse(sealInfo.bytes.toString('utf8'));
      if (seal.previousStateSealSha256 !== record.preStateSealSha256) findings.push({ code: 'START_PRE_STATE_SEAL_CHAIN_MISMATCH' });
      if (seal.payload?.executionStatus !== 'IN_PROGRESS') findings.push({ code: 'START_POST_STATE_NOT_IN_PROGRESS' });
      if (currentState.stateSealSha256 !== sealInfo.sha256) findings.push({ code: 'START_CURRENT_STATE_SEAL_HASH_MISMATCH' });
    } catch { findings.push({ code: 'START_POST_STATE_SEAL_MALFORMED' }); }
  }
  return findings;
}

export function deriveGateStartReadinessFacts(root, gateId) {
  const events = ledgerEvents(root);
  const gateEvents = events.filter((event) => event.gateId === gateId);
  const previous = gateEvents.at(-1) || null;
  const ledgerHead = events.at(-1) || null;
  const predecessorId = predecessorGateId(root, gateId);
  const predecessor = predecessorId ? events.filter((event) => event.gateId === predecessorId).at(-1) || null : null;
  const ledger = fileInfo(root, LEDGER_RELATIVE_PATH);
  const currentState = fileInfo(root, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  const seal = fileInfo(root, `governance/gates/${gateId}/state/revisions/R0001/STATE_SEAL.json`);
  const openDefects = fileInfo(root, `governance/gates/${gateId}/state/revisions/R0001/OPEN_DEFECTS.json`);
  const activeGate = fileInfo(root, 'governance/active/ACTIVE_GATE.json');
  const contract = contractView(root, gateId);
  const openJson = openDefects ? JSON.parse(openDefects.bytes.toString('utf8')) : null;
  const knowledge = Array.isArray(openJson?.defects) ? (openJson.defects.length === 0 ? 'KNOWN_ZERO' : 'KNOWN_NONZERO') : 'UNKNOWN';
  const readinessVerdict = previous?.toStatus === 'AUTHORIZED_NOT_STARTED'
    && currentState && seal && openDefects && contract && activeGate
    && JSON.parse(currentState.bytes.toString('utf8')).stateRevision === 'R0001'
    && predecessor?.toStatus === 'COMPLETE_CONFIRMED'
    && knowledge !== 'UNKNOWN' ? 'READY' : 'BLOCKED';
  const dependencyProof = predecessor ? {
    gateId: predecessorId, status: predecessor.toStatus,
    authorityPath: predecessor.authorityPath, authoritySha256: predecessor.authoritySha256
  } : { gateId: predecessorId || '', status: 'UNKNOWN', authorityPath: '', authoritySha256: '0'.repeat(64) };
  return {
    projectId: 'WHEEL', gateId, status: previous?.toStatus || null,
    preStartLedgerSha256: ledger?.sha256 || null,
    previousEventSha256: ledgerHead?.eventPayloadSha256 || null,
    preStateRevision: currentState ? JSON.parse(currentState.bytes.toString('utf8')).stateRevision : null,
    preCurrentStateSha256: currentState?.sha256 || null,
    preStateSealSha256: seal?.sha256 || null,
    openDefectsKnowledge: knowledge,
    contractSha256: contract?.contract.sha256 || null,
    currentContractSha256: contract?.pointer.sha256 || null,
    dependencyProof,
    readinessVerdict,
    activeGatePreState: activeGate ? { activeGate: readJson(activeGate.file).activeGate, sha256: activeGate.sha256, byteLength: activeGate.byteLength } : null,
    ledgerEventCount: events.length,
    contractJson: contract?.contractJson || null,
    contractPointer: contract?.pointerJson || null
  };
}

function loadModernAuthority(root, gateId) {
  const recordInfo = fileInfo(root, gateStartRecordPath(gateId));
  const authorityInfo = fileInfo(root, gateStartAuthorityPath(gateId));
  const result = { valid: false, findings: [], record: null, authority: null, recordInfo, authorityInfo };
  if (!recordInfo || !authorityInfo) { result.findings.push({ code: 'START_AUTHORITY_ABSENT' }); return result; }
  try { result.record = JSON.parse(recordInfo.bytes.toString('utf8')); result.authority = JSON.parse(authorityInfo.bytes.toString('utf8')); }
  catch { result.findings.push({ code: 'START_AUTHORITY_MALFORMED' }); return result; }
  result.findings.push(...validateGateStartRecordShape(result.record).findings, ...validateGateStartAuthorityShape(result.authority).findings);
  if (result.record.recordDigest !== computeGateStartRecordDigest(result.record)) result.findings.push({ code: 'START_RECORD_HASH_MISMATCH' });
  if (result.authority.recordDigest !== result.record.recordDigest) result.findings.push({ code: 'START_AUTHORITY_RECORD_MISMATCH' });
  if (result.authority.bindingDigest !== computeGateStartBindingDigestFromDigests({ requestDigest: result.authority.requestDigest, recordDigest: result.record.recordDigest })) result.findings.push({ code: 'START_AUTHORITY_BINDING_MISMATCH' });
  for (const field of GATE_START_SHARED_FIELDS) {
    if (canonicalize(result.authority[field]) !== canonicalize(result.record[field])) result.findings.push({ code: 'START_AUTHORITY_RECORD_FIELD_MISMATCH', detail: field });
  }
  const authorityMode = resolveAuthorityMode(result.authority, { defaultLegacy: false });
  if (authorityMode === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE) {
    if (result.authority.requestDigest !== computeGateStartLocalRequestDigest(result.authority)) {
      result.findings.push({ code: 'START_LOCAL_REQUEST_DIGEST_MISMATCH' });
    }
  } else if (authorityMode === LEGACY_SIGNED_AUTHORITY_MODE) {
    let ownerKey;
    try { ownerKey = readJson(path.join(root, ...OWNER_KEY_RELATIVE_PATH.split('/'))); }
    catch { result.findings.push({ code: 'START_OWNER_KEY_ABSENT' }); }
    if (ownerKey) {
      const signature = verifyOwnerSignature(result.authority, ownerKey);
      if (!signature.verified) result.findings.push({ code: 'START_OWNER_SIGNATURE_INVALID', detail: signature.reason });
    }
  }
  result.valid = result.findings.length === 0;
  return result;
}

export function createWheelGateStartAuthoritySource(repoRoot, { projectId = 'WHEEL' } = {}) {
  const root = path.resolve(repoRoot);
  return {
    projectId,
    workUnitType: 'GATE_START',
    sourceId: 'wheel-gate-start-authority-source',
    resolveWorkUnitAuthority(workUnitId) {
      const facts = deriveGateStartReadinessFacts(root, workUnitId);
      if (!facts.status && !facts.contractJson) return null;
      const authority = loadModernAuthority(root, workUnitId);
      const appliedStart = facts.status === 'IN_PROGRESS' ? findAppliedModernStart(root, workUnitId) : { event: null, findings: [] };
      const scopeExact = authority.valid && exactSamePaths(authority.authority.functionalExecutionScope, facts.contractJson?.authorizedPaths);
      const findings = [...authority.findings, ...appliedStart.findings];
      if (facts.status === 'IN_PROGRESS' && appliedStart.event) {
        const expectedRecordPath = gateStartRecordPath(workUnitId);
        if (appliedStart.event.authorityPath !== expectedRecordPath) findings.push({ code: 'START_EVENT_AUTHORITY_PATH_MISMATCH' });
        if (!authority.recordInfo || authority.recordInfo.sha256 !== appliedStart.event.authoritySha256) findings.push({ code: 'START_RECORD_LEDGER_HASH_MISMATCH' });
        const record = authority.record;
        const event = appliedStart.event;
        for (const field of ['gateId', 'eventId', 'transitionType', 'fromStatus', 'toStatus', 'recordedAt', 'previousEventSha256']) {
          if (record?.[field] !== event[field]) findings.push({ code: `START_RECORD_EVENT_${field.toUpperCase()}_MISMATCH` });
        }
        if (record?.preStartLedgerSha256 !== appliedStart.prefixSha256) findings.push({ code: 'START_RECORD_PRE_LEDGER_HASH_MISMATCH' });
        if (record?.previousEventSha256 !== appliedStart.previousEventSha256) findings.push({ code: 'START_RECORD_PREVIOUS_EVENT_HASH_MISMATCH' });
        findings.push(...checkPostStartState(root, workUnitId, record));
      }
      if (authority.valid && !scopeExact) findings.push({ code: 'FUNCTIONAL_SCOPE_NOT_EXACT' });
      const postStartExecutable = facts.status === 'IN_PROGRESS' && authority.valid && scopeExact && findings.length === 0;
      return {
        workUnitId, workUnitType: 'GATE_START', status: facts.status,
        executionAuthorized: postStartExecutable,
        startAuthorized: authority.valid,
        authorizedPaths: scopeExact ? facts.contractJson.authorizedPaths : [],
        contract: facts.contractJson,
        facts,
        findings,
        proofs: {
          EXECUTION_CONTRACT: facts.contractJson ? { state: 'PROVEN', reason: 'CURRENT_CONTRACT and contract present' } : { state: 'FAILED', reason: 'contract absent' },
          CONTRACT_INTEGRITY: facts.contractJson ? { state: 'PROVEN', reason: 'contract-derived exact scope' } : { state: 'FAILED', reason: 'contract absent' },
          PREREQUISITES: facts.dependencyProof.status === 'COMPLETE_CONFIRMED' ? { state: 'PROVEN', reason: `${facts.dependencyProof.gateId} terminal dependency` } : { state: 'FAILED', reason: 'dependency not terminal' },
          WORK_UNIT_EXECUTABLE: postStartExecutable ? { state: 'PROVEN', reason: 'IN_PROGRESS plus valid modern START authority and exact scope' } : { state: 'FAILED', reason: facts.status === 'AUTHORIZED_NOT_STARTED' ? 'START authority cannot grant pre-START execution' : 'modern START authority or exact scope invalid' }
        }
      };
    }
  };
}

export { gateStartWriteCohortPaths };
