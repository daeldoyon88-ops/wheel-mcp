/**
 * GATE24 regime record emission and persistence.
 *
 * Append-only and keyed by RegimeRecordId. Replaying an identical emission is
 * idempotent; a divergent emission under the same key is refused, so a later macro
 * vintage revision can never rewrite an emitted RegimeRecord.
 *
 * No opaque regime is emitted: every record carries its full provenance, its
 * classification evidence and its declared missingness state.
 *
 * Omitting a session in scope is a defect, never an implicit non-classification.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  createRegimeRecordId,
  regimeRecordIdentityTuple,
  REGIME_RECORD_ID_MEMBERS_V1,
} from './regime-identity-v1.mjs';
import {
  REGIME_TAXONOMY_VERSION_ID,
  ACTIVE_DIMENSION_NAMES_V1,
  INACTIVE_DIMENSION_NAMES_V1,
  MACRO_FED_DIMENSION_NAMES_V1,
  isFailClosedValue,
} from './regime-taxonomy-v1.mjs';
import {
  classifyRegimeVector,
  buildClassificationEvidence,
  resolveParameter,
  featureEvidenceItem,
  macroEvidenceItem,
  parameterEvidenceItem,
  MISSINGNESS_POLICY_VERSION,
  MISSINGNESS_MODEL,
} from './regime-classifier-v1.mjs';

export const REGIME_STORE_VERSION = 'GATE24_RegimeStore/1';
export const REGIME_RECORD_VERSION = 'GATE24_RegimeRecord/1';
export const MISSINGNESS_STATE_VERSION = 'GATE24_MissingnessState/1';

export const MISSINGNESS_STATES_V1 = Object.freeze({
  COMPLETE: 'COMPLETE',
  DIMENSION_LOCAL_INSUFFICIENT: 'DIMENSION_LOCAL_INSUFFICIENT',
  PRIMARY_INSUFFICIENT: 'PRIMARY_INSUFFICIENT',
});

export const missingnessStateId = (state) => `${MISSINGNESS_STATE_VERSION}:${state}`;

export const REGIME_STORE_POLICY = Object.freeze({
  append: 'APPEND_ONLY',
  key: 'RegimeRecordId',
  identicalReplay: 'IDEMPOTENT',
  divergentReplayUnderSameKey: 'REFUSED',
  historicalRewriteOnMacroRevision: 'FORBIDDEN',
  outcomeRecords: 'FORBIDDEN',
  silentSessionOmission: 'FORBIDDEN',
});

/** DIMENSION_LOCAL_FAIL_CLOSED: a dimension-local failure never collapses the vector. */
export function resolveMissingnessState(activeValues) {
  if (isFailClosedValue('primaryMarketRegime', activeValues.primaryMarketRegime)) {
    return MISSINGNESS_STATES_V1.PRIMARY_INSUFFICIENT;
  }
  return ACTIVE_DIMENSION_NAMES_V1.some((name) => isFailClosedValue(name, activeValues[name]))
    ? MISSINGNESS_STATES_V1.DIMENSION_LOCAL_INSUFFICIENT
    : MISSINGNESS_STATES_V1.COMPLETE;
}

function featureMemberByKey(featureSet, memberKey) {
  return featureSet?.records?.find((item) => `${item.featureDefinitionId}@W${item.sessionCount}` === memberKey) ?? null;
}

/**
 * Assembles itemsByFamily for one record.
 *
 * A PARAMETER_SET item is a declared artifact rather than an observation: its
 * availableAt is the classifier binding instant K(T), which satisfies the
 * availableAt <= K(T) bound exactly.
 */
