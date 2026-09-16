/**
 * GATE26_CONSUMPTION_BOUNDARY_V1 — the real consumer surface GATE27 will import.
 *
 * The consumer reads SERIALIZED product bytes, never an in-memory record. Before a
 * record is returned it re-derives, from those bytes alone: the declared product
 * identities, the ensemble identity digest, the provenance manifest and its binding
 * to the identity members, the regime binding digest, the three V1 families, the
 * ALL_AND_ONLY horizon set and the abstention the frozen V1 policy requires.
 *
 * A consumer version mismatch is ABSTAIN. Every integrity violation fails closed.
 * There is no permissive fallback. Wheel live-scan inline compute is forbidden.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { CORE_V1_DIMENSIONS_V1 } from '../../GATE25/implementation/analogue-eligibility-v1.mjs';
import { SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1 } from '../../GATE25/implementation/analogue-report-v1.mjs';
import {
  ENSEMBLE_ENGINE_VERSION_V1, assertClosedKeys, failClosed, horizonCoverageId, verifyEnsembleIdentity,
} from './ensemble-identity-v1.mjs';
import {
  ABSTAIN_REASONS_V1, COMBINATION_POLICY_SCHEMA_V1, FAMILIES_V1, refuseForcedNonAbstention, refuseProbabilityClaim,
} from './combination-policy-v1.mjs';
import { ADMISSIBLE_SESSION_COUNTS_V1, ENSEMBLE_RECORD_FIELDS_V1, MULTI_HORIZON_OUTPUT_SCHEMA_V1 } from './ensemble-record-v1.mjs';
import {
  ENSEMBLE_INDEX_PRODUCT_PATH_V1, ENSEMBLE_INDEX_RECORD_FIELDS_V1, PRODUCT_PROVENANCE_FIELDS_V1, PRODUCT_PROVENANCE_SCHEMA_V1,
  PROVENANCE_PRODUCT_PATH_V1, isSha256Hex, parseEnsembleIndex, validateInputBinding, verifyProvenanceManifest,
} from './ensemble-provenance-v1.mjs';

export const CONSUMPTION_BOUNDARY_SCHEMA_V1 = 'GATE26_CONSUMPTION_BOUNDARY_V1';
export const CONSUMER_VERSION_V1 = 'GATE26_ConsumptionBoundary/1';
export const CONSUMPTION_BOUNDARY_CONTRACT_PATH_V1 = 'governance/gates/GATE26/contracts/GATE26_CONSUMPTION_BOUNDARY_V1.json';

const member = (record, memberId) => record.orderedMembers.find((entry) => entry.memberId === memberId)?.value;

function parseProductProvenance(bytes) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { failClosed('PARTIAL_ARTIFACT_REFUSED', { reason: 'PROVENANCE_MALFORMED_JSON' }); }
  assertClosedKeys(parsed, PRODUCT_PROVENANCE_FIELDS_V1, 'INCOMPATIBLE_PUBLISHED_RECORD', { artifact: 'PROVENANCE' });
  if (parsed.schema !== PRODUCT_PROVENANCE_SCHEMA_V1) failClosed('INCOMPATIBLE_PUBLISHED_RECORD', { artifact: 'PROVENANCE', field: 'schema' });
  if (!Array.isArray(parsed.records)) failClosed('INCOMPATIBLE_PUBLISHED_RECORD', { artifact: 'PROVENANCE', field: 'records' });
  return parsed;
}

function verifyFamilies(record) {
  if (!Array.isArray(record.families)) failClosed('INCOMPATIBLE_PUBLISHED_RECORD', { field: 'families' });
  for (const family of FAMILIES_V1) {
    if (!record.families.includes(family)) {
      if (family === 'ANALOGUE_OUTCOME_FAMILY') failClosed('PREDICTIVE_FAMILY_MISSING', { family });
      failClosed('DEGRADED_INPUT', { family });
    }
  }
  if (record.families.length !== FAMILIES_V1.length || FAMILIES_V1.some((family, index) => record.families[index] !== family)) {
    failClosed('INCOMPATIBLE_PUBLISHED_RECORD', { field: 'families' });
  }
}

function verifyHorizons(record, manifest) {
  if (!Array.isArray(record.horizons) || record.horizons.length === 0) failClosed('HORIZON_COVERAGE_EMPTY');
  const counts = record.horizons.map((horizon) => horizon?.sessionCount);
  for (const count of counts) {
    if (!ADMISSIBLE_SESSION_COUNTS_V1.includes(count)) failClosed('HORIZON_NOT_ADMISSIBLE', { sessionCount: count });
  }
  if (new Set(counts).size !== counts.length || counts.length > ADMISSIBLE_SESSION_COUNTS_V1.length) {
    failClosed('HORIZON_NOT_ADMISSIBLE', { reason: 'EXTRA_OR_DUPLICATE_HORIZON', sessionCounts: counts });
  }
  const absent = ADMISSIBLE_SESSION_COUNTS_V1.filter((count) => !counts.includes(count));
  if (absent.length > 0) failClosed('HORIZON_REQUIRED_MISSING', { sessionCounts: absent });
  record.horizons.forEach((horizon, index) => {
    assertClosedKeys(horizon, ENSEMBLE_RECORD_FIELDS_V1, 'INCOMPATIBLE_PUBLISHED_RECORD', { horizonIndex: index });
    if (horizon.sessionCount !== ADMISSIBLE_SESSION_COUNTS_V1[index]) failClosed('HORIZON_NOT_ADMISSIBLE', { reason: 'ORDER', index });
    if (horizon.schema !== MULTI_HORIZON_OUTPUT_SCHEMA_V1 || horizon.ensembleIdentityId !== record.ensembleIdentityId) {
      failClosed('INCOMPATIBLE_PUBLISHED_RECORD', { horizonIndex: index });
    }
    if (horizon.horizonId !== `${horizon.sessionCount}:${manifest.inputBinding.calendarRegistryManifestId}`) {
      failClosed('HORIZON_NOT_ADMISSIBLE', { reason: 'HORIZON_ID_NOT_BOUND_TO_CALENDAR', index });
    }
    assertClosedKeys(horizon.provenanceBinding, ['provenanceId', 'selectionDigest'], 'PROVENANCE_BINDING_MISMATCH', { horizonIndex: index });
    if (horizon.provenanceBinding.provenanceId !== record.provenanceId || horizon.provenanceBinding.selectionDigest !== manifest.selectionDigest) {
      failClosed('PROVENANCE_BINDING_MISMATCH', { horizonIndex: index });
    }
    if (horizon.supportDerivedConfidence?.kind !== 'SUPPORT_DERIVED_NOT_PROBABILITY' || horizon.supportDerivedConfidence.calibratedProbability !== null) {
      failClosed('PROBABILITY_CLAIM_FORBIDDEN', { horizonIndex: index });
    }
    refuseProbabilityClaim(horizon);
  });
}

/** The abstention frozen V1 semantics require for this record, re-derived from its own evidence. */
function verifyAbstention(record) {
  assertClosedKeys(record.abstention, ['decision', 'reason'], 'INCOMPATIBLE_PUBLISHED_RECORD', { field: 'abstention' });
  if (record.abstention.decision !== record.decision || !['PROCEED', 'ABSTAIN'].includes(record.decision)) {
    failClosed('ABSTENTION_INCONSISTENT', { field: 'decision' });
  }
  const support = record.horizons[0].supportDerivedConfidence;
  if (record.horizons.some((horizon) => horizon.supportDerivedConfidence.supportStatus !== support.supportStatus
    || horizon.supportDerivedConfidence.eligibleCount !== support.eligibleCount)) {
    failClosed('ABSTENTION_INCONSISTENT', { field: 'supportDerivedConfidence' });
  }
  if (member(record, 'MissingnessStateId') !== support.supportStatus) failClosed('PROVENANCE_BINDING_MISMATCH', { field: 'MissingnessStateId' });
  record.horizons.forEach((horizon, index) => {
    const summary = horizon.analogueOutcomeSummary;
    const derived = summary.missingCount === summary.analogueCount ? 'MISSING'
      : summary.availableCount === summary.analogueCount ? 'AVAILABLE' : 'PARTIAL';
    if (summary.availableCount + summary.missingCount !== summary.analogueCount || summary.analogueCount !== support.eligibleCount
      || horizon.outcomeAvailability !== derived) {
      failClosed('ABSTENTION_INCONSISTENT', { horizonIndex: index, field: 'outcomeAvailability' });
    }
  });
  const insufficient = support.supportStatus !== 'SUFFICIENT_SUPPORT' || support.eligibleCount < SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1;
  const allMissing = record.horizons.every((horizon) => horizon.outcomeAvailability === 'MISSING');
  const requiredReason = insufficient ? 'INSUFFICIENT_SUPPORT' : allMissing ? 'PREDICTIVE_FAMILY_MISSING' : null;
  if (record.decision === 'PROCEED' && requiredReason !== null) refuseForcedNonAbstention();
  if (canonicalize(record.abstention) !== canonicalize({ decision: requiredReason === null ? 'PROCEED' : 'ABSTAIN', reason: requiredReason })
    || (requiredReason !== null && !ABSTAIN_REASONS_V1.includes(requiredReason))) {
    failClosed('ABSTENTION_INCONSISTENT', { declared: record.abstention.reason, required: requiredReason });
  }
  record.horizons.forEach((horizon, index) => {
    const reason = requiredReason ?? (horizon.outcomeAvailability === 'MISSING' ? 'PREDICTIVE_FAMILY_MISSING' : null);
    if (horizon.abstention?.decision === 'PROCEED' && reason !== null) refuseForcedNonAbstention();
    if (canonicalize(horizon.abstention) !== canonicalize({ decision: reason === null ? 'PROCEED' : 'ABSTAIN', reason })) {
      failClosed('ABSTENTION_INCONSISTENT', { horizonIndex: index });
    }
  });
}

