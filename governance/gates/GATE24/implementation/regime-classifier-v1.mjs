/**
 * GATE24 deterministic regime classifier, classification quality and classification
 * evidence.
 *
 * The classifier emits RegimeVector(T) from GATE23 FeatureRecords and prepared macro
 * context, both at or before K(T). It produces no prediction, recommendation, Wheel
 * decision, strategy, calibration or probability.
 *
 * Every threshold, weight and window selection resolves to a parameterPath in the
 * bound ParameterSet. There is no inline magic constant: an unresolved reference
 * fails BUILD closed with PARAMETER_NOT_IN_BOUND_PARAMETER_SET.
 *
 * Determinism: no random source, no wall clock, no ambient state. Identical
 * canonical inputs reproduce identical ids and identical classifications.
 */

import { sha256Canonical, canonicalize } from '../../../tools/canonical-json.mjs';
import {
  REGIME_TAXONOMY_VERSION_ID,
  ACTIVE_DIMENSIONS_V1,
  ACTIVE_DIMENSION_NAMES_V1,
  INACTIVE_DIMENSION_NAMES_V1,
  MACRO_FED_DIMENSION_NAMES_V1,
  DIMENSION_TAXONOMY_VERSION_IDS_V1,
  REGIME_DIMENSIONS_V1,
  UNRESOLVABLE_INPUT_REASONS_V1,
  isDeclaredUnresolvableReason,
  resolveDimension,
  assertDeclaredEntry,
  isClassifyingValue,
  isFailClosedValue,
  inactiveDimensionValues,
  mapProducerToken,
  CURVE_SHAPE_PRODUCER_MAP_V1,
  CURVE_DIRECTION_PRODUCER_MAP_V1,
} from './regime-taxonomy-v1.mjs';
import { admitInputAtCutoff } from './causal-admission-v1.mjs';
import { selectVintageAsOf } from './causal-admission-v1.mjs';
import { assertMacroCoverageConsistent } from './macro-context-binding-v1.mjs';

export const CLASSIFIER_VERSION_SCHEMA = 'GATE24_ClassifierVersion/1';
export const PARAMETER_SET_SCHEMA = 'GATE24_ParameterSet/1';
export const CLASSIFICATION_QUALITY_RULE_VERSION = 'GATE24_ClassificationQualityRule/1';
export const CLASSIFICATION_EVIDENCE_SCHEMA_VERSION = 'GATE24_ClassificationEvidence/1';
export const MISSINGNESS_POLICY_VERSION = 'GATE24_MissingnessPolicy/1';
export const REGIME_VECTOR_VERSION_ID = 'REGIME_VECTOR_V1';

export const MISSINGNESS_MODEL = 'DIMENSION_LOCAL_FAIL_CLOSED';

export const CLASSIFICATION_QUALITY_VALUES_V1 = Object.freeze(['COMPLETE', 'PARTIAL', 'INSUFFICIENT', 'CONFLICTING']);
/** Evaluation order, first match wins. */
export const CLASSIFICATION_QUALITY_EVALUATION_ORDER_V1 = Object.freeze(['CONFLICTING', 'INSUFFICIENT', 'PARTIAL', 'COMPLETE']);
export const CONFLICTING_DISPOSITION_V1 = 'NOT_REACHABLE_IN_CORE_V1';

export const CLASSIFIER_REFUSAL_CODES_V1 = Object.freeze({
  parameterMissing: 'PARAMETER_NOT_IN_BOUND_PARAMETER_SET',
  futureEvidence: 'FUTURE_EVIDENCE_FORBIDDEN',
  unexplained: 'INSUFFICIENT_DATA_UNEXPLAINED',
  macroInconsistent: 'MACRO_COVERAGE_DECLARATION_INCONSISTENT',
  probabilityForbidden: 'PROBABILITY_OR_CONFIDENCE_OUTPUT_FORBIDDEN',
});

/** Fields that may never appear in a GATE24 emission or its evidence. */
export const FORBIDDEN_EVIDENCE_FIELDS_V1 = Object.freeze([
  'probability', 'confidence', 'confidencePercentage', 'percentage', 'score', 'weightAsProbability',
  'ticker', 'symbol', 'alias', 'temporaryAlias',
  'OutcomeId', 'OutcomeStatus', 'DatasetId_outcome', 'HorizonId',
]);

/* ------------------------------------------------------------------ ParameterSet */

/**
 * G24-BUILD-10. Parameters are ordered by (dimension asc, parameterName asc) and the
 * identity is EXACT_ONLY over the declared payload.
 */
