import { sha256Canonical } from '../../tools/canonical-json.mjs';

/**
 * Minimal activation-authority record for execution-contract freeze.
 * Digests bind the activated contract+seal; identity is content-addressed.
 */
export function buildActivationAuthorityRecord({
  workUnitId,
  executionContractId,
  executionContractVersion,
  expectedContractSha256,
  expectedSealSha256,
  activatedAt
}) {
  return {
    schemaVersion: 1,
    authorityKind: 'EXECUTION_CONTRACT_ACTIVATION',
    workUnitId,
    executionContractId,
    executionContractVersion,
    expectedContractSha256,
    expectedSealSha256,
    activatedAt
  };
}

export function activationIdOf(record) {
  return sha256Canonical(record);
}

export function createActivationAuthority({
  workUnitId,
  executionContractId,
  executionContractVersion,
  expectedContractSha256,
  expectedSealSha256,
  activatedAt
}) {
  const record = buildActivationAuthorityRecord({
    workUnitId,
    executionContractId,
    executionContractVersion,
    expectedContractSha256,
    expectedSealSha256,
    activatedAt
  });
  return { record, activationId: activationIdOf(record) };
}
