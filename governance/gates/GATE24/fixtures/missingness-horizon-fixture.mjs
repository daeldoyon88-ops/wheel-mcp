/**
 * GATE24 missingness and horizon fixture.
 *
 * FIXTURE SCOPE ONLY. Supplies the bound classifier surface used across the test
 * suites, plus the feature and macro shapes that exercise DIMENSION_LOCAL_FAIL_CLOSED
 * and the horizon identity differential.
 *
 * The horizon spec built here is BUILD-scoped: it is derived from a fixture calendar
 * binding and is never a production RegimeHorizonSpecId.
 */

import { createRegimeHorizonSpec, createActiveRegimeHorizonSpec } from '../implementation/regime-horizon-v1.mjs';
import { createParameterSet, createClassifierVersion } from '../implementation/regime-classifier-v1.mjs';
import { createMacroContextBinding, createMacroSnapshotCache, createMacroBudgetMeter } from '../implementation/macro-context-binding-v1.mjs';
import { createFeatureVectorBinding } from '../implementation/regime-identity-v1.mjs';
import { emitRegimeRecord } from '../implementation/regime-store-v1.mjs';
import {
  FIXTURE_CALENDAR_WINDOW_BINDING,
  FIXTURE_ALTERNATE_CALENDAR_WINDOW_BINDING,
  FIXTURE_MACRO_VINTAGE_SET_MANIFEST_ID,
  FIXTURE_MACRO_DATASET_SNAPSHOT_MANIFEST_ID,
  FIXTURE_AVAILABLE_AT_POLICY_ID,
  FIXTURE_INSTRUMENT_IDENTITY_ID,
  FIXTURE_DATASET_ID_FEATURE,
  ANCHOR_SESSION_DATE,
  ANCHOR_KNOWLEDGE_CUTOFF,
  HORIZON_START_KNOWLEDGE_CUTOFF,
  COMPLETE_FEATURE_VALUES,
  buildFeatureSet,
  buildMacroVintageStore,
  MACRO_VINTAGE_STORE,
} from './vintage-causality-fixture.mjs';

export const FIXTURE_SCOPE = 'GATE24_FIXTURE_ONLY';
export const KNOWLEDGE_CUTOFF_BOUNDARY = 'PINNED_CANONICAL_SESSION_CLOSE_UTC';

/** BUILD-scoped active horizon: 21 sessions over a FIXTURE calendar binding. */
export const FIXTURE_ACTIVE_HORIZON_SPEC = createActiveRegimeHorizonSpec({
  calendarWindowBindingId: FIXTURE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId,
});

/** Same session count, different calendar binding: a different horizon identity. */
export const FIXTURE_ALTERNATE_HORIZON_SPEC = createRegimeHorizonSpec({
  sessionCount: 21,
  calendarWindowBindingId: FIXTURE_ALTERNATE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId,
});

/** A deferred horizon, materialized only to prove the identity differential. */
export const FIXTURE_DEFERRED_HORIZON_SPEC = createRegimeHorizonSpec({
  sessionCount: 63,
  calendarWindowBindingId: FIXTURE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId,
});

export const ACTIVE_REGIME_HORIZON_SPEC_IDS = Object.freeze([FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId]);

/**
 * The CORE_V1 parameter set. Every threshold, weight and window selection used by a
 * dimension decision procedure appears here; the classifier holds no inline constant.
 */