export function createParameterSet({ parameterSetLabel, regimeVectorVersionId, activeRegimeHorizonSpecIds, parameters }) {
  if (typeof parameterSetLabel !== 'string' || parameterSetLabel.length === 0) throw new Error('PARAMETER_SET_LABEL_REQUIRED');
  if (regimeVectorVersionId !== REGIME_VECTOR_VERSION_ID) throw new Error('REGIME_VECTOR_VERSION_MISMATCH');
  if (!Array.isArray(activeRegimeHorizonSpecIds) || activeRegimeHorizonSpecIds.length === 0) throw new Error('ACTIVE_HORIZON_SPEC_IDS_REQUIRED');
  if (!Array.isArray(parameters) || parameters.length === 0) throw new Error('PARAMETER_SET_EMPTY');
  const ordered = [...parameters]
    .map((parameter) => {
      if (typeof parameter?.dimension !== 'string' || typeof parameter?.parameterName !== 'string'
        || parameter.value === undefined || parameter.value === null) {
        throw new Error('PARAMETER_DECLARATION_INVALID');
      }
      resolveDimension(parameter.dimension);
      return Object.freeze({
        dimension: parameter.dimension,
        parameterName: parameter.parameterName,
        parameterPath: `${parameter.dimension}.${parameter.parameterName}`,
        value: parameter.value,
      });
    })
    .sort((left, right) => (left.dimension === right.dimension
      ? left.parameterName.localeCompare(right.parameterName)
      : left.dimension.localeCompare(right.dimension)));
  const paths = ordered.map((parameter) => parameter.parameterPath);
  if (new Set(paths).size !== paths.length) throw new Error('PARAMETER_PATH_DUPLICATE');
  const payload = {
    schemaVersion: PARAMETER_SET_SCHEMA,
    parameterSetLabel,
    regimeVectorVersionId,
    activeRegimeHorizonSpecIds: [...activeRegimeHorizonSpecIds].sort(),
    parameters: ordered.map((parameter) => ({
      dimension: parameter.dimension,
      parameterName: parameter.parameterName,
      value: parameter.value,
    })),
  };
  return Object.freeze({
    ...payload,
    parameters: Object.freeze(ordered),
    parameterPaths: Object.freeze(paths),
    closureRule: 'EXACT_ONLY',
    parameterSetId: sha256Canonical(payload),
  });
}

/** Every threshold reference goes through here; an unresolved path fails closed. */
export function resolveParameter(parameterSet, dimension, parameterName) {
  const found = parameterSet?.parameters?.find(
    (parameter) => parameter.dimension === dimension && parameter.parameterName === parameterName,
  );
  if (!found) throw new Error(CLASSIFIER_REFUSAL_CODES_V1.parameterMissing);
  return found.value;
}

const parameterPath = (dimension, parameterName) => `${dimension}.${parameterName}`;

/* -------------------------------------------------------------- ClassifierVersion */

/**
 * G24-BUILD-09. ParameterSetId is deliberately NOT an input: a parameter change bumps
 * ParameterSetId only, a taxonomy or dimension change bumps the classifier version,
 * and both remain separate required identity members.
 */
export function createClassifierVersion({ classifierVersionLabel, activeRegimeHorizonSpecIds }) {
  if (typeof classifierVersionLabel !== 'string' || classifierVersionLabel.length === 0) throw new Error('CLASSIFIER_VERSION_LABEL_REQUIRED');
  if (!Array.isArray(activeRegimeHorizonSpecIds) || activeRegimeHorizonSpecIds.length !== 1) {
    throw new Error('CORE_V1_REQUIRES_EXACTLY_ONE_ACTIVE_HORIZON');
  }
  if (activeRegimeHorizonSpecIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id))) {
    throw new Error('ACTIVE_HORIZON_MUST_BE_PINNED_BY_ID');
  }
  const payload = {
    schemaVersion: CLASSIFIER_VERSION_SCHEMA,
    classifierVersionLabel,
    regimeVectorVersionId: REGIME_VECTOR_VERSION_ID,
    /** Ordered over all eleven declared dimensions, active and registered-not-active. */
    dimensionTaxonomyVersionIds: Object.fromEntries(
      [...REGIME_DIMENSIONS_V1]
        .map((item) => [item.name, item.taxonomyVersionId])
        .sort((left, right) => left[0].localeCompare(right[0])),
    ),
    activeRegimeHorizonSpecIds: [...activeRegimeHorizonSpecIds].sort(),
    classificationQualityRuleVersion: CLASSIFICATION_QUALITY_RULE_VERSION,
    classificationEvidenceSchemaVersion: CLASSIFICATION_EVIDENCE_SCHEMA_VERSION,
    missingnessPolicyVersion: MISSINGNESS_POLICY_VERSION,
  };
  return Object.freeze({
    ...payload,
    closureRule: 'EXACT_ONLY',
    parameterSetIdIsInput: false,
    classifierVersionId: sha256Canonical(payload),
  });
}