function collectEvidenceItems({ featureSet, macroSnapshot, parameterSet, classification, knowledgeCutoff }) {
  const values = Object.fromEntries(ACTIVE_DIMENSION_NAMES_V1.map((name) => [name, classification.regimeVector[name]]));
  const items = Object.fromEntries([
    'trend evidence', 'volatility evidence', 'drawdown evidence', 'liquidity evidence',
    'inflation evidence', 'rates evidence', 'curve evidence', 'macro coverage', 'parameter set used',
  ].map((family) => [family, []]));

  const featureFamilies = [
    { family: 'trend evidence', dimension: 'primaryMarketRegime', parameterName: 'trendMemberKey' },
    { family: 'trend evidence', dimension: 'primaryMarketRegime', parameterName: 'trendShortMemberKey' },
    { family: 'drawdown evidence', dimension: 'primaryMarketRegime', parameterName: 'drawdownMemberKey' },
    { family: 'liquidity evidence', dimension: 'primaryMarketRegime', parameterName: 'liquidityMemberKey' },
    { family: 'volatility evidence', dimension: 'volatilityState', parameterName: 'volatilityMemberKey' },
  ];
  for (const entry of featureFamilies) {
    const memberKey = resolveParameter(parameterSet, entry.dimension, entry.parameterName);
    const record = featureMemberByKey(featureSet, memberKey);
    if (!record || record.status !== 'RESOLVED') continue;
    if (isFailClosedValue(entry.dimension, values[entry.dimension])) continue;
    items[entry.family].push(featureEvidenceItem({
      itemId: `${entry.family.replace(/ /g, '_')}:${memberKey}`,
      dimensions: [entry.dimension],
      record: {
        featureRecordId: record.featureRecordId,
        featureDefinitionId: record.featureDefinitionId,
        featureWindowSpecId: record.featureWindowSpecId,
        missingnessStateId: record.missingnessStateId,
        availableAt: featureSet.knowledgeCutoff,
      },
      resolvedValues: values,
    }));
  }

  const macroFamilies = [
    { family: 'inflation evidence', dimension: 'inflationState', parameterName: 'seriesCode' },
    { family: 'rates evidence', dimension: 'ratesState', parameterName: 'seriesCode' },
    { family: 'curve evidence', dimension: 'yieldCurveShape', parameterName: 'producerFeatureCode' },
    { family: 'curve evidence', dimension: 'yieldCurveDirection', parameterName: 'producerFeatureCode' },
  ];
  for (const entry of macroFamilies) {
    if (!macroSnapshot) continue;
    if (isFailClosedValue(entry.dimension, values[entry.dimension])) continue;
    const seriesCode = resolveParameter(parameterSet, entry.dimension, entry.parameterName);
    const observation = macroSnapshot.derived?.[seriesCode] ?? macroSnapshot.series?.[seriesCode];
    if (!observation) continue;
    items[entry.family].push(macroEvidenceItem({
      itemId: `${entry.family.replace(/ /g, '_')}:${entry.dimension}:${seriesCode}`,
      dimensions: [entry.dimension],
      macroContextBindingId: macroSnapshot.macroContextBindingId,
      seriesCode,
      vintageAvailableAt: observation.vintageAvailableAt ?? observation.availableAt,
      resolvedValues: values,
    }));
  }

  /* macro coverage carries one item per macro-fed dimension that actually resolved,
     so a partially covered macro perimeter is explainable dimension by dimension. */
  for (const dimensionName of MACRO_FED_DIMENSION_NAMES_V1) {
    if (!macroSnapshot || isFailClosedValue(dimensionName, values[dimensionName])) continue;
    items['macro coverage'].push(macroEvidenceItem({
      itemId: `macro_coverage:${dimensionName}`,
      dimensions: [dimensionName],
      macroContextBindingId: macroSnapshot.macroContextBindingId,
      seriesCode: `MACRO_FEATURE_COMPLETENESS:${macroSnapshot.macroFeatureCompleteness}`,
      vintageAvailableAt: macroSnapshot.knowledgeCutoff,
      resolvedValues: values,
    }));
  }

  for (const parameter of parameterSet.parameters) {
    if (!ACTIVE_DIMENSION_NAMES_V1.includes(parameter.dimension)) continue;
    items['parameter set used'].push(parameterEvidenceItem({
      itemId: `parameter_set_used:${parameter.parameterPath}`,
      dimensions: [parameter.dimension],
      parameterSetId: parameterSet.parameterSetId,
      dimension: parameter.dimension,
      parameterName: parameter.parameterName,
      availableAt: knowledgeCutoff,
      resolvedValues: values,
    }));
  }
  return items;
}

/**
 * Emits one RegimeRecord(T). The record is always emitted: a dimension-local
 * INSUFFICIENT_DATA is recorded, never used as a reason to omit the session.
 */
