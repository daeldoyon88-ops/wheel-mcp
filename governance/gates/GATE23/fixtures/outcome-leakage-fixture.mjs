/**
 * GATE23 Outcome leakage fixture.
 *
 * One candidate per prohibited mode — direct, lagged, renamed, same-type
 * laundering — plus a clean control, so the Outcome prohibition is proven mode by
 * mode and never by a single generic refusal.
 */

import { DATASET_ID_OBSERVATION } from './causal-window-fixture.mjs';
import { CALENDAR_WINDOW_BINDING, SESSION_UNIVERSE } from './calendar-window-fixture.mjs';

export const KNOWLEDGE_CUTOFF = SESSION_UNIVERSE[SESSION_UNIVERSE.length - 1].closeUtc;
export const CALENDAR_WINDOW_BINDING_ID = CALENDAR_WINDOW_BINDING.calendarWindowBindingId;

const observationProvenance = Object.freeze({
  producerGateId: 'GATE21',
  originRecordType: 'Observation',
  availableAt: KNOWLEDGE_CUTOFF,
  datasetId: DATASET_ID_OBSERVATION,
  derivedFrom: Object.freeze([]),
});

/** Clean control: a genuine GATE21 observation input. */
export const CLEAN_OBSERVATION = Object.freeze({
  name: 'close',
  recordType: 'Observation',
  provenance: observationProvenance,
});

/** Mode 1 — direct: the GATE22 Outcome is offered under its own name. */
export const DIRECT_OUTCOME = Object.freeze({
  name: 'OutcomeStatus',
  recordType: 'Observation',
  provenance: observationProvenance,
});

/** Mode 2 — lagged: the Outcome is offered shifted back by one session. */
export const LAGGED_OUTCOME = Object.freeze({
  name: 'priorSessionSignal',
  recordType: 'Observation',
  lag: 1,
  provenance: Object.freeze({
    producerGateId: 'GATE22',
    originRecordType: 'Outcome',
    availableAt: KNOWLEDGE_CUTOFF,
    datasetId: `sha256:${'c'.repeat(64)}`,
    derivedFrom: Object.freeze([]),
  }),
});

/** Mode 3 — renamed: the Outcome ancestry is buried in the derivation chain. */
export const RENAMED_OUTCOME = Object.freeze({
  name: 'momentumProxy',
  recordType: 'Observation',
  provenance: Object.freeze({
    producerGateId: 'GATE21',
    originRecordType: 'Observation',
    availableAt: KNOWLEDGE_CUTOFF,
    datasetId: DATASET_ID_OBSERVATION,
    derivedFrom: Object.freeze([Object.freeze({
      producerGateId: 'GATE21',
      recordType: 'Observation',
      derivedFrom: Object.freeze([Object.freeze({
        producerGateId: 'GATE22',
        recordType: 'Outcome',
        derivedFrom: Object.freeze([]),
      })]),
    })]),
  }),
});

/** Mode 4 — same-type laundering: an Outcome re-typed as an Observation. */
export const LAUNDERED_OUTCOME = Object.freeze({
  name: 'sessionState',
  recordType: 'Observation',
  provenance: Object.freeze({
    producerGateId: 'GATE21',
    originRecordType: 'Outcome',
    availableAt: KNOWLEDGE_CUTOFF,
    datasetId: DATASET_ID_OBSERVATION,
    derivedFrom: Object.freeze([]),
  }),
});

/** A GATE22 taxonomy primitive presented as a GATE23 feature name. */
export const TAXONOMY_PRIMITIVE_AS_FEATURE = Object.freeze({
  name: 'NEW_LOW',
  recordType: 'Observation',
  provenance: observationProvenance,
});

/** Future provenance: visible only after K(T). */
export const FUTURE_PROVENANCE_OBSERVATION = Object.freeze({
  name: 'close',
  recordType: 'Observation',
  provenance: Object.freeze({ ...observationProvenance, availableAt: '2099-01-04T21:00:00.000Z' }),
});

/** An untrusted producer outside TRUSTED_CANONICAL_PRODUCER_V1. */
export const UNTRUSTED_PRODUCER_OBSERVATION = Object.freeze({
  name: 'close',
  recordType: 'Observation',
  provenance: Object.freeze({ ...observationProvenance, producerGateId: 'GATE99' }),
});

export const LEAKAGE_MODE_CASES = Object.freeze([
  Object.freeze({ mode: 'direct', candidate: DIRECT_OUTCOME, code: 'OUTCOME_DIRECT_FORBIDDEN' }),
  Object.freeze({ mode: 'lagged', candidate: LAGGED_OUTCOME, code: 'OUTCOME_LAGGED_FORBIDDEN' }),
  Object.freeze({ mode: 'renamed', candidate: RENAMED_OUTCOME, code: 'OUTCOME_RENAMED_FORBIDDEN' }),
  Object.freeze({ mode: 'same-type laundering', candidate: LAUNDERED_OUTCOME, code: 'OUTCOME_SAME_TYPE_LAUNDERING_FORBIDDEN' }),
]);

/** Feature-name strings offered to the GATE23 consumption boundary. */
export const FORBIDDEN_FEATURE_NAMES = Object.freeze([
  'outcome', 'laggedOutcome', 'outcome_t_minus_1', 'OutcomeStatus', 'horizonId',
  'forwardReturn', 'DRAWDOWN', 'labelValue',
]);
export const ALLOWED_FEATURE_NAMES = Object.freeze(['F1_SIMPLE_RETURN', 'close', 'volume']);