/* ------------------------------------------------------------ dimension resolution */

const unresolved = (dimensionName, reason) => {
  const spec = resolveDimension(dimensionName);
  if (!isDeclaredUnresolvableReason(reason)) throw new Error('UNRESOLVABLE_REASON_NOT_DECLARED');
  const insufficientReasons = ['PRODUCER_VALUE_NOT_AVAILABLE', 'CORE_INPUT_MISSING', 'MACRO_CONTEXT_ABSENT', 'INSUFFICIENT_HISTORY_IN_WINDOW', 'INPUT_NOT_AVAILABLE_AT_CUTOFF'];
  return Object.freeze({
    value: insufficientReasons.includes(reason) ? spec.insufficientMember : spec.unknownMember,
    classifying: false,
    reason,
  });
};

const resolved = (dimensionName, value) => Object.freeze({
  value: assertDeclaredEntry(dimensionName, value),
  classifying: true,
  reason: null,
});

/** Reads a GATE23 FeatureRecord by member key and maps its status to a reason. */
function readFeatureMember(featureSet, memberKey) {
  const record = featureSet?.records?.find(
    (item) => `${item.featureDefinitionId}@W${item.sessionCount}` === memberKey,
  );
  if (!record) return { record: null, reason: 'CORE_INPUT_MISSING' };
  if (record.status === 'INSUFFICIENT_DATA') return { record, reason: 'INSUFFICIENT_HISTORY_IN_WINDOW' };
  if (record.status !== 'RESOLVED') return { record, reason: 'FEATURE_RECORD_FAIL_CLOSED' };
  if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return { record, reason: 'FEATURE_RECORD_FAIL_CLOSED' };
  return { record, reason: null };
}

function resolvePrimaryMarketRegime({ featureSet, parameterSet }) {
  const dimensionName = 'primaryMarketRegime';
  const trendKey = resolveParameter(parameterSet, dimensionName, 'trendMemberKey');
  const trendShortKey = resolveParameter(parameterSet, dimensionName, 'trendShortMemberKey');
  const drawdownKey = resolveParameter(parameterSet, dimensionName, 'drawdownMemberKey');
  const liquidityKey = resolveParameter(parameterSet, dimensionName, 'liquidityMemberKey');

  const trend = readFeatureMember(featureSet, trendKey);
  if (trend.reason !== null) return { ...unresolved(dimensionName, trend.reason), inputs: { trendKey } };

  const liquidity = readFeatureMember(featureSet, liquidityKey);
  if (liquidity.reason === null
    && liquidity.record.value >= resolveParameter(parameterSet, dimensionName, 'liquidityStressRatioMin')) {
    return { ...resolved(dimensionName, 'LIQUIDITY_STRESS'), inputs: { trendKey, liquidityKey } };
  }
  const drawdown = readFeatureMember(featureSet, drawdownKey);
  if (drawdown.reason === null
    && drawdown.record.value <= resolveParameter(parameterSet, dimensionName, 'crisisDrawdownMax')) {
    return { ...resolved(dimensionName, 'CRISIS'), inputs: { trendKey, drawdownKey } };
  }

  const trendValue = trend.record.value;
  if (Math.abs(trendValue) <= resolveParameter(parameterSet, dimensionName, 'rangeAbsReturnMax')) {
    return { ...resolved(dimensionName, 'RANGE'), inputs: { trendKey } };
  }
  if (trendValue >= resolveParameter(parameterSet, dimensionName, 'bullReturnMin')) {
    return { ...resolved(dimensionName, 'BULL'), inputs: { trendKey } };
  }
  if (trendValue <= resolveParameter(parameterSet, dimensionName, 'bearReturnMax')) {
    return { ...resolved(dimensionName, 'BEAR'), inputs: { trendKey } };
  }
  const trendShort = readFeatureMember(featureSet, trendShortKey);
  if (trendValue < 0 && trendShort.reason === null
    && trendShort.record.value >= resolveParameter(parameterSet, dimensionName, 'recoveryShortReturnMin')) {
    return { ...resolved(dimensionName, 'RECOVERY'), inputs: { trendKey, trendShortKey } };
  }
  return { ...resolved(dimensionName, 'TRANSITION'), inputs: { trendKey } };
}