/**
 * @param indexBytes / provenanceBytes  the serialized MINI products (Buffers)
 * @param expectedIndexSha256 / expectedProvenanceSha256  identities the consumer was told to trust
 * @param ensembleIdentityId  the ensemble question being consumed
 */
export function consumeEnsemble({
  indexBytes,
  provenanceBytes,
  ensembleIdentityId,
  expectedIndexSha256,
  expectedProvenanceSha256,
  expectedCombinationPolicyVersionId,
  expectedEngineVersion = ENSEMBLE_ENGINE_VERSION_V1,
  expectedPolicySchema = COMBINATION_POLICY_SCHEMA_V1,
  consumerId = 'GATE27_FUTURE',
}) {
  if (!Buffer.isBuffer(indexBytes) || !Buffer.isBuffer(provenanceBytes)) failClosed('PARTIAL_ARTIFACT_REFUSED', { consumerId, reason: 'SERIALIZED_BYTES_REQUIRED' });
  for (const [field, value] of Object.entries({ expectedIndexSha256, expectedProvenanceSha256, expectedCombinationPolicyVersionId, ensembleIdentityId })) {
    if (!isSha256Hex(value)) failClosed('CONSUMER_DECLARED_IDENTITY_REQUIRED', { field });
  }
  const indexSha256 = sha256Bytes(indexBytes);
  if (indexSha256 !== expectedIndexSha256) failClosed('PRODUCT_BYTES_IDENTITY_MISMATCH', { artifact: 'ENSEMBLE_INDEX', observed: indexSha256 });
  const provenanceSha256 = sha256Bytes(provenanceBytes);
  if (provenanceSha256 !== expectedProvenanceSha256) failClosed('PRODUCT_BYTES_IDENTITY_MISMATCH', { artifact: 'PROVENANCE', observed: provenanceSha256 });

  const index = parseEnsembleIndex(indexBytes);
  const productProvenance = parseProductProvenance(provenanceBytes);
  if (productProvenance.product?.ensembleIndexSha256 !== indexSha256 || productProvenance.product?.ensembleIndexByteLength !== indexBytes.length
    || productProvenance.product?.ensembleIndexPath !== ENSEMBLE_INDEX_PRODUCT_PATH_V1 || productProvenance.product?.recordCount !== index.recordCount) {
    failClosed('PRODUCT_IDENTITY_NOT_BOUND_BY_PROVENANCE');
  }

  if (index.engineVersion !== expectedEngineVersion || index.combinationPolicyVersionId !== expectedCombinationPolicyVersionId
    || productProvenance.modelPolicy?.combinationPolicySchema !== expectedPolicySchema
    || productProvenance.modelPolicy?.engineVersion !== index.engineVersion
    || productProvenance.modelPolicy?.combinationPolicyVersionId !== index.combinationPolicyVersionId) {
    return Object.freeze({ decision: 'ABSTAIN', abstainReason: 'CONSUMER_VERSION_MISMATCH', consumerId, record: null, verification: null });
  }
  const coverageId = horizonCoverageId(ADMISSIBLE_SESSION_COUNTS_V1);
  if (index.horizonCoverageId !== coverageId || productProvenance.modelPolicy.horizonCoverageId !== coverageId) {
    failClosed('HORIZON_NOT_ADMISSIBLE', { reason: 'INDEX_HORIZON_COVERAGE' });
  }
  const productInputBinding = validateInputBinding(productProvenance.inputBinding);

  const matches = index.records.filter((entry) => entry?.ensembleIdentityId === ensembleIdentityId);
  if (matches.length !== 1) failClosed('ENSEMBLE_IDENTITY_NOT_PUBLISHED', { ensembleIdentityId, matches: matches.length });
  const record = matches[0];
  assertClosedKeys(record, ENSEMBLE_INDEX_RECORD_FIELDS_V1, 'INCOMPATIBLE_PUBLISHED_RECORD');
  verifyEnsembleIdentity({ ensembleIdentityId: record.ensembleIdentityId, orderedMembers: record.orderedMembers });
  if (member(record, 'CombinationPolicyVersionId') !== index.combinationPolicyVersionId || member(record, 'HorizonCoverageId') !== coverageId) {
    failClosed('STALE_OR_WRONG_VERSION', { ensembleIdentityId });
  }

  const manifests = productProvenance.records.filter((entry) => entry?.ensembleIdentityId === ensembleIdentityId);
  if (manifests.length !== 1) failClosed('PROVENANCE_RECORD_ABSENT', { ensembleIdentityId, matches: manifests.length });
  const manifest = verifyProvenanceManifest(manifests[0]);
  if (manifest.provenanceId !== record.provenanceId) failClosed('PROVENANCE_ID_MISMATCH', { ensembleIdentityId });
  if (canonicalize(manifest.inputBinding) !== canonicalize(productInputBinding)) failClosed('PROVENANCE_BINDING_MISMATCH', { field: 'inputBinding' });
  if (manifest.inputBinding.datasetId !== member(record, 'DatasetId_observation')) {
    failClosed('DATASET_IDENTITY_MISMATCH', { declared: member(record, 'DatasetId_observation'), provenance: manifest.inputBinding.datasetId });
  }
  for (const [field, memberId] of [
    ['queryIdentityId', 'QueryAnalogueIdentityId'], ['knowledgeCutoff', 'KnowledgeCutoff'],
    ['combinationPolicyVersionId', 'CombinationPolicyVersionId'], ['horizonCoverageId', 'HorizonCoverageId'],
    ['supportReportId', 'AnalogueSupportReportId'], ['outcomeSetId', 'OutcomeSetId'],
  ]) {
    if (manifest[field] !== member(record, memberId)) failClosed('PROVENANCE_BINDING_MISMATCH', { field });
  }
  if (canonicalize(manifest.regimeBinding.dimensions) !== canonicalize([...CORE_V1_DIMENSIONS_V1])
    || sha256Canonical(manifest.regimeBinding) !== member(record, 'RegimeBindingDigest')) {
    failClosed('REGIME_BINDING_INVALID', { ensembleIdentityId });
  }

  verifyFamilies(record);
  verifyHorizons(record, manifest);
  verifyAbstention(record);

  const verification = Object.freeze({
    consumerVersion: CONSUMER_VERSION_V1,
    indexSha256,
    provenanceSha256,
    ensembleIdentityId,
    provenanceId: manifest.provenanceId,
    datasetIdObservation: manifest.inputBinding.datasetId,
  });
  return Object.freeze({
    decision: record.decision === 'PROCEED' ? 'CONSUME' : 'ABSTAIN',
    abstainReason: record.abstention.reason,
    consumerId,
    record: JSON.parse(canonicalize(record)),
    verification,
  });
}

