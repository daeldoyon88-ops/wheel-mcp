/**
 * GATE23 causal window fixture: a complete, deterministic Observation(T) input for
 * the materializer, pinned to the calendar-window fixture universe.
 *
 * Every bar is SPLIT_ADJUSTED, produced by GATE21 as an Observation, and visible
 * at or before the canonical session close of its own session date.
 */

import { createFeatureRegistry } from '../implementation/feature-registry-v1.mjs';
import { F1_DEFINITION, F1_FEATURE_DEFINITION_ID, declareFeatureVector } from '../implementation/feature-families-v1.mjs';
import { materializeFeatureRecords } from '../implementation/feature-materializer-v1.mjs';
import {
  SESSION_UNIVERSE,
  ANCHOR_SESSION_DATE,
  HALF_DAY_ANCHOR,
  CALENDAR_WINDOW_BINDING,
} from './calendar-window-fixture.mjs';

export const INSTRUMENT_IDENTITY_ID = `sha256:${'a'.repeat(64)}`;
export const DATASET_ID_OBSERVATION = `sha256:${'b'.repeat(64)}`;
export const SOURCE_BINDING_ID = 'GATE21_BINDING_V1';

export const REGISTRY = createFeatureRegistry([F1_DEFINITION]);

/** Declared vector: the two core members plus three declared non-core members. */
export const DECLARED_MEMBERS = Object.freeze([
  { featureDefinitionId: F1_FEATURE_DEFINITION_ID, sessionCount: 5 },
  { featureDefinitionId: F1_FEATURE_DEFINITION_ID, sessionCount: 21 },
  { featureDefinitionId: F1_FEATURE_DEFINITION_ID, sessionCount: 63 },
  { featureDefinitionId: F1_FEATURE_DEFINITION_ID, sessionCount: 126 },
  { featureDefinitionId: F1_FEATURE_DEFINITION_ID, sessionCount: 252 },
]);

export const VECTOR = declareFeatureVector([...DECLARED_MEMBERS]);

const closeFor = (index) => 100 + (index % 37) * 0.25 + index * 0.01;

export function buildObservationBars({
  sessions = SESSION_UNIVERSE,
  priceBasisId = 'SPLIT_ADJUSTED',
  producerGateId = 'GATE21',
} = {}) {
  return Object.freeze(sessions.map((session, index) => Object.freeze({
    sessionDate: session.sessionDate,
    close: closeFor(index),
    volume: 1000000 + index,
    priceBasisId,
    recordType: 'Observation',
    provenance: Object.freeze({
      producerGateId,
      originRecordType: 'Observation',
      availableAt: session.closeUtc,
      datasetId: DATASET_ID_OBSERVATION,
      derivedFrom: Object.freeze([]),
    }),
  })));
}

export const OBSERVATION_BARS = buildObservationBars();

/**
 * GATE23 never receives an observation dated after T: the causal boundary is
 * enforced at the input, not only inside the window.
 */
export const barsThrough = (sessionDate) => Object.freeze(OBSERVATION_BARS.filter((bar) => bar.sessionDate <= sessionDate));

export function buildFixtureInput(overrides = {}) {
  const sessionDate = overrides.sessionDate ?? ANCHOR_SESSION_DATE;
  return {
    instrumentIdentityId: INSTRUMENT_IDENTITY_ID,
    sessionDate,
    calendarWindowBinding: CALENDAR_WINDOW_BINDING,
    sessions: SESSION_UNIVERSE,
    observationBars: barsThrough(sessionDate),
    datasetIdObservation: DATASET_ID_OBSERVATION,
    sourceBindingId: SOURCE_BINDING_ID,
    registry: REGISTRY,
    vector: VECTOR,
    ...overrides,
  };
}

export const FIXTURE_INPUT = Object.freeze(buildFixtureInput());
export const materializeFixture = (overrides = {}) => materializeFeatureRecords(buildFixtureInput(overrides));

/** Half-day anchor: K(T) must be the half-day canonical close, not a regular close. */
export const HALF_DAY_FIXTURE_INPUT = Object.freeze(buildFixtureInput({ sessionDate: HALF_DAY_ANCHOR.sessionDate }));

export function withPriceBasis(priceBasisId) {
  return buildFixtureInput({ observationBars: buildObservationBars({ priceBasisId }) });
}

export function withMixedPriceBasis() {
  const bars = OBSERVATION_BARS.map((bar, index) => (index === OBSERVATION_BARS.length - 2
    ? { ...bar, priceBasisId: 'RAW' } : bar));
  return buildFixtureInput({ observationBars: Object.freeze(bars) });
}

export function withImplicitDividendTotalReturn() {
  const bars = OBSERVATION_BARS.map((bar, index) => (index === OBSERVATION_BARS.length - 1
    ? { ...bar, dividendAdjusted: true } : bar));
  return buildFixtureInput({ observationBars: Object.freeze(bars) });
}

/** A bar dated after T: T-CAUSAL-B. */
export function withFutureBar() {
  const last = OBSERVATION_BARS[OBSERVATION_BARS.length - 1];
  return buildFixtureInput({
    observationBars: Object.freeze([...OBSERVATION_BARS, { ...last, sessionDate: '2099-01-04' }]),
  });
}

/** A bar visible only after K(T): T-CAUSAL-A future provenance. */
export function withFutureAvailableAt() {
  const bars = OBSERVATION_BARS.map((bar, index) => (index === OBSERVATION_BARS.length - 1
    ? { ...bar, provenance: { ...bar.provenance, availableAt: '2099-01-04T21:00:00.000Z' } } : bar));
  return buildFixtureInput({ observationBars: Object.freeze(bars) });
}

export function withMissingClose(offsetFromEnd = 2) {
  const bars = OBSERVATION_BARS.map((bar, index) => (index === OBSERVATION_BARS.length - offsetFromEnd
    ? { ...bar, close: null } : bar));
  return buildFixtureInput({ observationBars: Object.freeze(bars) });
}

export function withMissingVolume(offsetFromEnd = 2) {
  const bars = OBSERVATION_BARS.map((bar, index) => (index === OBSERVATION_BARS.length - offsetFromEnd
    ? { ...bar, volume: null } : bar));
  return buildFixtureInput({ observationBars: Object.freeze(bars) });
}

export function withoutBar(sessionDate) {
  return buildFixtureInput({
    observationBars: Object.freeze(OBSERVATION_BARS.filter((bar) => bar.sessionDate !== sessionDate)),
  });
}

/**
 * OD-2: arbitrary valid split ratios, including reverse splits, restate the whole
 * series consistently. A simple return is invariant under a uniform restatement.
 */
export function withSplitRatio(ratio) {
  const bars = OBSERVATION_BARS.map((bar) => ({ ...bar, close: bar.close / ratio }));
  return buildFixtureInput({ observationBars: Object.freeze(bars) });
}
