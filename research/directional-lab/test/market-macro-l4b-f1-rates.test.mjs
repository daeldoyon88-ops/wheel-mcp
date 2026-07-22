import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRateState } from '../src/macro/macroRateFeaturesL4BV1.mjs';
import {
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES,
  normalizeMarketMacroFeatureComputationPolicyV1,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
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

function resolutions(sessionDate) {
  return row(sessionDate).provenanceState.orderedSeriesResolutions;
}

test('official rows expose expected policy directions', () => {
  const dirs = live.rows.macroStateBySessionRows.rows.map((r) => r.rateState.policyDirection);
  assert.deepEqual(dirs, ['NOT_AVAILABLE', 'TIGHTENING', 'UNCHANGED', 'EASING', 'UNCHANGED', 'TIGHTENING']);
});

test('first session has no midpoint change baseline', () => {
  const rate = row('2026-03-02').rateState;
  assert.equal(rate.midpointChange, null);
  assert.equal(rate.policyDirection, 'NOT_AVAILABLE');
});

test('hike session computes positive midpoint change', () => {
  const rate = row('2026-03-03').rateState;
  assert.equal(rate.policyDirection, 'TIGHTENING');
  assert.ok(BigInt(rate.midpointChange.atoms) > 0n);
});

test('cut session computes negative midpoint change', () => {
  const rate = row('2026-03-05').rateState;
  assert.equal(rate.policyDirection, 'EASING');
  assert.ok(BigInt(rate.midpointChange.atoms) < 0n);
});

test('restructure lands as tightening hike on 03-09', () => {
  const rate = row('2026-03-09').rateState;
  assert.equal(rate.policyDirection, 'TIGHTENING');
  assert.equal(rate.fedTargetUpperBound.atoms, '4750000');
});

test('fed target midpoint equals exact half of bounds', () => {
  const rate = row('2026-03-03').rateState;
  const mid = (BigInt(rate.fedTargetLowerBound.atoms) + BigInt(rate.fedTargetUpperBound.atoms)) / 2n;
  assert.equal(rate.fedTargetMidpoint.atoms, mid.toString());
});

test('target range width equals upper minus lower', () => {
  const rate = row('2026-03-03').rateState;
  const width = BigInt(rate.fedTargetUpperBound.atoms) - BigInt(rate.fedTargetLowerBound.atoms);
  assert.equal(rate.targetRangeWidth.atoms, width.toString());
});

test('computeRateState matches stored row rate state on hike day', () => {
  const previous = row('2026-03-02').rateState;
  const computed = computeRateState({
    orderedResolutions: resolutions('2026-03-03'),
    policy,
    previousRateState: previous,
  });
  assert.deepEqual(computed.policyDirection, row('2026-03-03').rateState.policyDirection);
  assert.deepEqual(computed.fedTargetMidpoint, row('2026-03-03').rateState.fedTargetMidpoint);
});

test('EFFR and SOFR levels are aligned to policy scale 6', () => {
  for (const sessionDate of ['2026-03-02', '2026-03-03', '2026-03-05']) {
    const rate = row(sessionDate).rateState;
    assert.equal(rate.effectiveFedFundsRate.scale, 6);
    if (rate.sofr !== null) assert.equal(rate.sofr.scale, 6);
  }
});

test('effrMinusTargetMidpoint is computed when both present', () => {
  const rate = row('2026-03-03').rateState;
  assert.notEqual(rate.effrMinusTargetMidpoint, null);
});

test('sofrMinusEffr is computed when both present', () => {
  const rate = row('2026-03-03').rateState;
  assert.notEqual(rate.sofrMinusEffr, null);
});

test('sessionsSincePolicyChange increments on unchanged sessions', () => {
  assert.equal(row('2026-03-04').rateState.sessionsSincePolicyChange, 1);
});

test('sessionsSincePolicyChange resets on direction change', () => {
  assert.equal(row('2026-03-03').rateState.sessionsSincePolicyChange, 0);
  assert.equal(row('2026-03-05').rateState.sessionsSincePolicyChange, 0);
});

test('treasury anchors populate rate state levels', () => {
  const rate = row('2026-03-09').rateState;
  assert.notEqual(rate.treasury10y, null);
  assert.notEqual(rate.treasury3m, null);
});

test('rate regime classifies from policy midpoint', () => {
  const rate = row('2026-03-03').rateState;
  assert.notEqual(rate.rateRegime, 'NOT_AVAILABLE');
});

test('monetary policy regime follows direction on hike session', () => {
  assert.equal(row('2026-03-03').rateState.monetaryPolicyRegime, 'TIGHTENING');
});

test('hold session after hike keeps unchanged direction', () => {
  assert.equal(row('2026-03-04').rateState.policyDirection, 'UNCHANGED');
});
