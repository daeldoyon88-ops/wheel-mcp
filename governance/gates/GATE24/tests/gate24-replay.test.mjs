/**
 * GATE24 replay identity tests.
 *
 * Identical canonical inputs reproduce identical RegimeHorizonSpecId,
 * ClassifierVersionId, ParameterSetId, RegimeRecordId, evidenceSetId,
 * RegimeVector and transition result. No randomness. No current-time dependency.
 */

import assert from 'node:assert/strict';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  REGIME_RECORD_ID_MEMBERS_V1,
  createRegimeRecordId,
} from '../implementation/regime-identity-v1.mjs';
import { createActiveRegimeHorizonSpec } from '../implementation/regime-horizon-v1.mjs';
import { createClassifierVersion } from '../implementation/regime-classifier-v1.mjs';
import {
  createRegimeStore,
  appendRegimeRecord,
  storeDigest,
} from '../implementation/regime-store-v1.mjs';
import { evaluateTransitionSeries } from '../implementation/regime-transition-v1.mjs';
import {
  emitFixtureRecord,
  FIXTURE_ACTIVE_HORIZON_SPEC,
  FIXTURE_ALTERNATE_HORIZON_SPEC,
  FIXTURE_DEFERRED_HORIZON_SPEC,
  PARAMETER_SET,
  ALTERNATE_PARAMETER_SET,
  CLASSIFIER_VERSION,
  MACRO_CONTEXT_BINDING,
  ALTERNATE_MACRO_CONTEXT_BINDING,
} from '../fixtures/missingness-horizon-fixture.mjs';
import {
  FIXTURE_CALENDAR_WINDOW_BINDING,
  ANCHOR_SESSION_DATE,
  COMPLETE_FEATURE_VALUES,
  SESSION_UNIVERSE,
} from '../fixtures/vintage-causality-fixture.mjs';

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

const first = emitFixtureRecord();
const second = emitFixtureRecord();

check(() => assert.equal(first.RegimeHorizonSpecId, second.RegimeHorizonSpecId));
check(() => assert.equal(first.ClassifierVersionId, second.ClassifierVersionId));
check(() => assert.equal(first.ParameterSetId, second.ParameterSetId));
check(() => assert.equal(first.regimeRecordId, second.regimeRecordId));
check(() => assert.equal(first.evidenceSetId, second.evidenceSetId));
check(() => assert.deepEqual(first.regimeVector, second.regimeVector));
check(() => assert.equal(first.classificationQuality, second.classificationQuality));
check(() => assert.equal(first.ClassifierVersionId, CLASSIFIER_VERSION.classifierVersionId));
check(() => assert.equal(first.ParameterSetId, PARAMETER_SET.parameterSetId));
check(() => assert.equal(first.RegimeHorizonSpecId, FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId));

/* Independent recomputation of the eleven-member digest. */
check(() => assert.equal(
  first.regimeRecordId,
  sha256Canonical(Object.fromEntries(REGIME_RECORD_ID_MEMBERS_V1.map((member) => [member, first.identity[member]]))),
));
check(() => assert.equal(createRegimeRecordId(first.identity), first.regimeRecordId));

/* Store digests replay identically; identical append is idempotent. */
const storeA = appendRegimeRecord(createRegimeStore(), first);
const storeB = appendRegimeRecord(createRegimeStore(), second);
check(() => assert.equal(storeDigest(storeA), storeDigest(storeB)));
check(() => assert.equal(appendRegimeRecord(storeA, second).records.length, 1));

/* Horizon identity is a function of the four-member payload, not of wall-clock. */
const rematerializedHorizon = createActiveRegimeHorizonSpec({
  calendarWindowBindingId: FIXTURE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId,
});
check(() => assert.equal(rematerializedHorizon.regimeHorizonSpecId, FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId));
check(() => assert.notEqual(FIXTURE_ALTERNATE_HORIZON_SPEC.regimeHorizonSpecId, FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId));
check(() => assert.notEqual(FIXTURE_DEFERRED_HORIZON_SPEC.regimeHorizonSpecId, FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId));

/* Classifier version pins the horizon by id. A different horizon is a different classifier. */
const deferredClassifier = createClassifierVersion({
  classifierVersionLabel: CLASSIFIER_VERSION.classifierVersionLabel,
  activeRegimeHorizonSpecIds: [FIXTURE_DEFERRED_HORIZON_SPEC.regimeHorizonSpecId],
});
check(() => assert.notEqual(deferredClassifier.classifierVersionId, CLASSIFIER_VERSION.classifierVersionId));

/* Parameter mutation moves ParameterSetId and RegimeRecordId, not ClassifierVersionId. */
const mutated = emitFixtureRecord({ parameterSet: ALTERNATE_PARAMETER_SET });
check(() => assert.notEqual(mutated.ParameterSetId, first.ParameterSetId));
check(() => assert.equal(mutated.ClassifierVersionId, first.ClassifierVersionId));
check(() => assert.notEqual(mutated.regimeRecordId, first.regimeRecordId));

/* Macro vintage mutation moves MacroContextBindingId and RegimeRecordId. */
const altMacro = emitFixtureRecord({ macroContextBinding: ALTERNATE_MACRO_CONTEXT_BINDING });
check(() => assert.notEqual(altMacro.MacroContextBindingId, MACRO_CONTEXT_BINDING.macroContextBindingId));
check(() => assert.notEqual(altMacro.regimeRecordId, first.regimeRecordId));
check(() => assert.equal(altMacro.SessionDate, ANCHOR_SESSION_DATE));

/* Horizon replay isolation: two horizons for the same session coexist. */
const alternate = emitFixtureRecord({ regimeHorizonSpec: FIXTURE_ALTERNATE_HORIZON_SPEC });
const isolated = appendRegimeRecord(appendRegimeRecord(createRegimeStore(), first), alternate);
check(() => assert.equal(isolated.records.length, 2));
check(() => assert.equal(isolated.records[0].SessionDate, isolated.records[1].SessionDate));
check(() => assert.notEqual(isolated.records[0].regimeRecordId, isolated.records[1].regimeRecordId));

/* Transition series replay. */
const sessions = SESSION_UNIVERSE.slice(-3).map((session) => session.sessionDate);
const seriesRecords = sessions.map((sessionDate) => emitFixtureRecord({
  sessionDate,
  featureValues: COMPLETE_FEATURE_VALUES,
}));
const seriesA = evaluateTransitionSeries({ records: seriesRecords });
const seriesB = evaluateTransitionSeries({ records: seriesRecords });
check(() => assert.equal(seriesA.status, 'RESOLVED'));
check(() => assert.deepEqual(seriesA.transitions, seriesB.transitions));
check(() => assert.equal(sha256Canonical(seriesA.transitions), sha256Canonical(seriesB.transitions)));

console.log(`GATE24_REPLAY_PASS ${assertions}`);
