/**
 * GATE25 provenance: D5 GATE25_ANALOGUE_PROVENANCE_MANIFEST_V1.
 *
 * Closed manifest over the full required field list. No required field is ever
 * defaulted: an absent value refuses the manifest. availableByCutoff is recomputed
 * from availableAt and knowledgeCutoff for every input that participates in
 * selection or distance, and a single false value refuses the manifest.
 * analogueIndexSha256 binds the exact canonical ANALOGUE_INDEX.json bytes.
 */

import { canonicalize, sha256Bytes } from '../../../tools/canonical-json.mjs';
import {
  assertClosedKeys,
  failClosed,
  instantMs,
  isCanonicalUtcInstant,
  isExactGovernedString,
} from './analogue-identity-v1.mjs';
import { ELIGIBILITY_EXCLUSION_REASONS_V1 } from './analogue-eligibility-v1.mjs';
import { parseAnalogueIndex, readIndexRecord } from './analogue-index-v1.mjs';

export const PROVENANCE_SCHEMA_V1 = 'GATE25_ANALOGUE_PROVENANCE_MANIFEST_V1';
export const PROVENANCE_PRODUCT_PATH_V1 = 'data/jarvise/historical-analogue/GATE25/V1/PROVENANCE.json';
export const PROVENANCE_FIELDS_V1 = Object.freeze([
  'schema', 'queryIdentityId', 'datasetId', 'datasetSha256', 'sourceBindingId', 'instrumentIdentityId',
  'featureDatasetId', 'selectionPolicyVersionId', 'knowledgeCutoff', 'eligibleHistoryPinSetId', 'inputProofs',
  'selectedAnalogueIdentityIds', 'distanceEvidence', 'eligibleUniverseCount', 'excludedUniverseCount',
  'exclusionCountsByReason', 'outcomeHorizonBindings', 'supportReportId', 'analogueIndexSha256',
]);
export const PROVENANCE_INPUT_PROOF_FIELDS_V1 = Object.freeze([
  'inputId', 'sourceArtifactId', 'sourceArtifactSha256', 'availableAt', 'knowledgeCutoff', 'availableByCutoff',
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** availableByCutoff is always computed here, never accepted from a caller. */
export function buildInputProof({ inputId, sourceArtifactId, sourceArtifactSha256, availableAt, knowledgeCutoff }) {
  if (!isExactGovernedString(inputId) || !isExactGovernedString(sourceArtifactId)) failClosed('INPUT_PROOF_IDENTIFIER_REQUIRED');
  if (typeof sourceArtifactSha256 !== 'string' || !SHA256_HEX.test(sourceArtifactSha256)) failClosed('INPUT_PROOF_SOURCE_SHA256_INVALID', { inputId });
  if (!isCanonicalUtcInstant(availableAt)) failClosed('INPUT_PROOF_AVAILABLE_AT_UNKNOWN', { inputId });
  const cutoffMs = instantMs(knowledgeCutoff, 'INPUT_PROOF_KNOWLEDGE_CUTOFF_INVALID');
  return Object.freeze({
    inputId,
    sourceArtifactId,
    sourceArtifactSha256,
    availableAt,
    knowledgeCutoff,
    availableByCutoff: Date.parse(availableAt) <= cutoffMs,
  });
}

function assertRequired(fields) {
  for (const field of PROVENANCE_FIELDS_V1) {
    if (fields[field] === undefined || fields[field] === null) failClosed('PROVENANCE_REQUIRED_FIELD_ABSENT', { field });
  }
}

export function buildProvenanceManifest(fields) {
  assertClosedKeys(fields, PROVENANCE_FIELDS_V1, 'PROVENANCE_FIELDS_NOT_CLOSED');
  assertRequired(fields);
  if (fields.schema !== PROVENANCE_SCHEMA_V1) failClosed('PROVENANCE_SCHEMA_INVALID');
  for (const field of ['queryIdentityId', 'datasetId', 'sourceBindingId', 'instrumentIdentityId', 'featureDatasetId',
    'selectionPolicyVersionId', 'eligibleHistoryPinSetId', 'supportReportId']) {
    if (!isExactGovernedString(fields[field])) failClosed('PROVENANCE_FIELD_NOT_EXACT', { field });
  }
  if (!isCanonicalUtcInstant(fields.knowledgeCutoff)) failClosed('PROVENANCE_KNOWLEDGE_CUTOFF_INVALID');
  for (const field of ['datasetSha256', 'analogueIndexSha256']) {
    if (!SHA256_HEX.test(fields[field])) failClosed('PROVENANCE_SHA256_INVALID', { field });
  }
  if (fields.datasetId !== fields.eligibleHistoryPinSetId) failClosed('PROVENANCE_PIN_SET_DATASET_MISMATCH');
  if (!Array.isArray(fields.inputProofs) || fields.inputProofs.length === 0) failClosed('PROVENANCE_INPUT_PROOFS_REQUIRED');
  const inputIds = new Set();
  fields.inputProofs.forEach((proof, index) => {
    assertClosedKeys(proof, PROVENANCE_INPUT_PROOF_FIELDS_V1, 'PROVENANCE_INPUT_PROOF_NOT_CLOSED', { index });
    const rebuilt = buildInputProof(proof);
    if (rebuilt.availableByCutoff !== proof.availableByCutoff) failClosed('PROVENANCE_AVAILABLE_BY_CUTOFF_NOT_RECOMPUTED', { inputId: proof.inputId });
    if (rebuilt.availableByCutoff !== true) failClosed('INPUT_NOT_AVAILABLE_BY_CUTOFF', { inputId: proof.inputId });
    if (Date.parse(proof.knowledgeCutoff) > Date.parse(fields.knowledgeCutoff)) failClosed('INPUT_PROOF_CUTOFF_AFTER_QUERY_CUTOFF', { inputId: proof.inputId });
    if (inputIds.has(proof.inputId)) failClosed('PROVENANCE_INPUT_PROOF_DUPLICATE', { inputId: proof.inputId });
    inputIds.add(proof.inputId);
  });
  if (!Array.isArray(fields.selectedAnalogueIdentityIds) || new Set(fields.selectedAnalogueIdentityIds).size !== fields.selectedAnalogueIdentityIds.length) {
    failClosed('PROVENANCE_SELECTED_ANALOGUES_INVALID');
  }
  if (fields.eligibleUniverseCount !== fields.selectedAnalogueIdentityIds.length) failClosed('PROVENANCE_ELIGIBLE_COUNT_MISMATCH');
  if (!Number.isInteger(fields.excludedUniverseCount) || fields.excludedUniverseCount < 0) failClosed('PROVENANCE_EXCLUDED_COUNT_INVALID');
  if (!Array.isArray(fields.exclusionCountsByReason)
    || fields.exclusionCountsByReason.map((entry) => entry.reasonId).join('|') !== ELIGIBILITY_EXCLUSION_REASONS_V1.join('|')) {
    failClosed('PROVENANCE_EXCLUSION_COUNTS_INVALID');
  }
  if (!Array.isArray(fields.outcomeHorizonBindings) || fields.outcomeHorizonBindings.length === 0) failClosed('PROVENANCE_OUTCOME_HORIZONS_REQUIRED');
  const manifest = JSON.parse(canonicalize(fields));
  return Object.freeze({ manifest, text: canonicalize(manifest) });
}

export const provenanceSha256 = (provenanceText) => sha256Bytes(Buffer.from(provenanceText, 'utf8'));

/** Binds a persisted provenance manifest to the exact persisted index bytes. */
export function verifyProvenanceIndexBinding({ provenanceText, indexText }) {
  let parsed;
  try {
    parsed = JSON.parse(provenanceText);
  } catch {
    failClosed('PROVENANCE_NOT_JSON');
  }
  const rebuilt = buildProvenanceManifest(parsed);
  if (rebuilt.text !== provenanceText) failClosed('PROVENANCE_NOT_CANONICAL');
  const index = parseAnalogueIndex(indexText);
  if (sha256Bytes(Buffer.from(indexText, 'utf8')) !== parsed.analogueIndexSha256) failClosed('PROVENANCE_INDEX_SHA256_MISMATCH');
  if (index.datasetId !== parsed.datasetId || index.selectionPolicyVersionId !== parsed.selectionPolicyVersionId) {
    failClosed('PROVENANCE_INDEX_BINDING_MISMATCH');
  }
  const absent = parsed.selectedAnalogueIdentityIds.find((id) => readIndexRecord(index, id) === null);
  if (absent !== undefined) failClosed('PROVENANCE_SELECTED_ANALOGUE_NOT_IN_INDEX', { analogueIdentityId: absent });
  return Object.freeze({ manifest: rebuilt.manifest, index });
}

export function describeProvenanceManifest() {
  return Object.freeze({
    schema: PROVENANCE_SCHEMA_V1,
    persistedPath: PROVENANCE_PRODUCT_PATH_V1,
    serialization: 'CanonicalJSON/1',
    requiredFields: PROVENANCE_FIELDS_V1,
    inputProofRequiredFields: PROVENANCE_INPUT_PROOF_FIELDS_V1,
    availableByCutoffRule: 'availableByCutoff = true for every input participating in selection or distance',
    requiredFieldSilentDefault: 'FORBIDDEN',
  });
}
