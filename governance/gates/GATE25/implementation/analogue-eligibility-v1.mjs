/**
 * GATE25 exact historical eligibility: D7 GATE25_ELIGIBILITY_EXCLUSION_REASON_V1.
 *
 * Phase 1 (SELECTION) only. Every candidate deterministically becomes ELIGIBLE, or
 * EXCLUDED with every applicable reason emitted in the closed twelve-reason
 * precedence order. No candidate is silently dropped: universeCount always equals
 * eligibleCount + excludedCount, and every decision enters a running digest.
 *
 * Inputs are closed schemas. A renamed, lagged or type-laundered Outcome has no key
 * through which it could enter; an unknown key fails closed. Dataset-level identity
 * or binding failure is an engine fail-closed condition, never an exclusion reason.
 *
 * GATE24 RegimeRecords are consumed read-only through their recomputed
 * RegimeRecordId; only the six CORE_V1 dimensions are read.
 */

import { createHash } from 'node:crypto';
import { canonicalize, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { createRegimeRecordId, FEATURE_VECTOR_BINDING_VERSION } from '../../GATE24/implementation/regime-identity-v1.mjs';
import {
  ACTIVE_DIMENSION_NAMES_V1,
  assertDeclaredEntry,
  isClassifyingValue,
} from '../../GATE24/implementation/regime-taxonomy-v1.mjs';
import {
  ADMISSIBLE_PRICE_BASIS_ID_V1,
  assertClosedKeys,
  failClosed,
  instantMs,
  isCanonicalSessionDate,
  isCanonicalUtcInstant,
  isExactGovernedString,
  isPlainObject,
  missingnessStateId,
  readHistoricalInstrumentIdentity,
  resolveMissingnessState,
} from './analogue-identity-v1.mjs';
import { DISTANCE_FEATURE_IDS_V1 } from './analogue-distance-v1.mjs';

export const ELIGIBILITY_VOCABULARY_ID_V1 = 'GATE25_ELIGIBILITY_EXCLUSION_REASON_V1';

/** D7: closed vocabulary, exact precedence order. */
export const ELIGIBILITY_EXCLUSION_REASONS_V1 = Object.freeze([
  'P3H_EXCLUDED_MALFORMED_PROVIDER_RESULT',
  'P3H_EXCLUDED_SCHEMA_FAILURE',
  'P3H_EXCLUDED_SNAPSHOT_CONTRACT_INVALID',
  'OUTSIDE_HISTORICAL_WINDOW',
  'AVAILABLE_AFTER_KNOWLEDGE_CUTOFF',
  'INSTRUMENT_IDENTITY_MISMATCH',
  'REGIME_HORIZON_SPEC_MISMATCH',
  'CORE_V1_REGIME_MISMATCH',
  'VOLATILITY_STATE_UNAVAILABLE',
  'REQUIRED_DISTANCE_FEATURE_MISSING',
  'REQUIRED_DISTANCE_FEATURE_MALFORMED',
  'REQUIRED_DISTANCE_FEATURE_NON_FINITE',
]);
const REASON = Object.freeze(Object.fromEntries(ELIGIBILITY_EXCLUSION_REASONS_V1.map((reason, index) => [reason, index])));

/** D7 p3hClassMapping, keyed by the P3H finalization exclusions[].reasonCode. */
export const P3H_EXCLUSION_CLASS_REASONS_V1 = Object.freeze({
  MALFORMED_PROVIDER_RESULT: 'P3H_EXCLUDED_MALFORMED_PROVIDER_RESULT',
  SCHEMA_FAILURE: 'P3H_EXCLUDED_SCHEMA_FAILURE',
  SNAPSHOT_CONTRACT_INVALID: 'P3H_EXCLUDED_SNAPSHOT_CONTRACT_INVALID',
});

/** Mandate IC-12 / OD-1: the six CORE_V1 dimensions, in canonical order. */
export const CORE_V1_DIMENSIONS_V1 = Object.freeze([
  'primaryMarketRegime',
  'volatilityState',
  'inflationState',
  'ratesState',
  'yieldCurveShape',
  'yieldCurveDirection',
]);
if (ACTIVE_DIMENSION_NAMES_V1.length !== CORE_V1_DIMENSIONS_V1.length
  || CORE_V1_DIMENSIONS_V1.some((name, index) => ACTIVE_DIMENSION_NAMES_V1[index] !== name)) {
  throw new Error('GATE25_CORE_V1_DIMENSIONS_DIVERGE_FROM_GATE24_ACTIVE_DIMENSIONS');
}

export const CANDIDATE_SCHEMA_V1 = 'GATE25_HistoricalAnalogueCandidate/1';
export const QUERY_SCHEMA_V1 = 'GATE25_AnalogueQuery/1';
export const CANDIDATE_KEYS_V1 = Object.freeze([
  'schema', 'candidateKey', 'p3hKeyId', 'p3hAdmission', 'sessionDate', 'knowledgeCutoff',
  'instrumentIdentity', 'priceBasisId', 'featureVectorBinding', 'features', 'regimeRecord', 'inputProofs',
]);
export const QUERY_KEYS_V1 = Object.freeze([
  'schema', 'sessionDate', 'knowledgeCutoff', 'instrumentIdentity', 'priceBasisId',
  'featureVectorBinding', 'features', 'regimeRecord', 'inputProofs', 'sourceBindingId',
]);
export const FEATURE_INPUT_KEYS_V1 = Object.freeze(['featureRecordId', 'status', 'code', 'value']);
export const INPUT_PROOF_KEYS_V1 = Object.freeze(['inputId', 'sourceArtifactId', 'sourceArtifactSha256', 'availableAt']);
export const REGIME_RECORD_PROOF_INPUT_ID = 'GATE24_REGIME_RECORD';

/** The exact GATE24_RegimeRecord/1 emission shape (regime-store-v1.mjs::emitRegimeRecord). */
export const GATE24_REGIME_RECORD_KEYS_V1 = Object.freeze([
  'schemaVersion', 'regimeRecordId', 'identity', 'identityTuple', 'identityMemberCount',
  'InstrumentIdentityId', 'SessionDate', 'KnowledgeCutoff', 'RegimeHorizonSpecId', 'FeatureVectorBindingId',
  'MacroContextBindingId', 'RegimeTaxonomyVersionId', 'ClassifierVersionId', 'ParameterSetId',
  'DatasetId_feature', 'MissingnessStateId', 'knowledgeCutoffBoundary', 'regimeVector',
  'classificationQuality', 'classificationEvidence', 'evidenceSetId', 'missingnessState', 'missingnessStateId',
  'missingnessPolicyVersion', 'missingnessModel', 'macroFeatureCompleteness', 'activeDimensions', 'inactiveDimensions',
]);
export const GATE24_FEATURE_VECTOR_BINDING_KEYS_V1 = Object.freeze([
  'schemaVersion', 'instrumentIdentityId', 'sessionDate', 'knowledgeCutoff', 'datasetIdFeature',
  'featureRecordIds', 'featureWindowSpecIds', 'calendarWindowBindingIds', 'featureVectorBindingId',
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/* ----------------------------------------------------------------- input readers */

function readFeatureVectorBinding(binding, { sessionDate, knowledgeCutoff }) {
  if (binding === null) return null;
  assertClosedKeys(binding, GATE24_FEATURE_VECTOR_BINDING_KEYS_V1, 'FEATURE_VECTOR_BINDING_NOT_CLOSED');
  if (binding.schemaVersion !== FEATURE_VECTOR_BINDING_VERSION) failClosed('FEATURE_VECTOR_BINDING_SCHEMA_INVALID');
  const { featureVectorBindingId, ...payload } = binding;
  if (sha256Canonical(payload) !== featureVectorBindingId) failClosed('FEATURE_VECTOR_BINDING_ID_MISMATCH');
  if (!Array.isArray(binding.calendarWindowBindingIds) || binding.calendarWindowBindingIds.length !== 1) {
    failClosed('CALENDAR_WINDOW_BINDING_NOT_SINGLE_VALUED', { observed: binding.calendarWindowBindingIds?.length ?? null });
  }
  if (binding.sessionDate !== sessionDate || binding.knowledgeCutoff !== knowledgeCutoff) {
    failClosed('FEATURE_VECTOR_BINDING_SESSION_MISMATCH');
  }
  return Object.freeze({
    featureVectorBindingId,
    instrumentIdentityId: binding.instrumentIdentityId,
    featureRecordIds: new Set(binding.featureRecordIds),
    calendarWindowBindingId: binding.calendarWindowBindingIds[0],
  });
}

function readRegimeRecord(record, { sessionDate, knowledgeCutoff, featureVectorBinding, identity }) {
  if (record === null) return null;
  assertClosedKeys(record, GATE24_REGIME_RECORD_KEYS_V1, 'REGIME_RECORD_NOT_CLOSED');
  if (record.schemaVersion !== 'GATE24_RegimeRecord/1') failClosed('REGIME_RECORD_SCHEMA_INVALID');
  let recomputed;
  try {
    recomputed = createRegimeRecordId(record.identity);
  } catch (cause) {
    failClosed('REGIME_RECORD_IDENTITY_NOT_EXACT', { cause: cause.message });
  }
  if (recomputed !== record.regimeRecordId) failClosed('REGIME_RECORD_IDENTITY_MISMATCH');
  const members = record.identity;
  if (members.SessionDate !== sessionDate || members.KnowledgeCutoff !== knowledgeCutoff) {
    failClosed('REGIME_RECORD_SESSION_BINDING_MISMATCH');
  }
  if (featureVectorBinding === null || members.FeatureVectorBindingId !== featureVectorBinding.featureVectorBindingId) {
    failClosed('REGIME_RECORD_FEATURE_VECTOR_BINDING_MISMATCH');
  }
  if (identity.matchable && members.InstrumentIdentityId !== identity.instrumentIdentityId) {
    failClosed('REGIME_RECORD_INSTRUMENT_IDENTITY_MISMATCH');
  }
  if (!isPlainObject(record.regimeVector)) failClosed('REGIME_VECTOR_INVALID');
  const coreV1 = {};
  const coreV1Classifying = {};
  for (const dimension of CORE_V1_DIMENSIONS_V1) {
    try {
      coreV1[dimension] = assertDeclaredEntry(dimension, record.regimeVector[dimension]);
    } catch {
      failClosed('REGIME_VECTOR_VALUE_OUT_OF_TAXONOMY', { dimension });
    }
    coreV1Classifying[dimension] = isClassifyingValue(dimension, coreV1[dimension]);
  }
  const allCoreV1Classifying = CORE_V1_DIMENSIONS_V1.every((dimension) => coreV1Classifying[dimension]);
  return Object.freeze({
    regimeRecordId: record.regimeRecordId,
    regimeHorizonSpecId: members.RegimeHorizonSpecId,
    macroContextBindingId: members.MacroContextBindingId,
    datasetIdFeature: members.DatasetId_feature,
    availableAt: members.KnowledgeCutoff,
    coreV1: Object.freeze(coreV1),
    coreV1Classifying: Object.freeze(coreV1Classifying),
    allCoreV1Classifying,
    volatilityStateClassifying: coreV1Classifying.volatilityState,
  });
}

/**
 * B-2: a NON-CLASSIFYING CORE_V1 value is never a valid positive exact match.
 * Equal missingness / fail-closed tokens do not constitute regime equality.
 * Only six genuinely classifying values may participate in exact CORE_V1 equality.
 */
export function evaluateCoreV1ExactMatch({ queryRegime, candidateRegime }) {
  const evidence = CORE_V1_DIMENSIONS_V1.map((dimension) => {
    const queryValue = queryRegime?.coreV1?.[dimension] ?? null;
    const candidateValue = candidateRegime?.coreV1?.[dimension] ?? null;
    const queryClassifying = queryValue !== null && isClassifyingValue(dimension, queryValue);
    const candidateClassifying = candidateValue !== null && isClassifyingValue(dimension, candidateValue);
    return Object.freeze({
      dimension,
      queryClassifying,
      candidateClassifying,
      queryValue,
      candidateValue,
    });
  });
  const match = queryRegime !== null && candidateRegime !== null
    && evidence.every((item) => item.queryClassifying && item.candidateClassifying && item.queryValue === item.candidateValue);
  return Object.freeze({ match, evidence: Object.freeze(evidence) });
}

export function coreV1Signature(coreV1) {
  return CORE_V1_DIMENSIONS_V1.map((dimension) => coreV1[dimension]).join('\u001f');
}

/** GATE23 FeatureRecord status to D7 feature reason; null means usable. */
export function classifyDistanceFeature(input) {
  if (input === null) return 'REQUIRED_DISTANCE_FEATURE_MISSING';
  assertClosedKeys(input, FEATURE_INPUT_KEYS_V1, 'DISTANCE_FEATURE_INPUT_NOT_CLOSED');
  if (input.status === 'INSUFFICIENT_DATA') return 'REQUIRED_DISTANCE_FEATURE_MISSING';
  if (input.status === 'FAIL_CLOSED') {
    return input.code === 'INPUT_MISSING' ? 'REQUIRED_DISTANCE_FEATURE_MISSING' : 'REQUIRED_DISTANCE_FEATURE_MALFORMED';
  }
  if (input.status !== 'RESOLVED') return 'REQUIRED_DISTANCE_FEATURE_MALFORMED';
  if (input.value === null || input.value === undefined) return 'REQUIRED_DISTANCE_FEATURE_MISSING';
  if (typeof input.value !== 'number') return 'REQUIRED_DISTANCE_FEATURE_MALFORMED';
  if (!Number.isFinite(input.value)) return 'REQUIRED_DISTANCE_FEATURE_NON_FINITE';
  return null;
}

function readFeatures(features, featureVectorBinding) {
  assertClosedKeys(features, DISTANCE_FEATURE_IDS_V1, 'DISTANCE_FEATURES_NOT_CLOSED');
  const classes = {};
  const values = {};
  const records = {};
  for (const featureId of DISTANCE_FEATURE_IDS_V1) {
    const input = features[featureId];
    const featureClass = classifyDistanceFeature(input);
    if (input !== null) {
      if (input.featureRecordId !== null && !isExactGovernedString(input.featureRecordId)) failClosed('DISTANCE_FEATURE_RECORD_ID_INVALID', { featureId });
      if (featureVectorBinding === null && input.featureRecordId !== null) {
        failClosed('DISTANCE_FEATURE_WITHOUT_FEATURE_VECTOR_BINDING', { featureId });
      }
      if (featureVectorBinding !== null && input.status === 'RESOLVED') {
        if (input.featureRecordId === null) failClosed('DISTANCE_FEATURE_RECORD_ID_REQUIRED', { featureId });
        if (!featureVectorBinding.featureRecordIds.has(input.featureRecordId)) {
          failClosed('DISTANCE_FEATURE_NOT_IN_FEATURE_VECTOR_BINDING', { featureId });
        }
      }
    }
    classes[featureId] = featureClass;
    values[featureId] = featureClass === null ? (input.value === 0 ? 0 : input.value) : null;
    records[featureId] = input === null ? null : Object.freeze({
      featureId,
      featureRecordId: input.featureRecordId,
      status: input.status,
      code: input.code,
      rawValue: featureClass === null ? values[featureId] : null,
    });
  }
  return Object.freeze({
    classes: Object.freeze(classes),
    values: Object.freeze(values),
    records: Object.freeze(records),
    complete: DISTANCE_FEATURE_IDS_V1.every((featureId) => classes[featureId] === null),
  });
}

function readInputProofs(proofs) {
  if (!Array.isArray(proofs)) failClosed('INPUT_PROOFS_REQUIRED');
  const seen = new Set();
  return Object.freeze(proofs.map((proof, index) => {
    assertClosedKeys(proof, INPUT_PROOF_KEYS_V1, 'INPUT_PROOF_NOT_CLOSED', { index });
    if (!isExactGovernedString(proof.inputId) || seen.has(proof.inputId)) failClosed('INPUT_PROOF_ID_INVALID', { index });
    seen.add(proof.inputId);
    if (!isExactGovernedString(proof.sourceArtifactId)) failClosed('INPUT_PROOF_SOURCE_ARTIFACT_INVALID', { index });
    if (typeof proof.sourceArtifactSha256 !== 'string' || !SHA256_HEX.test(proof.sourceArtifactSha256)) {
      failClosed('INPUT_PROOF_SOURCE_SHA256_INVALID', { index });
    }
    return Object.freeze({
      ...proof,
      availableAtMs: isCanonicalUtcInstant(proof.availableAt) ? Date.parse(proof.availableAt) : null,
    });
  }));
}

/**
 * Inputs that participate in selection or distance and must each carry a proof:
 * every usable distance feature and the bound RegimeRecord. Any additional proof
 * supplied is checked all the same.
 */
function requiredProofInputIds({ features, regime }) {
  const ids = DISTANCE_FEATURE_IDS_V1.filter((featureId) => features.classes[featureId] === null);
  if (regime !== null) ids.push(REGIME_RECORD_PROOF_INPUT_ID);
  return ids;
}

function readPriceBasis(priceBasisId) {
  if (priceBasisId !== null && priceBasisId !== ADMISSIBLE_PRICE_BASIS_ID_V1) failClosed('PRICE_BASIS_NOT_ADMITTED', { priceBasisId });
  return priceBasisId;
}

/* ------------------------------------------------------------------------ query */

/**
 * Validates the query at T. Look-ahead on the query side is never a report: an
 * unproven or post-cutoff query input fails closed, and so does an identity that
 * was not resolved at T itself.
 */
export function readAnalogueQuery(query, policy) {
  assertClosedKeys(query, QUERY_KEYS_V1, 'QUERY_INPUT_NOT_CLOSED');
  if (query.schema !== QUERY_SCHEMA_V1) failClosed('QUERY_SCHEMA_INVALID');
  if (!isCanonicalSessionDate(query.sessionDate)) failClosed('QUERY_SESSION_DATE_INVALID');
  const knowledgeCutoffMs = instantMs(query.knowledgeCutoff, 'QUERY_KNOWLEDGE_CUTOFF_INVALID');
  const window = policy.historicalObservationWindow;
  if (query.sessionDate < window.startSessionInclusive || query.sessionDate > window.endSessionInclusive) {
    failClosed('QUERY_OUTSIDE_HISTORICAL_OBSERVATION_WINDOW', { sessionDate: query.sessionDate });
  }
  if (!isExactGovernedString(query.sourceBindingId)) failClosed('QUERY_SOURCE_BINDING_REQUIRED');
  const identity = readHistoricalInstrumentIdentity({ resolution: query.instrumentIdentity, sessionDate: query.sessionDate });
  if (!identity.matchable) {
    failClosed('QUERY_INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE', { code: identity.code, sessionDate: query.sessionDate });
  }
  const priceBasisId = readPriceBasis(query.priceBasisId);
  if (priceBasisId === null) failClosed('QUERY_PRICE_BASIS_REQUIRED');
  const featureVectorBinding = readFeatureVectorBinding(query.featureVectorBinding, query);
  if (featureVectorBinding !== null && featureVectorBinding.instrumentIdentityId !== identity.instrumentIdentityId) {
    failClosed('QUERY_FEATURE_VECTOR_BINDING_IDENTITY_MISMATCH');
  }
  const features = readFeatures(query.features, featureVectorBinding);
  const regime = readRegimeRecord(query.regimeRecord, {
    sessionDate: query.sessionDate, knowledgeCutoff: query.knowledgeCutoff, featureVectorBinding, identity,
  });
  const inputProofs = readInputProofs(query.inputProofs);
  const proven = new Set(inputProofs.map((proof) => proof.inputId));
  const unproven = requiredProofInputIds({ features, regime }).filter((inputId) => !proven.has(inputId));
  if (unproven.length > 0) failClosed('QUERY_INPUT_AVAILABILITY_UNPROVEN', { unproven });
  const late = inputProofs.find((proof) => proof.availableAtMs === null || proof.availableAtMs > knowledgeCutoffMs);
  if (late !== undefined) failClosed('QUERY_INPUT_AFTER_KNOWLEDGE_CUTOFF', { inputId: late.inputId });

  const volatilityStateClassifying = regime !== null && regime.volatilityStateClassifying;
  const allCoreV1Classifying = regime !== null && regime.allCoreV1Classifying;
  return Object.freeze({
    sessionDate: query.sessionDate,
    knowledgeCutoff: query.knowledgeCutoff,
    knowledgeCutoffMs,
    identity,
    priceBasisId,
    featureVectorBinding,
    features,
    regime,
    inputProofs,
    sourceBindingId: query.sourceBindingId,
    featureDatasetId: regime === null ? null : regime.datasetIdFeature,
    volatilityStateClassifying,
    allCoreV1Classifying,
    /* Query rule: any non-classifying CORE_V1 dimension fails closed — no analogue search on missingness. */
    structuralGatesPass: allCoreV1Classifying && features.complete,
  });
}

/* ---------------------------------------------------------------------- candidate */

function readP3hAdmission(candidate, policy) {
  const admission = candidate.p3hAdmission;
  if (!isPlainObject(admission)) failClosed('P3H_ADMISSION_INVALID');
  if (admission.status === 'ADMITTED') assertClosedKeys(admission, ['status'], 'P3H_ADMISSION_NOT_CLOSED');
  else if (admission.status === 'EXCLUDED') assertClosedKeys(admission, ['status', 'exclusionClass'], 'P3H_ADMISSION_NOT_CLOSED');
  else failClosed('P3H_ADMISSION_STATUS_INVALID', { status: admission.status });

  const keyId = candidate.p3hKeyId;
  if (policy.pinSet.admittedKeyIds.has(keyId)) {
    if (admission.status !== 'ADMITTED') failClosed('P3H_ADMISSION_STATE_MISMATCH', { p3hKeyId: keyId });
    return null;
  }
  if (policy.pinSet.exclusionClassByKeyId.has(keyId)) {
    const exclusionClass = policy.pinSet.exclusionClassByKeyId.get(keyId);
    if (admission.status !== 'EXCLUDED' || admission.exclusionClass !== exclusionClass) {
      failClosed('P3H_EXCLUSION_CANNOT_BE_READMITTED', { p3hKeyId: keyId });
    }
    const reason = P3H_EXCLUSION_CLASS_REASONS_V1[exclusionClass];
    if (reason === undefined) failClosed('P3H_EXCLUSION_CLASS_NOT_MAPPED', { exclusionClass });
    return reason;
  }
  return failClosed('CANDIDATE_OUTSIDE_BOUND_PIN_SET', { p3hKeyId: keyId });
}

/**
 * Reads one historical candidate. Structural and binding failures throw; every
 * other condition becomes one of the twelve reasons.
 */
export function readHistoricalCandidate(candidate, policy) {
  assertClosedKeys(candidate, CANDIDATE_KEYS_V1, 'CANDIDATE_INPUT_NOT_CLOSED');
  if (candidate.schema !== CANDIDATE_SCHEMA_V1) failClosed('CANDIDATE_SCHEMA_INVALID');
  if (!isExactGovernedString(candidate.candidateKey) || !isExactGovernedString(candidate.p3hKeyId)) {
    failClosed('CANDIDATE_KEY_INVALID');
  }
  if (!isCanonicalSessionDate(candidate.sessionDate)) failClosed('CANDIDATE_SESSION_DATE_INVALID', { candidateKey: candidate.candidateKey });
  if (candidate.knowledgeCutoff !== null && !isCanonicalUtcInstant(candidate.knowledgeCutoff)) {
    failClosed('CANDIDATE_KNOWLEDGE_CUTOFF_INVALID', { candidateKey: candidate.candidateKey });
  }
  const p3hReason = readP3hAdmission(candidate, policy);
  const identity = readHistoricalInstrumentIdentity({ resolution: candidate.instrumentIdentity, sessionDate: candidate.sessionDate });
  const priceBasisId = readPriceBasis(candidate.priceBasisId);
  const featureVectorBinding = readFeatureVectorBinding(candidate.featureVectorBinding, candidate);
  if (featureVectorBinding !== null && identity.matchable && featureVectorBinding.instrumentIdentityId !== identity.instrumentIdentityId) {
    failClosed('CANDIDATE_FEATURE_VECTOR_BINDING_IDENTITY_MISMATCH', { candidateKey: candidate.candidateKey });
  }
  const features = readFeatures(candidate.features, featureVectorBinding);
  if (priceBasisId === null && DISTANCE_FEATURE_IDS_V1.some((featureId) => features.records[featureId] !== null)) {
    failClosed('CANDIDATE_PRICE_BASIS_REQUIRED', { candidateKey: candidate.candidateKey });
  }
  const regime = readRegimeRecord(candidate.regimeRecord, {
    sessionDate: candidate.sessionDate, knowledgeCutoff: candidate.knowledgeCutoff, featureVectorBinding, identity,
  });
  const inputProofs = readInputProofs(candidate.inputProofs);
  return Object.freeze({
    candidateKey: candidate.candidateKey,
    p3hKeyId: candidate.p3hKeyId,
    p3hReason,
    sessionDate: candidate.sessionDate,
    knowledgeCutoff: candidate.knowledgeCutoff,
    identity,
    priceBasisId,
    featureVectorBinding,
    features,
    regime,
    inputProofs,
  });
}

/**
 * Causal proof: every selection/distance input proven at or before the candidate's
 * own K(T_hist) and at or before the applicable query cutoff. Index construction
 * is query-independent and passes Infinity for the query cutoff.
 */
export function historicallyCausal(context, queryKnowledgeCutoffMs) {
  if (context.knowledgeCutoff === null) return false;
  const ownCutoffMs = Date.parse(context.knowledgeCutoff);
  if (ownCutoffMs > queryKnowledgeCutoffMs) return false;
  const proven = new Set(context.inputProofs.map((proof) => proof.inputId));
  if (requiredProofInputIds(context).some((inputId) => !proven.has(inputId))) return false;
  return context.inputProofs.every((proof) => proof.availableAtMs !== null
    && proof.availableAtMs <= ownCutoffMs
    && proof.availableAtMs <= queryKnowledgeCutoffMs);
}

export function evaluateCandidateEligibility({ context, query, policy }) {
  const flags = new Array(ELIGIBILITY_EXCLUSION_REASONS_V1.length).fill(false);
  if (context.p3hReason !== null) flags[REASON[context.p3hReason]] = true;

  const window = policy.historicalObservationWindow;
  if (context.sessionDate < window.startSessionInclusive || context.sessionDate > window.endSessionInclusive
    || !(context.sessionDate < query.sessionDate)) {
    flags[REASON.OUTSIDE_HISTORICAL_WINDOW] = true;
  }
  if (!historicallyCausal(context, query.knowledgeCutoffMs)) flags[REASON.AVAILABLE_AFTER_KNOWLEDGE_CUTOFF] = true;
  if (!context.identity.matchable || context.identity.instrumentIdentityId !== query.identity.instrumentIdentityId) {
    flags[REASON.INSTRUMENT_IDENTITY_MISMATCH] = true;
  }
  if (context.regime !== null && query.regime === null) {
    failClosed('QUERY_REGIME_RECORD_UNAVAILABLE_FOR_REGIME_BEARING_CANDIDATE', { candidateKey: context.candidateKey });
  }
  if (context.regime === null || context.regime.regimeHorizonSpecId !== query.regime.regimeHorizonSpecId) {
    flags[REASON.REGIME_HORIZON_SPEC_MISMATCH] = true;
  }
  const coreMatch = evaluateCoreV1ExactMatch({ queryRegime: query.regime, candidateRegime: context.regime });
  if (!coreMatch.match) flags[REASON.CORE_V1_REGIME_MISMATCH] = true;
  if (context.regime === null || !context.regime.volatilityStateClassifying) {
    flags[REASON.VOLATILITY_STATE_UNAVAILABLE] = true;
  }
  for (const featureId of DISTANCE_FEATURE_IDS_V1) {
    const featureClass = context.features.classes[featureId];
    if (featureClass !== null) flags[REASON[featureClass]] = true;
  }
  const reasons = ELIGIBILITY_EXCLUSION_REASONS_V1.filter((_, index) => flags[index]);
  return Object.freeze({
    candidateKey: context.candidateKey,
    status: reasons.length === 0 ? 'ELIGIBLE' : 'EXCLUDED',
    reasons: Object.freeze(reasons),
    coreV1MatchEvidence: coreMatch.evidence,
  });
}

/**
 * Evaluates the whole candidate universe in one pass. Candidates must arrive in
 * strictly increasing code-unit order of candidateKey, which makes the pass
 * independent of filesystem or producer order and refuses duplicates.
 */
export function evaluateEligibleUniverse({ candidates, query, policy }) {
  const counts = new Array(ELIGIBILITY_EXCLUSION_REASONS_V1.length).fill(0);
  const eligible = [];
  const digest = createHash('sha256');
  let universeCount = 0;
  let excludedCount = 0;
  let previousKey = null;
  for (const candidate of candidates) {
    const context = readHistoricalCandidate(candidate, policy);
    if (previousKey !== null && !(context.candidateKey > previousKey)) {
      failClosed('CANDIDATE_ORDER_NOT_CANONICAL_OR_DUPLICATE', { candidateKey: context.candidateKey });
    }
    previousKey = context.candidateKey;
    const decision = evaluateCandidateEligibility({ context, query, policy });
    digest.update(`${canonicalize({ candidateKey: decision.candidateKey, status: decision.status, reasons: decision.reasons })}\n`);
    universeCount += 1;
    if (decision.status === 'ELIGIBLE') {
      if (context.p3hReason !== null) failClosed('P3H_EXCLUDED_CANDIDATE_REACHED_ELIGIBILITY');
      eligible.push(Object.freeze({ context, decision }));
    } else {
      excludedCount += 1;
      for (const reason of decision.reasons) counts[REASON[reason]] += 1;
    }
  }
  if (universeCount !== eligible.length + excludedCount) failClosed('ELIGIBLE_UNIVERSE_ARITHMETIC_INCONSISTENT');
  return Object.freeze({
    universeCount,
    eligibleCount: eligible.length,
    excludedCount,
    exclusionCountsByReason: Object.freeze(ELIGIBILITY_EXCLUSION_REASONS_V1.map((reasonId, index) => Object.freeze({ reasonId, count: counts[index] }))),
    eligible: Object.freeze(eligible),
    decisionDigest: digest.digest('hex'),
  });
}

/* ----------------------------------------------------------------------- identity */

/** commonFactors: the exact matched CORE_V1 values, in CORE_V1 order. */
export function coreV1Factors(regime) {
  return Object.freeze(CORE_V1_DIMENSIONS_V1.map((dimensionId) => Object.freeze({ dimensionId, value: regime.coreV1[dimensionId] })));
}

/**
 * The eleven OD-3 member values for a query or candidate context. A member that
 * cannot be read from a bound input makes the identity non-formable; no member is
 * ever defaulted.
 */
export function deriveAnalogueIdentityMembers({ context, policy }) {
  const missingMembers = [];
  if (!context.identity.matchable) missingMembers.push('InstrumentIdentityId');
  if (context.knowledgeCutoff === null) missingMembers.push('KnowledgeCutoff');
  if (context.featureVectorBinding === null) missingMembers.push('FeatureVectorBindingId');
  if (context.regime === null) missingMembers.push('RegimeRecordId', 'RegimeHorizonSpecId', 'MacroContextBindingId');
  if (context.priceBasisId === null) missingMembers.push('PriceBasisId');
  if (missingMembers.length > 0) return Object.freeze({ formable: false, missingMembers: Object.freeze(missingMembers), members: null });
  const state = resolveMissingnessState({
    distanceFeaturesComplete: context.features.complete,
    volatilityStateClassifying: context.regime.volatilityStateClassifying,
  });
  return Object.freeze({
    formable: true,
    missingMembers: Object.freeze([]),
    members: Object.freeze({
      InstrumentIdentityId: context.identity.instrumentIdentityId,
      SessionDate: context.sessionDate,
      KnowledgeCutoff: context.knowledgeCutoff,
      FeatureVectorBindingId: context.featureVectorBinding.featureVectorBindingId,
      RegimeRecordId: context.regime.regimeRecordId,
      RegimeHorizonSpecId: context.regime.regimeHorizonSpecId,
      MacroContextBindingId: context.regime.macroContextBindingId,
      SelectionPolicyVersionId: policy.selectionPolicyVersionId,
      EligibleHistoryPinSetId: policy.eligibleHistoryPinSetId,
      PriceBasisId: context.priceBasisId,
      MissingnessStateId: missingnessStateId(state),
    }),
  });
}

export function describeEligibility() {
  return Object.freeze({
    vocabularyId: ELIGIBILITY_VOCABULARY_ID_V1,
    precedence: ELIGIBILITY_EXCLUSION_REASONS_V1,
    p3hClassMapping: P3H_EXCLUSION_CLASS_REASONS_V1,
    coreV1Dimensions: CORE_V1_DIMENSIONS_V1,
    distanceFeatureIds: DISTANCE_FEATURE_IDS_V1,
    candidateSchema: CANDIDATE_SCHEMA_V1,
    querySchema: QUERY_SCHEMA_V1,
    silentCandidateDrop: 'FORBIDDEN',
    outcomeInSelection: 'FORBIDDEN_BY_CLOSED_INPUT_SCHEMA',
  });
}
