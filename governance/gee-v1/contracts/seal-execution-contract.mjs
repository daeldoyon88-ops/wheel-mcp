import { createHash } from 'node:crypto';
import { canonicalize, sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateExecutionContract } from './validate-execution-contract.mjs';

export function sealExecutionContract(contract, options = {}) {
  const validation = validateExecutionContract(contract, options);
  if (!validation.valid) {
    return { sealed: false, validation, seal: null };
  }
  const sealedAt = options.sealedAt || new Date().toISOString();
  const payload = {
    contractId: contract.id,
    contractVersion: contract.version,
    contractKind: contract.contractKind,
    sealedAt,
    contractSha256: sha256Canonical(contract),
    closureConditionsSha256: sha256Canonical(contract.closureConditions),
    authorizedVerdictsSha256: sha256Canonical(contract.authorizedVerdicts)
  };
  const sealBody = {
    schemaVersion: 1,
    sealKind: 'EXECUTION_CONTRACT_SEAL',
    payload,
    payloadSha256: sha256Canonical(payload)
  };
  const sealSha256 = createHash('sha256').update(canonicalize(sealBody), 'utf8').digest('hex');
  return { sealed: true, validation, seal: { ...sealBody, sealSha256 } };
}