function resolveVolatilityState({ featureSet, parameterSet }) {
  const dimensionName = 'volatilityState';
  const memberKey = resolveParameter(parameterSet, dimensionName, 'volatilityMemberKey');
  const member = readFeatureMember(featureSet, memberKey);
  if (member.reason !== null) return { ...unresolved(dimensionName, member.reason), inputs: { memberKey } };
  const value = member.record.value;
  if (value <= resolveParameter(parameterSet, dimensionName, 'calmMax')) return { ...resolved(dimensionName, 'CALM'), inputs: { memberKey } };
  if (value <= resolveParameter(parameterSet, dimensionName, 'normalMax')) return { ...resolved(dimensionName, 'NORMAL'), inputs: { memberKey } };
  if (value <= resolveParameter(parameterSet, dimensionName, 'volatileMax')) return { ...resolved(dimensionName, 'VOLATILE'), inputs: { memberKey } };
  return { ...resolved(dimensionName, 'EXTREME'), inputs: { memberKey } };
}

function resolveInflationState({ macroSnapshot, parameterSet }) {
  const dimensionName = 'inflationState';
  const seriesCode = resolveParameter(parameterSet, dimensionName, 'seriesCode');
  if (!macroSnapshot) return { ...unresolved(dimensionName, 'MACRO_CONTEXT_ABSENT'), inputs: { seriesCode } };
  const observation = macroSnapshot.derived?.[seriesCode] ?? macroSnapshot.series?.[seriesCode];
  if (!observation) return { ...unresolved(dimensionName, 'CORE_INPUT_MISSING'), inputs: { seriesCode } };
  if (observation.value === 'NOT_AVAILABLE') return { ...unresolved(dimensionName, 'PRODUCER_VALUE_NOT_AVAILABLE'), inputs: { seriesCode } };
  if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) {
    return { ...unresolved(dimensionName, 'PRODUCER_VALUE_OUT_OF_VOCABULARY'), inputs: { seriesCode } };
  }
  if (observation.value >= resolveParameter(parameterSet, dimensionName, 'inflationaryMin')) {
    return { ...resolved(dimensionName, 'INFLATIONARY'), inputs: { seriesCode } };
  }
  if (observation.value <= resolveParameter(parameterSet, dimensionName, 'disinflationaryMax')) {
    return { ...resolved(dimensionName, 'DISINFLATIONARY'), inputs: { seriesCode } };
  }
  return { ...resolved(dimensionName, 'INFLATION_STABLE'), inputs: { seriesCode } };
}

/**
 * ratesState is DIRECTIONAL, not a level dimension. The direction is measured
 * between two strictly causal vintages: the admissible vintage at the start of the
 * active horizon and the admissible vintage at K(T). Both are at or before K(T).
 */
function resolveRatesState({ macroSnapshot, vintageStore, horizonStartKnowledgeCutoff, parameterSet }) {
  const dimensionName = 'ratesState';
  const seriesCode = resolveParameter(parameterSet, dimensionName, 'seriesCode');
  if (!macroSnapshot) return { ...unresolved(dimensionName, 'MACRO_CONTEXT_ABSENT'), inputs: { seriesCode } };
  const current = macroSnapshot.series?.[seriesCode];
  if (!current) return { ...unresolved(dimensionName, 'CORE_INPUT_MISSING'), inputs: { seriesCode } };
  if (current.value === 'NOT_AVAILABLE') return { ...unresolved(dimensionName, 'PRODUCER_VALUE_NOT_AVAILABLE'), inputs: { seriesCode } };
  if (typeof horizonStartKnowledgeCutoff !== 'string' || horizonStartKnowledgeCutoff.length === 0) {
    return { ...unresolved(dimensionName, 'INSUFFICIENT_HISTORY_IN_WINDOW'), inputs: { seriesCode } };
  }
  const prior = selectVintageAsOf({
    observations: vintageStore?.[seriesCode] ?? [],
    knowledgeCutoff: horizonStartKnowledgeCutoff,
  });
  if (prior.status !== 'RESOLVED' || typeof prior.observation.value !== 'number') {
    return { ...unresolved(dimensionName, 'INSUFFICIENT_HISTORY_IN_WINDOW'), inputs: { seriesCode } };
  }
  if (typeof current.value !== 'number' || !Number.isFinite(current.value)) {
    return { ...unresolved(dimensionName, 'PRODUCER_VALUE_OUT_OF_VOCABULARY'), inputs: { seriesCode } };
  }
  const delta = current.value - prior.observation.value;
  if (delta >= resolveParameter(parameterSet, dimensionName, 'risingDeltaMin')) {
    return { ...resolved(dimensionName, 'RATES_RISING'), inputs: { seriesCode } };
  }
  if (delta <= resolveParameter(parameterSet, dimensionName, 'fallingDeltaMax')) {
    return { ...resolved(dimensionName, 'RATES_FALLING'), inputs: { seriesCode } };
  }
  return { ...resolved(dimensionName, 'RATES_STABLE'), inputs: { seriesCode } };
}

