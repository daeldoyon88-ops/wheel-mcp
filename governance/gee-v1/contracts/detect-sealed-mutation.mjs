import { createHash } from 'node:crypto';
import { canonicalize, sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateActivationAnchor } from './validate-activation-anchor.mjs';

/**
 * Detect silent mutation / internal seal incoherence of a sealed execution contract.
 * Returns MUTATED | INTACT | SEAL_MISSING | CONTRACT_INVALID | SEAL_INVALID
 *        | ANCHOR_MISMATCH | ANCHOR_MISSING | ANCHOR_INVALID | AUTHORITY_REJECTED | RESEALED_AFTER_ACTIVATION
 *
 * Integrity order (fail-closed):
 * A. structure / version / kind
 * B. payloadSha256 from canonical payload
 * C. sealSha256 from canonical seal body (same as seal-execution-contract.mjs)
 * D. contract ↔ payload linkage hashes
 * E. optional immutable external activation anchor (when activated)
 */
export function detectSealedMutation(contract, seal, options = {}) {
  if (!seal || typeof seal !== 'object') {
    return { status: 'SEAL_MISSING', mutated: false, findings: ['SEAL_MISSING'] };
  }
  if (!contract || typeof contract !== 'object') {
    return { status: 'CONTRACT_INVALID', mutated: true, findings: ['CONTRACT_INVALID'] };
  }

  const findings = [];

  // A. structure / version / kind
  if (seal.schemaVersion !== 1) {
    findings.push('SEAL_SCHEMA_VERSION_INVALID');
  }
  if (seal.sealKind !== 'EXECUTION_CONTRACT_SEAL') {
    findings.push('SEAL_KIND_INVALID');
  }
  if (!seal.payload || typeof seal.payload !== 'object' || Array.isArray(seal.payload)) {
    findings.push('SEAL_PAYLOAD_MISSING');
  }
  if (typeof seal.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(seal.payloadSha256)) {
    findings.push('SEAL_PAYLOAD_SHA_MISSING');
  }
  if (typeof seal.sealSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(seal.sealSha256)) {
    findings.push('SEAL_SHA_MISSING');
  }

  if (findings.length > 0) {
    return { status: 'SEAL_INVALID', mutated: true, findings };
  }

  const payload = seal.payload;

  // B. recalculate payloadSha256 from canonical payload
  const expectedPayloadSha = sha256Canonical(payload);
  if (seal.payloadSha256 !== expectedPayloadSha) {
    findings.push('PAYLOAD_SHA256_MISMATCH');
  }

  // C. recalculate sealSha256 exactly as seal-execution-contract.mjs
  const sealBody = {
    schemaVersion: seal.schemaVersion,
    sealKind: seal.sealKind,
    payload,
    payloadSha256: seal.payloadSha256
  };
  const expectedSealSha = createHash('sha256').update(canonicalize(sealBody), 'utf8').digest('hex');
  if (seal.sealSha256 !== expectedSealSha) {
    findings.push('SEAL_SHA256_MISMATCH');
  }

  if (findings.length > 0) {
    return { status: 'SEAL_INVALID', mutated: true, findings };
  }

  // D. contract ↔ payload linkage
  const contractSha = sha256Canonical(contract);
  if (payload.contractSha256 !== contractSha) {
    findings.push('CONTRACT_BYTES_CHANGED');
  }
  if (payload.closureConditionsSha256 !== sha256Canonical(contract.closureConditions || null)) {
    findings.push('CLOSURE_CONDITIONS_CHANGED');
  }
  if (payload.authorizedVerdictsSha256 !== sha256Canonical(contract.authorizedVerdicts || null)) {
    findings.push('AUTHORIZED_VERDICTS_CHANGED');
  }
  if (payload.contractId && payload.contractId !== contract.id) {
    findings.push('CONTRACT_ID_MISMATCH');
  }
  if (payload.contractVersion && payload.contractVersion !== contract.version) {
    findings.push('CONTRACT_VERSION_MISMATCH');
  }
  if (payload.contractKind && payload.contractKind !== contract.contractKind) {
    findings.push('CONTRACT_KIND_MISMATCH');
  }

  if (findings.length > 0) {
    return { status: 'MUTATED', mutated: true, findings };
  }

  // E. immutable external activation anchor (only when activated / required)
  const anchor = validateActivationAnchor({
    contract,
    seal,
    activationAnchor: options.activationAnchor,
    activationState: options.activationState,
    requireActivationAnchor: options.requireActivationAnchor === true
  });
  if (anchor.status !== 'NOT_APPLICABLE' && anchor.status !== 'INTACT') {
    const status = anchor.status === 'ANCHOR_MISMATCH'
      ? 'RESEALED_AFTER_ACTIVATION'
      : anchor.status;
    return {
      status,
      mutated: true,
      findings: anchor.findings,
      activationId: anchor.activationId
    };
  }

  return { status: 'INTACT', mutated: false, findings: [], activationId: anchor.activationId || null };
}
