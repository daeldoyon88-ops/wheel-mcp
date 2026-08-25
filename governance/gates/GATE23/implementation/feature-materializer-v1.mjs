/**
 * GATE23 point-in-time FeatureRecord materializer: Observation(T) -> FeatureRecord(T).
 *
 * This module produces feature records and nothing else. It produces no Outcome,
 * no prediction, no recommendation, no Wheel decision, no Market Regime, no
 * strategy and no cross-sectional implementation.
 *
 * OD-2: price basis is SPLIT_ADJUSTED under strict point-in-time restatement.
 * Arbitrary valid split ratios are supported with no integer and no >= 1
 * assumption. TOTAL_RETURN_ADJUSTED and implicit dividend total return are refused.
 * A later restatement never rewrites a historical FeatureRecord: it either keeps
 * the DatasetId and is refused by the store, or it carries a new DatasetId and is
 * therefore a new FeatureRecordId.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { MISSING_REASONS } from '../../../../research/directional-lab/src/contracts/missingReasonsV1.mjs';
import { validatePriceBasisWindow } from '../../GATE22/implementation/price-basis-v1.mjs';
import { createFeatureRecordId, featureRecordIdentityTuple } from './feature-identity-v1.mjs';
import {
  createFeatureWindowSpec,
  resolvePinnedCanonicalSession,
  resolveTrailingWindow,
} from './feature-window-v1.mjs';
import { admitObservationInput, refuseOutcomeAsFeature } from './causal-admission-v1.mjs';
import { resolveFeatureDefinition } from './feature-registry-v1.mjs';
import { memberKey, resolveVectorStatus, requestCrossSectional } from './feature-families-v1.mjs';

export const FEATURE_MATERIALIZER_VERSION = 'GATE23_FeatureMaterializer/1';
export const FEATURE_RECORD_VERSION = 'GATE23_FeatureRecord/1';
export const MISSINGNESS_STATE_VERSION = 'GATE23_MissingnessState/1';

/** OD-2. */
export const ADMISSIBLE_PRICE_BASIS_V1 = 'SPLIT_ADJUSTED';
export const FORBIDDEN_PRICE_BASES_V1 = Object.freeze(['TOTAL_RETURN_ADJUSTED', 'DERIVED_ADJUSTED']);

export const MISSINGNESS_STATES_V1 = Object.freeze({
  COMPLETE: 'COMPLETE',
  VOLUME_MISSING: MISSING_REASONS.VOLUME_MISSING,
  INPUT_MISSING: MISSING_REASONS.INPUT_MISSING,
  INSUFFICIENT_HISTORY: MISSING_REASONS.INSUFFICIENT_HISTORY,
  INVALID_INPUT: MISSING_REASONS.INVALID_INPUT,
});

export const GATE23_DOES_NOT_PRODUCE = Object.freeze([
  'Outcome', 'prediction', 'recommendation', 'Wheel decision', 'Market Regime', 'strategy',
  'cross-sectional implementation',
]);

export const missingnessStateId = (state) => `${MISSINGNESS_STATE_VERSION}:${state}`;

/** OD-2: any strictly positive finite ratio is valid; no integer and no >= 1 assumption. */
export function assertSplitRatioAdmissible(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) throw new Error('SPLIT_RATIO_INVALID');
  return ratio;
}

export function applySplitAdjustment(rawClose, cumulativeSplitFactor) {
  assertSplitRatioAdmissible(cumulativeSplitFactor);
  if (typeof rawClose !== 'number' || !Number.isFinite(rawClose) || rawClose <= 0) throw new Error('CLOSE_INVALID');
  return rawClose / cumulativeSplitFactor;
}

/** GATE23 never emits an Outcome-shaped product. */
export function refuseOutcomeProduction(product) {
  const causal = refuseOutcomeAsFeature({ name: product, recordType: 'FeatureRecord' });
  return causal.status === 'ALLOWED'
    ? { status: 'ALLOWED', code: null }
    : { status: 'BLOCKED', code: 'GATE23_PRODUCES_NO_OUTCOME', product };
}

