/**
 * GATE24 hostile matrix tests.
 *
 * Binds the ALREADY-FROZEN GATE24 hostile matrix: the thirty validationExpectations
 * V-1 through V-30 of GATE24_CANONICAL_MANDATE_R0. No second matrix is invented and
 * no case is redesigned. Every case is bound to an executable proof; a declarative
 * PASS is not admitted.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  admitInputAtCutoff,
  admitMacroVintage,
  selectVintageAsOf,
  refuseSubstitution,
  assertAdmissibleCutoffDerivation,
  resolveKnowledgeCutoff,
  FORBIDDEN_WALL_CLOCK_CONSTANTS,
  FORBIDDEN_CUTOFF_PRIMITIVE,
} from '../implementation/causal-admission-v1.mjs';
import {
  createRegimeHorizonSpec,
  resolveCalendarWindowBindingIdFromFeatureSet,
  resolveProductionCalendarWindowBinding,
  admitProductionCalendarWindowBinding,
  isFixtureCalendarNamespace,
  bindConsumerHorizon,
  refuseImplicitHorizon,
  describeRegimeHorizonArchitecture,
  CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS,
} from '../implementation/regime-horizon-v1.mjs';
import {
  refuseCartesianLabel,
  assertDeclaredEntry,
  mapProducerToken,
  CURVE_SHAPE_PRODUCER_MAP_V1,
  CURVE_DIRECTION_PRODUCER_MAP_V1,
  CURVE_SHAPE_PRODUCER_TOKENS_V1,
  CURVE_DIRECTION_PRODUCER_TOKENS_V1,
  UNRESOLVABLE_INPUT_REASONS_V1,
  ACTIVE_DIMENSION_NAMES_V1,
  INACTIVE_DIMENSIONS_V1,
  resolveDimension,
  isFailClosedValue,
} from '../implementation/regime-taxonomy-v1.mjs';
import {
  createParameterSet,
  createClassifierVersion,
  resolveParameter,
  assertNoForbiddenEvidenceField,
  FORBIDDEN_EVIDENCE_FIELDS_V1,
} from '../implementation/regime-classifier-v1.mjs';
import {
  createMacroBudgetMeter,
  createMacroSnapshotCache,
  createMacroContextBinding,
  refuseLiveMacroFetcher,
  refusePerTickerMacroFetch,
  refuseMacroIngestion,
  assertMacroPerimeter,
  assertMacroCoverageConsistent,
  MACRO_OPTIONAL_V1_MEMBERS,
} from '../implementation/macro-context-binding-v1.mjs';
import {
  createRegimeStore,
  appendRegimeRecord,
  assertSessionCoverage,
} from '../implementation/regime-store-v1.mjs';
import {
  evaluateTransition,
  evaluateTransitionSeries,
  refuseCrossHorizonComparison,
  requestMinimumDwell,
} from '../implementation/regime-transition-v1.mjs';
import { OUTCOME_LEAKAGE_CASES } from '../fixtures/outcome-leakage-fixture.mjs';
import {
  DEFERRED_DIMENSION_NAMES,
  DEFERRED_REASON_VOCABULARY,
  DEFERRED_MACRO_SERIES_CODES,
  DEFERRED_HORIZON_SESSION_COUNTS,
  OPTIONAL_V1_MEMBERS,
} from '../fixtures/deferred-exclusion-fixture.mjs';
import {
  emitFixtureRecord,
  FIXTURE_ACTIVE_HORIZON_SPEC,
  FIXTURE_ALTERNATE_HORIZON_SPEC,
  ACTIVE_REGIME_HORIZON_SPEC_IDS,
  PARAMETER_SET,
  ALTERNATE_PARAMETER_SET,
  MACRO_CONTEXT_BINDING,
  ALTERNATE_MACRO_CONTEXT_BINDING,
  CLASSIFIER_VERSION,
  MACRO_ABSENCE_STORE,
  CURVE_NOT_AVAILABLE_STORE,
  CURVE_OUT_OF_VOCABULARY_STORE,
  CURVE_PRESERVED_TOKEN_STORE,
  CURVE_INVERTED_STEEPENING_STORE,
  MISSINGNESS_CASES,
  KNOWLEDGE_CUTOFF_BOUNDARY,
} from '../fixtures/missingness-horizon-fixture.mjs';
import {
  buildFeatureSet,
  buildMacroVintageStore,
  ANCHOR_SESSION_DATE,
  ANCHOR_KNOWLEDGE_CUTOFF,
  HORIZON_START_KNOWLEDGE_CUTOFF,
  FUTURE_INSTANT,
  SESSION_UNIVERSE,
  FIXTURE_CALENDAR_WINDOW_BINDING,
  FIXTURE_ALTERNATE_CALENDAR_WINDOW_BINDING,
  MACRO_VINTAGE_STORE,
} from '../fixtures/vintage-causality-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const results = [];
let assertions = 0;

/** Every case must actually execute an assertion; a declarative PASS is refused. */
function hostile(id, name, fn) {
  const before = assertions;
  fn({ check: (assertion) => { assertion(); assertions += 1; } });
  const executed = assertions - before;
  if (executed === 0) throw new Error(`DECLARATIVE_PASS_FORBIDDEN:${id}`);
  results.push({ hostileId: id, name, result: 'PASS', assertionsExecuted: executed });
}

const baseRecord = emitFixtureRecord();

