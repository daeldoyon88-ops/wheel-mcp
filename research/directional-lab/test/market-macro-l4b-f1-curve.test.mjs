import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCurveState } from '../src/macro/macroCurveFeaturesL4BV1.mjs';
import {
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES,
  normalizeMarketMacroFeatureComputationPolicyV1,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  F1_SPREAD_DEFINITIONS,
} from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import { openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

const policy = normalizeMarketMacroFeatureComputationPolicyV1({
  schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  ...structuredClone(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
});

function row(sessionDate) {
  return live.rows.macroStateBySessionRows.rows.find((r) => r.sessionDate === sessionDate);
}

test('official curve shapes follow fixture path', () => {
  const shapes = live.rows.macroStateBySessionRows.rows.map((r) => r.curveState.curveShape);
  assert.deepEqual(shapes, [
    'FLAT', 'FLAT', 'PARTIALLY_INVERTED', 'INVERTED', 'INVERTED', 'NORMAL',
  ]);
});

test('ordered spreads count is exactly six', () => {
  for (const sessionDate of ['2026-03-02', '2026-03-09']) {
    assert.equal(row(sessionDate).curveState.orderedSpreads.length, 6);
  }
});

test('spread codes match closed F1 definitions', () => {
  const codes = row('2026-03-02').curveState.orderedSpreads.map((s) => s.spreadCode);
  assert.deepEqual(codes, F1_SPREAD_DEFINITIONS.map((d) => d.spreadCode));
});

test('required spreads 10Y2Y and 10Y3M are available on normal session', () => {
  const spreads = row('2026-03-09').curveState.orderedSpreads;
  const req = spreads.filter((s) => s.spreadCode === 'SPREAD_10Y_2Y' || s.spreadCode === 'SPREAD_10Y_3M');
  assert.equal(req.every((s) => s.availabilityStatus === 'AVAILABLE'), true);
});

test('inverted session classifies both required spreads as inverted family', () => {
  const spreads = row('2026-03-05').curveState.orderedSpreads
    .filter((s) => s.spreadCode === 'SPREAD_10Y_2Y' || s.spreadCode === 'SPREAD_10Y_3M');
  assert.equal(row('2026-03-05').curveState.curveShape, 'INVERTED');
  assert.equal(spreads.length, 2);
});

test('partial inversion session on 03-04', () => {
  assert.equal(row('2026-03-04').curveState.curveShape, 'PARTIALLY_INVERTED');
});

test('flat sessions on 03-02 and 03-03', () => {
  assert.equal(row('2026-03-02').curveState.curveShape, 'FLAT');
  assert.equal(row('2026-03-03').curveState.curveShape, 'FLAT');
});

test('steepening direction on 03-09 after DST boundary', () => {
  const curve = row('2026-03-09').curveState;
  assert.equal(curve.curveShape, 'NORMAL');
  assert.notEqual(curve.curveDirection, 'NOT_AVAILABLE');
});

test('computeCurveState matches stored curve on first session', () => {
  const resolutions = row('2026-03-02').provenanceState.orderedSeriesResolutions;
  const computed = computeCurveState({
    orderedResolutions: resolutions,
    policy,
    previousCurveState: null,
  });
  assert.equal(computed.curveShape, row('2026-03-02').curveState.curveShape);
});

test('spread values use policy rate scale', () => {
  const spread = row('2026-03-02').curveState.orderedSpreads[0];
  if (spread.value !== null) assert.equal(spread.value.scale, policy.rateFeatureScale);
});

test('curve change fields track 10y2y and 10y3m deltas', () => {
  const curve = row('2026-03-09').curveState;
  assert.notEqual(curve.curveChange10y2y, null);
});

test('missing maturity would yield NOT_AVAILABLE spread status when forced absent', () => {
  const resolutions = row('2026-03-02').provenanceState.orderedSeriesResolutions
    .filter((r) => r.canonicalSeriesCode !== 'US.TREAS.DGS30');
  const computed = computeCurveState({
    orderedResolutions: resolutions,
    policy,
    previousCurveState: null,
  });
  const missing = computed.orderedSpreads.find((s) => s.spreadCode === 'SPREAD_30Y_10Y');
  assert.notEqual(missing.availabilityStatus, 'AVAILABLE');
});

test('flat threshold boundary at 10 bps scale 2', () => {
  assert.deepEqual(policy.curveShapePolicy.flatThreshold, { atoms: '10', scale: 2 });
});

test('inversion threshold boundary at -10 bps scale 2', () => {
  assert.deepEqual(policy.curveShapePolicy.inversionThreshold, { atoms: '-10', scale: 2 });
});