function resolveCurveDimension({ dimensionName, macroSnapshot, parameterSet, producerMap }) {
  const featureCode = resolveParameter(parameterSet, dimensionName, 'producerFeatureCode');
  if (!macroSnapshot) return { ...unresolved(dimensionName, 'MACRO_CONTEXT_ABSENT'), inputs: { featureCode } };
  const observation = macroSnapshot.derived?.[featureCode] ?? macroSnapshot.series?.[featureCode];
  const token = observation?.value;
  const mapped = mapProducerToken({ dimensionName, producerToken: token, producerMap });
  if (!mapped.classifying) {
    return { ...unresolved(dimensionName, mapped.reason), inputs: { featureCode } };
  }
  return { ...resolved(dimensionName, mapped.value), inputs: { featureCode } };
}

/* -------------------------------------------------------- classificationQuality */

/**
 * G24-BUILD-11. Computed over exactly the six ACTIVE_IN_CORE_V1 dimensions. The five
 * REGISTERED_NOT_ACTIVE dimensions are excluded because a classifyingCount of 0 would
 * make COMPLETE unreachable.
 *
 * Evaluation order is CONFLICTING, INSUFFICIENT, PARTIAL, COMPLETE; first match wins.
 * The conditions are mutually exclusive and total over the six dimensions.
 *
 * No probability, confidence percentage or uncalibrated score is emitted.
 */
export function computeClassificationQuality(resolvedByDimension) {
  const values = ACTIVE_DIMENSION_NAMES_V1.map((name) => {
    const value = resolvedByDimension?.[name];
    if (value === undefined) throw new Error('ACTIVE_DIMENSION_RESOLUTION_MISSING');
    assertDeclaredEntry(name, value);
    return { name, value };
  });
  if (isConflictingInCoreV1()) return 'CONFLICTING';
  const primary = values.find((item) => item.name === 'primaryMarketRegime').value;
  if (isFailClosedValue('primaryMarketRegime', primary)) return 'INSUFFICIENT';
  if (values.some((item) => isFailClosedValue(item.name, item.value))) return 'PARTIAL';
  return 'COMPLETE';
}

/**
 * CONFLICTING remains in the closed enumeration with no CORE_V1 trigger, following
 * the mandate's registered-not-active disposition and the GATE23 OPTION_B_SETTLING_AT
 * precedent. Activating a trigger later is additive and requires a classifier bump.
 */
export function isConflictingInCoreV1() {
  return false;
}

export function describeClassificationQualityRule() {
  return Object.freeze({
    schemaVersion: CLASSIFICATION_QUALITY_RULE_VERSION,
    values: CLASSIFICATION_QUALITY_VALUES_V1,
    evaluationOrder: CLASSIFICATION_QUALITY_EVALUATION_ORDER_V1,
    firstMatchWins: true,
    computedOverDimensions: ACTIVE_DIMENSION_NAMES_V1,
    excludedDimensions: INACTIVE_DIMENSION_NAMES_V1,
    exclusionReason: 'classifyingCount 0 would make COMPLETE unreachable',
    conflictingDisposition: CONFLICTING_DISPOSITION_V1,
    alternativeFormCoverageScoreAdopted: false,
    probabilityEmitted: false,
    confidenceEmitted: false,
    uncalibratedScoreEmitted: false,
    isMacroFeatureCompleteness: false,
  });
}

/* ------------------------------------------------------------ classificationEvidence */

/** G24-BUILD-13: exactly nine families, quoted verbatim, in mandate order. */
export const EVIDENCE_FAMILIES_V1 = Object.freeze([
  'trend evidence', 'volatility evidence', 'drawdown evidence', 'liquidity evidence',
  'inflation evidence', 'rates evidence', 'curve evidence', 'macro coverage', 'parameter set used',
]);

/** Dimension attribution is EXACT_ONLY and is a complete cover of the six active dimensions. */
export const EVIDENCE_FAMILY_DIMENSIONS_V1 = Object.freeze({
  'trend evidence': Object.freeze(['primaryMarketRegime']),
  'volatility evidence': Object.freeze(['volatilityState']),
  'drawdown evidence': Object.freeze(['primaryMarketRegime']),
  'liquidity evidence': Object.freeze(['primaryMarketRegime']),
  'inflation evidence': Object.freeze(['inflationState']),
  'rates evidence': Object.freeze(['ratesState']),
  'curve evidence': Object.freeze(['yieldCurveShape', 'yieldCurveDirection']),
  'macro coverage': Object.freeze([...MACRO_FED_DIMENSION_NAMES_V1]),
  'parameter set used': Object.freeze([...ACTIVE_DIMENSION_NAMES_V1]),
});

/**
 * The dimensions a family is the primary input evidence for. A family goes ABSENT
 * when a dimension in its absence scope resolved to a fail-closed member without a
 * supporting item, which is what makes a dimension-local INSUFFICIENT_DATA
 * explainable. "parameter set used" is a declaration family and has no absence scope:
 * the bound ParameterSet is always present.
 */
