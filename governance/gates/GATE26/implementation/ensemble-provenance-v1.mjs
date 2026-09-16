/**
 * GATE26 ensemble provenance and append-only MINI index.
 *
 * Every provenance manifest binds the actual inputs a record was built from: the
 * P3H dataset identity, the GATE25 selection binding, the analogue index and GATE25
 * provenance bytes, and the per-input proofs GATE25 emitted. Placeholder, missing or
 * malformed SHA-256 values are refused; nothing here is fabricated.
 */

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { isCanonicalUtcInstant, isExactGovernedString } from '../../GATE25/implementation/analogue-identity-v1.mjs';
import { buildInputProof } from '../../GATE25/implementation/analogue-provenance-v1.mjs';
import { failClosed, assertClosedKeys, ENSEMBLE_ENGINE_VERSION_V1 } from './ensemble-identity-v1.mjs';
import { ENSEMBLE_RECORD_FIELDS_V1 } from './ensemble-record-v1.mjs';

export const ENSEMBLE_INDEX_SCHEMA_V1 = 'GATE26_ENSEMBLE_INDEX_V1';
export const ENSEMBLE_INDEX_FIELDS_V1 = Object.freeze([
  'schema', 'engineVersion', 'combinationPolicyVersionId', 'horizonCoverageId', 'recordCount', 'records',
]);
export const ENSEMBLE_INDEX_RECORD_FIELDS_V1 = Object.freeze([
  'ensembleIdentityId', 'orderedMembers', 'decision', 'abstention', 'families', 'provenanceId', 'horizons',
]);
export const PROVENANCE_MANIFEST_SCHEMA_V1 = 'GATE26_ENSEMBLE_PROVENANCE_V1';
export const PROVENANCE_MANIFEST_FIELDS_V1 = Object.freeze([
  'schema', 'ensembleIdentityId', 'queryIdentityId', 'knowledgeCutoff', 'analogueIdentityIds',
  'combinationPolicyVersionId', 'engineVersion', 'horizonCoverageId', 'selectionDigest', 'outcomeSetId',
  'supportReportId', 'inputBinding', 'regimeBinding', 'inputProofs', 'provenanceId',
]);
export const INPUT_BINDING_FIELDS_V1 = Object.freeze([
  'datasetId', 'datasetSha256', 'admittedKeyDigest', 'exclusionDigest', 'selectionPolicyVersionId',
  'gate25ExecutionContractSha256', 'calendarRegistryManifestId', 'analogueIndexSha256', 'gate25ProvenanceSha256',
  'horizonContractSha256',
]);
export const INPUT_PROOF_FIELDS_V1 = Object.freeze([
  'inputId', 'sourceArtifactId', 'sourceArtifactSha256', 'availableAt', 'knowledgeCutoff', 'availableByCutoff',
]);
export const PRODUCT_PROVENANCE_SCHEMA_V1 = 'GATE26_MINI_PRODUCT_PROVENANCE_V1';
export const PRODUCT_PROVENANCE_FIELDS_V1 = Object.freeze([
  'schema', 'authority', 'modelPolicy', 'inputBinding', 'queryCases', 'd4Coverage', 'records', 'product',
  'analogueIndexMutation', 'samePipelineAsFullBuild',
]);
export const LFS_THRESHOLD_BYTES_V1 = 52428800;
export const ENSEMBLE_INDEX_PRODUCT_PATH_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/MINI/ENSEMBLE_INDEX.json';
export const PROVENANCE_PRODUCT_PATH_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/MINI/PROVENANCE.json';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_OBJECT_ID = /^sha256:[0-9a-f]{64}$/;

export const isSha256Hex = (value) => typeof value === 'string' && SHA256_HEX.test(value);

function requireSha256(value, code, details) {
  if (!isSha256Hex(value)) failClosed(code, details);
  return value;
}

