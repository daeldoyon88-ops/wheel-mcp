import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveOptionPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function finding(findings, detectorId, jsonPointer, actualValue, expectedRule, message, requirementId) {
  findings.push({ detectorId, severity: 'BLOCKING', jsonPointer, actualValue, expectedRule, message, requirementId });
}

function readJson(file, findings, requirementId) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    finding(findings, 'MISSING_SEAL_INPUT', '/', file, 'existing JSON file', 'Required seal input is missing.', requirementId);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    finding(findings, 'INVALID_JSON', '/', file, 'valid JSON', error.message, requirementId);
    return null;
  }
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveMember(root, value, findings, pointer) {
  if (!safeRelative(value)) {
    finding(findings, 'INVALID_NORMALIZED_PATH', pointer, value, 'relative slash-separated path without traversal', 'Sealed member path is unsafe.', 'REQ-SEA-01');
    return null;
  }
  const resolved = path.resolve(root, value);
  const prefix = path.resolve(root) + path.sep;
  if (!resolved.startsWith(prefix)) {
    finding(findings, 'PATH_OUTSIDE_ROOT', pointer, value, 'member below repository root', 'Sealed member escapes the repository root.', 'REQ-SEA-01');
    return null;
  }
  return resolved;
}

function mutableProjectionKind(gateId, memberPath) {
  if (typeof memberPath !== 'string') return null;
  const expectedContract = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const expectedState = `governance/gates/${gateId}/state/CURRENT_STATE.json`;
  if (memberPath === expectedContract || memberPath.endsWith('/CURRENT_CONTRACT.json')) return { kind: 'CURRENT_CONTRACT', expectedPath: expectedContract };
  if (memberPath === expectedState || memberPath.endsWith('/CURRENT_STATE.json')) return { kind: 'CURRENT_STATE', expectedPath: expectedState };
  return null;
}

function revisionNumber(value) {
  return /^R[0-9]{4}$/.test(String(value || '')) ? Number.parseInt(String(value).slice(1), 10) : null;
}

function maximumRevision(revisionRoot) {
  if (!fs.existsSync(revisionRoot) || !fs.statSync(revisionRoot).isDirectory()) return null;
  const revisions = fs.readdirSync(revisionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^R[0-9]{4}$/.test(entry.name))
    .map((entry) => revisionNumber(entry.name));
  return revisions.length ? Math.max(...revisions) : null;
}