export const EVIDENCE_FAMILY_ABSENCE_SCOPE_V1 = Object.freeze({
  'trend evidence': Object.freeze(['primaryMarketRegime']),
  'volatility evidence': Object.freeze(['volatilityState']),
  'drawdown evidence': Object.freeze(['primaryMarketRegime']),
  'liquidity evidence': Object.freeze(['primaryMarketRegime']),
  'inflation evidence': Object.freeze(['inflationState']),
  'rates evidence': Object.freeze(['ratesState']),
  'curve evidence': Object.freeze(['yieldCurveShape', 'yieldCurveDirection']),
  'macro coverage': Object.freeze([...MACRO_FED_DIMENSION_NAMES_V1]),
  'parameter set used': Object.freeze([]),
});

export const EVIDENCE_SOURCE_KINDS_V1 = Object.freeze(['FEATURE_RECORD', 'MACRO_CONTEXT_SNAPSHOT', 'PARAMETER_SET']);
export const EVIDENCE_CAUSAL_ADMISSION_CLAIM = 'NO_OUTCOME_OR_FUTURE_PROVENANCE_DEPENDENCY';

const sourceRefFor = (sourceKind, payload) => {
  if (sourceKind === 'FEATURE_RECORD') {
    return { featureRecordId: payload.featureRecordId, featureDefinitionId: payload.featureDefinitionId, featureWindowSpecId: payload.featureWindowSpecId, missingnessStateId: payload.missingnessStateId };
  }
  if (sourceKind === 'MACRO_CONTEXT_SNAPSHOT') {
    return { macroContextBindingId: payload.macroContextBindingId, seriesCode: payload.seriesCode, vintageAvailableAt: payload.vintageAvailableAt };
  }
  return { parameterSetId: payload.parameterSetId, parameterPath: payload.parameterPath };
};

function orderItems(items) {
  return [...items].sort((left, right) => {
    const byDimensions = canonicalize(left.dimensions).localeCompare(canonicalize(right.dimensions));
    if (byDimensions !== 0) return byDimensions;
    const bySourceKind = left.sourceKind.localeCompare(right.sourceKind);
    if (bySourceKind !== 0) return bySourceKind;
    const bySourceRef = canonicalize(left.sourceRef).localeCompare(canonicalize(right.sourceRef));
    if (bySourceRef !== 0) return bySourceRef;
    return left.itemId.localeCompare(right.itemId);
  });
}

/**
 * Builds the ClassificationEvidence for one RegimeRecord.
 *
 * containsFutureData is the literal boolean false AND is independently enforced by
 * asserting max(availableAt) <= knowledgeCutoff, so a mislabelled input is still
 * refused with FUTURE_EVIDENCE_FORBIDDEN.
 */
export function buildClassificationEvidence({ identity, resolutions, itemsByFamily, knowledgeCutoff }) {
  const families = EVIDENCE_FAMILIES_V1.map((family) => {
    const items = orderItems(itemsByFamily[family] ?? []);
    const scope = EVIDENCE_FAMILY_ABSENCE_SCOPE_V1[family];
    const supportedDimensions = new Set(items.flatMap((item) => item.dimensions));
    const unexplained = scope.find((dimensionName) => {
      const value = resolutions[dimensionName]?.value;
      return isFailClosedValue(dimensionName, value) && !supportedDimensions.has(dimensionName);
    });
    const emptyFamily = items.length === 0 && scope.length > 0;
    const absent = unexplained !== undefined || emptyFamily;
    const absenceReason = absent
      ? (resolutions[unexplained]?.reason ?? resolutions[scope[0]]?.reason ?? 'CORE_INPUT_MISSING')
      : null;
    if (absent && !isDeclaredUnresolvableReason(absenceReason)) throw new Error('UNRESOLVABLE_REASON_NOT_DECLARED');
    const entry = {
      family,
      dimensions: [...EVIDENCE_FAMILY_DIMENSIONS_V1[family]],
      status: absent ? 'ABSENT' : 'PRESENT',
      items,
    };
    if (absent) entry.absenceReason = absenceReason;
    return entry;
  });

  const availableAts = families.flatMap((family) => family.items.map((item) => item.availableAt));
  if (availableAts.some((availableAt) => typeof availableAt !== 'string' || availableAt.length === 0)) {
    throw new Error('AVAILABLE_AT_REQUIRED');
  }
  if (availableAts.some((availableAt) => availableAt > knowledgeCutoff)) {
    throw new Error(CLASSIFIER_REFUSAL_CODES_V1.futureEvidence);
  }

  /* Every fail-closed dimension must be explained by at least one attributed family
     carrying status ABSENT and a declared absenceReason. Silent collapse is forbidden. */
  for (const dimensionName of ACTIVE_DIMENSION_NAMES_V1) {
    if (!isFailClosedValue(dimensionName, resolutions[dimensionName].value)) continue;
    const explained = families.some((family) => family.status === 'ABSENT'
      && EVIDENCE_FAMILY_DIMENSIONS_V1[family.family].includes(dimensionName)
      && isDeclaredUnresolvableReason(family.absenceReason));
    if (!explained) throw new Error(CLASSIFIER_REFUSAL_CODES_V1.unexplained);
  }

  const ordered = {
    schemaVersion: CLASSIFICATION_EVIDENCE_SCHEMA_VERSION,
    regimeRecordId: identity.regimeRecordId,
    instrumentIdentityId: identity.InstrumentIdentityId,
    sessionDate: identity.SessionDate,
    knowledgeCutoff: identity.KnowledgeCutoff,
    knowledgeCutoffBoundary: identity.knowledgeCutoffBoundary,
    regimeHorizonSpecId: identity.RegimeHorizonSpecId,
    featureVectorBindingId: identity.FeatureVectorBindingId,
    macroContextBindingId: identity.MacroContextBindingId,
    regimeTaxonomyVersionId: identity.RegimeTaxonomyVersionId,
    classifierVersionId: identity.ClassifierVersionId,
    parameterSetId: identity.ParameterSetId,
    datasetIdFeature: identity.DatasetId_feature,
    missingnessStateId: identity.MissingnessStateId,
    families,
    containsFutureData: false,
  };
  assertNoForbiddenEvidenceField(ordered);
  return Object.freeze({ ...ordered, evidenceSetId: sha256Canonical(ordered) });
}