function priceBasisDecision(bars) {
  if (bars.some((bar) => FORBIDDEN_PRICE_BASES_V1.includes(bar?.priceBasisId))) {
    return { status: 'FAIL_CLOSED', code: 'PRICE_BASIS_TOTAL_RETURN_FORBIDDEN' };
  }
  if (bars.some((bar) => bar?.dividendAdjusted === true || bar?.impliedTotalReturn === true)) {
    return { status: 'FAIL_CLOSED', code: 'IMPLICIT_DIVIDEND_TOTAL_RETURN_FORBIDDEN' };
  }
  const basis = validatePriceBasisWindow(bars.map((bar) => bar?.priceBasisId));
  if (basis.status !== 'RESOLVED') return basis;
  return basis.priceBasisId === ADMISSIBLE_PRICE_BASIS_V1
    ? basis
    : { status: 'FAIL_CLOSED', code: 'PRICE_BASIS_NOT_ADMITTED_V1' };
}

function windowMissingness(windowBars) {
  if (windowBars.some((bar) => bar === undefined)) return MISSINGNESS_STATES_V1.INPUT_MISSING;
  if (windowBars.some((bar) => bar.close === null || bar.close === undefined)) return MISSINGNESS_STATES_V1.INPUT_MISSING;
  if (windowBars.some((bar) => typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0)) {
    return MISSINGNESS_STATES_V1.INVALID_INPUT;
  }
  if (windowBars.some((bar) => bar.volume === null || bar.volume === undefined)) return MISSINGNESS_STATES_V1.VOLUME_MISSING;
  return MISSINGNESS_STATES_V1.COMPLETE;
}

function materializeMember({ member, context }) {
  const definition = resolveFeatureDefinition(context.registry, member.featureDefinitionId);
  const featureWindowSpec = createFeatureWindowSpec({
    sessionCount: member.sessionCount,
    calendarWindowBinding: context.calendarWindowBinding,
  });
  const window = resolveTrailingWindow({
    sessionDate: context.sessionDate,
    featureWindowSpec,
    calendarWindowBinding: context.calendarWindowBinding,
    sessions: context.sessions,
  });

  let state;
  let outcome;
  let windowBars = [];
  if (window.status === 'INSUFFICIENT_DATA') {
    state = MISSINGNESS_STATES_V1.INSUFFICIENT_HISTORY;
    outcome = { status: 'INSUFFICIENT_DATA', code: window.code, value: null };
  } else if (window.status !== 'RESOLVED') {
    state = MISSINGNESS_STATES_V1.INVALID_INPUT;
    outcome = { status: 'FAIL_CLOSED', code: window.code, value: null };
  } else {
    windowBars = window.sessions.map((session) => context.barsBySession.get(session.sessionDate));
    state = windowMissingness(windowBars);
    const admissionFailure = windowBars
      .filter((bar) => bar !== undefined)
      .map((bar) => admitObservationInput({ input: bar, knowledgeCutoff: context.knowledgeCutoff }))
      .find((decision) => decision.status !== 'ALLOWED');
    if (admissionFailure) {
      outcome = { status: 'FAIL_CLOSED', code: admissionFailure.code, value: null };
      state = MISSINGNESS_STATES_V1.INVALID_INPUT;
    } else if (state === MISSINGNESS_STATES_V1.INPUT_MISSING || state === MISSINGNESS_STATES_V1.INVALID_INPUT) {
      outcome = { status: 'FAIL_CLOSED', code: state, value: null };
    } else {
      outcome = definition.compute({ closes: windowBars.map((bar) => bar.close) });
    }
  }

  const identity = {
    InstrumentIdentityId: context.instrumentIdentityId,
    SessionDate: context.sessionDate,
    KnowledgeCutoff: context.knowledgeCutoff,
    FeatureDefinitionId: definition.featureDefinitionId,
    FormulaId: definition.formulaId,
    FeatureWindowSpecId: featureWindowSpec.featureWindowSpecId,
    CalendarWindowBindingId: context.calendarWindowBinding.calendarWindowBindingId,
    SourceBindingId: context.sourceBindingId,
    DatasetId_observation: context.datasetIdObservation,
    PriceBasisId: context.priceBasisId,
    MissingnessStateId: missingnessStateId(state),
  };

  return Object.freeze({
    schemaVersion: FEATURE_RECORD_VERSION,
    featureRecordId: createFeatureRecordId(identity),
    identity: Object.freeze({ ...identity }),
    identityTuple: featureRecordIdentityTuple(identity),
    featureDefinitionId: definition.featureDefinitionId,
    formulaId: definition.formulaId,
    featureWindowSpecId: featureWindowSpec.featureWindowSpecId,
    sessionCount: member.sessionCount,
    core: member.core,
    status: outcome.status,
    code: outcome.code ?? null,
    value: outcome.value ?? null,
    missingnessState: state,
    missingnessStateId: missingnessStateId(state),
    observedSessionCount: windowBars.length,
    observationWindowDigest: sha256Canonical(windowBars.map((bar) => (bar === undefined ? null : {
      sessionDate: bar.sessionDate,
      close: bar.close ?? null,
      volume: bar.volume ?? null,
      priceBasisId: bar.priceBasisId,
      availableAt: bar.provenance?.availableAt ?? null,
    }))),
  });
}