/** The actual P3H / GATE25 input identity a record was built from. Closed and hash-exact. */
export function validateInputBinding(binding) {
  assertClosedKeys(binding, INPUT_BINDING_FIELDS_V1, 'INPUT_BINDING_NOT_CLOSED');
  if (typeof binding.datasetId !== 'string' || !SHA256_OBJECT_ID.test(binding.datasetId)) failClosed('DATASET_IDENTITY_MALFORMED', { datasetId: binding.datasetId });
  requireSha256(binding.datasetSha256, 'DATASET_IDENTITY_MALFORMED', { field: 'datasetSha256' });
  if (binding.datasetId !== `sha256:${binding.datasetSha256}`) failClosed('DATASET_IDENTITY_MISMATCH', { field: 'datasetSha256' });
  for (const field of ['admittedKeyDigest', 'exclusionDigest', 'selectionPolicyVersionId', 'gate25ExecutionContractSha256',
    'analogueIndexSha256', 'gate25ProvenanceSha256', 'horizonContractSha256']) {
    requireSha256(binding[field], 'PROVENANCE_SOURCE_SHA256_INVALID', { field });
  }
  if (typeof binding.calendarRegistryManifestId !== 'string' || !SHA256_OBJECT_ID.test(binding.calendarRegistryManifestId)) {
    failClosed('PROVENANCE_SOURCE_SHA256_INVALID', { field: 'calendarRegistryManifestId' });
  }
  return Object.freeze(Object.fromEntries(INPUT_BINDING_FIELDS_V1.map((field) => [field, binding[field]])));
}

/** One GATE25 input proof, re-derived through GATE25 buildInputProof and required causal. */
export function validateInputProof(proof, index) {
  assertClosedKeys(proof, INPUT_PROOF_FIELDS_V1, 'PROVENANCE_INPUT_PROOF_NOT_CLOSED', { index });
  requireSha256(proof.sourceArtifactSha256, 'PROVENANCE_SOURCE_SHA256_INVALID', { index, inputId: proof.inputId });
  if (!isExactGovernedString(proof.inputId) || !isExactGovernedString(proof.sourceArtifactId)) {
    failClosed('PROVENANCE_INPUT_PROOF_INVALID', { index });
  }
  if (!isCanonicalUtcInstant(proof.availableAt) || !isCanonicalUtcInstant(proof.knowledgeCutoff)) {
    failClosed('PROVENANCE_INPUT_PROOF_INVALID', { index, inputId: proof.inputId });
  }
  const rebuilt = buildInputProof({
    inputId: proof.inputId,
    sourceArtifactId: proof.sourceArtifactId,
    sourceArtifactSha256: proof.sourceArtifactSha256,
    availableAt: proof.availableAt,
    knowledgeCutoff: proof.knowledgeCutoff,
  });
  if (canonicalize(rebuilt) !== canonicalize(proof)) failClosed('PROVENANCE_INPUT_PROOF_INVALID', { index, inputId: proof.inputId });
  if (rebuilt.availableByCutoff !== true) failClosed('LEAKAGE_ATTEMPT', { reason: 'INPUT_AVAILABLE_AFTER_KNOWLEDGE_CUTOFF', inputId: proof.inputId });
  return rebuilt;
}

function validateRegimeBinding(regimeBinding, analogueIdentityIds) {
  assertClosedKeys(regimeBinding, ['dimensions', 'factors'], 'REGIME_BINDING_INVALID');
  if (!Array.isArray(regimeBinding.dimensions) || regimeBinding.dimensions.length === 0
    || regimeBinding.dimensions.some((dimension) => !isExactGovernedString(dimension))) {
    failClosed('REGIME_BINDING_INVALID', { field: 'dimensions' });
  }
  if (!Array.isArray(regimeBinding.factors) || regimeBinding.factors.length !== analogueIdentityIds.length) {
    failClosed('REGIME_BINDING_INVALID', { field: 'factors' });
  }
  regimeBinding.factors.forEach((entry, index) => {
    assertClosedKeys(entry, ['analogueIdentityId', 'commonFactors'], 'REGIME_BINDING_INVALID', { index });
    if (entry.analogueIdentityId !== analogueIdentityIds[index] || !Array.isArray(entry.commonFactors)) {
      failClosed('REGIME_BINDING_INVALID', { index });
    }
  });
}

