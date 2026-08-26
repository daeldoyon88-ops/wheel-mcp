/**
 * GATE24 Outcome leakage fixture.
 *
 * FIXTURE SCOPE ONLY. Every shape here is a hostile input that GATE24 must refuse.
 * Outcome data stays forbidden even when it is lagged, renamed or laundered through
 * an Observation record type, and a future-dated input stays inadmissible whatever
 * its own containsFutureData claim says.
 */

import { ANCHOR_KNOWLEDGE_CUTOFF, FUTURE_INSTANT } from './vintage-causality-fixture.mjs';

export const FIXTURE_SCOPE = 'GATE24_FIXTURE_ONLY';

const observationProvenance = (overrides = {}) => ({
  producerGateId: 'GATE21',
  originRecordType: 'Observation',
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  ...overrides,
});

/** Direct: the Outcome is named outright. */
export const DIRECT_OUTCOME_INPUT = Object.freeze({
  name: 'OutcomeStatus',
  recordType: 'Observation',
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  provenance: observationProvenance(),
});

/** Renamed: the Outcome derivation survives a cosmetic rename. */
export const RENAMED_OUTCOME_INPUT = Object.freeze({
  name: 'marketBreadthIndex',
  recordType: 'Observation',
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  provenance: observationProvenance({
    derivedFrom: [{ name: 'forwardReturn', producerGateId: 'GATE22', recordType: 'Outcome' }],
  }),
});

/** Lagged: an Outcome shifted backwards is still an Outcome. */
export const LAGGED_OUTCOME_INPUT = Object.freeze({
  name: 'laggedSignal',
  recordType: 'Observation',
  lag: 1,
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  provenance: observationProvenance({
    originRecordType: 'Outcome',
    derivedFrom: [{ name: 'realizedOutcome', producerGateId: 'GATE22', recordType: 'Outcome' }],
  }),
});

/** Same-type laundering: an Outcome re-typed as an Observation. */
export const LAUNDERED_OUTCOME_INPUT = Object.freeze({
  name: 'preparedContextValue',
  recordType: 'Observation',
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  provenance: observationProvenance({ originRecordType: 'Outcome' }),
});

/** An Outcome-bearing dataset member smuggled onto the record surface. */
export const OUTCOME_DATASET_INPUT = Object.freeze({
  name: 'preparedMacroValue',
  recordType: 'Observation',
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  DatasetId_outcome: `sha256:${'e1'.repeat(32)}`,
  provenance: observationProvenance(),
});

/** Future data that self-certifies as safe. The boolean is not trusted. */
export const FUTURE_INPUT_CLAIMING_NO_FUTURE_DATA = Object.freeze({
  name: 'preparedMacroValue',
  recordType: 'Observation',
  containsFutureData: false,
  availableAt: FUTURE_INSTANT,
  provenance: observationProvenance({ availableAt: FUTURE_INSTANT }),
});

/** A value manufactured by substitution rather than observed. */
export const SUBSTITUTED_INPUT = Object.freeze({
  name: 'preparedMacroValue',
  recordType: 'Observation',
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  substitutionMode: 'LATEST_VALUE_SUBSTITUTION',
  provenance: observationProvenance(),
});

/** A legitimate input, present so the hostile set is not vacuously refused. */
export const ADMISSIBLE_INPUT = Object.freeze({
  name: 'preparedMacroValue',
  recordType: 'Observation',
  availableAt: ANCHOR_KNOWLEDGE_CUTOFF,
  provenance: observationProvenance(),
});

export const OUTCOME_LEAKAGE_CASES = Object.freeze([
  Object.freeze({ caseId: 'OUTCOME_DIRECT', input: DIRECT_OUTCOME_INPUT, expectedCode: 'OUTCOME_DIRECT_FORBIDDEN' }),
  Object.freeze({ caseId: 'OUTCOME_RENAMED', input: RENAMED_OUTCOME_INPUT, expectedCode: 'OUTCOME_RENAMED_FORBIDDEN' }),
  Object.freeze({ caseId: 'OUTCOME_LAGGED', input: LAGGED_OUTCOME_INPUT, expectedCode: 'OUTCOME_LAGGED_FORBIDDEN' }),
  Object.freeze({ caseId: 'OUTCOME_LAUNDERED', input: LAUNDERED_OUTCOME_INPUT, expectedCode: 'OUTCOME_SAME_TYPE_LAUNDERING_FORBIDDEN' }),
  Object.freeze({ caseId: 'OUTCOME_DATASET_SURFACE', input: OUTCOME_DATASET_INPUT, expectedCode: 'OUTCOME_SURFACE_FORBIDDEN' }),
  Object.freeze({ caseId: 'FUTURE_SELF_CERTIFIED', input: FUTURE_INPUT_CLAIMING_NO_FUTURE_DATA, expectedCode: 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN' }),
  Object.freeze({ caseId: 'SUBSTITUTED_VALUE', input: SUBSTITUTED_INPUT, expectedCode: 'SUBSTITUTED_INPUT_FORBIDDEN' }),
]);