export function materializeFeatureRecords(input) {
  if (input?.forwardFill === true) return { status: 'BLOCKED', code: 'FORWARD_FILL_FORBIDDEN', records: [] };
  if (input?.coerceMissingToZero === true) return { status: 'BLOCKED', code: 'MISSING_NOT_ZERO', records: [] };
  if (input?.crossSectional === true) return { ...requestCrossSectional(), records: [] };
  if (typeof input?.instrumentIdentityId !== 'string' || input.instrumentIdentityId.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'INSTRUMENT_IDENTITY_REQUIRED', records: [] };
  }
  if (typeof input?.datasetIdObservation !== 'string' || input.datasetIdObservation.length === 0
    || typeof input?.sourceBindingId !== 'string' || input.sourceBindingId.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'SOURCE_OR_DATASET_BINDING_REQUIRED', records: [] };
  }

  const pinned = resolvePinnedCanonicalSession({
    sessionDate: input.sessionDate,
    calendarWindowBinding: input.calendarWindowBinding,
    sessions: input.sessions,
  });
  if (pinned.status !== 'RESOLVED') return { status: pinned.status, code: pinned.code, records: [] };

  const bars = Array.isArray(input.observationBars) ? input.observationBars : [];
  if (bars.length === 0) return { status: 'INSUFFICIENT_DATA', code: 'NO_OBSERVATION_BARS', records: [] };
  if (bars.some((bar) => bar?.sessionDate > input.sessionDate)) {
    return { status: 'BLOCKED', code: 'FUTURE_WINDOW_ACCESS_FORBIDDEN', records: [] };
  }
  const basis = priceBasisDecision(bars);
  if (basis.status !== 'RESOLVED') return { status: basis.status, code: basis.code, records: [] };

  const barsBySession = new Map(bars.map((bar) => [bar.sessionDate, bar]));
  if (barsBySession.size !== bars.length) return { status: 'FAIL_CLOSED', code: 'OBSERVATION_BAR_DUPLICATE', records: [] };

  const context = {
    instrumentIdentityId: input.instrumentIdentityId,
    sessionDate: input.sessionDate,
    knowledgeCutoff: pinned.knowledgeCutoff,
    calendarWindowBinding: input.calendarWindowBinding,
    sessions: input.sessions,
    barsBySession,
    registry: input.registry,
    sourceBindingId: input.sourceBindingId,
    datasetIdObservation: input.datasetIdObservation,
    priceBasisId: basis.priceBasisId,
  };

  const records = input.vector.members.map((member) => materializeMember({ member, context }));
  const vector = resolveVectorStatus({
    vector: input.vector,
    memberResults: records.map((record) => ({
      featureDefinitionId: record.featureDefinitionId,
      sessionCount: record.sessionCount,
      status: record.status,
    })),
  });

  return Object.freeze({
    schemaVersion: FEATURE_MATERIALIZER_VERSION,
    status: vector.vectorStatus,
    code: vector.code,
    transform: 'Observation(T) -> FeatureRecord(T)',
    instrumentIdentityId: input.instrumentIdentityId,
    sessionDate: input.sessionDate,
    sessionKind: pinned.sessionKind,
    knowledgeCutoff: pinned.knowledgeCutoff,
    knowledgeCutoffBoundary: pinned.knowledgeCutoffBoundary,
    calendarWindowBindingId: input.calendarWindowBinding.calendarWindowBindingId,
    priceBasisId: basis.priceBasisId,
    datasetIdObservation: input.datasetIdObservation,
    sourceBindingId: input.sourceBindingId,
    vectorStatus: vector.vectorStatus,
    vectorStatusMeaning: 'CORE_RESOLVED_ONLY',
    records: Object.freeze(records),
    memberIndex: Object.freeze(records.map((record) => memberKey(record))),
    doesNotProduce: GATE23_DOES_NOT_PRODUCE,
  });
}