hostile('V-1', 'FUTURE LEAKAGE HOSTILE', ({ check }) => {
  const future = { name: 'preparedMacroValue', recordType: 'Observation', availableAt: FUTURE_INSTANT, provenance: { producerGateId: 'GATE21', originRecordType: 'Observation', availableAt: FUTURE_INSTANT } };
  check(() => assert.equal(admitInputAtCutoff({ input: future, knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF }).code, 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN'));
  /* A publication after K(T) cannot influence T: it is simply not selected. */
  const selected = selectVintageAsOf({ observations: MACRO_VINTAGE_STORE['US.TREAS.DGS10'], knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF });
  check(() => assert.equal(selected.status, 'RESOLVED'));
  check(() => assert.ok(selected.observation.availableAt <= ANCHOR_KNOWLEDGE_CUTOFF));
  check(() => assert.notEqual(selected.observation.value, 0.09));
});

hostile('V-2', 'VINTAGE LEAKAGE HOSTILE', ({ check }) => {
  /* Replay at the horizon start must see the older vintage, never the later one. */
  const early = selectVintageAsOf({ observations: MACRO_VINTAGE_STORE['US.TREAS.DGS10'], knowledgeCutoff: HORIZON_START_KNOWLEDGE_CUTOFF });
  const late = selectVintageAsOf({ observations: MACRO_VINTAGE_STORE['US.TREAS.DGS10'], knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF });
  check(() => assert.equal(early.status, 'RESOLVED'));
  check(() => assert.notEqual(early.observation.value, late.observation.value));
  check(() => assert.equal(admitMacroVintage({ observation: { seriesCode: 'X', availableAt: ANCHOR_KNOWLEDGE_CUTOFF, vintageAvailableAt: FUTURE_INSTANT }, knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF }).code, 'FUTURE_VINTAGE_LEAKAGE_FORBIDDEN'));
});

hostile('V-3', 'FOMC AS-OF', ({ check }) => {
  const fomc = { seriesCode: 'US.FOMC.DECISION', value: 'CUT', availableAt: FUTURE_INSTANT };
  check(() => assert.equal(admitMacroVintage({ observation: fomc, knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF }).code, 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN'));
  const store = buildMacroVintageStore();
  const asOf = selectVintageAsOf({ observations: [...store['US.FOMC.DECISION'], fomc], knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF });
  check(() => assert.equal(asOf.observation.value, 'HOLD'));
});

hostile('V-4', 'TREASURY AS-OF', ({ check }) => {
  const treasury = { seriesCode: 'US.TREAS.DGS2', value: 0.99, availableAt: FUTURE_INSTANT };
  check(() => assert.equal(admitMacroVintage({ observation: treasury, knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF }).code, 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN'));
  check(() => assert.equal(selectVintageAsOf({ observations: [treasury], knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF }).code, 'NO_ADMISSIBLE_VINTAGE_AT_CUTOFF'));
});

hostile('V-5', 'MISSING CORE FAIL-CLOSED', ({ check }) => {
  for (const testCase of MISSINGNESS_CASES) {
    const record = emitFixtureRecord({ missing: testCase.missing ?? [], insufficient: testCase.insufficient ?? [] });
    check(() => assert.equal(record.regimeVector[testCase.dimension], testCase.expectedValue));
    check(() => assert.equal(record.classificationQuality, testCase.expectedQuality));
    /* No silent imputation: the record is still emitted, with the gap declared. */
    check(() => assert.ok(record.regimeRecordId.length === 64));
  }
});

hostile('V-6', 'DEFERRED SERIES ABSENCE NON-BLOCKING', ({ check }) => {
  const withoutDeferred = emitFixtureRecord();
  check(() => assert.equal(withoutDeferred.classificationQuality, 'COMPLETE'));
  for (const code of DEFERRED_MACRO_SERIES_CODES) {
    check(() => assert.ok(!MACRO_CONTEXT_BINDING.coreSeriesCodes.includes(code)));
    check(() => assert.ok(!Object.keys(withoutDeferred.classificationEvidence).includes(code)));
  }
});

hostile('V-7', 'PARAMETER VERSION MUTATION', ({ check }) => {
  check(() => assert.notEqual(ALTERNATE_PARAMETER_SET.parameterSetId, PARAMETER_SET.parameterSetId));
  const altered = emitFixtureRecord({ parameterSet: ALTERNATE_PARAMETER_SET });
  check(() => assert.notEqual(altered.regimeRecordId, baseRecord.regimeRecordId));
  /* A parameter change bumps ParameterSetId only; the classifier version is stable. */
  check(() => assert.equal(altered.ClassifierVersionId, baseRecord.ClassifierVersionId));
  /* History is never rewritten: both records coexist under distinct keys. */
  const store = appendRegimeRecord(appendRegimeRecord(createRegimeStore(), baseRecord), altered);
  check(() => assert.equal(store.records.length, 2));
});

hostile('V-8', 'EXACT REPLAY', ({ check }) => {
  const replay = emitFixtureRecord();
  check(() => assert.equal(replay.regimeRecordId, baseRecord.regimeRecordId));
  check(() => assert.equal(replay.evidenceSetId, baseRecord.evidenceSetId));
  check(() => assert.deepEqual(replay.regimeVector, baseRecord.regimeVector));
});

const seriesRecords = (() => {
  const sessions = SESSION_UNIVERSE.slice(-4).map((session) => session.sessionDate);
  const shapes = [
    { 'F1_SIMPLE_RETURN@W21': 0.08, 'F1_SIMPLE_RETURN@W5': 0.01, 'F2_REALIZED_VOLATILITY@W21': 0.15, 'F3_MAX_DRAWDOWN@W21': -0.04, 'F4_RELATIVE_VOLUME@W21': 1.1 },
    { 'F1_SIMPLE_RETURN@W21': 0.09, 'F1_SIMPLE_RETURN@W5': 0.01, 'F2_REALIZED_VOLATILITY@W21': 0.25, 'F3_MAX_DRAWDOWN@W21': -0.04, 'F4_RELATIVE_VOLUME@W21': 1.1 },
    { 'F1_SIMPLE_RETURN@W21': -0.09, 'F1_SIMPLE_RETURN@W5': -0.02, 'F2_REALIZED_VOLATILITY@W21': 0.25, 'F3_MAX_DRAWDOWN@W21': -0.04, 'F4_RELATIVE_VOLUME@W21': 1.1 },
    { 'F1_SIMPLE_RETURN@W21': -0.09, 'F1_SIMPLE_RETURN@W5': -0.02, 'F2_REALIZED_VOLATILITY@W21': 0.25, 'F3_MAX_DRAWDOWN@W21': -0.25, 'F4_RELATIVE_VOLUME@W21': 1.1 },
  ];
  return sessions.map((sessionDate, index) => emitFixtureRecord({ sessionDate, featureValues: shapes[index] }));
})();

hostile('V-9', 'TRANSITION PERSIST/CHANGE', ({ check }) => {
  const series = evaluateTransitionSeries({ records: seriesRecords });
  check(() => assert.equal(series.status, 'RESOLVED'));
  /* Exactly one transition per consecutive pair; the first session emits none. */
  check(() => assert.equal(series.transitions.length, series.expectedTransitionCount));
  check(() => assert.equal(series.transitions.length, seriesRecords.length - 1));
  check(() => assert.equal(series.firstSession.emitsTransition, false));
  check(() => assert.equal(series.transitions[0].transitionType, 'PERSIST'));
  check(() => assert.equal(series.transitions[1].transitionType, 'CHANGE'));
  check(() => assert.equal(series.transitions[2].transitionType, 'CHANGE'));
  check(() => assert.ok(series.transitions.every((t) => ['PERSIST', 'CHANGE'].includes(t.transitionType))));
});

hostile('V-10', 'CHANGED DIMENSIONS', ({ check }) => {
  const series = evaluateTransitionSeries({ records: seriesRecords });
  /* Pair 0: only the overlay volatilityState moved; primary must stay PERSIST. */
  check(() => assert.deepEqual(series.transitions[0].changedDimensions, ['volatilityState']));
  check(() => assert.equal(series.transitions[0].transitionType, 'PERSIST'));
  /* Pair 1: the primary moved; changedDimensions lists exactly the differing ones. */
  check(() => assert.ok(series.transitions[1].changedDimensions.includes('primaryMarketRegime')));
  check(() => assert.equal(series.transitions[1].transitionType, 'CHANGE'));
});

hostile('V-11', 'CRISIS / FAST TRANSITION', ({ check }) => {
  const series = evaluateTransitionSeries({ records: seriesRecords });
  const crisis = series.transitions[2];
  /* Emitted at the session it occurs: no confirmation delay, no smoothing. */
  check(() => assert.equal(crisis.toPrimaryMarketRegime, 'CRISIS'));
  check(() => assert.equal(crisis.transitionType, 'CHANGE'));
  check(() => assert.equal(crisis.regimeAgeSessions, 1));
  check(() => assert.equal(crisis.lastTransitionSession, crisis.toSessionDate));
  check(() => assert.equal(crisis.hysteresis, 'DEFERRED'));
  check(() => assert.equal(requestMinimumDwell(3).code, 'MINIMUM_DWELL_NOT_DECLARED'));
});

hostile('V-12', 'MACRO NETWORK OFF-SCAN', ({ check }) => {
  const meter = createMacroBudgetMeter();
  const cache = createMacroSnapshotCache();
  for (let index = 0; index < 25; index += 1) {
    emitFixtureRecord({ meter, cache });
  }
  check(() => assert.equal(meter.read().networkCalls, 0));
  check(() => assert.equal(meter.read().macroFetches, 0));
  check(() => assert.equal(meter.read().ingestionCalls, 0));
  check(() => assert.equal(refuseLiveMacroFetcher().code, 'LIVE_MACRO_FETCHER_FORBIDDEN'));
  check(() => assert.equal(refusePerTickerMacroFetch().code, 'PER_TICKER_MACRO_FETCH_FORBIDDEN'));
  check(() => assert.equal(refuseMacroIngestion().code, 'MACRO_INGESTION_NOT_IN_GATE24_SCOPE'));
});

hostile('V-13', 'COVERAGE REPORT', ({ check }) => {
  const store = seriesRecords.reduce(appendRegimeRecord, createRegimeStore());
  const scope = seriesRecords.map((record) => record.SessionDate);
  const coverage = assertSessionCoverage({
    store, scopeSessionDates: scope,
    instrumentIdentityId: seriesRecords[0].InstrumentIdentityId,
    regimeHorizonSpecId: FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId,
  });
  check(() => assert.equal(coverage.status, 'COMPLETE'));
  check(() => assert.equal(coverage.missingSessionDates.length, 0));
  /* An omitted session is a declared defect, never an implicit non-classification. */
  const gapped = assertSessionCoverage({
    store, scopeSessionDates: [...scope, '2030-01-02'],
    instrumentIdentityId: seriesRecords[0].InstrumentIdentityId,
    regimeHorizonSpecId: FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId,
  });
  check(() => assert.equal(gapped.status, 'DEFECT'));
  check(() => assert.equal(gapped.code, 'SESSION_OMITTED_FROM_SCOPE'));
});

hostile('V-14', 'PROVENANCE COMPLETENESS', ({ check }) => {
  for (const field of ['FeatureVectorBindingId', 'MacroContextBindingId', 'ParameterSetId', 'ClassifierVersionId', 'RegimeTaxonomyVersionId', 'KnowledgeCutoff', 'DatasetId_feature', 'MissingnessStateId', 'RegimeHorizonSpecId']) {
    check(() => assert.ok(typeof baseRecord[field] === 'string' && baseRecord[field].length > 0, field));
  }
  check(() => assert.ok(baseRecord.classificationEvidence.families.length === 9));
  check(() => assert.ok(baseRecord.evidenceSetId.length === 64));
  check(() => assert.equal(baseRecord.knowledgeCutoffBoundary, KNOWLEDGE_CUTOFF_BOUNDARY));
});

hostile('V-15', 'MACRO BINDING IDENTITY DIFFERENTIAL', ({ check }) => {
  const altered = emitFixtureRecord({ macroContextBinding: ALTERNATE_MACRO_CONTEXT_BINDING });
  check(() => assert.notEqual(ALTERNATE_MACRO_CONTEXT_BINDING.macroContextBindingId, MACRO_CONTEXT_BINDING.macroContextBindingId));
  check(() => assert.equal(altered.SessionDate, baseRecord.SessionDate));
  check(() => assert.equal(altered.KnowledgeCutoff, baseRecord.KnowledgeCutoff));
  check(() => assert.equal(altered.FeatureVectorBindingId, baseRecord.FeatureVectorBindingId));
  check(() => assert.notEqual(altered.regimeRecordId, baseRecord.regimeRecordId));
});

hostile('V-16', 'LIVE SCAN PERFORMANCE NON-REGRESSION', ({ check }) => {
  const meter = createMacroBudgetMeter();
  const cache = createMacroSnapshotCache();
  for (let index = 0; index < 40; index += 1) emitFixtureRecord({ meter, cache });
  /* One snapshot computed once, reused across every subsequent ticker. */
  check(() => assert.equal(meter.read().snapshotComputes, 1));
  check(() => assert.equal(meter.read().snapshotReuses, 39));
  check(() => assert.equal(cache.size(), 1));
  check(() => assert.equal(meter.read().networkCalls, 0));
  check(() => assert.equal(describeRegimeHorizonArchitecture().createsNewCalendarConcept, false));
});

hostile('V-17', 'TAXONOMY CLOSURE', ({ check }) => {
  for (const name of ACTIVE_DIMENSION_NAMES_V1) {
    const spec = resolveDimension(name);
    check(() => assert.ok(spec.entries.includes(baseRecord.regimeVector[name])));
    check(() => assert.throws(() => assertDeclaredEntry(name, 'NOT_A_DECLARED_ENTRY'), /OUT_OF_ENUMERATION/));
  }
  const outOfVocabulary = emitFixtureRecord({ vintageStore: CURVE_OUT_OF_VOCABULARY_STORE });
  check(() => assert.equal(outOfVocabulary.regimeVector.yieldCurveShape, 'UNKNOWN'));
});

hostile('V-18', 'EXPLICIT NON-CLASSIFICATION', ({ check }) => {
  const notAvailable = emitFixtureRecord({ vintageStore: CURVE_NOT_AVAILABLE_STORE });
  const outOfVocabulary = emitFixtureRecord({ vintageStore: CURVE_OUT_OF_VOCABULARY_STORE });
  /* NOT_AVAILABLE and out-of-vocabulary are distinguishable, never merged. */
  check(() => assert.equal(notAvailable.regimeVector.yieldCurveShape, 'INSUFFICIENT_DATA'));
  check(() => assert.equal(outOfVocabulary.regimeVector.yieldCurveShape, 'UNKNOWN'));
  check(() => assert.notEqual(notAvailable.regimeVector.yieldCurveShape, outOfVocabulary.regimeVector.yieldCurveShape));
  /* Neither ever resolves to a classifying entry. */
  check(() => assert.ok(isFailClosedValue('yieldCurveShape', notAvailable.regimeVector.yieldCurveShape)));
  check(() => assert.ok(isFailClosedValue('yieldCurveShape', outOfVocabulary.regimeVector.yieldCurveShape)));
});

hostile('V-19', 'MACRO PERIMETER INTEGRITY', ({ check }) => {
  const meter = createMacroBudgetMeter();
  const cache = createMacroSnapshotCache();
  emitFixtureRecord({ meter, cache });
  check(() => assert.deepEqual(MACRO_OPTIONAL_V1_MEMBERS, []));
  check(() => assert.deepEqual(OPTIONAL_V1_MEMBERS, []));
  check(() => assert.throws(
    () => createMacroContextBinding({ macroVintageSetManifestId: 'a', macroDatasetSnapshotManifestId: 'b', availableAtPolicyId: 'c', optionalSeriesCodes: ['US.BLS.ICSA'] }),
    /SILENT_TIER_PROMOTION_FORBIDDEN/,
  ));
  const snapshot = createMacroSnapshotCache().resolve({ macroContextBinding: MACRO_CONTEXT_BINDING, vintageStore: MACRO_VINTAGE_STORE, knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF, meter });
  check(() => assert.equal(assertMacroPerimeter({ macroContextBinding: MACRO_CONTEXT_BINDING, snapshot: snapshot.snapshot }).status, 'ALLOWED'));
  check(() => assert.equal(
    assertMacroPerimeter({ macroContextBinding: MACRO_CONTEXT_BINDING, snapshot: { series: { 'US.BLS.ICSA': {} }, derived: {} } }).code,
    'SILENT_TIER_PROMOTION_FORBIDDEN',
  ));
});

hostile('V-20', 'NO CARTESIAN LABEL', ({ check }) => {
  check(() => assert.equal(refuseCartesianLabel('BULL_VOLATILE_DISINFLATION_RATES_FALLING_CURVE_INVERTED').code, 'CARTESIAN_REGIME_LABEL_FORBIDDEN'));
  check(() => assert.equal(refuseCartesianLabel('BULL').status, 'ALLOWED'));
  /* Dimension values stay independently readable on the emitted record. */
  check(() => assert.equal(baseRecord.regimeVector.primaryMarketRegime, 'BULL'));
  check(() => assert.equal(baseRecord.regimeVector.volatilityState, 'NORMAL'));
  check(() => assert.equal(Object.values(baseRecord.regimeVector).filter((v) => String(v).includes('BULL_')).length, 0));
});

hostile('V-21', 'CURVE MAPPING EXHAUSTIVENESS', ({ check }) => {
  for (const token of CURVE_SHAPE_PRODUCER_TOKENS_V1) {
    const mapped = mapProducerToken({ dimensionName: 'yieldCurveShape', producerToken: token, producerMap: CURVE_SHAPE_PRODUCER_MAP_V1 });
    check(() => assert.ok(resolveDimension('yieldCurveShape').entries.includes(mapped.value)));
    if (token === 'NOT_AVAILABLE') check(() => assert.equal(mapped.value, 'INSUFFICIENT_DATA'));
    else check(() => assert.equal(mapped.value, token));
  }
  for (const token of CURVE_DIRECTION_PRODUCER_TOKENS_V1) {
    const mapped = mapProducerToken({ dimensionName: 'yieldCurveDirection', producerToken: token, producerMap: CURVE_DIRECTION_PRODUCER_MAP_V1 });
    if (token === 'NOT_AVAILABLE') check(() => assert.equal(mapped.value, 'INSUFFICIENT_DATA'));
    else check(() => assert.equal(mapped.value, token));
  }
  /* PARTIALLY_INVERTED, MIXED, FLATTENING and UNCHANGED are preserved, never collapsed. */
  const preserved = emitFixtureRecord({ vintageStore: CURVE_PRESERVED_TOKEN_STORE });
  check(() => assert.equal(preserved.regimeVector.yieldCurveShape, 'PARTIALLY_INVERTED'));
  check(() => assert.equal(preserved.regimeVector.yieldCurveDirection, 'FLATTENING'));
  /* An unmapped value fails closed to UNKNOWN, never to a classifying entry. */
  check(() => assert.equal(mapProducerToken({ dimensionName: 'yieldCurveShape', producerToken: 'BANANA', producerMap: CURVE_SHAPE_PRODUCER_MAP_V1 }).value, 'UNKNOWN'));
  check(() => assert.equal(mapProducerToken({ dimensionName: 'yieldCurveShape', producerToken: undefined, producerMap: CURVE_SHAPE_PRODUCER_MAP_V1 }).reason, 'PRODUCER_RECORD_ABSENT'));
});

hostile('V-22', 'CURVE SHAPE AND DIRECTION INDEPENDENCE', ({ check }) => {
  const record = emitFixtureRecord({ vintageStore: CURVE_INVERTED_STEEPENING_STORE });
  /* A record may carry INVERTED with STEEPENING; no composite value is produced. */
  check(() => assert.equal(record.regimeVector.yieldCurveShape, 'INVERTED'));
  check(() => assert.equal(record.regimeVector.yieldCurveDirection, 'STEEPENING'));
  check(() => assert.notEqual(record.regimeVector.yieldCurveShape, record.regimeVector.yieldCurveDirection));
  check(() => assert.ok(!Object.hasOwn(record.regimeVector, 'yieldCurveState')));
});

hostile('V-23', 'EXTENDED DIMENSION NON-BLOCKING', ({ check }) => {
  for (const name of DEFERRED_DIMENSION_NAMES) {
    const spec = resolveDimension(name);
    check(() => assert.equal(spec.classifyingCount, 0));
    check(() => assert.ok(['UNKNOWN', 'INSUFFICIENT_DATA'].includes(baseRecord.regimeVector[name])));
  }
  /* A COMPLETE classification is reached with all five still inactive. */
  check(() => assert.equal(baseRecord.classificationQuality, 'COMPLETE'));
  check(() => assert.equal(INACTIVE_DIMENSIONS_V1.length, 5));
});

hostile('V-24', 'MULTI_HORIZON_IDENTITY_DIFFERENTIAL', ({ check }) => {
  const alternate = emitFixtureRecord({ regimeHorizonSpec: FIXTURE_ALTERNATE_HORIZON_SPEC });
  check(() => assert.notEqual(FIXTURE_ALTERNATE_HORIZON_SPEC.regimeHorizonSpecId, FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId));
  check(() => assert.equal(alternate.SessionDate, baseRecord.SessionDate));
  check(() => assert.equal(alternate.KnowledgeCutoff, baseRecord.KnowledgeCutoff));
  check(() => assert.equal(alternate.FeatureVectorBindingId, baseRecord.FeatureVectorBindingId));
  check(() => assert.equal(alternate.MacroContextBindingId, baseRecord.MacroContextBindingId));
  check(() => assert.notEqual(alternate.regimeRecordId, baseRecord.regimeRecordId));
});

hostile('V-25', 'MULTI_HORIZON_EXACT_REPLAY', ({ check }) => {
  const first = emitFixtureRecord({ regimeHorizonSpec: FIXTURE_ALTERNATE_HORIZON_SPEC });
  const second = emitFixtureRecord({ regimeHorizonSpec: FIXTURE_ALTERNATE_HORIZON_SPEC });
  check(() => assert.equal(first.regimeRecordId, second.regimeRecordId));
  check(() => assert.equal(first.evidenceSetId, second.evidenceSetId));
  check(() => assert.deepEqual(first.regimeVector, second.regimeVector));
});

hostile('V-26', 'CONSUMER_HORIZON_BINDING', ({ check }) => {
  check(() => assert.equal(refuseImplicitHorizon({}).code, 'IMPLICIT_HORIZON_BINDING_FORBIDDEN'));
  check(() => assert.equal(refuseImplicitHorizon({ regimeHorizonSpecId: FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId }).status, 'ALLOWED'));
  /* "the only regime because only one horizon is active" is not an admissible binding. */
  check(() => assert.equal(bindConsumerHorizon({ consumerId: 'c', regimeHorizonSpecId: null, activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS }).code, 'IMPLICIT_HORIZON_BINDING_FORBIDDEN'));
  check(() => assert.equal(bindConsumerHorizon({ consumerId: 'c', regimeHorizonSpecId: FIXTURE_ALTERNATE_HORIZON_SPEC.regimeHorizonSpecId, activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS }).code, 'REGIME_HORIZON_NOT_ACTIVE_IN_CORE_V1'));
  check(() => assert.equal(describeRegimeHorizonArchitecture().codeDefaultHorizon, null));
  /* A cross-horizon pair is never emitted as a transition. */
  check(() => assert.equal(refuseCrossHorizonComparison({ previous: baseRecord, current: emitFixtureRecord({ regimeHorizonSpec: FIXTURE_ALTERNATE_HORIZON_SPEC }) }).code, 'CROSS_HORIZON_COMPARISON_FORBIDDEN'));
});

const deferredIndexPath = 'governance/master-matrix/DEFERRED_CAPABILITY_REGISTRY.ndjson';
const deferredEntries = fs.existsSync(path.join(REPO_ROOT, deferredIndexPath))
  ? fs.readFileSync(path.join(REPO_ROOT, deferredIndexPath), 'utf8').split('\n').filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    return {
      ...event,
      ...payload,
      deferredCapabilityId: event.deferredCapabilityId,
      sourceGate: payload.sourceGate ?? event.sourceGate,
      reasonDeferred: payload.reasonDeferred ?? event.reasonDeferred,
      promotionRequirements: payload.promotionRequirements ?? event.promotionRequirements,
      disposition: payload.disposition ?? event.disposition,
      abandoned: payload.abandoned === true || event.abandoned === true,
      revisitTrigger: payload.revisitTrigger ?? payload.eventBasedRevisitTrigger ?? event.revisitTrigger,
    };
  })
  : [];
const gate24Deferred = deferredEntries.filter((entry) => entry.sourceGate === 'GATE24' || String(entry.deferredCapabilityId ?? '').startsWith('GATE24-DC-'));

hostile('V-27', 'DEFERRED_CAPABILITY_TRACEABILITY', ({ check }) => {
  /* Every registered-not-active dimension carries a durable deferred-capability id. */
  for (const name of DEFERRED_DIMENSION_NAMES) {
    check(() => assert.ok(/^GATE24-DC-0[1-5]$/.test(resolveDimension(name).deferredCapabilityId)));
  }
  check(() => assert.ok(gate24Deferred.length >= 5, 'GATE24 deferred capabilities must be durably registered'));
  for (const entry of gate24Deferred) {
    check(() => assert.ok(Array.isArray(entry.reasonDeferred) && entry.reasonDeferred.length > 0));
    check(() => assert.ok(typeof entry.revisitTrigger === 'string' && entry.revisitTrigger.length > 0));
  }
});

hostile('V-28', 'DEFERRED_PROMOTION_VERSIONING', ({ check }) => {
  /* Activating a further horizon is additive: new identity, existing records intact. */
  const promoted = createRegimeHorizonSpec({ sessionCount: 63, calendarWindowBindingId: FIXTURE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId });
  check(() => assert.notEqual(promoted.regimeHorizonSpecId, FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId));
  check(() => assert.equal(promoted.activeInCoreV1, false));
  const promotedClassifier = createClassifierVersion({ classifierVersionLabel: 'GATE24_CORE_V1_CLASSIFIER', activeRegimeHorizonSpecIds: [promoted.regimeHorizonSpecId] });
  check(() => assert.notEqual(promotedClassifier.classifierVersionId, CLASSIFIER_VERSION.classifierVersionId));
  const store = appendRegimeRecord(createRegimeStore(), baseRecord);
  check(() => assert.equal(appendRegimeRecord(store, baseRecord).records.length, 1));
  check(() => assert.deepEqual(DEFERRED_HORIZON_SESSION_COUNTS, [5, 63, 126, 252]));
});

hostile('V-29', 'DEFERRED_REVISIT', ({ check }) => {
  const revisitable = gate24Deferred.filter((entry) => entry.disposition === 'OPEN' && entry.abandoned === false);
  check(() => assert.ok(revisitable.length >= 5));
  for (const entry of revisitable) {
    check(() => assert.ok(Array.isArray(entry.promotionRequirements) && entry.promotionRequirements.length > 0));
  }
});

hostile('V-30', 'DEFERRED_REASON_VALIDITY', ({ check }) => {
  for (const entry of gate24Deferred) {
    for (const reason of entry.reasonDeferred) {
      check(() => assert.ok(DEFERRED_REASON_VOCABULARY.includes(reason), `non-vocabulary reason ${reason}`));
      check(() => assert.ok(reason !== 'later' && reason.length > 0));
    }
  }
});

/* ---- Mission-named BUILD hostiles beyond the numbered matrix ------------------- */

hostile('H-OUTCOME', 'OUTCOME LEAKAGE / LAUNDERING', ({ check }) => {
  for (const testCase of OUTCOME_LEAKAGE_CASES) {
    const decision = admitInputAtCutoff({ input: testCase.input, knowledgeCutoff: ANCHOR_KNOWLEDGE_CUTOFF });
    check(() => assert.notEqual(decision.status, 'ALLOWED', testCase.caseId));
    check(() => assert.equal(decision.code, testCase.expectedCode, testCase.caseId));
  }
  check(() => assert.equal(refuseSubstitution('LATEST_VALUE_SUBSTITUTION').code, 'LATEST_VALUE_SUBSTITUTION_FORBIDDEN'));
  check(() => assert.equal(refuseSubstitution('FUTURE_BACKFILL').code, 'FUTURE_BACKFILL_FORBIDDEN'));
});

hostile('H-FIXTURE-CALENDAR', 'FIXTURE CALENDAR REJECTION', ({ check }) => {
  /* The GATE23 fixture namespace and its value are inadmissible as production. */
  check(() => assert.equal(isFixtureCalendarNamespace('GATE23_FIXTURE_CALENDAR/1'), true));
  check(() => assert.equal(isFixtureCalendarNamespace('GATE24_FIXTURE_CALENDAR/1'), true));
  check(() => assert.equal(admitProductionCalendarWindowBinding(FIXTURE_CALENDAR_WINDOW_BINDING).code, 'FIXTURE_CALENDAR_NAMESPACE_FORBIDDEN'));
  const featureSet = buildFeatureSet();
  check(() => assert.equal(
    resolveProductionCalendarWindowBinding({ featureSet, calendarWindowBinding: FIXTURE_CALENDAR_WINDOW_BINDING }).code,
    'FIXTURE_CALENDAR_NAMESPACE_FORBIDDEN',
  ));
  /* No literal calendar-binding id appears in GATE24 implementation or BUILD domain contracts.
     Lifecycle contracts (CURRENT_CONTRACT, EXECUTION_CONTRACT_*) are outside this BUILD
     workset and already carry SHA-256 pins by governance design. */
  const forbiddenLiteral = 'df2f4340d7b04a165611e0fefe34092708a77668181624876164dd10fa93c090';
  const implementationDir = path.join(REPO_ROOT, 'governance/gates/GATE24/implementation');
  const contractsDir = path.join(REPO_ROOT, 'governance/gates/GATE24/contracts');
  const scanned = [
    ...fs.readdirSync(implementationDir).map((name) => path.join(implementationDir, name)),
    ...fs.readdirSync(contractsDir)
      .filter((name) => name.startsWith('GATE24_') && name.endsWith('.json'))
      .map((name) => path.join(contractsDir, name)),
  ];
  for (const filePath of scanned) {
    const source = fs.readFileSync(filePath, 'utf8');
    check(() => assert.ok(!source.includes(forbiddenLiteral), `forbidden calendar literal in ${filePath}`));
    check(() => assert.ok(!/["'][0-9a-f]{64}["']/.test(source), `literal 64-hex id in ${filePath}`));
  }
});

hostile('H-CALENDAR-SINGLE-VALUED', 'CALENDAR BINDING SINGLE-VALUEDNESS', ({ check }) => {
  const divergent = buildFeatureSet({
    calendarWindowBindingIdOverrides: { 'F1_SIMPLE_RETURN@W5': FIXTURE_ALTERNATE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId },
  });
  const resolvedBinding = resolveCalendarWindowBindingIdFromFeatureSet(divergent);
  check(() => assert.equal(resolvedBinding.status, 'FAIL_CLOSED'));
  check(() => assert.equal(resolvedBinding.code, 'CALENDAR_WINDOW_BINDING_NOT_SINGLE_VALUED'));
  check(() => assert.equal(resolvedBinding.observedCount, 2));
  check(() => assert.equal(resolveCalendarWindowBindingIdFromFeatureSet({ records: [] }).code, 'CALENDAR_WINDOW_BINDING_ABSENT'));
});

hostile('H-CUTOFF', 'WALL-CLOCK CUTOFF PROHIBITION', ({ check }) => {
  check(() => assert.equal(assertAdmissibleCutoffDerivation(FORBIDDEN_CUTOFF_PRIMITIVE).code, 'FORBIDDEN_CUTOFF_PRIMITIVE'));
  for (const constant of FORBIDDEN_WALL_CLOCK_CONSTANTS) {
    check(() => assert.equal(assertAdmissibleCutoffDerivation(constant).code, 'WALL_CLOCK_CUTOFF_CONSTANT_FORBIDDEN'));
  }
  /* K(T) is read off the pinned canonical session, never derived from a convention. */
  const pinned = resolveKnowledgeCutoff({ sessionDate: ANCHOR_SESSION_DATE, calendarWindowBinding: FIXTURE_CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE });
  check(() => assert.equal(pinned.status, 'RESOLVED'));
  check(() => assert.equal(pinned.knowledgeCutoff, ANCHOR_KNOWLEDGE_CUTOFF));
  check(() => assert.equal(pinned.knowledgeCutoffBoundary, KNOWLEDGE_CUTOFF_BOUNDARY));
});

hostile('H-PARAMETER', 'NO CODE-DEFAULT THRESHOLD', ({ check }) => {
  check(() => assert.throws(() => resolveParameter(PARAMETER_SET, 'volatilityState', 'notDeclared'), /PARAMETER_NOT_IN_BOUND_PARAMETER_SET/));
  const stripped = createParameterSet({
    parameterSetLabel: 'STRIPPED', regimeVectorVersionId: 'REGIME_VECTOR_V1',
    activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS,
    parameters: PARAMETER_SET.parameters.filter((p) => p.parameterName !== 'bullReturnMin')
      .map((p) => ({ dimension: p.dimension, parameterName: p.parameterName, value: p.value })),
  });
  /* Removing one declared threshold fails the classification closed rather than
     falling back to an inline default. */
  check(() => assert.throws(() => emitFixtureRecord({ parameterSet: stripped }), /PARAMETER_NOT_IN_BOUND_PARAMETER_SET/));
});

hostile('H-EVIDENCE', 'CLASSIFICATION EVIDENCE INTEGRITY', ({ check }) => {
  check(() => assert.throws(() => assertNoForbiddenEvidenceField({ families: [{ probability: 0.9 }] }), /PROBABILITY_OR_CONFIDENCE_OUTPUT_FORBIDDEN/));
  for (const field of FORBIDDEN_EVIDENCE_FIELDS_V1) {
    check(() => assert.throws(() => assertNoForbiddenEvidenceField({ [field]: 1 }), /PROBABILITY_OR_CONFIDENCE_OUTPUT_FORBIDDEN/));
  }
  /* Every fail-closed dimension is explained by an ABSENT attributed family. */
  const partial = emitFixtureRecord({ vintageStore: MACRO_ABSENCE_STORE });
  for (const name of ACTIVE_DIMENSION_NAMES_V1) {
    if (!isFailClosedValue(name, partial.regimeVector[name])) continue;
    const explaining = partial.classificationEvidence.families.filter((family) => family.status === 'ABSENT' && family.dimensions.includes(name));
    check(() => assert.ok(explaining.length > 0, `unexplained ${name}`));
    check(() => assert.ok(explaining.every((family) => UNRESOLVABLE_INPUT_REASONS_V1.includes(family.absenceReason))));
  }
  /* Producer-declared completeness may never disagree with observed coverage. */
  check(() => assert.throws(() => emitFixtureRecord({ declaredMacroCompleteness: 'UNAVAILABLE' }), /MACRO_COVERAGE_DECLARATION_INCONSISTENT/));
  check(() => assert.equal(assertMacroCoverageConsistent({ declaredCompleteness: 'COMPLETE', snapshot: { macroFeatureCompleteness: 'COMPLETE' } }).status, 'ALLOWED'));
});

hostile('H-IMMUTABLE-RECORD', 'IMMUTABLE REGIME RECORD IDENTITY', ({ check }) => {
  const store = appendRegimeRecord(createRegimeStore(), baseRecord);
  /* Identical replay is idempotent. */
  check(() => assert.equal(appendRegimeRecord(store, emitFixtureRecord()).records.length, 1));
  /* A divergent emission under the same key is refused, never a silent rewrite. */
  const forged = { ...baseRecord, regimeVector: { ...baseRecord.regimeVector, primaryMarketRegime: 'BEAR' } };
  check(() => assert.throws(() => appendRegimeRecord(store, forged), /REGIME_STORE_RESTATEMENT_CONFLICT/));
  check(() => assert.ok(Object.isFrozen(baseRecord.regimeVector)));
});

hostile('H-HORIZON-REPLAY', 'HORIZON REPLAY ISOLATION', ({ check }) => {
  const active = emitFixtureRecord({ regimeHorizonSpec: FIXTURE_ACTIVE_HORIZON_SPEC });
  const alternate = emitFixtureRecord({ regimeHorizonSpec: FIXTURE_ALTERNATE_HORIZON_SPEC });
  const store = appendRegimeRecord(appendRegimeRecord(createRegimeStore(), active), alternate);
  /* Two horizons for the same session coexist under distinct identities. */
  check(() => assert.equal(store.records.length, 2));
  check(() => assert.equal(new Set(store.records.map((r) => r.SessionDate)).size, 1));
  check(() => assert.equal(new Set(store.records.map((r) => r.regimeRecordId)).size, 2));
  const series = evaluateTransition({ previous: active, current: alternate });
  check(() => assert.equal(series.code, 'CROSS_HORIZON_COMPARISON_FORBIDDEN'));
});

const passCount = results.filter((entry) => entry.result === 'PASS').length;
const failCount = results.filter((entry) => entry.result !== 'PASS').length;
if (failCount > 0) throw new Error('GATE24_HOSTILE_FAILURE');

const hostileEvidence = {
  document: 'GATE24_HOSTILE_MATRIX_RESULT',
  schemaVersion: 1,
  gateId: 'GATE24',
  generatedBy: 'governance/gates/GATE24/tests/gate24-hostiles.test.mjs',
  verdict: 'PASS',
  passCount,
  failCount,
  assertions,
  caseCount: results.length,
  digest: sha256Canonical(results),
  futureLeakage: 0,
  outcomeLeakage: 0,
  fixturePromotion: 0,
  results,
};

/* READ-ONLY EVIDENCE VERIFICATION.
   The canonical hostile matrix is pinned BUILD evidence. An independent
   reinspection must not mutate canonical repository bytes, so this test no
   longer regenerates the artifact. It serialises exactly what the BUILD-time
   writer would have emitted and proves those bytes are already on disk. That
   is strictly stronger than writing: a drifted artifact now FAILS rather than
   being silently overwritten. */
const EVIDENCE_PATH = path.join(REPO_ROOT, 'governance/gates/GATE24/evidence/GATE24_HOSTILE_MATRIX_RESULT.json');
const canonicalHostileBytes = fs.readFileSync(EVIDENCE_PATH, 'utf8');
const canonicalHostile = JSON.parse(canonicalHostileBytes);
assert.deepEqual(canonicalHostile, hostileEvidence);
assert.equal(`${JSON.stringify(hostileEvidence, null, 2)}\n`, canonicalHostileBytes);
assert.equal(canonicalHostile.caseCount, 38);
assert.equal(canonicalHostile.passCount, 38);
assert.equal(canonicalHostile.failCount, 0);
assert.equal(canonicalHostile.digest, sha256Canonical(results));

console.log(`GATE24_HOSTILES_PASS ${assertions} cases=${results.length} pass=${passCount} fail=${failCount}`);