export function emitRegimeRecord({
  instrumentIdentityId, sessionDate, knowledgeCutoff, knowledgeCutoffBoundary,
  regimeHorizonSpec, featureVectorBinding, macroContextBinding, macroSnapshot,
  vintageStore, horizonStartKnowledgeCutoff, classifierVersion, parameterSet,
  featureSet, datasetIdFeature, declaredMacroCompleteness,
}) {
  const classification = classifyRegimeVector({
    featureSet, macroSnapshot, vintageStore, horizonStartKnowledgeCutoff,
    parameterSet, declaredMacroCompleteness,
  });
  const activeValues = Object.fromEntries(ACTIVE_DIMENSION_NAMES_V1.map((name) => [name, classification.regimeVector[name]]));
  const state = resolveMissingnessState(activeValues);

  const identity = {
    InstrumentIdentityId: instrumentIdentityId,
    SessionDate: sessionDate,
    KnowledgeCutoff: knowledgeCutoff,
    RegimeHorizonSpecId: regimeHorizonSpec.regimeHorizonSpecId,
    FeatureVectorBindingId: featureVectorBinding.featureVectorBindingId,
    MacroContextBindingId: macroContextBinding.macroContextBindingId,
    RegimeTaxonomyVersionId: REGIME_TAXONOMY_VERSION_ID,
    ClassifierVersionId: classifierVersion.classifierVersionId,
    ParameterSetId: parameterSet.parameterSetId,
    DatasetId_feature: datasetIdFeature,
    MissingnessStateId: missingnessStateId(state),
  };
  const regimeRecordId = createRegimeRecordId(identity);

  const evidence = buildClassificationEvidence({
    identity: { ...identity, regimeRecordId, knowledgeCutoffBoundary },
    resolutions: classification.resolutions,
    itemsByFamily: collectEvidenceItems({ featureSet, macroSnapshot, parameterSet, classification, knowledgeCutoff }),
    knowledgeCutoff,
  });

  return Object.freeze({
    schemaVersion: REGIME_RECORD_VERSION,
    regimeRecordId,
    identity: Object.freeze({ ...identity }),
    identityTuple: regimeRecordIdentityTuple(identity),
    identityMemberCount: REGIME_RECORD_ID_MEMBERS_V1.length,
    ...identity,
    knowledgeCutoffBoundary,
    regimeVector: classification.regimeVector,
    classificationQuality: classification.classificationQuality,
    classificationEvidence: evidence,
    evidenceSetId: evidence.evidenceSetId,
    missingnessState: state,
    missingnessStateId: missingnessStateId(state),
    missingnessPolicyVersion: MISSINGNESS_POLICY_VERSION,
    missingnessModel: MISSINGNESS_MODEL,
    macroFeatureCompleteness: macroSnapshot?.macroFeatureCompleteness ?? 'UNAVAILABLE',
    activeDimensions: ACTIVE_DIMENSION_NAMES_V1,
    inactiveDimensions: INACTIVE_DIMENSION_NAMES_V1,
  });
}

const contentDigest = (record) => sha256Canonical({
  regimeRecordId: record.regimeRecordId,
  identity: record.identity,
  regimeVector: record.regimeVector,
  classificationQuality: record.classificationQuality,
  evidenceSetId: record.evidenceSetId,
  missingnessStateId: record.missingnessStateId,
});

export function createRegimeStore() {
  return Object.freeze({ schemaVersion: REGIME_STORE_VERSION, records: Object.freeze([]) });
}

function assertStorableRecord(record) {
  if (!record || typeof record.regimeRecordId !== 'string' || !/^[0-9a-f]{64}$/.test(record.regimeRecordId)) {
    throw new Error('REGIME_RECORD_ID_INVALID');
  }
  if (!record.identity || REGIME_RECORD_ID_MEMBERS_V1.some((member) => typeof record.identity[member] !== 'string')) {
    throw new Error('REGIME_RECORD_IDENTITY_INVALID');
  }
  if (record.classificationEvidence?.containsFutureData !== false) throw new Error('FUTURE_EVIDENCE_FORBIDDEN');
}

export function appendRegimeRecord(store, record) {
  if (store?.schemaVersion !== REGIME_STORE_VERSION) throw new Error('REGIME_STORE_INVALID');
  assertStorableRecord(record);
  const existing = store.records.find((item) => item.regimeRecordId === record.regimeRecordId);
  if (existing) {
    if (contentDigest(existing) === contentDigest(record)) return store;
    throw new Error('REGIME_STORE_RESTATEMENT_CONFLICT');
  }
  return Object.freeze({
    schemaVersion: REGIME_STORE_VERSION,
    records: Object.freeze([...store.records, Object.freeze(record)]),
  });
}

export function appendRegimeRecords(store, records) {
  return records.reduce(appendRegimeRecord, store);
}

export function readRegimeRecord(store, regimeRecordId) {
  return store.records.find((item) => item.regimeRecordId === regimeRecordId) ?? null;
}

export function storeDigest(store) {
  return sha256Canonical(store.records.map(contentDigest));
}

/**
 * V-13 coverage: every session declared in scope must carry a record. A gap is a
 * defect, reported explicitly, never an implicit non-classification.
 */
export function assertSessionCoverage({ store, scopeSessionDates, instrumentIdentityId, regimeHorizonSpecId }) {
  const covered = new Set(store.records
    .filter((record) => record.InstrumentIdentityId === instrumentIdentityId
      && record.RegimeHorizonSpecId === regimeHorizonSpecId)
    .map((record) => record.SessionDate));
  const missing = scopeSessionDates.filter((sessionDate) => !covered.has(sessionDate));
  return Object.freeze({
    status: missing.length === 0 ? 'COMPLETE' : 'DEFECT',
    code: missing.length === 0 ? null : 'SESSION_OMITTED_FROM_SCOPE',
    scopeSessionCount: scopeSessionDates.length,
    coveredSessionCount: scopeSessionDates.length - missing.length,
    missingSessionDates: Object.freeze(missing),
  });
}

export function describeRegimeStore() {
  return Object.freeze({
    schemaVersion: REGIME_STORE_VERSION,
    recordVersion: REGIME_RECORD_VERSION,
    missingnessStateVersion: MISSINGNESS_STATE_VERSION,
    missingnessStates: MISSINGNESS_STATES_V1,
    policy: REGIME_STORE_POLICY,
    opaqueRegimeEmitted: false,
  });
}