export const PARAMETER_SET = createParameterSet({
  parameterSetLabel: 'GATE24_CORE_V1_PARAMETER_SET',
  regimeVectorVersionId: 'REGIME_VECTOR_V1',
  activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS,
  parameters: [
    { dimension: 'primaryMarketRegime', parameterName: 'trendMemberKey', value: 'F1_SIMPLE_RETURN@W21' },
    { dimension: 'primaryMarketRegime', parameterName: 'trendShortMemberKey', value: 'F1_SIMPLE_RETURN@W5' },
    { dimension: 'primaryMarketRegime', parameterName: 'drawdownMemberKey', value: 'F3_MAX_DRAWDOWN@W21' },
    { dimension: 'primaryMarketRegime', parameterName: 'liquidityMemberKey', value: 'F4_RELATIVE_VOLUME@W21' },
    { dimension: 'primaryMarketRegime', parameterName: 'bullReturnMin', value: 0.05 },
    { dimension: 'primaryMarketRegime', parameterName: 'bearReturnMax', value: -0.05 },
    { dimension: 'primaryMarketRegime', parameterName: 'rangeAbsReturnMax', value: 0.02 },
    { dimension: 'primaryMarketRegime', parameterName: 'crisisDrawdownMax', value: -0.2 },
    { dimension: 'primaryMarketRegime', parameterName: 'liquidityStressRatioMin', value: 3 },
    { dimension: 'primaryMarketRegime', parameterName: 'recoveryShortReturnMin', value: 0.03 },
    { dimension: 'volatilityState', parameterName: 'volatilityMemberKey', value: 'F2_REALIZED_VOLATILITY@W21' },
    { dimension: 'volatilityState', parameterName: 'calmMax', value: 0.1 },
    { dimension: 'volatilityState', parameterName: 'normalMax', value: 0.2 },
    { dimension: 'volatilityState', parameterName: 'volatileMax', value: 0.35 },
    { dimension: 'inflationState', parameterName: 'seriesCode', value: 'cpiYoY' },
    { dimension: 'inflationState', parameterName: 'inflationaryMin', value: 0.03 },
    { dimension: 'inflationState', parameterName: 'disinflationaryMax', value: 0.02 },
    { dimension: 'ratesState', parameterName: 'seriesCode', value: 'US.TREAS.DGS10' },
    { dimension: 'ratesState', parameterName: 'risingDeltaMin', value: 0.001 },
    { dimension: 'ratesState', parameterName: 'fallingDeltaMax', value: -0.001 },
    { dimension: 'yieldCurveShape', parameterName: 'producerFeatureCode', value: 'curveShape' },
    { dimension: 'yieldCurveDirection', parameterName: 'producerFeatureCode', value: 'curveDirection' },
  ],
});

/** A parameter set differing only in one threshold: a new ParameterSetId, same classifier. */
export const ALTERNATE_PARAMETER_SET = createParameterSet({
  parameterSetLabel: 'GATE24_CORE_V1_PARAMETER_SET',
  regimeVectorVersionId: 'REGIME_VECTOR_V1',
  activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS,
  parameters: PARAMETER_SET.parameters.map((parameter) => (parameter.parameterName === 'bullReturnMin'
    ? { dimension: parameter.dimension, parameterName: parameter.parameterName, value: 0.06 }
    : { dimension: parameter.dimension, parameterName: parameter.parameterName, value: parameter.value })),
});

export const CLASSIFIER_VERSION = createClassifierVersion({
  classifierVersionLabel: 'GATE24_CORE_V1_CLASSIFIER',
  activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS,
});

export const MACRO_CONTEXT_BINDING = createMacroContextBinding({
  macroVintageSetManifestId: FIXTURE_MACRO_VINTAGE_SET_MANIFEST_ID,
  macroDatasetSnapshotManifestId: FIXTURE_MACRO_DATASET_SNAPSHOT_MANIFEST_ID,
  availableAtPolicyId: FIXTURE_AVAILABLE_AT_POLICY_ID,
});

/** A different macro vintage, same market features: a different RegimeRecordId. */
export const ALTERNATE_MACRO_CONTEXT_BINDING = createMacroContextBinding({
  macroVintageSetManifestId: `sha256:${'d3'.repeat(32)}`,
  macroDatasetSnapshotManifestId: FIXTURE_MACRO_DATASET_SNAPSHOT_MANIFEST_ID,
  availableAtPolicyId: FIXTURE_AVAILABLE_AT_POLICY_ID,
});

/**
 * Emits one fixture RegimeRecord end to end. `overrides` steers the feature and
 * macro shapes so a single helper covers the complete, partial, insufficient and
 * horizon-differential cases without duplicating wiring.
 */