export function assertNoForbiddenEvidenceField(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 16) return true;
  if (Array.isArray(node)) return node.every((item) => assertNoForbiddenEvidenceField(item, depth + 1));
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_EVIDENCE_FIELDS_V1.includes(key)) throw new Error(CLASSIFIER_REFUSAL_CODES_V1.probabilityForbidden);
    assertNoForbiddenEvidenceField(node[key], depth + 1);
  }
  return true;
}

export function describeClassificationEvidenceSchema() {
  return Object.freeze({
    schemaVersion: CLASSIFICATION_EVIDENCE_SCHEMA_VERSION,
    familyCount: EVIDENCE_FAMILIES_V1.length,
    families: EVIDENCE_FAMILIES_V1,
    familyDimensions: EVIDENCE_FAMILY_DIMENSIONS_V1,
    familyAbsenceScope: EVIDENCE_FAMILY_ABSENCE_SCOPE_V1,
    sourceKinds: EVIDENCE_SOURCE_KINDS_V1,
    causalAdmission: EVIDENCE_CAUSAL_ADMISSION_CLAIM,
    unresolvableInputReasons: UNRESOLVABLE_INPUT_REASONS_V1,
    itemOrdering: 'dimensions asc, sourceKind asc, canonical JSON of sourceRef asc, itemId asc',
    evidenceSetIdRule: 'sha256Canonical of the ordered structure excluding evidenceSetId',
    containsFutureData: false,
    futureEnforcement: 'max(availableAt) <= knowledgeCutoff',
    forbiddenFields: FORBIDDEN_EVIDENCE_FIELDS_V1,
  });
}

/* ------------------------------------------------------------------- classification */

/**
 * Resolves the full eleven-dimension RegimeVector(T).
 *
 * The five registered-but-inactive dimensions emit their fail-closed member only and
 * never block, degrade or fail a CORE_V1 classification. A dimension-local
 * INSUFFICIENT_DATA never collapses the vector: the record is always emitted.
 */