function validateStateSeal({ root, sealPath }) {
  const findings = [];
  const seal = readJson(sealPath, findings, 'REQ-SEA-01');
  if (!seal) return { valid: false, blockingCount: findings.length, findings, sealPath };
  const required = ['schemaVersion', 'gateId', 'stateRevision', 'sealedMembers', 'previousStateSealSha256', 'sealedAt', 'payload', 'payloadSha256'];
  const allowed = new Set(required);
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(seal, field)) finding(findings, 'SCHEMA_VIOLATION', '/', field, 'required property', `STATE_SEAL is missing ${field}.`, 'REQ-SEA-01');
  for (const field of Object.keys(seal)) if (!allowed.has(field)) finding(findings, 'SCHEMA_VIOLATION', `/${field}`, seal[field], 'additionalProperties=false', `STATE_SEAL contains unknown field ${field}.`, 'REQ-SEA-01');
  if (typeof seal.stateRevision !== 'string' || !/^R[0-9]{4}$/.test(seal.stateRevision)) finding(findings, 'INVALID_REVISION_ID', '/stateRevision', seal.stateRevision, 'Rxxxx', 'Seal revision is not versioned.', 'REQ-SEA-01');
  if (!Array.isArray(seal.sealedMembers)) finding(findings, 'SCHEMA_VIOLATION', '/sealedMembers', seal.sealedMembers, 'array', 'sealedMembers must be an array.', 'REQ-SEA-01');
  if (seal.payload === null || typeof seal.payload !== 'object' || Array.isArray(seal.payload)) finding(findings, 'SCHEMA_VIOLATION', '/payload', seal.payload, 'object', 'Seal payload must be an object.', 'REQ-CJS-03');
  else if (sha256Canonical(seal.payload) !== seal.payloadSha256) finding(findings, 'PAYLOAD_HASH_MISMATCH', '/payloadSha256', seal.payloadSha256, sha256Canonical(seal.payload), 'payloadSha256 is not recalculated from the real payload.', 'REQ-CJS-03');

  const rootResolved = path.resolve(root);
  const sealRelative = path.relative(rootResolved, sealPath).replaceAll('\\', '/');
  const revisionDir = path.dirname(sealPath);
  const expectedRevisionDir = path.basename(revisionDir);
  const revision = revisionNumber(seal.stateRevision);
  const newestRevision = maximumRevision(path.dirname(revisionDir));
  const historicalProjection = Number.isInteger(revision) && Number.isInteger(newestRevision) && revision < newestRevision;
  const members = new Set();
  let hasCheckpoint = false;
  let hasDefects = false;
  let hasContract = false;
  for (const [index, member] of (seal.sealedMembers || []).entries()) {
    const pointer = `/sealedMembers/${index}`;
    if (!member || typeof member !== 'object') {
      finding(findings, 'SCHEMA_VIOLATION', pointer, member, 'object', 'Sealed member must be an object.', 'REQ-SEA-01');
      continue;
    }
    const memberPath = member.repoRelativePath;
    const projection = mutableProjectionKind(seal.gateId, memberPath);
    if (projection && memberPath !== projection.expectedPath) finding(findings, 'HISTORICAL_TARGET_PATH_MISMATCH', `${pointer}/repoRelativePath`, memberPath, projection.expectedPath, 'Mutable projection path is gate-local and exact.', 'REQ-SEA-03');
    if (typeof memberPath === 'string' && memberPath.includes(`/contracts/`) && memberPath !== `governance/gates/${seal.gateId}/contracts/CURRENT_CONTRACT.json`) finding(findings, 'HISTORICAL_TARGET_PATH_MISMATCH', `${pointer}/repoRelativePath`, memberPath, `governance/gates/${seal.gateId}/contracts/CURRENT_CONTRACT.json`, 'State seals must bind the gate-local current contract projection, not an unrelated contract artifact.', 'REQ-SEA-03');
    if (typeof memberPath === 'string' && memberPath.startsWith('governance/gee-v1/')) finding(findings, 'GEE_R8_PATH_FORBIDDEN', `${pointer}/repoRelativePath`, memberPath, 'no GEE path in state seal', 'State seals cannot depend on GEE infrastructure.', 'REQ-SEA-03');
    if (memberPath?.endsWith('/STATE_SEAL.json') || memberPath === 'STATE_SEAL.json') finding(findings, 'SELF_HASH_RECURSION', `${pointer}/repoRelativePath`, memberPath, 'STATE_SEAL.json excluded from sealedMembers', 'STATE_SEAL cannot seal itself.', 'REQ-CJS-03');
    if (members.has(memberPath)) finding(findings, 'DUPLICATE_SEALED_MEMBER', `${pointer}/repoRelativePath`, memberPath, 'unique sealed member path', 'A sealed member is listed twice.', 'REQ-SEA-01');
    members.add(memberPath);
    if (typeof memberPath === 'string' && memberPath.endsWith('/CHECKPOINT.json')) hasCheckpoint = true;
    if (typeof memberPath === 'string' && memberPath.endsWith('/OPEN_DEFECTS.json')) hasDefects = true;
    if (typeof memberPath === 'string' && memberPath.includes('/contracts/')) hasContract = true;
    const target = resolveMember(rootResolved, memberPath, findings, `${pointer}/repoRelativePath`);
    if (!target) continue;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      finding(findings, historicalProjection && projection ? 'HISTORICAL_PROJECTION_BYTES_UNAVAILABLE' : 'STATE_SEAL_MEMBER_MISMATCH', `${pointer}/repoRelativePath`, memberPath, 'existing regular file', 'Sealed member is absent.', historicalProjection && projection ? 'REQ-SEA-03' : 'REQ-SEA-01');
      continue;
    }
    const bytes = fs.readFileSync(target);
    const actualSha = sha256Bytes(bytes);
    if (historicalProjection && projection) {
      if (!/^[a-f0-9]{64}$/.test(String(member.sha256 || '')) || !Number.isInteger(member.byteLength) || member.byteLength < 0) finding(findings, 'HISTORICAL_PROJECTION_BINDING_INVALID', pointer, member, 'historical SHA-256 and byteLength', 'Historical mutable projection identity is malformed.', 'REQ-SEA-03');
    } else if (actualSha !== member.sha256 || bytes.length !== member.byteLength) finding(findings, 'STATE_SEAL_MEMBER_MISMATCH', pointer, { sha256: member.sha256, byteLength: member.byteLength }, { sha256: actualSha, byteLength: bytes.length }, 'Sealed member hash and length match real bytes.', 'REQ-SEA-01');
    const currentRevision = path.basename(path.dirname(target));
    if (memberPath?.includes('/state/revisions/') && currentRevision !== expectedRevisionDir) finding(findings, 'CROSS_REVISION_MEMBER', pointer, memberPath, `member belongs to ${expectedRevisionDir}`, 'Seal references a mutable or different revision.', 'REQ-SEA-01');
  }
  if (!hasCheckpoint) finding(findings, 'STATE_SEAL_MEMBER_MISSING', '/sealedMembers', seal.sealedMembers, 'same revision CHECKPOINT.json', 'Seal does not include CHECKPOINT.json.', 'REQ-SEA-01');
  if (!hasDefects) finding(findings, 'STATE_SEAL_MEMBER_MISSING', '/sealedMembers', seal.sealedMembers, 'same revision OPEN_DEFECTS.json', 'Seal does not include OPEN_DEFECTS.json.', 'REQ-SEA-01');
  if (!hasContract) finding(findings, 'STATE_SEAL_MEMBER_MISSING', '/sealedMembers', seal.sealedMembers, 'current contract reference', 'Seal does not include the current contract reference.', 'REQ-SEA-01');
  const sealRevisionNumber = Number.parseInt(seal.stateRevision?.slice(1), 10);
  const previous = seal.previousStateSealSha256;
  if (sealRevisionNumber === 1 && previous !== null) finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, null, 'R0001 must have no previous seal.', 'REQ-SEA-02');
  if (sealRevisionNumber > 1) {
    if (typeof previous !== 'string') finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, 'SHA-256 of previous STATE_SEAL.json', 'A non-bootstrap revision must link a previous seal.', 'REQ-SEA-02');
    else {
      const previousPath = path.join(revisionDir, '..', `R${String(sealRevisionNumber - 1).padStart(4, '0')}`, 'STATE_SEAL.json');
      if (!fs.existsSync(previousPath)) finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, 'existing previous revision seal', 'Previous revision seal is absent.', 'REQ-SEA-02');
      else {
        const actualPrevious = sha256Bytes(fs.readFileSync(previousPath));
        if (actualPrevious !== previous) finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, actualPrevious, 'previousStateSealSha256 links the previous seal bytes.', 'REQ-SEA-02');
      }
    }
  }
  return { valid: findings.length === 0, blockingCount: findings.length, findings, sealPath: sealRelative, stateRevision: seal.stateRevision };
}

export { validateStateSeal };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const sealPath = resolveOptionPath(root, option('--seal', path.join(root, 'governance/gates/GATE13/state/revisions/R0001/STATE_SEAL.json')));
  const report = validateStateSeal({ root, sealPath });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