export function emitFixtureRecord({
  sessionDate = ANCHOR_SESSION_DATE,
  knowledgeCutoff = ANCHOR_KNOWLEDGE_CUTOFF,
  featureValues = COMPLETE_FEATURE_VALUES,
  missing = [],
  insufficient = [],
  vintageStore = MACRO_VINTAGE_STORE,
  regimeHorizonSpec = FIXTURE_ACTIVE_HORIZON_SPEC,
  macroContextBinding = MACRO_CONTEXT_BINDING,
  parameterSet = PARAMETER_SET,
  classifierVersion = CLASSIFIER_VERSION,
  meter = createMacroBudgetMeter(),
  cache = createMacroSnapshotCache(),
  declaredMacroCompleteness = undefined,
  calendarWindowBindingIdOverrides = {},
} = {}) {
  const featureSet = buildFeatureSet({
    sessionDate,
    knowledgeCutoff,
    values: featureValues,
    missing,
    insufficient,
    calendarWindowBindingIdOverrides,
  });
  const featureVectorBinding = createFeatureVectorBinding({ featureSet });
  const snapshot = cache.resolve({ macroContextBinding, vintageStore, knowledgeCutoff, meter });
  return emitRegimeRecord({
    instrumentIdentityId: FIXTURE_INSTRUMENT_IDENTITY_ID,
    sessionDate,
    knowledgeCutoff,
    knowledgeCutoffBoundary: KNOWLEDGE_CUTOFF_BOUNDARY,
    regimeHorizonSpec,
    featureVectorBinding,
    macroContextBinding,
    macroSnapshot: snapshot.snapshot,
    vintageStore,
    horizonStartKnowledgeCutoff: HORIZON_START_KNOWLEDGE_CUTOFF,
    classifierVersion,
    parameterSet,
    featureSet,
    datasetIdFeature: FIXTURE_DATASET_ID_FEATURE,
    declaredMacroCompleteness,
  });
}

/** Feature shapes exercising DIMENSION_LOCAL_FAIL_CLOSED, one dimension at a time. */
export const MISSINGNESS_CASES = Object.freeze([
  Object.freeze({
    caseId: 'VOLATILITY_INPUT_MISSING',
    missing: ['F2_REALIZED_VOLATILITY@W21'],
    dimension: 'volatilityState',
    expectedValue: 'INSUFFICIENT_DATA',
    expectedQuality: 'PARTIAL',
  }),
  Object.freeze({
    caseId: 'VOLATILITY_INSUFFICIENT_HISTORY',
    insufficient: ['F2_REALIZED_VOLATILITY@W21'],
    dimension: 'volatilityState',
    expectedValue: 'INSUFFICIENT_DATA',
    expectedQuality: 'PARTIAL',
  }),
  Object.freeze({
    caseId: 'PRIMARY_TREND_MISSING',
    missing: ['F1_SIMPLE_RETURN@W21'],
    dimension: 'primaryMarketRegime',
    expectedValue: 'REGIME_INSUFFICIENT_DATA',
    expectedQuality: 'INSUFFICIENT',
  }),
]);

/** Macro shapes that resolve the four macro-fed dimensions to their own fail-closed members. */
export const MACRO_ABSENCE_STORE = Object.freeze({});
export const CURVE_NOT_AVAILABLE_STORE = buildMacroVintageStore({ curveShape: 'NOT_AVAILABLE', curveDirection: 'NOT_AVAILABLE' });
export const CURVE_OUT_OF_VOCABULARY_STORE = buildMacroVintageStore({ curveShape: 'BANANA', curveDirection: 'BANANA' });
export const CURVE_PRESERVED_TOKEN_STORE = buildMacroVintageStore({ curveShape: 'PARTIALLY_INVERTED', curveDirection: 'FLATTENING' });
export const CURVE_MIXED_STORE = buildMacroVintageStore({ curveShape: 'MIXED', curveDirection: 'MIXED' });
export const CURVE_INVERTED_STEEPENING_STORE = buildMacroVintageStore({ curveShape: 'INVERTED', curveDirection: 'STEEPENING' });

export { buildFeatureSet, buildMacroVintageStore, ANCHOR_SESSION_DATE, ANCHOR_KNOWLEDGE_CUTOFF, HORIZON_START_KNOWLEDGE_CUTOFF, COMPLETE_FEATURE_VALUES };