export function classifyRegimeVector({
  featureSet, macroSnapshot, vintageStore, horizonStartKnowledgeCutoff,
  parameterSet, declaredMacroCompleteness,
}) {
  const macroConsistency = assertMacroCoverageConsistent({ declaredCompleteness: declaredMacroCompleteness, snapshot: macroSnapshot });
  if (macroConsistency.status !== 'ALLOWED') throw new Error(macroConsistency.code);

  const resolutions = {
    primaryMarketRegime: resolvePrimaryMarketRegime({ featureSet, parameterSet }),
    volatilityState: resolveVolatilityState({ featureSet, parameterSet }),
    inflationState: resolveInflationState({ macroSnapshot, parameterSet }),
    ratesState: resolveRatesState({ macroSnapshot, vintageStore, horizonStartKnowledgeCutoff, parameterSet }),
    yieldCurveShape: resolveCurveDimension({ dimensionName: 'yieldCurveShape', macroSnapshot, parameterSet, producerMap: CURVE_SHAPE_PRODUCER_MAP_V1 }),
    yieldCurveDirection: resolveCurveDimension({ dimensionName: 'yieldCurveDirection', macroSnapshot, parameterSet, producerMap: CURVE_DIRECTION_PRODUCER_MAP_V1 }),
  };

  const activeValues = Object.fromEntries(
    ACTIVE_DIMENSION_NAMES_V1.map((name) => [name, resolutions[name].value]),
  );
  const regimeVector = Object.freeze({ ...activeValues, ...inactiveDimensionValues() });
  const classificationQuality = computeClassificationQuality(activeValues);

  return Object.freeze({
    schemaVersion: REGIME_VECTOR_VERSION_ID,
    regimeVector,
    resolutions: Object.freeze(resolutions),
    classificationQuality,
    classificationQualityRuleVersion: CLASSIFICATION_QUALITY_RULE_VERSION,
    dimensionCount: Object.keys(regimeVector).length,
    activeDimensionCount: ACTIVE_DIMENSION_NAMES_V1.length,
    inactiveDimensionCount: INACTIVE_DIMENSION_NAMES_V1.length,
    cartesianLabel: null,
  });
}

/** Evidence item builders, used by the store to assemble itemsByFamily. */
export function featureEvidenceItem({ itemId, dimensions, record, resolvedValues }) {
  return Object.freeze({
    itemId,
    dimensions: Object.freeze([...dimensions].sort()),
    sourceKind: 'FEATURE_RECORD',
    sourceRef: Object.freeze(sourceRefFor('FEATURE_RECORD', record)),
    availableAt: record.availableAt,
    causalAdmission: EVIDENCE_CAUSAL_ADMISSION_CLAIM,
    supports: Object.freeze(dimensions.map((name) => assertDeclaredEntry(name, resolvedValues[name]))),
  });
}

export function macroEvidenceItem({ itemId, dimensions, macroContextBindingId, seriesCode, vintageAvailableAt, resolvedValues }) {
  return Object.freeze({
    itemId,
    dimensions: Object.freeze([...dimensions].sort()),
    sourceKind: 'MACRO_CONTEXT_SNAPSHOT',
    sourceRef: Object.freeze(sourceRefFor('MACRO_CONTEXT_SNAPSHOT', { macroContextBindingId, seriesCode, vintageAvailableAt })),
    availableAt: vintageAvailableAt,
    causalAdmission: EVIDENCE_CAUSAL_ADMISSION_CLAIM,
    supports: Object.freeze(dimensions.map((name) => assertDeclaredEntry(name, resolvedValues[name]))),
  });
}

export function parameterEvidenceItem({ itemId, dimensions, parameterSetId, dimension, parameterName, availableAt, resolvedValues }) {
  return Object.freeze({
    itemId,
    dimensions: Object.freeze([...dimensions].sort()),
    sourceKind: 'PARAMETER_SET',
    sourceRef: Object.freeze(sourceRefFor('PARAMETER_SET', { parameterSetId, parameterPath: parameterPath(dimension, parameterName) })),
    availableAt,
    causalAdmission: EVIDENCE_CAUSAL_ADMISSION_CLAIM,
    supports: Object.freeze(dimensions.map((name) => assertDeclaredEntry(name, resolvedValues[name]))),
  });
}

export function describeClassifier() {
  return Object.freeze({
    classifierVersionSchema: CLASSIFIER_VERSION_SCHEMA,
    parameterSetSchema: PARAMETER_SET_SCHEMA,
    regimeVectorVersionId: REGIME_VECTOR_VERSION_ID,
    regimeTaxonomyVersionId: REGIME_TAXONOMY_VERSION_ID,
    missingnessPolicyVersion: MISSINGNESS_POLICY_VERSION,
    missingnessModel: MISSINGNESS_MODEL,
    dimensionTaxonomyVersionIds: DIMENSION_TAXONOMY_VERSION_IDS_V1,
    activeDimensions: ACTIVE_DIMENSION_NAMES_V1,
    inactiveDimensions: INACTIVE_DIMENSION_NAMES_V1,
    inlineConstantsPresent: false,
    networkAccess: 'NONE',
    wallClockAsInput: 'NONE',
    outcomeAccess: 'NONE',
    produces: Object.freeze(['RegimeVector(T)', 'classificationQuality', 'classificationEvidence']),
    doesNotProduce: Object.freeze(['prediction', 'recommendation', 'Wheel decision', 'strategy', 'calibration', 'probability']),
    refusalCodes: CLASSIFIER_REFUSAL_CODES_V1,
  });
}

export { ACTIVE_DIMENSION_NAMES_V1, INACTIVE_DIMENSION_NAMES_V1, isClassifyingValue, isFailClosedValue };
