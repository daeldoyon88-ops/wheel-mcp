/**
 * GATE24 coverage and classification-quality tests.
 *
 * Proves CORE_V1 quality totality over the six active dimensions, transition
 * coverage (exactly one transition per consecutive pair), missingness
 * DIMENSION_LOCAL_FAIL_CLOSED, and nine-family evidence completeness.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  computeClassificationQuality,
  CLASSIFICATION_QUALITY_VALUES_V1,
  describeClassificationQualityRule,
  describeClassificationEvidenceSchema,
  EVIDENCE_FAMILIES_V1,
} from '../implementation/regime-classifier-v1.mjs';
import {
  ACTIVE_DIMENSIONS_V1,
  ACTIVE_DIMENSION_NAMES_V1,
  INACTIVE_DIMENSION_NAMES_V1,
  isFailClosedValue,
} from '../implementation/regime-taxonomy-v1.mjs';
import {
  createRegimeStore,
  appendRegimeRecord,
  assertSessionCoverage,
} from '../implementation/regime-store-v1.mjs';
import { evaluateTransitionSeries } from '../implementation/regime-transition-v1.mjs';
import {
  emitFixtureRecord,
  FIXTURE_ACTIVE_HORIZON_SPEC,
  MISSINGNESS_CASES,
  MACRO_ABSENCE_STORE,
} from '../fixtures/missingness-horizon-fixture.mjs';
import {
  SESSION_UNIVERSE,
  COMPLETE_FEATURE_VALUES,
} from '../fixtures/vintage-causality-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

const expectedQuality = (values) => {
  const primary = values.primaryMarketRegime;
  if (isFailClosedValue('primaryMarketRegime', primary)) return 'INSUFFICIENT';
  return ACTIVE_DIMENSION_NAMES_V1.some((name) => isFailClosedValue(name, values[name])) ? 'PARTIAL' : 'COMPLETE';
};

let combinations = 0;
const observedQualities = new Set();
const walk = (index, accumulator) => {
  if (index === ACTIVE_DIMENSIONS_V1.length) {
    const quality = computeClassificationQuality(accumulator);
    combinations += 1;
    observedQualities.add(quality);
    assert.ok(CLASSIFICATION_QUALITY_VALUES_V1.includes(quality));
    assert.equal(quality, expectedQuality(accumulator));
    return;
  }
  const spec = ACTIVE_DIMENSIONS_V1[index];
  for (const entry of spec.entries) walk(index + 1, { ...accumulator, [spec.name]: entry });
};
walk(0, {});

check(() => assert.equal(combinations, ACTIVE_DIMENSIONS_V1.reduce((total, spec) => total * spec.entries.length, 1)));
check(() => assert.ok(combinations > 10000));
check(() => assert.deepEqual([...observedQualities].sort(), ['COMPLETE', 'INSUFFICIENT', 'PARTIAL']));
check(() => assert.ok(!observedQualities.has('CONFLICTING')));
check(() => assert.equal(describeClassificationQualityRule().conflictingDisposition, 'NOT_REACHABLE_IN_CORE_V1'));
check(() => assert.equal(INACTIVE_DIMENSION_NAMES_V1.length, 5));

const complete = emitFixtureRecord();
check(() => assert.equal(complete.classificationQuality, 'COMPLETE'));
check(() => assert.deepEqual(complete.classificationEvidence.families.map((family) => family.family), EVIDENCE_FAMILIES_V1));
check(() => assert.equal(describeClassificationEvidenceSchema().familyCount, 9));
check(() => assert.equal(complete.classificationEvidence.containsFutureData, false));

for (const testCase of MISSINGNESS_CASES) {
  const record = emitFixtureRecord({ missing: testCase.missing ?? [], insufficient: testCase.insufficient ?? [] });
  check(() => assert.equal(record.regimeVector[testCase.dimension], testCase.expectedValue));
  check(() => assert.equal(record.classificationQuality, testCase.expectedQuality));
  check(() => assert.ok(record.regimeRecordId.length === 64));
}

const macroAbsent = emitFixtureRecord({ vintageStore: MACRO_ABSENCE_STORE });
check(() => assert.equal(macroAbsent.classificationQuality, 'PARTIAL'));
check(() => assert.notEqual(macroAbsent.regimeVector.primaryMarketRegime, 'REGIME_INSUFFICIENT_DATA'));
for (const name of ['inflationState', 'ratesState', 'yieldCurveShape', 'yieldCurveDirection']) {
  check(() => assert.ok(isFailClosedValue(name, macroAbsent.regimeVector[name])));
}

const sessions = SESSION_UNIVERSE.slice(-4);
const shapes = [
  { ...COMPLETE_FEATURE_VALUES },
  { ...COMPLETE_FEATURE_VALUES, 'F2_REALIZED_VOLATILITY@W21': 0.25 },
  { ...COMPLETE_FEATURE_VALUES, 'F1_SIMPLE_RETURN@W21': -0.09, 'F1_SIMPLE_RETURN@W5': -0.02, 'F2_REALIZED_VOLATILITY@W21': 0.25 },
  { ...COMPLETE_FEATURE_VALUES, 'F1_SIMPLE_RETURN@W21': -0.09, 'F1_SIMPLE_RETURN@W5': -0.02, 'F2_REALIZED_VOLATILITY@W21': 0.25, 'F3_MAX_DRAWDOWN@W21': -0.25 },
];
const seriesRecords = sessions.map((session, index) => emitFixtureRecord({
  sessionDate: session.sessionDate,
  featureValues: shapes[index],
}));
const series = evaluateTransitionSeries({ records: seriesRecords });
check(() => assert.equal(series.status, 'RESOLVED'));
check(() => assert.equal(series.transitions.length, seriesRecords.length - 1));
check(() => assert.equal(series.firstSession.emitsTransition, false));
check(() => assert.equal(series.transitions[0].transitionType, 'PERSIST'));
check(() => assert.equal(series.transitions[1].transitionType, 'CHANGE'));
check(() => assert.equal(series.transitions[2].transitionType, 'CHANGE'));
check(() => assert.deepEqual(series.transitions[0].changedDimensions, ['volatilityState']));

const store = seriesRecords.reduce(appendRegimeRecord, createRegimeStore());
const scope = seriesRecords.map((record) => record.SessionDate);
const coverage = assertSessionCoverage({
  store,
  scopeSessionDates: scope,
  instrumentIdentityId: seriesRecords[0].InstrumentIdentityId,
  regimeHorizonSpecId: FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId,
});
check(() => assert.equal(coverage.status, 'COMPLETE'));
check(() => assert.equal(coverage.missingSessionDates.length, 0));

const report = {
  document: 'GATE24_COVERAGE_TRANSITION_REPORT',
  schemaVersion: 1,
  gateId: 'GATE24',
  generatedBy: 'governance/gates/GATE24/tests/gate24-coverage.test.mjs',
  verdict: 'PASS',
  classificationQuality: {
    combinations,
    observedQualities: [...observedQualities].sort(),
    conflictingReachable: false,
    rule: describeClassificationQualityRule(),
  },
  transitions: {
    sessionCount: series.sessionCount,
    expectedTransitionCount: series.expectedTransitionCount,
    observedTransitionCount: series.transitions.length,
    types: series.transitions.map((item) => item.transitionType),
    firstChangedDimensions: series.transitions[0].changedDimensions,
  },
  sessionCoverage: coverage,
  evidenceFamilies: EVIDENCE_FAMILIES_V1,
  digest: sha256Canonical({
    combinations,
    observedQualities: [...observedQualities].sort(),
    transitionTypes: series.transitions.map((item) => item.transitionType),
    coverageStatus: coverage.status,
  }),
};

/* READ-ONLY EVIDENCE VERIFICATION.
   The canonical coverage transition report is pinned BUILD evidence. This test
   no longer regenerates it; it serialises exactly what the BUILD-time writer
   would have emitted and proves those bytes are already on disk. Drift now
   FAILS instead of being silently overwritten. */
const EVIDENCE_PATH = path.join(REPO_ROOT, 'governance/gates/GATE24/evidence/GATE24_COVERAGE_TRANSITION_REPORT.json');
const canonicalCoverageBytes = fs.readFileSync(EVIDENCE_PATH, 'utf8');
const candidateCoverageBytes = `${JSON.stringify(report, null, 2)}\n`;
assert.deepEqual(JSON.parse(canonicalCoverageBytes), report);
assert.equal(candidateCoverageBytes, canonicalCoverageBytes);

console.log(`GATE24_COVERAGE_PASS ${assertions}`);