export function buildProvenanceManifest({
  ensembleIdentityId, queryIdentityId, knowledgeCutoff, analogueIdentityIds, combinationPolicyVersionId, engineVersion,
  horizonCoverageId, selectionDigest, outcomeSetId, supportReportId, inputBinding, regimeBinding, inputProofs,
}) {
  for (const [field, value] of Object.entries({
    ensembleIdentityId, queryIdentityId, combinationPolicyVersionId, horizonCoverageId, selectionDigest, outcomeSetId, supportReportId,
  })) {
    requireSha256(value, 'PROVENANCE_IDENTITY_MALFORMED', { field });
  }
  if (engineVersion !== ENSEMBLE_ENGINE_VERSION_V1) failClosed('STALE_OR_WRONG_VERSION', { engineVersion });
  if (!isCanonicalUtcInstant(knowledgeCutoff)) failClosed('PROVENANCE_IDENTITY_MALFORMED', { field: 'knowledgeCutoff' });
  if (!Array.isArray(analogueIdentityIds) || analogueIdentityIds.some((id) => !isSha256Hex(id))) {
    failClosed('PROVENANCE_IDENTITY_MALFORMED', { field: 'analogueIdentityIds' });
  }
  const binding = validateInputBinding(inputBinding);
  validateRegimeBinding(regimeBinding, analogueIdentityIds);
  if (!Array.isArray(inputProofs) || inputProofs.length === 0) failClosed('PROVENANCE_INPUT_PROOFS_REQUIRED');
  const proofs = inputProofs.map((proof, index) => validateInputProof(proof, index));
  const manifest = {
    schema: PROVENANCE_MANIFEST_SCHEMA_V1,
    ensembleIdentityId,
    queryIdentityId,
    knowledgeCutoff,
    analogueIdentityIds: [...analogueIdentityIds],
    combinationPolicyVersionId,
    engineVersion,
    horizonCoverageId,
    selectionDigest,
    outcomeSetId,
    supportReportId,
    inputBinding: binding,
    regimeBinding: {
      dimensions: [...regimeBinding.dimensions],
      factors: regimeBinding.factors.map((entry) => ({
        analogueIdentityId: entry.analogueIdentityId,
        commonFactors: entry.commonFactors.map((factor) => ({ ...factor })),
      })),
    },
    inputProofs: proofs.map((proof) => ({ ...proof })),
  };
  return Object.freeze({ ...manifest, provenanceId: sha256Canonical(manifest) });
}

/** Re-derives a persisted manifest from its own fields; any drift or malformed SHA fails closed. */
export function verifyProvenanceManifest(manifest) {
  assertClosedKeys(manifest, PROVENANCE_MANIFEST_FIELDS_V1, 'PROVENANCE_MANIFEST_NOT_CLOSED');
  if (manifest.schema !== PROVENANCE_MANIFEST_SCHEMA_V1) failClosed('PROVENANCE_MANIFEST_SCHEMA_INVALID');
  requireSha256(manifest.provenanceId, 'PROVENANCE_IDENTITY_MALFORMED', { field: 'provenanceId' });
  const { schema, provenanceId, ...fields } = manifest;
  const rebuilt = buildProvenanceManifest(fields);
  if (rebuilt.provenanceId !== provenanceId) failClosed('PROVENANCE_ID_MISMATCH', { declared: provenanceId, derived: rebuilt.provenanceId });
  return rebuilt;
}

export function verifyProvenanceBinding({ manifest, ensembleIdentityId, analogueIdentityIds }) {
  if (manifest.ensembleIdentityId !== ensembleIdentityId) failClosed('PROVENANCE_MISMATCH', { field: 'ensembleIdentityId' });
  const expected = [...analogueIdentityIds].sort();
  const actual = [...manifest.analogueIdentityIds].sort();
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    failClosed('PROVENANCE_MISMATCH', { field: 'analogueIdentityIds' });
  }
  return true;
}

/* ---------------------------------------------------------------------- index */

export function createEnsembleIndex({ engineVersion, combinationPolicyVersionId, horizonCoverageId }) {
  return Object.freeze({
    schema: ENSEMBLE_INDEX_SCHEMA_V1,
    engineVersion,
    combinationPolicyVersionId,
    horizonCoverageId,
    recordCount: 0,
    records: Object.freeze([]),
  });
}

