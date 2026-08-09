import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function exists(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Map a legacy Wheel gate execution contract into a generic execution-contract
 * VIEW.
 *
 * RC-7 repair: the canonical contract carries ONLY schema-defined fields and
 * always validates against work-unit-execution-contract.schema.json. Adapter
 * metadata (compatibility, sourcePath, sourceSha256) never lives inside it —
 * it travels beside it as `provenance`. Optional absent fields are omitted,
 * never materialized as `undefined` (CT-F2): `objective` is only set when a
 * real, non-empty value exists.
 *
 * @returns {{ contract: object, provenance: object }}
 */
export function mapLegacyGateContractToExecutionView(legacyContract, meta = {}) {
  if (!legacyContract || typeof legacyContract !== 'object') return null;
  const positive = Array.isArray(legacyContract.positiveTests) ? legacyContract.positiveTests : [];
  const negative = Array.isArray(legacyContract.negativeTests) ? legacyContract.negativeTests : [];
  const counter = Array.isArray(legacyContract.countertests) ? legacyContract.countertests : [];
  const outputs = Array.isArray(legacyContract.requiredOutputs) ? legacyContract.requiredOutputs : [];
  const closure = Array.isArray(legacyContract.closureConditions) ? legacyContract.closureConditions : [];
  const hasObjective = typeof meta.objective === 'string' && meta.objective.trim().length > 0;

  const contract = {
    schemaVersion: 1,
    contractKind: 'EXECUTION',
    id: `${legacyContract.gateId}:${legacyContract.contractRevision}`,
    type: 'GATE',
    version: legacyContract.contractRevision,
    strategicContractId: legacyContract.gateId,
    ...(hasObjective ? { objective: meta.objective } : {}),
    prerequisites: Array.isArray(meta.prerequisites) ? meta.prerequisites : [],
    invariants: Array.isArray(legacyContract.canonicalRequirements)
      ? legacyContract.canonicalRequirements.map((r) => r.requirementId || r.statement).filter(Boolean)
      : ['LEGACY_GATE_CONTRACT'],
    requiredArtifacts: outputs.map((o) => o.path || o).filter(Boolean),
    requiredTests: positive,
    requiredNegativeTests: negative,
    requiredHostileOrCounterTests: counter,
    evidenceRequirements: Array.isArray(legacyContract.packagingRequirements) && legacyContract.packagingRequirements.length
      ? legacyContract.packagingRequirements
      : ['legacy-seal-and-validators'],
    closureConditions: closure,
    authorizedVerdicts: meta.authorizedVerdicts || ['COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'BLOCKED', 'INCOMPLETE'],
    stateTransitionRules: Array.isArray(legacyContract.nextGateAuthorizationConditions)
      ? legacyContract.nextGateAuthorizationConditions
      : ['legacy-next-gate-conditions'],
    authorizedPaths: Array.isArray(legacyContract.authorizedPaths) ? legacyContract.authorizedPaths : []
  };

  const missingForGenericReadiness = [
    ...(hasObjective ? [] : ['objective']),
    ...(closure.length ? [] : ['closureConditions']),
    ...(positive.length ? [] : ['requiredTests']),
    ...(negative.length ? [] : ['requiredNegativeTests']),
    ...(counter.length ? [] : ['requiredHostileOrCounterTests'])
  ];

  const provenance = {
    sourceKind: 'LEGACY_MAPPED',
    ...(meta.sourcePath ? { sourcePath: meta.sourcePath } : {}),
    ...(meta.sourceSha256 ? { sourceSha256: meta.sourceSha256 } : {}),
    mappingId: 'wheel-legacy-gate-contract-v1',
    mappingVersion: 1,
    fidelity: 'MAPPED',
    missingForGenericReadiness
  };

  return { contract, provenance };
}

export function loadLegacyGateContract(repoRoot, gateId) {
  const pointerPath = path.join(repoRoot, 'governance', 'gates', gateId, 'contracts', 'CURRENT_CONTRACT.json');
  if (!exists(pointerPath)) {
    return { present: false, pointerPath, contract: null, view: null };
  }
  const pointer = readJson(pointerPath);
  if (typeof pointer.contractPath !== 'string' || !pointer.contractPath) {
    return { present: false, pointerPath, pointer, contract: null, view: null };
  }
  const contractPath = path.join(repoRoot, pointer.contractPath);
  if (!exists(contractPath)) {
    return { present: false, pointerPath, pointer, contract: null, view: null };
  }
  const contract = readJson(contractPath);
  return {
    present: true,
    pointerPath,
    pointer,
    contractPath: pointer.contractPath,
    contractSha256: sha256File(contractPath),
    contract,
    view: null
  };
}
