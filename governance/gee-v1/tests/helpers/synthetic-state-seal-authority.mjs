import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';

/**
 * Build a minimal synthetic STATE_SEAL authority tree that seals an activation record.
 * Reuses the same shape validated by governance/tools/validate-state-seal.mjs.
 * For tests only — does not mutate historical GATE trees.
 */
export function writeSyntheticStateSealAuthority(repoRoot, {
  gateId = 'GATE80',
  stateRevision = 'R0001',
  activationRecord,
  activationRelativePath = null
} = {}) {
  const revRel = `governance/gates/${gateId}/state/revisions/${stateRevision}`;
  const revDir = path.join(repoRoot, revRel);
  fs.mkdirSync(revDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, `governance/gates/${gateId}/contracts`), { recursive: true });

  const checkpoint = {
    gateId,
    stateRevision,
    milestone: 'SYNTHETIC_ACTIVATION_AUTHORITY',
    resumePoint: 'synthetic activation seal for GEE R1_REPAIR_R2 tests',
    completedTasks: ['seal-activation-authority'],
    openTasks: [],
    reusableEvidence: [],
    requiredNextActions: [],
    protectedHashes: []
  };
  const defects = { gateId, stateRevision, defects: [] };
  const contractPtr = {
    schemaVersion: 1,
    gateId,
    contractPath: `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`
  };
  const contractBody = {
    schemaVersion: 1,
    gateId,
    contractId: `${gateId}_SYNTHETIC`,
    version: 'R0001'
  };

  const memberRel = activationRelativePath || `${revRel}/ACTIVATION_AUTHORITY.json`;
  const activationAbs = path.join(repoRoot, memberRel);
  fs.mkdirSync(path.dirname(activationAbs), { recursive: true });
  fs.writeFileSync(activationAbs, `${JSON.stringify(activationRecord, null, 2)}\n`);

  const checkpointPath = path.join(revDir, 'CHECKPOINT.json');
  const defectsPath = path.join(revDir, 'OPEN_DEFECTS.json');
  const contractPath = path.join(repoRoot, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`);
  const contractBodyPath = path.join(repoRoot, `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`);

  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  fs.writeFileSync(defectsPath, `${JSON.stringify(defects, null, 2)}\n`);
  fs.writeFileSync(contractPath, `${JSON.stringify(contractPtr, null, 2)}\n`);
  fs.writeFileSync(contractBodyPath, `${JSON.stringify(contractBody, null, 2)}\n`);

  function member(repoRelativePath, abs) {
    const bytes = fs.readFileSync(abs);
    return { repoRelativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
  }

  const payload = {
    gateId,
    stateRevision,
    purpose: 'GEE_ACTIVATION_AUTHORITY',
    sealedAt: '2026-08-08T00:00:00.000Z'
  };
  const seal = {
    schemaVersion: 1,
    gateId,
    stateRevision,
    sealedMembers: [
      member(`${revRel}/CHECKPOINT.json`, checkpointPath),
      member(`${revRel}/OPEN_DEFECTS.json`, defectsPath),
      member(`governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`, contractPath),
      member(memberRel, activationAbs)
    ],
    previousStateSealSha256: null,
    sealedAt: '2026-08-08T00:00:00.000Z',
    payload,
    payloadSha256: sha256Canonical(payload)
  };

  const sealPath = path.join(revDir, 'STATE_SEAL.json');
  fs.writeFileSync(sealPath, `${JSON.stringify(seal, null, 2)}\n`);

  return {
    repoRoot,
    gateId,
    stateRevision,
    sealPath: path.relative(repoRoot, sealPath).split(path.sep).join('/'),
    memberRepoRelativePath: memberRel,
    activationAbs
  };
}
