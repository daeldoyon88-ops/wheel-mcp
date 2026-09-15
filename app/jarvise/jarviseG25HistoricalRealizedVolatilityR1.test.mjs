import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sha256Canonical } from '../../governance/tools/canonical-json.mjs';
import { CORE_FEATURE_SET_V1, F1_DEFINITION, declareFeatureVector, memberKey } from '../../governance/gates/GATE23/implementation/feature-families-v1.mjs';
import { createFeatureRegistry } from '../../governance/gates/GATE23/implementation/feature-registry-v1.mjs';
import { materializeFeatureRecords } from '../../governance/gates/GATE23/implementation/feature-materializer-v1.mjs';
import { computeJarviseHistoricalCalendarBindingR1, loadJarviseHistoricalCalendarR1 } from './jarviseHistoricalCalendarBindingR1.mjs';
import { loadJarviseG24ProductionFoundationR1 } from './jarviseG24ProductionFoundationR1.mjs';
import { G24_FEATURE_SEMANTICS_R1 } from './jarviseG24RatifiedParametersR1.mjs';
import {
  F2_FORMULA_ID_R1,
  F2_REALIZED_VOLATILITY_DEFINITION_R1,
  computeRealizedVolatilityR1,
  describeF2ProducerR1,
} from './jarviseG25HistoricalRealizedVolatilityR1.mjs';

/** Closes whose ln-returns are exactly the supplied list, up to IEEE rounding of exp/log. */
const closesFromReturns = (returns, start = 100) => returns.reduce((closes, r) => [...closes, closes.at(-1) * Math.exp(r)], [start]);
const relClose = (actual, expected, tolerance = 1e-12) => Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));

test('golden: constant closes give zero annualized volatility', () => {
  const result = computeRealizedVolatilityR1({ closes: new Array(22).fill(57.25) });
  assert.deepEqual({ ...result }, { status: 'RESOLVED', code: null, value: 0 });
});

test('golden: alternating +/-1% log returns match the closed form', () => {
  const returns = Array.from({ length: 21 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.01));
  const mean = 0.01 / 21;
  const sampleVariance = (21 * 0.0001 - 21 * mean * mean) / 20;
  const expected = Math.sqrt(sampleVariance) * Math.sqrt(252);
  const result = computeRealizedVolatilityR1({ closes: closesFromReturns(returns) });
  assert.equal(result.status, 'RESOLVED');
  assert.ok(relClose(result.value, expected), `${result.value} vs ${expected}`);
  /* By hand: sum r^2 = 0.0021, 21 m^2 = 4.7619e-6, s = sqrt(1.047619e-4) = 0.01023533, x sqrt(252) = 0.16248077. */
  assert.ok(relClose(expected, 0.16248076809271922, 1e-12));
});

test('golden: independent reference implementation over an irregular series', () => {
  const closes = [100, 101.3, 99.8, 102.45, 103.1, 101.02, 100.5, 104.7, 105.25, 103.9, 106.4, 107.05, 105.5, 104.2, 108.8, 109.35, 107.9, 110.6, 111.15, 109.4, 112.75, 113.2];
  const logs = closes.slice(1).map((close, index) => Math.log(close) - Math.log(closes[index]));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const reference = Math.sqrt(logs.map((r) => (r - mean) ** 2).reduce((a, b) => a + b, 0) / (logs.length - 1)) * Math.sqrt(252);
  const result = computeRealizedVolatilityR1({ closes });
  assert.equal(result.status, 'RESOLVED');
  assert.ok(relClose(result.value, reference, 1e-10), `${result.value} vs ${reference}`);
  assert.ok(result.value > 0 && Number.isFinite(result.value));
});