/** The persisted projection of one combined result: identity members, decision, families, provenance id, D3 horizons. */
export function buildEnsembleIndexRecord(combined) {
  if (!combined?.identity || !combined?.provenance) failClosed('ENSEMBLE_RECORD_IDENTITY_REQUIRED');
  return {
    ensembleIdentityId: combined.identity.ensembleIdentityId,
    orderedMembers: combined.identity.orderedMembers.map(({ memberId, value }) => ({ memberId, value })),
    decision: combined.decision,
    abstention: { decision: combined.abstention.decision, reason: combined.abstention.reason },
    families: [...combined.families],
    provenanceId: combined.provenance.provenanceId,
    horizons: combined.horizons.map((horizon) => JSON.parse(canonicalize(
      Object.fromEntries(ENSEMBLE_RECORD_FIELDS_V1.map((field) => [field, horizon[field]])),
    ))),
  };
}

export function appendEnsembleRecord(index, record) {
  assertClosedKeys(index, ENSEMBLE_INDEX_FIELDS_V1, 'ENSEMBLE_INDEX_NOT_CLOSED');
  assertClosedKeys(record, ENSEMBLE_INDEX_RECORD_FIELDS_V1, 'ENSEMBLE_INDEX_RECORD_NOT_CLOSED');
  requireSha256(record.ensembleIdentityId, 'ENSEMBLE_INDEX_RECORD_NOT_CLOSED', { field: 'ensembleIdentityId' });
  const existing = index.records.find((entry) => entry.ensembleIdentityId === record.ensembleIdentityId);
  if (existing) {
    if (sha256Canonical(existing) === sha256Canonical(record)) return index;
    failClosed('DIVERGENT_REPLAY_REFUSED', { ensembleIdentityId: record.ensembleIdentityId });
  }
  const records = Object.freeze([...index.records, Object.freeze(record)]
    .sort((left, right) => (left.ensembleIdentityId < right.ensembleIdentityId ? -1 : left.ensembleIdentityId > right.ensembleIdentityId ? 1 : 0)));
  return Object.freeze({ ...index, recordCount: records.length, records });
}

export function serializeEnsembleIndex(index) {
  const bytes = Buffer.from(`${canonicalize(index)}\n`, 'utf8');
  if (bytes.length >= LFS_THRESHOLD_BYTES_V1) failClosed('LFS_THRESHOLD_EXCEEDED', { byteLength: bytes.length, thresholdBytes: LFS_THRESHOLD_BYTES_V1 });
  return bytes;
}

/** Parses persisted index bytes and refuses anything that is not their own canonical serialization. */
export function parseEnsembleIndex(bytes) {
  if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') failClosed('PARTIAL_ARTIFACT_REFUSED', { reason: 'INDEX_BYTES_REQUIRED' });
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  if (buffer.length === 0) failClosed('PARTIAL_ARTIFACT_REFUSED', { reason: 'EMPTY' });
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { failClosed('PARTIAL_ARTIFACT_REFUSED', { reason: 'MALFORMED_JSON' }); }
  assertClosedKeys(parsed, ENSEMBLE_INDEX_FIELDS_V1, 'ENSEMBLE_INDEX_NOT_CLOSED');
  if (parsed.schema !== ENSEMBLE_INDEX_SCHEMA_V1) failClosed('ENSEMBLE_INDEX_SCHEMA_INVALID');
  if (!Array.isArray(parsed.records) || parsed.recordCount !== parsed.records.length) failClosed('ENSEMBLE_INDEX_COUNT_MISMATCH');
  if (`${canonicalize(parsed)}\n` !== buffer.toString('utf8')) failClosed('ENSEMBLE_INDEX_NOT_CANONICAL');
  return parsed;
}

export function verifyPublicationIdentity({ productBytes, publishedSha256 }) {
  const observed = sha256Bytes(productBytes);
  if (observed !== publishedSha256) failClosed('PUBLICATION_SHA_MISMATCH', { observed, publishedSha256 });
  return observed;
}
