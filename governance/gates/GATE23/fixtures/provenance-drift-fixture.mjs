/**
 * GATE23 provenance drift fixture.
 *
 * Each case changes exactly one identity-bearing binding and nothing else, so the
 * EXACT_ONLY 11-member identity can be shown to move for the right reason and to
 * stay put otherwise. The same-DatasetId restatement case is the strict
 * point-in-time proof required by OD-2.
 */

import { createFeatureRegistry, defineFeature } from '../implementation/feature-registry-v1.mjs';
import { simpleReturn } from '../implementation/feature-families-v1.mjs';
import { createCalendarWindowBinding } from '../implementation/feature-window-v1.mjs';
import {
  CALENDAR_AUTHORITY_POLICY_ID,
  CALENDAR_REGISTRY_MANIFEST_ID,
} from './calendar-window-fixture.mjs';
import {
  DATASET_ID_OBSERVATION,
  OBSERVATION_BARS,
  buildFixtureInput,
  withSplitRatio,
} from './causal-window-fixture.mjs';

export const RESTATED_DATASET_ID_OBSERVATION = `sha256:${'d'.repeat(64)}`;
export const ALTERNATE_SOURCE_BINDING_ID = 'GATE21_BINDING_V1_ALTERNATE';
export const RESTATEMENT_SPLIT_RATIO = 0.1;

/**
 * A later corporate-action restatement of the same vintage. Prices move, the
 * DatasetId does not: the FeatureRecordId is unchanged and the store must refuse
 * the divergent content rather than rewrite history.
 */
export const SAME_DATASET_RESTATEMENT = () => withSplitRatio(RESTATEMENT_SPLIT_RATIO);

/** The same restatement published as a new vintage: a new identity, history intact. */
export const NEW_DATASET_RESTATEMENT = () => ({
  ...withSplitRatio(RESTATEMENT_SPLIT_RATIO),
  datasetIdObservation: RESTATED_DATASET_ID_OBSERVATION,
});

/** Source binding drift only. */
export const SOURCE_BINDING_DRIFT = () => buildFixtureInput({ sourceBindingId: ALTERNATE_SOURCE_BINDING_ID });

/** Calendar window binding drift only. */
export const ALTERNATE_CALENDAR_WINDOW_BINDING = createCalendarWindowBinding({
  calendarAuthorityPolicyId: CALENDAR_AUTHORITY_POLICY_ID,
  calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
  allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'],
  calendarNamespaceVersion: 'GATE23_FIXTURE_CALENDAR/2',
});
export const CALENDAR_BINDING_DRIFT = () => buildFixtureInput({
  calendarWindowBinding: ALTERNATE_CALENDAR_WINDOW_BINDING,
});

/** Formula behaviour drift: same family, new behaviour, therefore a new FormulaId. */
export const F1_V2_DEFINITION = defineFeature({
  featureDefinitionId: 'F1_SIMPLE_RETURN',
  familyId: 'F1_SIMPLE_RETURN',
  formulaId: 'GATE23_SIMPLE_RETURN/2',
  formulaVersion: '2',
  requiredObservedFields: ['close'],
  compute: ({ closes }) => simpleReturn(closes),
});
export const FORMULA_DRIFT = () => buildFixtureInput({ registry: createFeatureRegistry([F1_V2_DEFINITION]) });

/** Unchanged rematerialization, for the replay identity check. */
export const NO_DRIFT = () => buildFixtureInput({});

export const DRIFT_CASES = Object.freeze([
  Object.freeze({ id: 'DATASET_ID', build: NEW_DATASET_RESTATEMENT, identityMoves: true }),
  Object.freeze({ id: 'SOURCE_BINDING_ID', build: SOURCE_BINDING_DRIFT, identityMoves: true }),
  Object.freeze({ id: 'CALENDAR_WINDOW_BINDING_ID', build: CALENDAR_BINDING_DRIFT, identityMoves: true }),
  Object.freeze({ id: 'FORMULA_ID', build: FORMULA_DRIFT, identityMoves: true }),
  Object.freeze({ id: 'SAME_DATASET_RESTATEMENT', build: SAME_DATASET_RESTATEMENT, identityMoves: false }),
  Object.freeze({ id: 'NO_DRIFT', build: NO_DRIFT, identityMoves: false }),
]);

export { DATASET_ID_OBSERVATION, OBSERVATION_BARS };
