import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from '../../tools/canonical-json.mjs';
import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateStateSeal } from '../../tools/validate-state-seal.mjs';
import { activationIdOf } from './activation-anchor.mjs';

/**
 * Validate an immutable external activation anchor.
 *
 * Authority MUST be STATE_SEAL_MEMBER (reuses canonical validateStateSeal).
 * A mutable local sidecar alone is NEVER accepted.
 *
 * @returns {{
 *   status: 'INTACT'|'ANCHOR_MISMATCH'|'ANCHOR_MISSING'|'ANCHOR_INVALID'|'AUTHORITY_REJECTED'|'NOT_APPLICABLE',
 *   findings: string[],
 *   activationId: string|null
 * }}
 */
export function validateActivationAnchor({
  contract,
  seal,
  activationAnchor = null,
  activationState = null,
  requireActivationAnchor = false
} = {}) {
  const findings = [];
  const activated = activationState === 'ACTIVATED' || requireActivationAnchor === true;

  if (!activated) {
    return { status: 'NOT_APPLICABLE', findings: [], activationId: null };
  }

  if (!activationAnchor || typeof activationAnchor !== 'object' || Array.isArray(activationAnchor)) {
    return { status: 'ANCHOR_MISSING', findings: ['ACTIVATION_ANCHOR_MISSING'], activationId: null };
  }

  const record = activationAnchor.record;
  const activationId = activationAnchor.activationId;
  const authority = activationAnchor.authority;

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    findings.push('ACTIVATION_RECORD_MISSING');
  }
  if (typeof activationId !== 'string' || !/^[a-f0-9]{64}$/.test(activationId)) {
    findings.push('ACTIVATION_ID_INVALID');
  }
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    findings.push('ACTIVATION_AUTHORITY_MISSING');
  } else if (authority.kind !== 'STATE_SEAL_MEMBER') {
    // Explicitly reject local sidecars / self-declared mutable anchors.
    findings.push('ACTIVATION_AUTHORITY_KIND_REJECTED');
  }

  if (findings.length > 0) {
    return { status: 'ANCHOR_INVALID', findings, activationId: activationId || null };
  }

  const expectedId = activationIdOf(record);
  if (expectedId !== activationId) {
    findings.push('ACTIVATION_ID_MISMATCH');
  }

  if (record.authorityKind !== 'EXECUTION_CONTRACT_ACTIVATION') {
    findings.push('ACTIVATION_RECORD_KIND_INVALID');
  }
  if (typeof record.expectedContractSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.expectedContractSha256)) {
    findings.push('EXPECTED_CONTRACT_SHA_INVALID');
  }
  if (typeof record.expectedSealSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.expectedSealSha256)) {
    findings.push('EXPECTED_SEAL_SHA_INVALID');
  }

  const repoRoot = authority.repoRoot;
  const sealPath = authority.sealPath;
  const memberPath = authority.memberRepoRelativePath;
  if (typeof repoRoot !== 'string' || typeof sealPath !== 'string' || typeof memberPath !== 'string') {
    findings.push('STATE_SEAL_AUTHORITY_PATHS_INVALID');
  }

  if (findings.length > 0) {
    return { status: 'ANCHOR_INVALID', findings, activationId };
  }

  const absoluteSeal = path.isAbsolute(sealPath) ? sealPath : path.join(repoRoot, sealPath);
  const sealReport = validateStateSeal({ root: repoRoot, sealPath: absoluteSeal });
  if (!sealReport.valid) {
    findings.push('STATE_SEAL_AUTHORITY_INVALID');
    for (const f of sealReport.findings || []) {
      findings.push(`SEAL:${f.detectorId}`);
    }
    return { status: 'AUTHORITY_REJECTED', findings, activationId };
  }

  // Re-read seal for sealedMembers (validateStateSeal does not return members list).
  let sealJson;
  try {
    sealJson = JSON.parse(fs.readFileSync(absoluteSeal, 'utf8'));
  } catch {
    findings.push('STATE_SEAL_UNREADABLE');
    return { status: 'AUTHORITY_REJECTED', findings, activationId };
  }
  const sealedMembers = Array.isArray(sealJson.sealedMembers) ? sealJson.sealedMembers : [];
  const hit = sealedMembers.find((m) => m && m.repoRelativePath === memberPath);
  if (!hit) {
    findings.push('ACTIVATION_RECORD_NOT_SEALED_MEMBER');
    return { status: 'AUTHORITY_REJECTED', findings, activationId };
  }

  const absoluteMember = path.join(repoRoot, memberPath);
  if (!fs.existsSync(absoluteMember) || !fs.statSync(absoluteMember).isFile()) {
    findings.push('ACTIVATION_RECORD_FILE_ABSENT');
    return { status: 'AUTHORITY_REJECTED', findings, activationId };
  }
  const bytes = fs.readFileSync(absoluteMember);
  const actualSha = sha256Bytes(bytes);
  if (actualSha !== hit.sha256 || bytes.length !== hit.byteLength) {
    findings.push('ACTIVATION_RECORD_MEMBER_HASH_MISMATCH');
    return { status: 'AUTHORITY_REJECTED', findings, activationId };
  }

  let onDiskRecord;
  try {
    onDiskRecord = JSON.parse(bytes.toString('utf8'));
  } catch {
    findings.push('ACTIVATION_RECORD_JSON_INVALID');
    return { status: 'AUTHORITY_REJECTED', findings, activationId };
  }
  if (sha256Canonical(onDiskRecord) !== activationId || sha256Canonical(onDiskRecord) !== sha256Canonical(record)) {
    findings.push('ACTIVATION_RECORD_BYTES_MISMATCH');
    return { status: 'AUTHORITY_REJECTED', findings, activationId };
  }

  if (!contract || typeof contract !== 'object') {
    findings.push('CONTRACT_ABSENT');
    return { status: 'ANCHOR_INVALID', findings, activationId };
  }
  if (!seal || typeof seal !== 'object' || typeof seal.sealSha256 !== 'string') {
    findings.push('SEAL_ABSENT');
    return { status: 'ANCHOR_INVALID', findings, activationId };
  }

  const currentContractSha = sha256Canonical(contract);
  const currentSealSha = seal.sealSha256;
  if (currentContractSha !== record.expectedContractSha256) {
    findings.push('ANCHOR_CONTRACT_DIGEST_MISMATCH');
  }
  if (currentSealSha !== record.expectedSealSha256) {
    findings.push('ANCHOR_SEAL_DIGEST_MISMATCH');
  }
  if (record.executionContractId && contract.id && record.executionContractId !== contract.id) {
    findings.push('ANCHOR_CONTRACT_ID_MISMATCH');
  }
  if (record.executionContractVersion && contract.version && record.executionContractVersion !== contract.version) {
    findings.push('ANCHOR_CONTRACT_VERSION_MISMATCH');
  }

  if (findings.length > 0) {
    return { status: 'ANCHOR_MISMATCH', findings, activationId };
  }

  return { status: 'INTACT', findings: [], activationId };
}