test('missing or invalid input fails closed; short windows are INSUFFICIENT_DATA; no partial window', () => {
  const base = new Array(22).fill(10);
  const at = (index, value) => base.map((close, position) => (position === index ? value : close));
  assert.equal(computeRealizedVolatilityR1({ closes: at(7, null) }).code, 'INPUT_MISSING');
  assert.equal(computeRealizedVolatilityR1({ closes: at(7, undefined) }).code, 'INPUT_MISSING');
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10', {}]) {
    const result = computeRealizedVolatilityR1({ closes: at(21, invalid) });
    assert.deepEqual([result.status, result.code, result.value], ['FAIL_CLOSED', 'INVALID_INPUT', null]);
  }
  assert.deepEqual({ ...computeRealizedVolatilityR1({ closes: base.slice(0, 21) }) }, { status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW', value: null });
  assert.equal(computeRealizedVolatilityR1({ closes: [] }).status, 'INSUFFICIENT_DATA');
  assert.equal(computeRealizedVolatilityR1({}).status, 'INSUFFICIENT_DATA');
  assert.deepEqual([computeRealizedVolatilityR1({ closes: [...base, 10] }).status, computeRealizedVolatilityR1({ closes: [...base, 10] }).code], ['FAIL_CLOSED', 'WINDOW_CLOSE_COUNT_INVALID']);
});

test('producer implements the Owner-ratified declaration exactly and does not widen the GATE23 core', () => {
  const ratified = G24_FEATURE_SEMANTICS_R1.find((item) => item.featureDefinitionId === 'F2_REALIZED_VOLATILITY');
  const described = describeF2ProducerR1();
  const { producerStatus, ...ratifiedSemantics } = ratified;
  assert.equal(producerStatus, 'NOT_IMPLEMENTED');
  assert.equal(sha256Canonical(described.semantics), sha256Canonical(ratifiedSemantics));
  assert.equal(described.ratifiedSemanticDeclarationSha256, sha256Canonical(ratified));
  assert.equal(F2_REALIZED_VOLATILITY_DEFINITION_R1.formulaId, F2_FORMULA_ID_R1);
  assert.equal(ratified.formulaId, 'WHEEL_JARVISE_REALIZED_VOLATILITY/1');
  assert.deepEqual([ratified.divisor, ratified.annualizationFactor, ratified.sessionCount, ratified.observedSessionCount, ratified.unit], [20, 'sqrt(252)', 21, 22, 'ANNUALIZED_DECIMAL_FRACTION']);
  /* The persisted V1 regime-config CAS carries the same ratified declaration bytes. */
  const persisted = loadJarviseG24ProductionFoundationR1().featureSemantics.find((item) => item.featureDefinitionId === 'F2_REALIZED_VOLATILITY');
  assert.equal(sha256Canonical(persisted), sha256Canonical(ratified));
  assert.equal(CORE_FEATURE_SET_V1.length, 2);
  assert.deepEqual(CORE_FEATURE_SET_V1.map(memberKey), ['F1_SIMPLE_RETURN@W5', 'F1_SIMPLE_RETURN@W21']);
  const vector = declareFeatureVector([...CORE_FEATURE_SET_V1, { featureDefinitionId: 'F2_REALIZED_VOLATILITY', sessionCount: 21 }]);
  assert.deepEqual(vector.members.map((member) => [memberKey(member), member.core]), [['F1_SIMPLE_RETURN@W5', true], ['F1_SIMPLE_RETURN@W21', true], ['F2_REALIZED_VOLATILITY@W21', false]]);
  const source = readFileSync(new URL('./jarviseG25HistoricalRealizedVolatilityR1.mjs', import.meta.url), 'utf8');
  assert.equal(/fixtures?\//i.test(source), false, 'no GATE24 fixture F2 is imported');
});

function materializeAt({ bars, sessionDate }) {
  const calendarWindowBinding = computeJarviseHistoricalCalendarBindingR1();
  return materializeFeatureRecords({
    instrumentIdentityId: 'sha256:' + 'c'.repeat(64),
    sessionDate,
    calendarWindowBinding,
    sessions: loadJarviseHistoricalCalendarR1().sessions,
    observationBars: bars,
    registry: createFeatureRegistry([F1_DEFINITION, F2_REALIZED_VOLATILITY_DEFINITION_R1]),
    vector: declareFeatureVector([...CORE_FEATURE_SET_V1, { featureDefinitionId: 'F2_REALIZED_VOLATILITY', sessionCount: 21 }]),
    sourceBindingId: 'unit-test-source-binding',
    datasetIdObservation: 'unit-test-observation-dataset',
  });
}

test('no look-ahead through the unchanged GATE23 materializer on Calendar V2', () => {
  const sessions = loadJarviseHistoricalCalendarR1().sessions.filter((session) => session.sessionDate >= '2026-05-01' && session.sessionDate <= '2026-07-01');
  const bar = (session, index) => ({ recordType: 'Observation', sessionDate: session.sessionDate, close: 50 + Math.sin(index) * 2 + index * 0.1, volume: 1000, priceBasisId: 'SPLIT_ADJUSTED', provenance: { producerGateId: 'GATE21', originRecordType: 'Observation', availableAt: session.closeUtc } });
  const all = sessions.map(bar);
  const tIndex = 30;
  const T = sessions[tIndex];
  const upToT = all.slice(0, tIndex + 1);
  const f2 = (set) => set.records.find((record) => record.featureDefinitionId === 'F2_REALIZED_VOLATILITY');
  const resolved = materializeAt({ bars: upToT, sessionDate: T.sessionDate });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(f2(resolved).status, 'RESOLVED');
  const expected = computeRealizedVolatilityR1({ closes: upToT.slice(tIndex - 21).map((item) => item.close) }).value;
  assert.equal(f2(resolved).value, expected);
  /* A bar after T is refused outright; it can never enter the window. */
  assert.equal(materializeAt({ bars: all, sessionDate: T.sessionDate }).code, 'FUTURE_WINDOW_ACCESS_FORBIDDEN');
  /* A window bar that only became available after K(T) fails the feature closed. */
  const leaked = upToT.map((item, index) => (index === tIndex - 3 ? { ...item, provenance: { ...item.provenance, availableAt: '2099-01-01T00:00:00.000Z' } } : item));
  const leakedSet = materializeAt({ bars: leaked, sessionDate: T.sessionDate });
  assert.deepEqual([f2(leakedSet).status, f2(leakedSet).code], ['FAIL_CLOSED', 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN']);
  /* A missing bar inside the full window fails closed; a short calendar history is INSUFFICIENT_DATA. */
  const gapped = upToT.filter((_, index) => index !== tIndex - 10);
  assert.deepEqual([f2(materializeAt({ bars: gapped, sessionDate: T.sessionDate })).status, f2(materializeAt({ bars: gapped, sessionDate: T.sessionDate })).code], ['FAIL_CLOSED', 'INPUT_MISSING']);
  const early = loadJarviseHistoricalCalendarR1().sessions.slice(0, 15).map(bar);
  assert.equal(f2(materializeAt({ bars: early, sessionDate: early.at(-1).sessionDate })).status, 'INSUFFICIENT_DATA');
});

test('deterministic replay: identical inputs give identical values and FeatureRecordIds', () => {
  const closes = closesFromReturns(Array.from({ length: 21 }, (_, index) => Math.cos(index * 1.7) / 50));
  const first = computeRealizedVolatilityR1({ closes });
  const second = computeRealizedVolatilityR1({ closes: [...closes] });
  assert.ok(Object.is(first.value, second.value));
  const sessions = loadJarviseHistoricalCalendarR1().sessions.filter((session) => session.sessionDate >= '2026-06-01' && session.sessionDate <= '2026-07-10');
  const bars = sessions.slice(0, 25).map((session, index) => ({ recordType: 'Observation', sessionDate: session.sessionDate, close: 80 + index, volume: 5, priceBasisId: 'SPLIT_ADJUSTED', provenance: { producerGateId: 'GATE21', originRecordType: 'Observation', availableAt: session.closeUtc } }));
  const a = materializeAt({ bars, sessionDate: bars.at(-1).sessionDate });
  const b = materializeAt({ bars: [...bars].reverse(), sessionDate: bars.at(-1).sessionDate });
  assert.deepEqual(a.records.map((record) => [record.featureRecordId, record.value]), b.records.map((record) => [record.featureRecordId, record.value]));
});