/** Reads the canonical MINI product bytes from disk and consumes them through the same boundary. */
export function consumePublishedEnsemble({ root, ...request }) {
  const read = (path) => {
    try { return readFileSync(resolve(root, path)); } catch (cause) { failClosed('PARTIAL_ARTIFACT_REFUSED', { path, cause: cause.code }); }
  };
  return consumeEnsemble({ ...request, indexBytes: read(ENSEMBLE_INDEX_PRODUCT_PATH_V1), provenanceBytes: read(PROVENANCE_PRODUCT_PATH_V1) });
}

export function refuseWheelScanInlineCompute() {
  failClosed('WHEEL_SCAN_INLINE_COMPUTE_FORBIDDEN');
}

export function describeConsumptionBoundary() {
  return Object.freeze({
    schema: CONSUMPTION_BOUNDARY_SCHEMA_V1,
    consumerVersion: CONSUMER_VERSION_V1,
    consumer: 'GATE27',
    input: 'SERIALIZED_PRODUCT_BYTES',
    products: [ENSEMBLE_INDEX_PRODUCT_PATH_V1, PROVENANCE_PRODUCT_PATH_V1],
    declaredIdentityRequired: true,
    fallback: 'ABSTAIN',
    permissiveFallback: 'FORBIDDEN',
    wheelScanInlineCompute: 'FORBIDDEN',
    liveLearning: 'FORBIDDEN',
    brokerWrites: 'FORBIDDEN',
  });
}
